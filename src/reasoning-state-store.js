import { createHash } from 'node:crypto';

import { decodeReasoningState, encodeReasoningState, encodeReasoningStateBundle, GEMINI_BRIDGE_STATE_TEXT } from './reasoning-state.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const CACHED_TOOL_FINGERPRINT = Symbol('cachedToolFingerprint');

export function createReasoningStateScope(clientId, model, route) {
  const values = [clientId, model, route?.provider, route?.upstreamModel, route?.protocol];
  if (values.some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError('推理状态作用域缺少客户端、模型或上游路由身份');
  }
  return JSON.stringify(values);
}

export class ReasoningStateStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.protocolEntryCounts = new Map();
    this.bytes = 0;
    this.nextExpiryAt = Infinity;
    this.nextExpiryCount = 0;
    this.expiryIndexDirty = false;
  }

  remember(toolCalls, providerStates, scope = '') {
    const states = [];
    for (const state of providerStates || []) {
      if (state?.protocol && state?.kind && state?.value) states.push(state);
    }
    if (!states.length) return;
    const calls = uniqueToolCalls(toolCalls);
    if (!calls.length) return;
    const size = Buffer.byteLength(JSON.stringify(states), 'utf8');
    if (size > this.maxBytes) return;
    const protocols = new Set();
    for (const state of states) protocols.add(state.protocol);
    const now = this.now();
    const expiresAt = now + this.ttlMs;
    for (const call of calls) {
      const key = scopedKey(scope, call);
      const previous = this.entries.get(key);
      if (previous) this.removeEntry(key, previous);
      this.addEntry(key, { states, protocols, expiresAt, size });
    }
    this.prune(now);
  }

  rememberParts(parts, scope = '') {
    const toolCalls = [];
    const states = [];
    for (const part of parts || []) {
      if (part?.type === 'tool_call') {
        toolCalls.push({ id: part.id, name: part.name, arguments: part.arguments });
      }
      if (part?.providerState) states.push(part.providerState);
    }
    this.remember(toolCalls, states, scope);
  }

  inject(body, incomingProtocol, targetProtocol, scope = '') {
    if (!this.entries.size) return body;
    this.prune();
    if (!this.entries.size || !this.protocolEntryCounts.has(targetProtocol)) return body;
    if (incomingProtocol === 'chat') return this.injectChat(body, targetProtocol, scope);
    if (incomingProtocol === 'claude') return this.injectClaude(body, targetProtocol, scope);
    if (incomingProtocol === 'responses') return this.injectResponses(body, targetProtocol, scope);
    if (incomingProtocol === 'gemini') return this.injectGemini(body, targetProtocol, scope);
    return body;
  }

  injectChat(body, targetProtocol, scope = '') {
    if (!body || !Array.isArray(body.messages)) return body;
    const messages = mapWithStructuralSharing(body.messages, (message) => {
      if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
      const existing = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
      const existingStates = [];
      for (const detail of existing) {
        const state = decodeReasoningState(detail?.data) || decodeReasoningState(detail?.signature);
        if (state) existingStates.push(state);
      }
      const toolCalls = [];
      for (const call of message.tool_calls) {
        toolCalls.push({ id: call?.id, name: call?.function?.name, arguments: call?.function?.arguments });
      }
      const states = withoutExistingStates(this.statesForCalls(toolCalls, targetProtocol, scope), existingStates);
      if (!states.length) return message;
      const reasoningDetails = [...existing];
      for (const [index, state] of states.entries()) {
        reasoningDetails.push({
          type: 'reasoning.encrypted',
          data: encodeReasoningState(state.protocol, state.kind, state.value),
          id: `bridge-reasoning-${index}`,
          format: 'anthropic-claude-v1',
          index: existing.length + index
        });
      }
      return {
        ...message,
        reasoning_details: reasoningDetails
      };
    });
    return messages === body.messages ? body : { ...body, messages };
  }

  injectClaude(body, targetProtocol, scope = '') {
    if (!body || !Array.isArray(body.messages)) return body;
    const messages = mapWithStructuralSharing(body.messages, (message) => {
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
      const toolCalls = [];
      const existing = [];
      let insertAt = -1;
      for (const [index, part] of message.content.entries()) {
        if (part?.type === 'tool_use') {
          if (insertAt < 0) insertAt = index;
          toolCalls.push({ id: part.id, name: part.name, arguments: part.input });
        }
        const state = decodeReasoningState(part?.signature) || decodeReasoningState(part?.data);
        if (state) existing.push(state);
      }
      const states = withoutExistingStates(this.statesForCalls(toolCalls, targetProtocol, scope), existing);
      if (!states.length) return message;
      const content = [...message.content];
      content.splice(insertAt < 0 ? 0 : insertAt, 0, ...states.map((state) => ({
        type: 'redacted_thinking', data: encodeReasoningState(state.protocol, state.kind, state.value)
      })));
      return { ...message, content };
    });
    return messages === body.messages ? body : { ...body, messages };
  }

  injectResponses(body, targetProtocol, scope = '') {
    if (!body || !Array.isArray(body.input)) return body;
    let changed = false;
    const input = [];
    const existingStates = new Set();
    const usedIds = new Set();
    for (const item of body.input) {
      if (typeof item?.id === 'string' && item.id) usedIds.add(item.id);
    }
    let bridgeIdIndex = 0;
    const nextBridgeId = () => {
      let id;
      do { id = `rs_bridge_${bridgeIdIndex++}`; } while (usedIds.has(id));
      usedIds.add(id);
      return id;
    };
    const rememberExistingState = (item) => {
      const state = decodeReasoningState(item?.encrypted_content);
      if (!state || state.protocol === 'bridge') return;
      existingStates.add(encodeReasoningState(state.protocol, state.kind, state.value));
    };
    for (const item of body.input) {
      if (item?.type === 'function_call') {
        const states = this.statesForCalls([{
          id: item.call_id || item.id, name: item.name, arguments: item.arguments
        }], targetProtocol, scope);
        for (const state of states) {
          const encryptedContent = encodeReasoningState(state.protocol, state.kind, state.value);
          if (existingStates.has(encryptedContent)) continue;
          existingStates.add(encryptedContent);
          changed = true;
          input.push({
            id: nextBridgeId(), type: 'reasoning', summary: [],
            encrypted_content: encryptedContent
          });
        }
      }
      input.push(item);
      rememberExistingState(item);
    }
    return changed ? { ...body, input } : body;
  }

  injectGemini(body, targetProtocol, scope = '') {
    if (!body || !Array.isArray(body.contents)) return body;
    const contents = mapWithStructuralSharing(body.contents, (content) => {
      if (content?.role !== 'model' || !Array.isArray(content.parts)) return content;
      const toolCalls = [];
      const existingStates = [];
      for (const part of content.parts) {
        const call = part?.functionCall || part?.function_call;
        if (call) toolCalls.push({ id: call.id || call.name, name: call.name, arguments: call.args });
        existingStates.push(...decodedReasoningStates(part?.thoughtSignature || part?.thought_signature));
      }
      const states = withoutExistingStates(this.statesForCalls(toolCalls, targetProtocol, scope), existingStates);
      if (!states.length) return content;
      const signature = states.length === 1
        ? encodeReasoningState(states[0].protocol, states[0].kind, states[0].value)
        : encodeReasoningStateBundle(states);
      return {
        ...content,
        parts: [{ text: GEMINI_BRIDGE_STATE_TEXT, thought: true, thoughtSignature: signature }, ...content.parts]
      };
    });
    return contents === body.contents ? body : { ...body, contents };
  }

  statesForCalls(calls, targetProtocol, scope = '') {
    const states = [];
    if (!this.protocolEntryCounts.has(targetProtocol)) return states;
    const uniqueCalls = uniqueToolCalls(calls);
    if (!uniqueCalls.length) return states;
    const identities = new Set();
    const identityCache = new Map();
    let now;
    let hasNow = false;
    const identityFor = (state) => {
      if (!identityCache.has(state)) identityCache.set(state, stateIdentity(state));
      return identityCache.get(state);
    };
    for (const call of uniqueCalls) {
      let key = scopedKey(scope, call);
      let entry = this.entries.get(key);
      if (!entry && call[CACHED_TOOL_FINGERPRINT]) {
        key = scopedKey(scope, { id: call.id });
        entry = this.entries.get(key);
      }
      if (!entry) continue;
      if (!hasNow) {
        now = this.now();
        hasNow = true;
      }
      if (entry.expiresAt <= now) continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      for (const state of entry.states) {
        if (state.protocol !== targetProtocol) continue;
        const identity = identityFor(state);
        if (identities.has(identity)) continue;
        identities.add(identity);
        states.push(state);
      }
    }
    return states;
  }

  addEntry(key, entry) {
    this.entries.set(key, entry);
    this.bytes += entry.size;
    if (entry.expiresAt < this.nextExpiryAt) {
      this.nextExpiryAt = entry.expiresAt;
      this.nextExpiryCount = 1;
    } else if (entry.expiresAt === this.nextExpiryAt) {
      this.nextExpiryCount++;
    }
    for (const protocol of entry.protocols) {
      this.protocolEntryCounts.set(protocol, (this.protocolEntryCounts.get(protocol) || 0) + 1);
    }
  }

  removeEntry(key, entry = this.entries.get(key)) {
    if (!entry || !this.entries.delete(key)) return;
    this.bytes -= entry.size;
    if (entry.expiresAt === this.nextExpiryAt) {
      this.nextExpiryCount--;
      if (this.nextExpiryCount <= 0) {
        this.nextExpiryCount = 0;
        this.expiryIndexDirty = true;
      }
    }
    for (const protocol of entry.protocols) {
      const count = (this.protocolEntryCounts.get(protocol) || 0) - 1;
      if (count > 0) this.protocolEntryCounts.set(protocol, count);
      else this.protocolEntryCounts.delete(protocol);
    }
    if (!this.entries.size) {
      this.nextExpiryAt = Infinity;
      this.nextExpiryCount = 0;
      this.expiryIndexDirty = false;
    }
  }

  rebuildExpiryIndex() {
    let nextExpiryAt = Infinity;
    let nextExpiryCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt < nextExpiryAt) {
        nextExpiryAt = entry.expiresAt;
        nextExpiryCount = 1;
      } else if (entry.expiresAt === nextExpiryAt) {
        nextExpiryCount++;
      }
    }
    this.nextExpiryAt = nextExpiryAt;
    this.nextExpiryCount = nextExpiryCount;
    this.expiryIndexDirty = false;
  }

  prune(now) {
    if (!this.entries.size) {
      this.nextExpiryAt = Infinity;
      this.nextExpiryCount = 0;
      this.expiryIndexDirty = false;
      return;
    }
    const snapshot = now ?? this.now();
    if (this.expiryIndexDirty || this.nextExpiryAt <= snapshot) {
      let nextExpiryAt = Infinity;
      let nextExpiryCount = 0;
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt <= snapshot) {
          this.removeEntry(id, entry);
          continue;
        }
        if (entry.expiresAt < nextExpiryAt) {
          nextExpiryAt = entry.expiresAt;
          nextExpiryCount = 1;
        } else if (entry.expiresAt === nextExpiryAt) {
          nextExpiryCount++;
        }
      }
      this.nextExpiryAt = nextExpiryAt;
      this.nextExpiryCount = nextExpiryCount;
      this.expiryIndexDirty = false;
    }
    if (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestEntries = this.entries.entries();
      while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
        const oldest = oldestEntries.next().value;
        if (!oldest) break;
        this.removeEntry(oldest[0], oldest[1]);
      }
    }
    if (this.expiryIndexDirty) this.rebuildExpiryIndex();
  }
}

function mapWithStructuralSharing(items, transform) {
  let result;
  for (let index = 0; index < items.length; index++) {
    if (!(index in items)) {
      if (result) result.length++;
      continue;
    }
    const item = items[index];
    const transformed = transform(item, index);
    if (!result) {
      if (transformed === item) continue;
      result = items.slice(0, index);
    }
    result.push(transformed);
  }
  return result || items;
}

function decodedReasoningStates(value) {
  const state = decodeReasoningState(value);
  if (!state) return [];
  return state.protocol === 'bridge' && state.kind === 'bundle' ? state.value.states : [state];
}

function stateIdentity(state) {
  return createHash('sha256')
    .update(JSON.stringify([state.protocol, state.kind, state.value]))
    .digest('base64url');
}

function withoutExistingStates(states, existingStates) {
  if (!states.length || !existingStates.length) return states;
  const existing = new Set();
  for (const state of existingStates) existing.add(stateIdentity(state));
  const missing = [];
  for (const state of states) {
    if (!existing.has(stateIdentity(state))) missing.push(state);
  }
  return missing;
}

function scopedKey(scope, call) {
  const fingerprint = call[CACHED_TOOL_FINGERPRINT] ?? toolFingerprint(call);
  return createHash('sha256')
    .update(scope)
    .update('\u0000')
    .update(call.id)
    .update('\u0000')
    .update(fingerprint)
    .digest('base64url');
}

function uniqueToolCalls(toolCalls) {
  const calls = [];
  const seen = new Set();
  for (const value of toolCalls || []) {
    const call = typeof value === 'string' ? { id: value } : value;
    if (!call || typeof call.id !== 'string' || !call.id) continue;
    const normalized = {
      id: call.id,
      ...(typeof call.name === 'string' && call.name ? { name: call.name } : {}),
      ...(call.arguments !== undefined ? { arguments: call.arguments } : {})
    };
    const fingerprint = toolFingerprint(normalized);
    Object.defineProperty(normalized, CACHED_TOOL_FINGERPRINT, { value: fingerprint });
    const key = `${normalized.id}\u0000${fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(normalized);
  }
  return calls;
}

function toolFingerprint(call) {
  if (!call.name && call.arguments === undefined) return '';
  return `${call.name || ''}\u0000${canonicalToolArguments(call.arguments)}`;
}

function canonicalToolArguments(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return digestValue('raw', value); }
  }
  const hash = createHash('sha256').update('json\u0000');
  const stack = [{ value: parsed }];
  const seen = new Set();
  while (stack.length) {
    const frame = stack.pop();
    if (frame.token !== undefined) {
      hash.update(frame.token);
      continue;
    }
    const item = frame.value;
    if (!item || typeof item !== 'object') {
      hash.update(JSON.stringify(item) ?? `"<${typeof item}>"`);
      continue;
    }
    if (seen.has(item)) return digestValue('unserializable', typeof value === 'string' ? value : Object.prototype.toString.call(value));
    seen.add(item);
    if (Array.isArray(item)) {
      hash.update('[');
      stack.push({ token: ']' });
      for (let index = item.length - 1; index >= 0; index--) {
        stack.push({ value: item[index] });
        if (index > 0) stack.push({ token: ',' });
      }
      continue;
    }
    const keys = Object.keys(item).sort();
    hash.update('{');
    stack.push({ token: '}' });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      stack.push({ value: item[key] });
      stack.push({ token: ':' });
      stack.push({ token: JSON.stringify(key) });
      if (index > 0) stack.push({ token: ',' });
    }
  }
  return hash.digest('base64url');
}

function digestValue(tag, value) {
  return createHash('sha256').update(tag).update('\u0000').update(value).digest('base64url');
}
