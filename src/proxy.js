import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import {
  buildManagedTunnelConfig,
  isKnownTunnelProxyProtocol,
  isManagedTunnelProxyProtocol,
  maskManagedTunnelProxyUrl,
  parseManagedTunnelProxy,
  protocolOfProxyUrl,
  tunnelProxyProtocolLabel
} from './tunnel-proxy.js';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const PROXY_ALIASES = new Map([
  ['mixed:', 'http:']
]);
const MAX_PROXY_DISPATCHERS = 64;
const DEFAULT_MAX_MANAGED_TUNNELS = 16;
const HARD_MAX_MANAGED_TUNNELS = 64;
const DEFAULT_MANAGED_TUNNEL_IDLE_MS = 15 * 60 * 1000;
const MAX_MANAGED_TUNNEL_IDLE_MS = 24 * 60 * 60 * 1000;
const MANAGED_TUNNEL_READY_TIMEOUT_MS = 8000;
const MANAGED_TUNNEL_PREFIX = 'opencode-protocol-bridge-tunnel-';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dispatchers = new Map();
const managedTunnels = new Map();
let managedTunnelMutationQueue = Promise.resolve();
let managedTunnelSweepTimer = null;
let singBoxStatusPromise = null;

export function normalizeProxyUrl(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  const candidate = input.includes('://') ? input : `http://${input}`;
  const protocol = protocolOfProxyUrl(candidate);
  if (isKnownTunnelProxyProtocol(protocol)) {
    if (!isManagedTunnelProxyProtocol(protocol)) {
      throw new Error(`${tunnelProxyProtocolLabel(protocol)} 分享链接暂不支持内置托管；请先转换为本地 HTTP/SOCKS 端口`);
    }
    try { parseManagedTunnelProxy(candidate); }
    catch (error) { throw new Error(`${tunnelProxyProtocolLabel(protocol)} 分享链接无效：${error.message}`); }
    return candidate;
  }
  let parsed;
  try { parsed = new URL(candidate); }
  catch { throw new Error('代理地址必须是有效的 URL 或 host:port'); }
  if (PROXY_ALIASES.has(parsed.protocol)) parsed = aliasProxyUrl(parsed, PROXY_ALIASES.get(parsed.protocol));
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) throw new Error('代理协议仅支持 HTTP、HTTPS、SOCKS4、SOCKS4a、SOCKS5 和 SOCKS5h');
  if (!parsed.hostname) throw new Error('代理地址缺少主机名');
  if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error('代理地址不能包含路径、查询参数或片段');
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch { throw new Error('代理用户名或密码包含无效的百分号编码'); }
  const port = Number(parsed.port || defaultPort(parsed.protocol));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1–65535');
  if (!parsed.port) parsed.port = String(port);
  return parsed.toString();
}

export function maskProxyUrl(value) {
  if (!value) return '';
  const protocol = protocolOfProxyUrl(value);
  if (isKnownTunnelProxyProtocol(protocol)) return maskManagedTunnelProxyUrl(value);
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.username || url.password ? '••••@' : ''}${url.host}`;
  } catch { return '••••'; }
}

function aliasProxyUrl(url, protocol) {
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return new URL(`${protocol}//${auth}${url.host}${url.pathname}${url.search}${url.hash}`);
}

export function proxyDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return undefined;
  if (isManagedTunnelProxyProtocol(protocolOfProxyUrl(normalized))) throw new Error('托管隧道代理需要通过异步请求路径创建');
  if (!dispatchers.has(normalized)) {
    if (dispatchers.size >= MAX_PROXY_DISPATCHERS) closeOldestDispatcher();
    dispatchers.set(normalized, createProxyDispatcher(normalized));
  } else {
    const existing = dispatchers.get(normalized);
    dispatchers.delete(normalized);
    dispatchers.set(normalized, existing);
  }
  return dispatchers.get(normalized);
}

export async function proxyDispatcherForUrl(proxyUrl, { signal } = {}) {
  signal?.throwIfAborted();
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return undefined;
  const protocol = protocolOfProxyUrl(normalized);
  if (!isManagedTunnelProxyProtocol(protocol)) return proxyDispatcher(normalized);
  const entry = await managedTunnel(normalized, signal);
  if (!entry.dispatcher) {
    entry.baseDispatcher = createProxyDispatcher(entry.localProxyUrl);
    entry.dispatcher = createManagedTunnelDispatcher(entry, entry.baseDispatcher);
  }
  return entry.dispatcher;
}

export function singBoxRuntimeStatus({ refresh = false } = {}) {
  if (refresh || !singBoxStatusPromise) singBoxStatusPromise = inspectSingBoxRuntime();
  return singBoxStatusPromise;
}

export function providerProxyUrl(config, provider) {
  const own = provider === 'go' ? config.goProxyUrl : config.zenProxyUrl;
  return own || config.proxyUrl || '';
}

export async function closeProxyDispatchers({ force = false } = {}) {
  const active = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.allSettled([
    ...active.map((dispatcher) => force && typeof dispatcher.destroy === 'function' ? dispatcher.destroy() : dispatcher.close()),
    closeManagedTunnels({ force })
  ]);
}

function createSocksDispatcher(url) {
  return socksDispatcher({
    type: ['socks:', 'socks5:', 'socks5h:'].includes(url.protocol) ? 5 : 4,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 1080),
    ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {})
  });
}

function createProxyDispatcher(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return parsed.protocol.startsWith('socks')
    ? createSocksDispatcher(parsed)
    : new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
}

function defaultPort(protocol) {
  if (protocol === 'http:') return 80;
  if (protocol === 'https:') return 443;
  return 1080;
}

function closeOldestDispatcher() {
  const [url, dispatcher] = dispatchers.entries().next().value;
  dispatchers.delete(url);
  Promise.resolve(dispatcher.close()).catch(() => {});
}

async function managedTunnel(proxyUrl, signal) {
  let entry = managedTunnels.get(proxyUrl);
  if (!entry) entry = await createManagedTunnelEntry(proxyUrl);
  entry.startupWaiters += 1;
  let canceled = false;
  try { await abortableWait(entry.ready, signal); }
  catch (error) {
    canceled = signal?.aborted === true;
    throw error;
  } finally {
    entry.startupWaiters = Math.max(0, entry.startupWaiters - 1);
    if (canceled) await cancelUnusedStartingManagedTunnel(entry);
  }
  ensureManagedTunnelOpen(entry);
  touchManagedTunnel(entry);
  return entry;
}

function createManagedTunnelEntry(proxyUrl) {
  return enqueueManagedTunnelMutation(async () => {
    const existing = managedTunnels.get(proxyUrl);
    if (existing) {
      touchManagedTunnel(existing);
      return existing;
    }
    const limit = maxManagedTunnels();
    while (managedTunnels.size >= limit) await closeOldestManagedTunnel(limit);
    const entry = {
      proxyUrl, createdAt: Date.now(), localProxyUrl: '', process: null, tempDir: '', stderr: '',
      ready: null, dispatcher: null, baseDispatcher: null, activeRequests: 0,
      startupWaiters: 0, lastUsedAt: Date.now(), starting: true, closing: false, cleanupQueue: Promise.resolve()
    };
    entry.ready = startManagedTunnel(entry).catch((error) => {
      if (managedTunnels.get(proxyUrl) === entry) managedTunnels.delete(proxyUrl);
      stopManagedTunnelSweepTimerIfEmpty();
      throw error;
    });
    managedTunnels.set(proxyUrl, entry);
    ensureManagedTunnelSweepTimer();
    return entry;
  });
}

function abortableWait(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolveWait, rejectWait) => {
    const onAbort = () => {
      cleanup();
      rejectWait(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolveWait(value); },
      (error) => { cleanup(); rejectWait(error); }
    );
  });
}

function cancelUnusedStartingManagedTunnel(entry) {
  return enqueueManagedTunnelMutation(async () => {
    if (!entry.starting || entry.startupWaiters > 0 || entry.activeRequests > 0
      || managedTunnels.get(entry.proxyUrl) !== entry) return;
    managedTunnels.delete(entry.proxyUrl);
    await closeManagedTunnel(entry, { force: true });
    stopManagedTunnelSweepTimerIfEmpty();
  });
}

function enqueueManagedTunnelMutation(operation) {
  const mutation = managedTunnelMutationQueue.catch(() => {}).then(operation);
  managedTunnelMutationQueue = mutation.then(() => {}, () => {});
  return mutation;
}

function maxManagedTunnels() {
  const configured = Number(process.env.OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS);
  return Number.isInteger(configured) && configured >= 1 && configured <= HARD_MAX_MANAGED_TUNNELS
    ? configured
    : DEFAULT_MAX_MANAGED_TUNNELS;
}

function managedTunnelIdleMs() {
  const raw = String(process.env.OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS ?? '').trim();
  if (!raw) return DEFAULT_MANAGED_TUNNEL_IDLE_MS;
  const configured = Number(raw);
  if (configured === 0) return 0;
  return Number.isInteger(configured) && configured >= 1000 && configured <= MAX_MANAGED_TUNNEL_IDLE_MS
    ? configured
    : DEFAULT_MANAGED_TUNNEL_IDLE_MS;
}

function ensureManagedTunnelSweepTimer() {
  if (managedTunnelSweepTimer) return;
  const idleMs = managedTunnelIdleMs();
  if (!idleMs) return;
  const intervalMs = Math.min(60_000, Math.max(1000, Math.ceil(idleMs / 2)));
  managedTunnelSweepTimer = setInterval(() => {
    sweepIdleManagedTunnels().catch((error) => console.error(`清理闲置托管隧道失败：${error.message}`));
  }, intervalMs);
  managedTunnelSweepTimer.unref();
}

function stopManagedTunnelSweepTimer() {
  if (managedTunnelSweepTimer) clearInterval(managedTunnelSweepTimer);
  managedTunnelSweepTimer = null;
}

function stopManagedTunnelSweepTimerIfEmpty() {
  if (managedTunnels.size === 0) stopManagedTunnelSweepTimer();
}

function sweepIdleManagedTunnels() {
  const idleMs = managedTunnelIdleMs();
  if (!idleMs) return Promise.resolve();
  return enqueueManagedTunnelMutation(async () => {
    const cutoff = Date.now() - idleMs;
    const idleEntries = [...managedTunnels.entries()].filter(([, entry]) => (
      !entry.closing && entry.localProxyUrl && entry.activeRequests === 0 && entry.lastUsedAt <= cutoff
    ));
    for (const [key, entry] of idleEntries) {
      if (managedTunnels.get(key) !== entry) continue;
      managedTunnels.delete(key);
      await closeManagedTunnel(entry, { force: false });
    }
    stopManagedTunnelSweepTimerIfEmpty();
  });
}

function createManagedTunnelDispatcher(entry, dispatcher) {
  return new Proxy(dispatcher, {
    get(target, property) {
      if (property === 'dispatch') {
        return (options, handler) => {
          ensureManagedTunnelOpen(entry);
          entry.activeRequests += 1;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            entry.activeRequests = Math.max(0, entry.activeRequests - 1);
            touchManagedTunnel(entry);
          };
          try {
            return target.dispatch(options, managedTunnelHandler(handler, release));
          } catch (error) {
            release();
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function managedTunnelHandler(handler, release) {
  if (!handler || typeof handler !== 'object') return handler;
  const completionCallbacks = new Set(['onResponseEnd', 'onResponseError', 'onComplete', 'onError']);
  const upgradeCallbacks = new Set(['onRequestUpgrade', 'onUpgrade']);
  return new Proxy(handler, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (completionCallbacks.has(property)) {
        return (...args) => {
          release();
          return Reflect.apply(value, target, args);
        };
      }
      if (upgradeCallbacks.has(property)) {
        return (...args) => {
          releaseWhenSocketCloses(args[property === 'onRequestUpgrade' ? 3 : 2], release);
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    }
  });
}

function releaseWhenSocketCloses(socket, release) {
  if (!socket || typeof socket.once !== 'function') return release();
  socket.once('close', release);
  socket.once('error', release);
}

function touchManagedTunnel(entry) {
  if (entry.closing || managedTunnels.get(entry.proxyUrl) !== entry) return;
  entry.lastUsedAt = Date.now();
  managedTunnels.delete(entry.proxyUrl);
  managedTunnels.set(entry.proxyUrl, entry);
}

async function startManagedTunnel(entry) {
  try {
    ensureManagedTunnelOpen(entry);
    const port = await reserveLocalPort();
    ensureManagedTunnelOpen(entry);
    const fingerprint = createHash('sha256').update(entry.proxyUrl).digest('hex').slice(0, 12);
    entry.tempDir = await mkdtemp(join(tmpdir(), `${MANAGED_TUNNEL_PREFIX}${process.pid}-${fingerprint}-`));
    ensureManagedTunnelOpen(entry);
    const configPath = join(entry.tempDir, 'sing-box.json');
    const config = buildManagedTunnelConfig(entry.proxyUrl, port);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    ensureManagedTunnelOpen(entry);
    const command = singBoxCommand();
    const child = spawn(command.file, [...command.args, 'run', '-c', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    entry.process = child;
    child.stderr?.on('data', (chunk) => {
      entry.stderr = `${entry.stderr}${chunk.toString('utf8')}`.slice(-8192);
    });
    child.once('exit', () => {
      if (!entry.starting) void managedTunnelExited(entry).catch(() => {});
    });
    await waitForManagedTunnelPort(port, child, entry);
    ensureManagedTunnelOpen(entry);
    if (child.exitCode !== null) throw managedTunnelError('sing-box 在本地端口就绪后退出');
    entry.localProxyUrl = `socks5h://127.0.0.1:${port}`;
    entry.starting = false;
    return entry.localProxyUrl;
  } catch (error) {
    entry.starting = false;
    entry.closing = true;
    await cleanupManagedTunnel(entry, { force: true });
    throw error;
  }
}

function ensureManagedTunnelOpen(entry) {
  if (entry.closing) throw managedTunnelError('sing-box 启动已取消');
}

function singBoxCommand() {
  const location = singBoxLocation();
  if (/\.(?:mjs|cjs|js)$/i.test(location.path)) return { file: process.execPath, args: [location.path], source: location.source };
  return { file: location.path, args: [], source: location.source };
}

function singBoxLocation() {
  const configured = String(process.env.OPENCODE_BRIDGE_SING_BOX_PATH || '').trim();
  if (configured) return { path: configured, source: 'environment' };
  const local = resolve(ROOT, 'vendor', 'sing-box', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  return existsSync(local) ? { path: local, source: 'project' } : { path: 'sing-box', source: 'path' };
}

function inspectSingBoxRuntime() {
  const command = singBoxCommand();
  return new Promise((resolveStatus) => {
    let stdout = '';
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStatus(status);
    };
    const child = spawn(command.file, [...command.args, 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已经退出 */ }
      finish({ available: false, version: '', source: command.source, errorCode: 'probe_timeout' });
    }, 3000);
    timeout.unref();
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4096); });
    child.once('error', (error) => finish({
      available: false, version: '', source: command.source,
      errorCode: error.code === 'ENOENT' ? 'not_found' : 'probe_failed'
    }));
    child.once('exit', (code) => {
      const version = stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || '';
      finish(code === 0 && version
        ? { available: true, version, source: command.source, errorCode: null }
        : { available: false, version: '', source: command.source, errorCode: 'probe_failed' });
    });
  });
}

async function reserveLocalPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function waitForManagedTunnelPort(port, child, entry) {
  const started = Date.now();
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  while (Date.now() - started < MANAGED_TUNNEL_READY_TIMEOUT_MS) {
    ensureManagedTunnelOpen(entry);
    if (spawnError) {
      const detail = spawnError.code === 'ENOENT'
        ? '未找到 sing-box，请安装后设置 OPENCODE_BRIDGE_SING_BOX_PATH'
        : `进程创建失败（${/^[A-Z0-9_-]{1,64}$/i.test(String(spawnError.code || '')) ? spawnError.code : 'spawn_failed'}）`;
      throw managedTunnelError(`启动 sing-box 失败：${detail}`);
    }
    if (child.exitCode !== null) throw managedTunnelError(`sing-box 已退出${entry.stderr ? `：${trimStderr(entry.stderr, entry)}` : ''}`);
    if (await canConnectLocalPort(port)) return;
    await delay(80);
  }
  throw managedTunnelError(`sing-box 本地 SOCKS 端口 ${port} 在 ${MANAGED_TUNNEL_READY_TIMEOUT_MS}ms 内没有就绪${entry.stderr ? `：${trimStderr(entry.stderr, entry)}` : ''}`);
}

function canConnectLocalPort(port) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveConnect(true); });
    socket.once('error', () => resolveConnect(false));
    socket.setTimeout(300, () => { socket.destroy(); resolveConnect(false); });
  });
}

function managedTunnelError(message) {
  return Object.assign(new Error(`托管隧道代理不可用：${message}`), { code: 'PROXY_TUNNEL_ERROR' });
}

function trimStderr(value, entry) {
  let text = String(value || '');
  if (entry?.tempDir) text = text.replaceAll(entry.tempDir, '[临时目录]');
  if (entry?.proxyUrl) text = text.replaceAll(entry.proxyUrl, '[已隐藏的代理地址]');
  try {
    const { outbound } = parseManagedTunnelProxy(entry?.proxyUrl || '');
    for (const secret of tunnelSecretValues(outbound)) text = text.replaceAll(secret, '••••');
  } catch { /* 原始代理地址已经在保存前校验；错误诊断不依赖再次解析 */ }
  return text
    .replace(/\b(?:hy2|hysteria2?|tuic|vless|vmess|trojan|ss):\/\/\S+/gi, '[已隐藏的代理地址]')
    .replace(/("(?:password|uuid|auth|auth_str|private_key)"\s*:\s*")[^"]*(")/gi, '$1••••$2')
    .replace(/\b(password|uuid|auth|auth_str|private_key)\s*=\s*[^\s,;]+/gi, '$1=••••')
    .replace(/\s+/g, ' ').trim().slice(0, 1024);
}

function tunnelSecretValues(value) {
  if (!value || typeof value !== 'object') return [];
  const sensitive = new Set(['password', 'uuid', 'auth', 'auth_str', 'private_key']);
  return Object.entries(value).flatMap(([childKey, childValue]) => {
    if (typeof childValue === 'string' && sensitive.has(childKey) && childValue) return [childValue];
    return childValue && typeof childValue === 'object' ? tunnelSecretValues(childValue) : [];
  });
}

async function closeOldestManagedTunnel(limit) {
  const candidate = [...managedTunnels.entries()].find(([, entry]) => (
    !entry.closing && entry.localProxyUrl && entry.activeRequests === 0
  ));
  if (!candidate) {
    throw managedTunnelError(`托管隧道已达到 ${limit} 个且全部正在使用，请等待现有请求结束后重试`);
  }
  const [key, entry] = candidate;
  managedTunnels.delete(key);
  await closeManagedTunnel(entry, { force: false });
}

async function closeManagedTunnels({ force = false } = {}) {
  stopManagedTunnelSweepTimer();
  await managedTunnelMutationQueue.catch(() => {});
  const entries = [...managedTunnels.values()];
  managedTunnels.clear();
  await Promise.allSettled(entries.map((entry) => closeManagedTunnel(entry, { force })));
  stopManagedTunnelSweepTimer();
}

async function closeManagedTunnel(entry, { force = false } = {}) {
  entry.closing = true;
  await cleanupManagedTunnel(entry, { force });
}

async function managedTunnelExited(entry) {
  if (managedTunnels.get(entry.proxyUrl) === entry) managedTunnels.delete(entry.proxyUrl);
  stopManagedTunnelSweepTimerIfEmpty();
  entry.closing = true;
  await cleanupManagedTunnel(entry, { force: true });
}

function cleanupManagedTunnel(entry, { force = false } = {}) {
  entry.cleanupQueue = entry.cleanupQueue.catch(() => {}).then(async () => {
    const child = entry.process;
    entry.process = null;
    if (child && child.exitCode === null) await stopManagedTunnelProcess(child, { force });
    entry.localProxyUrl = '';
    entry.dispatcher = null;
    const dispatcher = entry.baseDispatcher;
    entry.baseDispatcher = null;
    if (dispatcher) {
      if (force && typeof dispatcher.destroy === 'function') await dispatcher.destroy();
      else await dispatcher.close();
    }
    const directory = entry.tempDir;
    entry.tempDir = '';
    if (isOwnedManagedTunnelTempDir(directory)) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
  return entry.cleanupQueue;
}

async function stopManagedTunnelProcess(child, { force = false } = {}) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit').then(() => true).catch(() => true);
  try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* 进程可能已经退出 */ }
  const stopped = await Promise.race([exited, delay(force ? 1000 : 2500).then(() => false)]);
  if (stopped || child.exitCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* 进程可能已经退出 */ }
  await Promise.race([exited, delay(1000)]);
}

function isOwnedManagedTunnelTempDir(directory) {
  if (!directory) return false;
  const resolvedTemp = `${resolve(tmpdir())}${sep}`;
  const resolvedDirectory = resolve(directory);
  return resolvedDirectory.startsWith(resolvedTemp) && basename(resolvedDirectory).startsWith(MANAGED_TUNNEL_PREFIX);
}
