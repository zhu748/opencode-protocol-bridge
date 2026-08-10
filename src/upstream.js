import { Agent, fetch } from 'undici';
import { proxyDispatcherForUrl } from './proxy.js';
import { assertJsonComplexity } from './json-complexity.js';

export const MAX_UPSTREAM_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
export const MAX_MODEL_LIST_BYTES = 10 * 1024 * 1024;
export const DIRECT_CONNECT_TIMEOUT_MS = 60_000;

let directAgent = null;
const responseTimeoutCleanups = new WeakMap();

function upstreamErrorChain(error) {
  const chain = [];
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) chain.push(current);
  return chain;
}

export function isUpstreamConnectionError(error) {
  const chain = upstreamErrorChain(error);
  const codes = new Set([
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'PROXY_TUNNEL_ERROR',
    'UPSTREAM_STREAM_IDLE_TIMEOUT'
  ]);
  return chain.some((item) => item?.name === 'TimeoutError'
    || codes.has(item?.code)
    || /^(?:CERT_|ERR_TLS_CERT_ALTNAME_INVALID$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(String(item?.code || '')));
}

export function upstreamConnectionFailure(error) {
  const chain = upstreamErrorChain(error);
  const hasCode = (...codes) => chain.some((item) => codes.includes(item?.code));
  const tlsFailure = chain.some((item) => /^(?:CERT_|ERR_TLS_CERT_ALTNAME_INVALID$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(String(item?.code || '')));

  const proxyTunnelFailure = chain.find((item) => item?.code === 'PROXY_TUNNEL_ERROR');
  if (proxyTunnelFailure) {
    return { status: 502, code: 'proxy_tunnel_error', message: proxyTunnelFailure.message || '托管隧道代理不可用' };
  }
  if (hasCode('UPSTREAM_STREAM_IDLE_TIMEOUT')) {
    return { status: 504, code: 'upstream_stream_idle_timeout', message: '读取上游流超时：长时间未收到任何数据' };
  }
  if (hasCode('UND_ERR_CONNECT_TIMEOUT')) {
    return { status: 504, code: 'upstream_connect_timeout', message: '连接上游失败：建立连接超时，请检查网络或该 Key 的代理' };
  }
  if (hasCode('UND_ERR_HEADERS_TIMEOUT') || chain.some((item) => item?.name === 'TimeoutError')) {
    return { status: 504, code: 'upstream_response_timeout', message: '连接上游失败：等待上游响应超时' };
  }
  if (hasCode('UND_ERR_BODY_TIMEOUT')) {
    return { status: 504, code: 'upstream_body_timeout', message: '连接上游失败：读取上游响应超时' };
  }
  if (hasCode('ENOTFOUND', 'EAI_AGAIN')) {
    return { status: 502, code: 'upstream_dns_error', message: '连接上游失败：域名解析失败' };
  }
  if (hasCode('ECONNREFUSED')) {
    return { status: 502, code: 'upstream_connection_refused', message: '连接上游失败：连接被拒绝' };
  }
  if (hasCode('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET')) {
    return { status: 502, code: 'upstream_connection_reset', message: '连接上游失败：连接被意外断开' };
  }
  if (tlsFailure) {
    return { status: 502, code: 'upstream_tls_error', message: '连接上游失败：TLS 连接或证书校验失败' };
  }
  return { status: 502, code: 'upstream_network_error', message: '连接上游失败：网络请求失败' };
}

export function upstreamBase(provider) {
  const fallback = provider === 'go' ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1';
  const value = provider === 'go' ? process.env.OPENCODE_GO_BASE_URL : process.env.OPENCODE_ZEN_BASE_URL;
  return (value?.trim() || fallback).replace(/\/+$/, '');
}

function timedSignal(signal, timeoutMs) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal,
    clearTimeout: () => clearTimeout(timeout)
  };
}

export function directUpstreamDispatcher() {
  if (!directAgent || directAgent.closed || directAgent.destroyed) {
    directAgent = new Agent({
      connectTimeout: DIRECT_CONNECT_TIMEOUT_MS,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250
    });
  }
  return directAgent;
}

export async function closeDirectUpstreamDispatcher({ force = false } = {}) {
  const active = directAgent;
  directAgent = null;
  if (!active || active.destroyed) return;
  if (force) await active.destroy();
  else if (!active.closed) await active.close();
}

async function requestDispatcher(proxyUrl, signal) {
  signal?.throwIfAborted();
  return proxyUrl ? await proxyDispatcherForUrl(proxyUrl, { signal }) : directUpstreamDispatcher();
}

export async function callUpstream({ provider, protocol, apiKey, proxyUrl, body, signal, timeoutMs = 120000, forwardHeaders = {}, anthropicBetaEndpoint = false, operation = 'create' }) {
  if (!['create', 'compact'].includes(operation)) throw new TypeError(`不支持的上游操作：${operation}`);
  if (operation === 'compact' && protocol !== 'responses') throw new TypeError('compact 操作只支持 Responses 上游');
  if (protocol === 'gemini' && operation !== 'create') throw new TypeError('Gemini 上游只支持 create 操作');
  const geminiModel = protocol === 'gemini' ? body?.model : undefined;
  if (protocol === 'gemini' && (typeof geminiModel !== 'string' || !geminiModel)) throw new TypeError('Gemini 上游请求缺少模型名');
  const stream = body?.stream === true;
  const endpoint = operation === 'compact'
    ? 'responses/compact'
    : protocol === 'claude' ? 'messages'
      : protocol === 'responses' ? 'responses'
        : protocol === 'gemini' ? `models/${encodeURIComponent(geminiModel)}:${stream ? 'streamGenerateContent' : 'generateContent'}`
          : 'chat/completions';
  const endpointQuery = protocol === 'claude' && anthropicBetaEndpoint === true
    ? '?beta=true'
    : protocol === 'gemini' && stream ? '?alt=sse' : '';
  const requestControl = timedSignal(signal, timeoutMs);
  const requestSignal = requestControl.signal;
  const requestBody = protocol === 'gemini' ? { ...body } : body;
  if (protocol === 'gemini') {
    delete requestBody.model;
    delete requestBody.stream;
  }
  try {
    const response = await fetch(`${upstreamBase(provider)}/${endpoint}${endpointQuery}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(protocol === 'claude' ? {
          'x-api-key': apiKey,
          'anthropic-version': forwardHeaders['anthropic-version'] || '2023-06-01',
          ...(forwardHeaders['anthropic-beta'] ? { 'anthropic-beta': forwardHeaders['anthropic-beta'] } : {})
        } : protocol === 'gemini' ? {
          'x-goog-api-key': apiKey
        } : forwardHeaders['openai-beta'] ? { 'openai-beta': forwardHeaders['openai-beta'] } : {})
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal,
      dispatcher: await requestDispatcher(proxyUrl, requestSignal)
    });
    if (stream && response.ok) requestControl.clearTimeout();
    else responseTimeoutCleanups.set(response, requestControl.clearTimeout);
    return response;
  } catch (error) {
    requestControl.clearTimeout();
    throw error;
  }
}

export function releaseUpstreamResponseTimeout(response) {
  const cleanup = responseTimeoutCleanups.get(response);
  if (!cleanup) return false;
  responseTimeoutCleanups.delete(response);
  cleanup();
  return true;
}

export async function discardUpstreamResponse(response, reason) {
  releaseUpstreamResponseTimeout(response);
  await response?.body?.cancel(reason);
}

export async function* withStreamIdleTimeout(body, timeoutMs, onChunk) {
  if (!body) return;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('上游流空闲超时必须是非负整数');
  if (onChunk !== undefined && typeof onChunk !== 'function') throw new TypeError('上游流数据回调必须是函数');
  if (timeoutMs === 0) {
    yield* body;
    return;
  }

  const reader = body.getReader();
  let completed = false;
  let cancellationReason;
  try {
    while (true) {
      let timer;
      const idleTimeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('读取上游流超时：长时间未收到任何数据'), {
            name: 'TimeoutError',
            code: 'UPSTREAM_STREAM_IDLE_TIMEOUT'
          }));
        }, timeoutMs);
        timer.unref?.();
      });
      let result;
      try {
        result = await Promise.race([reader.read(), idleTimeout]);
      } catch (error) {
        cancellationReason = error;
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (result.done) {
        completed = true;
        return;
      }
      onChunk?.(result.value);
      yield result.value;
    }
  } finally {
    if (!completed) await reader.cancel(cancellationReason).catch(() => {});
    reader.releaseLock();
  }
}

export async function listModels({ provider, apiKey, proxyUrl, signal, timeoutMs = 120000 }) {
  const requestControl = timedSignal(signal, timeoutMs);
  try {
    const response = await fetch(`${upstreamBase(provider)}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: requestControl.signal,
      dispatcher: await requestDispatcher(proxyUrl, requestControl.signal)
    });
    responseTimeoutCleanups.set(response, requestControl.clearTimeout);
    return response;
  } catch (error) {
    requestControl.clearTimeout();
    throw error;
  }
}

async function readResponseBuffer(response, limit, label) {
  try {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${label}超过 ${formatMiB(limit)} MiB 上限`), { code: 'UPSTREAM_BODY_TOO_LARGE' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error(`${label}超过 ${formatMiB(limit)} MiB 上限`), { code: 'UPSTREAM_BODY_TOO_LARGE' });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    releaseUpstreamResponseTimeout(response);
  }
}

function decodeResponseUtf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error(`${label}包含无效 UTF-8`), { code: 'UPSTREAM_INVALID_UTF8' }); }
}

export async function readResponseText(response, limit, label = '上游响应') {
  return decodeResponseUtf8(await readResponseBuffer(response, limit, label), label);
}

export async function readResponseJsonPayload(response, limit = MAX_UPSTREAM_JSON_BYTES, label = '上游 JSON 响应') {
  const bytes = await readResponseBuffer(response, limit, label);
  const text = decodeResponseUtf8(bytes, label);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Object.assign(new Error(`${label}格式无效`), { code: 'UPSTREAM_INVALID_JSON' }); }
  assertJsonComplexity(parsed, { label, code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  return { value: parsed, bytes };
}

export async function readResponseJson(response, limit = MAX_UPSTREAM_JSON_BYTES, label = '上游 JSON 响应') {
  return (await readResponseJsonPayload(response, limit, label)).value;
}

function formatMiB(bytes) {
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}
