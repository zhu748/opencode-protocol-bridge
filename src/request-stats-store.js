import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from './file-io.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATS_READ_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_STATS_BYTES = 64 * 1024 * 1024;
const PERSIST_INTERVAL_MS = 1000;
const STORAGE_FORMAT = 'opencode-request-stats-ndjson';
const STORAGE_VERSION = 1;

export class RequestStatsStore {
  constructor(file, { maxBytes = DEFAULT_MAX_STATS_BYTES } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_STATS_READ_BYTES) {
      throw new Error('统计存储容量必须是 1024–134217728 字节之间的整数');
    }
    this.file = file;
    this.maxBytes = maxBytes;
    this.targetBytes = Math.max(1024, Math.floor(maxBytes * 0.9));
    this.items = [];
    this.requestIds = new Set();
    this.pendingItems = [];
    this.loaded = false;
    this.loadPromise = null;
    this.persistPromise = null;
    this.flushTimer = null;
    this.dirty = false;
    this.rewriteRequired = false;
    this.lastError = '';
    this.revision = 0;
    this.diskBytes = 0;
    this.liveBytes = 0;
    this.capacityDroppedEntries = 0;
    this.capacityLimitedAt = '';
  }

  async ensureLoaded({ retentionDays = 7, now = Date.now(), compact = false } = {}) {
    const firstLoad = !this.loaded;
    if (!this.loaded && !this.loadPromise) this.loadPromise = this.#loadPersistent();
    if (this.loadPromise) await this.loadPromise;
    const pruned = this.#prune(retentionDays, now);
    if (pruned && (firstLoad || compact)) this.#requireRewrite();
    if (this.#enforceCapacity(now)) this.#requireRewrite();
    if (this.dirty) this.#schedulePersist();
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
      const source = await readUtf8FileLimited(this.file, MAX_STATS_READ_BYTES, '统计文件');
      this.diskBytes = Buffer.byteLength(source);
      const parsed = parsePersistentStats(source);
      this.capacityDroppedEntries = parsed.capacityDroppedEntries;
      this.capacityLimitedAt = parsed.capacityLimitedAt;
      const requestIds = new Set();
      this.items = [];
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          parsed.diagnostics.push('统计文件包含非对象条目，已忽略');
          parsed.rewriteRequired = true;
          continue;
        }
        const item = sanitizeStatsEntry(entry);
        if (item.requestId && requestIds.has(item.requestId)) {
          parsed.rewriteRequired = true;
          continue;
        }
        if (item.requestId) requestIds.add(item.requestId);
        this.items.push(item);
      }
      this.#sortAndRebuildIds();
      this.#recalculateLiveBytes();
      if (this.items.length) this.revision++;
      if (parsed.rewriteRequired || this.items.length !== parsed.entries.length) this.#requireRewrite();
      diagnostics.push(...parsed.diagnostics);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        diagnostics.push(`无法读取持久化统计：${error.message}`);
        // 保留无法读取的原文件供人工恢复；后续确有新数据或显式配置时再原子替换。
        this.rewriteRequired = true;
      }
      this.diskBytes = 0;
      this.#recalculateLiveBytes();
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
    this.pendingItems.push(item);
    if (item.requestId) this.requestIds.add(item.requestId);
    this.liveBytes += serializedEntryBytes(item);
    this.revision++;
    this.dirty = true;
    this.#prune(options.retentionDays, options.now);
    if (this.#enforceCapacity(options.now)) this.#requireRewrite();
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
      this.pendingItems.push(item);
      this.liveBytes += serializedEntryBytes(item);
      if (item.requestId) this.requestIds.add(item.requestId);
      changed = true;
    }
    if (changed) {
      this.#sortAndRebuildIds();
      this.revision++;
      this.dirty = true;
    }
    if (this.#prune(options.retentionDays, options.now)) changed = true;
    if (this.#enforceCapacity(options.now)) {
      this.#requireRewrite();
      changed = true;
    }
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

  status() {
    return {
      format: 'ndjson-v1',
      entries: this.items.length,
      bytes: this.diskBytes,
      liveBytes: this.liveBytes,
      maxBytes: this.maxBytes,
      capacityDroppedEntries: this.capacityDroppedEntries,
      capacityLimitedAt: this.capacityLimitedAt || null
    };
  }

  async configure(options = {}) {
    await this.ensureLoaded({ ...options, compact: true });
    this.#requireRewrite();
    await this.flush();
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.persistPromise) {
      await this.persistPromise;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.file) {
      this.pendingItems = [];
      this.rewriteRequired = false;
      this.dirty = false;
      return;
    }
    if (!this.dirty) return;
    this.persistPromise = this.#persist();
    try {
      await this.persistPromise;
    } finally {
      this.persistPromise = null;
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
    if (start === 0 && end === this.items.length) return 0;
    const previousLength = this.items.length;
    this.items = this.items.slice(start, end);
    this.#afterItemsRemoved();
    this.revision++;
    this.dirty = true;
    return previousLength - this.items.length;
  }

  #enforceCapacity(now = Date.now()) {
    if (this.liveBytes <= this.maxBytes) return 0;
    let removeCount = 0;
    let remainingBytes = this.liveBytes;
    while (removeCount < this.items.length && remainingBytes > this.targetBytes) {
      remainingBytes -= serializedEntryBytes(this.items[removeCount]);
      removeCount++;
    }
    if (!removeCount) return 0;
    this.items = this.items.slice(removeCount);
    this.capacityDroppedEntries = Math.min(Number.MAX_SAFE_INTEGER, this.capacityDroppedEntries + removeCount);
    const candidateTimestamp = Number(now);
    const timestamp = Number.isFinite(candidateTimestamp) && Math.abs(candidateTimestamp) <= 8.64e15 ? candidateTimestamp : Date.now();
    this.capacityLimitedAt = new Date(timestamp).toISOString();
    this.#afterItemsRemoved();
    this.revision++;
    this.dirty = true;
    return removeCount;
  }

  #afterItemsRemoved() {
    const retained = new Set(this.items);
    this.pendingItems = this.pendingItems.filter((item) => retained.has(item));
    this.#sortAndRebuildIds();
    this.#recalculateLiveBytes();
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

  #requireRewrite() {
    this.rewriteRequired = true;
    this.dirty = true;
  }

  #recalculateLiveBytes() {
    this.liveBytes = Buffer.byteLength(`${this.#headerLine()}\n`)
      + this.items.reduce((total, item) => total + serializedEntryBytes(item), 0);
  }

  #headerLine() {
    return JSON.stringify({
      format: STORAGE_FORMAT,
      version: STORAGE_VERSION,
      capacityDroppedEntries: this.capacityDroppedEntries,
      ...(this.capacityLimitedAt ? { capacityLimitedAt: this.capacityLimitedAt } : {})
    });
  }

  #snapshotText() {
    return `${this.#headerLine()}\n${this.items.map((item) => JSON.stringify(item)).join('\n')}${this.items.length ? '\n' : ''}`;
  }

  async #persist() {
    let rewrite = this.rewriteRequired || this.diskBytes === 0;
    let batch = rewrite ? [] : this.pendingItems.splice(0);
    let payload = rewrite ? this.#snapshotText() : batch.map((item) => `${JSON.stringify(item)}\n`).join('');
    if (!rewrite && this.diskBytes + Buffer.byteLength(payload) > this.maxBytes) {
      rewrite = true;
      batch = [];
      payload = this.#snapshotText();
    }
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > this.maxBytes) {
      const error = Object.assign(new Error(`统计快照超过 ${this.maxBytes} 字节容量上限`), { code: 'STATS_FILE_TOO_LARGE' });
      this.lastError = `无法写入持久化统计：${error.message}`;
      this.#requireRewrite();
      throw error;
    }
    if (rewrite) {
      this.rewriteRequired = false;
      this.pendingItems = [];
    }
    this.dirty = this.rewriteRequired || this.pendingItems.length > 0;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      if (rewrite) await atomicWriteFile(this.file, payload, { encoding: 'utf8', mode: 0o600 });
      else if (payload) await appendFile(this.file, payload, { encoding: 'utf8', mode: 0o600 });
      this.diskBytes = rewrite ? payloadBytes : this.diskBytes + payloadBytes;
      this.lastError = '';
    } catch (error) {
      if (rewrite) this.#requireRewrite();
      else this.pendingItems.unshift(...batch);
      this.dirty = true;
      this.lastError = `无法写入持久化统计：${error.message}`;
      throw error;
    }
  }
}

function parsePersistentStats(source) {
  const trimmed = source.trim();
  if (!trimmed) return { entries: [], diagnostics: [], rewriteRequired: true, capacityDroppedEntries: 0, capacityLimitedAt: '' };
  if (trimmed.startsWith('[')) {
    const entries = JSON.parse(trimmed);
    if (!Array.isArray(entries)) throw new Error('统计文件根节点不是数组');
    return { entries, diagnostics: [], rewriteRequired: true, capacityDroppedEntries: 0, capacityLimitedAt: '' };
  }
  const lines = source.split(/\r?\n/);
  const firstLine = lines.findIndex((line) => line.trim());
  if (firstLine === -1) return { entries: [], diagnostics: [], rewriteRequired: true, capacityDroppedEntries: 0, capacityLimitedAt: '' };
  const header = JSON.parse(lines[firstLine]);
  if (header?.format !== STORAGE_FORMAT || header?.version !== STORAGE_VERSION) throw new Error('统计文件格式或版本不受支持');
  const result = {
    entries: [],
    diagnostics: [],
    rewriteRequired: false,
    capacityDroppedEntries: safeCount(header.capacityDroppedEntries),
    capacityLimitedAt: validIsoTimestamp(header.capacityLimitedAt) ? header.capacityLimitedAt : ''
  };
  for (let index = firstLine + 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      result.entries.push(JSON.parse(lines[index]));
    } catch {
      result.diagnostics.push(`统计文件第 ${index + 1} 行不完整或无效，已忽略`);
      result.rewriteRequired = true;
    }
  }
  return result;
}

function normalizeRetentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(365, Math.max(1, parsed)) : 7;
}

function sortableTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function serializedEntryBytes(item) {
  return Buffer.byteLength(JSON.stringify(item)) + 1;
}

function safeCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function sanitizeStatsEntry(entry) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const text = (value, limit) => String(value ?? '').slice(0, limit);
  const number = (value, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(maximum, Math.trunc(parsed)));
  };
  const sanitized = {
    time: text(source.time, 64),
    requestId: text(source.requestId, 64),
    clientName: text(source.clientName, 64),
    model: text(source.model, 256),
    upstreamModel: text(source.upstreamModel, 256),
    provider: text(source.provider, 16),
    credentialId: text(source.credentialId, 64),
    credentialLabel: text(source.credentialLabel, 64),
    credentialAttempts: Math.max(1, number(source.credentialAttempts, 1000) || 1),
    protocol: text(source.protocol, 512),
    status: number(source.status, 999),
    duration: number(source.duration),
    stream: Boolean(source.stream)
  };
  const requestedReasoningEffort = source.requestedReasoningEffort;
  const reasoningEffort = source.reasoningEffort;
  if (requestedReasoningEffort) sanitized.requestedReasoningEffort = text(requestedReasoningEffort, 64);
  if (reasoningEffort) sanitized.reasoningEffort = text(reasoningEffort, 64);
  for (const field of [
    'upstreamWaitMs', 'upstreamBodyMs', 'inputTokens', 'outputTokens', 'cachedInputTokens',
    'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens', 'reasoningTokens'
  ]) {
    if (source[field] !== undefined) sanitized[field] = number(source[field]);
  }
  if (typeof source.inputTokensIncludeCache === 'boolean') sanitized.inputTokensIncludeCache = source.inputTokensIncludeCache;
  return sanitized;
}
