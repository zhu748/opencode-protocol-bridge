const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function normalizeKeepAliveUrl(value) {
  if (typeof value !== 'string') throw new Error('保活 URL 必须是字符串');
  const input = value.trim();
  if (!input) return '';
  if (input.length > 2048) throw new Error('保活 URL 不能超过 2048 个字符');
  let url;
  try { url = new URL(input); }
  catch { throw new Error('保活 URL 格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('保活 URL 仅支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('保活 URL 不能包含用户名或密码');
  if (url.hash) throw new Error('保活 URL 不能包含片段标识');
  return url.toString();
}

export function resolveKeepAliveConfig(config = {}, environment = process.env) {
  const rawUrl = environment.OPENCODE_BRIDGE_KEEP_ALIVE_URL;
  const rawInterval = environment.OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS;
  const urlManagedByEnvironment = typeof rawUrl === 'string' && rawUrl.trim() !== '';
  const intervalManagedByEnvironment = typeof rawInterval === 'string' && rawInterval.trim() !== '';
  let keepAliveUrl = normalizeKeepAliveUrl(config.keepAliveUrl || '');
  let keepAliveIntervalSeconds = config.keepAliveIntervalSeconds ?? 60;

  if (urlManagedByEnvironment) {
    const value = rawUrl.trim();
    keepAliveUrl = normalizeKeepAliveUrl(value);
  }

  if (intervalManagedByEnvironment) {
    if (!/^\d+$/.test(rawInterval.trim())) throw new Error('OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS 必须是 5–86400 的整数');
    keepAliveIntervalSeconds = Number(rawInterval.trim());
  }
  if (!Number.isInteger(keepAliveIntervalSeconds) || keepAliveIntervalSeconds < 5 || keepAliveIntervalSeconds > 86_400) {
    throw new Error('保活间隔必须是 5–86400 的整数');
  }
  return { keepAliveUrl, keepAliveIntervalSeconds, urlManagedByEnvironment, intervalManagedByEnvironment };
}

export class KeepAliveService {
  constructor({ fetchImpl = globalThis.fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('保活服务需要 fetch 实现');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.url = '';
    this.intervalSeconds = 60;
    this.timer = null;
    this.controller = null;
    this.generation = 0;
    this.closed = false;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastStatus = null;
    this.lastError = null;
  }

  configure({ keepAliveUrl = '', keepAliveIntervalSeconds = 60 } = {}) {
    const url = normalizeKeepAliveUrl(keepAliveUrl);
    if (!Number.isInteger(keepAliveIntervalSeconds) || keepAliveIntervalSeconds < 5 || keepAliveIntervalSeconds > 86_400) {
      throw new Error('保活间隔必须是 5–86400 的整数');
    }
    if (!this.closed && url === this.url && keepAliveIntervalSeconds === this.intervalSeconds) return;
    this.stopCurrent();
    this.closed = false;
    this.url = url;
    this.intervalSeconds = keepAliveIntervalSeconds;
    this.lastError = null;
    if (url) this.schedule(0, this.generation);
  }

  stopCurrent() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  schedule(delayMs, generation) {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ping(generation);
    }, delayMs);
    this.timer.unref?.();
  }

  async ping(generation) {
    if (this.closed || generation !== this.generation || !this.url) return;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error('保活请求超时')), this.requestTimeoutMs);
    timeout.unref?.();
    this.lastAttemptAt = new Date().toISOString();
    this.lastStatus = null;
    this.lastError = null;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'OpenCode-Bridge-KeepAlive/1.0' }
      });
      this.lastStatus = response.status;
      if (response.ok) this.lastSuccessAt = new Date().toISOString();
      else this.lastError = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.lastError = controller.signal.aborted ? '请求超时或已取消' : String(error?.message || '网络请求失败').slice(0, 200);
      }
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
      if (!this.closed && generation === this.generation && this.url) this.schedule(this.intervalSeconds * 1000, generation);
    }
  }

  status() {
    return {
      enabled: Boolean(this.url) && !this.closed,
      intervalSeconds: this.intervalSeconds,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastStatus: this.lastStatus,
      lastError: this.lastError
    };
  }

  close() {
    this.closed = true;
    this.stopCurrent();
  }
}
