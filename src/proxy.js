import { ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const MAX_PROXY_DISPATCHERS = 64;
const dispatchers = new Map();

export function normalizeProxyUrl(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  const candidate = input.includes('://') ? input : `http://${input}`;
  let parsed;
  try { parsed = new URL(candidate); }
  catch { throw new Error('代理地址必须是有效的 URL 或 host:port'); }
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

export function proxyDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return undefined;
  if (!dispatchers.has(normalized)) {
    if (dispatchers.size >= MAX_PROXY_DISPATCHERS) closeOldestDispatcher();
    const parsed = new URL(normalized);
    dispatchers.set(normalized, parsed.protocol.startsWith('socks') ? createSocksDispatcher(parsed) : new ProxyAgent(normalized));
  }
  return dispatchers.get(normalized);
}

export function providerProxyUrl(config, provider) {
  const own = provider === 'go' ? config.goProxyUrl : config.zenProxyUrl;
  return own || config.proxyUrl || '';
}

export async function closeProxyDispatchers({ force = false } = {}) {
  const active = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.allSettled(active.map((dispatcher) => force && typeof dispatcher.destroy === 'function' ? dispatcher.destroy() : dispatcher.close()));
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
