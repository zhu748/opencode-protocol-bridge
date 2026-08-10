const ENVELOPE_MARKER = 'opencode_bridge_reasoning_v1';
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const PROTOCOLS = new Set(['responses', 'claude', 'chat', 'gemini']);
const RESPONSES_ITEM_STATUSES = new Set(['in_progress', 'completed', 'incomplete']);
const RESPONSES_ITEM_PHASES = new Set(['commentary', 'final_answer']);
export const GEMINI_BRIDGE_STATE_TEXT = '\u2060';

export function encodeReasoningState(protocol, kind, value) {
  if (!PROTOCOLS.has(protocol)) throw new Error(`不支持的推理状态协议：${protocol}`);
  if (!isValidReasoningState(protocol, kind, value)) throw new Error(`推理状态封装包含无效的 ${protocol}/${kind || 'unknown'} 状态`);
  return encodeEnvelope(protocol, kind, value);
}

export function encodeReasoningStateBundle(states) {
  if (!Array.isArray(states) || states.length < 2 || states.some((state) => !state || !PROTOCOLS.has(state.protocol)
    || !isValidReasoningState(state.protocol, state.kind, state.value))) {
    throw new Error('推理状态组合必须包含至少两个有效的供应商状态');
  }
  return encodeEnvelope('bridge', 'bundle', { states });
}

function encodeEnvelope(protocol, kind, value) {
  const json = JSON.stringify({ marker: ENVELOPE_MARKER, protocol, kind, value });
  if (Buffer.byteLength(json, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('推理状态封装超过 8 MiB 上限');
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeReasoningState(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_ENVELOPE_BYTES * 4 / 3) + 16) return null;
  let parsed;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || parsed.marker !== ENVELOPE_MARKER) return null;
  if (parsed.protocol === 'bridge') {
    const states = parsed.kind === 'bundle' && isRecord(parsed.value) ? parsed.value.states : undefined;
    if (!Array.isArray(states) || states.length < 2 || states.some((state) => !isRecord(state) || !PROTOCOLS.has(state.protocol)
      || !isValidReasoningState(state.protocol, state.kind, state.value))) return null;
    return { protocol: 'bridge', kind: 'bundle', value: { states } };
  }
  if (!PROTOCOLS.has(parsed.protocol) || !isValidReasoningState(parsed.protocol, parsed.kind, parsed.value)) return null;
  return { protocol: parsed.protocol, kind: parsed.kind, value: parsed.value };
}

export function isBridgeReasoningState(value) {
  return decodeReasoningState(value) !== null;
}

export function isValidReasoningState(protocol, kind, value) {
  if (!isRecord(value)) return false;
  if (protocol === 'claude') {
    if (kind === 'thinking') {
      return hasOnlyKeys(value, ['type', 'thinking', 'signature'])
        && value.type === 'thinking' && typeof value.thinking === 'string'
        && typeof value.signature === 'string' && Boolean(value.signature);
    }
    if (kind === 'redacted_thinking') {
      return hasOnlyKeys(value, ['type', 'data'])
        && value.type === 'redacted_thinking' && typeof value.data === 'string' && Boolean(value.data);
    }
    if (kind === 'fallback') {
      return hasOnlyKeys(value, ['type', 'from', 'to']) && value.type === 'fallback'
        && isRecord(value.from) && typeof value.from.model === 'string' && Boolean(value.from.model)
        && hasOnlyKeys(value.from, ['model'])
        && isRecord(value.to) && typeof value.to.model === 'string' && Boolean(value.to.model)
        && hasOnlyKeys(value.to, ['model']);
    }
    if (kind === 'compaction') {
      const keys = Object.keys(value);
      const cacheControl = value.cache_control;
      return value.type === 'compaction'
        && keys.every((key) => ['type', 'content', 'encrypted_content', 'cache_control'].includes(key))
        && (value.content === undefined || value.content === null || (typeof value.content === 'string' && Boolean(value.content)))
        && (value.encrypted_content === undefined || value.encrypted_content === null
          || (typeof value.encrypted_content === 'string' && Boolean(value.encrypted_content)))
        && (cacheControl === undefined || (isRecord(cacheControl) && cacheControl.type === 'ephemeral'
          && Object.keys(cacheControl).every((key) => ['type', 'ttl'].includes(key))
          && (cacheControl.ttl === undefined || ['5m', '1h'].includes(cacheControl.ttl))));
    }
    return false;
  }
  if (protocol === 'responses') {
    if (kind === 'reasoning') {
      return hasOnlyKeys(value, ['type', 'id', 'status', 'summary', 'content', 'encrypted_content', 'phase'])
        && value.type === 'reasoning'
        && typeof value.encrypted_content === 'string' && Boolean(value.encrypted_content)
        && optionalNonEmptyString(value.id)
        && optionalEnum(value.status, RESPONSES_ITEM_STATUSES)
        && optionalEnum(value.phase, RESPONSES_ITEM_PHASES)
        && validReasoningParts(value.summary, 'summary_text')
        && validReasoningParts(value.content, 'reasoning_text');
    }
    if (kind === 'compaction') {
      return value.type === 'compaction'
        && Object.keys(value).every((key) => ['type', 'id', 'encrypted_content', 'created_by'].includes(key))
        && typeof value.id === 'string' && Boolean(value.id)
        && typeof value.encrypted_content === 'string' && Boolean(value.encrypted_content)
        && (value.created_by === undefined || (typeof value.created_by === 'string' && Boolean(value.created_by)));
    }
    return false;
  }
  if (protocol === 'chat') {
    if (kind === 'reasoning_detail') return isChatReasoningDetail(value);
    return kind === 'reasoning_details' && hasOnlyKeys(value, ['details'])
      && Array.isArray(value.details) && value.details.length > 0
      && value.details.every(isChatReasoningDetail);
  }
  if (protocol === 'gemini') return kind === 'part' && isGeminiSignedPart(value);
  return false;
}

function isChatReasoningDetail(detail) {
  if (!isRecord(detail)) return false;
  if (detail.type === 'reasoning.text') {
    if (!hasOnlyKeys(detail, ['type', 'text', 'signature', 'id', 'format', 'index'])
      || typeof detail.text !== 'string'
      || (detail.signature != null && typeof detail.signature !== 'string')) return false;
  } else if (detail.type === 'reasoning.summary') {
    if (!hasOnlyKeys(detail, ['type', 'summary', 'id', 'format', 'index']) || typeof detail.summary !== 'string') return false;
  } else if (detail.type === 'reasoning.encrypted') {
    if (!hasOnlyKeys(detail, ['type', 'data', 'id', 'format', 'index'])
      || typeof detail.data !== 'string' || !detail.data) return false;
  } else {
    return false;
  }
  return optionalNonEmptyString(detail.id) && optionalNonEmptyString(detail.format)
    && (detail.index == null || (Number.isSafeInteger(detail.index) && detail.index >= 0));
}

function isGeminiSignedPart(part) {
  const signature = part.thoughtSignature ?? part.thought_signature;
  if (typeof signature !== 'string' || !signature) return false;
  if (part.thoughtSignature !== undefined && part.thought_signature !== undefined
    && part.thoughtSignature !== part.thought_signature) return false;
  const call = part.functionCall || part.function_call;
  if (call !== undefined) {
    return !(part.functionCall !== undefined && part.function_call !== undefined)
      && hasOnlyKeys(part, ['functionCall', 'function_call', 'thoughtSignature', 'thought_signature', 'thought'])
      && (part.thought === undefined || typeof part.thought === 'boolean')
      && isRecord(call) && hasOnlyKeys(call, ['id', 'name', 'args'])
      && optionalNonEmptyString(call.id)
      && typeof call.name === 'string' && Boolean(call.name)
      && (call.args === undefined || isRecord(call.args));
  }
  return hasOnlyKeys(part, ['text', 'thought', 'thoughtSignature', 'thought_signature'])
    && part.thought === true && typeof part.text === 'string';
}

function validReasoningParts(value, type) {
  return value == null || (Array.isArray(value) && value.every((part) =>
    isRecord(part) && hasOnlyKeys(part, ['type', 'text'])
      && part.type === type && typeof part.text === 'string'));
}

function optionalNonEmptyString(value) {
  return value == null || (typeof value === 'string' && Boolean(value));
}

function optionalEnum(value, allowed) {
  return value == null || allowed.has(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
