import { fetch } from 'undici';
import { proxyDispatcher } from './proxy.js';

export const MAX_UPSTREAM_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_UPSTREAM_ERROR_BYTES = 1024 * 1024;
export const MAX_MODEL_LIST_BYTES = 10 * 1024 * 1024;

export function upstreamBase(provider) {
  const fallback = provider === 'go' ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1';
  const value = provider === 'go' ? process.env.OPENCODE_GO_BASE_URL : process.env.OPENCODE_ZEN_BASE_URL;
  return (value?.trim() || fallback).replace(/\/+$/, '');
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
    ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl) } : {})
  });
}

export async function listModels({ provider, apiKey, proxyUrl, timeoutMs = 120000 }) {
  const response = await fetch(`${upstreamBase(provider)}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: combinedSignal(undefined, timeoutMs),
    ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl) } : {})
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
