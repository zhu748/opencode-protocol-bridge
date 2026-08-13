import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from './file-io.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATS_FILE_BYTES = 128 * 1024 * 1024;
const PERSIST_INTERVAL_MS = 1000;

export class RequestStatsStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.requestIds = new Set();
    this.loaded = false;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
    this.flushTimer = null;
    this.dirty = false;
    this.lastError = '';
    this.revision = 0;
  }

  async ensureLoaded({ retentionDays = 7, now = Date.now() } = {}) {
    if (!this.loaded && !this.loadPromise) this.loadPromise = this.#loadPersistent();
    if (this.loadPromise) await this.loadPromise;
    if (this.#prune(retentionDays, now) || this.dirty) this.#schedulePersist();
  }

  async #loadPersistent() {
    const diagnostics = [];
    if (!this.file) {
      this.loaded = true;
      this.loadPromise = null;
      return;
    }
    try {
      await cleanupAtomicTemporary(this.file);
    } catch (error) {
      diagnostics.push(`无法清理统计临时文件：${error.message}`);
    }
    try {
      const parsed = JSON.parse(await readUtf8FileLimited(this.file, MAX_STATS_FILE_BYTES, '统计文件'));
      if (!Array.isArray(parsed)) throw new Error('统计文件根节点不是数组');
      const requestIds = new Set();
      this.items = [];
      for (const entry of parsed) {
        const item = sanitizeStatsEntry(entry);
        if (item.requestId && requestIds.has(item.requestId)) continue;
        if (item.requestId) requestIds.add(item.requestId);
        this.items.push(item);
      }
      if (this.items.length !== parsed.length) this.dirty = true;
      this.#sortAndRebuildIds();
      if (this.items.length) this.revision++;
    } catch (error) {
      if (error.code !== 'ENOENT') diagnostics.push(`无法读取持久化统计：${error.message}`);
    } finally {
      this.lastError = diagnostics.join('；');
      this.loaded = true;
      this.loadPromise = null;
    }
  }

  async add(entry, options = {}) {
    await this.ensureLoaded(options);
    const item = sanitizeStatsEntry(entry);
    if (item.requestId && this.requestIds.has(item.requestId)) return false;
    this.#insertChronologically(item);
    if (item.requestId) this.requestIds.add(item.requestId);
    this.revision++;
    this.#prune(options.retentionDays, options.now);
    this.#schedulePersist();
    return true;
  }

  async merge(entries, options = {}) {
    await this.ensureLoaded(options);
    let changed = false;
    for (const entry of entries) {
      const item = sanitizeStatsEntry(entry);
      if (item.requestId && this.requestIds.has(item.requestId)) continue;
      this.items.push(item);
      if (item.requestId) this.requestIds.add(item.requestId);
      changed = true;
    }
    if (changed) {
      this.#sortAndRebuildIds();
      this.revision++;
    }
    if (this.#prune(options.retentionDays, options.now)) changed = true;
    if (changed) this.#schedulePersist();
    return changed;
  }

  *values() {
    for (let index = this.items.length - 1; index >= 0; index--) yield this.items[index];
  }

  get size() {
    return this.items.length;
  }

  get version() {
    return this.revision;
  }

  async configure(options = {}) {
    await this.ensureLoaded(options);
    if (this.#prune(options.retentionDays, options.now)) this.dirty = true;
    await this.flush();
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.file) {
      this.dirty = false;
      return this.writeQueue;
    }
    if (!this.dirty) return this.writeQueue;
    this.dirty = false;
    try { return await this.#persist(); }
    catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  #prune(retentionDays = 7, now = Date.now()) {
    const cutoff = now - normalizeRetentionDays(retentionDays) * DAY_MS;
    let start = 0;
    let end = this.items.length;
    while (start < end) {
      const timestamp = Date.parse(this.items[start].time);
      if (Number.isFinite(timestamp) && timestamp >= cutoff) break;
      start++;
    }
    while (end > start && Date.parse(this.items[end - 1].time) > now) end--;
    if (start === 0 && end === this.items.length) return false;
    this.items = this.items.slice(start, end);
    this.#sortAndRebuildIds();
    this.revision++;
    return true;
  }

  #sortAndRebuildIds() {
    this.items.sort((left, right) => sortableTimestamp(left.time) - sortableTimestamp(right.time));
    const requestIds = new Set();
    for (const item of this.items) if (item.requestId) requestIds.add(item.requestId);
    this.requestIds = requestIds;
  }

  #insertChronologically(item) {
    const timestamp = sortableTimestamp(item.time);
    if (!this.items.length || timestamp >= sortableTimestamp(this.items.at(-1).time)) {
      this.items.push(item);
      return;
    }
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sortableTimestamp(this.items[middle].time) <= timestamp) low = middle + 1;
      else high = middle;
    }
    this.items.splice(low, 0, item);
  }

  #schedulePersist() {
    if (!this.file) return;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, PERSIST_INTERVAL_MS);
    this.flushTimer.unref();
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.items)}\n`;
    if (Buffer.byteLength(snapshot) > MAX_STATS_FILE_BYTES) {
      const error = Object.assign(new Error('统计文件超过 128 MiB 安全上限，请缩短统计保留天数'), { code: 'STATS_FILE_TOO_LARGE' });
      this.lastError = `无法写入持久化统计：${error.message}`;
      throw error;
    }
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await atomicWriteFile(this.file, snapshot, { encoding: 'utf8', mode: 0o600 });
    });
    try { await this.writeQueue; this.lastError = ''; }
    catch (error) {
      this.lastError = `无法写入持久化统计：${error.message}`;
      throw error;
    }
  }
}

function normalizeRetentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(365, Math.max(1, parsed)) : 7;
}

function sortableTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function sanitizeStatsEntry(entry) {
  const text = (value, limit) => String(value ?? '').slice(0, limit);
  const number = (value, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(maximum, Math.trunc(parsed)));
  };
  const sanitized = {
    time: text(entry.time, 64),
    requestId: text(entry.requestId, 64),
    clientName: text(entry.clientName, 64),
    model: text(entry.model, 256),
    upstreamModel: text(entry.upstreamModel, 256),
    provider: text(entry.provider, 16),
    credentialId: text(entry.credentialId, 64),
    credentialLabel: text(entry.credentialLabel, 64),
    credentialAttempts: Math.max(1, number(entry.credentialAttempts, 1000) || 1),
    protocol: text(entry.protocol, 256),
    status: number(entry.status, 999),
    duration: number(entry.duration),
    stream: Boolean(entry.stream)
  };
  const requestedReasoningEffort = entry.requestedReasoningEffort;
  const reasoningEffort = entry.reasoningEffort;
  if (requestedReasoningEffort) sanitized.requestedReasoningEffort = text(requestedReasoningEffort, 64);
  if (reasoningEffort) sanitized.reasoningEffort = text(reasoningEffort, 64);
  for (const field of [
    'upstreamWaitMs', 'upstreamBodyMs', 'inputTokens', 'outputTokens', 'cachedInputTokens',
    'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens', 'reasoningTokens'
  ]) {
    if (entry[field] !== undefined) sanitized[field] = number(entry[field]);
  }
  if (typeof entry.inputTokensIncludeCache === 'boolean') sanitized.inputTokensIncludeCache = entry.inputTokensIncludeCache;
  return sanitized;
}
