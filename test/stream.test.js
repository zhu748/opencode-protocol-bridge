import test from 'node:test';
import assert from 'node:assert/strict';
import { chatStreamContentDeltas, createSseObserver, createSseTerminalTracker, MAX_SSE_EVENT_BYTES, MAX_TRANSLATED_STREAM_OUTPUT_ITEMS, MAX_TRANSLATED_STREAM_RETAINED_BYTES, MAX_TRANSLATED_TOOL_ARGUMENT_BYTES, observeSse, sanitizeSseErrorStream, SSE_HEARTBEAT_COMMENT, summarizeStreamBlocks, translateSse, withSseEventIdleTimeout, withSseHeartbeat } from '../src/stream.js';
import { normalizeUpstreamStreamError } from '../src/upstream-error.js';
import { decodeReasoningState, encodeReasoningState } from '../src/reasoning-state.js';

function responseFrom(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const [name, data] of events) controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(iterable) {
  let result = '';
  for await (const chunk of iterable) result += chunk;
  return result;
}

function holdingSseBody(text) {
  const encoder = new TextEncoder();
  let canceled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(text)); },
    cancel() { canceled = true; }
  });
  return { body, canceled: () => canceled };
}

test('同协议 SSE 在成功终态后立即停止并取消未关闭的上游正文', { timeout: 2_000 }, async () => {
  const cases = [
    ['Responses completed', 'responses', 'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"status":"completed"}}\n\n', /event: response\.completed/g],
    ['Responses incomplete', 'responses', 'event: response.incomplete\ndata: {"type":"response.incomplete","sequence_number":1,"response":{"status":"incomplete"}}\n\n', /event: response\.incomplete/g],
    ['Claude', 'claude', 'event: message_stop\ndata: {"type":"message_stop"}\n\n', /event: message_stop/g],
    ['Chat', 'chat', 'data: [DONE]\n\n', /data: \[DONE\]/g],
    ['Gemini', 'gemini', 'data: {"candidates":[{"index":0,"finishReason":"STOP"}]}\n\n', /"finishReason":"STOP"/g]
  ];

  for (const [label, protocol, terminal, terminalPattern] of cases) {
    const source = holdingSseBody(`${terminal}data: {"marker":"after-terminal"}\n\n`);
    const output = await collect(sanitizeSseErrorStream(source.body, protocol));
    assert.equal((output.match(terminalPattern) || []).length, 1, `${label} 只转发一次终态`);
    assert.doesNotMatch(output, /after-terminal/, `${label} 不转发终态后的事件`);
    assert.equal(source.canceled(), true, `${label} 主动释放未关闭的上游正文`);
  }
});

test('跨协议 canonical 在终态后立即结束且只生成一个下游终态', { timeout: 2_000 }, async () => {
  const cases = [
    ['Responses completed', 'responses', 'claude', [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_hold","model":"gpt","status":"in_progress"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_hold","model":"gpt","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
    ], /event: message_stop/g],
    ['Responses incomplete', 'responses', 'chat', [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_incomplete","model":"gpt","status":"in_progress"}}\n\n',
      'event: response.incomplete\ndata: {"type":"response.incomplete","sequence_number":1,"response":{"id":"resp_incomplete","model":"gpt","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
    ], /data: \[DONE\]/g],
    ['Claude', 'claude', 'responses', [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_hold","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ], /event: response\.completed/g],
    ['Chat', 'chat', 'responses', [
      'data: {"id":"chat_hold","object":"chat.completion.chunk","created":1,"model":"chat","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_hold","object":"chat.completion.chunk","created":1,"model":"chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ], /event: response\.completed/g],
    ['Gemini', 'gemini', 'responses', [
      'data: {"responseId":"gemini-hold","modelVersion":"gemini","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n'
    ], /event: response\.completed/g]
  ];

  for (const [label, sourceProtocol, targetProtocol, frames, terminalPattern] of cases) {
    const source = holdingSseBody(`${frames.join('')}data: {"marker":"after-terminal"}\n\n`);
    const output = await collect(translateSse({ body: source.body }, sourceProtocol, targetProtocol, 'fallback'));
    assert.equal((output.match(terminalPattern) || []).length, 1, `${label} 只生成一次下游终态`);
    assert.doesNotMatch(output, /after-terminal/, `${label} 不解析终态后的事件`);
    assert.equal(source.canceled(), true, `${label} 主动释放未关闭的上游正文`);
  }
});

test('跨协议累计保留内容限制会拒绝大量合法小 delta', async () => {
  const delta = 'x'.repeat(4 * 1024);
  const count = Math.ceil(MAX_TRANSLATED_STREAM_RETAINED_BYTES / delta.length) + 1;
  const events = [
    ['message', { id: 'chat_retained_limit', model: 'chat', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }],
    ...Array.from({ length: count }, () => ['message', {
      id: 'chat_retained_limit', model: 'chat',
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
    }])
  ];

  await assert.rejects(
    collect(translateSse(responseFrom(events), 'chat', 'responses', 'fallback')),
    (error) => error?.code === 'UPSTREAM_TRANSLATED_STREAM_TOO_LARGE'
  );
});

test('跨协议输出项数量限制会拒绝过多小工具调用', async () => {
  const toolCalls = Array.from({ length: MAX_TRANSLATED_STREAM_OUTPUT_ITEMS + 1 }, (_, index) => ({
    index, id: `call_${index}`, type: 'function',
    function: { name: `tool_${index}`, arguments: '{}' }
  }));
  const source = responseFrom([
    ['message', {
      id: 'chat_item_limit', model: 'chat',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }]
    }]
  ]);

  await assert.rejects(
    collect(translateSse(source, 'chat', 'responses', 'fallback')),
    (error) => error?.code === 'UPSTREAM_TRANSLATED_STREAM_TOO_LARGE'
  );
});

test('跨协议工具参数累计限制会拒绝许多合法小参数 delta', async () => {
  const delta = 'x'.repeat(4 * 1024);
  const count = Math.ceil(MAX_TRANSLATED_TOOL_ARGUMENT_BYTES / delta.length) + 1;
  const events = [
    ['message', {
      id: 'chat_tool_argument_limit', model: 'chat',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'call_limit', type: 'function', function: { name: 'run', arguments: '{"value":"' }
      }] }, finish_reason: null }]
    }],
    ...Array.from({ length: count }, () => ['message', {
      id: 'chat_tool_argument_limit', model: 'chat',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta } }] }, finish_reason: null }]
    }])
  ];

  await assert.rejects(
    collect(translateSse(responseFrom(events), 'chat', 'responses', 'fallback')),
    (error) => error?.code === 'UPSTREAM_TRANSLATED_STREAM_TOO_LARGE'
  );
});

test('跨协议常规长流仍可完成且每个合成 SSE 帧不超过单事件上限', async () => {
  const delta = '长'.repeat(1024);
  const count = Math.floor(MAX_TRANSLATED_STREAM_RETAINED_BYTES / 4 / Buffer.byteLength(JSON.stringify(delta), 'utf8'));
  const events = [
    ['message', { id: 'chat_long_ok', model: 'chat', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }],
    ...Array.from({ length: count }, () => ['message', {
      id: 'chat_long_ok', model: 'chat',
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
    }]),
    ['message', {
      id: 'chat_long_ok', model: 'chat',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: count }
    }]
  ];

  const output = await collect(translateSse(responseFrom(events), 'chat', 'responses', 'fallback'));
  assert.match(output, /event: response\.completed/);
  for (const frame of output.split('\n\n').filter(Boolean)) {
    assert.ok(Buffer.byteLength(`${frame}\n\n`, 'utf8') <= MAX_SSE_EVENT_BYTES);
  }
});

test('下游 SSE 终态跟踪只在协议终态完整写出后标记成功', () => {
  const responses = createSseTerminalTracker('responses');
  responses.write('event: response.completed\ndata: {"type":"response.comp');
  assert.equal(responses.outcome, undefined);
  responses.write('leted","response":{"status":"completed"}}\n\n');
  assert.equal(responses.outcome, 'success');

  const chat = createSseTerminalTracker('chat');
  chat.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
  assert.equal(chat.outcome, undefined);
  chat.write('data: [DONE]\n\n');
  assert.equal(chat.outcome, 'success');

  const claude = createSseTerminalTracker('claude');
  claude.write('event: message_delta\ndata: {"type":"message_delta"}\n\n');
  assert.equal(claude.outcome, undefined);
  claude.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.equal(claude.completed, true);

  const failed = createSseTerminalTracker('responses');
  failed.write('event: error\ndata: {"type":"error","message":"failed"}\n\n');
  assert.equal(failed.outcome, 'error');
});

test('流式终态汇总只迭代一次块表并保留各派生顺序', () => {
  const count = 512;
  let valuesCalls = 0;
  let nextCalls = 0;
  class ObservedMap extends Map {
    values() {
      valuesCalls++;
      const iterator = super.values();
      return {
        [Symbol.iterator]() { return this; },
        next() {
          nextCalls++;
          return iterator.next();
        }
      };
    }
  }
  const blocks = new ObservedMap();
  const expectedToolIds = [];
  const expectedProviderStates = [];
  const expectedOutputIds = [];
  const expectedGroundingTexts = [];
  for (let index = 0; index < count; index++) {
    const type = index === 0 ? 'refusal' : index % 3 === 0 ? 'tool' : 'text';
    const providerState = index % 5 === 0 ? { protocol: 'responses', kind: 'reasoning', value: { index } } : undefined;
    const item = index % 2 === 0 ? { id: `item_${index}` } : undefined;
    const block = {
      type, id: `call_${index}`, name: `tool_${index}`, arguments: `{"index":${index}}`,
      text: `part-${index}`,
      annotations: index === count - 1 ? [{
        type: 'url_citation', start_index: 0, end_index: 4,
        title: '来源', url: 'https://example.invalid/source'
      }] : [{ index }],
      providerState, item
    };
    blocks.set(index, block);
    if (type === 'tool') expectedToolIds.push(block.id);
    if (providerState) expectedProviderStates.push(providerState);
    if (item) expectedOutputIds.push(item.id);
    if (type === 'text') expectedGroundingTexts.push(block.text);
  }

  const summary = summarizeStreamBlocks(blocks, {
    collectReasoningState: true, collectOutput: true, collectGrounding: true
  });
  assert.equal(valuesCalls, 1);
  assert.equal(nextCalls, count + 1);
  assert.equal(summary.hasTools, true);
  assert.equal(summary.hasRefusal, true);
  assert.equal(summary.hasUrlCitations, true);
  assert.deepEqual(summary.toolCalls.map((call) => call.id), expectedToolIds);
  assert.deepEqual(summary.providerStates, expectedProviderStates);
  assert.deepEqual(summary.output.map((item) => item.id), expectedOutputIds);
  assert.deepEqual(summary.groundingParts.map((part) => part.text), expectedGroundingTexts);
});

test('Chat 流内容数组按协议严格度单遍或双遍提取', () => {
  const count = 512;
  const content = [];
  const expectedText = [];
  const expectedRefusal = [];
  for (let index = 0; index < count; index++) {
    if (index % 3 === 2) {
      const refusal = `refusal-${index}`;
      content.push({ type: 'refusal', refusal });
      expectedRefusal.push(refusal);
    } else {
      const text = `text-${index}`;
      content.push({ type: index % 3 === 0 ? 'text' : 'output_text', text });
      expectedText.push(text);
    }
  }

  let indexReads = 0;
  const observedContent = new Proxy(content, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexReads++;
      return Reflect.get(target, property, receiver);
    }
  });

  assert.deepEqual(chatStreamContentDeltas(observedContent), {
    text: expectedText.join(''), refusal: expectedRefusal.join('')
  });
  assert.equal(indexReads, count);

  indexReads = 0;
  assert.deepEqual(chatStreamContentDeltas(observedContent, true), {
    text: expectedText.join(''), refusal: expectedRefusal.join('')
  });
  assert.equal(indexReads, count * 2);

  assert.deepEqual(chatStreamContentDeltas('plain text', true), { text: 'plain text', refusal: '' });
  assert.throws(
    () => chatStreamContentDeltas([{ type: 'text', text: 1 }, { type: 'vendor_content' }], true),
    (error) => error?.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /vendor_content/.test(error.message)
  );
});

test('Claude 与 Chat 工具终态使用单调标记且不重复扫描缓存表', async () => {
  const sources = [
    ['Claude', 'claude', responseFrom([
      ['message_start', { type: 'message_start', message: { id: 'msg_tool_presence', model: 'claude', content: [], usage: { input_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_tool_presence', name: 'lookup', input: { q: 'x' } } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }]
    ])],
    ['Chat', 'chat', responseFrom([
      ['message', { id: 'chat_tool_presence', model: 'chat', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_tool_presence', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, finish_reason: null }] }],
      ['message', { id: 'chat_tool_presence', model: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
    ])]
  ];
  const originalValues = Map.prototype.values;
  for (const [label, protocol, source] of sources) {
    let valuesCalls = 0;
    Map.prototype.values = function(...args) {
      valuesCalls++;
      return originalValues.apply(this, args);
    };
    try {
      const output = await collect(translateSse(source, protocol, 'responses', 'alias'));
      assert.match(output, /response\.completed/);
    } finally {
      Map.prototype.values = originalValues;
    }
    assert.equal(valuesCalls, 1, `${label} 仅允许终态输出汇总读取一次 Map.values()`);
  }

  const emptyToolShells = responseFrom([
    ['message', { id: 'chat_empty_tools', model: 'chat', choices: [{ index: 0, delta: { tool_calls: Array.from({ length: 512 }, (_, index) => ({ index })) }, finish_reason: null }] }],
    ['message', { id: 'chat_empty_tools', model: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
  ]);
  let terminalValuesCalls = 0;
  let terminalSetCalls = 0;
  const originalSet = Map.prototype.set;
  Map.prototype.values = function(...args) {
    terminalValuesCalls++;
    return originalValues.apply(this, args);
  };
  Map.prototype.set = function(...args) {
    terminalSetCalls++;
    return originalSet.apply(this, args);
  };
  try {
    await assert.rejects(
      collect(translateSse(emptyToolShells, 'chat', 'claude', 'alias')),
      (error) => error?.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /没有工具调用/.test(error.message)
    );
  } finally {
    Map.prototype.values = originalValues;
    Map.prototype.set = originalSet;
  }
  assert.equal(terminalValuesCalls, 0);
  assert.equal(terminalSetCalls, 0);
});

test('SSE 心跳等待同一个上游读取且不抢占真实事件', async () => {
  let nextCalls = 0;
  let returnCalls = 0;
  let heartbeatCount = 0;
  let resolvePending;
  const stalled = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          nextCalls++;
          return new Promise((resolve) => { resolvePending = resolve; });
        },
        async return() {
          returnCalls++;
          resolvePending?.({ done: true });
          return { done: true };
        }
      };
    }
  };
  const heartbeat = withSseHeartbeat(stalled, 20, { onHeartbeat: () => { heartbeatCount++; } })[Symbol.asyncIterator]();
  assert.deepEqual(await heartbeat.next(), { value: SSE_HEARTBEAT_COMMENT, done: false });
  assert.equal(heartbeatCount, 0, '仅生成但尚未由消费者确认的心跳不应计数');
  assert.deepEqual(await heartbeat.next(), { value: SSE_HEARTBEAT_COMMENT, done: false });
  assert.equal(heartbeatCount, 1);
  assert.equal(nextCalls, 1);
  resolvePending({ value: 'data: delayed\n\n', done: false });
  assert.deepEqual(await heartbeat.next(), { value: 'data: delayed\n\n', done: false });
  assert.equal(heartbeatCount, 2);
  await heartbeat.return();
  assert.equal(returnCalls, 1);

  let abandonedHeartbeatCount = 0;
  let resolveAbandoned;
  const abandonedSource = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise((resolve) => { resolveAbandoned = resolve; }),
        return: async () => { resolveAbandoned?.({ done: true }); return { done: true }; }
      };
    }
  };
  const abandoned = withSseHeartbeat(abandonedSource, 20, { onHeartbeat: () => { abandonedHeartbeatCount++; } })[Symbol.asyncIterator]();
  assert.deepEqual(await abandoned.next(), { value: SSE_HEARTBEAT_COMMENT, done: false });
  await abandoned.return();
  assert.equal(abandonedHeartbeatCount, 0, '消费者在写出前结束时不能把心跳记作已送达');

  const cancellation = new AbortController();
  let cancellationCalls = 0;
  let stalledClosed = false;
  async function* abortableStalledSource() {
    try {
      await new Promise((_, reject) => cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true }));
      yield 'data: unreachable\n\n';
    } finally {
      stalledClosed = true;
    }
  }
  const abortable = withSseHeartbeat(abortableStalledSource(), 20, {
    onCancel: () => { cancellationCalls++; cancellation.abort(new Error('consumer stopped')); }
  })[Symbol.asyncIterator]();
  assert.deepEqual(await abortable.next(), { value: SSE_HEARTBEAT_COMMENT, done: false });
  await Promise.race([
    abortable.return(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('消费者取消后挂起来源未及时退出')), 250))
  ]);
  assert.equal(cancellationCalls, 1);
  assert.equal(cancellation.signal.aborted, true);
  assert.equal(stalledClosed, true);

  async function* immediate() { yield 'data: real\n\n'; }
  let normalCancellationCalls = 0;
  assert.equal(await collect(withSseHeartbeat(immediate(), 100, { onCancel: () => { normalCancellationCalls++; } })), 'data: real\n\n');
  assert.equal(await collect(withSseHeartbeat(immediate(), 0, { onCancel: () => { normalCancellationCalls++; } })), 'data: real\n\n');
  assert.equal(normalCancellationCalls, 0, '来源正常完成时不应中止上游');
  let failedCancellationCalls = 0;
  await assert.rejects(collect(withSseHeartbeat((async function* () { throw new Error('source failed'); })(), 100, {
    onCancel: () => { failedCancellationCalls++; }
  })), /source failed/);
  assert.equal(failedCancellationCalls, 0, '来源自身报错时不应重复触发消费者取消');
  await assert.rejects(collect(withSseHeartbeat(immediate(), -1)), /非负整数/);
  await assert.rejects(collect(withSseHeartbeat(immediate(), 10, { comment: 'data: not-comment\n\n' })), /注释帧/);
  await assert.rejects(collect(withSseHeartbeat(immediate(), 10, { onHeartbeat: true })), /回调必须是函数/);
  await assert.rejects(collect(withSseHeartbeat(immediate(), 10, { onCancel: true })), /取消回调必须是函数/);

  let stubbornCanceled = 0;
  const stubborn = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: () => new Promise(() => {})
      };
    }
  };
  const bounded = withSseHeartbeat(stubborn, 20, { onCancel: () => { stubbornCanceled++; } })[Symbol.asyncIterator]();
  assert.deepEqual(await bounded.next(), { value: SSE_HEARTBEAT_COMMENT, done: false });
  await Promise.race([
    bounded.return(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('消费者取消不应无限等待上游 iterator.return')), 500))
  ]);
  assert.equal(stubbornCanceled, 1);
});

test('SSE 有效事件空闲超时忽略注释心跳并由真实事件重置', async () => {
  let returned = 0;
  let timeoutCode;
  const comments = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { value: ': upstream keep-alive\n\n', done: false };
        },
        async return() { returned++; return { done: true }; }
      };
    }
  };
  const commentsOnly = withSseEventIdleTimeout(comments, 50, {
    isActivity: (chunk) => !String(chunk).startsWith(':'),
    onTimeout: (error) => { timeoutCode = error.code; }
  });
  await assert.rejects(collect(commentsOnly), (error) => error?.code === 'UPSTREAM_STREAM_EVENT_IDLE_TIMEOUT');
  assert.equal(timeoutCode, 'UPSTREAM_STREAM_EVENT_IDLE_TIMEOUT');
  assert.equal(returned, 1);

  async function* active() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield 'data: one\n\n';
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield 'data: two\n\n';
  }
  let activities = 0;
  assert.equal(await collect(withSseEventIdleTimeout(active(), 50, {
    onActivity: () => { activities++; }
  })), 'data: one\n\ndata: two\n\n');
  assert.equal(activities, 2);

  await assert.rejects(collect(withSseEventIdleTimeout(active(), -1)), /非负整数/);
  await assert.rejects(collect(withSseEventIdleTimeout(active(), 10, { isActivity: true })), /判定必须是函数/);
  await assert.rejects(collect(withSseEventIdleTimeout(active(), 10, { onActivity: true })), /回调必须是函数/);
  await assert.rejects(collect(withSseEventIdleTimeout(active(), 10, { onTimeout: true })), /超时回调必须是函数/);
});

test('Claude SSE 可逐事件转换为 Responses SSE', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-test', usage: { input_tokens: 5 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  const responseTools = [{ type: 'function', name: 'lookup', description: '查找信息', parameters: { type: 'object' } }];
  const output = await collect(translateSse(source, 'claude', 'responses', 'alias', {
    responsesOptions: {
      parallelToolCalls: false, toolChoice: { type: 'function', name: 'lookup' }, tools: responseTools,
      instructions: '流式规则', metadata: { trace: 'stream' }, temperature: 0.3, topP: 0.7,
      maxOutputTokens: 256, reasoning: { effort: 'medium' }, store: false,
      text: { format: { type: 'text' }, verbosity: 'low' }, truncation: 'disabled'
    }
  }));
  assert.match(output, /response\.created/);
  assert.match(output, /response\.output_text\.delta/);
  assert.match(output, /"delta":"你"/);
  assert.match(output, /"delta":"好"/);
  assert.match(output, /response\.completed/);
  assert.match(output, /"output_tokens":2/);
  const events = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.equal(events[0].response.parallel_tool_calls, false);
  assert.deepEqual(events[0].response.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(events[0].response.tools, responseTools);
  assert.equal(events[0].response.error, null);
  assert.equal(events[0].response.incomplete_details, null);
  assert.equal(events[0].response.instructions, '流式规则');
  assert.deepEqual(events[0].response.metadata, { trace: 'stream' });
  assert.equal(events[0].response.temperature, 0.3);
  assert.equal(events[0].response.top_p, 0.7);
  assert.equal(events[0].response.max_output_tokens, 256);
  assert.deepEqual(events[0].response.reasoning, { effort: 'medium' });
  assert.equal('completed_at' in events[0].response, false);
  assert.ok(events.filter((event) => event.type === 'response.output_text.delta').every((event) => Array.isArray(event.logprobs)));
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.parallel_tool_calls, false);
  assert.deepEqual(completed.response.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(completed.response.tools, responseTools);
  assert.ok(Number.isSafeInteger(completed.response.completed_at));
  assert.ok(completed.response.completed_at >= completed.response.created_at);
  assert.equal(completed.response.end_turn, true);
  assert.equal(events.find((event) => event.type === 'response.output_item.done').item.phase, 'final_answer');
  assert.deepEqual(completed.response.usage.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 });
  assert.deepEqual(completed.response.usage.output_tokens_details, { reasoning_tokens: 0 });
});

test('Claude SSE 跨协议会报告响应元数据降级并保留缓存 TTL usage', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: {
      id: 'msg_metadata', type: 'message', role: 'assistant', model: 'claude-test', content: [],
      container: { id: 'container_1' }, context_management: { applied_edits: [] }, diagnostics: { cache: { status: 'miss' } },
      stop_reason: null, stop_sequence: null,
      usage: {
        input_tokens: 9, output_tokens: 0, cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
        inference_geo: 'us', service_tier: 'standard'
      }
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', context_management: { applied_edits: [{ type: 'clear_thinking_20251015' }] },
      delta: { stop_reason: 'end_turn', stop_sequence: null, container: { id: 'container_1' }, stop_details: null },
      usage: { output_tokens: 2, iterations: [], server_tool_use: { web_search_requests: 1 } }
    }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let usage;
  const degradations = new Set();
  await collect(translateSse(source, 'claude', 'responses', 'alias', {
    onUsage: (value) => { usage = value; },
    onResponseDegradations: (values) => values.forEach((value) => degradations.add(value))
  }));
  assert.deepEqual(usage, {
    inputTokens: 9, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 5,
    cacheCreation5mInputTokens: 3, cacheCreation1hInputTokens: 2, reasoningTokens: 0
  });
  assert.deepEqual([...degradations], [
    'claude_container', 'claude_context_management', 'claude_diagnostics',
    'claude_cache_creation_ttl', 'claude_inference_geo', 'claude_usage_service_tier',
    'claude_iterations', 'claude_server_tool_use'
  ]);
});

test('Claude 多个累计 message_delta 等到 message_stop 后只完成一次', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_multi_delta', model: 'claude-test', content: [], usage: { input_tokens: 4 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 2 } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 1 } } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'claude', 'responses', 'alias', {
    onUsage: (value) => { usage = value; }
  }));
  assert.equal((output.match(/event: response\.completed/g) || []).length, 1);
  assert.match(output, /"output_tokens":5/);
  assert.deepEqual(usage, { inputTokens: 4, outputTokens: 5, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 1 });
});

test('Claude content_block_start 的非空文本和完整工具 input 可直接转换', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_initial_content', model: 'claude-test', content: [], usage: { input_tokens: 2 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '起始文本' } }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_initial', name: 'lookup', input: { q: '起始参数' } } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'claude', 'chat', 'alias', {
    onReasoningState: (value) => { reasoningState = value; }
  }));
  assert.equal((output.match(/起始文本/g) || []).length, 1);
  assert.match(output, /"name":"lookup"/);
  assert.deepEqual(reasoningState.toolCalls, [{ id: 'call_initial', name: 'lookup', arguments: '{"q":"起始参数"}' }]);
  assert.match(output, /"finish_reason":"tool_calls"/);
});

test('Claude 空文本块不会生成可被 Codex 重放的空 Responses message', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_empty', model: 'claude-test', content: [], usage: { input_tokens: 2 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);

  const output = await collect(translateSse(source, 'claude', 'responses', 'claude-test'));
  const events = output.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  assert.equal(events.some((event) => event.type === 'response.output_item.added'), false);
  assert.equal(events.some((event) => event.type === 'response.output_item.done'), false);
  assert.deepEqual(events.find((event) => event.type === 'response.completed').response.output, []);
});

test('Claude fallback 边界跨协议保留并更新最终服务模型', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_fallback', model: 'claude-primary', content: [], usage: { input_tokens: 3 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'fallback', from: { model: 'claude-primary' }, to: { model: 'claude-fallback' }
    } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回退回答' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'claude', 'responses', 'alias', {
    onReasoningState: (value) => { reasoningState = value; }
  }));
  const events = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  assert.equal(events.find((event) => event.type === 'response.created').response.model, 'claude-primary');
  assert.equal(events.find((event) => event.type === 'response.completed').response.model, 'claude-fallback');
  assert.match(output, /回退回答/);
  assert.equal(reasoningState.providerStates.length, 1);
  assert.equal(reasoningState.providerStates[0].kind, 'fallback');
});

test('Claude compaction 流把摘要与加密元数据一起转换并保留续轮状态', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_compaction', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120000 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null, encrypted_content: null } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: '压缩后的会话摘要', encrypted_content: 'opaque-compaction-state' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'compaction', stop_sequence: null }, usage: { output_tokens: 800 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'claude', 'responses', 'claude-test', {
    responsesOptions: { includeObfuscation: false },
    onReasoningState: (value) => { reasoningState = value; }
  }));
  const events = output.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  assert.equal(events.find((event) => event.type === 'response.reasoning_summary_text.delta').delta, '压缩后的会话摘要');
  const item = events.find((event) => event.type === 'response.output_item.done').item;
  assert.equal(item.summary[0].text, '压缩后的会话摘要');
  assert.deepEqual(decodeReasoningState(item.encrypted_content), {
    protocol: 'claude', kind: 'compaction',
    value: { type: 'compaction', content: '压缩后的会话摘要', encrypted_content: 'opaque-compaction-state' }
  });
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.deepEqual(events.at(-1).response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(reasoningState.providerStates[0].kind, 'compaction');
});

test('Claude 内容块乱序、类型漂移或完整 input 后继续增量时明确失败', async () => {
  const beforeStart = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_bad_order', model: 'claude-test', content: [] } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '错误' } }]
  ]);
  await assert.rejects(
    () => collect(translateSse(beforeStart, 'claude', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /尚未开始/.test(error.message)
  );

  const wrongType = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_bad_type', model: 'claude-test', content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }]
  ]);
  await assert.rejects(
    () => collect(translateSse(wrongType, 'claude', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /input_json_delta/.test(error.message)
  );

  const duplicatedInput = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_duplicate_input', model: 'claude-test', content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_dup', name: 'lookup', input: { q: '完整' } } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"重复"}' } }]
  ]);
  await assert.rejects(
    () => collect(translateSse(duplicatedInput, 'claude', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /完整 input/.test(error.message)
  );
});

test('Chat SSE 工具调用可转换为 Claude SSE', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_1', model: 'kimi', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run', arguments: '' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_1', model: 'kimi', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"dir"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_1', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /content_block_start/);
  assert.match(output, /"name":"run"/);
  assert.match(output, /partial_json/);
  assert.match(output, /"stop_reason":"tool_use"/);
});

test('Chat SSE 的 Codex namespace 工具别名可还原为 Responses namespace 调用', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_namespace', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_ns', function: { name: 'multi_agent_v1__spawn_agent', arguments: '{"task":' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_namespace', model: 'deepseek-v4-flash', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"检查"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_namespace', model: 'deepseek-v4-flash', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }]
  ]);
  const tools = [{
    type: 'namespace', name: 'multi_agent_v1', description: '管理子代理', tools: [
      { type: 'function', name: 'spawn_agent', description: '创建子代理', parameters: { type: 'object' } }
    ]
  }];
  const output = await collect(translateSse(source, 'chat', 'responses', 'deepseek-v4-flash', { responsesOptions: { tools } }));
  const events = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  const added = events.find((event) => event.type === 'response.output_item.added');
  const done = events.find((event) => event.type === 'response.output_item.done');
  assert.equal(added.item.namespace, 'multi_agent_v1');
  assert.equal(added.item.name, 'spawn_agent');
  assert.equal(done.item.namespace, 'multi_agent_v1');
  assert.equal(done.item.name, 'spawn_agent');
  assert.equal(done.item.arguments, '{"task":"检查"}');
  assert.equal(events.find((event) => event.type === 'response.completed').response.end_turn, false);
});

test('Chat SSE 的 Sol namespaced custom alias 可还原为带 namespace 的 custom_tool_call', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_custom_namespace', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_exec', function: { name: 'functions__exec', arguments: '{"input":"text(' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_custom_namespace', model: 'deepseek-v4-flash', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '\\"STREAM_OK\\")"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_custom_namespace', model: 'deepseek-v4-flash', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }]
  ]);
  const tools = [{
    type: 'namespace', name: 'functions', tools: [{
      type: 'custom', name: 'exec', description: 'Run code',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
    }]
  }];
  const output = await collect(translateSse(source, 'chat', 'responses', 'deepseek-v4-flash', {
    responsesOptions: { tools, parallelToolCalls: false }
  }));
  const events = output.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  const added = events.find((event) => event.type === 'response.output_item.added');
  const done = events.find((event) => event.type === 'response.output_item.done');
  assert.deepEqual({ type: added.item.type, namespace: added.item.namespace, name: added.item.name }, {
    type: 'custom_tool_call', namespace: 'functions', name: 'exec'
  });
  assert.equal(done.item.namespace, 'functions');
  assert.equal(done.item.name, 'exec');
  assert.equal(done.item.input, 'text("STREAM_OK")');
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta'), false);
});

test('Responses 流式大工具表只为全部并行调用构建一次别名索引', async () => {
  const count = 128;
  const children = Array.from({ length: count }, (_, index) => ({
    type: 'function', name: `tool_${index}`, parameters: { type: 'object' }
  }));
  let namespaceToolReads = 0;
  const namespace = {
    type: 'namespace', name: 'workspace',
    get tools() {
      namespaceToolReads++;
      return children;
    }
  };
  const source = responseFrom([
    ['message', { id: 'chat_many_namespace', model: 'deepseek-v4-flash', choices: [{
      delta: {
        role: 'assistant',
        tool_calls: Array.from({ length: count }, (_, index) => ({
          index, id: `call_${index}`, type: 'function',
          function: { name: `workspace__tool_${index}`, arguments: `{"index":${index}}` }
        }))
      },
      finish_reason: null
    }] }],
    ['message', { id: 'chat_many_namespace', model: 'deepseek-v4-flash', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'responses', 'deepseek-v4-flash', {
    responsesOptions: { tools: [namespace], includeObfuscation: false }
  }));
  const events = output.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  const added = events.filter((event) => event.type === 'response.output_item.added');
  const done = events.filter((event) => event.type === 'response.output_item.done');

  assert.equal(added.length, count);
  assert.equal(done.length, count);
  assert.equal(added.at(-1).item.namespace, 'workspace');
  assert.equal(done.at(-1).item.name, `tool_${count - 1}`);
  assert.ok(namespaceToolReads <= count * 3, `流式别名索引不应为每个调用重建工具表：${namespaceToolReads}`);
});

test('Chat SSE 可还原 Codex custom tool 与 client tool_search 调用', async () => {
  const customTools = [{ type: 'custom', name: 'apply_patch', description: '应用补丁' }];
  const custom = responseFrom([
    ['message', { id: 'chat_custom', model: 'deepseek', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_custom', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' Patch"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_custom', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }]
  ]);
  const customOutput = await collect(translateSse(custom, 'chat', 'responses', 'alias', { responsesOptions: { tools: customTools } }));
  assert.match(customOutput, /response\.custom_tool_call_input\.done/);
  assert.match(customOutput, /"type":"custom_tool_call"/);
  assert.match(customOutput, /"input":"\*\*\* Begin Patch"/);
  assert.doesNotMatch(customOutput, /response\.function_call_arguments\.delta/);

  const searchTools = [{ type: 'tool_search', execution: 'client', description: '搜索工具', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
  const search = responseFrom([
    ['message', { id: 'chat_search', model: 'deepseek', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_search', type: 'function', function: { name: 'tool_search', arguments: '{"query":"tests"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_search', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }]
  ]);
  const searchOutput = await collect(translateSse(search, 'chat', 'responses', 'alias', { responsesOptions: { tools: searchTools } }));
  assert.match(searchOutput, /"type":"tool_search_call"/);
  assert.match(searchOutput, /"execution":"client"/);
  assert.match(searchOutput, /"arguments":\{"query":"tests"\}/);
});

test('Chat SSE 并行工具调用保留独立索引和参数', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_parallel', model: 'kimi', choices: [{ delta: { role: 'assistant', tool_calls: [
      { index: 0, id: 'call_a', function: { name: 'first', arguments: '{"a":1}' } },
      { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"b":2}' } }
    ] }, finish_reason: null }] }],
    ['message', { id: 'chat_parallel', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 4 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /"index":0,"content_block":\{"type":"tool_use","id":"call_a","name":"first"/);
  assert.match(output, /"index":1,"content_block":\{"type":"tool_use","id":"call_b","name":"second"/);
  assert.match(output, /"partial_json":"\{\\"a\\":1\}"/);
  assert.match(output, /"partial_json":"\{\\"b\\":2\}"/);
});

test('Chat SSE 工具参数先于 id 和 name 到达时会缓冲', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_late', model: 'kimi', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_late', model: 'kimi', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_late', function: { name: 'get_weather', arguments: '"上海"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_late', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /"id":"call_late","name":"get_weather"/);
  assert.match(output, /"partial_json":"\{\\"city\\":\\"上海\\"\}"/);
  assert.equal((output.match(/content_block_start/g) || []).length, 2, '事件名和 type 字段应各出现一次');
});

test('流式 Read 工具会移除空 pages 参数', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_read', model: 'gpt', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'Read', arguments: '{"file_path":"demo.js",' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_read', model: 'gpt', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pages":""}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_read', model: 'gpt', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /partial_json.*file_path/);
  assert.doesNotMatch(output, /pages/);
});

test('Claude SSE 文本与工具调用转换为 Chat 时工具索引连续且名称不重复', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_2', model: 'claude', usage: { input_tokens: 2 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '调用' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'run', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }]
  ]);
  const output = await collect(translateSse(source, 'claude', 'chat', 'alias'));
  assert.match(output, /"index":0,"id":"c1"/);
  assert.equal((output.match(/"name":"run"/g) || []).length, 1);
  assert.match(output, /"arguments":"\{\\"x\\":"/);
  assert.match(output, /data: \[DONE\]/);
});

test('Chat SSE 文本可转换为 Responses SSE', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_2', model: 'kimi', choices: [{ delta: { role: 'assistant', content: 'A' }, finish_reason: null }] }],
    ['message', { id: 'chat_2', model: 'kimi', choices: [{ delta: { content: 'B' }, finish_reason: null }] }],
    ['message', { id: 'chat_2', model: 'kimi', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'responses', 'alias'));
  assert.match(output, /response\.created/);
  assert.match(output, /"delta":"A"/);
  assert.match(output, /"delta":"B"/);
  assert.match(output, /response\.completed/);
});

test('Gemini 原生 SSE 的思考、文本、搜索引用和 usage 可转换为 Responses', async () => {
  const source = responseFrom([
    ['message', {
      responseId: 'gemini_native_1', modelVersion: 'gemini-3.6-flash',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '分析', thought: true, thoughtSignature: 'sig_native_1' }] } }],
      usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 2 }
    }],
    ['message', { responseId: 'gemini_native_1', modelVersion: 'gemini-3.6-flash', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '你' }] } }] }],
    ['message', { responseId: 'gemini_native_1', modelVersion: 'gemini-3.6-flash', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '好' }] } }] }],
    ['message', {
      responseId: 'gemini_native_1', modelVersion: 'gemini-3.6-flash',
      candidates: [{
        index: 0, finishReason: 'STOP',
        groundingMetadata: {
          webSearchQueries: ['问候语来源'],
          groundingChunks: [{ web: { uri: 'https://example.invalid/hello', title: '来源' } }],
          groundingSupports: [{ segment: { startIndex: 0, endIndex: 2, text: '你好' }, groundingChunkIndices: [0] }]
        }
      }],
      usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 2, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 8 }
    }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'gemini', 'responses', 'fallback', { onUsage: (value) => { usage = value; } }));
  assert.match(output, /response\.reasoning_summary_text\.delta/);
  assert.equal((output.match(/"delta":"你"/g) || []).length, 1);
  assert.equal((output.match(/"delta":"好"/g) || []).length, 1);
  const annotationPosition = output.indexOf('response.output_text.annotation.added');
  const textDonePosition = output.indexOf('response.output_text.done');
  assert.ok(annotationPosition >= 0 && annotationPosition < textDonePosition);
  assert.match(output, /https:\/\/example\.invalid\/hello/);
  const completedBlock = output.split(/\n\n/).find((block) => block.includes('event: response.completed'));
  const completed = JSON.parse(completedBlock.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(completed.response.id, 'gemini_native_1');
  assert.equal(completed.response.model, 'gemini-3.6-flash');
  assert.deepEqual(completed.response.usage, {
    input_tokens: 5, output_tokens: 3, total_tokens: 8,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 1 }
  });
  assert.deepEqual(usage, {
    inputTokens: 5, outputTokens: 3, cachedInputTokens: 2,
    cacheCreationInputTokens: 0, reasoningTokens: 1
  });
});

test('Gemini 原生 SSE 的函数调用可转换为 Claude，损坏候选和残缺流会失败', async () => {
  const toolSource = responseFrom([
    ['message', {
      responseId: 'gemini_tool_1', modelVersion: 'gemini-3.6-flash',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { city: '上海' } }, thoughtSignature: 'sig_tool_1' }] } }]
    }],
    ['message', {
      responseId: 'gemini_tool_1', modelVersion: 'gemini-3.6-flash',
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }
    }]
  ]);
  const output = await collect(translateSse(toolSource, 'gemini', 'claude', 'fallback'));
  assert.match(output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(output, /"partial_json":"\{\\"city\\":\\"上海\\"\}"/);
  assert.match(output, /"stop_reason":"tool_use"/);

  await assert.rejects(collect(translateSse(responseFrom([['message', {
    candidates: [
      { index: 0, content: { role: 'model', parts: [{ text: '一' }] } },
      { index: 1, content: { role: 'model', parts: [{ text: '二' }] } }
    ]
  }]]), 'gemini', 'chat', 'fallback')), /只能保留一个候选/);
  const incomplete = await collect(translateSse(responseFrom([['message', {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '未完成' }] } }]
  }]]), 'gemini', 'responses', 'fallback'));
  assert.match(incomplete, /上游 SSE 在完成事件前结束/);
});

test('同协议 Gemini SSE 观察器提取原生 usage', async () => {
  const observed = await observeSse(responseFrom([
    ['message', { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '完成' }] } }] }],
    ['message', {
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, cachedContentTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 10 }
    }]
  ]), 'gemini', 'gemini-3.6-flash');
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, {
    inputTokens: 7, outputTokens: 3, cachedInputTokens: 3,
    cacheCreationInputTokens: 0, reasoningTokens: 1
  });
});

test('Chat SSE 文本、工具和 usage 可转换为 Gemini SSE', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_gemini', model: 'kimi', choices: [{
      delta: { role: 'assistant', content: '正在查询' }, finish_reason: null,
      logprobs: { content: [{ token: '正在', logprob: -0.25, top_logprobs: [{ token: '正在', logprob: -0.25 }, { token: '开始', logprob: -1.25 }] }] }
    }] }],
    ['message', { id: 'chat_gemini', model: 'kimi', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_weather', function: { name: 'weather', arguments: '{"city":"上海"}' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_gemini', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 3 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'gemini', 'alias'));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  assert.ok(chunks.every((chunk) => chunk.responseId === 'chat_gemini'));
  assert.ok(chunks.every((chunk) => chunk.modelVersion === 'kimi'));
  assert.equal(chunks[0].candidates[0].content.parts[0].text, '正在查询');
  assert.equal(chunks[0].candidates[0].avgLogprobs, -0.25);
  assert.deepEqual(chunks[0].candidates[0].logprobsResult, {
    topCandidates: [{ candidates: [{ token: '正在', logProbability: -0.25 }, { token: '开始', logProbability: -1.25 }] }],
    chosenCandidates: [{ token: '正在', logProbability: -0.25 }],
    logProbabilitySum: -0.25
  });
  assert.deepEqual(chunks[1].candidates[0].content.parts[0].functionCall, { name: 'weather', args: { city: '上海' }, id: 'call_weather' });
  assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP');
  assert.deepEqual(chunks.at(-1).usageMetadata, { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 });
  assert.ok(chunks.slice(0, -1).every((chunk) => !('usageMetadata' in chunk)));
  assert.doesNotMatch(output, /\[DONE\]/);
});

test('Gemini SSE 的思考、提供商状态和终态共享稳定响应元数据', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_gemini_metadata', model: 'claude-primary', content: [], usage: { input_tokens: 3 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'fallback', from: { model: 'claude-primary' }, to: { model: 'claude-fallback' }
    } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '分析中' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig_1' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2, output_tokens_details: { thinking_tokens: 2 } } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  const output = await collect(translateSse(source, 'claude', 'gemini', 'alias'));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.responseId === 'msg_gemini_metadata'));
  assert.ok(chunks.every((chunk) => chunk.modelVersion === 'claude-fallback'));
  const thought = chunks.map((chunk) => chunk.candidates?.[0]?.content?.parts?.[0])
    .find((part) => part?.text === '分析中');
  assert.equal(thought.thought, true);
  assert.ok(chunks.some((chunk) => typeof chunk.candidates?.[0]?.content?.parts?.[0]?.thoughtSignature === 'string'));
  assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP');
  assert.deepEqual(chunks.at(-1).usageMetadata, {
    promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 5, thoughtsTokenCount: 2
  });
});

test('Claude SSE 复合推理状态只绑定到首个并行 Gemini functionCall', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_gemini_parallel_state', model: 'claude-test', content: [], usage: { input_tokens: 4 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '需要并行查询' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_parallel' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque_parallel' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_a', name: 'first', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"value":1}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_b', name: 'second', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"value":2}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 3 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  const output = await collect(translateSse(source, 'claude', 'gemini', 'alias'));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  const callParts = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || [])
    .filter((part) => part.functionCall);
  assert.deepEqual(callParts.map((part) => part.functionCall), [
    { name: 'first', args: { value: 1 }, id: 'call_a' },
    { name: 'second', args: { value: 2 }, id: 'call_b' }
  ]);
  assert.equal(callParts.filter((part) => typeof part.thoughtSignature === 'string').length, 1);
  assert.equal(callParts[1].thoughtSignature, undefined);
  const bundled = decodeReasoningState(callParts[0].thoughtSignature);
  assert.equal(bundled.protocol, 'bridge');
  assert.equal(bundled.kind, 'bundle');
  assert.deepEqual(bundled.value.states.map(({ protocol, kind }) => ({ protocol, kind })), [
    { protocol: 'claude', kind: 'thinking' },
    { protocol: 'claude', kind: 'redacted_thinking' }
  ]);
});

test('Gemini SSE 会把上游工具别名还原为客户端原始函数名', async () => {
  const original = `lookup_${'x'.repeat(80)}`;
  const alias = 'lookup_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx__gemini_0';
  const source = responseFrom([
    ['message', { id: 'chat_gemini_alias', model: 'chat-test', choices: [{ delta: {
      tool_calls: [{ index: 0, id: 'call_alias', function: { name: alias, arguments: '{"value":1}' } }]
    }, finish_reason: null }] }],
    ['message', { id: 'chat_gemini_alias', model: 'chat-test', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'gemini', 'alias', {
    responsesOptions: { geminiToolAliases: [{ name: original, alias }] }
  }));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  const call = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || [])
    .map((part) => part.functionCall).find((item) => item?.name);
  assert.deepEqual(call, { name: original, args: { value: 1 }, id: 'call_alias' });
});

test('Gemini SSE 大工具别名表只构建一次还原索引', async () => {
  const count = 64;
  let aliasReads = 0;
  const aliases = Array.from({ length: count }, (_, index) => {
    const entry = { name: `original.stream:${index}` };
    Object.defineProperty(entry, 'alias', {
      enumerable: true,
      get() {
        aliasReads++;
        return `stream_alias_${index}`;
      }
    });
    return entry;
  });
  const source = responseFrom([
    ['message', { id: 'chat_many_gemini_aliases', model: 'chat-test', choices: [{ index: 0, delta: {
      tool_calls: Array.from({ length: count }, (_, index) => ({
        index, id: `call_${index}`, function: { name: `stream_alias_${index}`, arguments: '{}' }
      }))
    }, finish_reason: null }] }],
    ['message', { id: 'chat_many_gemini_aliases', model: 'chat-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }]
  ]);

  const output = await collect(translateSse(source, 'chat', 'gemini', 'alias', {
    responsesOptions: { geminiToolAliases: aliases }
  }));
  const names = output.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.slice('data: '.length)))
    .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || [])
    .map((part) => part.functionCall?.name)
    .filter(Boolean);

  assert.ok(aliasReads <= count * 2, `Gemini SSE alias 属性读取 ${aliasReads} 次，预期为 O(n)`);
  assert.deepEqual(names, Array.from({ length: count }, (_, index) => `original.stream:${index}`));
});

test('Chat SSE 并行工具参数可重编码为 Gemini PartialArg', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_partial', model: 'kimi', choices: [{ delta: { tool_calls: [{
      index: 0, id: 'call_a', function: { name: 'first', arguments: '{"city":"上' }
    }] }, finish_reason: null }] }],
    ['message', { id: 'chat_partial', model: 'kimi', choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '海","count":2,"enabled":true,"note":null,"nested":{"flag":false},"items":["a",3],"odd key":"值"}' } },
      { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"query":"tests"}' } }
    ] }, finish_reason: null }] }],
    ['message', { id: 'chat_partial', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'gemini', 'alias', { geminiStreamFunctionCallArguments: true }));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  const calls = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || []).map((part) => part.functionCall).filter(Boolean);
  assert.deepEqual(calls[0], {
    name: 'first', id: 'call_a', willContinue: true,
    partialArgs: [
      { jsonPath: '$.city', stringValue: '上海' },
      { jsonPath: '$.count', numberValue: 2 },
      { jsonPath: '$.enabled', boolValue: true },
      { jsonPath: '$.note', nullValue: null },
      { jsonPath: '$.nested.flag', boolValue: false },
      { jsonPath: '$.items[0]', stringValue: 'a' },
      { jsonPath: '$.items[1]', numberValue: 3 },
      { jsonPath: '$["odd key"]', stringValue: '值' }
    ]
  });
  assert.deepEqual(calls[1], {
    name: 'second', id: 'call_b', willContinue: true,
    partialArgs: [{ jsonPath: '$.query', stringValue: 'tests' }]
  });
  assert.deepEqual(calls.slice(2), [{}, {}]);
  assert.equal(calls.some((call) => call.args), false);
});

test('Responses 与 Claude 参数增量同样可重编码为 Gemini PartialArg', async () => {
  const responsesSource = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_partial', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_responses', name: 'lookup', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"上海"}' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_responses', name: 'lookup', arguments: '{"city":"上海"}' } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 2 } } }]
  ]);
  const claudeSource = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_partial', model: 'claude', usage: { input_tokens: 2 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_claude', name: 'lookup', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"北京"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }]
  ]);

  for (const [protocol, source, id, city] of [
    ['responses', responsesSource, 'call_responses', '上海'],
    ['claude', claudeSource, 'call_claude', '北京']
  ]) {
    const output = await collect(translateSse(source, protocol, 'gemini', 'alias', { geminiStreamFunctionCallArguments: true }));
    const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
    const calls = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || []).map((part) => part.functionCall).filter(Boolean);
    assert.deepEqual(calls, [
      { name: 'lookup', id, partialArgs: [{ jsonPath: '$.city', stringValue: city }], willContinue: true },
      {}
    ]);
  }
});

test('Gemini PartialArg 无法表达空嵌套容器时保留完整 args', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_partial_fallback', model: 'kimi', choices: [{ delta: { tool_calls: [{
      index: 0, id: 'call_empty', function: { name: 'configure', arguments: '{"empty":{},"items":[]}' }
    }] }, finish_reason: null }] }],
    ['message', { id: 'chat_partial_fallback', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'gemini', 'alias', { geminiStreamFunctionCallArguments: true }));
  const chunks = output.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.slice('data: '.length)));
  const calls = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || []).map((part) => part.functionCall).filter(Boolean);
  assert.deepEqual(calls, [{ name: 'configure', args: { empty: {}, items: [] }, id: 'call_empty' }]);
});

test('转换 Gemini SSE 时不会把损坏的工具参数静默伪装为空对象', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_bad_args', model: 'kimi', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'run', arguments: '{bad' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_bad_args', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  ]);
  await assert.rejects(collect(translateSse(source, 'chat', 'gemini', 'alias')), /无效 JSON 参数/);
});

test('三种上游协议的损坏流式工具参数会在所有目标协议完成前失败', async () => {
  const chatSource = () => responseFrom([
    ['message', { id: 'chat_bad_args_all', model: 'kimi', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'run', arguments: '{bad' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_bad_args_all', model: 'kimi', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  ]);
  for (const target of ['claude', 'responses']) {
    await assert.rejects(
      collect(translateSse(chatSource(), 'chat', target, 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_TOOL_ARGUMENTS' && /工具 run/.test(error.message)
    );
  }

  const responsesSource = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_bad_args', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_bad', type: 'function_call', call_id: 'call_bad', name: 'run', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '[]' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_bad', type: 'function_call', call_id: 'call_bad', name: 'run', arguments: '[]' } }]
  ]);
  await assert.rejects(
    collect(translateSse(responsesSource, 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_TOOL_ARGUMENTS' && /工具 run/.test(error.message)
  );

  const claudeSource = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_bad_args', model: 'claude', content: [], usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_bad', name: 'run', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'null' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }]
  ]);
  await assert.rejects(
    collect(translateSse(claudeSource, 'claude', 'responses', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_TOOL_ARGUMENTS' && /工具 run/.test(error.message)
  );
});

test('Chat SSE 独立 usage 事件会进入最终响应和日志回调', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_usage', model: 'kimi', choices: [{ delta: { role: 'assistant', content: '完成' }, finish_reason: null }] }],
    ['message', { id: 'chat_usage', model: 'kimi', choices: [{ delta: {}, finish_reason: 'stop' }] }],
    ['message', { id: 'chat_usage', model: 'kimi', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.match(output, /"output_tokens":7/);
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, cacheCreationInputTokens: 0, reasoningTokens: 2 });
  assert.equal((output.match(/message_stop/g) || []).length, 2, '事件名和 type 字段应各出现一次');
});

test('同协议观察器提取 usage 但不参与流转换', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_observe', model: 'kimi', choices: [{ delta: { content: '原始流' }, finish_reason: null }] }],
    ['message', { id: 'chat_observe', model: 'kimi', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }]
  ]);
  const observed = await observeSse(source, 'chat', 'alias');
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, { inputTokens: 6, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
});

test('同协议错误过滤与用量观察复用同一次 SSE JSON 解析', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_once', model: 'gpt', status: 'in_progress' } }],
    ['response.completed', { type: 'response.completed', sequence_number: 1, response: { id: 'resp_once', status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } }]
  ]);
  const observer = createSseObserver('responses', 'gpt');
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = (...args) => {
    parseCalls += 1;
    return originalParse(...args);
  };
  let output;
  try {
    output = await collect(sanitizeSseErrorStream(source.body, 'responses', undefined, { onData: observer.observe }));
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(parseCalls, 2);
  assert.match(output, /event: response\.created/);
  assert.match(output, /event: response\.completed/);
  assert.deepEqual(observer.end(), {
    usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
    error: undefined,
    nextSequenceNumber: 2
  });
});

test('复用解析时仍按显式 SSE 事件名终止并记录非标准错误', async () => {
  const source = responseFrom([
    ['response.failed', { sequence_number: 5, message: 'explicit failure' }],
    ['response.completed', { type: 'response.completed', sequence_number: 6, response: { status: 'completed' } }]
  ]);
  const observer = createSseObserver('responses', 'gpt');
  const output = await collect(sanitizeSseErrorStream(source.body, 'responses', undefined, { onData: observer.observe }));
  assert.match(output, /event: error/);
  assert.match(output, /explicit failure/);
  assert.doesNotMatch(output, /response\.completed/);
  const observed = observer.end();
  assert.equal(observed.error.message, 'explicit failure');
  assert.equal(observed.nextSequenceNumber, 6);
});

test('流式 usage 规范化数字字符串并隔离非法或超大计数', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_usage_bounds', model: 'kimi', choices: [{ delta: { content: 'ok' }, finish_reason: null }] }],
    ['message', {
      id: 'chat_usage_bounds', choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: '8', completion_tokens: -2,
        prompt_tokens_details: { cached_tokens: '3', cache_creation_tokens: 1.25 },
        completion_tokens_details: { reasoning_tokens: 1e100 }
      }
    }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'chat', 'responses', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.deepEqual(usage, {
    inputTokens: 8,
    outputTokens: 0,
    cachedInputTokens: 3,
    cacheCreationInputTokens: 0,
    reasoningTokens: Number.MAX_SAFE_INTEGER
  });
  const completedBlock = output.split(/\n\n/).find((block) => block.includes('event: response.completed'));
  const completed = JSON.parse(completedBlock.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(completed.response.usage.total_tokens, 8);
  assert.equal(typeof completed.response.usage.total_tokens, 'number');
});

test('增量 SSE 观察器可跨 chunk 解析且不会持有独立读取分支', () => {
  const encoder = new TextEncoder();
  let callbackUsage;
  const observer = createSseObserver('chat', 'alias', { onUsage: (usage) => { callbackUsage = usage; } });
  const raw = [
    'data: {"id":"chat_incremental","choices":[{"delta":{"content":"原样"},"finish_reason":null}]}\r',
    '\n\r\ndata: {"id":"chat_incremental","choices":[{"delta":{},"finish_reason":"stop"}],',
    '"usage":{"prompt_tokens":4,"completion_tokens":2}}\r\n\r\n'
  ];
  for (const chunk of raw) observer.write(encoder.encode(chunk));
  const observed = observer.end();
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  assert.deepEqual(callbackUsage, observed.usage);
});

test('同协议观察器保留底层流读取错误而不被残缺事件覆盖', async () => {
  const encoder = new TextEncoder();
  let firstPull = true;
  const source = new Response(new ReadableStream({
    pull(controller) {
      if (firstPull) {
        firstPull = false;
        controller.enqueue(encoder.encode('data: {"id":"partial"'));
      } else controller.error(new Error('socket lost'));
    }
  }));
  const observed = await observeSse(source, 'chat', 'alias');
  assert.equal(observed.error.message, 'socket lost');
});

test('同协议观察器不会把缺失 usage 的正常流伪记为零 token', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_no_usage', model: 'kimi', choices: [{ delta: { content: '正常内容' }, finish_reason: null }] }],
    ['message', { id: 'chat_no_usage', model: 'kimi', choices: [{ delta: {}, finish_reason: 'stop' }] }]
  ]);
  let callbackCalled = false;
  const observed = await observeSse(source, 'chat', 'alias', { onUsage: () => { callbackCalled = true; } });
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, {});
  assert.equal(callbackCalled, false);
});

test('可解析末尾没有空行的 SSE 事件', async () => {
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"id":"x","model":"m","choices":[{"delta":{"content":"尾部"},"finish_reason":"stop"}]}'));
    controller.close();
  } }));
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /尾部/);
  assert.match(output, /message_stop/);
});

test('SSE 解析兼容仅使用 CR 的合法换行', async () => {
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: message\rdata: {"id":"chat_cr","model":"legacy","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\r\r'));
      controller.enqueue(encoder.encode('event: message\rdata: {"id":"chat_cr","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\r\r'));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /"text":"ok"/);
  assert.match(output, /event: message_stop/);
});

test('SSE 多行 data 事件使用单次行分类且保持 JSON 拼接语义', async () => {
  const paddingCount = 1024;
  const payload = {
    id: 'chat_multiline_data', model: 'legacy', padding: Array.from({ length: paddingCount }, (_, index) => index),
    choices: [{ delta: { content: '多行事件' }, finish_reason: 'stop' }]
  };
  const dataLines = JSON.stringify(payload, null, 1).split('\n').map((line) => `data: ${line}`).join('\n');
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`event: message\n${dataLines}\n\n`));
    controller.close();
  } }));

  const filter = Array.prototype.filter;
  const map = Array.prototype.map;
  let largeLineTransforms = 0;
  Array.prototype.filter = function countedFilter(...args) {
    if (this.length > paddingCount && typeof this[0] === 'string') largeLineTransforms++;
    return Reflect.apply(filter, this, args);
  };
  Array.prototype.map = function countedMap(...args) {
    if (this.length > paddingCount && typeof this[0] === 'string') largeLineTransforms++;
    return Reflect.apply(map, this, args);
  };
  let output;
  try {
    output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  } finally {
    Array.prototype.filter = filter;
    Array.prototype.map = map;
  }

  assert.equal(largeLineTransforms, 0, 'SSE 行数组不应再经过 filter/map 复制');
  assert.match(output, /多行事件/);
  assert.match(output, /event: message_stop/);
});

test('损坏的上游 SSE 会转换为错误事件而不是静默丢失', async () => {
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: not-json\n\n'));
    controller.close();
  } }));
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /event: error/);
  assert.match(output, /无法解析/);
});

test('跨协议和同协议 SSE 都拒绝无效 UTF-8 而不是插入替换字符', async () => {
  const invalid = () => new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]));
      controller.close();
    }
  });
  await assert.rejects(
    collect(translateSse(new Response(invalid()), 'chat', 'claude', 'alias')),
    (error) => error?.code === 'UPSTREAM_INVALID_UTF8' && /无效 UTF-8/.test(error.message)
  );
  await assert.rejects(
    collect(sanitizeSseErrorStream(invalid(), 'chat')),
    (error) => error?.code === 'UPSTREAM_INVALID_UTF8' && /无效 UTF-8/.test(error.message)
  );
  const observer = createSseObserver('chat', 'alias');
  observer.write(Uint8Array.from([0xc3, 0x28]));
  assert.match(observer.end().error.message, /无效 UTF-8/);
});

test('Responses 推理摘要流可转换为 Claude thinking 流', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_r', model: 'gpt', usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 5 } } } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '分析中' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '分析中' }] } }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_r', usage: { input_tokens: 9, output_tokens: 6, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 4 } } } }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.match(output, /"type":"thinking"/);
  assert.match(output, /"type":"thinking_delta","thinking":"分析中"/);
  assert.match(output, /"type":"signature_delta"/);
  assert.match(output, /"cache_read_input_tokens":5/);
  assert.match(output, /"output_tokens_details":\{"thinking_tokens":4\}/);
  assert.deepEqual(usage, { inputTokens: 9, outputTokens: 6, cachedInputTokens: 5, cacheCreationInputTokens: 0, reasoningTokens: 4 });
});

test('Responses compaction 流只在密文完整后发出并可恢复原始输出项', async () => {
  const compaction = {
    id: 'cmp_stream', type: 'compaction', encrypted_content: 'opaque-responses-compaction', created_by: 'server'
  };
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_compaction', object: 'response', status: 'in_progress', model: 'gpt', reasoning: { context: 'all_turns' } } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'cmp_stream', type: 'compaction' } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: compaction }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_compaction', object: 'response', status: 'completed', model: 'gpt', output: [compaction], usage: { input_tokens: 10, output_tokens: 0 } } }]
  ]);
  const responseDegradations = [];
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', {
    onResponseDegradations: (values) => responseDegradations.push(...values)
  }));
  const events = output.split(/\n\n/).filter(Boolean).map((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
    return data ? JSON.parse(data.slice(6)) : null;
  }).filter(Boolean);
  const redacted = events.find((event) => event.type === 'content_block_start')?.content_block;
  assert.equal(redacted.type, 'redacted_thinking');
  assert.deepEqual(decodeReasoningState(redacted.data), {
    protocol: 'responses', kind: 'compaction', value: compaction
  });
  assert.doesNotMatch(output, /opaque-responses-compaction/);
  assert.deepEqual(responseDegradations, ['responses_reasoning_context']);

  const encoded = encodeReasoningState('responses', 'compaction', compaction);
  const encoder = new TextEncoder();
  const chatSource = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: 'chat_compaction', model: 'chat-test', choices: [{ index: 0, delta: {
        role: 'assistant', reasoning_details: [{ type: 'reasoning.encrypted', data: encoded }]
      }, finish_reason: null }]
    })}\n\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: 'chat_compaction', model: 'chat-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 }
    })}\n\ndata: [DONE]\n\n`));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const responsesOutput = await collect(translateSse(chatSource, 'chat', 'responses', 'alias'));
  const responseEvents = responsesOutput.split(/\n\n/).filter(Boolean).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!data || data === 'data: [DONE]') return [];
    return [JSON.parse(data.slice(6))];
  });
  const done = responseEvents.find((event) => event.type === 'response.output_item.done');
  assert.deepEqual(done.item, compaction);
  assert.equal('status' in done.item, false);
  assert.deepEqual(responseEvents.find((event) => event.type === 'response.completed').response.output, [compaction]);
});

test('Codex context_compaction 流允许可选 id/密文并可恢复原始输出项', async () => {
  const contextCompaction = { type: 'context_compaction' };
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_context_compaction', object: 'response', status: 'in_progress', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: contextCompaction }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: contextCompaction }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_context_compaction', object: 'response', status: 'completed', model: 'gpt',
      output: [contextCompaction], usage: { input_tokens: 10, output_tokens: 0 }
    } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias'));
  const events = output.split(/\n\n/).filter(Boolean).map((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
    return data ? JSON.parse(data.slice(6)) : null;
  }).filter(Boolean);
  const redacted = events.find((event) => event.type === 'content_block_start')?.content_block;
  assert.deepEqual(decodeReasoningState(redacted.data), {
    protocol: 'responses', kind: 'context_compaction', value: contextCompaction
  });

  const encoded = encodeReasoningState('responses', 'context_compaction', contextCompaction);
  const encoder = new TextEncoder();
  const chatSource = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: 'chat_context_compaction', model: 'chat-test', choices: [{ index: 0, delta: {
        role: 'assistant', reasoning_details: [{ type: 'reasoning.encrypted', data: encoded }]
      }, finish_reason: null }]
    })}\n\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: 'chat_context_compaction', model: 'chat-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 }
    })}\n\ndata: [DONE]\n\n`));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const responsesOutput = await collect(translateSse(chatSource, 'chat', 'responses', 'alias'));
  const responseEvents = responsesOutput.split(/\n\n/).filter(Boolean).flatMap((block) => {
    const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!data || data === 'data: [DONE]') return [];
    return [JSON.parse(data.slice(6))];
  });
  const done = responseEvents.find((event) => event.type === 'response.output_item.done');
  assert.deepEqual(done.item, contextCompaction);
  assert.equal('status' in done.item, false);
  assert.deepEqual(responseEvents.find((event) => event.type === 'response.completed').response.output, [contextCompaction]);
});

test('Chat SSE 大量桥接推理状态使用身份集合线性去重', async () => {
  const count = 64;
  const states = Array.from({ length: count }, (_, index) => encodeReasoningState('responses', 'reasoning', {
    type: 'reasoning', id: `rs_linear_${index}`, encrypted_content: `linear-marker-${index}`
  }));
  const details = [...states, ...states].map((data, index) => ({
    index, type: 'reasoning.encrypted', data
  }));
  const source = responseFrom([
    ['message', { id: 'chat_many_states', model: 'chat-test', choices: [{ index: 0, delta: {
      role: 'assistant', reasoning_details: details
    }, finish_reason: null }] }],
    ['message', { id: 'chat_many_states', model: 'chat-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  ]);

  const stringify = JSON.stringify;
  let identitySerializations = 0;
  JSON.stringify = function countedStringify(value, ...args) {
    const stateValue = Array.isArray(value) ? value[2] : value;
    if (stateValue?.type === 'reasoning' && stateValue.encrypted_content?.startsWith('linear-marker-')) {
      identitySerializations++;
    }
    return Reflect.apply(stringify, this, [value, ...args]);
  };
  let output;
  try {
    output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  } finally {
    JSON.stringify = stringify;
  }

  assert.ok(identitySerializations <= details.length * 2, `桥接推理状态身份序列化 ${identitySerializations} 次，预期为 O(n)`);
  assert.equal((output.match(/"type":"redacted_thinking"/g) || []).length, count);
});

test('Responses reasoning_text content part 可转换并由完整事件补齐', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_reasoning_text', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_text', type: 'reasoning', summary: [], content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'rs_text', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } }],
    ['response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: 'rs_text', output_index: 0, content_index: 0, delta: '内部' }],
    ['response.reasoning_text.done', { type: 'response.reasoning_text.done', item_id: 'rs_text', output_index: 0, content_index: 0, text: '内部推理' }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'rs_text', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '内部推理' } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_text', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '内部推理' }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 2 } } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias'));
  assert.match(output, /"type":"thinking_delta","thinking":"内部"/);
  assert.match(output, /"type":"thinking_delta","thinking":"推理"/);
  assert.equal((output.match(/内部/g) || []).length, 1);
  assert.equal((output.match(/推理/g) || []).length, 1);
  assert.doesNotMatch(output, /UPSTREAM_UNSUPPORTED_STREAM_CONTENT/);
});

test('Responses 多段 summary 与 reasoning content 使用独立索引且加密状态只绑定一次', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_multi_reasoning', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_multi', type: 'reasoning', summary: [], content: [], encrypted_content: 'encrypted-state' } }],
    ['response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: 'rs_multi', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_multi', output_index: 0, summary_index: 0, delta: '摘要甲' }],
    ['response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: 'rs_multi', output_index: 0, summary_index: 1, part: { type: 'summary_text', text: '' } }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'rs_multi', output_index: 0, summary_index: 1, delta: '摘要乙' }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'rs_multi', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } }],
    ['response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: 'rs_multi', output_index: 0, content_index: 0, delta: '内容甲' }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'rs_multi', output_index: 0, content_index: 1, part: { type: 'reasoning_text', text: '' } }],
    ['response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: 'rs_multi', output_index: 0, content_index: 1, delta: '内容乙' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
      id: 'rs_multi', type: 'reasoning', encrypted_content: 'encrypted-state',
      summary: [{ type: 'summary_text', text: '摘要甲' }, { type: 'summary_text', text: '摘要乙' }],
      content: [{ type: 'reasoning_text', text: '内容甲' }, { type: 'reasoning_text', text: '内容乙' }]
    } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 4 } } }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', {
    onReasoningState: (value) => { reasoningState = value; }
  }));
  for (const text of ['摘要甲', '摘要乙', '内容甲', '内容乙']) {
    assert.equal((output.match(new RegExp(text, 'g')) || []).length, 1);
  }
  assert.equal((output.match(/"content_block":\{"type":"thinking"/g) || []).length, 4);
  assert.equal(reasoningState.providerStates.length, 1);
});

test('Responses 流索引为负数时返回明确的损坏序列错误', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_bad_index', model: 'gpt' } }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: -1, delta: '错误' }]
  ]);
  await assert.rejects(
    () => collect(translateSse(source, 'responses', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /summary_index/.test(error.message)
  );
});

test('Claude omitted thinking 流不生成伪摘要并以 encrypted_content 保留状态', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_omitted', model: 'claude-test', usage: { input_tokens: 4 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8, output_tokens_details: { thinking_tokens: 6 } } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'claude', 'responses', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.doesNotMatch(output, /response\.reasoning_summary_part\.added/);
  assert.match(output, /"type":"reasoning"/);
  assert.match(output, /"encrypted_content":"[A-Za-z0-9_-]+"/);
  assert.match(output, /"type":"output_text"/);
  assert.match(output, /答案/);
  assert.match(output, /"reasoning_tokens":6/);
  assert.deepEqual(usage, { inputTokens: 4, outputTokens: 8, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 6 });
});

test('Responses delta 乱序与 done 完整值不会导致内容丢失', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_late', model: 'gpt' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '' } }],
    ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"city":"上海"}' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"上海"}' } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias'));
  assert.match(output, /"name":"weather"/);
  assert.match(output, /"partial_json":"\{\\"city\\":/);
  assert.match(output, /"partial_json":"\\"上海\\"\}"/);
  assert.equal((output.match(/上海/g) || []).length, 1);
  assert.match(output, /"stop_reason":"tool_use"/);
});

test('Responses SSE 并行工具调用转换为连续 Chat tool_calls 索引', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_parallel', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'first', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":1}' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_a', type: 'function_call', call_id: 'call_a', name: 'first', arguments: '{"a":1}' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_b', type: 'function_call', call_id: 'call_b', name: 'second', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"b":2}' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_b', type: 'function_call', call_id: 'call_b', name: 'second', arguments: '{"b":2}' } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias'));
  assert.match(output, /"index":0,"id":"call_a"/);
  assert.match(output, /"index":1,"id":"call_b"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
});

test('Responses output_item.done 可兜底缺失的文本 delta', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_done', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '仅在完成事件出现' }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias'));
  assert.match(output, /仅在完成事件出现/);
  assert.match(output, /data: \[DONE\]/);
});

test('Responses 大量 output_item.done 只遍历当前输出项的块', async () => {
  const count = 128;
  const events = [
    ['response.created', { type: 'response.created', response: {
      id: 'resp_linear_output_blocks', model: 'gpt-test', status: 'in_progress'
    } }]
  ];
  for (let index = 0; index < count; index++) {
    const item = {
      id: `msg_linear_output_block_${index}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'x' }]
    };
    events.push(['response.output_item.added', {
      type: 'response.output_item.added', output_index: index,
      item: { ...item, status: 'in_progress', content: [] }
    }]);
    events.push(['response.output_item.done', {
      type: 'response.output_item.done', output_index: index, item
    }]);
  }
  events.push(['response.completed', { type: 'response.completed', response: {
    id: 'resp_linear_output_blocks', model: 'gpt-test', status: 'completed', output: [],
    usage: { input_tokens: 1, output_tokens: count }
  } }]);

  const iterator = Map.prototype[Symbol.iterator];
  let blockVisits = 0;
  Map.prototype[Symbol.iterator] = function* countedIterator() {
    for (const entry of iterator.call(this)) {
      if (entry?.[1]?.id?.startsWith('msg_linear_output_block_') && entry[1]?.streamKind === 'message') {
        blockVisits++;
      }
      yield entry;
    }
  };
  let output;
  try {
    output = await collect(translateSse(responseFrom(events), 'responses', 'chat', 'alias'));
  } finally {
    Map.prototype[Symbol.iterator] = iterator;
  }

  assert.ok(blockVisits <= count * 2, `Responses 输出块共被遍历 ${blockVisits} 次，预期为 O(n)`);
  assert.equal((output.match(/"content":"x"/g) || []).length, count);
});

test('Responses 仅在 completed 终态提供 output 时仍完整转换文本、推理与工具', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_terminal_only', model: 'gpt' } }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_terminal_only', model: 'gpt', status: 'completed',
      output: [
        {
          id: 'rs_terminal', type: 'reasoning', encrypted_content: 'terminal-encrypted',
          summary: [{ type: 'summary_text', text: '终态摘要' }],
          content: [{ type: 'reasoning_text', text: '终态推理' }]
        },
        { id: 'msg_terminal', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '终态答案', annotations: [] }] },
        { id: 'fc_terminal', type: 'function_call', call_id: 'call_terminal', name: 'lookup', arguments: '{"q":"终态"}' }
      ],
      usage: { input_tokens: 3, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } }
    } }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', {
    onReasoningState: (value) => { reasoningState = value; }
  }));
  for (const text of ['终态摘要', '终态推理', '终态答案']) assert.match(output, new RegExp(text));
  assert.match(output, /"type":"tool_use"/);
  assert.equal(reasoningState.providerStates.length, 1);
  assert.deepEqual(reasoningState.toolCalls, [{ id: 'call_terminal', name: 'lookup', arguments: '{"q":"终态"}' }]);
});

test('Responses completed 终态可补齐最后一段且不重复已发 delta', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_terminal_tail', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_tail', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_tail', output_index: 0, content_index: 0, delta: '前半' }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_terminal_tail', status: 'completed',
      output: [{ id: 'msg_tail', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '前半后半', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 2 }
    } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias'));
  assert.equal((output.match(/前半/g) || []).length, 1);
  assert.equal((output.match(/后半/g) || []).length, 1);
});

test('Responses 终态补回较晚出现的 encrypted_content', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_late_encrypted', model: 'gpt' } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
      id: 'rs_late', type: 'reasoning', summary: [{ type: 'summary_text', text: '已完成推理' }]
    } }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_late_encrypted', status: 'completed',
      output: [{ id: 'rs_late', type: 'reasoning', summary: [{ type: 'summary_text', text: '已完成推理' }], encrypted_content: 'late-encrypted' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    } }]
  ]);
  let reasoningState;
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', {
    onReasoningState: (value) => { reasoningState = value; }
  }));
  assert.equal((output.match(/已完成推理/g) || []).length, 1);
  assert.match(output, /"type":"redacted_thinking"/);
  assert.equal(reasoningState.providerStates.length, 1);
});

test('Responses 同一 output_index 的 item ID 或类型漂移时明确失败', async () => {
  const idDrift = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_id_drift', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_a', type: 'message', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_b', output_index: 0, content_index: 0, delta: '错误' }]
  ]);
  await assert.rejects(
    () => collect(translateSse(idDrift, 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /item_id/.test(error.message)
  );

  const typeDrift = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_type_drift', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'item_a', type: 'message', content: [] } }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: 'item_a', output_index: 0, summary_index: 0, delta: '错误' }]
  ]);
  await assert.rejects(
    () => collect(translateSse(typeDrift, 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /类型/.test(error.message)
  );
});

test('Responses 同一 message 的多个 content_index 会转换为独立内容块', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_multi_content', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_multi', type: 'message', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_multi', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_multi', output_index: 0, content_index: 0, delta: '第一段' }],
    ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_multi', output_index: 0, content_index: 0, text: '第一段' }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_multi', output_index: 0, content_index: 0, part: { type: 'output_text', text: '第一段', annotations: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_multi', output_index: 0, content_index: 1, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_multi', output_index: 0, content_index: 1, delta: '第二段' }],
    ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_multi', output_index: 0, content_index: 1, text: '第二段' }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_multi', output_index: 0, content_index: 1, part: { type: 'output_text', text: '第二段', annotations: [] } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_multi', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一段', annotations: [] }, { type: 'output_text', text: '第二段', annotations: [] }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 4 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias'));
  assert.match(output, /"index":0,"content_block":\{"type":"text","text":""\}/);
  assert.match(output, /"index":1,"content_block":\{"type":"text","text":""\}/);
  assert.match(output, /"index":0,"delta":\{"type":"text_delta","text":"第一段"\}/);
  assert.match(output, /"index":1,"delta":\{"type":"text_delta","text":"第二段"\}/);
  assert.equal((output.match(/第一段/g) || []).length, 1);
  assert.equal((output.match(/第二段/g) || []).length, 1);
});

test('Responses 流式 annotations 在内容块结束前转换为可读来源且不重复', async () => {
  const annotation = { type: 'url_citation', start_index: 0, end_index: 2, title: '来源页', url: 'https://example.invalid/citation' };
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_annotation', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_annotation', type: 'message', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_annotation', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_annotation', output_index: 0, content_index: 0, delta: '答案' }],
    ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', item_id: 'msg_annotation', output_index: 0, content_index: 0, annotation_index: 0, annotation }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_annotation', output_index: 0, content_index: 0, part: { type: 'output_text', text: '答案', annotations: [annotation] } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_annotation', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [annotation] }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  assert.match(output, /"content":"答案"/);
  assert.match(output, /Sources:\\n- 来源页 — https:\/\/example\.invalid\/citation/);
  assert.equal((output.match(/example\.invalid\/citation/g) || []).length, 1);
});

test('Responses 流式 annotation 去重不会反复序列化既有引用', async () => {
  const count = 64;
  const annotations = Array.from({ length: count }, (_, index) => ({
    type: 'url_citation', start_index: 0, end_index: 2,
    title: `来源 ${index}`, url: `https://annotation-linear.invalid/${index}`
  }));
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_many_annotations', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_many_annotations', type: 'message', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_many_annotations', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ...annotations.map((annotation, annotation_index) => ['response.output_text.annotation.added', {
      type: 'response.output_text.annotation.added', item_id: 'msg_many_annotations',
      output_index: 0, content_index: 0, annotation_index, annotation
    }]),
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_many_annotations', output_index: 0, content_index: 0, delta: '答案' }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_many_annotations', output_index: 0, content_index: 0, part: { type: 'output_text', text: '答案', annotations } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_many_annotations', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }]
  ]);

  const stringify = JSON.stringify;
  let annotationSerializations = 0;
  JSON.stringify = function countedStringify(value, ...args) {
    if (value?.type === 'url_citation' && value.url?.startsWith('https://annotation-linear.invalid/')) {
      annotationSerializations++;
    }
    return Reflect.apply(stringify, this, [value, ...args]);
  };
  let output;
  try {
    output = await collect(translateSse(source, 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  } finally {
    JSON.stringify = stringify;
  }

  assert.ok(annotationSerializations <= count * 4, `annotation 被直接序列化 ${annotationSerializations} 次，预期为 O(n)`);
  assert.equal((output.match(/annotation-linear\.invalid/g) || []).length, count);
});

test('Responses web_search_call 仅为已映射的 Gemini Google Search 忽略执行轨迹并输出原生 groundingMetadata', async () => {
  const annotation = { type: 'url_citation', start_index: 0, end_index: 2, title: '搜索来源', url: 'https://example.invalid/web-search' };
  const events = [
    ['response.created', { type: 'response.created', response: { id: 'resp_search', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress', action: { type: 'search', query: '新闻' } } }],
    ['response.web_search_call.in_progress', { type: 'response.web_search_call.in_progress', output_index: 0, item_id: 'ws_1' }],
    ['response.web_search_call.searching', { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' }],
    ['response.web_search_call.completed', { type: 'response.web_search_call.completed', output_index: 0, item_id: 'ws_1' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '新闻', queries: ['新闻', '今日新闻'] } } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_search', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_search', output_index: 1, content_index: 0, delta: '答案' }],
    ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', item_id: 'msg_search', output_index: 1, content_index: 0, annotation_index: 0, annotation }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_search', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [annotation] }] } }],
    ['response.completed', { type: 'response.completed', response: { output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed' },
      { id: 'msg_search', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [annotation] }] }
    ], usage: { input_tokens: 2, output_tokens: 3 } } }]
  ];
  const output = await collect(translateSse(responseFrom(events), 'responses', 'gemini', 'alias', { allowResponsesWebSearch: true }));
  assert.match(output, /答案/);
  assert.doesNotMatch(output, /Sources:/);
  assert.equal((output.match(/example\.invalid\/web-search/g) || []).length, 1);
  const chunks = output.split(/\n\n/).filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)));
  assert.deepEqual(chunks.at(-1).candidates[0].groundingMetadata, {
    webSearchQueries: ['新闻', '今日新闻'],
    groundingChunks: [{ web: { uri: 'https://example.invalid/web-search', title: '搜索来源' } }],
    groundingSupports: [{
      segment: { startIndex: 0, endIndex: 2, text: '答案' },
      groundingChunkIndices: [0]
    }]
  });
  await assert.rejects(
    collect(translateSse(responseFrom(events), 'responses', 'gemini', 'alias')),
    /web_search_call/
  );
});

test('Responses 多内容块在仅有 output_item.done 时逐块兜底且保留拒答字段', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_multi_fallback', model: 'gpt' } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
      id: 'msg_multi_fallback', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '可见文本', annotations: [] }, { type: 'refusal', refusal: '拒答说明' }]
    } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 3 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  const chunks = output.split(/\n\n/).filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)));
  const deltas = chunks.flatMap((chunk) => chunk.choices || []).map((choice) => choice.delta);
  assert.ok(deltas.some((delta) => delta.content === '可见文本'));
  assert.ok(deltas.some((delta) => delta.refusal === '拒答说明'));
  assert.equal(deltas.some((delta) => delta.content === '可见文本拒答说明'), false);
  assert.equal(chunks.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
});

test('Responses 同一 content_index 中途改变类型会明确失败', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_bad_content_type', model: 'gpt' } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_bad', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.refusal.delta', { type: 'response.refusal.delta', item_id: 'msg_bad', output_index: 0, content_index: 0, delta: '非法切换' }]
  ]);
  await assert.rejects(
    collect(translateSse(source, 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /类型从 text 变为 refusal/.test(error.message)
  );
});

test('Chat reasoning_content 流可转换为 Responses reasoning 流', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_r', model: 'deepseek', choices: [{ delta: { role: 'assistant', reasoning_content: '思考' }, finish_reason: null }] }],
    ['message', { id: 'chat_r', model: 'deepseek', choices: [{ delta: { reasoning_content: '完成' }, finish_reason: null }] }],
    ['message', { id: 'chat_r', model: 'deepseek', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'responses', 'alias'));
  assert.match(output, /response\.reasoning_summary_part\.added/);
  assert.match(output, /"delta":"思考"/);
  assert.match(output, /"delta":"完成"/);
  assert.match(output, /response\.reasoning_summary_part\.done/);
  assert.match(output, /"reasoning_tokens":2/);
});

test('Chat reasoning 流字段别名可转换为 Claude thinking', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_alias', model: 'kimi', choices: [{ delta: { reasoning: '别名思考' }, finish_reason: null }] }],
    ['message', { id: 'chat_alias', model: 'kimi', choices: [{ delta: { content: '答案' }, finish_reason: null }] }],
    ['message', { id: 'chat_alias', model: 'kimi', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }]
  ]);
  const output = await collect(translateSse(source, 'chat', 'claude', 'alias'));
  assert.match(output, /"type":"thinking_delta","thinking":"别名思考"/);
  assert.match(output, /"type":"text_delta","text":"答案"/);
});

test('Chat 分段 content、refusal 与旧 function_call 流可转换', async () => {
  const contentSource = responseFrom([
    ['message', { id: 'chat_parts', model: 'legacy', choices: [{ delta: { content: [{ type: 'text', text: '分段' }, { type: 'refusal', refusal: '拒绝' }] }, finish_reason: null }] }],
    ['message', { id: 'chat_parts', model: 'legacy', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { input_tokens: 4, output_tokens: 2 } }]
  ]);
  let usage;
  const contentOutput = await collect(translateSse(contentSource, 'chat', 'claude', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.match(contentOutput, /"text":"分段"/);
  assert.match(contentOutput, /"text":"拒绝"/);
  assert.match(contentOutput, /"stop_reason":"refusal"/);
  assert.equal(usage.inputTokens, 4);
  assert.equal(usage.outputTokens, 2);

  const functionSource = responseFrom([
    ['message', { id: 'chat_legacy', model: 'legacy', choices: [{ delta: { function_call: { name: 'lookup', arguments: '{"q":' } }, finish_reason: null }] }],
    ['message', { id: 'chat_legacy', model: 'legacy', choices: [{ delta: { function_call: { arguments: '"x"}' } }, finish_reason: null }] }],
    ['message', { id: 'chat_legacy', model: 'legacy', choices: [{ delta: {}, finish_reason: 'function_call' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }]
  ]);
  const functionOutput = await collect(translateSse(functionSource, 'chat', 'claude', 'alias'));
  assert.match(functionOutput, /"name":"lookup"/);
  assert.match(functionOutput, /"partial_json":"\{\\"q\\":\\"x\\"\}"/);
  assert.match(functionOutput, /"stop_reason":"tool_use"/);
});

test('Chat 流中的非文本内容块不会被静默丢弃', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_media', model: 'multimodal', choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }] }]
  ]);
  await assert.rejects(
    collect(translateSse(source, 'chat', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /image_url/.test(error.message)
  );
});

test('Chat 流式多候选、非零候选索引和损坏增量不会被静默转换', async () => {
  const cases = [
    {
      data: { id: 'chat_multi', choices: [{ index: 0, delta: { content: '第一项' } }, { index: 1, delta: { content: '第二项' } }] },
      code: 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT', pattern: /2 个候选/
    },
    {
      data: { id: 'chat_index', choices: [{ index: 1, delta: { content: '第二项' } }] },
      code: 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT', pattern: /index=1/
    },
    {
      data: { id: 'chat_null', choices: [null] },
      code: 'UPSTREAM_INVALID_STREAM_SEQUENCE', pattern: /choices\[0\] 必须是对象/
    },
    {
      data: { id: 'chat_content', choices: [{ index: 0, delta: { content: [{ type: 'text', text: 42 }] } }] },
      code: 'UPSTREAM_INVALID_STREAM_SEQUENCE', pattern: /content\[0\]\.text 必须是字符串/
    },
    {
      data: { id: 'chat_tools', choices: [{ index: 0, delta: { tool_calls: {} } }] },
      code: 'UPSTREAM_INVALID_STREAM_SEQUENCE', pattern: /tool_calls 必须是数组/
    }
  ];
  for (const item of cases) {
    const source = responseFrom([['message', item.data]]);
    await assert.rejects(
      collect(translateSse(source, 'chat', 'claude', 'alias')),
      (error) => error.code === item.code && item.pattern.test(error.message)
    );
  }
});

test('Claude 与 Chat 跨协议流严格校验停止原因及工具终态一致性', async () => {
  const claudeSource = (stopReason, withTool = false) => responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_terminal', model: 'claude', content: [], usage: { input_tokens: 1 } } }],
    ...(withTool ? [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_terminal', name: 'lookup', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }]
    ] : []),
    ['message_delta', { type: 'message_delta', delta: stopReason === undefined ? {} : { stop_reason: stopReason }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  for (const [stopReason, withTool, pattern] of [
    ['vendor_stop', false, /vendor_stop/],
    [undefined, false, /缺少合法 stop_reason/],
    ['tool_use', false, /没有工具调用/],
    ['end_turn', true, /包含工具调用.*end_turn/]
  ]) {
    await assert.rejects(
      collect(translateSse(claudeSource(stopReason, withTool), 'claude', 'chat', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }
  await assert.rejects(
    collect(translateSse(responseFrom([
      ['message_start', { type: 'message_start', message: { id: 'msg_missing_stop', model: 'claude', content: [] } }],
      ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 1 } }]
    ]), 'claude', 'responses', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /缺少合法 stop_reason/.test(error.message)
  );

  const chatSource = (finishReason, withTool = false) => responseFrom([
    ['message', { id: 'chat_terminal', model: 'chat', choices: [{
      delta: withTool ? { tool_calls: [{ index: 0, id: 'call_terminal', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] } : { content: '完成' },
      finish_reason: null
    }] }],
    ['message', { id: 'chat_terminal', model: 'chat', choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  ]);
  for (const [finishReason, withTool, pattern] of [
    ['vendor_stop', false, /vendor_stop/],
    ['tool_calls', false, /没有工具调用/],
    ['stop', true, /包含工具调用.*finish_reason=stop/]
  ]) {
    await assert.rejects(
      collect(translateSse(chatSource(finishReason, withTool), 'chat', 'claude', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const afterFinish = responseFrom([
    ['message', { id: 'chat_after_finish', model: 'chat', choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }],
    ['message', { id: 'chat_after_finish', choices: [{ delta: { content: '越界内容' }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  ]);
  await assert.rejects(
    collect(translateSse(afterFinish, 'chat', 'responses', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /终止 finish_reason 之后/.test(error.message)
  );
});

test('跨协议流会校验响应角色、Claude 停止序列和 Responses 输出项终态', async () => {
  const claudeSource = (message, deltas) => responseFrom([
    ['message_start', { type: 'message_start', message: {
      id: 'msg_envelope', type: 'message', role: 'assistant', model: 'claude', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1 }, ...message
    } }],
    ...deltas.map((delta) => ['message_delta', { type: 'message_delta', delta, usage: { output_tokens: 1 } }]),
    ['message_stop', { type: 'message_stop' }]
  ]);
  const valid = await collect(translateSse(
    claudeSource({}, [{ stop_reason: 'stop_sequence', stop_sequence: 'END' }]),
    'claude', 'chat', 'alias'
  ));
  assert.match(valid, /"finish_reason":"stop"/);

  for (const [source, pattern] of [
    [claudeSource({ role: 'user' }, [{ stop_reason: 'end_turn', stop_sequence: null }]), /message\.role 无效/],
    [claudeSource({}, [{ stop_reason: 'stop_sequence' }]), /stop_sequence 不是非空字符串/],
    [claudeSource({}, [{ stop_reason: 'end_turn', stop_sequence: 'END' }]), /stop_sequence 非空/],
    [claudeSource({}, [{ stop_sequence: 'END' }, { stop_reason: 'stop_sequence', stop_sequence: 'STOP' }]), /stop_sequence 从 END 变为 STOP/]
  ]) {
    await assert.rejects(
      collect(translateSse(source, 'claude', 'responses', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  await assert.rejects(
    collect(translateSse(responseFrom([
      ['message', { id: 'chat_role', model: 'chat', choices: [{ delta: { role: 'user', content: '错误角色' }, finish_reason: 'stop' }] }]
    ]), 'chat', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /delta\.role 无效/.test(error.message)
  );

  const responsesSource = (events) => responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_state', model: 'gpt' } }],
    ...events
  ]);
  for (const [events, pattern] of [
    [[['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: {
      id: 'msg_bad_added', type: 'message', role: 'assistant', status: 'completed', content: []
    } }]], /added.*status=completed/],
    [[['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
      id: 'msg_bad_done', type: 'message', role: 'assistant', status: 'in_progress', content: []
    } }]], /done.*status=in_progress/],
    [[['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: {
      id: 'msg_bad_role', type: 'message', role: 'user', status: 'in_progress', content: []
    } }]], /role 无效/],
    [[['response.completed', { type: 'response.completed', response: {
      status: 'completed', output: [{ id: 'msg_bad_terminal', type: 'message', role: 'assistant', status: 'incomplete', content: [] }]
    } }]], /status=incomplete.*completed/]
  ]) {
    await assert.rejects(
      collect(translateSse(responsesSource(events), 'responses', 'claude', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }
});

test('跨协议流拒绝损坏或漂移的响应身份及 Claude 非字符串增量', async () => {
  const invalidClaude = [
    [['message_start', { type: 'message_start', message: { id: 7, model: 'claude', content: [] } }], /message\.id 必须是非空字符串/],
    [['message_start', { type: 'message_start', message: { id: 'msg_scalar', model: {}, content: [] } }], /message\.model 必须是非空字符串/]
  ];
  for (const [event, pattern] of invalidClaude) {
    await assert.rejects(
      collect(translateSse(responseFrom([event]), 'claude', 'responses', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const claudeBlockSource = (contentBlock, delta) => responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_scalar', model: 'claude', content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: contentBlock }],
    ...(delta ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta }]] : [])
  ]);
  for (const [contentBlock, delta, pattern] of [
    [{ type: 'tool_use', id: 1, name: 'run', input: {} }, null, /id 必须是非空字符串/],
    [{ type: 'tool_use', id: 'call_1', name: {}, input: {} }, null, /name 必须是非空字符串/],
    [{ type: 'text', text: 1 }, null, /text 必须是字符串/],
    [{ type: 'text', text: '' }, { type: 'text_delta', text: 1 }, /text 必须是字符串/],
    [{ type: 'tool_use', id: 'call_1', name: 'run', input: {} }, { type: 'input_json_delta', partial_json: {} }, /partial_json 必须是字符串/],
    [{ type: 'thinking', thinking: '', signature: '' }, { type: 'thinking_delta', thinking: 1 }, /thinking 必须是字符串/],
    [{ type: 'thinking', thinking: '', signature: '' }, { type: 'signature_delta', signature: 1 }, /signature 必须是字符串/],
    [{ type: 'redacted_thinking', data: '' }, null, /data 必须是非空字符串/]
  ]) {
    await assert.rejects(
      collect(translateSse(claudeBlockSource(contentBlock, delta), 'claude', 'chat', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const responsesCases = [
    [responseFrom([['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '丢失首事件' }]]), /出现在 response\.created 之前/],
    [responseFrom([
      ['response.created', { type: 'response.created', response: { id: 'resp_dup', model: 'gpt' } }],
      ['response.created', { type: 'response.created', response: { id: 'resp_dup', model: 'gpt' } }]
    ]), /重复收到 response\.created/],
    [responseFrom([['response.created', { type: 'response.created', response: { id: 1, model: 'gpt' } }]]), /response\.id 必须是非空字符串/],
    [responseFrom([['response.created', { type: 'response.created', response: { id: 'resp_bad_object', object: 'chat.completion', model: 'gpt' } }]]), /object 无效/],
    [responseFrom([
      ['response.created', { type: 'response.created', response: { id: 'resp_a', model: 'gpt' } }],
      ['response.completed', { type: 'response.completed', response: { id: 'resp_b', model: 'gpt', status: 'completed', output: [] } }]
    ]), /response\.id 从 resp_a 变为 resp_b/]
  ];
  for (const [source, pattern] of responsesCases) {
    await assert.rejects(
      collect(translateSse(source, 'responses', 'claude', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  for (const [chunks, pattern] of [
    [[{ id: 'chat_object', object: 'chat.completion', model: 'chat', choices: [{ delta: { content: 'x' }, finish_reason: null }] }], /object 无效/],
    [[{ id: 1, model: 'chat', choices: [{ delta: { content: 'x' }, finish_reason: null }] }], /id 必须是非空字符串/],
    [[
      { id: 'chat_a', model: 'chat', choices: [{ delta: { content: 'x' }, finish_reason: null }] },
      { id: 'chat_b', model: 'chat', choices: [{ delta: {}, finish_reason: 'stop' }] }
    ], /id 从 chat_a 变为 chat_b/]
  ]) {
    await assert.rejects(
      collect(translateSse(responseFrom(chunks.map((chunk) => ['message', chunk])), 'chat', 'responses', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const observed = await observeSse(responseFrom([
    ['message', { id: 1, object: 'vendor.chunk', model: {}, choices: [{ delta: { content: '原生扩展' }, finish_reason: 'vendor_stop' }] }]
  ]), 'chat', 'alias');
  assert.equal(observed.error, undefined);
});

test('Responses 跨协议流拒绝非字符串内容、推理和函数参数字段', async () => {
  const created = ['response.created', { type: 'response.created', response: { id: 'resp_bad_scalar', model: 'gpt' } }];
  for (const [event, pattern] of [
    [['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: {} }], /output_text\.delta\.delta 必须是字符串/],
    [['response.refusal.done', { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: null }], /refusal\.done\.refusal 必须是字符串/],
    [['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, arguments: {} }], /arguments\.done\.arguments 必须是字符串/],
    [['response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: 1 } }], /content_part\.added\.part\.text 必须是字符串/],
    [['response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: 1 } }], /reasoning_summary_part\.done\.part\.text 必须是字符串/],
    [['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_bad_scalar', type: 'function_call', name: {}, arguments: '' } }], /\.name 必须是非空字符串/],
    [['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_bad_scalar', type: 'message', content: [{ type: 'output_text', text: 1 }] } }], /content\[0\]\.text 必须是字符串/],
    [['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_bad_scalar', type: 'reasoning', summary: [{ type: 'summary_text', text: 1 }] } }], /summary\[0\]\.text 必须是字符串/]
  ]) {
    await assert.rejects(
      collect(translateSse(responseFrom([created, event]), 'responses', 'claude', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }
});

test('Responses 跨协议流拒绝重复 output item 生命周期事件、终态后停止并兼容 done-only 兜底', async () => {
  const created = ['response.created', { type: 'response.created', response: { id: 'resp_bad_lifecycle', model: 'gpt' } }];
  const added = ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_lifecycle', type: 'message', role: 'assistant', content: [] } }];
  const done = ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_lifecycle', type: 'message', role: 'assistant', content: [] } }];
  const textDone = ['response.output_text.done', {
    type: 'response.output_text.done', item_id: 'msg_lifecycle', output_index: 0, content_index: 0, text: '完成'
  }];
  const textDelta = ['response.output_text.delta', {
    type: 'response.output_text.delta', item_id: 'msg_lifecycle', output_index: 0, content_index: 0, delta: '过期内容'
  }];
  const partAdded = ['response.content_part.added', {
    type: 'response.content_part.added', item_id: 'msg_lifecycle', output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  }];
  const partDone = ['response.content_part.done', {
    type: 'response.content_part.done', item_id: 'msg_lifecycle', output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '完成', annotations: [] }
  }];
  for (const [events, pattern] of [
    [[added, added], /重复收到 output_item\.added/],
    [[done, done], /重复收到 output_item\.done/],
    [[done, added], /output_item\.done 之后又收到 output_item\.added/],
    [[done, textDelta], /output_item\.done 之后又收到内容事件/],
    [[textDone, textDone], /重复收到 response\.output_text\.done/],
    [[textDone, textDelta], /对应 done 事件之后/],
    [[partAdded, partAdded], /content\[0\] 重复收到 added/],
    [[partDone, partAdded], /content\[0\] 在 done 之后又收到 added/]
  ]) {
    await assert.rejects(
      collect(translateSse(responseFrom([created, ...events]), 'responses', 'chat', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const terminalThenAdded = await collect(translateSse(responseFrom([
    created,
    ['response.completed', { type: 'response.completed', response: { status: 'completed', output: [] } }],
    added
  ]), 'responses', 'claude', 'alias'));
  assert.equal((terminalThenAdded.match(/event: message_stop/g) || []).length, 1);
  assert.doesNotMatch(terminalThenAdded, /msg_lifecycle/);

  const doneOnly = await collect(translateSse(responseFrom([
    created,
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
      id: 'msg_done_only', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '兜底内容' }]
    } }],
    ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } }]
  ]), 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  assert.match(doneOnly, /兜底内容/);
});

test('Responses 跨协议流校验显式 SSE 事件名和可选序号顺序', async () => {
  const created = { type: 'response.created', sequence_number: 2, response: { id: 'resp_envelope', model: 'gpt' } };
  const completed = { type: 'response.completed', sequence_number: 9, response: { status: 'completed', output: [] } };
  const compatible = await collect(translateSse(responseFrom([
    ['message', created],
    ['message', completed]
  ]), 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  assert.match(compatible, /"finish_reason":"stop"/);

  for (const [events, pattern] of [
    [[['response.output_item.added', created]], /SSE event=response\.output_item\.added 与 data\.type=response\.created 不一致/],
    [[['response.created', { ...created, sequence_number: '2' }]], /sequence_number 必须是非负安全整数/],
    [[['response.created', created], ['response.completed', { ...completed, sequence_number: 2 }]], /sequence_number 未严格递增：2 → 2/],
    [[['response.created', created], ['response.completed', { ...completed, sequence_number: 1 }]], /sequence_number 未严格递增：2 → 1/],
    [[['message', { sequence_number: 0 }]], /data\.type 必须是非空字符串/],
    [[['response.created', null]], /SSE data 必须是 JSON 对象/]
  ]) {
    await assert.rejects(
      collect(translateSse(responseFrom(events), 'responses', 'claude', 'alias')),
      (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && pattern.test(error.message)
    );
  }

  const observed = await observeSse(responseFrom([
    ['vendor.created', created],
    ['vendor.completed', completed]
  ]), 'responses', 'alias');
  assert.equal(observed.error, undefined);
});

test('Claude 跨协议流校验显式 SSE 事件名并兼容 data-only 与未知事件', async () => {
  const messageStart = { type: 'message_start', message: { id: 'msg_envelope', model: 'claude', content: [] } };
  const messageDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } };
  const messageStop = { type: 'message_stop' };
  const compatible = await collect(translateSse(responseFrom([
    ['message', messageStart],
    ['future_event', { type: 'future_event', extension: true }],
    ['message', messageDelta],
    ['message', messageStop]
  ]), 'claude', 'responses', 'alias'));
  assert.match(compatible, /response\.completed/);

  await assert.rejects(
    collect(translateSse(responseFrom([
      ['content_block_delta', messageStart]
    ]), 'claude', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE'
      && /SSE event=content_block_delta 与 data\.type=message_start 不一致/.test(error.message)
  );
  await assert.rejects(
    collect(translateSse(responseFrom([
      ['message', { extension: true }]
    ]), 'claude', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /data\.type 必须是非空字符串/.test(error.message)
  );

  const observed = await observeSse(responseFrom([
    ['vendor.start', messageStart],
    ['vendor.delta', messageDelta],
    ['vendor.stop', messageStop]
  ]), 'claude', 'alias');
  assert.equal(observed.error, undefined);
});

test('Responses 与 Claude 流中的未知输出块不会被静默丢弃', async () => {
  const responsesItem = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_media', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'img_1', type: 'image_generation_call', status: 'in_progress' } }]
  ]);
  await assert.rejects(
    collect(translateSse(responsesItem, 'responses', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /image_generation_call/.test(error.message)
  );

  const responsesPart = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_audio', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_audio', type: 'message', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_audio', audio: 'opaque' } }]
  ]);
  await assert.rejects(
    collect(translateSse(responsesPart, 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /output_audio/.test(error.message)
  );

  const programCall = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_program', model: 'gpt-5.6-sol' } }],
    ['response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: {
        id: 'fc_nested', type: 'function_call', call_id: 'call_nested', name: 'inventory', arguments: '',
        caller: { type: 'program', caller_id: 'call_program' }
      }
    }]
  ]);
  await assert.rejects(
    collect(translateSse(programCall, 'responses', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' && /caller/.test(error.message)
  );

  const claudeBlock = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_redacted', model: 'claude', usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  const redactedOutput = await collect(translateSse(claudeBlock, 'claude', 'responses', 'alias'));
  assert.match(redactedOutput, /"type":"reasoning"/);
  assert.match(redactedOutput, /"encrypted_content":"[A-Za-z0-9_-]+"/);
});

test('同协议观察器允许厂商扩展内容块并继续提取 usage', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_media_passthrough', model: 'multimodal', choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_media_passthrough', choices: [{ delta: {}, finish_reason: 'vendor_stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }]
  ]);
  const observed = await observeSse(source, 'chat', 'alias');
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
});

test('Responses refusal 流保留拒答块并转换为 Claude refusal', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_refusal', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_refusal', type: 'message', role: 'assistant', content: [] } }],
    ['response.refusal.delta', { type: 'response.refusal.delta', output_index: 0, delta: '无法' }],
    ['response.refusal.done', { type: 'response.refusal.done', output_index: 0, refusal: '无法协助' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_refusal', type: 'message', content: [{ type: 'refusal', refusal: '无法协助' }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { prompt_tokens: 3, completion_tokens: 2 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias'));
  assert.match(output, /"text":"无法"/);
  assert.match(output, /"text":"协助"/);
  assert.equal((output.match(/协助/g) || []).length, 1);
  assert.match(output, /"stop_reason":"refusal"/);
  assert.match(output, /"output_tokens":2/);
});

test('Responses 与 Chat refusal 流互转时使用各自的拒答增量字段', async () => {
  const responsesSource = () => responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_refusal_fields', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_refusal_fields', type: 'message', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } }],
    ['response.refusal.delta', { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: '不能协助' }],
    ['response.refusal.done', { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: '不能协助' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_refusal_fields', type: 'message', content: [{ type: 'refusal', refusal: '不能协助' }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } }]
  ]);
  const chat = await collect(translateSse(responsesSource(), 'responses', 'chat', 'alias', { chatOptions: { includeObfuscation: false } }));
  assert.match(chat, /"delta":\{"refusal":"不能协助"\}/);
  assert.doesNotMatch(chat, /"content":"不能协助"/);
  assert.match(chat, /"finish_reason":"stop"/);

  const chatSource = responseFrom([
    ['message', { id: 'chat_refusal_fields', model: 'chat', choices: [{ delta: { refusal: '不能协助' }, finish_reason: null }] }],
    ['message', { id: 'chat_refusal_fields', model: 'chat', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }]
  ]);
  const responses = await collect(translateSse(chatSource, 'chat', 'responses', 'alias', { responsesOptions: { includeObfuscation: false } }));
  assert.match(responses, /"type":"response.refusal.delta"/);
  assert.match(responses, /"type":"response.refusal.done"/);
  assert.match(responses, /"content":\[\{"type":"refusal","refusal":"不能协助"\}\]/);
  assert.match(responses, /"status":"completed"/);
  assert.doesNotMatch(responses, /"type":"response.output_text.delta"/);
});

test('Responses incomplete 与 failed 流不会静默结束', async () => {
  const incomplete = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_limit', model: 'gpt' } }],
    ['response.incomplete', { type: 'response.incomplete', response: { id: 'resp_limit', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 2, output_tokens: 4 } } }]
  ]);
  const incompleteOutput = await collect(translateSse(incomplete, 'responses', 'claude', 'alias'));
  assert.match(incompleteOutput, /"stop_reason":"max_tokens"/);
  assert.match(incompleteOutput, /"output_tokens":4/);

  const failed = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_fail', model: 'gpt' } }],
    ['response.failed', { type: 'response.failed', response: { id: 'resp_fail', error: { type: 'server_error', message: '上游失败' } } }]
  ]);
  let streamError;
  const failedOutput = await collect(translateSse(failed, 'responses', 'claude', 'alias', { onError: (error) => { streamError = error; } }));
  assert.match(failedOutput, /event: error/);
  assert.match(failedOutput, /上游失败/);
  assert.doesNotMatch(failedOutput, /message_stop/);
  assert.equal(streamError.message, '上游失败');

  const invalidIncomplete = () => responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_unknown_limit', model: 'gpt' } }],
    ['response.incomplete', { type: 'response.incomplete', response: {
      id: 'resp_unknown_limit', status: 'incomplete', incomplete_details: { reason: 'vendor_limit' }
    } }]
  ]);
  await assert.rejects(
    collect(translateSse(invalidIncomplete(), 'responses', 'chat', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /vendor_limit/.test(error.message)
  );
  await assert.rejects(
    collect(translateSse(responseFrom([
      ['response.created', { type: 'response.created', response: { id: 'resp_bad_completed', model: 'gpt' } }],
      ['response.completed', { type: 'response.completed', response: {
        id: 'resp_bad_completed', status: 'failed', error: { message: '不应成功' }
      } }]
    ]), 'responses', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_INVALID_STREAM_SEQUENCE' && /status=failed/.test(error.message)
  );

});

test('流式过滤和截断终止在目标协议中保持非正常完成语义', async () => {
  const filteredSource = () => responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_filtered', model: 'gpt' } }],
    ['response.incomplete', { type: 'response.incomplete', response: {
      id: 'resp_filtered', incomplete_details: { reason: 'content_filter' },
      usage: { input_tokens: 2, output_tokens: 0 }
    } }]
  ]);
  const chat = await collect(translateSse(filteredSource(), 'responses', 'chat', 'alias', {
    chatOptions: { includeObfuscation: false }
  }));
  assert.match(chat, /"finish_reason":"content_filter"/);
  const claude = await collect(translateSse(filteredSource(), 'responses', 'claude', 'alias'));
  assert.match(claude, /"stop_reason":"refusal"/);
  const gemini = await collect(translateSse(filteredSource(), 'responses', 'gemini', 'alias'));
  assert.match(gemini, /"finishReason":"SAFETY"/);

  const truncatedTool = responseFrom([
    ['message', { id: 'chat_truncated_tool', model: 'chat-test', choices: [{
      delta: { tool_calls: [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      finish_reason: null
    }] }],
    ['message', { id: 'chat_truncated_tool', model: 'chat-test', choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }]
  ]);
  const responses = await collect(translateSse(truncatedTool, 'chat', 'responses', 'alias', {
    responsesOptions: { includeObfuscation: false }
  }));
  const events = responses.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  const itemDone = events.find((event) => event.type === 'response.output_item.done');
  const incomplete = events.find((event) => event.type === 'response.incomplete');
  assert.equal(itemDone.item.status, 'incomplete');
  assert.equal(incomplete.response.status, 'incomplete');
  assert.equal(incomplete.response.completed_at, null);
  assert.deepEqual(incomplete.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.ok(events.indexOf(itemDone) < events.indexOf(incomplete));
});

test('流式缓存创建 token 与 incomplete 状态会保留到目标协议', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_cache', model: 'gpt', usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 } } } }],
    ['response.incomplete', { type: 'response.incomplete', response: { id: 'resp_cache', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 } } } }]
  ]);
  let usage;
  const output = await collect(translateSse(source, 'responses', 'responses', 'alias', { onUsage: (value) => { usage = value; } }));
  assert.match(output, /event: response\.incomplete/);
  assert.match(output, /"status":"incomplete"/);
  assert.match(output, /"cache_write_tokens":3/);
  assert.doesNotMatch(output, /"cache_creation_tokens":/);
  assert.deepEqual(usage, { inputTokens: 8, outputTokens: 4, cachedInputTokens: 2, cacheCreationInputTokens: 3, reasoningTokens: 0 });
});

test('流式 Responses 与 Chat 兼容缓存和推理 usage 别名', async () => {
  const responses = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_alias', model: 'gpt', usage: { prompt_tokens: 9, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 } } } }],
    ['response.completed', { type: 'response.completed', response: { usage: { prompt_tokens: 9, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } } } }]
  ]);
  const responseUsage = (await observeSse(responses, 'responses', 'alias')).usage;
  assert.deepEqual(responseUsage, { inputTokens: 9, outputTokens: 5, cachedInputTokens: 4, cacheCreationInputTokens: 2, reasoningTokens: 3 });

  const chat = responseFrom([
    ['message', { id: 'chat_alias_usage', model: 'deepseek', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 2 } }]
  ]);
  const chatUsage = (await observeSse(chat, 'chat', 'alias')).usage;
  assert.equal(chatUsage.cachedInputTokens, 5);
});

test('Responses 与 Chat 流式转换保留稳定时间戳和公共追踪元数据', async () => {
  const responsesSource = responseFrom([
    ['response.created', { type: 'response.created', response: {
      id: 'resp_meta', created_at: 1_725_000_123, model: 'gpt-test',
      service_tier: 'priority'
    } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_meta', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: '完成' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_meta', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] } }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_meta', created_at: 1_725_000_123, model: 'gpt-test',
      service_tier: 'flex', usage: { input_tokens: 2, output_tokens: 1 }
    } }]
  ]);
  const chatOutput = await collect(translateSse(responsesSource, 'responses', 'chat', 'alias'));
  const chatChunks = chatOutput.split(/\n\n/).filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)));
  assert.ok(chatChunks.every((chunk) => chunk.created === 1_725_000_123));
  assert.equal(chatChunks[0].service_tier, 'priority');
  assert.equal(chatChunks.at(-1).service_tier, 'flex');
  assert.ok(chatChunks.every((chunk) => !('system_fingerprint' in chunk)));

  const chatSource = responseFrom([
    ['message', { id: 'chat_meta', object: 'chat.completion.chunk', created: 1_725_000_456, model: 'chat-test', service_tier: 'flex', system_fingerprint: 'fp_chat', choices: [{ index: 0, delta: { role: 'assistant', content: '完成' }, finish_reason: null }] }],
    ['message', { id: 'chat_meta', object: 'chat.completion.chunk', created: 1_725_000_456, model: 'chat-test', service_tier: 'flex', system_fingerprint: 'fp_chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }]
  ]);
  const responsesOutput = await collect(translateSse(chatSource, 'chat', 'responses', 'alias'));
  const responseEvents = responsesOutput.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  for (const event of responseEvents.filter((event) => event.response)) {
    assert.equal(event.response.created_at, 1_725_000_456);
    assert.equal(event.response.service_tier, 'flex');
    assert.equal('system_fingerprint' in event.response, false);
  }
});

test('Claude speed 与 OpenAI service_tier 在流式响应中双向保留', async () => {
  const claudeSource = responseFrom([
    ['message_start', { type: 'message_start', message: {
      id: 'msg_speed', type: 'message', role: 'assistant', model: 'claude-test', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0, speed: 'fast' }
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1, speed: 'fast' } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  const responsesOutput = await collect(translateSse(claudeSource, 'claude', 'responses', 'claude-test'));
  const responsesEvents = responsesOutput.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  for (const event of responsesEvents.filter((event) => event.response)) assert.equal(event.response.service_tier, 'fast');

  const responsesSource = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_speed', status: 'in_progress', model: 'gpt-test', service_tier: 'default' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_speed', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: '完成' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_speed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] } }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_speed', status: 'completed', model: 'gpt-test', service_tier: 'default', usage: { input_tokens: 2, output_tokens: 1 } } }]
  ]);
  const claudeOutput = await collect(translateSse(responsesSource, 'responses', 'claude', 'gpt-test'));
  const messageStart = claudeOutput.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)))
    .find((event) => event.type === 'message_start');
  assert.equal(messageStart.message.usage.speed, 'standard');
});

test('重编码的 OpenAI delta 支持默认定长混淆和显式关闭', async () => {
  const makeSource = () => responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_obfuscation', model: 'claude-test', usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]
  ]);
  const enabled = await collect(translateSse(makeSource(), 'claude', 'responses', 'alias'));
  const enabledDeltaBlock = enabled.split(/\n\n/).find((block) => block.startsWith('event: response.output_text.delta'));
  const enabledDeltaJson = enabledDeltaBlock.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6);
  const enabledDelta = JSON.parse(enabledDeltaJson);
  assert.equal(typeof enabledDelta.obfuscation, 'string');
  assert.ok(enabledDelta.obfuscation.length > 0);
  assert.equal(Buffer.byteLength(enabledDeltaJson, 'utf8') % 256, 0);

  const disabled = await collect(translateSse(makeSource(), 'claude', 'responses', 'alias', {
    responsesOptions: { includeObfuscation: false }
  }));
  const disabledDeltaBlock = disabled.split(/\n\n/).find((block) => block.startsWith('event: response.output_text.delta'));
  const disabledDelta = JSON.parse(disabledDeltaBlock.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6));
  assert.equal('obfuscation' in disabledDelta, false);
});

test('Chat include_usage 使用独立空 choices 用量 chunk', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_chat_usage', model: 'gpt-test' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_chat_usage', type: 'message', role: 'assistant', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: '完成' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_chat_usage', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias', {
    chatOptions: { includeUsage: true, includeObfuscation: false }
  }));
  const chunks = output.split(/\n\n/).filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)));
  const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === 'stop');
  const usage = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
  assert.equal(finish.usage, null);
  assert.ok(chunks.filter((chunk) => chunk.choices?.length).every((chunk) => chunk.usage === null));
  assert.deepEqual(usage.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  assert.ok(chunks.every((chunk) => !('obfuscation' in chunk)));
});

test('转换到 Chat 的流式错误使用 data 帧并正常结束', async () => {
  const source = responseFrom([
    ['response.failed', { type: 'response.failed', response: { error: { type: 'server_error', message: '上游失败' } } }]
  ]);
  const output = await collect(translateSse(source, 'responses', 'chat', 'alias'));
  assert.doesNotMatch(output, /event: error/);
  assert.match(output, /^data: \{"error":/);
  assert.match(output, /data: \[DONE\]/);
});

test('转换到 Responses 的流式错误使用标准顶层字段和序号', async () => {
  const source = responseFrom([
    ['message_start', { type: 'message_start', message: { id: 'msg_error', model: 'claude-test', usage: { input_tokens: 1 } } }],
    ['error', { type: 'error', error: { type: 'overloaded_error', message: '上游繁忙' } }]
  ]);
  const output = await collect(translateSse(source, 'claude', 'responses', 'alias'));
  const errorBlock = output.split(/\n\n/).find((block) => block.startsWith('event: error'));
  const error = JSON.parse(errorBlock.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6));
  assert.deepEqual(error, { type: 'error', code: 'overloaded_error', message: '上游繁忙', param: null, sequence_number: 1 });
  assert.equal('error' in error, false);
});

test('跨协议流式错误可在输出和回调前统一脱敏', async () => {
  const source = responseFrom([
    ['response.failed', { type: 'response.failed', response: { error: {
      type: 'server_error', code: 'secret-key',
      message: 'first-key through socks5://user:pass@127.0.0.1:1080',
      debug: { authorization: 'Bearer first-key' }
    } } }]
  ]);
  let observed;
  const output = await collect(translateSse(source, 'responses', 'claude', 'alias', {
    normalizeError: (error) => normalizeUpstreamStreamError(error, {
      secrets: ['first-key', 'secret-key', 'socks5://user:pass@127.0.0.1:1080']
    }),
    onError: (error) => { observed = error; }
  }));
  assert.deepEqual(observed, {
    message: '[REDACTED] through [REDACTED]',
    type: 'server_error'
  });
  assert.match(output, /\[REDACTED\] through \[REDACTED\]/);
  assert.doesNotMatch(output, /first-key|secret-key|user:pass|authorization|debug/);
});

test('同协议 SSE 过滤器只改写安全错误并停止尾随事件', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', sequence_number: 3, response: { id: 'resp_safe_error', model: 'gpt' } }],
    ['response.failed', { type: 'response.failed', sequence_number: 7, response: { error: {
      type: 'server_error', code: 'secret-key', message: 'failed for first-key', debug: { key: 'first-key' }
    } } }],
    ['response.completed', { type: 'response.completed', sequence_number: 8, response: { status: 'completed' } }]
  ]);
  const output = await collect(sanitizeSseErrorStream(source.body, 'responses', (error) => normalizeUpstreamStreamError(error, {
    secrets: ['first-key', 'secret-key']
  })));
  assert.match(output, /event: response\.created/);
  assert.match(output, /event: error/);
  assert.match(output, /"message":"failed for \[REDACTED\]"/);
  assert.match(output, /"sequence_number":7/);
  assert.doesNotMatch(output, /first-key|secret-key|debug|response\.completed/);
});

test('同协议 SSE 过滤器按显式事件名拦截非标准错误载荷', async () => {
  const encoder = new TextEncoder();
  const responsesSource = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([
        'event: response.created',
        'data: {"type":"response.created","sequence_number":4,"response":{"id":"resp_explicit_error"}}',
        '',
        'event: response.failed',
        'data: {"sequence_number":9,"message":"failed for exposed-key","debug":{"authorization":"exposed-key"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","sequence_number":10}',
        '',
        ''
      ].join('\n')));
      controller.close();
    }
  });
  const responsesOutput = await collect(sanitizeSseErrorStream(responsesSource, 'responses', (error) => normalizeUpstreamStreamError(error, {
    secrets: ['exposed-key']
  })));
  assert.match(responsesOutput, /event: response\.created/);
  assert.match(responsesOutput, /event: error/);
  assert.match(responsesOutput, /"message":"failed for \[REDACTED\]"/);
  assert.match(responsesOutput, /"sequence_number":9/);
  assert.doesNotMatch(responsesOutput, /exposed-key|authorization|debug|response\.completed/);

  const claudeSource = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: error\ndata: "plain-secret"\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    }
  });
  const claudeOutput = await collect(sanitizeSseErrorStream(claudeSource, 'claude', (error) => normalizeUpstreamStreamError(error, {
    secrets: ['plain-secret']
  })));
  assert.match(claudeOutput, /event: error/);
  assert.match(claudeOutput, /\[REDACTED\]/);
  assert.doesNotMatch(claudeOutput, /plain-secret|message_stop/);
});

test('同协议 SSE 对高度碎片化的大事件保持线性增量处理', { timeout: 5_000 }, async () => {
  const encoder = new TextEncoder();
  const raw = encoder.encode(`data: ${JSON.stringify({ id: 'fragmented', text: 'x'.repeat(64 * 1024) })}\n\n`);
  async function* fragmented() {
    for (let index = 0; index < raw.length; index++) yield raw.subarray(index, index + 1);
  }
  const output = await collect(sanitizeSseErrorStream(fragmented(), 'chat'));
  assert.equal(output, new TextDecoder().decode(raw));
});

test('同协议 SSE 小分片按批暂存且每个完整事件只计算一次大字节长度', async () => {
  const encoder = new TextEncoder();
  const raw = encoder.encode(`data: ${JSON.stringify({ id: 'batched', text: 'x'.repeat(8 * 1024) })}\n\n`);
  async function* fragmented() {
    for (let index = 0; index < raw.length; index++) yield raw.subarray(index, index + 1);
  }

  const byteLength = Buffer.byteLength;
  let byteLengthCalls = 0;
  Buffer.byteLength = function countedByteLength(...args) {
    byteLengthCalls++;
    return Reflect.apply(byteLength, Buffer, args);
  };
  let output;
  try {
    output = await collect(sanitizeSseErrorStream(fragmented(), 'chat'));
  } finally {
    Buffer.byteLength = byteLength;
  }

  assert.equal(output, new TextDecoder().decode(raw));
  assert.ok(byteLengthCalls <= 1, `完整 ASCII 事件最多只应在边界确认时计算一次大字节长度，实际 ${byteLengthCalls} 次`);
});

test('同协议 SSE 按字节分片时保留非 ASCII 内容和跨分片 CRLF 边界', async () => {
  const encoder = new TextEncoder();
  const raw = encoder.encode(`data: ${JSON.stringify({ id: 'unicode-fragments', text: '你好🙂'.repeat(1024) })}\r\n\r\n`);
  async function* fragmented() {
    for (let index = 0; index < raw.length; index++) yield raw.subarray(index, index + 1);
  }

  const output = await collect(sanitizeSseErrorStream(fragmented(), 'chat'));
  assert.equal(output, new TextDecoder().decode(raw));
});

test('转换到 Responses 在异常前公开下一个序号', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_started', model: 'chat-test', choices: [{ delta: { role: 'assistant', content: '已开始' }, finish_reason: null }] }],
    ['message', { id: 'chat_started', choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }] }]
  ]);
  let nextSequenceNumber = 0;
  await assert.rejects(
    collect(translateSse(source, 'chat', 'responses', 'alias', { onResponsesSequenceNumber: (next) => { nextSequenceNumber = next; } })),
    (error) => error.code === 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT'
  );
  assert.equal(nextSequenceNumber, 4);
});

test('同协议 Responses 观察器保留追加错误所需的下一个序号', async () => {
  const source = responseFrom([
    ['response.created', { type: 'response.created', sequence_number: 7, response: { id: 'resp_truncated', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 8, output_index: 0, item: { id: 'msg_truncated', type: 'message', role: 'assistant', content: [] } }]
  ]);
  const observed = await observeSse(source, 'responses', 'alias');
  assert.equal(observed.error.message, '上游 SSE 在完成事件前结束');
  assert.equal(observed.nextSequenceNumber, 9);
});

test('上游 SSE 提前断开会生成明确错误', async () => {
  const truncated = responseFrom([
    ['response.created', { type: 'response.created', response: { id: 'resp_cut', model: 'gpt' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_cut', type: 'message', role: 'assistant' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: '未完成' }]
  ]);
  let streamError;
  const output = await collect(translateSse(truncated, 'responses', 'claude', 'alias', { onError: (error) => { streamError = error; } }));
  assert.match(output, /上游 SSE 在完成事件前结束/);
  assert.equal(streamError.type, 'upstream_error');
  assert.doesNotMatch(output, /message_stop/);
});

test('上游 SSE 单事件超过安全上限时停止缓冲', async () => {
  const encoder = new TextEncoder();
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(
    collect(translateSse(oversized, 'chat', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_SSE_EVENT_TOO_LARGE' && /8 MiB/.test(error.message)
  );
});

test('跨协议 SSE 在适配前拒绝异常复杂的事件与字符串工具参数', async () => {
  let nested = null;
  for (let depth = 0; depth < 257; depth++) nested = { value: nested };

  const complexEvent = responseFrom([
    ['message', { id: 'chat_complex', model: 'chat-test', nested, choices: [{ delta: { content: 'x' }, finish_reason: null }] }]
  ]);
  await assert.rejects(
    collect(translateSse(complexEvent, 'chat', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_JSON_TOO_COMPLEX' && /SSE 事件 JSON/.test(error.message)
  );

  const argumentsText = JSON.stringify(nested);
  const complexArguments = responseFrom([
    ['message', { id: 'chat_args', model: 'chat-test', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_complex', type: 'function', function: { name: 'probe', arguments: argumentsText } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_args', model: 'chat-test', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]
  ]);
  await assert.rejects(
    collect(translateSse(complexArguments, 'chat', 'claude', 'alias')),
    (error) => error.code === 'UPSTREAM_JSON_TOO_COMPLEX' && /tool JSON 参数/.test(error.message)
  );
});

test('同协议观察器超过事件上限时放弃统计但不破坏透传结果', async () => {
  const encoder = new TextEncoder();
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  const observed = await observeSse(oversized, 'chat', 'alias');
  assert.equal(observed.error, undefined);
  assert.match(observed.observationSkipped, /8 MiB/);
  assert.deepEqual(observed.usage, {});
});
