export const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 1000;

function safeStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function safeToken(value, fallback, secrets) {
  if (typeof value !== 'string') return fallback;
  const token = value.trim();
  const exposesSecret = secrets.some((secret) => typeof secret === 'string' && secret.length >= 4 && token.includes(secret));
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(token) && !exposesSecret ? token : fallback;
}

function truncateMessage(value) {
  if (value.length <= MAX_UPSTREAM_ERROR_MESSAGE_CHARS) return value;
  const truncated = value.slice(0, MAX_UPSTREAM_ERROR_MESSAGE_CHARS);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function safeMessage(value, fallback, secrets) {
  if (typeof value !== 'string') return fallback;
  let message = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const redactions = [...new Set(secrets
    .filter((secret) => typeof secret === 'string' && secret.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const secret of redactions) message = message.replaceAll(secret, '[REDACTED]');
  return message ? truncateMessage(message) : fallback;
}

export function normalizeUpstreamHttpError(text, status, { secrets = [] } = {}) {
  const normalizedStatus = safeStatus(status);
  const displayedStatus = Number.isInteger(status) ? status : '异常状态';
  const fallbackMessage = `OpenCode 上游返回 HTTP ${displayedStatus}`;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { /* 上游错误正文可能不是 JSON。 */ }

  const root = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : null;
  const nested = root?.error && !Array.isArray(root.error) && typeof root.error === 'object'
    ? root.error
    : null;
  const message = safeMessage(
    nested?.message ?? (typeof root?.error === 'string' ? root.error : root?.message),
    fallbackMessage,
    secrets
  );

  return {
    status: normalizedStatus,
    message,
    type: safeToken(nested?.type ?? root?.type, 'upstream_error', secrets),
    code: safeToken(nested?.code ?? root?.code, 'upstream_http_error', secrets)
  };
}

export function normalizeUpstreamStreamError(value, { secrets = [] } = {}) {
  const root = value && !Array.isArray(value) && typeof value === 'object' ? value : null;
  const nested = root?.error && !Array.isArray(root.error) && typeof root.error === 'object'
    ? root.error
    : null;
  const source = nested || root;
  const message = safeMessage(
    typeof value === 'string' ? value : source?.message,
    'OpenCode 上游流式响应失败',
    secrets
  );
  const type = safeToken(source?.type, 'upstream_error', secrets);
  const code = safeToken(source?.code, null, secrets);
  const param = source?.param === null ? null : safeToken(source?.param, null, secrets);
  return {
    message,
    type,
    ...(code ? { code } : {}),
    ...(source?.param !== undefined ? { param } : {})
  };
}
