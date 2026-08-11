import { randomBytes, randomUUID } from 'node:crypto';
import { chatStopReason, claudeSpeedForOpenAiServiceTier, claudeStopReason, createGeminiToolNameRestorer, createResponsesToolIdentityResolver, geminiFinishReason, geminiGroundingMetadata, geminiLogprobFields, geminiUsageMetadata, hasUsageData, isPortableChatFinishReason, isPortableClaudeStopReason, isPortableGeminiFinishReason, normalizeGeminiGroundingMetadata, normalizeGeminiLogprobs, normalizeOutputAnnotations, normalizeTokenLogprobs, normalizeUsageCount, openAiServiceTierForClaudeSpeed, openAiTokenLogprobs, portableAnnotationText, responseMetadataDegradations, responsesIncompleteReason, responsesResponseConfig } from './adapters.js';
import { validateClaudeCompactionBlock, validateClaudeFallbackBlock } from './claude-tools.js';
import { decodeReasoningState, encodeReasoningState, encodeReasoningStateBundle, GEMINI_BRIDGE_STATE_TEXT } from './reasoning-state.js';
import { assertJsonComplexity } from './json-complexity.js';

export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;
export const SSE_HEARTBEAT_COMMENT = ': opencode-bridge keep-alive\n\n';
const EMPTY_SSE_BLOCKS = Object.freeze([]);
const SSE_TEXT_BATCH_CHARS = 4 * 1024;
const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

export async function* withSseHeartbeat(source, intervalMs, options = {}) {
  if (!options || Array.isArray(options) || typeof options !== 'object') throw new TypeError('SSE 心跳选项必须是对象');
  const { comment = SSE_HEARTBEAT_COMMENT, onHeartbeat, onCancel } = options;
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw new TypeError('SSE 心跳来源必须可异步迭代');
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new TypeError('SSE 心跳间隔必须是非负整数');
  if (onHeartbeat !== undefined && typeof onHeartbeat !== 'function') throw new TypeError('SSE 心跳回调必须是函数');
  if (onCancel !== undefined && typeof onCancel !== 'function') throw new TypeError('SSE 取消回调必须是函数');
  if (typeof comment !== 'string' || !comment.startsWith(':') || !/\r?\n\r?\n$/.test(comment)) {
    throw new TypeError('SSE 心跳必须是完整的注释帧');
  }
  const iterator = source[Symbol.asyncIterator]();
  let outcome;
  let wake;
  let sourceFinished = false;
  try {
    if (intervalMs === 0) {
      while (true) {
        let result;
        try { result = await iterator.next(); }
        catch (error) { sourceFinished = true; throw error; }
        if (result.done) {
          sourceFinished = true;
          return;
        }
        yield result.value;
      }
    }
    const startRead = () => {
      outcome = undefined;
      Promise.resolve().then(() => iterator.next()).then(
        (result) => {
          outcome = { result };
          wake?.();
        },
        (error) => {
          outcome = { error };
          wake?.();
        }
      );
    };
    startRead();
    while (true) {
      if (!outcome) {
        let timer;
        await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, intervalMs);
        });
        wake = undefined;
        clearTimeout(timer);
      }
      if (!outcome) {
        yield comment;
        onHeartbeat?.();
        continue;
      }
      const settled = outcome;
      outcome = undefined;
      if (Object.hasOwn(settled, 'error')) {
        sourceFinished = true;
        throw settled.error;
      }
      if (settled.result.done) {
        sourceFinished = true;
        return;
      }
      yield settled.result.value;
      startRead();
    }
  } finally {
    wake = undefined;
    if (!sourceFinished) {
      let cancellationError;
      try { onCancel?.(); }
      catch (error) { cancellationError = error; }
      try { if (typeof iterator.return === 'function') await iterator.return(); }
      catch (error) { cancellationError ||= error; }
      if (cancellationError) throw cancellationError;
    }
  }
}

function assertSseEventBytes(bytes) {
  if (bytes > MAX_SSE_EVENT_BYTES) {
    throw Object.assign(new Error('上游 SSE 单个事件超过 8 MiB 上限'), { code: 'UPSTREAM_SSE_EVENT_TOO_LARGE' });
  }
}

function sseTextByteLength(value) {
  if (value.length <= 64) {
    for (let index = 0; index < value.length; index++) {
      if (value.charCodeAt(index) > 0x7f) return Buffer.byteLength(value, 'utf8');
    }
    return value.length;
  }
  return Buffer.byteLength(value, 'utf8');
}

function createSseTextBuffer() {
  return { text: '', fragments: [], staged: '', bytes: 0, scanFrom: 0 };
}

function resetSseTextBuffer(state) {
  state.text = '';
  state.fragments.length = 0;
  state.staged = '';
  state.bytes = 0;
  state.scanFrom = 0;
}

function stageSseText(state, value) {
  if (state.staged.length + value.length <= SSE_TEXT_BATCH_CHARS) {
    state.staged += value;
    return;
  }
  if (state.staged) state.fragments.push(state.staged);
  if (value.length >= SSE_TEXT_BATCH_CHARS) {
    state.fragments.push(value);
    state.staged = '';
  } else state.staged = value;
}

function materializeSseText(state, value = '') {
  if (!state.fragments.length && !state.staged) return value;
  if (state.staged) state.fragments.push(state.staged);
  if (value) state.fragments.push(value);
  const materialized = state.fragments.join('');
  state.fragments.length = 0;
  state.staged = '';
  return materialized;
}

function findSseBoundary(value, start) {
  for (let index = start; index < value.length - 1; index++) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    if (first === 10 && second === 10) return { index, length: 2 };
    if (first !== 13) continue;
    if (second === 13) return { index, length: 2 };
    if (second === 10 && value.charCodeAt(index + 2) === 13 && value.charCodeAt(index + 3) === 10) {
      return { index, length: 4 };
    }
  }
  return null;
}

function appendSseText(state, value) {
  if (!value) return EMPTY_SSE_BLOCKS;
  state.bytes += sseTextByteLength(value);
  if (!value.includes('\n') && !value.includes('\r')) {
    // 不含换行就不可能形成事件边界，先分批保留，避免每个小分片都拼接整段文本。
    stageSseText(state, value);
    assertSseEventBytes(state.bytes);
    return EMPTY_SSE_BLOCKS;
  }
  state.text += materializeSseText(state, value);
  let blocks;
  while (true) {
    const boundary = findSseBoundary(state.text, state.scanFrom);
    if (!boundary) break;
    const block = state.text.slice(0, boundary.index);
    const separator = state.text.slice(boundary.index, boundary.index + boundary.length);
    const blockBytes = sseTextByteLength(block);
    assertSseEventBytes(blockBytes);
    (blocks ||= []).push({ block, separator });
    state.text = state.text.slice(boundary.index + boundary.length);
    state.bytes -= blockBytes + boundary.length;
    state.scanFrom = 0;
  }
  assertSseEventBytes(state.bytes);
  state.scanFrom = Math.max(0, state.text.length - 3);
  return blocks || EMPTY_SSE_BLOCKS;
}

function takeSseText(state) {
  assertSseEventBytes(state.bytes);
  const value = state.text + materializeSseText(state);
  resetSseTextBuffer(state);
  return value;
}

function parseSseBlock(block) {
  const lines = block.split(/\r\n|\r|\n/);
  let event = 'message';
  let eventSeen = false;
  const dataLines = [];
  for (const line of lines) {
    if (!eventSeen && line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
      eventSeen = true;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return null;
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { return { event: 'error', data: { error: { message: '上游返回了无法解析的 SSE 数据' } } }; }
  assertJsonComplexity(parsed, { label: '上游 SSE 事件 JSON', code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  return { event, data: parsed };
}

function responsesItemSourceIndex(outputIndex) {
  return `responses-item:${outputIndex}`;
}

function responsesContentSourceIndex(outputIndex, contentIndex = 0) {
  return `responses-content:${outputIndex}:${contentIndex}`;
}

function responsesSummarySourceIndex(outputIndex, summaryIndex = 0) {
  return `responses-summary:${outputIndex}:${summaryIndex}`;
}

function responsesReasoningContentSourceIndex(outputIndex, contentIndex = 0) {
  return `responses-reasoning-content:${outputIndex}:${contentIndex}`;
}

function responsesProviderStateSourceIndex(outputIndex) {
  return `responses-provider-state:${outputIndex}`;
}

function invalidResponsesStream(message) {
  return Object.assign(new Error(`Responses 上游流事件无效：${message}`), { code: 'UPSTREAM_INVALID_STREAM_SEQUENCE' });
}

function invalidClaudeStream(message) {
  return Object.assign(new Error(`Claude 上游流事件无效：${message}`), { code: 'UPSTREAM_INVALID_STREAM_SEQUENCE' });
}

function invalidChatStream(message) {
  return Object.assign(new Error(`Chat 上游流事件无效：${message}`), { code: 'UPSTREAM_INVALID_STREAM_SEQUENCE' });
}

function invalidGeminiStream(message) {
  return Object.assign(new Error(`Gemini 上游流事件无效：${message}`), { code: 'UPSTREAM_INVALID_STREAM_SEQUENCE' });
}

function assertOptionalStreamIdentity(value, label, fail) {
  if (value !== undefined && (typeof value !== 'string' || !value)) fail(`${label} 必须是非空字符串`);
}

function assertStableStreamIdentity(previous, value, label, fail) {
  assertOptionalStreamIdentity(value, label, fail);
  if (previous && value && previous !== value) fail(`${label} 从 ${previous} 变为 ${value}`);
  return value || previous;
}

function validateResponsesWebSearchCall(item, label) {
  if (!item || Array.isArray(item) || typeof item !== 'object') throw invalidResponsesStream(`${label} 必须是对象`);
  if (typeof item.id !== 'string' || !item.id) throw invalidResponsesStream(`${label}.id 必须是非空字符串`);
  if (item.status !== undefined && !['in_progress', 'searching', 'completed', 'failed'].includes(item.status)) {
    throw invalidResponsesStream(`${label}.status 无效：${item.status}`);
  }
  if (item.action !== undefined && (!item.action || Array.isArray(item.action) || typeof item.action !== 'object')) {
    throw invalidResponsesStream(`${label}.action 必须是对象`);
  }
  if (item.action?.type !== undefined && !['search', 'open_page', 'find_in_page'].includes(item.action.type)) {
    throw invalidResponsesStream(`${label}.action.type 无效：${item.action.type}`);
  }
  if (item.action?.query !== undefined && typeof item.action.query !== 'string') throw invalidResponsesStream(`${label}.action.query 必须是字符串`);
  if (item.action?.queries !== undefined && (!Array.isArray(item.action.queries) || item.action.queries.some((query) => typeof query !== 'string'))) {
    throw invalidResponsesStream(`${label}.action.queries 必须是字符串数组`);
  }
}

function appendResponsesWebSearchQueries(target, seen, item) {
  if (item?.action?.type !== 'search') return;
  for (const query of [...asArray(item.action.queries), item.action.query]) {
    if (typeof query !== 'string' || !query || seen.has(query)) continue;
    seen.add(query);
    target.push(query);
  }
}

function responsesStreamIndex(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponsesStream(`${label} 必须是非负安全整数`);
  return value;
}

function claudeStreamIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidClaudeStream('content block index 必须是非负安全整数');
  return value;
}

function responseBlockState(blockType, outputIndex, contentIndex, extra = {}) {
  return {
    blockType, outputIndex, contentIndex,
    pending: '', pendingLogprobs: [], emitted: '', annotations: [], annotationKeys: new Set(), annotationsEmitted: false,
    started: false, valueDone: false, closed: false,
    ...extra
  };
}

function mergeResponseAnnotations(state, annotations, label) {
  if (annotations === undefined) return;
  const normalized = normalizeOutputAnnotations(annotations, label);
  const seen = state.annotationKeys
    || (state.annotationKeys = new Set(state.annotations.map((annotation) => JSON.stringify(annotation))));
  for (const annotation of normalized) {
    const key = JSON.stringify(annotation);
    if (seen.has(key)) continue;
    seen.add(key);
    state.annotations.push(annotation);
  }
}

function emitResponseAnnotations(state, sourceIndex) {
  if (state.annotationsEmitted || !state.started || state.closed) return [];
  state.annotationsEmitted = true;
  return state.annotations.length ? [{ type: 'annotations', sourceIndex, annotations: state.annotations }] : [];
}

function responseDeltaType(blockType) {
  return blockType === 'tool' ? 'tool_delta' : blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta';
}

function startResponseBlock(state, sourceIndex) {
  if (state.started) return [];
  state.started = true;
  const events = [{
    type: 'block_start', sourceIndex, blockType: state.blockType,
    id: state.id, name: state.name,
    ...(state.providerState ? { providerState: state.providerState } : {})
  }];
  if (state.pending) {
    events.push({
      type: responseDeltaType(state.blockType), sourceIndex, delta: state.pending,
      ...(state.blockType === 'text' && state.pendingLogprobs.length ? { logprobs: state.pendingLogprobs } : {})
    });
    state.emitted += state.pending;
    state.pending = '';
    state.pendingLogprobs = [];
  }
  return events;
}

function completeResponseBlock(state, sourceIndex, complete, logprobs) {
  if (state.closed || typeof complete !== 'string' || !complete.startsWith(state.emitted) || complete.length <= state.emitted.length) return [];
  const delta = complete.slice(state.emitted.length);
  state.emitted = complete;
  return [{
    type: responseDeltaType(state.blockType), sourceIndex, delta,
    ...(state.blockType === 'text' && logprobs?.length ? { logprobs } : {})
  }];
}

function stopResponseBlock(state, sourceIndex) {
  if (!state.started || state.closed) return [];
  state.closed = true;
  return [{ type: 'block_stop', sourceIndex }];
}

function decodeSseUtf8(decoder, chunk, options) {
  try { return decoder.decode(chunk, options); }
  catch { throw Object.assign(new Error('上游 SSE 包含无效 UTF-8'), { code: 'UPSTREAM_INVALID_UTF8' }); }
}

async function* parseSse(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pending = createSseTextBuffer();
  for await (const chunk of body) {
    for (const { block } of appendSseText(pending, decodeSseUtf8(decoder, chunk, { stream: true }))) {
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
    }
  }
  for (const { block } of appendSseText(pending, decodeSseUtf8(decoder))) {
    const parsed = parseSseBlock(block);
    if (parsed) yield parsed;
  }
  const parsed = parseSseBlock(takeSseText(pending).trim());
  if (parsed) yield parsed;
}

function sseErrorValue(data, eventName = '') {
  const explicitError = eventName === 'error';
  const explicitResponsesFailure = eventName === 'response.failed';
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    if (explicitError || explicitResponsesFailure) return data || { message: 'OpenCode 上游流式响应失败' };
    return undefined;
  }
  if (data.type === 'response.failed' || explicitResponsesFailure) {
    return data.response?.error || data.error || data;
  }
  if (data.error || data.type === 'error' || explicitError) return data.error || data;
  return undefined;
}

function safeSseErrorFrame(protocol, error, sequenceNumber) {
  const message = error?.message || String(error || 'OpenCode 上游流式响应失败');
  const code = error?.code || error?.type || 'upstream_error';
  if (protocol === 'responses') {
    return sse('error', {
      type: 'error', code, message, param: error?.param ?? null,
      sequence_number: Number.isSafeInteger(sequenceNumber) && sequenceNumber >= 0 ? sequenceNumber : 0
    });
  }
  if (protocol === 'claude') return sse('error', { type: 'error', error: { type: error?.type || 'upstream_error', message } });
  if (protocol === 'gemini') return geminiSse({ error: { code: 502, message, status: 'INTERNAL' } });
  return chatSse({ error: { message, type: error?.type || 'upstream_error', code: error?.code || null } });
}

export async function* sanitizeSseErrorStream(body, protocol, normalizeError = (error) => error, options = {}) {
  if (!options || Array.isArray(options) || typeof options !== 'object') throw new TypeError('SSE 过滤选项必须是对象');
  const { onData } = options;
  if (onData !== undefined && typeof onData !== 'function') throw new TypeError('SSE 过滤 onData 必须是函数');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pending = createSseTextBuffer();
  const sanitizedBlock = (block, separator = '') => {
    const parsed = parseSseBlock(block);
    const rawError = sseErrorValue(parsed?.data, parsed?.event);
    if (!rawError) {
      if (parsed && onData) {
        try { onData(parsed.data, parsed.event); } catch { /* 观察回调不能破坏原始流。 */ }
      }
      return { chunk: `${block}${separator}`, terminal: false };
    }
    const normalizedError = normalizeError(rawError);
    if (onData) {
      try {
        onData({
          type: 'error', error: normalizedError,
          ...(parsed?.data?.sequence_number !== undefined ? { sequence_number: parsed.data.sequence_number } : {})
        }, 'error');
      } catch { /* 观察回调不能破坏原始流。 */ }
    }
    return {
      chunk: safeSseErrorFrame(protocol, normalizedError, parsed?.data?.sequence_number),
      terminal: true
    };
  };
  for await (const chunk of body || []) {
    for (const { block, separator } of appendSseText(pending, decodeSseUtf8(decoder, chunk, { stream: true }))) {
      const result = sanitizedBlock(block, separator);
      yield result.chunk;
      if (result.terminal) return;
    }
  }
  for (const { block, separator } of appendSseText(pending, decodeSseUtf8(decoder))) {
    const result = sanitizedBlock(block, separator);
    yield result.chunk;
    if (result.terminal) return;
  }
  const buffer = takeSseText(pending);
  if (!buffer) return;
  const result = sanitizedBlock(buffer);
  yield result.chunk;
}

async function* canonicalEvents(response, protocol, fallbackModel, { rejectUnsupportedContent = false, allowResponsesWebSearch = false, onSseData } = {}) {
  let started = false;
  let id;
  let model = fallbackModel;
  let createdAt;
  let serviceTier;
  let speed;
  let systemFingerprint;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheCreation5mInputTokens = 0;
  let cacheCreation1hInputTokens = 0;
  let reasoningTokens = 0;
  let geminiCandidateTokens = 0;
  let usageObserved = false;
  let chatOutputTokens = 0;
  const chatTools = new Map();
  let chatHasTools = false;
  const responseBlocks = new Map();
  const responseBlockIndexes = new Map();
  const responseReasoningItems = new Map();
  const responseOutputItems = new Map();
  const responsePartLifecycles = new Map();
  const responseWebSearchQueries = [];
  const responseWebSearchQuerySet = new Set();
  const claudeBlocks = new Map();
  let claudeHasTools = false;
  const claudeReasoningBlocks = new Map();
  const chatReasoningDetails = new Map();
  let chatTextStarted = false;
  let chatRefusalStarted = false;
  let chatReasoningStarted = false;
  let chatFinishReason;
  let chatBlocksClosed = false;
  let claudeMessageDeltaSeen = false;
  let claudeStopReason;
  let claudeStopSequence;
  let claudeStopSequenceSeen = false;
  let claudeOutputTokens = 0;
  let responsesUpstreamId;
  let responsesUpstreamModel;
  let responsesSequenceNumber;
  let chatUpstreamId;
  let chatUpstreamModel;
  let geminiUpstreamId;
  let geminiUpstreamModel;
  let geminiPartIndex = 0;
  let geminiActiveBlock;
  let geminiText = '';
  let geminiGrounding;
  let terminal = false;

  const rememberResponseBlock = (sourceIndex, state) => {
    const previous = responseBlocks.get(sourceIndex);
    if (previous && previous.outputIndex !== state.outputIndex) {
      const previousIndexes = responseBlockIndexes.get(previous.outputIndex);
      previousIndexes?.delete(sourceIndex);
      if (previousIndexes?.size === 0) responseBlockIndexes.delete(previous.outputIndex);
    }
    responseBlocks.set(sourceIndex, state);
    let sourceIndexes = responseBlockIndexes.get(state.outputIndex);
    if (!sourceIndexes) {
      sourceIndexes = new Set();
      responseBlockIndexes.set(state.outputIndex, sourceIndexes);
    }
    sourceIndexes.add(sourceIndex);
    return state;
  };

  function* responseBlocksForOutput(outputIndex) {
    for (const sourceIndex of responseBlockIndexes.get(outputIndex) || []) {
      const state = responseBlocks.get(sourceIndex);
      if (state) yield [sourceIndex, state];
    }
  }

  const openResponseReasoningBlock = (outputIndex) => {
    for (const entry of responseBlocksForOutput(outputIndex)) {
      const state = entry[1];
      if (state.blockType === 'reasoning' && !state.closed) return entry;
    }
    return undefined;
  };

  const rememberResponseOutputItem = (outputIndex, item = {}, phase) => {
    const previous = responseOutputItems.get(outputIndex) || {};
    if (previous.type && item.type && previous.type !== item.type) {
      throw invalidResponsesStream(`output[${outputIndex}] 类型从 ${previous.type} 变为 ${item.type}`);
    }
    if (previous.id && item.id && previous.id !== item.id) {
      throw invalidResponsesStream(`output[${outputIndex}] item_id 从 ${previous.id} 变为 ${item.id}`);
    }
    if (phase === 'added' && previous.done) {
      throw invalidResponsesStream(`output[${outputIndex}] 在 output_item.done 之后又收到 output_item.added`);
    }
    if (phase === 'added' && previous.added) {
      throw invalidResponsesStream(`output[${outputIndex}] 重复收到 output_item.added`);
    }
    if (phase === 'done' && previous.done) {
      throw invalidResponsesStream(`output[${outputIndex}] 重复收到 output_item.done`);
    }
    if (phase === 'activity' && previous.done) {
      throw invalidResponsesStream(`output[${outputIndex}] 在 output_item.done 之后又收到内容事件`);
    }
    const identity = {
      ...previous,
      type: item.type || previous.type,
      id: item.id || previous.id,
      ...(phase === 'added' ? { added: true } : {}),
      ...(phase === 'done' ? { done: true } : {})
    };
    responseOutputItems.set(outputIndex, identity);
    return identity;
  };

  const rememberResponseReasoningItem = (outputIndex, item = {}) => {
    const previous = responseReasoningItems.get(outputIndex) || {};
    const providerState = typeof item.encrypted_content === 'string' && item.encrypted_content
      ? { protocol: 'responses', kind: 'reasoning', value: item }
      : previous.providerState;
    const metadata = {
      ...previous,
      id: item.id || previous.id,
      providerToken: typeof item.encrypted_content === 'string' && item.encrypted_content
        ? item.encrypted_content
        : previous.providerToken,
      ...(providerState ? { providerState } : {})
    };
    responseReasoningItems.set(outputIndex, metadata);
    return metadata;
  };

  const rememberResponsePartLifecycle = (key, phase, label) => {
    if (!rejectUnsupportedContent) return;
    const previous = responsePartLifecycles.get(key) || {};
    if (phase === 'added' && previous.done) throw invalidResponsesStream(`${label} 在 done 之后又收到 added`);
    if (phase === 'added' && previous.added) throw invalidResponsesStream(`${label} 重复收到 added`);
    if (phase === 'done' && previous.done) throw invalidResponsesStream(`${label} 重复收到 done`);
    responsePartLifecycles.set(key, { ...previous, [phase]: true });
  };

  const responseReasoningState = (sourceIndex, outputIndex, streamKind, itemId) => {
    const metadata = responseReasoningItems.get(outputIndex) || {};
    const state = responseBlocks.get(sourceIndex) || responseBlockState('reasoning', outputIndex, undefined, {
      streamKind,
      id: itemId || metadata.id
    });
    state.id = itemId || state.id || metadata.id;
    if (metadata.providerState && !metadata.attachedSourceIndex) {
      state.providerState = metadata.providerState;
      metadata.attachedSourceIndex = sourceIndex;
      metadata.attachedProviderToken = metadata.providerToken;
    }
    return rememberResponseBlock(sourceIndex, state);
  };

  function* responseCompactionEvents(outputIndex, item, { close = false } = {}) {
    if (typeof item?.encrypted_content !== 'string' || !item.encrypted_content) return;
    const sourceIndex = responsesProviderStateSourceIndex(outputIndex);
    const providerState = { protocol: 'responses', kind: 'compaction', value: item };
    const state = responseBlocks.get(sourceIndex) || responseBlockState('provider_state', outputIndex, undefined, {
      streamKind: 'compaction', id: item.id, providerState
    });
    if (state.blockType !== 'provider_state') {
      throw invalidResponsesStream(`output[${outputIndex}] 无法从 ${state.blockType} 变为 compaction`);
    }
    Object.assign(state, { streamKind: 'compaction', id: item.id, providerState });
    rememberResponseBlock(sourceIndex, state);
    for (const event of startResponseBlock(state, sourceIndex)) yield event;
    if (close) for (const event of stopResponseBlock(state, sourceIndex)) yield event;
  }

  function* closeClaudeBlock(index, state) {
    if (!state || state.closed) return;
    if (state.blockType === 'reasoning') {
      const reasoningState = claudeReasoningBlocks.get(index) || { started: false, text: '', signature: '' };
      const providerState = reasoningState.providerState || {
        protocol: 'claude', kind: 'thinking',
        value: { type: 'thinking', thinking: reasoningState.text, signature: reasoningState.signature }
      };
      if (!reasoningState.started) yield { type: 'block_start', sourceIndex: index, blockType: 'provider_state', providerState };
      else yield { type: 'provider_state', sourceIndex: index, providerState };
      claudeReasoningBlocks.delete(index);
    }
    yield { type: 'block_stop', sourceIndex: index };
    state.closed = true;
  }

  function* closeClaudeOpenBlocks() {
    for (const [index, state] of claudeBlocks) {
      if (!state.closed) yield* closeClaudeBlock(index, state);
    }
  }

  function assertPortableClaudeTerminalState() {
    if (!rejectUnsupportedContent) return;
    if (!isPortableClaudeStopReason(claudeStopReason)) throw invalidClaudeStream('终态前缺少合法 stop_reason');
    if (claudeStopReason === 'stop_sequence') {
      if (typeof claudeStopSequence !== 'string' || !claudeStopSequence) {
        throw invalidClaudeStream('stop_reason=stop_sequence，但 stop_sequence 不是非空字符串');
      }
    } else if (claudeStopSequenceSeen && claudeStopSequence !== null && claudeStopSequence !== undefined) {
      throw invalidClaudeStream(`stop_reason=${claudeStopReason}，但 stop_sequence 非空`);
    }
    if (claudeStopReason === 'tool_use' && !claudeHasTools) throw invalidClaudeStream('stop_reason=tool_use，但流中没有工具调用');
    if (claudeHasTools && ['end_turn', 'stop_sequence'].includes(claudeStopReason)) {
      throw invalidClaudeStream(`流中包含工具调用，但 stop_reason=${claudeStopReason}`);
    }
  }

  for await (const { event: eventName, data } of parseSse(response.body)) {
    if (rejectUnsupportedContent && (!data || Array.isArray(data) || typeof data !== 'object')) {
      if (protocol === 'responses') throw invalidResponsesStream('SSE data 必须是 JSON 对象');
      if (protocol === 'claude') throw invalidClaudeStream('SSE data 必须是 JSON 对象');
      if (protocol === 'chat') throw invalidChatStream('SSE data 必须是 JSON 对象');
      throw Object.assign(new Error('Gemini 上游流事件无效：SSE data 必须是 JSON 对象'), { code: 'UPSTREAM_INVALID_STREAM_SEQUENCE' });
    }
    onSseData?.(data);
    if (protocol === 'responses' && rejectUnsupportedContent) {
      if (!data.error && (typeof data.type !== 'string' || !data.type)) {
        throw invalidResponsesStream('data.type 必须是非空字符串');
      }
      const payloadType = data.type || (data.error ? 'error' : undefined);
      if (eventName !== 'message' && eventName !== payloadType) {
        throw invalidResponsesStream(`SSE event=${eventName} 与 data.type=${String(payloadType || 'missing')} 不一致`);
      }
      if (data.sequence_number !== undefined) {
        if (!Number.isSafeInteger(data.sequence_number) || data.sequence_number < 0) {
          throw invalidResponsesStream('sequence_number 必须是非负安全整数');
        }
        if (responsesSequenceNumber !== undefined && data.sequence_number <= responsesSequenceNumber) {
          throw invalidResponsesStream(`sequence_number 未严格递增：${responsesSequenceNumber} → ${data.sequence_number}`);
        }
        responsesSequenceNumber = data.sequence_number;
      }
    }
    if (protocol === 'claude' && rejectUnsupportedContent) {
      if (!data.error && (typeof data.type !== 'string' || !data.type)) {
        throw invalidClaudeStream('data.type 必须是非空字符串');
      }
      const payloadType = data.type || (data.error ? 'error' : undefined);
      if (eventName !== 'message' && eventName !== payloadType) {
        throw invalidClaudeStream(`SSE event=${eventName} 与 data.type=${String(payloadType || 'missing')} 不一致`);
      }
    }
    if (data.error || data.type === 'error') {
      terminal = true;
      yield { type: 'error', error: data.error || data };
      return;
    }
    if (protocol === 'claude') {
      if (data.type === 'message_start') {
        if (started) throw invalidClaudeStream('重复收到 message_start');
        if (asArray(data.message?.content).length) throw invalidClaudeStream('message_start.content 必须为空');
        if (rejectUnsupportedContent && data.message?.type !== undefined && data.message.type !== 'message') {
          throw invalidClaudeStream(`message_start.message.type 无效：${String(data.message.type)}`);
        }
        if (rejectUnsupportedContent && data.message?.role !== undefined && data.message.role !== 'assistant') {
          throw invalidClaudeStream(`message_start.message.role 无效：${String(data.message.role)}`);
        }
        if (rejectUnsupportedContent && data.message?.stop_reason !== undefined && data.message.stop_reason !== null) {
          throw invalidClaudeStream('message_start.message.stop_reason 必须为 null');
        }
        if (rejectUnsupportedContent && data.message?.stop_sequence !== undefined && data.message.stop_sequence !== null) {
          throw invalidClaudeStream('message_start.message.stop_sequence 必须为 null');
        }
        if (rejectUnsupportedContent) {
          assertOptionalStreamIdentity(data.message?.id, 'message_start.message.id', (message) => { throw invalidClaudeStream(message); });
          assertOptionalStreamIdentity(data.message?.model, 'message_start.message.model', (message) => { throw invalidClaudeStream(message); });
        }
        started = true; id = data.message?.id; model = data.message?.model || model;
        usageObserved ||= hasUsageData(data.message);
        inputTokens = normalizeUsageCount(data.message?.usage?.input_tokens);
        cachedInputTokens = normalizeUsageCount(data.message?.usage?.cache_read_input_tokens);
        cacheCreationInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation_input_tokens);
        cacheCreation5mInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation?.ephemeral_5m_input_tokens);
        cacheCreation1hInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation?.ephemeral_1h_input_tokens);
        reasoningTokens = normalizeUsageCount(data.message?.usage?.output_tokens_details?.thinking_tokens);
        speed = data.message?.usage?.speed == null ? speed : data.message.usage.speed;
        if (rejectUnsupportedContent && speed != null && !['standard', 'fast'].includes(speed)) {
          throw invalidClaudeStream(`message_start.message.usage.speed 无效：${String(speed)}`);
        }
        yield { type: 'start', id, model, speed, inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheCreation5mInputTokens, cacheCreation1hInputTokens };
      } else if (data.type === 'content_block_start') {
        if (!started) throw invalidClaudeStream('content_block_start 出现在 message_start 之前');
        if (claudeMessageDeltaSeen) throw invalidClaudeStream('content_block_start 出现在 message_delta 之后');
        const index = claudeStreamIndex(data.index);
        if (claudeBlocks.has(index)) throw invalidClaudeStream(`content block index ${index} 被重复使用`);
        if (!data.content_block || Array.isArray(data.content_block) || typeof data.content_block !== 'object') {
          throw invalidClaudeStream(`content block ${index} 必须是对象`);
        }
        const block = data.content_block;
        if (block.type === 'tool_use') {
          if (rejectUnsupportedContent && (typeof block.id !== 'string' || !block.id)) {
            throw invalidClaudeStream(`tool_use block ${index} 的 id 必须是非空字符串`);
          }
          if (rejectUnsupportedContent && (typeof block.name !== 'string' || !block.name)) {
            throw invalidClaudeStream(`tool_use block ${index} 的 name 必须是非空字符串`);
          }
          if (!block.input || Array.isArray(block.input) || typeof block.input !== 'object') {
            throw invalidClaudeStream(`tool_use block ${index} 的 input 必须是 JSON 对象`);
          }
          const initialArguments = Object.keys(block.input).length ? JSON.stringify(block.input) : '';
          claudeBlocks.set(index, { blockType: 'tool', closed: false, hasInitialToolInput: Boolean(initialArguments) });
          claudeHasTools = true;
          yield { type: 'block_start', sourceIndex: index, blockType: 'tool', id: block.id, name: block.name };
          if (initialArguments) yield { type: 'tool_delta', sourceIndex: index, delta: initialArguments };
        }
        else if (block.type === 'text') {
          if (rejectUnsupportedContent && typeof block.text !== 'string') {
            throw invalidClaudeStream(`text block ${index} 的 text 必须是字符串`);
          }
          const text = typeof block.text === 'string' ? block.text : '';
          claudeBlocks.set(index, { blockType: 'text', closed: false });
          yield { type: 'block_start', sourceIndex: index, blockType: 'text' };
          if (text) yield { type: 'text_delta', sourceIndex: index, delta: text };
        }
        else if (block.type === 'thinking') {
          if (rejectUnsupportedContent && typeof block.thinking !== 'string') {
            throw invalidClaudeStream(`thinking block ${index} 的 thinking 必须是字符串`);
          }
          if (rejectUnsupportedContent && typeof block.signature !== 'string') {
            throw invalidClaudeStream(`thinking block ${index} 的 signature 必须是字符串`);
          }
          const text = block.thinking || '';
          claudeBlocks.set(index, { blockType: 'reasoning', closed: false });
          claudeReasoningBlocks.set(index, { started: Boolean(text), text, signature: block.signature || '' });
          if (text) {
            yield { type: 'block_start', sourceIndex: index, blockType: 'reasoning' };
            yield { type: 'reasoning_delta', sourceIndex: index, delta: text };
          }
        }
        else if (block.type === 'redacted_thinking') {
          if (rejectUnsupportedContent && (typeof block.data !== 'string' || !block.data)) {
            throw invalidClaudeStream(`redacted_thinking block ${index} 的 data 必须是非空字符串`);
          }
          claudeBlocks.set(index, { blockType: 'provider_state', closed: false });
          yield {
            type: 'block_start', sourceIndex: index, blockType: 'provider_state',
            providerState: { protocol: 'claude', kind: 'redacted_thinking', value: block }
          };
        }
        else if (block.type === 'compaction') {
          validateClaudeCompactionBlock(block, `Claude compaction block ${index}`, (message) => { throw invalidClaudeStream(message); }, { response: true });
          const providerState = { protocol: 'claude', kind: 'compaction', value: block };
          const text = block.content || '';
          claudeBlocks.set(index, { blockType: 'reasoning', reasoningKind: 'compaction', closed: false });
          claudeReasoningBlocks.set(index, {
            started: Boolean(text), text, signature: '', providerState, compactionDeltaSeen: false
          });
          if (text) {
            yield { type: 'block_start', sourceIndex: index, blockType: 'reasoning', providerState };
            yield { type: 'reasoning_delta', sourceIndex: index, delta: text };
          }
        }
        else if (block.type === 'fallback') {
          validateClaudeFallbackBlock(block, `Claude fallback block ${index}`, (message) => { throw invalidClaudeStream(message); });
          const providerState = { protocol: 'claude', kind: 'fallback', value: block };
          claudeBlocks.set(index, { blockType: 'provider_state', closed: false });
          yield { type: 'block_start', sourceIndex: index, blockType: 'provider_state', providerState };
          if (typeof block.to?.model === 'string' && block.to.model) yield { type: 'model_update', model: block.to.model };
        }
        else if (rejectUnsupportedContent) throw unsupportedStreamContent(`Claude 流式内容块：${block.type || 'unknown'}`);
      } else if (data.type === 'content_block_delta') {
        if (!started) throw invalidClaudeStream('content_block_delta 出现在 message_start 之前');
        if (claudeMessageDeltaSeen) throw invalidClaudeStream('content_block_delta 出现在 message_delta 之后');
        const index = claudeStreamIndex(data.index);
        const blockState = claudeBlocks.get(index);
        if (!blockState || blockState.closed) throw invalidClaudeStream(`content block ${index} 尚未开始或已经结束`);
        if (data.delta?.type === 'text_delta') {
          if (blockState.blockType !== 'text') throw invalidClaudeStream(`text_delta 不能用于 ${blockState.blockType} block ${index}`);
          if (rejectUnsupportedContent && typeof data.delta.text !== 'string') throw invalidClaudeStream(`text_delta block ${index} 的 text 必须是字符串`);
          yield { type: 'text_delta', sourceIndex: index, delta: data.delta.text || '' };
        }
        else if (data.delta?.type === 'input_json_delta') {
          if (blockState.blockType !== 'tool') throw invalidClaudeStream(`input_json_delta 不能用于 ${blockState.blockType} block ${index}`);
          if (rejectUnsupportedContent && typeof data.delta.partial_json !== 'string') throw invalidClaudeStream(`input_json_delta block ${index} 的 partial_json 必须是字符串`);
          const delta = data.delta.partial_json || '';
          if (delta && blockState.hasInitialToolInput) throw invalidClaudeStream(`tool_use block ${index} 同时包含完整 input 和增量 input`);
          if (delta) yield { type: 'tool_delta', sourceIndex: index, delta };
        }
        else if (data.delta?.type === 'thinking_delta') {
          if (blockState.blockType !== 'reasoning') throw invalidClaudeStream(`thinking_delta 不能用于 ${blockState.blockType} block ${index}`);
          if (blockState.reasoningKind === 'compaction') throw invalidClaudeStream(`thinking_delta 不能用于 compaction block ${index}`);
          if (rejectUnsupportedContent && typeof data.delta.thinking !== 'string') throw invalidClaudeStream(`thinking_delta block ${index} 的 thinking 必须是字符串`);
          const text = data.delta.thinking || '';
          const state = claudeReasoningBlocks.get(index) || { started: false, text: '', signature: '' };
          state.text += text;
          if (text && !state.started) {
            state.started = true;
            claudeReasoningBlocks.set(index, state);
            yield { type: 'block_start', sourceIndex: index, blockType: 'reasoning' };
          }
          if (text) yield { type: 'reasoning_delta', sourceIndex: index, delta: text };
        }
        else if (data.delta?.type === 'signature_delta') {
          if (blockState.blockType !== 'reasoning') throw invalidClaudeStream(`signature_delta 不能用于 ${blockState.blockType} block ${index}`);
          if (blockState.reasoningKind === 'compaction') throw invalidClaudeStream(`signature_delta 不能用于 compaction block ${index}`);
          if (rejectUnsupportedContent && typeof data.delta.signature !== 'string') throw invalidClaudeStream(`signature_delta block ${index} 的 signature 必须是字符串`);
          const state = claudeReasoningBlocks.get(index);
          state.signature += data.delta.signature || '';
        }
        else if (data.delta?.type === 'compaction_delta') {
          if (blockState.blockType !== 'reasoning' || blockState.reasoningKind !== 'compaction') {
            throw invalidClaudeStream(`compaction_delta 不能用于 ${blockState.reasoningKind || blockState.blockType} block ${index}`);
          }
          const state = claudeReasoningBlocks.get(index);
          if (state.compactionDeltaSeen) throw invalidClaudeStream(`compaction block ${index} 重复收到 compaction_delta`);
          const unsupported = Object.keys(data.delta).filter((key) => !['type', 'content', 'encrypted_content'].includes(key));
          if (unsupported.length) throw invalidClaudeStream(`Claude compaction_delta block ${index} 包含不支持的字段：${unsupported.join(', ')}`);
          validateClaudeCompactionBlock({
            type: 'compaction', content: data.delta.content, encrypted_content: data.delta.encrypted_content
          }, `Claude compaction_delta block ${index}`, (message) => { throw invalidClaudeStream(message); }, { response: true });
          if (state.started) throw invalidClaudeStream(`compaction block ${index} 同时包含完整 content 和 compaction_delta`);
          state.compactionDeltaSeen = true;
          state.text = data.delta.content || '';
          state.providerState = {
            protocol: 'claude', kind: 'compaction',
            value: { type: 'compaction', content: data.delta.content, encrypted_content: data.delta.encrypted_content }
          };
          if (state.text) {
            state.started = true;
            yield { type: 'block_start', sourceIndex: index, blockType: 'reasoning', providerState: state.providerState };
            yield { type: 'reasoning_delta', sourceIndex: index, delta: state.text };
          }
        }
        else if (rejectUnsupportedContent) throw unsupportedStreamContent(`Claude 流式增量：${data.delta?.type || 'unknown'}`);
      } else if (data.type === 'content_block_stop') {
        if (!started) throw invalidClaudeStream('content_block_stop 出现在 message_start 之前');
        const index = claudeStreamIndex(data.index);
        const state = claudeBlocks.get(index);
        if (!state || state.closed) throw invalidClaudeStream(`content block ${index} 尚未开始或已经结束`);
        yield* closeClaudeBlock(index, state);
      }
      else if (data.type === 'message_delta') {
        if (!started) throw invalidClaudeStream('message_delta 出现在 message_start 之前');
        if (terminal) throw invalidClaudeStream('message_delta 出现在 message_stop 之后');
        usageObserved ||= hasUsageData(data);
        claudeMessageDeltaSeen = true;
        if (rejectUnsupportedContent && data.delta?.stop_reason != null && !isPortableClaudeStopReason(data.delta.stop_reason)) {
          throw invalidClaudeStream(`stop_reason 无法跨协议转换：${String(data.delta.stop_reason)}`);
        }
        if (claudeStopReason && data.delta?.stop_reason && claudeStopReason !== data.delta.stop_reason) {
          throw invalidClaudeStream(`stop_reason 从 ${claudeStopReason} 变为 ${data.delta.stop_reason}`);
        }
        if (data.delta?.stop_sequence !== undefined) {
          if (data.delta.stop_sequence !== null && (typeof data.delta.stop_sequence !== 'string' || !data.delta.stop_sequence)) {
            throw invalidClaudeStream('stop_sequence 必须为非空字符串或 null');
          }
          if (claudeStopSequenceSeen && claudeStopSequence !== data.delta.stop_sequence) {
            throw invalidClaudeStream(`stop_sequence 从 ${String(claudeStopSequence)} 变为 ${String(data.delta.stop_sequence)}`);
          }
          claudeStopSequence = data.delta.stop_sequence;
          claudeStopSequenceSeen = true;
        }
        claudeStopReason = data.delta?.stop_reason || claudeStopReason;
        inputTokens = normalizeUsageCount(data.usage?.input_tokens, inputTokens);
        cachedInputTokens = normalizeUsageCount(data.usage?.cache_read_input_tokens, cachedInputTokens);
        cacheCreationInputTokens = normalizeUsageCount(data.usage?.cache_creation_input_tokens, cacheCreationInputTokens);
        claudeOutputTokens = normalizeUsageCount(data.usage?.output_tokens, claudeOutputTokens);
        reasoningTokens = normalizeUsageCount(data.usage?.output_tokens_details?.thinking_tokens, reasoningTokens);
        if (data.usage?.speed !== undefined && data.usage.speed !== null) {
          if (rejectUnsupportedContent && !['standard', 'fast'].includes(data.usage.speed)) {
            throw invalidClaudeStream(`message_delta.usage.speed 无效：${String(data.usage.speed)}`);
          }
          if (speed && speed !== data.usage.speed) throw invalidClaudeStream(`usage.speed 从 ${speed} 变为 ${data.usage.speed}`);
          speed = data.usage.speed;
        }
      }
      else if (data.type === 'message_stop') {
        if (!started || !claudeMessageDeltaSeen) throw invalidClaudeStream('message_stop 缺少前置 message_start/message_delta');
        if (terminal) throw invalidClaudeStream('重复收到 message_stop');
        assertPortableClaudeTerminalState();
        yield* closeClaudeOpenBlocks();
        terminal = true;
        yield { type: 'done', stopReason: claudeStopReason, speed, outputTokens: claudeOutputTokens, inputTokens, cachedInputTokens, cacheCreationInputTokens, cacheCreation5mInputTokens, cacheCreation1hInputTokens, reasoningTokens, hasUsage: usageObserved };
        return;
      }
      continue;
    }

    if (protocol === 'responses') {
      if (rejectUnsupportedContent && terminal) {
        throw invalidResponsesStream(`${data.type || 'unknown'} 出现在终态事件之后`);
      }
      if (rejectUnsupportedContent && data.type !== 'response.created' && data.type !== 'response.failed'
        && typeof data.type === 'string' && data.type.startsWith('response.') && !started) {
        throw invalidResponsesStream(`${data.type} 出现在 response.created 之前`);
      }
      if (data.type === 'response.created') {
        if (started) throw invalidResponsesStream('重复收到 response.created');
        if (rejectUnsupportedContent && (!data.response || Array.isArray(data.response) || typeof data.response !== 'object')) {
          throw invalidResponsesStream('response.created.response 必须是对象');
        }
        if (rejectUnsupportedContent) {
          if (data.response.object !== undefined && data.response.object !== 'response') {
            throw invalidResponsesStream(`response.created.response.object 无效：${String(data.response.object)}`);
          }
          if (data.response.status !== undefined && data.response.status !== 'in_progress') {
            throw invalidResponsesStream(`response.created.response.status 无效：${String(data.response.status)}`);
          }
          responsesUpstreamId = assertStableStreamIdentity(responsesUpstreamId, data.response.id, 'response.id', (message) => { throw invalidResponsesStream(message); });
          responsesUpstreamModel = assertStableStreamIdentity(responsesUpstreamModel, data.response.model, 'response.model', (message) => { throw invalidResponsesStream(message); });
        }
        started = true; id = data.response?.id; model = data.response?.model || model;
        createdAt = Number.isSafeInteger(data.response?.created_at) ? data.response.created_at : createdAt;
        serviceTier = typeof data.response?.service_tier === 'string' ? data.response.service_tier : serviceTier;
        usageObserved ||= hasUsageData(data.response);
        inputTokens = normalizeUsageCount(data.response?.usage?.input_tokens, data.response?.usage?.prompt_tokens);
        cachedInputTokens = normalizeUsageCount(data.response?.usage?.cache_read_input_tokens, data.response?.usage?.prompt_cache_hit_tokens, data.response?.usage?.input_tokens_details?.cached_tokens, data.response?.usage?.prompt_tokens_details?.cached_tokens);
        cacheCreationInputTokens = normalizeUsageCount(data.response?.usage?.cache_creation_input_tokens, data.response?.usage?.input_tokens_details?.cache_write_tokens, data.response?.usage?.input_tokens_details?.cache_creation_tokens, data.response?.usage?.prompt_tokens_details?.cache_write_tokens, data.response?.usage?.prompt_tokens_details?.cache_creation_tokens);
        yield { type: 'start', id, model, createdAt, serviceTier, inputTokens, cachedInputTokens, cacheCreationInputTokens };
      } else if (data.type === 'response.output_item.added') {
        const item = data.item || {};
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        rememberResponseOutputItem(outputIndex, item, rejectUnsupportedContent ? 'added' : undefined);
        if (rejectUnsupportedContent) assertPortableResponsesStreamItem(item, `output_item.added output[${outputIndex}]`, 'added');
        if (item.type === 'web_search_call' && allowResponsesWebSearch) {
          validateResponsesWebSearchCall(item, `output[${outputIndex}] web_search_call`);
          appendResponsesWebSearchQueries(responseWebSearchQueries, responseWebSearchQuerySet, item);
          continue;
        }
        if (rejectUnsupportedContent && item.type === 'function_call' && item.caller !== undefined) {
          throw unsupportedStreamContent('Responses 程序调用 caller 关联');
        }
        if (item.type === 'message') {
          if (rejectUnsupportedContent) assertResponsesMessageContent(item.content);
          for (const [contentIndex, part] of asArray(item.content).entries()) {
            if (!['output_text', 'refusal'].includes(part?.type)) continue;
            const sourceIndex = responsesContentSourceIndex(outputIndex, contentIndex);
            const blockType = part.type === 'refusal' ? 'refusal' : 'text';
            const state = responseBlocks.get(sourceIndex) || responseBlockState(blockType, outputIndex, contentIndex, { streamKind: 'message' });
            Object.assign(state, { blockType, id: item.id, streamKind: 'message' });
            if (blockType === 'text') mergeResponseAnnotations(state, part.annotations, `Responses output[${outputIndex}].content[${contentIndex}].annotations`);
            rememberResponseBlock(sourceIndex, state);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
          }
        } else if (item.type === 'reasoning') {
          rememberResponseReasoningItem(outputIndex, item);
          for (const [summaryIndex, part] of asArray(item.summary).entries()) {
            if (part?.type !== 'summary_text' || !part.text) continue;
            const sourceIndex = responsesSummarySourceIndex(outputIndex, summaryIndex);
            const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_summary', item.id);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
          }
          for (const [contentIndex, part] of asArray(item.content).entries()) {
            if (part?.type !== 'reasoning_text' || !part.text) continue;
            const sourceIndex = responsesReasoningContentSourceIndex(outputIndex, contentIndex);
            const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_content', item.id);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
          }
        } else if (item.type === 'function_call') {
          const sourceIndex = responsesItemSourceIndex(outputIndex);
          const state = responseBlocks.get(sourceIndex) || responseBlockState('tool', outputIndex, undefined, { streamKind: 'tool' });
          Object.assign(state, { blockType: 'tool', streamKind: 'tool', id: item.call_id || item.id, name: item.name });
          rememberResponseBlock(sourceIndex, state);
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
        } else if (item.type === 'compaction') {
          // Compaction is opaque and may only become complete in output_item.done.
          // Defer emission so another protocol never receives a partial ciphertext.
        } else if (rejectUnsupportedContent) {
          throw unsupportedStreamContent(`Responses 输出项：${item.type || 'unknown'}`);
        }
      } else if (data.type === 'response.reasoning_summary_part.added' || data.type === 'response.reasoning_summary_part.done') {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        const summaryIndex = responsesStreamIndex(data.summary_index, 'summary_index', { optional: true });
        rememberResponseOutputItem(outputIndex, { id: data.item_id, type: 'reasoning' }, rejectUnsupportedContent ? 'activity' : undefined);
        if (rejectUnsupportedContent) assertResponsesReasoningSummaryPart(data.part, data.type);
        rememberResponsePartLifecycle(
          `summary:${outputIndex}:${summaryIndex}`,
          data.type.endsWith('.added') ? 'added' : 'done',
          `output[${outputIndex}].summary[${summaryIndex}]`
        );
        if (data.part?.type !== 'summary_text') {
          if (rejectUnsupportedContent) throw unsupportedStreamContent(`Responses reasoning summary part：${data.part?.type || 'unknown'}`);
          continue;
        }
        rememberResponseReasoningItem(outputIndex, { id: data.item_id });
        const sourceIndex = responsesSummarySourceIndex(outputIndex, summaryIndex);
        const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_summary', data.item_id);
        for (const event of startResponseBlock(state, sourceIndex)) yield event;
        if (data.type === 'response.reasoning_summary_part.done') {
          for (const event of completeResponseBlock(state, sourceIndex, typeof data.part.text === 'string' ? data.part.text : '')) yield event;
        }
      } else if (data.type === 'response.content_part.added' || data.type === 'response.content_part.done') {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        if (rejectUnsupportedContent) assertResponsesStreamContentPart(data.part, data.type);
        if (['output_text', 'refusal'].includes(data.part?.type)) {
          rememberResponseOutputItem(outputIndex, { id: data.item_id, type: 'message' }, rejectUnsupportedContent ? 'activity' : undefined);
          const blockType = data.part.type === 'refusal' ? 'refusal' : 'text';
          const contentIndex = responsesStreamIndex(data.content_index, 'content_index', { optional: true });
          rememberResponsePartLifecycle(
            `content:${outputIndex}:${contentIndex}`,
            data.type.endsWith('.added') ? 'added' : 'done',
            `output[${outputIndex}].content[${contentIndex}]`
          );
          const sourceIndex = responsesContentSourceIndex(outputIndex, contentIndex);
          const state = responseBlocks.get(sourceIndex) || responseBlockState(blockType, outputIndex, contentIndex, { streamKind: 'message' });
          if (state.blockType !== blockType) {
            throw unsupportedStreamContent(`Responses output[${outputIndex}].content[${contentIndex}] 类型从 ${state.blockType} 变为 ${blockType}`);
          }
          Object.assign(state, { id: data.item_id || state.id, streamKind: 'message' });
          if (blockType === 'text') mergeResponseAnnotations(state, data.part.annotations, `Responses content_part[${contentIndex}].annotations`);
          rememberResponseBlock(sourceIndex, state);
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
          if (data.type === 'response.content_part.done') {
            const complete = data.part.text ?? data.part.refusal ?? '';
            const logprobs = blockType === 'text' && !state.emitted
              ? normalizeTokenLogprobs(data.part.logprobs, 'Responses content_part.done logprobs')
              : undefined;
            for (const event of completeResponseBlock(state, sourceIndex, complete, logprobs)) yield event;
          }
        } else if (data.part?.type === 'reasoning_text') {
          rememberResponseOutputItem(outputIndex, { id: data.item_id, type: 'reasoning' }, rejectUnsupportedContent ? 'activity' : undefined);
          const contentIndex = responsesStreamIndex(data.content_index, 'content_index', { optional: true });
          rememberResponsePartLifecycle(
            `content:${outputIndex}:${contentIndex}`,
            data.type.endsWith('.added') ? 'added' : 'done',
            `output[${outputIndex}].content[${contentIndex}]`
          );
          rememberResponseReasoningItem(outputIndex, { id: data.item_id });
          const sourceIndex = responsesReasoningContentSourceIndex(outputIndex, contentIndex);
          const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_content', data.item_id);
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
          if (data.type === 'response.content_part.done') {
            for (const event of completeResponseBlock(state, sourceIndex, typeof data.part.text === 'string' ? data.part.text : '')) yield event;
          }
        }
      } else if (data.type === 'response.output_text.annotation.added') {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        rememberResponseOutputItem(outputIndex, { id: data.item_id, type: 'message' }, rejectUnsupportedContent ? 'activity' : undefined);
        const contentIndex = responsesStreamIndex(data.content_index, 'content_index', { optional: true });
        responsesStreamIndex(data.annotation_index, 'annotation_index', { optional: true });
        const sourceIndex = responsesContentSourceIndex(outputIndex, contentIndex);
        const state = responseBlocks.get(sourceIndex) || responseBlockState('text', outputIndex, contentIndex, { streamKind: 'message' });
        if (state.blockType !== 'text') {
          throw unsupportedStreamContent(`Responses output[${outputIndex}].content[${contentIndex}] 无法向 ${state.blockType} 块添加文本引用`);
        }
        Object.assign(state, { id: data.item_id || state.id, streamKind: 'message' });
        mergeResponseAnnotations(state, [data.annotation], `Responses annotation[${data.annotation_index ?? 0}]`);
        rememberResponseBlock(sourceIndex, state);
      } else if (['response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(data.type)) {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        if (rejectUnsupportedContent && typeof data.delta !== 'string') {
          throw invalidResponsesStream(`${data.type}.delta 必须是字符串`);
        }
        const blockType = data.type === 'response.function_call_arguments.delta' ? 'tool' : data.type.includes('reasoning') ? 'reasoning' : data.type === 'response.refusal.delta' ? 'refusal' : 'text';
        rememberResponseOutputItem(outputIndex, {
          id: data.item_id,
          type: blockType === 'tool' ? 'function_call' : blockType === 'reasoning' ? 'reasoning' : 'message'
        }, rejectUnsupportedContent ? 'activity' : undefined);
        const messageBlock = ['text', 'refusal'].includes(blockType);
        const summaryBlock = data.type === 'response.reasoning_summary_text.delta';
        const contentIndex = messageBlock || data.type === 'response.reasoning_text.delta'
          ? responsesStreamIndex(data.content_index, 'content_index', { optional: true })
          : undefined;
        const summaryIndex = summaryBlock
          ? responsesStreamIndex(data.summary_index, 'summary_index', { optional: true })
          : undefined;
        const sourceIndex = messageBlock
          ? responsesContentSourceIndex(outputIndex, contentIndex)
          : summaryBlock
            ? responsesSummarySourceIndex(outputIndex, summaryIndex)
            : data.type === 'response.reasoning_text.delta'
              ? responsesReasoningContentSourceIndex(outputIndex, contentIndex)
              : responsesItemSourceIndex(outputIndex);
        if (blockType === 'reasoning') rememberResponseReasoningItem(outputIndex, { id: data.item_id });
        const streamKind = messageBlock ? 'message' : summaryBlock ? 'reasoning_summary' : data.type === 'response.reasoning_text.delta' ? 'reasoning_content' : 'tool';
        const state = blockType === 'reasoning'
          ? responseReasoningState(sourceIndex, outputIndex, streamKind, data.item_id)
          : responseBlocks.get(sourceIndex) || responseBlockState(blockType, outputIndex, messageBlock ? contentIndex : undefined, { streamKind });
        if (state.blockType !== blockType) {
          throw unsupportedStreamContent(`Responses output[${outputIndex}] 流式内容类型从 ${state.blockType} 变为 ${blockType}`);
        }
        if (rejectUnsupportedContent && state.valueDone) {
          throw invalidResponsesStream(`${data.type} 出现在对应 done 事件之后`);
        }
        Object.assign(state, { id: data.item_id || state.id, streamKind });
        const delta = typeof data.delta === 'string' ? data.delta : '';
        const logprobs = blockType === 'text' ? normalizeTokenLogprobs(data.logprobs, 'Responses 流式 logprobs') : undefined;
        rememberResponseBlock(sourceIndex, state);
        if (!state.started && blockType !== 'tool') {
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
        }
        if (state.started && !state.closed) {
          state.emitted += delta;
          yield {
            type: responseDeltaType(blockType), sourceIndex, delta,
            ...(logprobs?.length ? { logprobs } : {})
          };
        } else if (!state.closed) {
          state.pending += delta;
          if (logprobs?.length) state.pendingLogprobs.push(...logprobs);
        }
      } else if (['response.output_text.done', 'response.refusal.done', 'response.function_call_arguments.done', 'response.reasoning_summary_text.done', 'response.reasoning_text.done'].includes(data.type)) {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        const completeField = data.type === 'response.function_call_arguments.done' ? 'arguments'
          : data.type === 'response.refusal.done' ? 'refusal' : 'text';
        if (rejectUnsupportedContent && typeof data[completeField] !== 'string') {
          throw invalidResponsesStream(`${data.type}.${completeField} 必须是字符串`);
        }
        const doneBlockType = data.type === 'response.function_call_arguments.done' ? 'tool' : data.type.includes('reasoning') ? 'reasoning' : data.type === 'response.refusal.done' ? 'refusal' : 'text';
        rememberResponseOutputItem(outputIndex, {
          id: data.item_id,
          type: doneBlockType === 'tool' ? 'function_call' : doneBlockType === 'reasoning' ? 'reasoning' : 'message'
        }, rejectUnsupportedContent ? 'activity' : undefined);
        const messageBlock = ['text', 'refusal'].includes(doneBlockType);
        const summaryBlock = data.type === 'response.reasoning_summary_text.done';
        const contentIndex = messageBlock || data.type === 'response.reasoning_text.done'
          ? responsesStreamIndex(data.content_index, 'content_index', { optional: true })
          : undefined;
        const summaryIndex = summaryBlock
          ? responsesStreamIndex(data.summary_index, 'summary_index', { optional: true })
          : undefined;
        const sourceIndex = messageBlock
          ? responsesContentSourceIndex(outputIndex, contentIndex)
          : summaryBlock
            ? responsesSummarySourceIndex(outputIndex, summaryIndex)
            : data.type === 'response.reasoning_text.done'
              ? responsesReasoningContentSourceIndex(outputIndex, contentIndex)
              : responsesItemSourceIndex(outputIndex);
        if (doneBlockType === 'reasoning') rememberResponseReasoningItem(outputIndex, { id: data.item_id });
        const streamKind = messageBlock ? 'message' : summaryBlock ? 'reasoning_summary' : data.type === 'response.reasoning_text.done' ? 'reasoning_content' : 'tool';
        const state = doneBlockType === 'reasoning'
          ? responseReasoningState(sourceIndex, outputIndex, streamKind, data.item_id)
          : responseBlocks.get(sourceIndex) || responseBlockState(doneBlockType, outputIndex, messageBlock ? contentIndex : undefined, { streamKind });
        if (state.blockType !== doneBlockType) {
          throw unsupportedStreamContent(`Responses output[${outputIndex}] 完成事件类型从 ${state.blockType} 变为 ${doneBlockType}`);
        }
        if (rejectUnsupportedContent && state.valueDone) throw invalidResponsesStream(`重复收到 ${data.type}`);
        Object.assign(state, { id: data.item_id || state.id, streamKind });
        rememberResponseBlock(sourceIndex, state);
        if (!state.started && doneBlockType !== 'tool') {
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
        }
        const complete = typeof data[completeField] === 'string' ? data[completeField] : '';
        const logprobs = state.blockType === 'text' && !state.emitted
          ? normalizeTokenLogprobs(data.logprobs, 'Responses 流式 done logprobs')
          : undefined;
        for (const event of completeResponseBlock(state, sourceIndex, complete, logprobs)) yield event;
        state.valueDone = true;
      } else if (data.type === 'response.output_item.done') {
        const item = data.item || {};
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        rememberResponseOutputItem(outputIndex, item, rejectUnsupportedContent ? 'done' : undefined);
        if (rejectUnsupportedContent) assertPortableResponsesStreamItem(item, `output_item.done output[${outputIndex}]`, 'done');
        if (item.type === 'web_search_call' && allowResponsesWebSearch) {
          validateResponsesWebSearchCall(item, `output[${outputIndex}] web_search_call`);
          appendResponsesWebSearchQueries(responseWebSearchQueries, responseWebSearchQuerySet, item);
          continue;
        }
        if (rejectUnsupportedContent && item.type === 'function_call' && item.caller !== undefined) {
          throw unsupportedStreamContent('Responses 程序调用 caller 关联');
        }
        if (item.type === 'message') {
          if (rejectUnsupportedContent) assertResponsesMessageContent(item.content);
          for (const [contentIndex, part] of asArray(item.content).entries()) {
            if (!['output_text', 'refusal'].includes(part?.type)) continue;
            const blockType = part.type === 'refusal' ? 'refusal' : 'text';
            const sourceIndex = responsesContentSourceIndex(outputIndex, contentIndex);
            const state = responseBlocks.get(sourceIndex) || responseBlockState(blockType, outputIndex, contentIndex, { streamKind: 'message' });
            if (state.blockType !== blockType) {
              throw unsupportedStreamContent(`Responses output[${outputIndex}].content[${contentIndex}] 类型从 ${state.blockType} 变为 ${blockType}`);
            }
            Object.assign(state, { id: item.id || state.id, streamKind: 'message' });
            if (blockType === 'text') mergeResponseAnnotations(state, part.annotations, `Responses output[${outputIndex}].content[${contentIndex}].annotations`);
            rememberResponseBlock(sourceIndex, state);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
            const complete = part.text ?? part.refusal ?? '';
            const logprobs = blockType === 'text' && !state.emitted
              ? normalizeTokenLogprobs(part.logprobs, 'Responses output_item.done logprobs')
              : undefined;
            for (const event of completeResponseBlock(state, sourceIndex, complete, logprobs)) yield event;
            for (const event of emitResponseAnnotations(state, sourceIndex)) yield event;
            for (const event of stopResponseBlock(state, sourceIndex)) yield event;
          }
          for (const [sourceIndex, state] of responseBlocksForOutput(outputIndex)) {
            if (state.outputIndex !== outputIndex || state.streamKind !== 'message') continue;
            for (const event of stopResponseBlock(state, sourceIndex)) yield event;
          }
        } else if (item.type === 'function_call') {
          const sourceIndex = responsesItemSourceIndex(outputIndex);
          const state = responseBlocks.get(sourceIndex) || responseBlockState('tool', outputIndex, undefined, { streamKind: 'tool' });
          Object.assign(state, { blockType: 'tool', streamKind: 'tool', id: state.id || item.call_id || item.id, name: state.name || item.name });
          rememberResponseBlock(sourceIndex, state);
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
          for (const event of completeResponseBlock(state, sourceIndex, item.arguments)) yield event;
          for (const event of stopResponseBlock(state, sourceIndex)) yield event;
        } else if (item.type === 'reasoning') {
          const metadata = rememberResponseReasoningItem(outputIndex, item);
          for (const [summaryIndex, part] of asArray(item.summary).entries()) {
            if (part?.type !== 'summary_text') continue;
            const sourceIndex = responsesSummarySourceIndex(outputIndex, summaryIndex);
            if (!part.text && !responseBlocks.has(sourceIndex)) continue;
            const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_summary', item.id);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
            for (const event of completeResponseBlock(state, sourceIndex, part.text || '')) yield event;
          }
          for (const [contentIndex, part] of asArray(item.content).entries()) {
            if (part?.type !== 'reasoning_text') continue;
            const sourceIndex = responsesReasoningContentSourceIndex(outputIndex, contentIndex);
            if (!part.text && !responseBlocks.has(sourceIndex)) continue;
            const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_content', item.id);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
            for (const event of completeResponseBlock(state, sourceIndex, part.text || '')) yield event;
          }
          let providerSourceIndex = metadata.attachedSourceIndex;
          if (!providerSourceIndex && metadata.providerState) {
            providerSourceIndex = openResponseReasoningBlock(outputIndex)?.[0];
          }
          if (metadata.providerState && providerSourceIndex && !responseBlocks.get(providerSourceIndex)?.closed) {
            const state = responseBlocks.get(providerSourceIndex);
            state.providerState = metadata.providerState;
            metadata.attachedSourceIndex = providerSourceIndex;
            metadata.attachedProviderToken = metadata.providerToken;
            yield { type: 'provider_state', sourceIndex: providerSourceIndex, providerState: metadata.providerState };
          } else if (metadata.providerState && metadata.finalizedProviderToken !== metadata.providerToken) {
            providerSourceIndex = responsesProviderStateSourceIndex(outputIndex);
            const state = responseBlockState('provider_state', outputIndex, undefined, {
              streamKind: 'reasoning_provider', id: item.id, providerState: metadata.providerState
            });
            rememberResponseBlock(providerSourceIndex, state);
            metadata.attachedSourceIndex = providerSourceIndex;
            metadata.attachedProviderToken = metadata.providerToken;
            for (const event of startResponseBlock(state, providerSourceIndex)) yield event;
          }
          for (const [sourceIndex, state] of responseBlocksForOutput(outputIndex)) {
            if (state.outputIndex !== outputIndex || !['reasoning', 'provider_state'].includes(state.blockType)) continue;
            for (const event of stopResponseBlock(state, sourceIndex)) yield event;
          }
          if (metadata.attachedProviderToken) metadata.finalizedProviderToken = metadata.attachedProviderToken;
        } else if (item.type === 'compaction') {
          yield* responseCompactionEvents(outputIndex, item, { close: true });
        } else if (rejectUnsupportedContent) {
          throw unsupportedStreamContent(`Responses 输出项：${item.type || 'unknown'}`);
        }
      }
      else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
        if (rejectUnsupportedContent) {
          if (!data.response || Array.isArray(data.response) || typeof data.response !== 'object') {
            throw invalidResponsesStream(`${data.type}.response 必须是对象`);
          }
          if (data.response.object !== undefined && data.response.object !== 'response') {
            throw invalidResponsesStream(`${data.type}.response.object 无效：${String(data.response.object)}`);
          }
          responsesUpstreamId = assertStableStreamIdentity(responsesUpstreamId, data.response.id, 'response.id', (message) => { throw invalidResponsesStream(message); });
          responsesUpstreamModel = assertStableStreamIdentity(responsesUpstreamModel, data.response.model, 'response.model', (message) => { throw invalidResponsesStream(message); });
          const expectedStatus = data.type === 'response.completed' ? 'completed' : 'incomplete';
          if (data.response?.status !== undefined && data.response.status !== expectedStatus) {
            throw invalidResponsesStream(`${data.type} 携带了不一致的 response.status=${String(data.response.status)}`);
          }
          if (data.response?.error !== undefined && data.response.error !== null) {
            throw invalidResponsesStream(`${data.type} 不能携带 error`);
          }
          if (expectedStatus === 'incomplete') {
            const reason = data.response?.incomplete_details?.reason;
            if (!responsesIncompleteReason(reason)) {
              throw invalidResponsesStream(`response.incomplete 的 incomplete_details.reason 无法跨协议转换：${String(reason || 'missing')}`);
            }
          }
        }
        for (const [outputIndex, item] of asArray(data.response?.output).entries()) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            if (rejectUnsupportedContent) throw unsupportedStreamContent(`Responses 终态 output[${outputIndex}]`);
            continue;
          }
          if (rejectUnsupportedContent) {
            assertPortableResponsesStreamItem(item, `终态 output[${outputIndex}]`, data.type === 'response.completed' ? 'completed' : 'incomplete');
          }
          rememberResponseOutputItem(outputIndex, item);
          if (item.type === 'web_search_call' && allowResponsesWebSearch) {
            validateResponsesWebSearchCall(item, `终态 output[${outputIndex}] web_search_call`);
            appendResponsesWebSearchQueries(responseWebSearchQueries, responseWebSearchQuerySet, item);
            continue;
          }
          if (item.type === 'message') {
            if (rejectUnsupportedContent) assertResponsesMessageContent(item.content);
            for (const [contentIndex, part] of asArray(item.content).entries()) {
              if (!['output_text', 'refusal'].includes(part?.type)) continue;
              const blockType = part.type === 'refusal' ? 'refusal' : 'text';
              const sourceIndex = responsesContentSourceIndex(outputIndex, contentIndex);
              const state = responseBlocks.get(sourceIndex) || responseBlockState(blockType, outputIndex, contentIndex, { streamKind: 'message' });
              if (state.blockType !== blockType) {
                throw invalidResponsesStream(`output[${outputIndex}].content[${contentIndex}] 类型从 ${state.blockType} 变为 ${blockType}`);
              }
              Object.assign(state, { id: item.id || state.id, streamKind: 'message' });
              if (blockType === 'text') mergeResponseAnnotations(state, part.annotations, `Responses completed.output[${outputIndex}].content[${contentIndex}].annotations`);
              rememberResponseBlock(sourceIndex, state);
              for (const event of startResponseBlock(state, sourceIndex)) yield event;
              const complete = part.text ?? part.refusal ?? '';
              const logprobs = blockType === 'text' && !state.emitted
                ? normalizeTokenLogprobs(part.logprobs, 'Responses completed output logprobs')
                : undefined;
              for (const event of completeResponseBlock(state, sourceIndex, complete, logprobs)) yield event;
            }
            continue;
          }
          if (item.type === 'function_call') {
            if (rejectUnsupportedContent && item.caller !== undefined) throw unsupportedStreamContent('Responses 程序调用 caller 关联');
            const sourceIndex = responsesItemSourceIndex(outputIndex);
            const state = responseBlocks.get(sourceIndex) || responseBlockState('tool', outputIndex, undefined, { streamKind: 'tool' });
            if (state.blockType !== 'tool') throw invalidResponsesStream(`output[${outputIndex}] 无法从 ${state.blockType} 变为 function_call`);
            Object.assign(state, { streamKind: 'tool', id: state.id || item.call_id || item.id, name: state.name || item.name });
            rememberResponseBlock(sourceIndex, state);
            for (const event of startResponseBlock(state, sourceIndex)) yield event;
            for (const event of completeResponseBlock(state, sourceIndex, item.arguments)) yield event;
            continue;
          }
          if (item.type === 'reasoning') {
            rememberResponseReasoningItem(outputIndex, item);
            for (const [summaryIndex, part] of asArray(item.summary).entries()) {
              if (part?.type !== 'summary_text') continue;
              const sourceIndex = responsesSummarySourceIndex(outputIndex, summaryIndex);
              if (!part.text && !responseBlocks.has(sourceIndex)) continue;
              const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_summary', item.id);
              for (const event of startResponseBlock(state, sourceIndex)) yield event;
              for (const event of completeResponseBlock(state, sourceIndex, part.text || '')) yield event;
            }
            for (const [contentIndex, part] of asArray(item.content).entries()) {
              if (part?.type !== 'reasoning_text') continue;
              const sourceIndex = responsesReasoningContentSourceIndex(outputIndex, contentIndex);
              if (!part.text && !responseBlocks.has(sourceIndex)) continue;
              const state = responseReasoningState(sourceIndex, outputIndex, 'reasoning_content', item.id);
              for (const event of startResponseBlock(state, sourceIndex)) yield event;
              for (const event of completeResponseBlock(state, sourceIndex, part.text || '')) yield event;
            }
            continue;
          }
          if (item.type === 'compaction') {
            yield* responseCompactionEvents(outputIndex, item);
            continue;
          }
          if (rejectUnsupportedContent) throw unsupportedStreamContent(`Responses 终态输出项：${item.type || 'unknown'}`);
        }
        for (const [outputIndex, metadata] of responseReasoningItems) {
          if (!metadata.providerState || metadata.finalizedProviderToken === metadata.providerToken) continue;
          const attachedState = metadata.attachedSourceIndex ? responseBlocks.get(metadata.attachedSourceIndex) : undefined;
          const reasoningEntry = attachedState && !attachedState.closed
            ? [metadata.attachedSourceIndex, attachedState]
            : openResponseReasoningBlock(outputIndex);
          if (reasoningEntry) {
            const [sourceIndex, state] = reasoningEntry;
            state.providerState = metadata.providerState;
            metadata.attachedSourceIndex = sourceIndex;
            metadata.attachedProviderToken = metadata.providerToken;
            yield { type: 'provider_state', sourceIndex, providerState: metadata.providerState };
            continue;
          }
          const sourceIndex = responsesProviderStateSourceIndex(outputIndex);
          const state = responseBlockState('provider_state', outputIndex, undefined, {
            streamKind: 'reasoning_provider', id: metadata.id, providerState: metadata.providerState
          });
          rememberResponseBlock(sourceIndex, state);
          metadata.attachedSourceIndex = sourceIndex;
          metadata.attachedProviderToken = metadata.providerToken;
          for (const event of startResponseBlock(state, sourceIndex)) yield event;
        }
        for (const [sourceIndex, state] of responseBlocks) {
          if (state.blockType === 'text') for (const event of emitResponseAnnotations(state, sourceIndex)) yield event;
          for (const event of stopResponseBlock(state, sourceIndex)) yield event;
        }
        for (const metadata of responseReasoningItems.values()) {
          if (metadata.attachedProviderToken) metadata.finalizedProviderToken = metadata.attachedProviderToken;
        }
        createdAt = Number.isSafeInteger(data.response?.created_at) ? data.response.created_at : createdAt;
        serviceTier = typeof data.response?.service_tier === 'string' ? data.response.service_tier : serviceTier;
        usageObserved ||= hasUsageData(data.response);
        const usage = data.response?.usage;
        if (usage) {
          inputTokens = normalizeUsageCount(usage.input_tokens, usage.prompt_tokens, inputTokens);
          cachedInputTokens = normalizeUsageCount(usage.cache_read_input_tokens, usage.prompt_cache_hit_tokens, usage.input_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens, cachedInputTokens);
          cacheCreationInputTokens = normalizeUsageCount(usage.cache_creation_input_tokens, usage.input_tokens_details?.cache_write_tokens, usage.input_tokens_details?.cache_creation_tokens, usage.prompt_tokens_details?.cache_write_tokens, usage.prompt_tokens_details?.cache_creation_tokens, cacheCreationInputTokens);
          reasoningTokens = normalizeUsageCount(usage.output_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens, reasoningTokens);
        }
        terminal = true;
        yield {
          type: 'done', stopReason: data.type === 'response.completed' ? 'end_turn' : (data.response?.incomplete_details?.reason || 'incomplete'), inputTokens,
          outputTokens: normalizeUsageCount(usage?.output_tokens, usage?.completion_tokens),
          cachedInputTokens, cacheCreationInputTokens, reasoningTokens, hasUsage: usageObserved,
          createdAt, serviceTier,
          ...(responseWebSearchQueries.length ? { webSearchQueries: responseWebSearchQueries } : {})
        };
      }
      else if (/^response\.web_search_call\.(?:in_progress|searching|completed|failed)$/.test(data.type)) {
        const outputIndex = responsesStreamIndex(data.output_index, 'output_index');
        if (typeof data.item_id !== 'string' || !data.item_id) throw invalidResponsesStream(`${data.type}.item_id 必须是非空字符串`);
        rememberResponseOutputItem(outputIndex, { id: data.item_id, type: 'web_search_call' }, rejectUnsupportedContent ? 'activity' : undefined);
        if (!allowResponsesWebSearch && rejectUnsupportedContent) {
          throw unsupportedStreamContent(`Responses 搜索事件：${data.type}`);
        }
      }
      else if (data.type === 'response.failed') {
        terminal = true;
        yield { type: 'error', error: data.response?.error || { message: 'Responses 上游生成失败' } };
        return;
      }
      continue;
    }

    if (protocol === 'gemini') {
      if (rejectUnsupportedContent && terminal) throw invalidGeminiStream('候选内容出现在终态事件之后');
      geminiUpstreamId = assertStableStreamIdentity(geminiUpstreamId, data.responseId, 'responseId', (message) => { throw invalidGeminiStream(message); });
      geminiUpstreamModel = assertStableStreamIdentity(geminiUpstreamModel, data.modelVersion, 'modelVersion', (message) => { throw invalidGeminiStream(message); });
      usageObserved ||= hasUsageData(data);
      inputTokens = normalizeUsageCount(data.usageMetadata?.promptTokenCount, inputTokens);
      cachedInputTokens = normalizeUsageCount(data.usageMetadata?.cachedContentTokenCount, cachedInputTokens);
      reasoningTokens = normalizeUsageCount(data.usageMetadata?.thoughtsTokenCount, reasoningTokens);
      geminiCandidateTokens = normalizeUsageCount(data.usageMetadata?.candidatesTokenCount, geminiCandidateTokens);
      if (!started) {
        started = true;
        id = geminiUpstreamId;
        model = geminiUpstreamModel || model;
        yield { type: 'start', id, model, inputTokens, cachedInputTokens };
      }
      if (data.candidates !== undefined && !Array.isArray(data.candidates)) throw invalidGeminiStream('candidates 必须是数组');
      if (rejectUnsupportedContent && data.candidates?.length > 1) {
        throw unsupportedStreamContent(` Gemini 流返回了 ${data.candidates.length} 个候选，跨协议只能保留一个候选`);
      }
      const candidate = data.candidates?.[0];
      if (!candidate) {
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
          if (geminiActiveBlock) {
            yield { type: 'block_stop', sourceIndex: geminiActiveBlock.sourceIndex };
            geminiActiveBlock = undefined;
          }
          terminal = true;
          yield {
            type: 'done', stopReason: blockReason, inputTokens,
            outputTokens: geminiCandidateTokens + reasoningTokens, cachedInputTokens, reasoningTokens,
            hasUsage: usageObserved
          };
          return;
        }
        continue;
      }
      if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') throw invalidGeminiStream('candidates[0] 必须是对象');
      if (rejectUnsupportedContent && candidate.index !== undefined && candidate.index !== 0) {
        throw invalidGeminiStream(`candidates[0].index=${String(candidate.index)}，跨协议只能保留 index=0`);
      }
      if (rejectUnsupportedContent && candidate.content?.role !== undefined && candidate.content.role !== 'model') {
        throw invalidGeminiStream(`candidates[0].content.role 无效：${String(candidate.content.role)}`);
      }
      if (candidate.finishReason !== undefined && !isPortableGeminiFinishReason(candidate.finishReason)) {
        throw invalidGeminiStream(`finishReason 无法跨协议转换：${String(candidate.finishReason)}`);
      }
      const parts = candidate.content?.parts;
      if (parts !== undefined && !Array.isArray(parts)) throw invalidGeminiStream('candidates[0].content.parts 必须是数组');
      if (candidate.groundingMetadata !== undefined) geminiGrounding = candidate.groundingMetadata;
      const logprobs = normalizeGeminiLogprobs(candidate);
      let logprobsAttached = false;
      for (const [partOffset, part] of asArray(parts).entries()) {
        if (!part || Array.isArray(part) || typeof part !== 'object') throw invalidGeminiStream(`part[${partOffset}] 必须是对象`);
        const signature = part.thoughtSignature ?? part.thought_signature;
        if (signature !== undefined && (typeof signature !== 'string' || !signature)) {
          throw invalidGeminiStream(`part[${partOffset}].thoughtSignature 必须是非空字符串`);
        }
        if (part.thought !== undefined && typeof part.thought !== 'boolean') throw invalidGeminiStream(`part[${partOffset}].thought 必须是布尔值`);
        const call = part.functionCall || part.function_call;
        const variants = [typeof part.text === 'string', Boolean(call)].filter(Boolean).length;
        if (variants !== 1) {
          throw unsupportedStreamContent(` Gemini 流式内容块：${Object.keys(part)[0] || 'unknown'}`);
        }
        const sourceIndex = `gemini:${geminiPartIndex++}`;
        const providerState = signature
          ? decodeReasoningState(signature) || { protocol: 'gemini', kind: 'part', value: part }
          : undefined;
        if (typeof part.text === 'string') {
          const blockType = part.thought === true ? 'reasoning' : 'text';
          if (geminiActiveBlock?.blockType !== blockType) {
            if (geminiActiveBlock) yield { type: 'block_stop', sourceIndex: geminiActiveBlock.sourceIndex };
            geminiActiveBlock = { sourceIndex, blockType };
            yield { type: 'block_start', sourceIndex, blockType, ...(providerState ? { providerState } : {}) };
          } else if (providerState) {
            yield { type: 'provider_state', sourceIndex: geminiActiveBlock.sourceIndex, providerState };
          }
          if (part.text) {
            const eventLogprobs = blockType === 'text' && !logprobsAttached && logprobs?.length ? logprobs : undefined;
            if (eventLogprobs) logprobsAttached = true;
            yield {
              type: blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta', sourceIndex: geminiActiveBlock.sourceIndex, delta: part.text,
              ...(eventLogprobs ? { logprobs: eventLogprobs } : {})
            };
            if (blockType === 'text') geminiText += part.text;
          }
          continue;
        }
        if (geminiActiveBlock) {
          yield { type: 'block_stop', sourceIndex: geminiActiveBlock.sourceIndex };
          geminiActiveBlock = undefined;
        }
        if (typeof call.name !== 'string' || !call.name) throw invalidGeminiStream(`part[${partOffset}].functionCall.name 必须是非空字符串`);
        if (call.id !== undefined && (typeof call.id !== 'string' || !call.id)) throw invalidGeminiStream(`part[${partOffset}].functionCall.id 必须是非空字符串`);
        if (call.args != null && (!call.args || Array.isArray(call.args) || typeof call.args !== 'object')) {
          throw invalidGeminiStream(`part[${partOffset}].functionCall.args 必须是对象`);
        }
        yield {
          type: 'block_start', sourceIndex, blockType: 'tool',
          id: call.id || `call_${randomUUID().replaceAll('-', '')}`, name: call.name,
          ...(providerState ? { providerState } : {})
        };
        yield { type: 'tool_delta', sourceIndex, delta: JSON.stringify(call.args || {}) };
        yield { type: 'block_stop', sourceIndex };
      }
      if (logprobs?.length && !logprobsAttached) throw invalidGeminiStream('logprobsResult 缺少对应文本 Part');
      if (candidate.finishReason) {
        const grounding = normalizeGeminiGroundingMetadata(
          geminiGrounding === undefined ? candidate : { groundingMetadata: geminiGrounding },
          { textLength: Array.from(geminiText).length }
        );
        if (grounding.annotations.length) {
          if (geminiActiveBlock?.blockType !== 'text') throw invalidGeminiStream('groundingMetadata 缺少对应文本块');
          yield { type: 'annotations', sourceIndex: geminiActiveBlock.sourceIndex, annotations: grounding.annotations };
        }
        if (geminiActiveBlock) {
          yield { type: 'block_stop', sourceIndex: geminiActiveBlock.sourceIndex };
          geminiActiveBlock = undefined;
        }
        terminal = true;
        yield {
          type: 'done', stopReason: candidate.finishReason, inputTokens,
          outputTokens: geminiCandidateTokens + reasoningTokens, cachedInputTokens, reasoningTokens,
          hasUsage: usageObserved,
          ...(grounding.webSearchQueries.length ? { webSearchQueries: grounding.webSearchQueries } : {})
        };
        return;
      }
      continue;
    }

    if (data.choices !== undefined && !Array.isArray(data.choices)) throw invalidChatStream('choices 必须是数组');
    if (rejectUnsupportedContent) {
      if (data.object !== undefined && data.object !== 'chat.completion.chunk') {
        throw invalidChatStream(`object 无效：${String(data.object)}`);
      }
      chatUpstreamId = assertStableStreamIdentity(chatUpstreamId, data.id, 'id', (message) => { throw invalidChatStream(message); });
      chatUpstreamModel = assertStableStreamIdentity(chatUpstreamModel, data.model, 'model', (message) => { throw invalidChatStream(message); });
    }
    if (rejectUnsupportedContent && data.choices?.length > 1) {
      throw unsupportedStreamContent(` Chat 流返回了 ${data.choices.length} 个候选，跨协议只能保留一个候选`);
    }
    const choice = data.choices?.[0];
    if (choice !== undefined) {
      if (!choice || Array.isArray(choice) || typeof choice !== 'object') throw invalidChatStream('choices[0] 必须是对象');
      if (rejectUnsupportedContent && choice.index !== undefined && choice.index !== 0) {
        throw unsupportedStreamContent(` Chat 流候选 index=${String(choice.index)}，跨协议只能保留 index=0`);
      }
      if (choice.delta !== undefined && (!choice.delta || Array.isArray(choice.delta) || typeof choice.delta !== 'object')) {
        throw invalidChatStream('choices[0].delta 必须是对象');
      }
      if (rejectUnsupportedContent && choice.delta?.role !== undefined && choice.delta.role !== 'assistant') {
        throw invalidChatStream(`choices[0].delta.role 无效：${String(choice.delta.role)}`);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== 'string') {
        throw invalidChatStream('choices[0].finish_reason 必须是字符串或 null');
      }
      if (rejectUnsupportedContent && choice.finish_reason != null && !isPortableChatFinishReason(choice.finish_reason)) {
        throw invalidChatStream(`choices[0].finish_reason 无法跨协议转换：${String(choice.finish_reason)}`);
      }
      if (rejectUnsupportedContent && chatBlocksClosed) {
        throw invalidChatStream('choices[0] 出现在终止 finish_reason 之后');
      }
    }
    createdAt = Number.isSafeInteger(data.created) ? data.created : createdAt;
    serviceTier = typeof data.service_tier === 'string' ? data.service_tier : serviceTier;
    systemFingerprint = typeof data.system_fingerprint === 'string' ? data.system_fingerprint : systemFingerprint;
    if (data.usage) {
      usageObserved ||= hasUsageData(data);
      inputTokens = normalizeUsageCount(data.usage.prompt_tokens, data.usage.input_tokens, inputTokens);
      chatOutputTokens = normalizeUsageCount(data.usage.completion_tokens, data.usage.output_tokens, chatOutputTokens);
      cachedInputTokens = normalizeUsageCount(data.usage.cache_read_input_tokens, data.usage.prompt_cache_hit_tokens, data.usage.prompt_tokens_details?.cached_tokens, cachedInputTokens);
      cacheCreationInputTokens = normalizeUsageCount(data.usage.cache_creation_input_tokens, data.usage.prompt_tokens_details?.cache_write_tokens, data.usage.prompt_tokens_details?.cache_creation_tokens, cacheCreationInputTokens);
      reasoningTokens = normalizeUsageCount(data.usage.completion_tokens_details?.reasoning_tokens, reasoningTokens);
    }
    if (!started) {
      started = true; id = data.id; model = data.model || model;
      inputTokens = normalizeUsageCount(data.usage?.prompt_tokens, data.usage?.input_tokens, inputTokens);
      cachedInputTokens = normalizeUsageCount(data.usage?.cache_read_input_tokens, data.usage?.prompt_cache_hit_tokens, data.usage?.prompt_tokens_details?.cached_tokens, cachedInputTokens);
      cacheCreationInputTokens = normalizeUsageCount(data.usage?.cache_creation_input_tokens, data.usage?.prompt_tokens_details?.cache_write_tokens, data.usage?.prompt_tokens_details?.cache_creation_tokens, cacheCreationInputTokens);
      yield { type: 'start', id, model, createdAt, serviceTier, systemFingerprint, inputTokens, cachedInputTokens, cacheCreationInputTokens };
    }
    for (const field of ['reasoning_content', 'reasoning', 'refusal']) {
      if (choice?.delta?.[field] !== undefined && choice.delta[field] !== null && typeof choice.delta[field] !== 'string') {
        throw invalidChatStream(`choices[0].delta.${field} 必须是字符串或 null`);
      }
    }
    const reasoningDelta = choice?.delta?.reasoning_content || choice?.delta?.reasoning;
    if (choice?.delta?.reasoning_details !== undefined && !Array.isArray(choice.delta.reasoning_details)) {
      throw invalidChatStream('choices[0].delta.reasoning_details 必须是数组');
    }
    for (const detail of asArray(choice?.delta?.reasoning_details)) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw invalidChatStream('reasoning_details 只能包含对象');
      const key = detail.index ?? detail.id ?? chatReasoningDetails.size;
      const previous = chatReasoningDetails.get(key);
      chatReasoningDetails.set(key, previous ? {
        ...previous, ...detail,
        ...(typeof detail.text === 'string' ? { text: `${previous.text || ''}${detail.text}` } : {}),
        ...(typeof detail.summary === 'string' ? { summary: `${previous.summary || ''}${detail.summary}` } : {})
      } : { ...detail });
    }
    const contentDeltas = chatStreamContentDeltas(choice?.delta?.content, rejectUnsupportedContent);
    const contentDelta = contentDeltas.text;
    const refusalDelta = contentDeltas.refusal + (choice?.delta?.refusal || '');
    if (reasoningDelta && !chatReasoningStarted) {
      chatReasoningStarted = true;
      yield { type: 'block_start', sourceIndex: 'reasoning', blockType: 'reasoning' };
    }
    if (reasoningDelta) yield { type: 'reasoning_delta', sourceIndex: 'reasoning', delta: reasoningDelta };
    if (contentDelta && !chatTextStarted) {
      chatTextStarted = true;
      yield { type: 'block_start', sourceIndex: 'text', blockType: 'text' };
    }
    if (contentDelta) {
      const logprobs = normalizeTokenLogprobs(choice?.logprobs?.content, 'Chat 流式 logprobs');
      yield { type: 'text_delta', sourceIndex: 'text', delta: contentDelta, ...(logprobs?.length ? { logprobs } : {}) };
    }
    if (refusalDelta && !chatRefusalStarted) {
      chatRefusalStarted = true;
      yield { type: 'block_start', sourceIndex: 'refusal', blockType: 'refusal' };
    }
    if (refusalDelta) yield { type: 'text_delta', sourceIndex: 'refusal', delta: refusalDelta };
    const streamToolCalls = choice?.delta?.tool_calls;
    if (streamToolCalls !== undefined && !Array.isArray(streamToolCalls)) throw invalidChatStream('choices[0].delta.tool_calls 必须是数组');
    let toolDeltas = streamToolCalls || [];
    if (choice?.delta?.function_call !== undefined) {
      const legacy = choice.delta.function_call;
      if (!legacy || Array.isArray(legacy) || typeof legacy !== 'object') throw invalidChatStream('choices[0].delta.function_call 必须是对象');
      toolDeltas = [...toolDeltas, { index: 0, id: legacy.id, function: legacy }];
    }
    for (const [toolDeltaIndex, call] of toolDeltas.entries()) {
      if (!call || Array.isArray(call) || typeof call !== 'object') throw invalidChatStream(`tool_calls[${toolDeltaIndex}] 必须是对象`);
      if (call.index !== undefined && (!Number.isSafeInteger(call.index) || call.index < 0)) throw invalidChatStream(`tool_calls[${toolDeltaIndex}].index 必须是非负安全整数`);
      if (call.id !== undefined && (typeof call.id !== 'string' || !call.id)) throw invalidChatStream(`tool_calls[${toolDeltaIndex}].id 必须是非空字符串`);
      if (call.type !== undefined && call.type !== 'function') throw unsupportedStreamContent(` Chat 流工具调用类型：${call.type}`);
      if (call.function !== undefined && (!call.function || Array.isArray(call.function) || typeof call.function !== 'object')) throw invalidChatStream(`tool_calls[${toolDeltaIndex}].function 必须是对象`);
      if (call.function?.name !== undefined && (typeof call.function.name !== 'string' || !call.function.name)) throw invalidChatStream(`tool_calls[${toolDeltaIndex}].function.name 必须是非空字符串`);
      if (call.function?.arguments !== undefined && typeof call.function.arguments !== 'string') throw invalidChatStream(`tool_calls[${toolDeltaIndex}].function.arguments 必须是字符串`);
      const sourceIndex = `tool-${call.index ?? 0}`;
      const argumentsDelta = call.function?.arguments || '';
      let state = chatTools.get(sourceIndex);
      if (!state && !call.id && !call.function?.name && !argumentsDelta) continue;
      if (!state) {
        state = { id: '', name: '', pending: '', started: false };
        chatTools.set(sourceIndex, state);
      }
      if (call.id) state.id = call.id;
      if (call.function?.name) state.name = call.function.name;
      if (call.id || call.function?.name || argumentsDelta) chatHasTools = true;
      if (!state.started && argumentsDelta) state.pending += argumentsDelta;
      if (!state.started && state.id && state.name) {
        state.started = true;
        yield { type: 'block_start', sourceIndex, blockType: 'tool', id: state.id, name: state.name };
        if (state.pending) {
          yield { type: 'tool_delta', sourceIndex, delta: state.pending };
          state.pending = '';
        }
      } else if (state.started && argumentsDelta) {
        yield { type: 'tool_delta', sourceIndex, delta: argumentsDelta };
      }
    }
    if (choice?.finish_reason && !chatBlocksClosed) {
      if (rejectUnsupportedContent) {
        if (['tool_calls', 'function_call'].includes(choice.finish_reason) && !chatHasTools) {
          throw invalidChatStream(`finish_reason=${choice.finish_reason}，但流中没有工具调用`);
        }
        if (chatHasTools && choice.finish_reason === 'stop') {
          throw invalidChatStream('流中包含工具调用，但 finish_reason=stop');
        }
      }
      if (chatReasoningDetails.size) {
        const bridgeStates = [];
        const bridgeStateKeys = new Set();
        const externalDetails = [];
        for (const detail of chatReasoningDetails.values()) {
          const encoded = detail?.data ?? detail?.signature;
          const state = decodeReasoningState(encoded);
          if (state) {
            const key = JSON.stringify([state.protocol, state.kind, state.value]);
            if (!bridgeStateKeys.has(key)) {
              bridgeStateKeys.add(key);
              bridgeStates.push(state);
            }
          } else externalDetails.push(detail);
        }
        let attachedToReasoning = false;
        for (const [index, providerState] of bridgeStates.entries()) {
          if (chatReasoningStarted && !attachedToReasoning) {
            yield { type: 'provider_state', sourceIndex: 'reasoning', providerState };
            attachedToReasoning = true;
          } else {
            const sourceIndex = `reasoning-details-bridge-${index}`;
            yield { type: 'block_start', sourceIndex, blockType: 'provider_state', providerState };
            yield { type: 'block_stop', sourceIndex };
          }
        }
        if (externalDetails.length) {
          const providerState = { protocol: 'chat', kind: 'reasoning_details', value: { details: externalDetails } };
          if (chatReasoningStarted && !attachedToReasoning) yield { type: 'provider_state', sourceIndex: 'reasoning', providerState };
          else {
            yield { type: 'block_start', sourceIndex: 'reasoning-details', blockType: 'provider_state', providerState };
            yield { type: 'block_stop', sourceIndex: 'reasoning-details' };
          }
        }
      }
      if (chatReasoningStarted) yield { type: 'block_stop', sourceIndex: 'reasoning' };
      if (chatTextStarted) yield { type: 'block_stop', sourceIndex: 'text' };
      if (chatRefusalStarted) yield { type: 'block_stop', sourceIndex: 'refusal' };
      for (const [sourceIndex, state] of chatTools) {
        if (!state.started && (state.id || state.name || state.pending)) {
          state.started = true;
          yield { type: 'block_start', sourceIndex, blockType: 'tool', id: state.id || `call_${randomUUID().replaceAll('-', '')}`, name: state.name || 'unknown_tool' };
          if (state.pending) yield { type: 'tool_delta', sourceIndex, delta: state.pending };
        }
        if (state.started) yield { type: 'block_stop', sourceIndex };
      }
      chatBlocksClosed = true;
      chatFinishReason = choice.finish_reason;
    }
    if (chatFinishReason && data.usage) {
      terminal = true;
      yield {
        type: 'done', stopReason: chatFinishReason, inputTokens, outputTokens: chatOutputTokens,
        cachedInputTokens, cacheCreationInputTokens, reasoningTokens, hasUsage: usageObserved,
        createdAt, serviceTier, systemFingerprint
      };
      chatFinishReason = undefined;
    }
  }
  if (protocol === 'claude' && started && !terminal && claudeMessageDeltaSeen) {
    assertPortableClaudeTerminalState();
    yield* closeClaudeOpenBlocks();
    terminal = true;
    yield { type: 'done', stopReason: claudeStopReason, outputTokens: claudeOutputTokens, inputTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens, hasUsage: usageObserved };
  }
  if (protocol === 'chat' && chatFinishReason) {
    terminal = true;
    yield { type: 'done', stopReason: chatFinishReason, inputTokens, outputTokens: chatOutputTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens, hasUsage: usageObserved, createdAt, serviceTier, systemFingerprint };
  }
  if (started && !terminal) yield { type: 'error', error: { type: 'upstream_error', message: '上游 SSE 在完成事件前结束' } };
}

export function chatStreamContentDeltas(content, rejectUnsupportedContent = false) {
  if (content === undefined || content === null) return { text: '', refusal: '' };
  if (typeof content === 'string') return { text: content, refusal: '' };
  if (!Array.isArray(content)) throw invalidChatStream('choices[0].delta.content 必须是字符串、数组或 null');

  if (rejectUnsupportedContent) {
    const unsupported = [];
    for (const part of content) {
      if (!part || Array.isArray(part) || typeof part !== 'object' || !['text', 'output_text', 'refusal'].includes(part.type)) {
        unsupported.push(part?.type || 'unknown');
      }
    }
    if (unsupported.length) throw Object.assign(new Error(`跨协议转换无法表达 Chat 流式内容块：${unsupported.join(', ')}`), { code: 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' });
  }

  const text = [];
  const refusal = [];
  for (const [index, part] of content.entries()) {
    if (['text', 'output_text'].includes(part?.type)) {
      if (typeof part.text !== 'string') throw invalidChatStream(`choices[0].delta.content[${index}].text 必须是字符串`);
      text.push(part.text || part.refusal || '');
    } else if (part?.type === 'refusal') {
      if (typeof part.refusal !== 'string') throw invalidChatStream(`choices[0].delta.content[${index}].refusal 必须是字符串`);
      refusal.push(part.text || part.refusal || '');
    }
  }
  return { text: text.join(''), refusal: refusal.join('') };
}

function unsupportedStreamContent(label) {
  return Object.assign(new Error(`跨协议转换无法表达${label}`), { code: 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' });
}

function assertResponsesMessageContent(content, label = 'Responses 流式消息 content') {
  if (content === undefined || content === null) return;
  if (!Array.isArray(content)) throw invalidResponsesStream(`${label} 必须是数组`);
  for (const [index, part] of content.entries()) {
    const partLabel = `${label}[${index}]`;
    if (!part || Array.isArray(part) || typeof part !== 'object') throw invalidResponsesStream(`${partLabel} 必须是对象`);
    if (!['output_text', 'refusal'].includes(part.type)) {
      throw unsupportedStreamContent(` Responses 流式消息内容块：${part.type || 'unknown'}`);
    }
    const field = part.type === 'refusal' ? 'refusal' : 'text';
    if (typeof part[field] !== 'string') throw invalidResponsesStream(`${partLabel}.${field} 必须是字符串`);
  }
}

function assertPortableResponsesStreamItem(item, label, phase) {
  if (!item || Array.isArray(item) || typeof item !== 'object') throw invalidResponsesStream(`${label} 必须是对象`);
  assertOptionalStreamIdentity(item.id, `${label}.id`, (message) => { throw invalidResponsesStream(message); });
  if (typeof item.type !== 'string' || !item.type) throw invalidResponsesStream(`${label}.type 必须是非空字符串`);
  if (item.type === 'message' && item.role !== undefined && item.role !== 'assistant') {
    throw invalidResponsesStream(`${label}.role 无效：${String(item.role)}`);
  }
  if (item.type === 'message') assertResponsesMessageContent(item.content, `${label}.content`);
  if (item.type === 'function_call') {
    assertOptionalStreamIdentity(item.call_id, `${label}.call_id`, (message) => { throw invalidResponsesStream(message); });
    if (typeof item.name !== 'string' || !item.name) throw invalidResponsesStream(`${label}.name 必须是非空字符串`);
    if (typeof item.arguments !== 'string') throw invalidResponsesStream(`${label}.arguments 必须是字符串`);
  }
  if (item.type === 'reasoning') {
    assertResponsesReasoningParts(item.summary, `${label}.summary`, 'summary_text');
    assertResponsesReasoningParts(item.content, `${label}.content`, 'reasoning_text');
    if (item.encrypted_content !== undefined && item.encrypted_content !== null
      && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
      throw invalidResponsesStream(`${label}.encrypted_content 必须是非空字符串或 null`);
    }
  }
  if (item.type === 'compaction') {
    const unsupported = Object.keys(item).filter((key) => !['type', 'id', 'encrypted_content', 'created_by'].includes(key));
    if (unsupported.length) throw invalidResponsesStream(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
    if (typeof item.id !== 'string' || !item.id) throw invalidResponsesStream(`${label}.id 必须是非空字符串`);
    const pending = phase === 'added' && (item.encrypted_content === undefined || item.encrypted_content === null);
    if (!pending && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
      throw invalidResponsesStream(`${label}.encrypted_content 必须是非空字符串`);
    }
    if (item.created_by !== undefined && (typeof item.created_by !== 'string' || !item.created_by)) {
      throw invalidResponsesStream(`${label}.created_by 必须是非空字符串`);
    }
  }
  if (!['message', 'function_call', 'reasoning'].includes(item.type) || item.status === undefined) return;
  if (!['in_progress', 'completed', 'incomplete'].includes(item.status)) {
    throw invalidResponsesStream(`${label}.status 无效：${String(item.status)}`);
  }
  const allowed = phase === 'added'
    ? new Set(['in_progress'])
    : phase === 'completed'
      ? new Set(['completed'])
      : new Set(['completed', 'incomplete']);
  if (!allowed.has(item.status)) {
    throw invalidResponsesStream(`${label}.status=${item.status} 与 ${phase} 终态不一致`);
  }
}

function assertResponsesReasoningParts(parts, label, expectedType) {
  if (parts === undefined || parts === null) return;
  if (!Array.isArray(parts)) throw invalidResponsesStream(`${label} 必须是数组`);
  for (const [index, part] of parts.entries()) {
    if (!part || Array.isArray(part) || typeof part !== 'object') throw invalidResponsesStream(`${label}[${index}] 必须是对象`);
    if (part.type !== expectedType) throw unsupportedStreamContent(` Responses ${label}[${index}]：${part.type || 'unknown'}`);
    if (typeof part.text !== 'string') throw invalidResponsesStream(`${label}[${index}].text 必须是字符串`);
  }
}

function assertResponsesReasoningSummaryPart(part, label) {
  if (!part || Array.isArray(part) || typeof part !== 'object') throw invalidResponsesStream(`${label}.part 必须是对象`);
  if (part.type !== 'summary_text') throw unsupportedStreamContent(` Responses reasoning summary part：${part.type || 'unknown'}`);
  if (typeof part.text !== 'string') throw invalidResponsesStream(`${label}.part.text 必须是字符串`);
}

function assertResponsesStreamContentPart(part, label) {
  if (!part || Array.isArray(part) || typeof part !== 'object') throw invalidResponsesStream(`${label}.part 必须是对象`);
  if (!['output_text', 'refusal', 'reasoning_text'].includes(part.type)) {
    throw unsupportedStreamContent(` Responses 流式内容块：${part.type || 'unknown'}`);
  }
  const field = part.type === 'refusal' ? 'refusal' : 'text';
  if (typeof part[field] !== 'string') throw invalidResponsesStream(`${label}.part.${field} 必须是字符串`);
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function withStreamObfuscation(data, enabled) {
  if (!enabled) return data;
  const empty = { ...data, obfuscation: '' };
  const byteLength = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const paddingLength = 256 - (byteLength % 256);
  const obfuscation = randomBytes(Math.ceil(paddingLength / 2)).toString('hex').slice(0, paddingLength);
  return { ...data, obfuscation };
}

function chatSse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function geminiSse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function* streamClaudeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('Claude 流式消息必须是对象');
  const content = Array.isArray(message.content) ? message.content : [];
  const usage = message.usage && typeof message.usage === 'object' && !Array.isArray(message.usage) ? message.usage : {};
  const inputTokens = Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 ? usage.input_tokens : 0;
  const outputTokens = Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 ? usage.output_tokens : 0;
  yield sse('message_start', {
    type: 'message_start',
    message: {
      id: typeof message.id === 'string' && message.id ? message.id : `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        ...(usage.cache_read_input_tokens ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
        ...(usage.speed ? { speed: usage.speed } : {})
      }
    }
  });
  for (const [index, block] of content.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new TypeError(`Claude content[${index}] 必须是对象`);
    if (block.type === 'text') {
      yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (typeof block.text === 'string' && block.text) {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      }
    } else if (block.type === 'thinking') {
      yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (typeof block.thinking === 'string' && block.thinking) {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      }
      yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature || 'bridge' } });
    } else if (block.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
      yield sse('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: block.id || `call_${randomUUID().replaceAll('-', '')}`, name: block.name || 'unknown', input: {} }
      });
      const argumentsText = JSON.stringify(input);
      if (argumentsText && argumentsText !== '{}') {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argumentsText } });
      }
    } else if (block.type === 'redacted_thinking') {
      yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data || 'bridge' } });
    } else {
      throw new TypeError(`本地 Web Search 无法流式编码 Claude content 类型：${String(block.type || 'unknown')}`);
    }
    yield sse('content_block_stop', { type: 'content_block_stop', index });
  }
  yield sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: message.stop_sequence ?? null },
    usage: {
      output_tokens: outputTokens,
      ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {})
    }
  });
  yield sse('message_stop', { type: 'message_stop' });
}

function blockToolArguments(block) {
  let parsed;
  try { parsed = parsedToolArguments(block.arguments, 'tool'); }
  catch (error) {
    if (error?.code === 'UPSTREAM_JSON_TOO_COMPLEX') throw error;
    throw Object.assign(new Error(`上游工具 ${block.name || 'unknown'} 返回了无效 JSON 参数`), { code: 'UPSTREAM_INVALID_TOOL_ARGUMENTS' });
  }
  if (block.name === 'Read' && parsed.pages === '') delete parsed.pages;
  return parsed;
}

function geminiJsonPath(path) {
  return path.reduce((result, segment) => {
    if (Number.isInteger(segment)) return `${result}[${segment}]`;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
      ? `${result}.${segment}`
      : `${result}[${JSON.stringify(segment)}]`;
  }, '$');
}

function tryGeminiPartialArguments(argumentsText) {
  const text = String(argumentsText || '').trim();
  if (!text.endsWith('}')) return undefined;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return undefined; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw Object.assign(new Error('上游工具返回了非对象 JSON 参数'), { code: 'UPSTREAM_INVALID_TOOL_ARGUMENTS' });
  }
  assertJsonComplexity(parsed, { label: '上游工具 JSON 参数', code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  const partialArgs = [];
  const append = (value, path, root = false) => {
    if (Array.isArray(value)) {
      if (!value.length && !root) return false;
      return value.every((item, index) => append(item, [...path, index]));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length && !root) return false;
      return entries.every(([key, item]) => append(item, [...path, key]));
    }
    const partial = { jsonPath: geminiJsonPath(path) };
    if (value === null) partial.nullValue = null;
    else if (typeof value === 'string') partial.stringValue = value;
    else if (typeof value === 'number') partial.numberValue = value;
    else if (typeof value === 'boolean') partial.boolValue = value;
    else return false;
    partialArgs.push(partial);
    return true;
  };
  return append(parsed, [], true) ? partialArgs : null;
}

function parsedToolArguments(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error(`上游 ${label} 返回了无效 JSON 对象参数`), { code: 'UPSTREAM_INVALID_TOOL_ARGUMENTS' });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw Object.assign(new Error(`上游 ${label} 返回了无效 JSON 对象参数`), { code: 'UPSTREAM_INVALID_TOOL_ARGUMENTS' });
  }
  assertJsonComplexity(parsed, { label: `上游 ${label} JSON 参数`, code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  return parsed;
}

function customToolInput(argumentsText) {
  const parsed = parsedToolArguments(argumentsText, 'custom tool');
  if (typeof parsed.input !== 'string') throw Object.assign(new Error('上游 custom tool 缺少字符串 input 参数'), { code: 'UPSTREAM_INVALID_TOOL_ARGUMENTS' });
  return parsed.input;
}

export function summarizeStreamBlocks(blocks, {
  collectReasoningState = false, collectOutput = false, collectGrounding = false
} = {}) {
  const toolCalls = collectReasoningState ? [] : undefined;
  const providerStates = collectReasoningState ? [] : undefined;
  const output = collectOutput ? [] : undefined;
  const groundingParts = collectGrounding ? [] : undefined;
  let hasTools = false;
  let hasRefusal = false;
  let hasUrlCitations = false;
  for (const block of blocks.values()) {
    if (block.type === 'tool') {
      hasTools = true;
      if (toolCalls) toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
    } else if (block.type === 'refusal') hasRefusal = true;
    if (providerStates && block.providerState) providerStates.push(block.providerState);
    if (output && block.item) output.push(block.item);
    if (groundingParts && block.type === 'text') {
      groundingParts.push({ type: block.type, text: block.text, annotations: block.annotations });
      if (!hasUrlCitations) {
        hasUrlCitations = asArray(block.annotations).some((annotation) => annotation?.type === 'url_citation');
      }
    }
  }
  return { hasTools, hasRefusal, hasUrlCitations, toolCalls, providerStates, output, groundingParts };
}

export async function* translateSse(response, sourceProtocol, targetProtocol, fallbackModel, options = {}) {
  const id = targetProtocol === 'claude' ? `msg_${randomUUID().replaceAll('-', '')}`
    : targetProtocol === 'responses' ? `resp_${randomUUID().replaceAll('-', '')}`
      : targetProtocol === 'gemini' ? `gemini-${randomUUID()}`
        : `chatcmpl-${randomUUID()}`;
  let responseId = id;
  let model = fallbackModel;
  let createdAt = Math.floor(Date.now() / 1000);
  let serviceTier;
  let speed;
  let systemFingerprint;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheCreation5mInputTokens = 0;
  let cacheCreation1hInputTokens = 0;
  let reasoningTokens = 0;
  let webSearchQueries = [];
  let targetIndex = 0;
  let chatToolIndex = 0;
  const indices = new Map();
  const blocks = new Map();
  const pendingGeminiProviderStates = [];
  let responseStarted = false;
  let responseSequenceNumber = 0;
  const responseTools = Array.isArray(options.responsesOptions?.tools) ? options.responsesOptions.tools : [];
  let resolveResponseToolIdentity;
  const responseToolIdentity = (name) => {
    resolveResponseToolIdentity ||= createResponsesToolIdentityResolver(responseTools);
    return resolveResponseToolIdentity(name);
  };
  const restoreGeminiToolName = createGeminiToolNameRestorer(options.responsesOptions?.geminiToolAliases);
  const responseConfig = responsesResponseConfig(options.responsesOptions);
  const responseIncludeObfuscation = options.responsesOptions?.includeObfuscation !== false;
  const chatIncludeUsage = options.chatOptions?.includeUsage === true;
  const chatIncludeObfuscation = options.chatOptions?.includeObfuscation !== false;
  const responsesMetadata = () => serviceTier ? { service_tier: serviceTier } : {};
  const chatMetadata = () => ({
    ...responsesMetadata(),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {})
  });
  const responseSse = (event, data) => {
    const sequenceNumber = responseSequenceNumber++;
    options.onResponsesSequenceNumber?.(responseSequenceNumber);
    const payload = { ...data, sequence_number: sequenceNumber };
    return sse(event, event.endsWith('.delta') ? withStreamObfuscation(payload, responseIncludeObfuscation) : payload);
  };
  const chatChunk = (data) => {
    const payload = chatIncludeUsage && Array.isArray(data.choices) && data.choices.length
      ? { ...data, usage: null }
      : data;
    return chatSse(
      payload.choices.some((choice) => choice?.delta)
        ? withStreamObfuscation(payload, chatIncludeObfuscation)
        : payload
    );
  };
  const geminiChunk = (data) => geminiSse({
    ...data,
    modelVersion: model,
    responseId
  });

  for await (const event of canonicalEvents(response, sourceProtocol, fallbackModel, {
    rejectUnsupportedContent: sourceProtocol !== targetProtocol,
    allowResponsesWebSearch: options.allowResponsesWebSearch === true,
    onSseData: sourceProtocol === targetProtocol ? undefined : (data) => {
      const degradations = responseMetadataDegradations(data, sourceProtocol, targetProtocol);
      if (degradations.length) options.onResponseDegradations?.(degradations);
    }
  })) {
    if (event.type === 'error') {
      const streamError = options.normalizeError ? options.normalizeError(event.error) : event.error;
      options.onError?.(streamError);
      if (targetProtocol === 'chat') {
        yield chatSse({ error: streamError });
        yield 'data: [DONE]\n\n';
      } else if (targetProtocol === 'responses') {
        const message = streamError?.message || String(streamError || '上游流式响应失败');
        const code = streamError?.code || streamError?.type || 'upstream_error';
        yield responseSse('error', { type: 'error', code, message, param: streamError?.param ?? null });
      } else if (targetProtocol === 'gemini') {
        yield geminiSse({ error: { code: 502, message: streamError?.message || String(streamError || '上游流式响应失败'), status: 'INTERNAL' } });
      } else yield sse('error', { type: 'error', error: streamError });
      return;
    }
    if (event.type === 'start') {
      responseStarted = true;
      responseId = event.id || responseId; model = event.model || model;
      createdAt = Number.isSafeInteger(event.createdAt) ? event.createdAt : createdAt;
      serviceTier = event.serviceTier || openAiServiceTierForClaudeSpeed(event.speed) || serviceTier;
      speed = event.speed || claudeSpeedForOpenAiServiceTier(event.serviceTier) || speed;
      systemFingerprint = event.systemFingerprint || systemFingerprint;
      inputTokens = event.inputTokens || 0; cachedInputTokens = event.cachedInputTokens || 0; cacheCreationInputTokens = event.cacheCreationInputTokens || 0;
      cacheCreation5mInputTokens = event.cacheCreation5mInputTokens || 0; cacheCreation1hInputTokens = event.cacheCreation1hInputTokens || 0;
      if (targetProtocol === 'claude') yield sse('message_start', { type: 'message_start', message: { id: responseId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, ...(cachedInputTokens ? { cache_read_input_tokens: cachedInputTokens } : {}), ...(cacheCreationInputTokens ? { cache_creation_input_tokens: cacheCreationInputTokens } : {}), ...(speed ? { speed } : {}) } } });
      else if (targetProtocol === 'responses') yield responseSse('response.created', { type: 'response.created', response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model, ...responsesMetadata(), ...responseConfig, output: [], usage: null } });
      else if (targetProtocol !== 'gemini') yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      continue;
    }
    if (!responseStarted) continue;
    if (event.type === 'model_update') {
      model = event.model || model;
      continue;
    }
    if (event.type === 'block_start') {
      const index = targetIndex++;
      indices.set(event.sourceIndex, index);
      const toolIdentity = event.blockType === 'tool' && targetProtocol === 'responses'
        ? responseToolIdentity(event.name || '')
        : { name: targetProtocol === 'gemini'
          ? restoreGeminiToolName(event.name || '')
          : event.name || '' };
      blocks.set(index, {
        type: event.blockType, id: event.id || `call_${randomUUID().replaceAll('-', '')}`, ...toolIdentity,
        text: '', arguments: '', logprobs: [], annotations: [],
        ...(event.providerState ? { providerState: event.providerState } : {}),
        ...(event.blockType === 'tool' ? { chatToolIndex: chatToolIndex++, geminiPartialArgsEmitted: false, geminiPartialParseAttempts: 0 } : {})
      });
      if (targetProtocol === 'claude') {
        const content_block = event.blockType === 'tool' ? { type: 'tool_use', id: blocks.get(index).id, name: blocks.get(index).name, input: {} }
          : event.blockType === 'reasoning' ? { type: 'thinking', thinking: '', signature: '' }
            : event.blockType === 'provider_state' ? { type: 'redacted_thinking', data: encodeReasoningState(event.providerState.protocol, event.providerState.kind, event.providerState.value) }
            : { type: 'text', text: '' };
        yield sse('content_block_start', { type: 'content_block_start', index, content_block });
      } else if (targetProtocol === 'responses') {
        const block = blocks.get(index);
        const responseCompaction = event.blockType === 'provider_state'
          && event.providerState?.protocol === 'responses'
          && event.providerState.kind === 'compaction'
          ? event.providerState.value
          : undefined;
        const item = responseCompaction
          || (event.blockType === 'tool' && block.kind === 'custom'
          ? { id: `ctc_${randomUUID().replaceAll('-', '')}`, type: 'custom_tool_call', status: 'in_progress', call_id: block.id, name: block.name, input: '' }
          : event.blockType === 'tool' && block.kind === 'tool_search'
            ? { id: `tsc_${randomUUID().replaceAll('-', '')}`, type: 'tool_search_call', status: 'in_progress', execution: 'client', call_id: block.id, arguments: {} }
            : event.blockType === 'tool'
              ? { id: `fc_${randomUUID().replaceAll('-', '')}`, type: 'function_call', status: 'in_progress', call_id: block.id, ...(block.namespace ? { namespace: block.namespace } : {}), name: block.name, arguments: '' }
          : event.blockType === 'reasoning'
            ? { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', status: 'in_progress', summary: [] }
            : event.blockType === 'provider_state'
              ? { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', status: 'in_progress', summary: [] }
            : { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] });
        blocks.get(index).item = item;
        yield responseSse('response.output_item.added', { type: 'response.output_item.added', output_index: index, item });
        if (event.blockType === 'text') yield responseSse('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        if (event.blockType === 'refusal') yield responseSse('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'refusal', refusal: '' } });
        if (event.blockType === 'reasoning') yield responseSse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      } else if (targetProtocol === 'chat' && event.blockType === 'tool') {
        const block = blocks.get(index);
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { tool_calls: [{ index: block.chatToolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'provider_state') {
      const index = indices.get(event.sourceIndex);
      if (index !== undefined) blocks.get(index).providerState = event.providerState;
      continue;
    }
    if (event.type === 'annotations') {
      const index = indices.get(event.sourceIndex);
      if (index === undefined) continue;
      const block = blocks.get(index);
      block.annotations = event.annotations;
      if (targetProtocol === 'responses') {
        for (const [annotationIndex, annotation] of event.annotations.entries()) {
          yield responseSse('response.output_text.annotation.added', {
            type: 'response.output_text.annotation.added', item_id: block.item.id, output_index: index,
            content_index: 0, annotation_index: annotationIndex, annotation
          });
        }
        continue;
      }
      const delta = portableAnnotationText(event.annotations, { excludeUrlCitations: targetProtocol === 'gemini' });
      if (!delta) continue;
      block.text += delta;
      if (targetProtocol === 'claude') {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } });
      } else if (targetProtocol === 'gemini') {
        yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{ text: delta }] }, index: 0 }] });
      } else {
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'text_delta' || event.type === 'tool_delta' || event.type === 'reasoning_delta') {
      const index = indices.get(event.sourceIndex);
      if (index === undefined) continue;
      const block = blocks.get(index);
      if (event.type === 'text_delta' || event.type === 'reasoning_delta') block.text += event.delta;
      else block.arguments += event.delta;
      if (event.type === 'text_delta' && event.logprobs?.length) block.logprobs.push(...event.logprobs);
      if (targetProtocol === 'claude' && event.type === 'tool_delta' && block.name === 'Read') continue;
      if (targetProtocol === 'claude') {
        const delta = event.type === 'text_delta' ? { type: 'text_delta', text: event.delta }
          : event.type === 'reasoning_delta' ? { type: 'thinking_delta', thinking: event.delta }
            : { type: 'input_json_delta', partial_json: event.delta };
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta });
      } else if (targetProtocol === 'responses') {
        if (event.type === 'tool_delta' && ['custom', 'tool_search'].includes(block.kind)) continue;
        const name = event.type === 'text_delta' && block.type === 'refusal' ? 'response.refusal.delta'
          : event.type === 'text_delta' ? 'response.output_text.delta'
          : event.type === 'reasoning_delta' ? 'response.reasoning_summary_text.delta'
            : 'response.function_call_arguments.delta';
        yield responseSse(name, { type: name, item_id: block.item.id, output_index: index, ...(event.type === 'text_delta' ? { content_index: 0, ...(block.type === 'text' ? { logprobs: openAiTokenLogprobs(event.logprobs || []) } : {}) } : {}), ...(event.type === 'reasoning_delta' ? { summary_index: 0 } : {}), delta: event.delta });
      } else if (targetProtocol === 'gemini' && event.type === 'text_delta') {
        yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{ text: event.delta, ...(event.type === 'reasoning_delta' ? { thought: true } : {}) }] }, index: 0, ...(event.type === 'text_delta' ? geminiLogprobFields(event.logprobs) : {}) }] });
      } else if (targetProtocol === 'gemini' && event.type === 'reasoning_delta') {
        // Buffer Gemini thought text until block_stop. Provider signatures often
        // arrive only in the terminal source event and Google clients ignore a
        // later empty thought Part carrying only thoughtSignature.
      } else if (targetProtocol === 'gemini' && event.type === 'tool_delta') {
        if (options.geminiStreamFunctionCallArguments && !block.geminiPartialArgsEmitted
          && block.arguments.trimEnd().endsWith('}') && block.geminiPartialParseAttempts < 128) {
          block.geminiPartialParseAttempts++;
          const partialArgs = tryGeminiPartialArguments(block.arguments);
          if (partialArgs?.length) {
            block.geminiPartialArgsEmitted = true;
            yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: {
              name: block.name, id: block.id, partialArgs, willContinue: true
            } }] }, index: 0 }] });
          }
        }
      } else if (event.type === 'text_delta') {
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: block.type === 'refusal' ? { refusal: event.delta } : { content: event.delta }, finish_reason: null, ...(block.type !== 'refusal' && event.logprobs?.length ? { logprobs: { content: openAiTokenLogprobs(event.logprobs) } } : {}) }] });
      } else if (event.type === 'reasoning_delta') {
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] });
      } else {
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { tool_calls: [{ index: block.chatToolIndex, function: { arguments: event.delta } }] }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'block_stop') {
      const index = indices.get(event.sourceIndex);
      if (index === undefined) continue;
      const block = blocks.get(index);
      const toolArguments = block.type === 'tool' ? blockToolArguments(block) : undefined;
      if (targetProtocol === 'claude') {
        if (block.type === 'tool' && block.name === 'Read' && block.arguments) {
          yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolArguments) } });
        }
        if (block.type === 'reasoning') yield sse('content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'signature_delta', signature: block.providerState
            ? encodeReasoningState(block.providerState.protocol, block.providerState.kind, block.providerState.value)
            : 'bridge' }
        });
        yield sse('content_block_stop', { type: 'content_block_stop', index });
      }
      else if (targetProtocol === 'responses') {
        if (block.type === 'text') {
          const logprobs = openAiTokenLogprobs(block.logprobs);
          const part = { type: 'output_text', text: block.text, annotations: block.annotations, ...(logprobs.length ? { logprobs } : {}) };
          yield responseSse('response.output_text.done', { type: 'response.output_text.done', item_id: block.item.id, output_index: index, content_index: 0, text: block.text, logprobs });
          yield responseSse('response.content_part.done', { type: 'response.content_part.done', item_id: block.item.id, output_index: index, content_index: 0, part });
          block.item.content = [part];
        } else if (block.type === 'refusal') {
          const part = { type: 'refusal', refusal: block.text };
          yield responseSse('response.refusal.done', { type: 'response.refusal.done', item_id: block.item.id, output_index: index, content_index: 0, refusal: block.text });
          yield responseSse('response.content_part.done', { type: 'response.content_part.done', item_id: block.item.id, output_index: index, content_index: 0, part });
          block.item.content = [part];
        } else if (block.type === 'reasoning') {
          const part = { type: 'summary_text', text: block.text };
          yield responseSse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: block.item.id, output_index: index, summary_index: 0, text: block.text });
          yield responseSse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: block.item.id, output_index: index, summary_index: 0, part });
          block.item.summary = [part];
          if (block.providerState) block.item.encrypted_content = encodeReasoningState(block.providerState.protocol, block.providerState.kind, block.providerState.value);
        } else if (block.type === 'provider_state') {
          if (block.item.type !== 'compaction') {
            block.item.encrypted_content = encodeReasoningState(block.providerState.protocol, block.providerState.kind, block.providerState.value);
          }
        } else {
          if (block.kind === 'custom') {
            const input = customToolInput(block.arguments);
            yield responseSse('response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', item_id: block.item.id, output_index: index, input });
            block.item.input = input;
          } else if (block.kind === 'tool_search') {
            block.item.arguments = toolArguments;
          } else {
            yield responseSse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: block.item.id, output_index: index, arguments: block.arguments });
            block.item.arguments = block.arguments;
          }
        }
        block.closed = true;
      }
      else if (targetProtocol === 'gemini' && block.type === 'tool') {
        if (block.providerState) pendingGeminiProviderStates.push(block.providerState);
        const signature = pendingGeminiProviderStates.length > 1
          ? encodeReasoningStateBundle(pendingGeminiProviderStates)
          : pendingGeminiProviderStates.length === 1
            ? encodeReasoningState(pendingGeminiProviderStates[0].protocol, pendingGeminiProviderStates[0].kind, pendingGeminiProviderStates[0].value)
            : undefined;
        pendingGeminiProviderStates.length = 0;
        yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: block.geminiPartialArgsEmitted
          ? {}
          : { name: block.name, args: toolArguments, id: block.id },
        ...(signature ? { thoughtSignature: signature } : {}) }] }, index: 0 }] });
      }
      else if (targetProtocol === 'gemini' && block.type === 'reasoning') {
        if (block.providerState) pendingGeminiProviderStates.push(block.providerState);
        if (block.text) {
          yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{
            text: block.text, thought: true
          }] }, index: 0 }] });
        }
      }
      else if (targetProtocol === 'gemini' && block.providerState) {
        pendingGeminiProviderStates.push(block.providerState);
      }
      else if (targetProtocol === 'chat' && block.providerState) {
        const encoded = encodeReasoningState(block.providerState.protocol, block.providerState.kind, block.providerState.value);
        const detail = block.type === 'reasoning'
          ? { type: 'reasoning.text', text: block.text, signature: encoded, id: `reasoning-text-${index}`, format: 'anthropic-claude-v1', index }
          : { type: 'reasoning.encrypted', data: encoded, id: `reasoning-encrypted-${index}`, format: 'anthropic-claude-v1', index };
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: { reasoning_details: [detail] }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'done') {
      createdAt = Number.isSafeInteger(event.createdAt) ? event.createdAt : createdAt;
      serviceTier = event.serviceTier || openAiServiceTierForClaudeSpeed(event.speed) || serviceTier;
      speed = event.speed || claudeSpeedForOpenAiServiceTier(event.serviceTier) || speed;
      systemFingerprint = event.systemFingerprint || systemFingerprint;
      inputTokens = event.inputTokens || inputTokens; outputTokens = event.outputTokens || 0; cachedInputTokens = event.cachedInputTokens || cachedInputTokens; cacheCreationInputTokens = event.cacheCreationInputTokens || cacheCreationInputTokens; reasoningTokens = event.reasoningTokens || 0;
      cacheCreation5mInputTokens = event.cacheCreation5mInputTokens || cacheCreation5mInputTokens; cacheCreation1hInputTokens = event.cacheCreation1hInputTokens || cacheCreation1hInputTokens;
      webSearchQueries = event.webSearchQueries || webSearchQueries;
      if (targetProtocol === 'gemini' && pendingGeminiProviderStates.length) {
        const signature = pendingGeminiProviderStates.length > 1
          ? encodeReasoningStateBundle(pendingGeminiProviderStates)
          : encodeReasoningState(pendingGeminiProviderStates[0].protocol, pendingGeminiProviderStates[0].kind, pendingGeminiProviderStates[0].value);
        pendingGeminiProviderStates.length = 0;
        yield geminiChunk({ candidates: [{ content: { role: 'model', parts: [{
          text: GEMINI_BRIDGE_STATE_TEXT, thought: true, thoughtSignature: signature
        }] }, index: 0 }] });
      }
      if (event.hasUsage) options.onUsage?.({
        inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens,
        ...(cacheCreation5mInputTokens ? { cacheCreation5mInputTokens } : {}),
        ...(cacheCreation1hInputTokens ? { cacheCreation1hInputTokens } : {}),
        reasoningTokens
      });
      const onReasoningState = options.onReasoningState;
      const blockSummary = summarizeStreamBlocks(blocks, {
        collectReasoningState: onReasoningState != null,
        collectOutput: targetProtocol === 'responses',
        collectGrounding: targetProtocol === 'gemini'
      });
      onReasoningState?.({
        toolCalls: blockSummary.toolCalls,
        providerStates: blockSummary.providerStates
      });
      const { hasTools, hasRefusal } = blockSummary;
      const portableStopReason = hasRefusal && event.stopReason === 'refusal' ? 'end_turn' : event.stopReason;
      if (targetProtocol === 'claude') {
        const stopReason = claudeStopReason(hasRefusal ? 'refusal' : event.stopReason, hasTools);
        yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens, ...(reasoningTokens ? { output_tokens_details: { thinking_tokens: reasoningTokens } } : {}) } });
        yield sse('message_stop', { type: 'message_stop' });
      } else if (targetProtocol === 'responses') {
        const incompleteReason = responsesIncompleteReason(portableStopReason);
        const incomplete = Boolean(incompleteReason);
        for (const [index, block] of blocks) {
          if (!block.item || !block.closed || block.itemDone) continue;
          if (block.item.type !== 'compaction') block.item.status = incomplete ? 'incomplete' : 'completed';
          block.itemDone = true;
          yield responseSse('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: block.item });
        }
        const final = {
          id: responseId, object: 'response', created_at: createdAt, status: incomplete ? 'incomplete' : 'completed',
          model, ...responsesMetadata(), ...responseConfig,
          ...(!incomplete ? { completed_at: Math.max(createdAt, Math.floor(Date.now() / 1000)) } : { completed_at: null }),
          ...(incomplete ? { incomplete_details: { reason: incompleteReason } } : {}),
          output: blockSummary.output,
          usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: cachedInputTokens, cache_write_tokens: cacheCreationInputTokens }, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: reasoningTokens }, total_tokens: normalizeUsageCount(inputTokens + outputTokens) }
        };
        yield responseSse(incomplete ? 'response.incomplete' : 'response.completed', { type: incomplete ? 'response.incomplete' : 'response.completed', response: final });
      } else if (targetProtocol === 'gemini') {
        const hasWebSearchQueries = asArray(webSearchQueries).some((query) => typeof query === 'string' && query);
        const groundingMetadata = blockSummary.hasUrlCitations
          ? geminiGroundingMetadata(blockSummary.groundingParts, { flatten: true, webSearchQueries })
          : hasWebSearchQueries ? geminiGroundingMetadata([], { flatten: true, webSearchQueries }) : undefined;
        yield geminiChunk({
          candidates: [{
            content: { role: 'model', parts: [] }, finishReason: geminiFinishReason(hasRefusal ? 'refusal' : event.stopReason), index: 0,
            ...(groundingMetadata ? { groundingMetadata } : {})
          }],
          usageMetadata: geminiUsageMetadata(inputTokens, outputTokens, cachedInputTokens, reasoningTokens)
        });
      } else {
        const promptDetails = (cachedInputTokens || cacheCreationInputTokens) ? { ...(cachedInputTokens ? { cached_tokens: cachedInputTokens } : {}), ...(cacheCreationInputTokens ? { cache_creation_tokens: cacheCreationInputTokens } : {}) } : undefined;
        yield chatChunk({ id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [{ index: 0, delta: {}, finish_reason: chatStopReason(portableStopReason, hasTools) }] });
        if (chatIncludeUsage) yield chatSse({
          id: responseId, object: 'chat.completion.chunk', created: createdAt, model, ...chatMetadata(), choices: [],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: normalizeUsageCount(inputTokens + outputTokens), ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}), ...(reasoningTokens ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}) }
        });
        yield 'data: [DONE]\n\n';
      }
    }
  }
}

export function createSseObserver(protocol, fallbackModel, options = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pending = createSseTextBuffer();
  let ended = false;
  let result;
  let started = false;
  let terminal = false;
  let usageObserved = false;
  let usageEmitted = false;
  let chatFinishReason = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheCreation5mInputTokens = 0;
  let cacheCreation1hInputTokens = 0;
  let reasoningTokens = 0;
  let geminiCandidateTokens = 0;
  let usage = {};
  let error;
  let observationSkipped;
  let streamFailed = false;
  let nextSequenceNumber = 0;

  const emitUsage = () => {
    if (usageEmitted || !usageObserved) return;
    usageEmitted = true;
    usage = {
      inputTokens: normalizeUsageCount(inputTokens),
      outputTokens: normalizeUsageCount(outputTokens),
      cachedInputTokens: normalizeUsageCount(cachedInputTokens),
      cacheCreationInputTokens: normalizeUsageCount(cacheCreationInputTokens),
      ...(cacheCreation5mInputTokens ? { cacheCreation5mInputTokens: normalizeUsageCount(cacheCreation5mInputTokens) } : {}),
      ...(cacheCreation1hInputTokens ? { cacheCreation1hInputTokens: normalizeUsageCount(cacheCreation1hInputTokens) } : {}),
      reasoningTokens: normalizeUsageCount(reasoningTokens)
    };
    try { options.onUsage?.(usage); } catch { /* 观察回调不能破坏原始流 */ }
  };
  const emitError = (value) => {
    error = value;
    try { options.onError?.(error); } catch { /* 观察回调不能破坏原始流 */ }
  };
  const observeSequenceNumber = (data) => {
    if (protocol !== 'responses') return;
    const sequenceNumber = data?.sequence_number;
    if (Number.isSafeInteger(sequenceNumber) && sequenceNumber >= nextSequenceNumber) nextSequenceNumber = sequenceNumber + 1;
  };
  const observeData = (data) => {
    observeSequenceNumber(data);
    if (data.error || data.type === 'error') {
      terminal = true;
      emitError(data.error || data);
      return;
    }
    if (protocol === 'claude') {
      if (data.type === 'message_start') {
        started = true;
        usageObserved ||= hasUsageData(data.message);
        inputTokens = normalizeUsageCount(data.message?.usage?.input_tokens);
        cachedInputTokens = normalizeUsageCount(data.message?.usage?.cache_read_input_tokens);
        cacheCreationInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation_input_tokens);
        cacheCreation5mInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation?.ephemeral_5m_input_tokens);
        cacheCreation1hInputTokens = normalizeUsageCount(data.message?.usage?.cache_creation?.ephemeral_1h_input_tokens);
      } else if (data.type === 'message_delta') {
        usageObserved ||= hasUsageData(data);
        outputTokens = normalizeUsageCount(data.usage?.output_tokens);
        terminal = true;
        emitUsage();
      }
      return;
    }
    if (protocol === 'responses') {
      if (data.type === 'response.created') {
        started = true;
        usageObserved ||= hasUsageData(data.response);
        const initial = data.response?.usage;
        inputTokens = normalizeUsageCount(initial?.input_tokens, initial?.prompt_tokens);
        cachedInputTokens = normalizeUsageCount(initial?.cache_read_input_tokens, initial?.prompt_cache_hit_tokens, initial?.input_tokens_details?.cached_tokens, initial?.prompt_tokens_details?.cached_tokens);
        cacheCreationInputTokens = normalizeUsageCount(initial?.cache_creation_input_tokens, initial?.input_tokens_details?.cache_write_tokens, initial?.input_tokens_details?.cache_creation_tokens, initial?.prompt_tokens_details?.cache_write_tokens, initial?.prompt_tokens_details?.cache_creation_tokens);
      } else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
        terminal = true;
        usageObserved ||= hasUsageData(data.response);
        const final = data.response?.usage;
        inputTokens = normalizeUsageCount(final?.input_tokens, final?.prompt_tokens, inputTokens);
        outputTokens = normalizeUsageCount(final?.output_tokens, final?.completion_tokens);
        cachedInputTokens = normalizeUsageCount(final?.cache_read_input_tokens, final?.prompt_cache_hit_tokens, final?.input_tokens_details?.cached_tokens, final?.prompt_tokens_details?.cached_tokens, cachedInputTokens);
        cacheCreationInputTokens = normalizeUsageCount(final?.cache_creation_input_tokens, final?.input_tokens_details?.cache_write_tokens, final?.input_tokens_details?.cache_creation_tokens, final?.prompt_tokens_details?.cache_write_tokens, final?.prompt_tokens_details?.cache_creation_tokens, cacheCreationInputTokens);
        reasoningTokens = normalizeUsageCount(final?.output_tokens_details?.reasoning_tokens, final?.completion_tokens_details?.reasoning_tokens, reasoningTokens);
        emitUsage();
      } else if (data.type === 'response.failed') {
        terminal = true;
        emitError(data.response?.error || { message: 'Responses 上游生成失败' });
      }
      return;
    }

    if (protocol === 'gemini') {
      started = true;
      usageObserved ||= hasUsageData(data);
      inputTokens = normalizeUsageCount(data.usageMetadata?.promptTokenCount, inputTokens);
      cachedInputTokens = normalizeUsageCount(data.usageMetadata?.cachedContentTokenCount, cachedInputTokens);
      reasoningTokens = normalizeUsageCount(data.usageMetadata?.thoughtsTokenCount, reasoningTokens);
      geminiCandidateTokens = normalizeUsageCount(data.usageMetadata?.candidatesTokenCount, geminiCandidateTokens);
      outputTokens = geminiCandidateTokens + reasoningTokens;
      const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
      if (candidate?.finishReason || data.promptFeedback?.blockReason) {
        terminal = true;
        emitUsage();
      }
      return;
    }

    started = true;
    if (data.usage) {
      usageObserved ||= hasUsageData(data);
      inputTokens = normalizeUsageCount(data.usage.prompt_tokens, data.usage.input_tokens, inputTokens);
      outputTokens = normalizeUsageCount(data.usage.completion_tokens, data.usage.output_tokens, outputTokens);
      cachedInputTokens = normalizeUsageCount(data.usage.cache_read_input_tokens, data.usage.prompt_cache_hit_tokens, data.usage.prompt_tokens_details?.cached_tokens, cachedInputTokens);
      cacheCreationInputTokens = normalizeUsageCount(data.usage.cache_creation_input_tokens, data.usage.prompt_tokens_details?.cache_write_tokens, data.usage.prompt_tokens_details?.cache_creation_tokens, cacheCreationInputTokens);
      reasoningTokens = normalizeUsageCount(data.usage.completion_tokens_details?.reasoning_tokens, reasoningTokens);
    }
    if (data.choices?.[0]?.finish_reason) chatFinishReason = true;
    if (chatFinishReason && data.usage) {
      terminal = true;
      emitUsage();
    }
  };
  const observeBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (parsed) observeData(parsed.data);
  };
  const processText = (value) => {
    for (const { block } of appendSseText(pending, value)) observeBlock(block);
  };
  const skipObservation = (caught) => {
    observationSkipped = caught.message;
    error = undefined;
    resetSseTextBuffer(pending);
  };

  return {
    observe(data) {
      if (ended || observationSkipped) return;
      try { observeData(data); }
      catch (caught) { emitError({ type: 'upstream_error', message: caught?.message || String(caught) }); }
    },
    write(chunk) {
      if (ended || observationSkipped) return;
      try {
        processText(typeof chunk === 'string' ? chunk : decodeSseUtf8(decoder, chunk, { stream: true }));
      } catch (caught) {
        if (['UPSTREAM_SSE_EVENT_TOO_LARGE', 'UPSTREAM_JSON_TOO_COMPLEX'].includes(caught.code)) skipObservation(caught);
        else emitError({ type: 'upstream_error', message: caught.message });
      }
    },
    fail(caught) {
      if (ended || observationSkipped) return;
      streamFailed = true;
      resetSseTextBuffer(pending);
      terminal = true;
      emitError({ type: 'upstream_error', message: caught?.message || String(caught) });
    },
    end() {
      if (ended) return result;
      ended = true;
      if (!observationSkipped && !streamFailed) {
        try {
          processText(decodeSseUtf8(decoder));
          const remainder = takeSseText(pending).trim();
          if (remainder) observeBlock(remainder);
        } catch (caught) {
          if (['UPSTREAM_SSE_EVENT_TOO_LARGE', 'UPSTREAM_JSON_TOO_COMPLEX'].includes(caught.code)) skipObservation(caught);
          else emitError({ type: 'upstream_error', message: caught.message });
        }
      }
      if (!observationSkipped) {
        if (protocol === 'chat' && chatFinishReason) {
          terminal = true;
          emitUsage();
        }
        if (started && !terminal && !error) emitError({ type: 'upstream_error', message: '上游 SSE 在完成事件前结束' });
      }
      result = {
        usage,
        error: observationSkipped ? undefined : error,
        ...(observationSkipped ? { observationSkipped } : {}),
        ...(protocol === 'responses' ? { nextSequenceNumber } : {})
      };
      return result;
    }
  };
}

export async function observeSse(response, protocol, fallbackModel, options = {}) {
  const observer = createSseObserver(protocol, fallbackModel, options);
  try {
    for await (const chunk of response.body || []) observer.write(chunk);
  } catch (caught) {
    observer.fail(caught);
  }
  return observer.end();
}
