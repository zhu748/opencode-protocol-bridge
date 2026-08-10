import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeReasoningState, encodeReasoningState, encodeReasoningStateBundle, isBridgeReasoningState } from '../src/reasoning-state.js';
import { createReasoningStateScope, ReasoningStateStore } from '../src/reasoning-state-store.js';

test('推理状态封装可逆且不会误认普通供应商签名', () => {
  const value = { type: 'thinking', thinking: '检查', signature: 'opaque' };
  const encoded = encodeReasoningState('claude', 'thinking', value);
  assert.deepEqual(decodeReasoningState(encoded), { protocol: 'claude', kind: 'thinking', value });
  assert.equal(isBridgeReasoningState(encoded), true);
  assert.equal(decodeReasoningState('ordinary-provider-signature'), null);
  assert.equal(decodeReasoningState(Buffer.from('{"marker":"wrong"}').toString('base64url')), null);

  const fallback = { type: 'fallback', from: { model: 'claude-primary' }, to: { model: 'claude-fallback' } };
  assert.deepEqual(decodeReasoningState(encodeReasoningState('claude', 'fallback', fallback)), {
    protocol: 'claude', kind: 'fallback', value: fallback
  });
  const compaction = {
    type: 'compaction', content: '压缩后的上下文', encrypted_content: 'opaque-compaction',
    cache_control: { type: 'ephemeral', ttl: '1h' }
  };
  assert.deepEqual(decodeReasoningState(encodeReasoningState('claude', 'compaction', compaction)), {
    protocol: 'claude', kind: 'compaction', value: compaction
  });
  const responsesCompaction = {
    type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-responses-compaction', created_by: 'server'
  };
  assert.deepEqual(decodeReasoningState(encodeReasoningState('responses', 'compaction', responsesCompaction)), {
    protocol: 'responses', kind: 'compaction', value: responsesCompaction
  });
});

test('Gemini 工具 Part 可封装多个供应商推理状态', () => {
  const states = [
    { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: '分析', signature: 'sig' } },
    { protocol: 'claude', kind: 'redacted_thinking', value: { type: 'redacted_thinking', data: 'hidden' } }
  ];
  assert.deepEqual(decodeReasoningState(encodeReasoningStateBundle(states)), {
    protocol: 'bridge', kind: 'bundle', value: { states }
  });
  assert.throws(() => encodeReasoningStateBundle(states.slice(0, 1)), /至少两个/);
});

test('推理状态封装拒绝协议与内容类型不匹配的伪造状态', () => {
  const forged = (protocol, kind, value) => Buffer.from(JSON.stringify({
    marker: 'opencode_bridge_reasoning_v1', protocol, kind, value
  })).toString('base64url');

  assert.equal(decodeReasoningState(forged('claude', 'thinking', {
    type: 'tool_use', id: 'call_forged', name: 'read', input: {}
  })), null);
  assert.equal(decodeReasoningState(forged('responses', 'reasoning', {
    type: 'function_call', call_id: 'call_forged', name: 'read', arguments: '{}'
  })), null);
  assert.equal(decodeReasoningState(forged('chat', 'reasoning_detail', {
    type: 'reasoning.encrypted', data: ''
  })), null);
  assert.equal(decodeReasoningState(forged('gemini', 'part', {
    functionResponse: { name: 'read', response: {} }, thoughtSignature: 'opaque'
  })), null);
  assert.throws(() => encodeReasoningState('claude', 'thinking', {
    type: 'redacted_thinking', data: 'opaque'
  }), /无效的 claude\/thinking 状态/);
  assert.throws(() => encodeReasoningState('claude', 'fallback', {
    type: 'fallback', from: { model: 'claude-primary' }, to: {}
  }), /无效的 claude\/fallback 状态/);
  assert.throws(() => encodeReasoningState('claude', 'compaction', {
    type: 'compaction', content: '', encrypted_content: 'opaque'
  }), /无效的 claude\/compaction 状态/);
  assert.throws(() => encodeReasoningState('responses', 'compaction', {
    type: 'compaction', id: 'cmp_1', encrypted_content: '', created_by: 'server'
  }), /无效的 responses\/compaction 状态/);

  for (const [protocol, kind, value] of [
    ['claude', 'thinking', { type: 'thinking', thinking: 'x', signature: 'sig', vendor_field: true }],
    ['claude', 'fallback', { type: 'fallback', from: { model: 'a', extra: true }, to: { model: 'b' } }],
    ['responses', 'reasoning', { type: 'reasoning', encrypted_content: 'opaque', summary: [], injected: true }],
    ['chat', 'reasoning_detail', { type: 'reasoning.encrypted', data: 'opaque', injected: true }],
    ['gemini', 'part', { text: 'x', thought: true, thoughtSignature: 'opaque', injected: true }]
  ]) {
    assert.equal(decodeReasoningState(forged(protocol, kind, value)), null, `${protocol}/${kind}`);
    assert.throws(() => encodeReasoningState(protocol, kind, value), /无效/, `${protocol}/${kind}`);
  }

  assert.doesNotThrow(() => encodeReasoningState('responses', 'reasoning', {
    id: 'rs_valid', type: 'reasoning', status: 'completed', phase: 'commentary',
    summary: [{ type: 'summary_text', text: '摘要' }],
    content: [{ type: 'reasoning_text', text: '正文' }], encrypted_content: 'opaque'
  }));
  assert.doesNotThrow(() => encodeReasoningState('chat', 'reasoning_detail', {
    type: 'reasoning.encrypted', data: 'opaque', id: 'detail_1', format: 'anthropic-claude-v1', index: 0
  }));
});

test('工具调用推理状态缓存可向四种客户端请求补回目标协议状态', () => {
  const store = new ReasoningStateStore();
  const state = {
    protocol: 'claude', kind: 'redacted_thinking',
    value: { type: 'redacted_thinking', data: 'opaque-redacted' }
  };
  store.remember(['call_1'], [state]);

  const chat = store.inject({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] }] }, 'chat', 'claude');
  assert.deepEqual(decodeReasoningState(chat.messages[0].reasoning_details[0].data), state);

  const claude = store.inject({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }] }] }, 'claude', 'claude');
  assert.deepEqual(decodeReasoningState(claude.messages[0].content[0].data), state);

  const responses = store.inject({ input: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' }] }, 'responses', 'claude');
  assert.deepEqual(decodeReasoningState(responses.input[0].encrypted_content), state);

  const gemini = store.inject({ contents: [{ role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'read', args: {} } }] }] }, 'gemini', 'claude');
  assert.deepEqual(decodeReasoningState(gemini.contents[0].parts[0].thoughtSignature), state);
  const deduplicated = store.inject(gemini, 'gemini', 'claude');
  assert.deepEqual(deduplicated, gemini);
});

test('三种消息历史在空状态仓库中零读取并共享原数组', () => {
  const count = 256;
  const cases = [
    ['chat', 'messages', Array.from({ length: count }, (_, index) => ({
      role: 'assistant', tool_calls: [{ id: `missing_chat_${index}`, function: { name: 'lookup', arguments: '{}' } }]
    }))],
    ['claude', 'messages', Array.from({ length: count }, (_, index) => ({
      role: 'assistant', content: [{ type: 'tool_use', id: `missing_claude_${index}`, name: 'lookup', input: {} }]
    }))],
    ['gemini', 'contents', Array.from({ length: count }, (_, index) => ({
      role: 'model', parts: [{ functionCall: { id: `missing_gemini_${index}`, name: 'lookup', args: {} } }]
    }))]
  ];
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  for (const [protocol, field, history] of cases) {
    let reads = 0;
    const observedHistory = new Proxy(history, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      }
    });
    const body = { [field]: observedHistory };
    let mapCalls = 0;
    let filterCalls = 0;
    let nowReads = 0;
    Array.prototype.map = function(...args) {
      mapCalls++;
      return originalMap.apply(this, args);
    };
    Array.prototype.filter = function(...args) {
      filterCalls++;
      return originalFilter.apply(this, args);
    };
    let result;
    try {
      result = new ReasoningStateStore({ now: () => {
        nowReads++;
        return 0;
      } }).inject(body, protocol, 'claude');
    } finally {
      Array.prototype.map = originalMap;
      Array.prototype.filter = originalFilter;
    }
    assert.equal(result, body, protocol);
    assert.equal(reads, 0, protocol);
    assert.equal(nowReads, 0, protocol);
    assert.equal(mapCalls, 0, protocol);
    assert.equal(filterCalls, 0, protocol);
  }

  const store = new ReasoningStateStore();
  const state = {
    protocol: 'claude', kind: 'redacted_thinking',
    value: { type: 'redacted_thinking', data: 'copy-on-write-state' }
  };
  store.remember(['call_copy_on_write'], [state]);
  const messages = [
    { role: 'user', content: '之前' },
    { role: 'assistant', tool_calls: [{ id: 'call_copy_on_write' }] },
    { role: 'user', content: '之后' }
  ];
  const injected = store.inject({ messages }, 'chat', 'claude');
  assert.notEqual(injected.messages, messages);
  assert.equal(injected.messages.length, messages.length);
  assert.equal(injected.messages[0], messages[0]);
  assert.notEqual(injected.messages[1], messages[1]);
  assert.equal(injected.messages[2], messages[2]);
});

test('无有效状态写入跳过工具指纹且有效写入只读取一次时钟', () => {
  let nowReads = 0;
  let argumentReads = 0;
  const store = new ReasoningStateStore({ now: () => {
    nowReads++;
    return 100;
  } });
  const ignoredCall = { id: 'call_ignored', name: 'lookup' };
  Object.defineProperty(ignoredCall, 'arguments', {
    enumerable: true,
    get() {
      argumentReads++;
      throw new Error('无有效状态时不应读取工具参数');
    }
  });

  assert.doesNotThrow(() => store.remember([ignoredCall], []));
  assert.doesNotThrow(() => store.remember([ignoredCall], [{ protocol: '', kind: 'reasoning', value: {} }]));
  store.prune();
  assert.equal(argumentReads, 0);
  assert.equal(nowReads, 0);

  store.remember(['call_valid'], [{
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'single-clock-state' }
  }]);
  assert.equal(nowReads, 1);
  assert.equal(store.entries.size, 1);
});

test('推理状态捕获及 Claude/Gemini 去重各只扫描一次内容', () => {
  const count = 512;
  const state = {
    protocol: 'claude', kind: 'redacted_thinking',
    value: { type: 'redacted_thinking', data: 'shared-opaque-state' }
  };
  const capturedParts = Array.from({ length: count - 2 }, (_, index) => ({ type: 'text', text: `part-${index}` }));
  capturedParts.push(
    { type: 'provider_state', providerState: state },
    { type: 'tool_call', id: 'call_scan', name: 'lookup', arguments: { value: 1 } }
  );
  let captureReads = 0;
  const observedCapturedParts = new Proxy(capturedParts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) captureReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const store = new ReasoningStateStore();
  store.rememberParts(observedCapturedParts, 'scope');
  assert.ok(captureReads <= count,
    `推理状态捕获读取了 ${captureReads} 个内容项，预期最多执行一次 O(n) 遍历`);

  const encoded = encodeReasoningState(state.protocol, state.kind, state.value);
  const claudeContent = [
    { type: 'redacted_thinking', data: encoded },
    ...Array.from({ length: count - 2 }, (_, index) => ({ type: 'text', text: `history-${index}` })),
    { type: 'tool_use', id: 'call_scan', name: 'lookup', input: { value: 1 } }
  ];
  let claudeReads = 0;
  const observedClaudeContent = new Proxy(claudeContent, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) claudeReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const claudeBody = { messages: [{ role: 'assistant', content: observedClaudeContent }] };
  assert.equal(store.inject(claudeBody, 'claude', 'claude', 'scope'), claudeBody);
  assert.ok(claudeReads <= count,
    `Claude 已有状态检查读取了 ${claudeReads} 个内容项，预期最多执行一次 O(n) 遍历`);

  const geminiParts = [
    { text: 'bridge state', thought: true, thoughtSignature: encoded },
    ...Array.from({ length: count - 2 }, (_, index) => ({ text: `history-${index}` })),
    { functionCall: { id: 'call_scan', name: 'lookup', args: { value: 1 } } }
  ];
  let geminiReads = 0;
  const observedGeminiParts = new Proxy(geminiParts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) geminiReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const geminiBody = { contents: [{ role: 'model', parts: observedGeminiParts }] };
  assert.equal(store.inject(geminiBody, 'gemini', 'claude', 'scope'), geminiBody);
  assert.ok(geminiReads <= count,
    `Gemini 已有状态检查读取了 ${geminiReads} 个内容项，预期最多执行一次 O(n) 遍历`);
});

test('工具调用推理状态缓存按协议隔离并在过期后清除', () => {
  let now = 100;
  const store = new ReasoningStateStore({ ttlMs: 10, now: () => now });
  store.remember(['call_1'], [{ protocol: 'responses', kind: 'reasoning', value: { type: 'reasoning', encrypted_content: 'x' } }]);
  const wrongTarget = store.inject({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1' }] }] }, 'chat', 'claude');
  assert.equal(wrongTarget.messages[0].reasoning_details, undefined);
  now = 111;
  let expiredHistoryReads = 0;
  const expiredMessages = new Proxy([{ role: 'assistant', tool_calls: [{ id: 'call_1' }] }], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) expiredHistoryReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const expiredBody = { messages: expiredMessages };
  const expired = store.inject(expiredBody, 'chat', 'responses');
  assert.equal(expired, expiredBody);
  assert.equal(expiredHistoryReads, 0);
  assert.equal(store.entries.size, 0);
});

test('推理状态作用域同时隔离请求模型、provider 和实际上游模型', () => {
  const client = 'client-a';
  const zen = createReasoningStateScope(client, 'shared-model', {
    provider: 'zen', upstreamModel: 'shared-model', protocol: 'chat'
  });
  const go = createReasoningStateScope(client, 'shared-model', {
    provider: 'go', upstreamModel: 'shared-model', protocol: 'chat'
  });
  const alias = createReasoningStateScope(client, 'alias-model', {
    provider: 'zen', upstreamModel: 'shared-model', protocol: 'chat'
  });
  assert.notEqual(zen, go);
  assert.notEqual(zen, alias);

  const store = new ReasoningStateStore();
  const state = { protocol: 'chat', kind: 'reasoning_detail', value: {
    type: 'reasoning.encrypted', data: 'zen-only-state'
  } };
  store.remember(['call_1'], [state], zen);
  const body = { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1' }] }] };
  assert.equal(store.inject(body, 'chat', 'chat', go).messages[0].reasoning_details, undefined);
  assert.deepEqual(decodeReasoningState(store.inject(body, 'chat', 'chat', zen).messages[0].reasoning_details[0].data), state);
});

test('协议索引在覆盖、容量淘汰和过期后保持一致并跳过无关历史', () => {
  let now = 100;
  let nowReads = 0;
  const store = new ReasoningStateStore({
    ttlMs: 10,
    maxEntries: 1,
    now: () => {
      nowReads++;
      return now;
    }
  });
  const responsesState = {
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'protocol-index-responses' }
  };
  const claudeStates = [
    {
      protocol: 'claude', kind: 'thinking',
      value: { type: 'thinking', thinking: '索引一', signature: 'protocol-index-1' }
    },
    {
      protocol: 'claude', kind: 'redacted_thinking',
      value: { type: 'redacted_thinking', data: 'protocol-index-2' }
    }
  ];
  const sharedCall = { id: 'call_protocol_index', name: 'lookup', arguments: '{}' };
  store.remember([sharedCall], [responsesState, ...claudeStates], 'scope');
  assert.equal(store.protocolEntryCounts.get('responses'), 1);
  assert.equal(store.protocolEntryCounts.get('claude'), 1);

  let historyReads = 0;
  const messages = new Proxy([{ role: 'assistant', tool_calls: [{ id: sharedCall.id }] }], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) historyReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const body = { messages };
  nowReads = 0;
  assert.equal(store.inject(body, 'chat', 'gemini', 'scope'), body);
  assert.equal(historyReads, 0);
  assert.equal(nowReads, 1);

  let argumentReads = 0;
  const unrelatedCall = { id: 'call_unrelated_protocol', name: 'lookup' };
  Object.defineProperty(unrelatedCall, 'arguments', {
    enumerable: true,
    get() {
      argumentReads++;
      throw new Error('目标协议无缓存时不应计算工具指纹');
    }
  });
  assert.doesNotThrow(() => store.statesForCalls([unrelatedCall], 'gemini', 'scope'));
  assert.equal(argumentReads, 0);

  store.remember([sharedCall], claudeStates, 'scope');
  assert.equal(store.protocolEntryCounts.has('responses'), false);
  assert.equal(store.protocolEntryCounts.get('claude'), 1);

  store.remember([{ id: 'call_protocol_index_2' }], [responsesState], 'scope');
  assert.equal(store.entries.size, 1);
  assert.equal(store.protocolEntryCounts.has('claude'), false);
  assert.equal(store.protocolEntryCounts.get('responses'), 1);

  now = 110;
  historyReads = 0;
  assert.equal(store.inject(body, 'chat', 'responses', 'scope'), body);
  assert.equal(historyReads, 0);
  assert.equal(store.entries.size, 0);
  assert.equal(store.protocolEntryCounts.size, 0);
  assert.equal(store.bytes, 0);
});

test('最早过期索引在未到期时跳过大仓库全表扫描并保持精确', () => {
  let now = 100;
  const entryCount = 512;
  const store = new ReasoningStateStore({
    ttlMs: 10,
    maxEntries: entryCount + 1,
    now: () => now
  });
  let fullScans = 0;
  const originalIterator = store.entries[Symbol.iterator].bind(store.entries);
  store.entries[Symbol.iterator] = () => {
    fullScans++;
    return originalIterator();
  };
  const state = {
    protocol: 'claude', kind: 'thinking',
    value: { type: 'thinking', thinking: '过期索引', signature: 'expiry-index' }
  };
  const calls = Array.from({ length: entryCount }, (_, index) => ({ id: `call_expiry_${index}` }));

  store.remember(calls, [state], 'scope');
  assert.equal(store.entries.size, entryCount);
  assert.equal(store.nextExpiryAt, 110);
  assert.equal(store.nextExpiryCount, entryCount);
  assert.equal(store.expiryIndexDirty, false);
  assert.equal(fullScans, 0);

  now = 109;
  for (let index = 0; index < 32; index++) store.prune();
  assert.equal(fullScans, 0);
  assert.equal(store.entries.size, entryCount);

  now = 110;
  store.prune();
  assert.equal(fullScans, 1);
  assert.equal(store.entries.size, 0);
  assert.equal(store.nextExpiryAt, Infinity);
  assert.equal(store.nextExpiryCount, 0);
  assert.equal(store.expiryIndexDirty, false);

  now = 200;
  const staggered = new ReasoningStateStore({ ttlMs: 10, now: () => now });
  staggered.remember([{ id: 'call_early' }], [state], 'scope');
  now = 201;
  staggered.remember([{ id: 'call_later' }], [state], 'scope');
  now = 202;
  staggered.remember([{ id: 'call_early' }], [state], 'scope');
  assert.equal(staggered.nextExpiryAt, 211);
  assert.equal(staggered.nextExpiryCount, 1);
  assert.equal(staggered.expiryIndexDirty, false);

  now = 211;
  staggered.prune();
  assert.equal(staggered.entries.size, 1);
  assert.equal(staggered.nextExpiryAt, 212);
  assert.equal(staggered.nextExpiryCount, 1);
  assert.equal(staggered.expiryIndexDirty, false);
  now = 212;
  staggered.prune();
  assert.equal(staggered.entries.size, 0);
  assert.equal(staggered.nextExpiryAt, Infinity);
  assert.equal(staggered.nextExpiryCount, 0);
});

test('共享最早过期项仅在最后一项被淘汰后重算索引', () => {
  let now = 100;
  const entryCount = 64;
  const store = new ReasoningStateStore({
    ttlMs: 10,
    maxEntries: entryCount,
    now: () => now
  });
  let rebuildScans = 0;
  const originalValues = store.entries.values.bind(store.entries);
  store.entries.values = () => {
    rebuildScans++;
    return originalValues();
  };
  const state = {
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'shared-expiry-index' }
  };
  const calls = Array.from({ length: entryCount }, (_, index) => ({ id: `call_shared_expiry_${index}` }));
  store.remember(calls, [state], 'scope');
  assert.equal(store.nextExpiryAt, 110);
  assert.equal(store.nextExpiryCount, entryCount);
  assert.equal(rebuildScans, 0);

  now = 101;
  store.remember([calls[0]], [state], 'scope');
  assert.equal(store.nextExpiryAt, 110);
  assert.equal(store.nextExpiryCount, entryCount - 1);
  assert.equal(rebuildScans, 0);

  for (let index = 0; index < entryCount - 2; index++) {
    store.remember([{ id: `call_new_expiry_${index}` }], [state], 'scope');
  }
  assert.equal(store.entries.size, entryCount);
  assert.equal(store.nextExpiryAt, 110);
  assert.equal(store.nextExpiryCount, 1);
  assert.equal(rebuildScans, 0);

  store.remember([{ id: 'call_new_expiry_last' }], [state], 'scope');
  assert.equal(store.entries.size, entryCount);
  assert.equal(store.nextExpiryAt, 111);
  assert.equal(store.nextExpiryCount, entryCount);
  assert.equal(store.expiryIndexDirty, false);
  assert.equal(rebuildScans, 1);
});

test('大批量容量淘汰复用单个迭代器并保持 LRU 与字节限制', () => {
  const now = 100;
  const entryCount = 256;
  const keptEntries = 32;
  const state = {
    protocol: 'claude', kind: 'thinking',
    value: { type: 'thinking', thinking: '容量淘汰', signature: 'capacity-iterator' }
  };
  const calls = Array.from({ length: entryCount }, (_, index) => ({ id: `call_capacity_${index}` }));
  const store = new ReasoningStateStore({
    ttlMs: 10,
    maxEntries: keptEntries,
    now: () => now
  });
  let iteratorCreations = 0;
  const originalEntries = store.entries.entries.bind(store.entries);
  store.entries.entries = () => {
    iteratorCreations++;
    return originalEntries();
  };

  store.remember(calls, [state], 'scope');
  assert.equal(iteratorCreations, 1);
  assert.equal(store.entries.size, keptEntries);
  assert.equal(store.nextExpiryCount, keptEntries);
  assert.deepEqual(store.statesForCalls([calls[entryCount - keptEntries]], 'claude', 'scope'), [state]);
  assert.deepEqual(store.statesForCalls([calls[entryCount - keptEntries - 1]], 'claude', 'scope'), []);

  store.remember([{ id: 'call_capacity_new' }], [state], 'scope');
  assert.equal(iteratorCreations, 2);
  assert.deepEqual(store.statesForCalls([calls[entryCount - keptEntries]], 'claude', 'scope'), [state]);
  assert.deepEqual(store.statesForCalls([calls[entryCount - keptEntries + 1]], 'claude', 'scope'), []);

  const stateSize = Buffer.byteLength(JSON.stringify([state]), 'utf8');
  const byteStore = new ReasoningStateStore({
    ttlMs: 10,
    maxEntries: entryCount,
    maxBytes: stateSize * 5,
    now: () => now
  });
  let byteIteratorCreations = 0;
  const originalByteEntries = byteStore.entries.entries.bind(byteStore.entries);
  byteStore.entries.entries = () => {
    byteIteratorCreations++;
    return originalByteEntries();
  };
  byteStore.remember(calls.slice(0, 64), [state], 'scope');
  assert.equal(byteIteratorCreations, 1);
  assert.equal(byteStore.entries.size, 5);
  assert.equal(byteStore.bytes, stateSize * 5);
  assert.equal(byteStore.nextExpiryCount, 5);
  assert.deepEqual(byteStore.statesForCalls([calls[59]], 'claude', 'scope'), [state]);
  assert.deepEqual(byteStore.statesForCalls([calls[58]], 'claude', 'scope'), []);
});

test('Responses 多工具状态补回使用不冲突的唯一 reasoning item ID', () => {
  const store = new ReasoningStateStore();
  store.remember([{ id: 'call_a', name: 'first', arguments: { value: 1 } }], [{
    protocol: 'responses', kind: 'reasoning', value: { type: 'reasoning', encrypted_content: 'state-a' }
  }], 'scope');
  store.remember([{ id: 'call_b', name: 'second', arguments: { value: 2 } }], [{
    protocol: 'responses', kind: 'reasoning', value: { type: 'reasoning', encrypted_content: 'state-b' }
  }], 'scope');
  const injected = store.inject({ input: [
    { id: 'rs_bridge_0', type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    { type: 'function_call', call_id: 'call_a', name: 'first', arguments: '{"value":1}' },
    { type: 'function_call', call_id: 'call_b', name: 'second', arguments: '{"value":2}' }
  ] }, 'responses', 'responses', 'scope');
  const ids = injected.input.filter((item) => item.type === 'reasoning').map((item) => item.id);
  assert.deepEqual(ids, ['rs_bridge_1', 'rs_bridge_2']);
  assert.equal(new Set(injected.input.map((item) => item.id).filter(Boolean)).size, 3);
});

test('Responses 长工具历史只读取每个既有推理状态一次', () => {
  const store = new ReasoningStateStore();
  const existing = [];
  const calls = [];
  let encryptedContentReads = 0;
  for (let index = 0; index < 64; index++) {
    const id = `call_${index}`;
    const state = {
      protocol: 'responses', kind: 'reasoning',
      value: { type: 'reasoning', encrypted_content: `state_${index}` }
    };
    const encryptedContent = encodeReasoningState(state.protocol, state.kind, state.value);
    const item = { id: `reasoning_${index}`, type: 'reasoning', summary: [] };
    Object.defineProperty(item, 'encrypted_content', {
      enumerable: true,
      get() {
        encryptedContentReads++;
        return encryptedContent;
      }
    });
    existing.push(item);
    calls.push({ type: 'function_call', call_id: id });
    store.remember([id], [state], 'scope');
  }

  const sequence = [...existing, ...calls];
  let inputReads = 0;
  const observedInput = new Proxy(sequence, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) inputReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const body = { input: observedInput };
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  let mapCalls = 0;
  let filterCalls = 0;
  Array.prototype.map = function(...args) {
    mapCalls++;
    return originalMap.apply(this, args);
  };
  Array.prototype.filter = function(...args) {
    filterCalls++;
    return originalFilter.apply(this, args);
  };
  let result;
  try {
    result = store.inject(body, 'responses', 'responses', 'scope');
  } finally {
    Array.prototype.map = originalMap;
    Array.prototype.filter = originalFilter;
  }
  assert.equal(result, body);
  assert.equal(encryptedContentReads, existing.length);
  assert.equal(inputReads, sequence.length * 2);
  assert.equal(mapCalls, 0);
  assert.equal(filterCalls, 0);
});

test('并行工具调用聚合共享状态时只序列化一次并保持首次顺序', () => {
  const store = new ReasoningStateStore();
  let valueReads = 0;
  const value = { type: 'redacted_thinking' };
  Object.defineProperty(value, 'data', {
    enumerable: true,
    get() {
      valueReads++;
      return 'shared-state';
    }
  });
  const state = { protocol: 'claude', kind: 'redacted_thinking', value };
  const calls = Array.from({ length: 64 }, (_, index) => ({ id: `parallel_${index}` }));
  store.remember(calls, [state], 'scope');
  valueReads = 0;

  assert.deepEqual(store.statesForCalls(calls, 'claude', 'scope'), [state]);
  assert.equal(valueReads, 1);
});

test('大量并行工具状态查找共享一次时钟快照', () => {
  let currentTime = 100;
  let nowReads = 0;
  const store = new ReasoningStateStore({
    ttlMs: 10,
    now: () => {
      nowReads++;
      return currentTime;
    }
  });
  const calls = Array.from({ length: 512 }, (_, index) => ({ id: `clock_${index}` }));
  const state = {
    protocol: 'claude', kind: 'redacted_thinking',
    value: { type: 'redacted_thinking', data: 'clock-state' }
  };
  store.remember(calls, [state], 'scope');

  nowReads = 0;
  assert.deepEqual(store.statesForCalls(calls, 'claude', 'scope'), [state]);
  assert.equal(nowReads, 1, '同一批并行调用应共享一个未过期判断时间点');

  currentTime = 110;
  nowReads = 0;
  assert.deepEqual(store.statesForCalls(calls, 'claude', 'scope'), []);
  assert.equal(nowReads, 1, '同一批并行调用应共享一个过期判断时间点');

  nowReads = 0;
  assert.deepEqual(store.statesForCalls([], 'claude', 'scope'), []);
  assert.equal(nowReads, 0, '空调用列表无需读取时钟');

  nowReads = 0;
  assert.deepEqual(store.statesForCalls([{ id: 'missing' }], 'claude', 'scope'), []);
  assert.equal(nowReads, 0, '全部未命中的调用无需读取时钟');
});

test('工具参数指纹在缓存写入和查找中各只计算一次', () => {
  const store = new ReasoningStateStore();
  const state = {
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'cached-fingerprint-state' }
  };
  let argumentReads = 0;
  const argumentsValue = {};
  Object.defineProperty(argumentsValue, 'payload', {
    enumerable: true,
    get() {
      argumentReads++;
      return { nested: ['value'] };
    }
  });
  const call = { id: 'call_fingerprint', name: 'lookup', arguments: argumentsValue };

  store.remember([call], [state], 'scope');
  assert.equal(argumentReads, 1, '缓存写入不应为去重和作用域键重复计算参数指纹');

  argumentReads = 0;
  assert.deepEqual(store.statesForCalls([call], 'responses', 'scope'), [state]);
  assert.equal(argumentReads, 1, '缓存查找不应为去重和作用域键重复计算参数指纹');
});

test('精确状态命中只查表一次且仅在必要时查找 ID 回退', () => {
  const store = new ReasoningStateStore();
  const exactState = {
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'exact-lookup-state' }
  };
  const fallbackState = {
    protocol: 'responses', kind: 'reasoning',
    value: { type: 'reasoning', encrypted_content: 'fallback-lookup-state' }
  };
  const exactCall = { id: 'call_exact_lookup', name: 'lookup', arguments: { city: '上海' } };
  store.remember([exactCall], [exactState], 'scope');
  store.remember([{ id: 'call_fallback_lookup' }], [fallbackState], 'scope');

  let getCalls = 0;
  let hasCalls = 0;
  const originalGet = store.entries.get.bind(store.entries);
  const originalHas = store.entries.has.bind(store.entries);
  store.entries.get = (key) => {
    getCalls++;
    return originalGet(key);
  };
  store.entries.has = (key) => {
    hasCalls++;
    return originalHas(key);
  };

  assert.deepEqual(store.statesForCalls([exactCall], 'responses', 'scope'), [exactState]);
  assert.equal(getCalls, 1);
  assert.equal(hasCalls, 0);

  getCalls = 0;
  assert.deepEqual(store.statesForCalls([{
    id: 'call_fallback_lookup', name: 'lookup', arguments: { city: '北京' }
  }], 'responses', 'scope'), [fallbackState]);
  assert.equal(getCalls, 2);
  assert.equal(hasCalls, 0);

  getCalls = 0;
  assert.deepEqual(store.statesForCalls([{ id: 'call_fallback_lookup' }], 'responses', 'scope'), [fallbackState]);
  assert.equal(getCalls, 1);

  getCalls = 0;
  assert.deepEqual(store.statesForCalls([{
    id: 'call_missing_lookup', name: 'lookup', arguments: '{}'
  }], 'responses', 'scope'), []);
  assert.equal(getCalls, 2);
  assert.equal(hasCalls, 0);
});

test('相同工具调用 ID 按客户端与模型作用域隔离', () => {
  const store = new ReasoningStateStore();
  const first = { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: 'A', signature: 'a' } };
  const second = { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: 'B', signature: 'b' } };
  store.remember(['same_call'], [first], 'client-a\nmodel');
  store.remember(['same_call'], [second], 'client-b\nmodel');
  const body = { messages: [{ role: 'assistant', tool_calls: [{ id: 'same_call' }] }] };
  const injected = store.inject(body, 'chat', 'claude', 'client-a\nmodel');
  assert.deepEqual(decodeReasoningState(injected.messages[0].reasoning_details[0].data), first);
});

test('相同作用域和调用 ID 按工具名及规范化参数隔离并发状态', () => {
  const store = new ReasoningStateStore();
  const first = { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: 'A', signature: 'a' } };
  const second = { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: 'B', signature: 'b' } };
  store.remember([{ id: 'same_call', name: 'lookup', arguments: { city: '上海', unit: 'c' } }], [first], 'same-scope');
  store.remember([{ id: 'same_call', name: 'lookup', arguments: { city: '北京', unit: 'c' } }], [second], 'same-scope');

  const request = (city) => ({ messages: [{
    role: 'assistant', content: null,
    tool_calls: [{ id: 'same_call', type: 'function', function: {
      name: 'lookup', arguments: JSON.stringify({ unit: 'c', city })
    } }]
  }] });
  const shanghai = store.inject(request('上海'), 'chat', 'claude', 'same-scope');
  const beijing = store.inject(request('北京'), 'chat', 'claude', 'same-scope');
  assert.deepEqual(decodeReasoningState(shanghai.messages[0].reasoning_details[0].data), first);
  assert.deepEqual(decodeReasoningState(beijing.messages[0].reasoning_details[0].data), second);

  const mismatch = store.inject({ messages: [{
    role: 'assistant', content: null,
    tool_calls: [{ id: 'same_call', type: 'function', function: { name: 'other', arguments: '{}' } }]
  }] }, 'chat', 'claude', 'same-scope');
  assert.equal(mismatch.messages[0].reasoning_details, undefined);
});

test('超长工具身份只生成固定长度缓存键且仍可准确命中', () => {
  const store = new ReasoningStateStore();
  const state = { protocol: 'responses', kind: 'reasoning', value: {
    type: 'reasoning', summary: [], encrypted_content: 'opaque'
  } };
  const id = `call_${'x'.repeat(128 * 1024)}`;
  const args = { payload: 'y'.repeat(128 * 1024) };
  store.remember([{ id, name: 'large', arguments: args }], [state], 'scope');
  assert.equal([...store.entries.keys()][0].length, 43);

  const injected = store.inject({ input: [{
    type: 'function_call', call_id: id, name: 'large', arguments: JSON.stringify(args)
  }] }, 'responses', 'responses', 'scope');
  assert.deepEqual(decodeReasoningState(injected.input[0].encrypted_content), state);
});

test('深层工具参数指纹不依赖递归调用栈', () => {
  const store = new ReasoningStateStore();
  const state = { protocol: 'claude', kind: 'redacted_thinking', value: {
    type: 'redacted_thinking', data: 'opaque'
  } };
  let args = 'leaf';
  for (let depth = 0; depth < 20_000; depth++) args = [args];
  store.remember([{ id: 'deep_call', name: 'deep', arguments: args }], [state], 'scope');
  const injected = store.inject({ messages: [{
    role: 'assistant', content: [{ type: 'tool_use', id: 'deep_call', name: 'deep', input: args }]
  }] }, 'claude', 'claude', 'scope');
  assert.deepEqual(decodeReasoningState(injected.messages[0].content[0].data), state);
});
