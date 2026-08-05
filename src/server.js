import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hashPassword, verifyPassword, createSession, verifySession, loginAllowed, recordLogin, cookieValue, hashClientToken, clientAddress } from './auth.js';
import { loadConfig, saveConfig, updateConfig, publicConfig, configRevision, normalizeImageHandoffModels, normalizeModelRoutes, ROOT } from './config.js';
import { detectProtocol, upstreamProtocol, prepareUpstreamRequest, normalizeResponse, formatResponse, hasUsageData } from './adapters.js';
import { callUpstream, closeDirectUpstreamDispatcher, isUpstreamConnectionError, listModels, MAX_MODEL_LIST_BYTES, MAX_UPSTREAM_ERROR_BYTES, readResponseJson, readResponseText, upstreamConnectionFailure } from './upstream.js';
import { closeProxyDispatchers, normalizeProxyUrl, providerProxyUrl, singBoxRuntimeStatus } from './proxy.js';
import { configuredProviderCredentials, environmentProviderCredentials, MAX_PROVIDER_KEYS, storedProviderCredentialEntries } from './provider-credentials.js';
import { CredentialHealthTracker } from './credential-health.js';
import { createSseObserver, translateSse } from './stream.js';
import { RequestLogStore } from './request-log.js';
import { aggregateRequestStats } from './stats.js';
import { applyPromptRules, MAX_PROMPT_BYTES, normalizePromptRules, promptSnapshotText, rewriteClaudeSystem } from './prompt-rewrite.js';
import { ImageHandoffStore, imageHandoffStorageOptions, localImageHandoffEnabled } from './image-handoff.js';
import { canonicalStaticRoot, ifNoneMatchMatches, resolveStaticFile } from './static-files.js';
import { writeResponseChunk } from './response-write.js';
import { parseRequestTarget } from './request-target.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须是 1–65535 之间的整数');
const TRUST_PROXY = /^(?:1|true)$/i.test(String(process.env.OPENCODE_BRIDGE_TRUST_PROXY || ''));
const REQUIRE_ENV_BOOTSTRAP = /^(?:1|true)$/i.test(String(process.env.OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP || ''));
const MAX_ADMIN_MUTATIONS = Number(process.env.OPENCODE_BRIDGE_MAX_ADMIN_MUTATIONS || 16);
if (!Number.isInteger(MAX_ADMIN_MUTATIONS) || MAX_ADMIN_MUTATIONS < 1 || MAX_ADMIN_MUTATIONS > 128) throw new Error('OPENCODE_BRIDGE_MAX_ADMIN_MUTATIONS 必须是 1–128 之间的整数');
const MAX_ADMIN_MODEL_DISCOVERIES = Number(process.env.OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES || 4);
if (!Number.isInteger(MAX_ADMIN_MODEL_DISCOVERIES) || MAX_ADMIN_MODEL_DISCOVERIES < 1 || MAX_ADMIN_MODEL_DISCOVERIES > 32) throw new Error('OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES 必须是 1–32 之间的整数');
const MAX_HTTP_CONNECTIONS = Number(process.env.OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS || 256);
if (!Number.isInteger(MAX_HTTP_CONNECTIONS) || MAX_HTTP_CONNECTIONS < 1 || MAX_HTTP_CONNECTIONS > 10_000) throw new Error('OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS 必须是 1–10000 之间的整数');
const STREAM_WRITE_TIMEOUT_MS = Number(process.env.OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS || 30_000);
if (!Number.isInteger(STREAM_WRITE_TIMEOUT_MS) || STREAM_WRITE_TIMEOUT_MS < 100 || STREAM_WRITE_TIMEOUT_MS > 300_000) throw new Error('OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS 必须是 100–300000 之间的整数');
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_HTTP_HEADERS = 128;
const MAX_REQUESTS_PER_SOCKET = 1000;
const CONNECTIONS_CHECKING_INTERVAL_MS = 1000;
const SINGLETON_REQUEST_HEADERS = new Set([
  'authorization', 'x-api-key', 'cookie', 'host', 'origin', 'sec-fetch-site',
  'content-type', 'content-encoding', 'content-length', 'transfer-encoding',
  'if-match', 'x-forwarded-for', 'x-forwarded-proto', 'anthropic-version'
]);
const MAX_ADMIN_REQUEST_BYTES = 64 * 1024;
const MAX_CONFIG_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_PREVIEW_REQUEST_BYTES = 2 * MAX_PROMPT_BYTES + 128 * 1024;
const MAX_PROXY_REQUEST_BYTES = 10 * 1024 * 1024;
const JSON_DECODER = new TextDecoder('utf-8', { fatal: true });
const PUBLIC = join(ROOT, 'public');
const PUBLIC_ROOT = await canonicalStaticRoot(PUBLIC);
const requestLogs = new RequestLogStore(process.env.LOG_FILE || resolve(ROOT, 'data', 'request-logs.json'));
const imageHandoffPublicUrl = process.env.OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL || '';
const imageHandoff = new ImageHandoffStore({
  enabled: localImageHandoffEnabled(HOST, process.env.OPENCODE_BRIDGE_IMAGE_HANDOFF),
  publicBaseUrl: imageHandoffPublicUrl,
  ...imageHandoffStorageOptions(process.env),
  ...(process.env.OPENCODE_BRIDGE_IMAGE_HANDOFF_DIR ? { baseDirectory: process.env.OPENCODE_BRIDGE_IMAGE_HANDOFF_DIR } : {})
});
let setupInProgress = false;
let activeLogins = 0;
let activeAdminMutations = 0;
let activeAdminModelDiscoveries = 0;
let activePublicRequests = 0;
let activeHttpRequests = 0;
let activeHttpConnections = 0;
const activeClientRequests = new Map();
let recentClaudePrompt = null;
const environmentCredentialPools = {
  zen: environmentProviderCredentials(process.env, 'zen'),
  go: environmentProviderCredentials(process.env, 'go')
};
const credentialHealth = new CredentialHealthTracker();

function requestProtocol(req) {
  if (req.socket.encrypted) return 'https';
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',', 1)[0].trim().toLowerCase()
    : '';
  return TRUST_PROXY && ['http', 'https'].includes(forwardedProto) ? forwardedProto : 'http';
}

function sessionCookie(req, token, maxAge = 86400) {
  const secure = requestProtocol(req) === 'https';
  return `bridge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const json = (res, status, data, headers = {}) => {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
};

function protocolError(res, status, protocol, message, type = 'invalid_request_error', headers = {}, code = null) {
  if (protocol === 'claude') return json(res, status, { type: 'error', error: { type, message } }, headers);
  return json(res, status, { error: { message, type, code } }, headers);
}

function streamProtocolError(protocol, message, responseSequenceNumber = 0, code = 'upstream_error') {
  const error = { message, type: 'upstream_error', code };
  if (protocol === 'chat') return `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`;
  if (protocol === 'responses') return `event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null, sequence_number: Number.isSafeInteger(responseSequenceNumber) && responseSequenceNumber >= 0 ? responseSequenceNumber : 0 })}\n\n`;
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: error.type, message } })}\n\n`;
}

function upstreamFailureStatus(error) {
  return upstreamConnectionFailure(error).status;
}

function upstreamOperationFailure(error) {
  const responseCodes = {
    UPSTREAM_BODY_TOO_LARGE: 'upstream_response_too_large',
    UPSTREAM_INVALID_JSON: 'upstream_invalid_json'
  };
  return {
    status: error?.upstreamCode ? upstreamFailureStatus(error) : 502,
    code: error?.upstreamCode || responseCodes[error?.code] || 'upstream_response_error',
    message: error?.message || '处理上游响应失败'
  };
}

function streamFailure(error, res, abort) {
  const clientClosed = ['CLIENT_CLOSED', 'CLIENT_WRITE_TIMEOUT'].includes(error?.code)
    || (abort.signal.aborted && !res.writableEnded);
  const credentialNeutral = ['UPSTREAM_SSE_EVENT_TOO_LARGE', 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT'].includes(error?.code);
  const networkFailure = isUpstreamConnectionError(error) ? upstreamConnectionFailure(error) : null;
  return clientClosed
    ? { status: 499, message: error?.code === 'CLIENT_WRITE_TIMEOUT' ? error.message : '客户端在流式响应完成前断开', penalizeCredential: false }
    : {
        status: networkFailure?.status || upstreamFailureStatus(error),
        message: networkFailure?.message || error?.message || String(error),
        code: networkFailure?.code || 'upstream_error',
        penalizeCredential: !credentialNeutral
      };
}

function clientAbortSignal(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.off('aborted', abort);
    res.off('close', onClose);
    res.off('finish', cleanup);
  };
  const abort = () => {
    cleanup();
    controller.abort(Object.assign(new Error('客户端已断开'), { code: 'CLIENT_CLOSED' }));
  };
  const onClose = () => {
    if (!res.writableEnded) abort();
    else cleanup();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  res.once('finish', cleanup);
  if (req.aborted || res.destroyed) abort();
  return controller.signal;
}

function isIncompleteSseError(error) {
  return error?.message === '上游 SSE 在完成事件前结束';
}

function compatibilityHeaders(req, incomingProtocol, targetProtocol) {
  if (incomingProtocol !== targetProtocol) return {};
  if (targetProtocol === 'claude') return Object.fromEntries(['anthropic-version', 'anthropic-beta']
    .flatMap((name) => typeof req.headers[name] === 'string' ? [[name, req.headers[name]]] : []));
  return typeof req.headers['openai-beta'] === 'string' ? { 'openai-beta': req.headers['openai-beta'] } : {};
}

async function bodyJson(req, limit = MAX_ADMIN_REQUEST_BYTES) {
  const contentType = typeof req.headers['content-type'] === 'string'
    ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase()
    : '';
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(contentType)) {
    throw Object.assign(new Error('JSON 请求的 Content-Type 必须是 application/json 或 application/*+json'), { status: 415 });
  }
  const contentEncoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw Object.assign(new Error('JSON 请求不支持压缩 Content-Encoding'), { status: 415 });
  }
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
    const body = JSON.parse(JSON_DECODER.decode(Buffer.concat(chunks, size)) || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
}

function formatSizeLimit(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024 * 10) / 10} KiB`;
  const mib = bytes / 1024 / 1024;
  return `${Number.isInteger(mib) ? mib : Math.round(mib * 10) / 10} MiB`;
}

function duplicatedSingletonHeader(req) {
  const seen = new Set();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (!SINGLETON_REQUEST_HEADERS.has(name)) continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
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

function validAlphaNumericSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{6,256}$/.test(value);
}

function randomClientToken() {
  return randomBytes(24).toString('hex');
}

function admin(req, config) {
  return verifySession(cookieValue(req.headers.cookie, 'bridge_session'), config.sessionSecret);
}

function mutationOriginAllowed(req) {
  if (String(req.headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false;
  try {
    const supplied = origin.trim();
    const parsed = new URL(supplied);
    const expected = new URL(`${requestProtocol(req)}://${req.headers.host}`).origin;
    return supplied === parsed.origin && parsed.origin === expected;
  }
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

function publicClient(client) {
  return {
    id: client.id, name: client.name, tokenPrefix: client.tokenPrefix,
    enabled: client.enabled !== false, maxConcurrentRequests: client.maxConcurrentRequests,
    createdAt: client.createdAt
  };
}

function serviceReady(config) {
  const hasClient = Boolean(config.clientToken) || (Array.isArray(config.apiClients) && config.apiClients.some((client) => client?.enabled !== false && typeof client.tokenHash === 'string'));
  return Boolean(config.password && hasClient && (providerCredentials(config, 'zen').length || providerCredentials(config, 'go').length));
}

function providerCredentials(config, provider) {
  return configuredProviderCredentials(config, provider, environmentCredentialPools[provider]);
}

function selectProviderCredential(config, provider) {
  return credentialHealth.select(provider, providerCredentials(config, provider));
}

function credentialUnavailableMessage(provider, selection) {
  if (selection.reason === 'cooldown') return `OpenCode ${provider === 'go' ? 'Go' : 'Zen'} 的全部 Key 正在冷却，请稍后重试`;
  return `尚未配置 OpenCode ${provider === 'go' ? 'Go' : 'Zen'} 密钥`;
}

function applyCredentialRetryHeader(res, selection) {
  if (selection.reason === 'cooldown') res.setHeader('retry-after', String(Math.max(1, Math.ceil(selection.retryAfterMs / 1000))));
}

function applyUpstreamResponseHeaders(res, response) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && retryAfter.length <= 1024) res.setHeader('retry-after', retryAfter);
  for (const [name, value] of response.headers) {
    if (/^(?:x-)?ratelimit-(?:limit|remaining|reset)(?:-(?:requests|tokens))?$/.test(name) && value.length <= 1024) res.setHeader(name, value);
  }
  const upstreamRequestId = ['x-request-id', 'request-id', 'x-trace-id']
    .map((name) => response.headers.get(name))
    .find((value) => value && value.length <= 256);
  if (upstreamRequestId) res.setHeader('x-opencode-upstream-request-id', upstreamRequestId);
  return {
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
    ...(retryAfter && retryAfter.length <= 1024 ? { retryAfter } : {})
  };
}

function recordCredentialResponse(provider, credential, response) {
  credentialHealth.recordResponse(provider, credential, response.status, response.headers.get('retry-after'));
}

async function readModelResponse(response, label, jsonBody = false) {
  const text = await readResponseText(response, MAX_MODEL_LIST_BYTES, label);
  if (!response.ok && !jsonBody) return text;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Object.assign(new Error(`${label}格式无效`), { code: 'UPSTREAM_INVALID_JSON' }); }
  return jsonBody ? parsed : text;
}

async function listModelsWithCredentialFailover(config, provider, signal, { jsonBody = false, label = '模型列表' } = {}) {
  const credentials = providerCredentials(config, provider);
  const initial = credentialHealth.select(provider, credentials);
  if (!initial.credential) return { response: null, credential: null, attempts: 0, selection: initial };

  const attemptedIds = new Set();
  let credential = initial.credential;
  let attempts = 0;
  while (credential && attempts < credentials.length) {
    attempts++;
    attemptedIds.add(credential.credentialId);
    let response;
    try {
      response = await listModels({ provider, ...credential, signal, timeoutMs: config.upstreamTimeoutMs });
    } catch (error) {
      if (signal?.aborted) {
        credentialHealth.releaseProbe(provider, credential);
        throw Object.assign(new Error('客户端已断开', { cause: error }), { code: 'CLIENT_CLOSED' });
      }
      const failure = upstreamConnectionFailure(error);
      credentialHealth.recordNetworkFailure(provider, credential, failure.status);
      const remaining = credentials.filter((item) => !attemptedIds.has(item.credentialId));
      const replacement = remaining.length ? credentialHealth.select(provider, remaining).credential : null;
      if (replacement) {
        credential = replacement;
        continue;
      }
      throw Object.assign(new Error(failure.message, { cause: error }), { credentialAttempts: attempts, upstreamCode: failure.code });
    }
    const retryable = [401, 403, 429].includes(response.status) || response.status >= 500;
    let responseRecorded = false;
    if (retryable) {
      recordCredentialResponse(provider, credential, response);
      responseRecorded = true;
      if (attempts < credentials.length) {
        const remaining = credentials.filter((item) => !attemptedIds.has(item.credentialId));
        const replacement = remaining.length ? credentialHealth.select(provider, remaining).credential : null;
        if (replacement) {
          await response.body?.cancel().catch(() => {});
          credential = replacement;
          continue;
        }
      }
    }
    let body;
    try {
      body = await readModelResponse(response, label, jsonBody);
    } catch (error) {
      if (signal?.aborted) {
        if (!responseRecorded) credentialHealth.releaseProbe(provider, credential);
        throw Object.assign(new Error('客户端已断开', { cause: error }), { code: 'CLIENT_CLOSED', credentialAttempts: attempts });
      }
      const networkFailure = isUpstreamConnectionError(error) ? upstreamConnectionFailure(error) : null;
      if (networkFailure && !responseRecorded) credentialHealth.recordNetworkFailure(provider, credential, networkFailure.status);
      else if (!responseRecorded) credentialHealth.releaseProbe(provider, credential);
      if (networkFailure) {
        const remaining = credentials.filter((item) => !attemptedIds.has(item.credentialId));
        const replacement = remaining.length ? credentialHealth.select(provider, remaining).credential : null;
        if (replacement) {
          await response.body?.cancel().catch(() => {});
          credential = replacement;
          continue;
        }
        throw Object.assign(new Error(networkFailure.message, { cause: error }), { credentialAttempts: attempts, upstreamCode: networkFailure.code });
      }
      throw Object.assign(new Error(error.message, { cause: error }), { code: error.code, credentialAttempts: attempts });
    }
    if (!responseRecorded) recordCredentialResponse(provider, credential, response);
    return { response, body, credential, attempts, selection: null };
  }
  return { response: null, credential: null, attempts, selection: { reason: 'unconfigured', retryAfterMs: 0 } };
}

function credentialHealthSnapshot(config) {
  return ['zen', 'go'].flatMap((provider) => credentialHealth.snapshot(provider, providerCredentials(config, provider)));
}

function providerCredentialFields(provider) {
  return provider === 'go'
    ? { collection: 'goCredentials', legacyKey: 'goKey', legacyProxy: 'goProxyUrl' }
    : { collection: 'zenCredentials', legacyKey: 'zenKey', legacyProxy: 'zenProxyUrl' };
}

function panelCredentialName(value, fallback = '') {
  const name = String(value ?? fallback).trim();
  if (!name || name.length > 64) throw Object.assign(new Error('Key 名称长度必须为 1–64 个字符'), { status: 400 });
  return name;
}

function panelCredentialKey(value, required = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string') throw Object.assign(new Error('API Key 必须是字符串'), { status: 400 });
  const apiKey = value.trim();
  if (required && !apiKey) throw Object.assign(new Error('API Key 不能为空'), { status: 400 });
  if (apiKey.length > 4096) throw Object.assign(new Error('API Key 不能超过 4096 个字符'), { status: 400 });
  return apiKey || null;
}

function panelCredentialProxy(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 4096) throw Object.assign(new Error('Key 代理必须是长度不超过 4096 的字符串'), { status: 400 });
  try { return normalizeProxyUrl(value); }
  catch (error) { throw Object.assign(new Error(`Key 代理无效：${error.message}`), { status: 400 }); }
}

function withStoredCredentials(config, provider, entries) {
  const fields = providerCredentialFields(provider);
  return { ...config, [fields.collection]: entries, [fields.legacyKey]: '', [fields.legacyProxy]: '' };
}

function configPrecondition(req, snapshot) {
  const value = req.headers['if-match'];
  if (value === undefined) return configRevision(snapshot);
  if (typeof value !== 'string') throw Object.assign(new Error('If-Match 配置修订号格式无效'), { status: 400 });
  const match = /^"([a-f0-9]{32})"$/.exec(value.trim());
  if (!match) throw Object.assign(new Error('If-Match 配置修订号格式无效'), { status: 400 });
  return match[1];
}

async function runtimePublicConfig(config) {
  const base = publicConfig(config);
  const singBoxRuntime = await singBoxRuntimeStatus();
  const environmentCredentials = (provider) => environmentCredentialPools[provider].map((credential) => ({
    id: credential.credentialId.split(':')[1],
    name: `${provider.toUpperCase()} 环境 #${credential.credentialId.split(':')[1]}`,
    proxyConfigured: Boolean(credential.proxyUrl)
  }));
  return {
    ...base,
    zenEnvironmentKeyCount: environmentCredentialPools.zen.length,
    goEnvironmentKeyCount: environmentCredentialPools.go.length,
    zenEnvironmentCredentials: environmentCredentials('zen'),
    goEnvironmentCredentials: environmentCredentials('go'),
    imageHandoffTransport: imageHandoff.publicBaseUrl ? 'remote' : imageHandoff.enabled ? 'local' : 'disabled',
    singBoxRuntime,
    zenProxyConfigured: environmentCredentialPools.zen.some((credential) => credential.proxyUrl) || base.zenProxyConfigured,
    goProxyConfigured: environmentCredentialPools.go.some((credential) => credential.proxyUrl) || base.goProxyConfigured
  };
}

async function runtimeConfigResponse(res, status, config) {
  const body = await runtimePublicConfig(config);
  return json(res, status, body, { etag: `"${body.revision}"` });
}

function configMutationResponse(res, status, data, config) {
  const revision = configRevision(config);
  return json(res, status, { ...data, revision }, { etag: `"${revision}"` });
}

async function bootstrapConfigFromEnvironment() {
  const current = await loadConfig();
  if (current.password) return;
  const adminPassword = String(process.env.OPENCODE_BRIDGE_ADMIN_PASSWORD || '').trim();
  if (!adminPassword) {
    if (REQUIRE_ENV_BOOTSTRAP) throw new Error('启用了 OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP 时必须配置 OPENCODE_BRIDGE_ADMIN_PASSWORD');
    return;
  }
  if (!validAlphaNumericSecret(adminPassword)) throw new Error('OPENCODE_BRIDGE_ADMIN_PASSWORD 必须是 6–256 位英文字母或数字');

  const secret = (name, fallback = '') => {
    const value = String(process.env[name] ?? fallback).trim();
    if (value.length > 4096) throw new Error(`${name} 不能超过 4096 个字符`);
    return value;
  };
  const configuredClientToken = secret('OPENCODE_BRIDGE_CLIENT_TOKEN');
  if (REQUIRE_ENV_BOOTSTRAP && !configuredClientToken) throw new Error('启用了 OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP 时必须配置 OPENCODE_BRIDGE_CLIENT_TOKEN');
  const clientToken = configuredClientToken || randomClientToken();
  if (!validAlphaNumericSecret(clientToken)) throw new Error('OPENCODE_BRIDGE_CLIENT_TOKEN 必须是 6–256 位英文字母或数字');
  const defaultProvider = String(process.env.OPENCODE_BRIDGE_DEFAULT_PROVIDER || current.defaultProvider).trim().toLowerCase();
  if (!['zen', 'go'].includes(defaultProvider)) throw new Error('OPENCODE_BRIDGE_DEFAULT_PROVIDER 仅支持 zen 或 go');

  const proxy = (name, fallback = '') => {
    const value = String(process.env[name] ?? fallback).trim();
    if (value.length > 4096) throw new Error(`${name} 不能超过 4096 个字符`);
    return normalizeProxyUrl(value);
  };
  await saveConfig({
    ...current,
    password: await hashPassword(adminPassword),
    sessionSecret: randomBytes(32).toString('hex'),
    clientToken,
    zenKey: current.zenKey,
    goKey: current.goKey,
    proxyUrl: proxy('OPENCODE_PROXY_URL', current.proxyUrl),
    zenProxyUrl: current.zenProxyUrl,
    goProxyUrl: current.goProxyUrl,
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

const ADMIN_EXACT_METHODS = new Map([
  ['/api/setup', ['POST']],
  ['/api/login', ['POST']],
  ['/api/session', ['GET']],
  ['/api/logout', ['POST']],
  ['/api/config', ['GET', 'PUT']],
  ['/api/credential-health/reset', ['POST']],
  ['/api/provider-credentials', ['POST']],
  ['/api/prompt-rewrite/recent', ['GET', 'DELETE']],
  ['/api/prompt-rewrite/preview', ['POST']],
  ['/api/password', ['PUT']],
  ['/api/token/regenerate', ['POST']],
  ['/api/clients', ['GET', 'POST']],
  ['/api/logs', ['GET', 'DELETE']],
  ['/api/stats', ['GET']],
  ['/api/status', ['GET']],
  ['/api/models', ['GET']],
  ['/api/models/test', ['POST']]
]);

function adminAllowedMethods(pathname) {
  const exact = ADMIN_EXACT_METHODS.get(pathname);
  if (exact) return exact;
  if (/^\/api\/provider-credentials\/(?:zen|go)\/[A-Za-z0-9_-]{1,64}$/.test(pathname)) return ['PUT', 'DELETE'];
  if (/^\/api\/clients\/[a-f0-9]{16}\/regenerate$/.test(pathname)) return ['POST'];
  if (/^\/api\/clients\/[a-f0-9]{16}$/.test(pathname)) return ['PUT', 'DELETE'];
  return null;
}

function adminMethodNotAllowed(res, allowedMethods) {
  return json(res, 405, { error: `该接口仅支持 ${allowedMethods.join('、')}` }, { allow: allowedMethods.join(', ') });
}

async function adminApi(req, res, url, config) {
  const mutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  if (!mutation) return adminApiOperation(req, res, url, config);
  if (!mutationOriginAllowed(req)) return json(res, 403, { error: '请求来源校验失败' });
  if (activeAdminMutations >= MAX_ADMIN_MUTATIONS) {
    return json(res, 429, { error: `管理操作并发已达到上限 ${MAX_ADMIN_MUTATIONS}` }, { 'retry-after': '1' });
  }
  activeAdminMutations++;
  try { return await adminApiOperation(req, res, url, config); }
  finally { activeAdminMutations--; }
}

async function adminApiOperation(req, res, url, config) {
  const allowedMethods = adminAllowedMethods(url.pathname);
  if (allowedMethods && ['/api/setup', '/api/login', '/api/session'].includes(url.pathname) && !allowedMethods.includes(req.method)) {
    return adminMethodNotAllowed(res, allowedMethods);
  }
  if (url.pathname === '/api/setup' && req.method === 'POST') {
    if (config.password || setupInProgress) return json(res, 409, { error: '管理密码已经初始化或正在初始化' });
    const body = await bodyJson(req);
    if (!validAlphaNumericSecret(body.password)) return json(res, 400, { error: '密码必须是 6–256 位英文字母或数字' });
    if (setupInProgress) return json(res, 409, { error: '管理密码已经初始化或正在初始化' });
    setupInProgress = true;
    try {
      const latest = await loadConfig();
      if (latest.password) return json(res, 409, { error: '管理密码已经初始化或正在初始化' });
      const updated = { ...latest, password: await hashPassword(body.password), sessionSecret: randomBytes(32).toString('hex'), clientToken: randomClientToken() };
      await saveConfig(updated);
      const token = createSession(updated.sessionSecret);
      return json(res, 200, { ok: true, clientToken: updated.clientToken }, { 'set-cookie': sessionCookie(req, token) });
    } finally { setupInProgress = false; }
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = clientAddress(req, TRUST_PROXY);
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
  if (allowedMethods && !allowedMethods.includes(req.method)) return adminMethodNotAllowed(res, allowedMethods);

  if (url.pathname === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });

  if (url.pathname === '/api/config' && req.method === 'GET') return runtimeConfigResponse(res, 200, config);
  if (url.pathname === '/api/credential-health/reset' && req.method === 'POST') {
    const body = await bodyJson(req);
    const provider = body.provider === 'go' ? 'go' : body.provider === 'zen' ? 'zen' : null;
    if (!provider) return json(res, 400, { error: 'provider 仅支持 zen 或 go' });
    const credentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
    const credential = providerCredentials(config, provider).find((item) => item.credentialId === credentialId);
    if (!credential) return json(res, 404, { error: '指定的 Key 槽位不存在' });
    credentialHealth.reset(provider, credential);
    return json(res, 200, { ok: true, credential: credentialHealth.snapshot(provider, [credential])[0] });
  }
  if (url.pathname === '/api/provider-credentials' && req.method === 'POST') {
    const expectedRevision = configPrecondition(req, config);
    const body = await bodyJson(req);
    const provider = body.provider === 'go' ? 'go' : body.provider === 'zen' ? 'zen' : null;
    if (!provider) return json(res, 400, { error: 'provider 仅支持 zen 或 go' });
    const apiKey = panelCredentialKey(body.apiKey, true);
    const proxyUrl = panelCredentialProxy(body.proxyUrl, '');
    const id = randomBytes(8).toString('hex');
    const saved = await updateConfig((current) => {
      const entries = storedProviderCredentialEntries(current, provider);
      if (entries.length >= MAX_PROVIDER_KEYS) throw Object.assign(new Error(`${provider.toUpperCase()} 面板最多支持 ${MAX_PROVIDER_KEYS} 把 Key`), { status: 400 });
      const name = panelCredentialName(body.name, `Key ${entries.length + 1}`);
      if (entries.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Object.assign(new Error('同一上游的 Key 名称不能重复'), { status: 409 });
      return withStoredCredentials(current, provider, [...entries, { id, name, apiKey, proxyUrl }]);
    }, { expectedRevision });
    return runtimeConfigResponse(res, 201, saved);
  }
  const providerCredentialMatch = url.pathname.match(/^\/api\/provider-credentials\/(zen|go)\/([A-Za-z0-9_-]{1,64})$/);
  if (providerCredentialMatch && req.method === 'PUT') {
    const [, provider, id] = providerCredentialMatch;
    const expectedRevision = configPrecondition(req, config);
    const body = await bodyJson(req);
    const saved = await updateConfig((current) => {
      const entries = storedProviderCredentialEntries(current, provider);
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw Object.assign(new Error('面板 Key 不存在'), { status: 404 });
      const name = panelCredentialName(body.name, entries[index].name);
      if (entries.some((entry, entryIndex) => entryIndex !== index && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Object.assign(new Error('同一上游的 Key 名称不能重复'), { status: 409 });
      const apiKey = panelCredentialKey(body.apiKey) || entries[index].apiKey;
      const proxyUrl = panelCredentialProxy(body.proxyUrl, entries[index].proxyUrl);
      const replacement = { ...entries[index], name, apiKey, proxyUrl };
      return withStoredCredentials(current, provider, entries.map((entry, entryIndex) => entryIndex === index ? replacement : entry));
    }, { expectedRevision });
    return runtimeConfigResponse(res, 200, saved);
  }
  if (providerCredentialMatch && req.method === 'DELETE') {
    const [, provider, id] = providerCredentialMatch;
    const expectedRevision = configPrecondition(req, config);
    const saved = await updateConfig((current) => {
      const entries = storedProviderCredentialEntries(current, provider);
      if (!entries.some((entry) => entry.id === id)) throw Object.assign(new Error('面板 Key 不存在'), { status: 404 });
      return withStoredCredentials(current, provider, entries.filter((entry) => entry.id !== id));
    }, { expectedRevision });
    return runtimeConfigResponse(res, 200, saved);
  }
  if (url.pathname === '/api/prompt-rewrite/recent' && req.method === 'GET') return json(res, 200, recentClaudePrompt || {});
  if (url.pathname === '/api/prompt-rewrite/recent' && req.method === 'DELETE') {
    recentClaudePrompt = null;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/prompt-rewrite/preview' && req.method === 'POST') {
    const body = await bodyJson(req, MAX_PROMPT_PREVIEW_REQUEST_BYTES);
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
    const next = await bodyJson(req, MAX_CONFIG_REQUEST_BYTES);
    const expectedRevision = configPrecondition(req, config);
    const updated = { ...config };
    const normalizedProxies = {};
    for (const [field, label] of [['proxyUrl', '默认代理'], ['zenProxyUrl', 'Zen 代理'], ['goProxyUrl', 'Go 代理']]) {
      if (!Object.hasOwn(next, field)) {
        normalizedProxies[field] = config[field] || '';
        continue;
      }
      if (String(next[field] || '').length > 4096) return json(res, 400, { error: `${label}地址过长` });
      try { normalizedProxies[field] = normalizeProxyUrl(next[field]); }
      catch (error) { return json(res, 400, { error: `${label}无效：${error.message}` }); }
    }
    if (!['zen', 'go'].includes(next.defaultProvider)) return json(res, 400, { error: '默认提供方无效' });
    let modelRoutes;
    try { modelRoutes = normalizeModelRoutes(next.modelRoutes); }
    catch (error) { return json(res, 400, { error: error.message }); }
    let promptRewriteRules;
    try { promptRewriteRules = normalizePromptRules(next.promptRewriteRules ?? config.promptRewriteRules); }
    catch (error) { return json(res, 400, { error: error.message }); }
    let imageHandoffModels;
    try { imageHandoffModels = normalizeImageHandoffModels(next.imageHandoffModels ?? config.imageHandoffModels); }
    catch (error) { return json(res, 400, { error: error.message }); }
    for (const key of ['zenKey', 'goKey', 'clientToken']) {
      if (Object.hasOwn(next, key) && typeof next[key] !== 'string') return json(res, 400, { error: `${key} 必须是字符串` });
      if (typeof next[key] === 'string' && next[key]) {
        const value = next[key].trim();
        if (value.length > 4096) return json(res, 400, { error: `${key} 长度无效` });
        if (key === 'clientToken' && !validAlphaNumericSecret(value)) return json(res, 400, { error: '客户端访问令牌必须是 6–256 位英文字母或数字' });
        updated[key] = value;
      }
    }
    const replaceZenKey = typeof next.zenKey === 'string' && Boolean(next.zenKey.trim());
    const replaceGoKey = typeof next.goKey === 'string' && Boolean(next.goKey.trim());
    if (next.clearZenKey) { updated.zenKey = ''; updated.zenCredentials = []; }
    else if (replaceZenKey) { updated.zenCredentials = [{ id: 'legacy-zen', name: '默认 Key', apiKey: updated.zenKey, proxyUrl: normalizedProxies.zenProxyUrl }]; updated.zenKey = ''; }
    if (next.clearGoKey) { updated.goKey = ''; updated.goCredentials = []; }
    else if (replaceGoKey) { updated.goCredentials = [{ id: 'legacy-go', name: '默认 Key', apiKey: updated.goKey, proxyUrl: normalizedProxies.goProxyUrl }]; updated.goKey = ''; }
    updated.proxyUrl = normalizedProxies.proxyUrl;
    updated.zenProxyUrl = normalizedProxies.zenProxyUrl;
    updated.goProxyUrl = normalizedProxies.goProxyUrl;
    if (next.clearProxy) updated.proxyUrl = '';
    if (next.clearZenProxy) updated.zenProxyUrl = '';
    if (next.clearGoProxy) updated.goProxyUrl = '';
    updated.defaultProvider = next.defaultProvider;
    updated.modelRoutes = modelRoutes;
    updated.imageHandoffModels = imageHandoffModels;
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
      zenKey: next.clearZenKey || replaceZenKey ? updated.zenKey : current.zenKey,
      goKey: next.clearGoKey || replaceGoKey ? updated.goKey : current.goKey,
      zenCredentials: next.clearZenKey || replaceZenKey ? updated.zenCredentials : current.zenCredentials,
      goCredentials: next.clearGoKey || replaceGoKey ? updated.goCredentials : current.goCredentials
    }), { expectedRevision });
    await requestLogs.configure({ limit: saved.requestLogLimit, persist: saved.persistLogs }).catch((error) => console.error(`更新日志持久化设置失败：${error.message}`));
    return runtimeConfigResponse(res, 200, saved);
  }
  if (url.pathname === '/api/password' && req.method === 'PUT') {
    const expectedRevision = configPrecondition(req, config);
    const next = await bodyJson(req);
    if (typeof next.currentPassword !== 'string' || next.currentPassword.length > 256 || !await verifyPassword(next.currentPassword, config.password)) return json(res, 401, { error: '当前密码错误' });
    if (!validAlphaNumericSecret(next.newPassword)) return json(res, 400, { error: '新密码必须是 6–256 位英文字母或数字' });
    const password = await hashPassword(next.newPassword);
    await updateConfig((current) => ({ ...current, password, sessionSecret: randomBytes(32).toString('hex') }), { expectedRevision });
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  }
  if (url.pathname === '/api/token/regenerate' && req.method === 'POST') {
    const expectedRevision = configPrecondition(req, config);
    const updated = await updateConfig((current) => ({ ...current, clientToken: randomClientToken() }), { expectedRevision });
    return configMutationResponse(res, 200, { token: updated.clientToken }, updated);
  }
  if (url.pathname === '/api/clients' && req.method === 'GET') {
    return json(res, 200, (Array.isArray(config.apiClients) ? config.apiClients : []).map(publicClient));
  }
  if (url.pathname === '/api/clients' && req.method === 'POST') {
    const expectedRevision = configPrecondition(req, config);
    const body = await bodyJson(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return json(res, 400, { error: '客户端名称长度必须为 1–64 个字符' });
    const maxConcurrentRequests = boundedInteger(body.maxConcurrentRequests, '客户端并发上限', 1, 1000, config.maxConcurrentRequests);
    const token = `ocb${randomBytes(32).toString('hex')}`;
    const client = {
      id: randomBytes(8).toString('hex'), name, tokenHash: hashClientToken(token), tokenPrefix: token.slice(0, 10),
      enabled: true, maxConcurrentRequests, createdAt: new Date().toISOString()
    };
    const saved = await updateConfig((current) => {
      const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
      if (clients.length >= 100) throw Object.assign(new Error('命名客户端不能超过 100 个'), { status: 400 });
      if (clients.some((item) => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) throw Object.assign(new Error('客户端名称已存在'), { status: 409 });
      return { ...current, apiClients: [...clients, client] };
    }, { expectedRevision });
    return configMutationResponse(res, 201, { ...publicClient(client), token }, saved);
  }
  const regenerateClientMatch = url.pathname.match(/^\/api\/clients\/([a-f0-9]{16})\/regenerate$/);
  if (regenerateClientMatch && req.method === 'POST') {
    const expectedRevision = configPrecondition(req, config);
    const token = `ocb${randomBytes(32).toString('hex')}`;
    let replacement;
    const saved = await updateConfig((current) => {
      const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
      const index = clients.findIndex((client) => client.id === regenerateClientMatch[1]);
      if (index === -1) throw Object.assign(new Error('客户端不存在'), { status: 404 });
      replacement = { ...clients[index], tokenHash: hashClientToken(token), tokenPrefix: token.slice(0, 10) };
      return { ...current, apiClients: clients.map((client, clientIndex) => clientIndex === index ? replacement : client) };
    }, { expectedRevision });
    return configMutationResponse(res, 200, { ...publicClient(replacement), token }, saved);
  }
  const clientMatch = url.pathname.match(/^\/api\/clients\/([a-f0-9]{16})$/);
  if (clientMatch && ['PUT', 'DELETE'].includes(req.method)) {
    const expectedRevision = configPrecondition(req, config);
    if (req.method === 'DELETE') {
      const saved = await updateConfig((current) => {
        const clients = Array.isArray(current.apiClients) ? current.apiClients : [];
        if (!clients.some((client) => client.id === clientMatch[1])) throw Object.assign(new Error('客户端不存在'), { status: 404 });
        return { ...current, apiClients: clients.filter((client) => client.id !== clientMatch[1]) };
      }, { expectedRevision });
      return configMutationResponse(res, 200, { ok: true }, saved);
    }
    const body = await bodyJson(req);
    let replacement;
    const saved = await updateConfig((current) => {
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
    }, { expectedRevision });
    return configMutationResponse(res, 200, publicClient(replacement), saved);
  }
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    await requestLogs.ensureLoaded({ limit: config.requestLogLimit, persist: config.persistLogs });
    if (config.persistLogs) await requestLogs.flush().catch(() => {});
    return json(res, 200, requestLogs.list(config.requestLogLimit));
  }
  if (url.pathname === '/api/logs' && req.method === 'DELETE') {
    await requestLogs.clear({ limit: config.requestLogLimit, persist: config.persistLogs });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    await requestLogs.ensureLoaded({ limit: config.requestLogLimit, persist: config.persistLogs });
    const stats = aggregateRequestStats(requestLogs.list(config.requestLogLimit), url.searchParams.get('window') || 'all');
    return json(res, 200, { ...stats, credentialHealth: credentialHealthSnapshot(config) });
  }
  if (url.pathname === '/api/status' && req.method === 'GET') {
    await requestLogs.ensureLoaded({ limit: config.requestLogLimit, persist: config.persistLogs });
    const logs = requestLogs.list(config.requestLogLimit);
    const summary = aggregateRequestStats(logs).summary;
    const memory = process.memoryUsage();
    return json(res, 200, {
      uptime: Math.floor(process.uptime()), requests: summary.requests, success: summary.success,
      ready: serviceReady(config),
      activeRequests: activePublicRequests,
      activeHttpConnections,
      maxHttpConnections: MAX_HTTP_CONNECTIONS,
      streamWriteTimeoutMs: STREAM_WRITE_TIMEOUT_MS,
      activeAdminMutations,
      maxAdminMutations: MAX_ADMIN_MUTATIONS,
      activeAdminModelDiscoveries,
      maxAdminModelDiscoveries: MAX_ADMIN_MODEL_DISCOVERIES,
      successRate: summary.successRate,
      averageDuration: summary.averageDurationMs,
      averageUpstreamWait: summary.averageUpstreamWaitMs,
      averageUpstreamBody: summary.averageUpstreamBodyMs,
      upstreamTimingCoverageRate: summary.upstreamWaitCoverageRate,
      upstreamBodyTimingCoverageRate: summary.upstreamBodyCoverageRate,
      memoryMb: Math.round(memory.rss / 1024 / 1024),
      logPersistenceError: requestLogs.lastError || null
    });
  }
  if (url.pathname === '/api/models' && req.method === 'GET') {
    if (activeAdminModelDiscoveries >= MAX_ADMIN_MODEL_DISCOVERIES) {
      return json(res, 429, { error: `管理端模型发现并发已达到上限 ${MAX_ADMIN_MODEL_DISCOVERIES}` }, { 'retry-after': '1' });
    }
    activeAdminModelDiscoveries++;
    try {
      const requestedProvider = url.searchParams.get('provider');
      if (requestedProvider && !['zen', 'go'].includes(requestedProvider)) return json(res, 400, { error: 'provider 仅支持 zen 或 go' });
      const provider = requestedProvider === 'go' ? 'go' : 'zen';
      const signal = clientAbortSignal(req, res);
      try {
        const result = await listModelsWithCredentialFailover(config, provider, signal);
        if (!result.response) {
          applyCredentialRetryHeader(res, result.selection);
          return json(res, result.selection.reason === 'cooldown' ? 503 : 400, { error: credentialUnavailableMessage(provider, result.selection) });
        }
        if (result.attempts > 1) res.setHeader('x-opencode-key-attempts', String(result.attempts));
        const response = result.response;
        applyUpstreamResponseHeaders(res, response);
        const text = result.body;
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8' });
        return res.end(text);
      } catch (error) {
        if (signal.aborted) return;
        if (error.credentialAttempts > 1) res.setHeader('x-opencode-key-attempts', String(error.credentialAttempts));
        const failure = upstreamOperationFailure(error);
        return json(res, failure.status, { error: failure.message, code: failure.code });
      }
    } finally { activeAdminModelDiscoveries--; }
  }
  if (url.pathname === '/api/models/test' && req.method === 'POST') {
    const body = await bodyJson(req);
    const provider = body.provider === 'go' ? 'go' : body.provider === 'zen' ? 'zen' : null;
    if (!provider) return json(res, 400, { error: 'provider 仅支持 zen 或 go' });
    const requestedCredentialId = typeof body.credentialId === 'string' ? body.credentialId : '';
    let selection = { credential: null, reason: null, retryAfterMs: 0 };
    if (requestedCredentialId) {
      const candidates = requestedCredentialId.startsWith('config:') ? configuredProviderCredentials(config, provider) : providerCredentials(config, provider);
      selection.credential = candidates.find((credential) => credential.credentialId === requestedCredentialId) || null;
      if (!selection.credential) return json(res, 404, { error: '指定的 Key 槽位不存在' });
    } else if (!body.apiKey) selection = selectProviderCredential(config, provider);
    const selected = selection.credential;
    const apiKey = panelCredentialKey(body.apiKey) || selected?.apiKey || '';
    let proxyUrl;
    try { proxyUrl = normalizeProxyUrl(body.proxyUrl ?? selected?.proxyUrl ?? providerProxyUrl(config, provider)); }
    catch (error) { return json(res, 400, { error: `代理地址无效：${error.message}` }); }
    if (!apiKey) {
      applyCredentialRetryHeader(res, selection);
      return json(res, selection.reason === 'cooldown' ? 503 : 400, { error: selection.reason === 'cooldown' ? credentialUnavailableMessage(provider, selection) : `${provider.toUpperCase()} 密钥未填写` });
    }
    const signal = clientAbortSignal(req, res);
    let responseReceived = false;
    let responseRecorded = false;
    try {
      const response = await listModels({ provider, apiKey, proxyUrl, signal, timeoutMs: config.upstreamTimeoutMs });
      responseReceived = true;
      if (selected && !body.apiKey && ([401, 403, 429].includes(response.status) || response.status >= 500)) {
        recordCredentialResponse(provider, selected, response);
        responseRecorded = true;
      }
      applyUpstreamResponseHeaders(res, response);
      const text = await readModelResponse(response, '模型列表');
      if (selected && !body.apiKey && !responseRecorded) recordCredentialResponse(provider, selected, response);
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8' });
      return res.end(text);
    } catch (error) {
      if (signal.aborted) {
        if (selected && !body.apiKey && !responseRecorded) credentialHealth.releaseProbe(provider, selected);
        return;
      }
      if (responseReceived) {
        const networkFailure = isUpstreamConnectionError(error) ? upstreamConnectionFailure(error) : null;
        if (selected && !body.apiKey && !responseRecorded) {
          if (networkFailure) credentialHealth.recordNetworkFailure(provider, selected, networkFailure.status);
          else credentialHealth.releaseProbe(provider, selected);
        }
        const failure = networkFailure || upstreamOperationFailure(error);
        return json(res, failure.status, { error: failure.message, code: failure.code });
      }
      const failure = upstreamConnectionFailure(error);
      if (selected && !body.apiKey) credentialHealth.recordNetworkFailure(provider, selected, failure.status);
      return json(res, failure.status, { error: failure.message, code: failure.code });
    }
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

function imageHandoffEnabledForRoute(config, route) {
  const model = route.upstreamModel.toLowerCase();
  return config.imageHandoffModels
    .some((entry) => entry.provider === route.provider && entry.model.toLowerCase() === model);
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

function responsesOutputOptions(body, protocol) {
  if (protocol !== 'responses') return {};
  return {
    parallelToolCalls: typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : true,
    toolChoice: body.tool_choice ?? 'auto',
    tools: Array.isArray(body.tools) ? body.tools : []
  };
}

async function proxyRequest(req, res, url, config, client, forcedProvider, requestId) {
  const incomingProtocol = detectProtocol(url.pathname);
  if (!incomingProtocol) return protocolError(res, 404, 'chat', '仅支持 messages、responses 和 chat/completions 端点');
  if (!client) return protocolError(res, 401, incomingProtocol, '访问令牌无效', 'authentication_error');
  const started = Date.now();
  let body = await bodyJson(req, MAX_PROXY_REQUEST_BYTES);
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256) return protocolError(res, 400, incomingProtocol, 'model 必须是长度 1–256 的非空字符串');
  let promptRewrite;
  if (incomingProtocol === 'claude') {
    promptRewrite = rewriteClaudeSystem(body.system, config.promptRewriteRules || []);
    body.system = promptRewrite.system;
  }
  const route = resolveRoute(body.model, config, forcedProvider);
  const responseOptions = responsesOutputOptions(body, incomingProtocol);
  if (!route.upstreamModel) return protocolError(res, 400, incomingProtocol, '上游模型名不能为空');
  const imageHandoffEnabled = imageHandoffEnabledForRoute(config, route);
  let upstreamBody;
  try {
    if (incomingProtocol === 'claude' && route.protocol === 'chat' && imageHandoffEnabled) {
      body = await imageHandoff.prepareClaudeRequest(body, true);
    }
    upstreamBody = prepareUpstreamRequest(body, incomingProtocol, route.protocol, route.upstreamModel, { toolChoiceFallback: route.toolChoiceFallback, imageHandoffEnabled });
  } catch (error) {
    return protocolError(res, error.status || 400, incomingProtocol, error.message, error.type || 'invalid_request_error');
  }
  const selection = selectProviderCredential(config, route.provider);
  let credential = selection.credential;
  if (!credential) {
    applyCredentialRetryHeader(res, selection);
    return protocolError(res, 503, incomingProtocol, credentialUnavailableMessage(route.provider, selection), selection.reason === 'cooldown' ? 'overloaded_error' : 'configuration_error');
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
  let upstreamMetadata = {};
  let credentialAttempts = 0;
  let upstreamWaitMs = 0;
  let upstreamBodyStartedAt = 0;
  const writeLog = (entry) => addLog({
    requestId, clientId: client?.id, clientName: client?.name,
    model: body.model, upstreamModel: route.upstreamModel, provider: route.provider, credentialId: credential.credentialId, credentialLabel: credential.credentialLabel, protocol: protocolLabel,
    credentialAttempts, duration: Date.now() - started, ...upstreamMetadata, ...entry,
    ...(credentialAttempts ? { upstreamWaitMs } : {}),
    ...(upstreamBodyStartedAt ? { upstreamBodyMs: Math.max(0, Date.now() - upstreamBodyStartedAt) } : {})
  }, config);
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  let upstream;
  const maximumCredentialAttempts = providerCredentials(config, route.provider).length;
  while (credential && credentialAttempts < maximumCredentialAttempts) {
    credentialAttempts++;
    const upstreamAttemptStartedAt = Date.now();
    try {
      upstream = await callUpstream({ provider: route.provider, protocol: route.protocol, ...credential, body: upstreamBody, signal: abort.signal, timeoutMs: config.upstreamTimeoutMs, forwardHeaders: compatibilityHeaders(req, incomingProtocol, route.protocol) });
    } catch (error) {
      upstreamWaitMs += Math.max(0, Date.now() - upstreamAttemptStartedAt);
      if (abort.signal.aborted) {
        credentialHealth.releaseProbe(route.provider, credential);
        await writeLog({ status: 499, error: '客户端在收到上游响应前断开' });
        return;
      }
      const failure = upstreamConnectionFailure(error);
      credentialHealth.recordNetworkFailure(route.provider, credential, failure.status);
      await writeLog({ status: failure.status, error: failure.message, errorCode: failure.code });
      if (credentialAttempts > 1) res.setHeader('x-opencode-key-attempts', String(credentialAttempts));
      return protocolError(res, failure.status, incomingProtocol, failure.message, 'upstream_error', {}, failure.code);
    }
    upstreamWaitMs += Math.max(0, Date.now() - upstreamAttemptStartedAt);
    if (!upstream.ok) recordCredentialResponse(route.provider, credential, upstream);
    if (![401, 403, 429].includes(upstream.status) || credentialAttempts >= maximumCredentialAttempts) break;
    const replacement = selectProviderCredential(config, route.provider).credential;
    if (!replacement) break;
    await upstream.body?.cancel().catch(() => {});
    credential = replacement;
  }
  if (credentialAttempts > 1) res.setHeader('x-opencode-key-attempts', String(credentialAttempts));
  upstreamBodyStartedAt = Date.now();
  upstreamMetadata = applyUpstreamResponseHeaders(res, upstream);
  if (!upstream.ok) {
    let text;
    try { text = await readResponseText(upstream, MAX_UPSTREAM_ERROR_BYTES, '上游错误响应'); }
    catch (error) {
      await writeLog({ status: 502, stream: Boolean(body.stream), error: error.message });
      return protocolError(res, 502, incomingProtocol, error.message, 'upstream_error');
    }
    await writeLog({ status: upstream.status, stream: Boolean(body.stream) });
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
  const upstreamContentType = upstream.headers.get('content-type') || '';
  if (body.stream && !/^text\/event-stream(?:\s*;|$)/i.test(upstreamContentType)) {
    await upstream.body?.cancel().catch(() => {});
    const received = upstreamContentType ? `收到 ${upstreamContentType.slice(0, 128)}` : '缺少 Content-Type';
    const message = `上游流式响应格式无效：${received}`;
    credentialHealth.recordNetworkFailure(route.provider, credential, 502);
    await writeLog({ status: 502, stream: true, error: message });
    return protocolError(res, 502, incomingProtocol, message, 'upstream_error');
  }
  if (body.stream && incomingProtocol === route.protocol) {
    const observer = createSseObserver(route.protocol, body.model);
    res.writeHead(upstream.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive' });
    try {
      for await (const chunk of upstream.body || []) {
        observer.write(chunk);
        await writeResponseChunk(res, chunk, STREAM_WRITE_TIMEOUT_MS);
      }
    } catch (error) {
      const failure = streamFailure(error, res, abort);
      const observed = failure.status === 499 ? undefined : observer.end();
      if (failure.penalizeCredential) credentialHealth.recordNetworkFailure(route.provider, credential, failure.status);
      else credentialHealth.releaseProbe(route.provider, credential);
      await writeLog({ status: failure.status, stream: true, error: failure.message, errorCode: failure.code });
      if (!res.writableEnded && !res.destroyed) {
        if (failure.status !== 499) res.write(streamProtocolError(incomingProtocol, failure.message, observed?.nextSequenceNumber, failure.code));
        res.end();
      }
      return;
    }
    const observed = observer.end();
    if (isIncompleteSseError(observed.error)) {
      credentialHealth.recordNetworkFailure(route.provider, credential, 502);
      if (!res.writableEnded && !res.destroyed) res.write(streamProtocolError(incomingProtocol, observed.error.message, observed.nextSequenceNumber));
    }
    else if (observed.error) credentialHealth.releaseProbe(route.provider, credential);
    else recordCredentialResponse(route.provider, credential, upstream);
    await writeLog({ status: observed.error ? 502 : upstream.status, stream: true, inputTokensIncludeCache: route.protocol !== 'claude', ...(observed.error ? { error: observed.error.message || String(observed.error) } : {}), ...observed.usage });
    return res.end();
  }
  if (body.stream) {
    let streamUsage = {};
    let streamError;
    let responseSequenceNumber = 0;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive' });
    try {
      for await (const event of translateSse(upstream, route.protocol, incomingProtocol, body.model, {
        onUsage: (usage) => { streamUsage = usage; },
        onError: (error) => { streamError = error; },
        onResponsesSequenceNumber: (nextSequenceNumber) => { responseSequenceNumber = nextSequenceNumber; },
        responsesOptions: responseOptions
      })) {
        await writeResponseChunk(res, event, STREAM_WRITE_TIMEOUT_MS);
      }
    } catch (error) {
      const failure = streamFailure(error, res, abort);
      if (failure.penalizeCredential) credentialHealth.recordNetworkFailure(route.provider, credential, failure.status);
      else credentialHealth.releaseProbe(route.provider, credential);
      await writeLog({ status: failure.status, stream: true, inputTokensIncludeCache: route.protocol !== 'claude', error: failure.message, errorCode: failure.code, ...streamUsage });
      if (!res.writableEnded && !res.destroyed) {
        if (failure.status !== 499) res.write(streamProtocolError(incomingProtocol, failure.message, responseSequenceNumber, failure.code));
        res.end();
      }
      return;
    }
    if (isIncompleteSseError(streamError)) credentialHealth.recordNetworkFailure(route.provider, credential, 502);
    else if (streamError) credentialHealth.releaseProbe(route.provider, credential);
    else recordCredentialResponse(route.provider, credential, upstream);
    await writeLog({ status: streamError ? 502 : upstream.status, stream: true, inputTokensIncludeCache: route.protocol !== 'claude', ...(streamError ? { error: streamError.message || String(streamError) } : {}), ...streamUsage });
    return res.end();
  }
  let upstreamJson;
  try { upstreamJson = await readResponseJson(upstream); }
  catch (error) {
    if (abort.signal.aborted) {
      credentialHealth.releaseProbe(route.provider, credential);
      await writeLog({ status: 499, stream: false, error: '客户端在读取上游响应时断开' });
      return;
    }
    const networkFailure = isUpstreamConnectionError(error) ? upstreamConnectionFailure(error) : null;
    const failure = networkFailure || upstreamOperationFailure(error);
    if (networkFailure) credentialHealth.recordNetworkFailure(route.provider, credential, failure.status);
    else credentialHealth.releaseProbe(route.provider, credential);
    await writeLog({ status: failure.status, stream: false, error: failure.message, errorCode: failure.code });
    return protocolError(res, failure.status, incomingProtocol, failure.message, 'upstream_error', {}, failure.code);
  }
  let normalizedResponse;
  let clientResponse;
  try {
    normalizedResponse = normalizeResponse(upstreamJson, route.protocol, body.model, { rejectUnknown: incomingProtocol !== route.protocol });
    clientResponse = incomingProtocol === route.protocol ? upstreamJson : formatResponse(normalizedResponse, incomingProtocol, responseOptions);
  } catch (error) {
    credentialHealth.releaseProbe(route.provider, credential);
    await writeLog({ status: 502, stream: false, error: error.message });
    return protocolError(res, 502, incomingProtocol, `上游响应结构无效：${error.message}`, 'upstream_error');
  }
  recordCredentialResponse(route.provider, credential, upstream);
  const hasUsage = hasUsageData(upstreamJson);
  await writeLog({
    status: upstream.status, stream: false,
    ...(hasUsage ? {
      inputTokens: normalizedResponse.inputTokens, outputTokens: normalizedResponse.outputTokens,
      inputTokensIncludeCache: route.protocol !== 'claude',
      cachedInputTokens: normalizedResponse.cachedInputTokens, cacheCreationInputTokens: normalizedResponse.cacheCreationInputTokens,
      reasoningTokens: normalizedResponse.reasoningTokens
    } : {})
  });
  return json(res, upstream.status, clientResponse);
}

function acquirePublicRequest(client, config) {
  if (activePublicRequests >= config.maxConcurrentRequests) {
    return { allowed: false, scope: 'global', limit: config.maxConcurrentRequests };
  }
  const clientActive = activeClientRequests.get(client.id) || 0;
  const clientLimit = Math.min(1000, Math.max(1, Number(client.maxConcurrentRequests) || config.maxConcurrentRequests));
  if (clientActive >= clientLimit) return { allowed: false, scope: 'client', limit: clientLimit };
  activePublicRequests++;
  activeClientRequests.set(client.id, clientActive + 1);
  let released = false;
  return {
    allowed: true,
    release() {
      if (released) return;
      released = true;
      activePublicRequests--;
      const remaining = (activeClientRequests.get(client.id) || 1) - 1;
      if (remaining > 0) activeClientRequests.set(client.id, remaining);
      else activeClientRequests.delete(client.id);
    }
  };
}

async function limitedPublicRequest(req, res, config, protocol, operation) {
  const client = authenticateClient(req, config);
  if (!client) return protocolError(res, 401, protocol, '访问令牌无效', 'authentication_error');
  const admission = acquirePublicRequest(client, config);
  if (!admission.allowed) {
    res.setHeader('retry-after', '1');
    const message = admission.scope === 'global'
      ? `并发请求已达到上限 ${admission.limit}`
      : `客户端 ${client.name} 的并发请求已达到上限 ${admission.limit}`;
    return protocolError(res, 429, protocol, message, 'rate_limit_error');
  }
  try { return await operation(client); }
  finally { admission.release(); }
}

async function limitedProxyRequest(req, res, url, config, forcedProvider, requestId) {
  const protocol = detectProtocol(url.pathname) || 'chat';
  return limitedPublicRequest(req, res, config, protocol, (client) => proxyRequest(req, res, url, config, client, forcedProvider, requestId));
}

async function staticFile(req, res, url) {
  let entry;
  try {
    entry = await resolveStaticFile(PUBLIC_ROOT, url.pathname);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message });
    throw error;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  const headers = {
    'content-type': types[extname(entry.filePath)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag: entry.etag,
    'last-modified': entry.lastModified,
    'x-content-type-options': 'nosniff'
  };
  if (ifNoneMatchMatches(req.headers['if-none-match'], entry.etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': entry.size });
  if (req.method === 'HEAD') return res.end();
  try {
    await pipeline(createReadStream(entry.filePath), res);
  } catch (error) {
    if (!req.destroyed && !res.destroyed && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  }
  return;
}

await bootstrapConfigFromEnvironment();

const server = createServer({
  maxHeaderSize: MAX_HTTP_HEADER_BYTES,
  connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
  insecureHTTPParser: false,
  joinDuplicateHeaders: false,
  requireHostHeader: true,
  rejectNonStandardBodyWrites: true
}, async (req, res) => {
  activeHttpRequests++;
  const requestId = randomBytes(16).toString('hex');
  res.setHeader('x-request-id', requestId);
  let requestReleased = false;
  const releaseRequest = () => {
    if (requestReleased) return;
    requestReleased = true;
    activeHttpRequests--;
  };
  res.once('finish', releaseRequest);
  res.once('close', releaseRequest);
  let url;
  try {
    url = parseRequestTarget(req.url);
    const apiScope = publicApiScope(url.pathname);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-xss-protection', '0');
    res.setHeader('x-permitted-cross-domain-policies', 'none');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (requestProtocol(req) === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.rawHeaders.length / 2 > MAX_HTTP_HEADERS) return json(res, 431, { error: `请求头字段不能超过 ${MAX_HTTP_HEADERS} 个` });
    const duplicateHeader = duplicatedSingletonHeader(req);
    if (duplicateHeader) {
      const message = `请求头 ${duplicateHeader} 不能重复`;
      if (apiScope) return protocolError(res, 400, detectProtocol(url.pathname) || 'chat', message);
      return json(res, 400, { error: message });
    }
    const publicImageMatch = url.pathname.match(/^\/_bridge\/images\/([a-f0-9]{64})$/);
    if (url.pathname === '/health' || url.pathname.startsWith('/api/') || publicImageMatch || apiScope) res.setHeader('cache-control', 'no-store');
    if (publicImageMatch) {
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '该接口仅支持 GET 或 HEAD' }, { allow: 'GET, HEAD' });
      const image = imageHandoff.acquirePublicImage(publicImageMatch[1]);
      if (!image) return json(res, 404, { error: '图片附件不存在或已经过期' });
      try {
        let size;
        try { size = (await stat(image.filePath)).size; }
        catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: '图片附件不存在或已经过期' }); throw error; }
        res.writeHead(200, {
          'content-type': image.mediaType,
          'content-length': size,
          'content-disposition': `inline; filename="image.${image.extension}"`,
          'cache-control': 'no-store'
        });
        if (req.method === 'HEAD') return res.end();
        try { await pipeline(createReadStream(image.filePath), res); }
        catch (error) {
          if (!req.destroyed && !res.destroyed && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
        }
        return;
      } finally {
        image.release();
      }
    }
    const config = await loadConfig();
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, ready: serviceReady(config), configured: Boolean(config.password), uptime: Math.floor(process.uptime()) });
    }
    if (url.pathname.startsWith('/api/')) return await adminApi(req, res, url, config);
    if (apiScope) {
      const modelsPath = `${apiScope.base}/models`;
      const modelPrefix = `${modelsPath}/`;
      const modelEndpoint = url.pathname === modelsPath || url.pathname.startsWith(modelPrefix);
      const modelSignal = modelEndpoint ? clientAbortSignal(req, res) : undefined;
      if (modelEndpoint && req.method !== 'GET') {
        return protocolError(res, 405, 'chat', '该接口仅支持 GET', 'invalid_request_error', { allow: 'GET' });
      }
      if (url.pathname.startsWith(modelPrefix) && req.method === 'GET') {
        return await limitedPublicRequest(req, res, config, 'chat', async () => {
          let requestedModel;
          try { requestedModel = decodeURIComponent(url.pathname.slice(modelPrefix.length)); }
          catch { return json(res, 400, { error: { message: '模型 ID 编码无效', type: 'invalid_request_error' } }); }
          if (!requestedModel) return json(res, 400, { error: { message: '模型 ID 不能为空', type: 'invalid_request_error' } });
          if (requestedModel.length > 256) return json(res, 400, { error: { message: '模型 ID 不能超过 256 个字符', type: 'invalid_request_error' } });
          const goModel = requestedModel.startsWith('opencode-go/');
          const requestedProvider = url.searchParams.get('provider');
          if (!apiScope.provider && requestedProvider && !['zen', 'go'].includes(requestedProvider)) {
            return protocolError(res, 400, 'chat', 'provider 仅支持 zen 或 go');
          }
          const provider = apiScope.provider || (goModel ? 'go' : (['zen', 'go'].includes(requestedProvider) ? requestedProvider : config.defaultProvider));
          const upstreamModel = goModel ? requestedModel.slice('opencode-go/'.length) : requestedModel.startsWith('opencode/') ? requestedModel.slice('opencode/'.length) : requestedModel;
          try {
            const result = await listModelsWithCredentialFailover(config, provider, modelSignal, { jsonBody: true });
            if (!result.response) {
              applyCredentialRetryHeader(res, result.selection);
              return json(res, 503, { error: { message: credentialUnavailableMessage(provider, result.selection), type: result.selection.reason === 'cooldown' ? 'overloaded_error' : 'configuration_error' } });
            }
            if (result.attempts > 1) res.setHeader('x-opencode-key-attempts', String(result.attempts));
            const upstream = result.response;
            applyUpstreamResponseHeaders(res, upstream);
            const body = result.body;
            if (!upstream.ok) return json(res, upstream.status, body);
            const model = (Array.isArray(body.data) ? body.data : []).find((item) => item.id === upstreamModel);
            if (!model) return json(res, 404, { error: { message: `模型 ${requestedModel} 不存在`, type: 'not_found_error' } });
            return json(res, 200, { ...model, id: requestedModel, provider });
          } catch (error) {
            if (modelSignal.aborted) return;
            if (error.credentialAttempts > 1) res.setHeader('x-opencode-key-attempts', String(error.credentialAttempts));
            const failure = upstreamOperationFailure(error);
            return json(res, failure.status, { error: { message: failure.message, type: 'upstream_error', code: failure.code } });
          }
        });
      }
      if (url.pathname === modelsPath && req.method === 'GET') {
        return await limitedPublicRequest(req, res, config, 'chat', async () => {
          const requestedProvider = url.searchParams.get('provider');
          if (!apiScope.provider && requestedProvider && !['zen', 'go', 'all'].includes(requestedProvider)) {
            return protocolError(res, 400, 'chat', 'provider 仅支持 zen、go 或 all');
          }
          const provider = apiScope.provider || (['zen', 'go', 'all'].includes(requestedProvider) ? requestedProvider : config.defaultProvider);
          if (provider === 'all') {
            const configuredProviders = ['zen', 'go'].filter((item) => providerCredentials(config, item).length);
            if (!configuredProviders.length) return json(res, 503, { error: { message: '尚未配置 OpenCode Zen 或 Go 密钥', type: 'configuration_error' } });
            const settled = await Promise.allSettled(configuredProviders.map(async (item) => {
              const result = await listModelsWithCredentialFailover(config, item, modelSignal, { jsonBody: true, label: `${item} 模型列表` });
              if (!result.response) {
                throw Object.assign(new Error(credentialUnavailableMessage(item, result.selection)), {
                  provider: item, credentialAttempts: result.attempts, selection: result.selection
                });
              }
              const body = result.body;
              if (!result.response.ok) throw Object.assign(new Error(body.error?.message || `${item} 返回 HTTP ${result.response.status}`), { provider: item, credentialAttempts: result.attempts });
              return {
                attempts: result.attempts,
                models: (Array.isArray(body.data) ? body.data : []).map((model) => ({
                  ...model,
                  id: item === 'go' ? `opencode-go/${model.id}` : model.id,
                  provider: item
                }))
              };
            }));
            if (modelSignal.aborted) return;
            const models = settled.flatMap((result) => result.status === 'fulfilled' ? result.value.models : []);
            const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason.message] : []);
            const attemptCounts = settled.map((result) => result.status === 'fulfilled' ? result.value.attempts : result.reason.credentialAttempts || 0);
            if (attemptCounts.some((attempts) => attempts > 1)) res.setHeader('x-opencode-key-attempts', String(attemptCounts.reduce((total, attempts) => total + attempts, 0)));
            if (!models.length && errors.length) {
              const cooling = settled.flatMap((result) => result.status === 'rejected' && result.reason.selection?.reason === 'cooldown' ? [result.reason.selection] : []);
              if (cooling.length === settled.length) {
                applyCredentialRetryHeader(res, { reason: 'cooldown', retryAfterMs: Math.min(...cooling.map((selection) => selection.retryAfterMs)) });
                return json(res, 503, { error: { message: '已配置的 OpenCode Key 均在冷却，请稍后重试', type: 'overloaded_error' } });
              }
              return json(res, 502, { error: { message: errors.join('；'), type: 'upstream_error' } });
            }
            return json(res, 200, { object: 'list', data: models, ...(errors.length ? { warnings: errors } : {}) });
          }
          try {
            const result = await listModelsWithCredentialFailover(config, provider, modelSignal);
            if (!result.response) {
              applyCredentialRetryHeader(res, result.selection);
              return json(res, 503, { error: { message: credentialUnavailableMessage(provider, result.selection), type: result.selection.reason === 'cooldown' ? 'overloaded_error' : 'configuration_error' } });
            }
            if (result.attempts > 1) res.setHeader('x-opencode-key-attempts', String(result.attempts));
            const upstream = result.response;
            applyUpstreamResponseHeaders(res, upstream);
            const content = result.body;
            res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8' });
            return res.end(content);
          } catch (error) {
            if (modelSignal.aborted) return;
            if (error.credentialAttempts > 1) res.setHeader('x-opencode-key-attempts', String(error.credentialAttempts));
            const failure = upstreamOperationFailure(error);
            return json(res, failure.status, { error: { message: failure.message, type: 'upstream_error', code: failure.code } });
          }
        });
      }
      if (![`${apiScope.base}/messages`, `${apiScope.base}/responses`, `${apiScope.base}/chat/completions`].includes(url.pathname)) {
        return json(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'POST') {
        return protocolError(res, 405, detectProtocol(url.pathname), '该接口仅支持 POST', 'invalid_request_error', { allow: 'POST' });
      }
      return await limitedProxyRequest(req, res, url, config, apiScope.provider, requestId);
    }
    if (['GET', 'HEAD'].includes(req.method)) return await staticFile(req, res, url);
    return json(res, 405, { error: '方法不允许' }, { allow: 'GET, HEAD' });
  } catch (error) {
    if (!error.status && !['CLIENT_CLOSED', 'CLIENT_WRITE_TIMEOUT'].includes(error.code) && error.name !== 'AbortError') console.error(error);
    if (!res.headersSent && url && publicApiScope(url.pathname)) {
      const status = error.status || 500;
      protocolError(res, status, detectProtocol(url.pathname) || 'chat', error.status ? error.message : '服务器内部错误', error.status ? 'invalid_request_error' : 'internal_error');
    } else if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    else res.end();
  }
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
server.maxConnections = MAX_HTTP_CONNECTIONS;
server.on('connection', (socket) => {
  activeHttpConnections++;
  socket.once('close', () => { activeHttpConnections--; });
});
server.on('error', (error) => {
  console.error(`服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => console.log(`OpenCode Bridge 已启动：http://${HOST}:${PORT}`));

let shutdownStarted = false;
let shutdownFinalized = false;

async function finalizeShutdown(exitCode, forceExit) {
  if (shutdownFinalized) return;
  shutdownFinalized = true;
  clearTimeout(forceExit);
  await requestLogs.flush().catch((error) => console.error(`退出前刷新请求日志失败：${error.message}`));
  const force = exitCode !== 0;
  await Promise.all([closeProxyDispatchers({ force }), closeDirectUpstreamDispatcher({ force }), imageHandoff.close()]);
  process.exit(exitCode);
}

function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`收到 ${signal}，正在等待活动请求结束`);
  const forceExit = setTimeout(() => {
    server.closeAllConnections();
    finalizeShutdown(1, forceExit);
  }, 25_000);
  forceExit.unref();
  server.close(async () => {
    while (activeHttpRequests > 0 && !shutdownFinalized) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    await finalizeShutdown(0, forceExit);
  });
  server.closeIdleConnections?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));
