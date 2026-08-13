import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from './file-io.js';

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

export class RequestLogStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.loaded = false;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
    this.flushTimer = null;
    this.dirty = false;
    this.lastError = '';
  }

  async ensureLoaded({ persist = false, limit = 100 } = {}) {
    if (this.loaded) return;
    if (!this.loadPromise && !persist) return;
    if (!this.loadPromise) this.loadPromise = this.#loadPersistent();
    await this.loadPromise;
    this.items.splice(normalizeLimit(limit));
  }

  async #loadPersistent() {
    const diagnostics = [];
    try {
      await cleanupAtomicTemporary(this.file);
    } catch (error) {
      diagnostics.push(`无法清理日志临时文件：${error.message}`);
    }
    try {
      const parsed = JSON.parse(await readUtf8FileLimited(this.file, MAX_LOG_FILE_BYTES, '日志文件'));
      if (!Array.isArray(parsed)) throw new Error('日志文件根节点不是数组');
      const merged = new Map();
      const addItem = (item) => { merged.set(item.requestId || Symbol(), item); };
      for (const item of this.items) addItem(item);
      for (const entry of parsed) addItem(sanitizeEntry(entry));
      const items = [...merged.values()];
      items.sort((left, right) => String(right.time).localeCompare(String(left.time)));
      if (items.length > 1000) items.length = 1000;
      this.items = items;
    } catch (error) {
      if (error.code !== 'ENOENT') diagnostics.push(`无法读取持久化日志：${error.message}`);
    } finally {
      this.lastError = diagnostics.join('；');
      this.loaded = true;
      this.loadPromise = null;
    }
  }

  async add(entry, options = {}) {
    await this.ensureLoaded(options);
    this.items.unshift(sanitizeEntry(entry));
    this.items.splice(normalizeLimit(options.limit));
    if (options.persist) this.#schedulePersist();
  }

  async clear(options = {}) {
    await this.ensureLoaded(options);
    this.items.length = 0;
    this.lastError = '';
    const exists = options.persist || await stat(this.file).then(() => true).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) {
      this.dirty = false;
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.#persist();
    }
  }

  list(limit = 100) {
    return this.items.slice(0, normalizeLimit(limit));
  }

  *values(limit = 100) {
    const length = Math.min(this.items.length, Math.trunc(normalizeLimit(limit)));
    for (let index = 0; index < length; index++) yield this.items[index];
  }

  async configure(options = {}) {
    await this.ensureLoaded(options);
    this.items.splice(normalizeLimit(options.limit));
    if (!options.persist) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.dirty = false;
      this.lastError = '';
      return this.writeQueue;
    }
    this.dirty = true;
    await this.flush();
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty) return this.writeQueue;
    this.dirty = false;
    try { return await this.#persist(); }
    catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  #schedulePersist() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 250);
    this.flushTimer.unref();
  }

  async #persist() {
    // JSON.stringify 在进入异步写队列前完成，这个字符串本身就是不可变快照。
    const snapshot = `${JSON.stringify(this.items, null, 2)}\n`;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await atomicWriteFile(this.file, snapshot, { encoding: 'utf8', mode: 0o600 });
    });
    try { await this.writeQueue; this.lastError = ''; }
    catch (error) {
      this.lastError = `无法写入持久化日志：${error.message}`;
      throw error;
    }
  }
}

function normalizeLimit(value) {
  return Math.min(1000, Math.max(10, Number(value) || 100));
}

function sanitizeEntry(entry) {
  const text = (value, limit) => String(value ?? '').slice(0, limit);
  const number = (value, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(-maximum, Math.min(maximum, Math.trunc(parsed)));
  };
  const nonNegative = (value, maximum) => Math.max(0, number(value, maximum));
  const sanitized = {
    time: text(entry.time, 64),
    requestId: text(entry.requestId, 64),
    clientId: text(entry.clientId, 64),
    clientName: text(entry.clientName, 64),
    model: text(entry.model, 256),
    upstreamModel: text(entry.upstreamModel, 256),
    provider: text(entry.provider, 16),
    credentialId: text(entry.credentialId, 64),
    credentialLabel: text(entry.credentialLabel, 64),
    credentialAttempts: Math.max(1, nonNegative(entry.credentialAttempts, 1000) || 1),
    upstreamRequestId: text(entry.upstreamRequestId, 256),
    retryAfter: text(entry.retryAfter, 128),
    // Compatibility labels can contain several independent adaptations. Keep
    // the complete bounded label so the management UI does not hide the cause.
    protocol: text(entry.protocol, 512),
    status: nonNegative(entry.status, 999),
    duration: nonNegative(entry.duration),
    stream: Boolean(entry.stream)
  };
  const upstreamWaitMs = entry.upstreamWaitMs;
  const upstreamBodyMs = entry.upstreamBodyMs;
  const inputTokens = entry.inputTokens;
  const outputTokens = entry.outputTokens;
  const inputTokensIncludeCache = entry.inputTokensIncludeCache;
  const cachedInputTokens = entry.cachedInputTokens;
  const cacheCreationInputTokens = entry.cacheCreationInputTokens;
  const cacheCreation5mInputTokens = entry.cacheCreation5mInputTokens;
  const cacheCreation1hInputTokens = entry.cacheCreation1hInputTokens;
  const reasoningTokens = entry.reasoningTokens;
  const bridgeWebSearchCalls = entry.bridgeWebSearchCalls;
  const responseDegradations = entry.responseDegradations;
  const requestedReasoningEffort = entry.requestedReasoningEffort;
  const reasoningEffort = entry.reasoningEffort;
  const requestKind = entry.requestKind;
  const errorCode = entry.errorCode;
  const error = entry.error;
  if (upstreamWaitMs !== undefined) sanitized.upstreamWaitMs = nonNegative(upstreamWaitMs);
  if (upstreamBodyMs !== undefined) sanitized.upstreamBodyMs = nonNegative(upstreamBodyMs);
  if (inputTokens !== undefined) sanitized.inputTokens = nonNegative(inputTokens);
  if (outputTokens !== undefined) sanitized.outputTokens = nonNegative(outputTokens);
  if (typeof inputTokensIncludeCache === 'boolean') sanitized.inputTokensIncludeCache = inputTokensIncludeCache;
  if (cachedInputTokens) sanitized.cachedInputTokens = nonNegative(cachedInputTokens);
  if (cacheCreationInputTokens) sanitized.cacheCreationInputTokens = nonNegative(cacheCreationInputTokens);
  if (cacheCreation5mInputTokens) sanitized.cacheCreation5mInputTokens = nonNegative(cacheCreation5mInputTokens);
  if (cacheCreation1hInputTokens) sanitized.cacheCreation1hInputTokens = nonNegative(cacheCreation1hInputTokens);
  if (reasoningTokens) sanitized.reasoningTokens = nonNegative(reasoningTokens);
  if (bridgeWebSearchCalls !== undefined) sanitized.bridgeWebSearchCalls = nonNegative(bridgeWebSearchCalls, 8);
  if (responseDegradations) sanitized.responseDegradations = text(responseDegradations, 512);
  if (requestedReasoningEffort) sanitized.requestedReasoningEffort = text(requestedReasoningEffort, 64);
  if (reasoningEffort) sanitized.reasoningEffort = text(reasoningEffort, 64);
  if (requestKind === 'turn' || requestKind === 'compaction') sanitized.requestKind = requestKind;
  if (errorCode) sanitized.errorCode = text(errorCode, 64);
  if (error) sanitized.error = text(error, 500);
  return sanitized;
}
