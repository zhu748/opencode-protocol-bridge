import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class RequestLogStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.flushTimer = null;
    this.dirty = false;
    this.lastError = '';
  }

  async ensureLoaded({ persist = false, limit = 100 } = {}) {
    if (this.loaded || !persist) return;
    try {
      const information = await stat(this.file);
      if (information.size > 10 * 1024 * 1024) throw new Error('日志文件超过 10 MiB 安全上限');
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('日志文件根节点不是数组');
      const merged = [...this.items, ...parsed.map(sanitizeEntry)];
      this.items = [...new Map(merged.map((item) => [item.requestId || `${item.time}:${Math.random()}`, item])).values()]
        .sort((left, right) => String(right.time).localeCompare(String(left.time)))
        .slice(0, normalizeLimit(limit));
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = `无法读取持久化日志：${error.message}`;
    }
    this.loaded = true;
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
    return this.#persist();
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
    const snapshot = structuredClone(this.items);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
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
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    time: text(entry.time, 64),
    requestId: text(entry.requestId, 64),
    clientId: text(entry.clientId, 64),
    clientName: text(entry.clientName, 64),
    model: text(entry.model, 256),
    upstreamModel: text(entry.upstreamModel, 256),
    provider: text(entry.provider, 16),
    credentialId: text(entry.credentialId, 64),
    credentialLabel: text(entry.credentialLabel, 64),
    credentialAttempts: Math.max(1, number(entry.credentialAttempts) || 1),
    upstreamRequestId: text(entry.upstreamRequestId, 256),
    retryAfter: text(entry.retryAfter, 128),
    protocol: text(entry.protocol, 64),
    status: number(entry.status),
    duration: number(entry.duration),
    stream: Boolean(entry.stream),
    ...(entry.inputTokens !== undefined ? { inputTokens: number(entry.inputTokens) } : {}),
    ...(entry.outputTokens !== undefined ? { outputTokens: number(entry.outputTokens) } : {}),
    ...(typeof entry.inputTokensIncludeCache === 'boolean' ? { inputTokensIncludeCache: entry.inputTokensIncludeCache } : {}),
    ...(entry.cachedInputTokens ? { cachedInputTokens: number(entry.cachedInputTokens) } : {}),
    ...(entry.cacheCreationInputTokens ? { cacheCreationInputTokens: number(entry.cacheCreationInputTokens) } : {}),
    ...(entry.reasoningTokens ? { reasoningTokens: number(entry.reasoningTokens) } : {}),
    ...(entry.error ? { error: text(entry.error, 500) } : {})
  };
}
