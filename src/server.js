import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { hashPassword, verifyPassword, createSession, verifySession, loginAllowed, recordLogin, cookieValue, hashClientToken } from './auth.js';
import { loadConfig, saveConfig, updateConfig, publicConfig, ROOT } from './config.js';
import { detectProtocol, upstreamProtocol, prepareUpstreamRequest, normalizeResponse, formatResponse } from './adapters.js';
import { callUpstream, listModels, MAX_MODEL_LIST_BYTES, MAX_UPSTREAM_ERROR_BYTES, readResponseJson, readResponseText } from './upstream.js';
import { closeProxyDispatchers, normalizeProxyUrl, providerProxyUrl } from './proxy.js';
import { observeSse, translateSse } from './stream.js';
import { RequestLogStore } from './request-log.js';
import { applyPromptRules, MAX_PROMPT_BYTES, normalizePromptRules, promptSnapshotText, rewriteClaudeSystem } from './prompt-rewrite.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须是 1–65535 之间的整数');
const PUBLIC = join(ROOT, 'public');
const requestLogs = new RequestLogStore(process.env.LOG_FILE || resolve(ROOT, 'data', 'request-logs.json'));
let setupInProgress = false;
let activeLogins = 0;
let activeProxyRequests = 0;
const activeClientRequests = new Map();
let recentClaudePrompt = null;

function sessionCookie(req, token, maxAge = 86400) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `bridge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const json = (res, status, data, headers = {}) => {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
};

function protocolError(res, status, protocol, message, type = 'invalid_request_error') {
  if (protocol === 'claude') return json(res, status, { type: 'error', error: { type, message } });
  return json(res, status, { error: { message, type, code: null } });
}

function upstreamFailureStatus(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    if (current.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(current.code)) return 504;
  }
  return 502;
}

function compatibilityHeaders(req, incomingProtocol, targetProtocol) {
  if (incomingProtocol !== targetProtocol) return {};
  if (targetProtocol === 'claude') return Object.fromEntries(['anthropic-version', 'anthropic-beta']
    .flatMap((name) => typeof req.headers[name] === 'string' ? [[name, req.headers[name]]] : []));
  return typeof req.headers['openai-beta'] === 'string' ? { 'openai-beta': req.headers['openai-beta'] } : {};
}

async function bodyJson(req, limit = 10 * 1024 * 1024) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error(`请求体超过 ${formatSizeLimit(limit)} 上限`), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`请求体超过 ${formatSizeLimit(limit)} 上限`), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

function formatSizeLimit(bytes) {
  const mib = bytes / 1024 / 1024;
  return `${Number.isInteger(mib) ? mib : Math.round(mib * 10) / 10} MiB`;
}

function sameSecret(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw Object.assign(new Error(`${label}必须是 ${minimum}–${maximum} 的整数`), { status: 400 });
  }
  return value;
}

function admin(req, config) {
  return verifySession(cookieValue(req.headers.cookie, 'bridge_session'), config.sessionSecret);
}

function mutationOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function authenticateClient(req, config) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const token = req.headers['x-api-key'] || bearer;
  if (!token) return null;
  if (config.clientToken && sameSecret(token, config.clientToken)) return { id: 'legacy', name: '主令牌', maxConcurrentRequests: config.maxConcurrentRequests };
  const candidateHash = hashClientToken(token);
  for (const client of Array.isArray(config.apiClients) ? config.apiClients : []) {
    if (client?.enabled !== false && typeof client.tokenHash === 'string' && sameSecret(candidateHash, client.tokenHash)) return client;
  }
  return null;
}

function clientAuthorized(req, config) {
  return Boolean(authenticateClient(req, config));
}

function publicClient(client) {
  return {
    id: client.id, name: client.name, tokenPrefix: client.tokenPrefix,
    enabled: client.enabled !== false, maxConcurrentRequests: client.maxConcurrentRequests,
    createdAt: client.createdAt
  };
}

function serviceReady(config) {
  const hasClient = Boolean(config.clientToken) || (Array.isArray(config.apiClients) && config.apiClients.some((client) => client?.enabled !== false && typeof client.tokenHash === 'string'));
  return Boolean(config.password && hasClient && (config.zenKey || config.goKey));
}

async function bootstrapConfigFromEnvironment() {
  const adminPassword = process.env.OPENCODE_BRIDGE_ADMIN_PASSWORD;
  if (!adminPassword) return;
  const current = await loadConfig();
  if (current.password) return;
  if (adminPassword.length < 8 || adminPassword.length > 256) throw new Error('OPENCODE_BRIDGE_ADMIN_PASSWORD 长度必须为 8–256 个字符');

  const secret = (name, fallback = '') => {
    const value = String(process.env[name] ?? fallback).trim();
    if (value.length > 4096) throw new Error(`${name} 不能超过 4096 个字符`);
    return value;
  };
  const clientToken = secret('OPENCODE_BRIDGE_CLIENT_TOKEN', randomBytes(24).toString('base64url'));
  if (clientToken.length < 24) throw new Error('OPENCODE_BRIDGE_CLIENT_TOKEN 至少需要 24 个字符');
  const defaultProvider = String(process.env.OPENCODE_BRIDGE_DEFAULT_PROVIDER || current.defaultProvider).trim().toLowerCase();
  if (!['zen', 'go'].includes(defaultProvider)) throw new Error('OPENCODE_BRIDGE_DEFAULT_PROVIDER 仅支持 zen 或 go');

  const proxy = (name, fallback = '') => {
    const value = String(process.env[name] ?? fallback).trim();
    if (value.length > 2048) throw new Error(`${name} 不能超过 2048 个字符`);
    return normalizeProxyUrl(value);
  };
  await saveConfig({
    ...current,
    password: await hashPassword(adminPassword),
    sessionSecret: randomBytes(32).toString('hex'),
    clientToken,
    zenKey: secret('OPENCODE_ZEN_KEY', current.zenKey),
    goKey: secret('OPENCODE_GO_KEY', current.goKey),
    proxyUrl: proxy('OPENCODE_PROXY_URL', current.proxyUrl),
    zenProxyUrl: proxy('OPENCODE_ZEN_PROXY_URL', current.zenProxyUrl),
    goProxyUrl: proxy('OPENCODE_GO_PROXY_URL', current.goProxyUrl),
    defaultProvider
  });
  console.log('已从环境变量初始化 OpenCode Bridge 配置');
}

function publicApiScope(pathname) {
  const scoped = pathname.match(/^\/(zen|go)\/v1(?:\/|$)/);
  if (scoped) return { base: `/${scoped[1]}/v1`, provider: scoped[1] };
  if (/^\/v1(?:\/|$)/.test(pathname)) return { base: '/v1', provider: null };
  return null;
}

async function addLog(entry, config) {
  try { await requestLogs.add({ time: new Date().toISOString(), ...entry }, { limit: config.requestLogLimit, persist: config.persistLogs }); }
  catch (error) { console.error(`请求日志持久化失败：${error.message}`); }
}

async function writeChunk(res, chunk) {
  if (res.write(chunk)) return;
  await new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); };
    const onDrain = () => { cleanup(); resolveWrite(); };
    const onClose = () => { cleanup(); rejectWrite(Object.assign(new Error('客户端已断开'), { code: 'CLIENT_CLOSED' })); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

async function adminApi(req, res, url, config) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && !mutationOriginAllowed(req)) return json(res, 403, { error: '请求来源校验失败' });
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (config.password || setupInProgress) return json(res, 409, { error: '管理密码已经初始化或正在初始化' });
    const body = await bodyJson(req);
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) return json(res, 400, { error: '密码长度必须为 8–256 个字符' });
    setupInProgress = true;
    try {
      const updated = { ...config, password: await hashPassword(body.password), sessionSecret: randomBytes(32).toString('hex'), clientToken: randomBytes(24).toString('base64url') };
      await saveConfig(updated);
      const token = createSession(updated.sessionSecret);
      return json(res, 200, { ok: true, clientToken: updated.clientToken }, { 'set-cookie': sessionCookie(req, token) });
    } finally { setupInProgress = false; }
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!loginAllowed(ip)) return json(res, 429, { error: '登录失败次数过多，请 15 分钟后重试' });
    const body = await bodyJson(req);
    if (activeLogins >= 4) return json(res, 429, { error: '登录验证繁忙，请稍后重试' });
    activeLogins++;
    try {
      const valid = typeof body.password === 'string' && body.password.length <= 256 && await verifyPassword(body.password, config.password);
      recordLogin(ip, valid);
      if (!valid) return json(res, 401, { error: '密码错误' });
      const token = createSession(config.sessionSecret);
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, token) });
    } finally { activeLogins--; }
  }
  if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { configured: Boolean(config.password), authenticated: admin(req, config) });
  if (!admin(req, config)) return json(res, 401, { error: '未登录' });

  if (url.pathname === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });

  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig(config));
  if (url.pathname === '/api/prompt-rewrite/recent' && req.method === 'GET') return json(res, 200, recentClaudePrompt || {});
  if (url.pathname === '/api/prompt-rewrite/recent' && req.method === 'DELETE') {
    recentClaudePrompt = null;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/prompt-rewrite/preview' && req.method === 'POST') {
    const body = await bodyJson(req, MAX_PROMPT_BYTES + 64 * 1024);
    const original = body.original === undefined ? recentClaudePrompt?.original || '' : String(body.original);
    if (Buffer.byteLength(original) > MAX_PROMPT_BYTES) return json(res, 413, { error: '预览提示词不能超过 1 MiB' });
    let rules;
    try { rules = normalizePromptRules(body.rules === undefined ? config.promptRewriteRules : body.rules); }
    catch (error) { return json(res, 400, { error: error.message }); }
    let result;
    try { result = applyPromptRules(original, rules); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    return json(res, 200, { original, final: result.text, originalBytes: Buffer.byteLength(original), finalBytes: Buffer.byteLength(result.text), applied: result.applied, ruleResults: result.ruleResults });
  }
  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const next = await bodyJson(req);
    const updated = { ...config };
    const normalizedProxies = {};
    for (const [field, label] of [['proxyUrl', '默认代理'], ['zenProxyUrl', 'Zen 代理'], ['goProxyUrl', 'Go 代理']]) {
      if (!Object.hasOwn(next, field)) {
        normalizedProxies[field] = config[field] || '';
        continue;
      }
      if (String(next[field] || '').length > 2048) return json(res, 400, { error: `${label}地址过长` });
      try { normalizedProxies[field] = normalizeProxyUrl(next[field]); }
      catch (error) { return json(res, 400, { error: `${label}无效：${error.message}` }); }
    }
    if (!['zen', 'go'].includes(next.defaultProvider)) return json(res, 400, { error: '默认提供方无效' });
    if (!next.modelRoutes || Array.isArray(next.modelRoutes) || typeof next.modelRoutes !== 'object') return json(res, 400, { error: '模型路由必须是 JSON 对象' });
    let promptRewriteRules;
    try { promptRewriteRules = normalizePromptRules(next.promptRewriteRules ?? config.promptRewriteRules); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const routeEntries = Object.entries(next.modelRoutes);
    if (routeEntries.length > 500) return json(res, 400, { error: '模型路由不能超过 500 条' });
    for (const [model, route] of routeEntries) {
      if (!model.trim() || model.length > 256 || !route || Array.isArray(route) || typeof route !== 'object') return json(res, 400, { error: `模型路由 ${model || '(空)'} 格式无效` });
      if (['__proto__', 'prototype', 'constructor'].includes(model)) return json(res, 400, { error: `模型路由名称 ${model} 不允许使用` });
      if (route.provider && !['zen', 'go'].includes(route.provider)) return json(res, 400, { error: `模型 ${model} 的 provider 无效` });
      if (route.protocol && !['auto', 'claude', 'responses', 'chat'].includes(route.protocol)) return json(res, 400, { error: `模型 ${model} 的 protocol 无效` });
      if (route.upstreamModel !== undefined && (typeof route.upstreamModel !== 'string' || !route.upstreamModel.trim() || route.upstreamModel.length > 256)) return json(res, 400, { error: `模型 ${model} 的 upstreamModel 无效` });
      if (route.toolChoiceFallback !== undefined && route.toolChoiceFallback !== 'auto') return json(res, 400, { error: `模型 ${model} 的 toolChoiceFallback 无效` });
    }
    for (const key of ['zenKey', 'goKey', 'clientToken']) {
      if (Object.hasOwn(next, key) && typeof next[key] !== 'string') return json(res, 400, { error: `${key} 必须是字符串` });
      if (typeof next[key] === 'string' && next[key]) {
        const value = next[key].trim();
        if (value.length > 4096) return json(res, 400, { error: `${key} 长度无效` });
        if (key === 'clientToken' && value.length < 24) return json(res, 400, { error: '客户端访问令牌至少需要 24 个字符' });
        updated[key] = value;
      }
    }
    if (next.clearZenKey) updated.zenKey = '';
    if (next.clearGoKey) updated.goKey = '';
    updated.proxyUrl = normalizedProxies.proxyUrl;
    updated.zenProxyUrl = normalizedProxies.zenProxyUrl;
    updated.goProxyUrl = normalizedProxies.goProxyUrl;
    if (next.clearProxy) updated.proxyUrl = '';
    if (next.clearZenProxy) updated.zenProxyUrl = '';
    if (next.clearGoProxy) updated.goProxyUrl = '';
    updated.defaultProvider = next.defaultProvider;
    updated.modelRoutes = next.modelRoutes;
    updated.promptRewriteRules = promptRewriteRules;
    updated.requestLogLimit = boundedInteger(next.requestLogLimit, '日志保留条数', 10, 1000, config.requestLogLimit);
    updated.upstreamTimeoutMs = boundedInteger(next.upstreamTimeoutMs, '上游超时', 1000, 600000, config.upstreamTimeoutMs);
    updated.maxConcurrentRequests = boundedInteger(next.maxConcurrentRequests, '最大并发请求', 1, 1000, config.maxConcurrentRequests);
    if (next.persistLogs !== undefined && typeof next.persistLogs !== 'boolean') return json(res, 400, { error: 'persistLogs 必须是布尔值' });
    updated.persistLogs = next.persistLogs ?? config.persistLogs;
    const saved = await updateConfig((current) => ({
      ...updated,
      password: current.password,
      sessionSecret: current.sessionSecret,
      apiClients: current.apiClients,
      clientToken: typeof next.clientToken === 'string' && next.clientToken ? updated.clientToken : current.clientToken,
      zenKey: next.clearZenKey || (typeof next.zenKey === 'string' && next.zenKey) ? updated.zenKey : current.zenKey,
      goKey: next.clearGoKey || (typeof next.goKey === 'string' && next.goKey) ? updated.goKey : current.goKey
    }));
    await requestLogs.configure({ limit: saved.requestLogLimit, persist: saved.persistLogs }).catch((error) => console.error(`更新日志持久化设置失败：${error.message}`));
    return json(res, 200, publicConfig(saved));
  }
  if (url.pathname === '/api/password' && req.method === 'PUT') {
    const next = await bodyJson(req);
    if (typeof next.currentPassword !== 'string' || next.currentPassword.length > 256 || !await verifyPassword(next.currentPassword, config.password)) return json(res, 401, { error: '当前密码错误' });
    if (typeof next.newPassword !== 'string' || next.newPassword.length < 8 || next.newPassword.length > 256) return json(res, 400, { error: '新密码长度必须为 8–256 个字符' });
    const password = await hashPassword(next.newPassword);
    await updateConfig((current) => ({ ...current, password, sessionSecret: randomBytes(32).toString('hex') }));
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  }
  if (url.pathname === '/api/token/regenerate' && req.method === 'POST') {
    const updated = await updateConfig((current) => ({ ...current, clientToken: randomBytes(24).toString('base64url') }));
    return json(res, 200, { token: updated.clientToken });
  }
  if (url.pathname === '/api/clients' && req.method === 'GET') {
    return json(res, 200, (Array.isArray(config.apiClients) ? config.apiClients : []).map(publicClient));
  }
  if (url.pathname === '/api/clients' && req.method === 'POST') {
    const body = await bodyJson(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return json(res, 400, { error: '客户端名称长度必须为 1–64 个字符' });
    const maxConcurrentRequests = boundedInteger(body.maxConcurrentRequests, '客户端并发上限', 1, 1000, config.maxConcurrentRequests);
    const token = `ocb_${randomBytes(32).toString('base64url')}`;
    const client = {
      id: randomBytes(8).toString('hex'), name, tokenHash: hashClientToken(token), tokenPrefix: token.slice(0, 10),
      enabled: true, maxConcurrentRequests, createdAt: new Date().toISOString()
    };
    await updateConfig((current) => {
      const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
      if (clients.length >= 100) throw Object.assign(new Error('命名客户端不能超过 100 个'), { status: 400 });
      if (clients.some((item) => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Object.assign(new Error('客户端名称已存在'), { status: 409 });
      return { ...current, apiClients: [...clients, client] };
    });
    return json(res, 201, { ...publicClient(client), token });
  }
  const regenerateClientMatch = url.pathname.match(/^\/api\/clients\/([a-f0-9]{16})\/regenerate$/);
  if (regenerateClientMatch && req.method === 'POST') {
    const token = `ocb_${randomBytes(32).toString('base64url')}`;
    let replacement;
    await updateConfig((current) => {
      const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
      const index = clients.findIndex((client) => client.id === regenerateClientMatch[1]);
      if (index === -1) throw Object.assign(new Error('客户端不存在'), { status: 404 });
      replacement = { ...clients[index], tokenHash: hashClientToken(token), tokenPrefix: token.slice(0, 10) };
      return { ...current, apiClients: clients.map((client, clientIndex) => clientIndex === index ? replacement : client) };
    });
    return json(res, 200, { ...publicClient(replacement), token });
  }
  const clientMatch = url.pathname.match(/^\/api\/clients\/([a-f0-9]{16})$/);
  if (clientMatch && ['PUT', 'DELETE'].includes(req.method)) {
    if (req.method === 'DELETE') {
      await updateConfig((current) => {
        const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
        if (!clients.some((client) => client.id === clientMatch[1])) throw Object.assign(new Error('客户端不存在'), { status: 404 });
        return { ...current, apiClients: clients.filter((client) => client.id !== clientMatch[1]) };
      });
      return json(res, 200, { ok: true });
    }
    const body = await bodyJson(req);
    let replacement;
    await updateConfig((current) => {
      const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
      const index = clients.findIndex((client) => client.id === clientMatch[1]);
      if (index === -1) throw Object.assign(new Error('客户端不存在'), { status: 404 });
      const name = body.name === undefined ? clients[index].name : String(body.name).trim();
      if (!name || name.length > 64) throw Object.assign(new Error('客户端名称长度必须为 1–64 个字符'), { status: 400 });
      if (clients.some((client, clientIndex) => clientIndex !== index && client.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Object.assign(new Error('客户端名称已存在'), { status: 409 });
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw Object.assign(new Error('客户端 enabled 必须是布尔值'), { status: 400 });
      replacement = {
        ...clients[index], name,
        enabled: body.enabled === undefined ? clients[index].enabled !== false : body.enabled,
        maxConcurrentRequests: boundedInteger(body.maxConcurrentRequests, '客户端并发上限', 1, 1000, clients[index].maxConcurrentRequests)
      };
      return { ...current, apiClients: clients.map((client, clientIndex) => clientIndex === index ? replacement : client) };
    });
    return json(res, 200, publicClient(replacement));
  }
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    await requestLogs.ensureLoaded({ limit: config.requestLogLimit, persist: config.persistLogs });
    if (config.persistLogs) await requestLogs.flush();
    return json(res, 200, requestLogs.list(config.requestLogLimit));
  }
  if (url.pathname === '/api/logs' && req.method === 'DELETE') {
    await requestLogs.clear({ limit: config.requestLogLimit, persist: config.persistLogs });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/status' && req.method === 'GET') {
    await requestLogs.ensureLoaded({ limit: config.requestLogLimit, persist: config.persistLogs });
    const logs = requestLogs.list(config.requestLogLimit);
    const success = logs.filter((item) => item.status >= 200 && item.status < 400).length;
    const durationTotal = logs.reduce((sum, item) => sum + (item.duration || 0), 0);
    const memory = process.memoryUsage();
    return json(res, 200, {
      uptime: Math.floor(process.uptime()), requests: logs.length, success,
      ready: serviceReady(config),
      activeRequests: activeProxyRequests,
      successRate: logs.length ? Math.round(success / logs.length * 1000) / 10 : 100,
      averageDuration: logs.length ? Math.round(durationTotal / logs.length) : 0,
      memoryMb: Math.round(memory.rss / 1024 / 1024),
      logPersistenceError: requestLogs.lastError || null
    });
  }
  if (url.pathname === '/api/models' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') === 'go' ? 'go' : 'zen';
    const apiKey = provider === 'go' ? config.goKey : config.zenKey;
    if (!apiKey) return json(res, 400, { error: `${provider.toUpperCase()} 密钥未配置` });
    try {
      const response = await listModels({ provider, apiKey, proxyUrl: providerProxyUrl(config, provider), timeoutMs: config.upstreamTimeoutMs });
      const text = await readResponseText(response, MAX_MODEL_LIST_BYTES, '模型列表');
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8' });
      return res.end(text);
    } catch (error) { return json(res, upstreamFailureStatus(error), { error: `连接上游失败：${error.message}` }); }
  }
  if (url.pathname === '/api/models/test' && req.method === 'POST') {
    const body = await bodyJson(req);
    const provider = body.provider === 'go' ? 'go' : 'zen';
    const apiKey = String(body.apiKey || (provider === 'go' ? config.goKey : config.zenKey)).trim();
    let proxyUrl;
    try { proxyUrl = normalizeProxyUrl(body.proxyUrl ?? providerProxyUrl(config, provider)); }
    catch (error) { return json(res, 400, { error: `代理地址无效：${error.message}` }); }
    if (!apiKey) return json(res, 400, { error: `${provider.toUpperCase()} 密钥未填写` });
    try {
      const response = await listModels({ provider, apiKey, proxyUrl, timeoutMs: config.upstreamTimeoutMs });
      const text = await readResponseText(response, MAX_MODEL_LIST_BYTES, '模型列表');
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8' });
      return res.end(text);
    } catch (error) { return json(res, upstreamFailureStatus(error), { error: `连接上游失败：${error.message}` }); }
  }
  return json(res, 404, { error: '接口不存在' });
}

function resolveRoute(model, config, forcedProvider = null) {
  const explicit = Object.hasOwn(config.modelRoutes, model) ? config.modelRoutes[model] : {};
  let provider = forcedProvider || explicit.provider || config.defaultProvider;
  let upstreamModel = explicit.upstreamModel || model;
  if (model.startsWith('opencode-go/')) { if (!forcedProvider) provider = 'go'; upstreamModel = model.slice('opencode-go/'.length); }
  if (model.startsWith('opencode/')) { if (!forcedProvider) provider = 'zen'; upstreamModel = model.slice('opencode/'.length); }
  return { provider, upstreamModel, protocol: upstreamProtocol(upstreamModel, explicit, provider), toolChoiceFallback: explicit.toolChoiceFallback };
}

function upstreamSystemText(body, protocol) {
  if (protocol === 'responses') return typeof body.instructions === 'string' ? body.instructions : '';
  if (protocol === 'claude') {
    if (typeof body.system === 'string') return body.system;
    return Array.isArray(body.system) ? body.system.map((block) => typeof block === 'string' ? block : block?.text || '').filter(Boolean).join('\n') : '';
  }
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => ['system', 'developer'].includes(message?.role))
    .map((message) => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text || part?.refusal || '').join('') : '')
    .filter(Boolean).join('\n');
}

async function proxyRequest(req, res, url, config, client, forcedProvider) {
  const incomingProtocol = detectProtocol(url.pathname);
  if (!incomingProtocol) return protocolError(res, 404, 'chat', '仅支持 messages、responses 和 chat/completions 端点');
  if (!client) return protocolError(res, 401, incomingProtocol, '访问令牌无效', 'authentication_error');
  const started = Date.now();
  const requestId = randomBytes(8).toString('hex');
  res.setHeader('x-request-id', requestId);
  const body = await bodyJson(req);
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256) return protocolError(res, 400, incomingProtocol, 'model 必须是长度 1–256 的非空字符串');
  let promptRewrite;
  if (incomingProtocol === 'claude') {
    promptRewrite = rewriteClaudeSystem(body.system, config.promptRewriteRules || []);
    body.system = promptRewrite.system;
  }
  const route = resolveRoute(body.model, config, forcedProvider);
  if (!route.upstreamModel) return protocolError(res, 400, incomingProtocol, '上游模型名不能为空');
  const apiKey = route.provider === 'go' ? config.goKey : config.zenKey;
  if (!apiKey) return protocolError(res, 503, incomingProtocol, `尚未配置 OpenCode ${route.provider === 'go' ? 'Go' : 'Zen'} 密钥`, 'configuration_error');
  let upstreamBody;
  try {
    upstreamBody = prepareUpstreamRequest(body, incomingProtocol, route.protocol, route.upstreamModel, { toolChoiceFallback: route.toolChoiceFallback });
  } catch (error) {
    return protocolError(res, error.status || 400, incomingProtocol, error.message, error.type || 'invalid_request_error');
  }
  if (promptRewrite) {
    const finalText = upstreamSystemText(upstreamBody, route.protocol);
    const original = promptSnapshotText(promptRewrite.original);
    const final = promptSnapshotText(finalText);
    recentClaudePrompt = {
      model: body.model, protocol: 'messages', upstreamProtocol: route.protocol, time: new Date().toISOString(),
      original: original.text, final: final.text,
      originalBytes: Buffer.byteLength(promptRewrite.original), finalBytes: Buffer.byteLength(finalText),
      originalTruncated: original.truncated, finalTruncated: final.truncated,
      applied: promptRewrite.applied,
      ruleResults: promptRewrite.ruleResults
    };
  }
  const protocolLabel = `${incomingProtocol} → ${route.protocol}${route.toolChoiceFallback ? ` (${route.toolChoiceFallback} tool choice)` : ''}`;
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  let upstream;
  try {
    upstream = await callUpstream({ provider: route.provider, protocol: route.protocol, apiKey, proxyUrl: providerProxyUrl(config, route.provider), body: upstreamBody, signal: abort.signal, timeoutMs: config.upstreamTimeoutMs, forwardHeaders: compatibilityHeaders(req, incomingProtocol, route.protocol) });
  } catch (error) {
    const status = upstreamFailureStatus(error);
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status, duration: Date.now() - started, error: error.message }, config);
    return protocolError(res, status, incomingProtocol, `连接上游失败：${error.message}`, 'upstream_error');
  }
  if (!upstream.ok) {
    let text;
    try { text = await readResponseText(upstream, MAX_UPSTREAM_ERROR_BYTES, '上游错误响应'); }
    catch (error) {
      await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status: 502, duration: Date.now() - started, stream: Boolean(body.stream), error: error.message }, config);
      return protocolError(res, 502, incomingProtocol, error.message, 'upstream_error');
    }
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status: upstream.status, duration: Date.now() - started, stream: Boolean(body.stream) }, config);
    if (incomingProtocol === route.protocol && upstream.headers.get('content-type')?.includes('application/json')) {
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(text);
    }
    let message = `OpenCode 上游返回 HTTP ${upstream.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error?.message || parsed.message || message;
    } catch { /* 上游可能返回纯文本 */ }
    return protocolError(res, upstream.status, incomingProtocol, message, 'upstream_error');
  }
  if (body.stream && incomingProtocol === route.protocol) {
    let forwardBody = upstream.body;
    let observation = Promise.resolve({ usage: {}, error: undefined });
    if (typeof upstream.body?.tee === 'function') {
      const [clientBody, observerBody] = upstream.body.tee();
      forwardBody = clientBody;
      observation = observeSse(new Response(observerBody), route.protocol, body.model);
    }
    res.writeHead(upstream.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for await (const chunk of forwardBody) {
      await writeChunk(res, chunk);
    }
    const observed = await observation;
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status: observed.error ? 502 : upstream.status, duration: Date.now() - started, stream: true, ...(observed.error ? { error: observed.error.message || String(observed.error) } : {}), ...observed.usage }, config);
    return res.end();
  }
  if (body.stream) {
    let streamUsage = {};
    let streamError;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for await (const event of translateSse(upstream, route.protocol, incomingProtocol, body.model, {
      onUsage: (usage) => { streamUsage = usage; },
      onError: (error) => { streamError = error?.message || String(error); }
    })) {
      await writeChunk(res, event);
    }
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status: streamError ? 502 : upstream.status, duration: Date.now() - started, stream: true, ...(streamError ? { error: streamError } : {}), ...streamUsage }, config);
    return res.end();
  }
  let upstreamJson;
  try { upstreamJson = await readResponseJson(upstream); }
  catch (error) {
    const status = upstreamFailureStatus(error);
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status, duration: Date.now() - started, stream: false, error: error.message }, config);
    return protocolError(res, status, incomingProtocol, error.message, 'upstream_error');
  }
  let normalizedResponse;
  let clientResponse;
  try {
    normalizedResponse = normalizeResponse(upstreamJson, route.protocol, body.model, { rejectUnknown: incomingProtocol !== route.protocol });
    clientResponse = incomingProtocol === route.protocol ? upstreamJson : formatResponse(normalizedResponse, incomingProtocol);
  } catch (error) {
    await addLog({ requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel, status: 502, duration: Date.now() - started, stream: false, error: error.message }, config);
    return protocolError(res, 502, incomingProtocol, `上游响应结构无效：${error.message}`, 'upstream_error');
  }
  await addLog({
    requestId, clientId: client?.id, clientName: client?.name, model: body.model, provider: route.provider, protocol: protocolLabel,
    status: upstream.status, duration: Date.now() - started, stream: false,
    inputTokens: normalizedResponse.inputTokens, outputTokens: normalizedResponse.outputTokens,
    cachedInputTokens: normalizedResponse.cachedInputTokens, cacheCreationInputTokens: normalizedResponse.cacheCreationInputTokens,
    reasoningTokens: normalizedResponse.reasoningTokens
  }, config);
  return json(res, upstream.status, clientResponse);
}

async function limitedProxyRequest(req, res, url, config, forcedProvider) {
  const client = authenticateClient(req, config);
  const authorized = Boolean(client);
  const protocol = detectProtocol(url.pathname) || 'chat';
  if (authorized && activeProxyRequests >= config.maxConcurrentRequests) {
    res.setHeader('retry-after', '1');
    return protocolError(res, 429, protocol, `并发请求已达到上限 ${config.maxConcurrentRequests}`, 'rate_limit_error');
  }
  const clientActive = authorized ? (activeClientRequests.get(client.id) || 0) : 0;
  const clientLimit = authorized ? Math.min(1000, Math.max(1, Number(client.maxConcurrentRequests) || config.maxConcurrentRequests)) : 0;
  if (authorized && clientActive >= clientLimit) {
    res.setHeader('retry-after', '1');
    return protocolError(res, 429, protocol, `客户端 ${client.name} 的并发请求已达到上限 ${clientLimit}`, 'rate_limit_error');
  }
  if (authorized) {
    activeProxyRequests++;
    activeClientRequests.set(client.id, clientActive + 1);
  }
  try { return await proxyRequest(req, res, url, config, client, forcedProvider); }
  finally {
    if (authorized) {
      activeProxyRequests--;
      const remaining = (activeClientRequests.get(client.id) || 1) - 1;
      if (remaining > 0) activeClientRequests.set(client.id, remaining);
      else activeClientRequests.delete(client.id);
    }
  }
}

async function staticFile(req, res, url) {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const path = resolve(PUBLIC, requested);
  const outside = relative(PUBLIC, path);
  if (outside.startsWith('..') || resolve(path) === resolve(PUBLIC)) return json(res, 403, { error: '禁止访问' });
  try {
    const content = await readFile(path);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'content-length': content.length, 'x-content-type-options': 'nosniff' });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, { error: '文件不存在' });
    throw error;
  }
}

await bootstrapConfigFromEnvironment();

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    const apiScope = publicApiScope(url.pathname);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (url.pathname === '/health' || url.pathname.startsWith('/api/') || apiScope) res.setHeader('cache-control', 'no-store');
    const config = await loadConfig();
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, ready: serviceReady(config), configured: Boolean(config.password), uptime: Math.floor(process.uptime()) });
    }
    if (url.pathname.startsWith('/api/')) return await adminApi(req, res, url, config);
    if (apiScope) {
      const modelsPath = `${apiScope.base}/models`;
      const modelPrefix = `${modelsPath}/`;
      if (url.pathname.startsWith(modelPrefix) && req.method === 'GET') {
        if (!clientAuthorized(req, config)) return json(res, 401, { error: { type: 'authentication_error', message: '访问令牌无效' } });
        let requestedModel;
        try { requestedModel = decodeURIComponent(url.pathname.slice(modelPrefix.length)); }
        catch { return json(res, 400, { error: { message: '模型 ID 编码无效', type: 'invalid_request_error' } }); }
        if (!requestedModel) return json(res, 400, { error: { message: '模型 ID 不能为空', type: 'invalid_request_error' } });
        if (requestedModel.length > 256) return json(res, 400, { error: { message: '模型 ID 不能超过 256 个字符', type: 'invalid_request_error' } });
        const goModel = requestedModel.startsWith('opencode-go/');
        const requestedProvider = url.searchParams.get('provider');
        const provider = apiScope.provider || (goModel ? 'go' : (['zen', 'go'].includes(requestedProvider) ? requestedProvider : config.defaultProvider));
        const upstreamModel = goModel ? requestedModel.slice('opencode-go/'.length) : requestedModel.startsWith('opencode/') ? requestedModel.slice('opencode/'.length) : requestedModel;
        const apiKey = provider === 'go' ? config.goKey : config.zenKey;
        if (!apiKey) return json(res, 503, { error: { message: `尚未配置 OpenCode ${provider === 'go' ? 'Go' : 'Zen'} 密钥` } });
        try {
          const upstream = await listModels({ provider, apiKey, proxyUrl: providerProxyUrl(config, provider), timeoutMs: config.upstreamTimeoutMs });
          const body = await readResponseJson(upstream, MAX_MODEL_LIST_BYTES, '模型列表');
          if (!upstream.ok) return json(res, upstream.status, body);
          const model = (Array.isArray(body.data) ? body.data : []).find((item) => item.id === upstreamModel);
          if (!model) return json(res, 404, { error: { message: `模型 ${requestedModel} 不存在`, type: 'not_found_error' } });
          return json(res, 200, { ...model, id: requestedModel, provider });
        } catch (error) { return json(res, upstreamFailureStatus(error), { error: { message: `连接上游失败：${error.message}`, type: 'upstream_error' } }); }
      }
      if (url.pathname === modelsPath && req.method === 'GET') {
        if (!clientAuthorized(req, config)) return json(res, 401, { error: { type: 'authentication_error', message: '访问令牌无效' } });
        const requestedProvider = url.searchParams.get('provider');
        const provider = apiScope.provider || (['zen', 'go', 'all'].includes(requestedProvider) ? requestedProvider : config.defaultProvider);
        if (provider === 'all') {
          const available = [
            ...(config.zenKey ? [{ provider: 'zen', apiKey: config.zenKey }] : []),
            ...(config.goKey ? [{ provider: 'go', apiKey: config.goKey }] : [])
          ];
          if (!available.length) return json(res, 503, { error: { message: '尚未配置 OpenCode Zen 或 Go 密钥' } });
          const settled = await Promise.allSettled(available.map(async (item) => {
            const response = await listModels({ ...item, proxyUrl: providerProxyUrl(config, item.provider), timeoutMs: config.upstreamTimeoutMs });
            const body = await readResponseJson(response, MAX_MODEL_LIST_BYTES, `${item.provider} 模型列表`);
            if (!response.ok) throw new Error(body.error?.message || `${item.provider} 返回 HTTP ${response.status}`);
            return (Array.isArray(body.data) ? body.data : []).map((model) => ({
              ...model,
              id: item.provider === 'go' ? `opencode-go/${model.id}` : model.id,
              provider: item.provider
            }));
          }));
          const models = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
          const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
          if (!models.length && errors.length) return json(res, 502, { error: { message: errors.join('；'), type: 'upstream_error' } });
          return json(res, 200, { object: 'list', data: models, ...(errors.length ? { warnings: errors } : {}) });
        }
        const apiKey = provider === 'go' ? config.goKey : config.zenKey;
        if (!apiKey) return json(res, 503, { error: { message: `尚未配置 OpenCode ${provider === 'go' ? 'Go' : 'Zen'} 密钥` } });
        try {
          const upstream = await listModels({ provider, apiKey, proxyUrl: providerProxyUrl(config, provider), timeoutMs: config.upstreamTimeoutMs });
          const content = await readResponseText(upstream, MAX_MODEL_LIST_BYTES, '模型列表');
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
          return res.end(content);
        } catch (error) {
          return json(res, upstreamFailureStatus(error), { error: { message: `连接上游失败：${error.message}`, type: 'upstream_error' } });
        }
      }
      if (![`${apiScope.base}/messages`, `${apiScope.base}/responses`, `${apiScope.base}/chat/completions`].includes(url.pathname)) {
        return json(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: '该接口仅支持 POST' });
      return await limitedProxyRequest(req, res, url, config, apiScope.provider);
    }
    if (req.method === 'GET') return await staticFile(req, res, url);
    return json(res, 405, { error: '方法不允许' });
  } catch (error) {
    if (!error.status && error.code !== 'CLIENT_CLOSED' && error.name !== 'AbortError') console.error(error);
    if (!res.headersSent && url && publicApiScope(url.pathname)) {
      const status = error.status || 500;
      protocolError(res, status, detectProtocol(url.pathname) || 'chat', error.status ? error.message : '服务器内部错误', error.status ? 'invalid_request_error' : 'internal_error');
    } else if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`OpenCode Bridge 已启动：http://${HOST}:${PORT}`));
server.on('error', (error) => {
  console.error(`服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await requestLogs.flush().catch((error) => console.error(`退出前刷新请求日志失败：${error.message}`));
    await closeProxyDispatchers();
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000).unref();
  });
}
