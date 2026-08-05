import { Agent, fetch } from 'undici';
import { proxyDispatcher } from './proxy.js';

export const MAX_UPSTREAM_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
export const MAX_MODEL_LIST_BYTES = 10 * 1024 * 1024;
export const DIRECT_CONNECT_TIMEOUT_MS = 60_000;

let directAgent = null;

function upstreamErrorChain(error) {
  const chain = [];
  for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) chain.push(current);
  return chain;
}

export function isUpstreamConnectionError(error) {
  const chain = upstreamErrorChain(error);
  const codes = new Set([
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'
  ]);
  return chain.some((item) => item?.name === 'TimeoutError'
    || codes.has(item?.code)
    || /^(?:CERT_|ERR_TLS_CERT_ALTNAME_INVALID$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(String(item?.code || '')));
}

export function upstreamConnectionFailure(error) {
  const chain = upstreamErrorChain(error);
  const hasCode = (...codes) => chain.some((item) => codes.includes(item?.code));
  const tlsFailure = chain.some((item) => /^(?:CERT_|ERR_TLS_CERT_ALTNAME_INVALID$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(String(item?.code || '')));

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

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

function requestDispatcher(proxyUrl) {
  return proxyUrl ? proxyDispatcher(proxyUrl) : directUpstreamDispatcher();
}

export async function callUpstream({ provider, protocol, apiKey, proxyUrl, body, signal, timeoutMs = 120000, forwardHeaders = {} }) {
  const endpoint = protocol === 'claude' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions';
  return fetch(`${upstreamBase(provider)}/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(protocol === 'claude' ? {
        'x-api-key': apiKey,
        'anthropic-version': forwardHeaders['anthropic-version'] || '2023-06-01',
        ...(forwardHeaders['anthropic-beta'] ? { 'anthropic-beta': forwardHeaders['anthropic-beta'] } : {})
      } : forwardHeaders['openai-beta'] ? { 'openai-beta': forwardHeaders['openai-beta'] } : {})
    },
    body: JSON.stringify(body),
    signal: combinedSignal(signal, timeoutMs),
    dispatcher: requestDispatcher(proxyUrl)
  });
}

export async function listModels({ provider, apiKey, proxyUrl, timeoutMs = 120000 }) {
  const response = await fetch(`${upstreamBase(provider)}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: combinedSignal(undefined, timeoutMs),
    dispatcher: requestDispatcher(proxyUrl)
  });
  return response;
}

export async function readResponseText(response, limit, label = '上游响应') {
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
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function readResponseJson(response, limit = MAX_UPSTREAM_JSON_BYTES, label = '上游 JSON 响应') {
  const text = await readResponseText(response, limit, label);
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error(`${label}格式无效`), { code: 'UPSTREAM_INVALID_JSON' }); }
}

function formatMiB(bytes) {
  return Math.round(bytes / 1024 / 1024 * 10) / 10;
}
