import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseObserver, MAX_SSE_EVENT_BYTES, observeSse, translateSse } from '../src/stream.js';

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
    responsesOptions: { parallelToolCalls: false, toolChoice: { type: 'function', name: 'lookup' }, tools: responseTools }
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
  assert.ok(events.filter((event) => event.type === 'response.output_text.delta').every((event) => Array.isArray(event.logprobs)));
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.parallel_tool_calls, false);
  assert.deepEqual(completed.response.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(completed.response.tools, responseTools);
  assert.deepEqual(completed.response.usage.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 });
  assert.deepEqual(completed.response.usage.output_tokens_details, { reasoning_tokens: 0 });
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
  assert.deepEqual(usage, { inputTokens: 9, outputTokens: 6, cachedInputTokens: 5, cacheCreationInputTokens: 0, reasoningTokens: 4 });
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
  assert.match(contentOutput, /"text":"分段拒绝"/);
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

test('同协议观察器允许厂商扩展内容块并继续提取 usage', async () => {
  const source = responseFrom([
    ['message', { id: 'chat_media_passthrough', model: 'multimodal', choices: [{ delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }] }],
    ['message', { id: 'chat_media_passthrough', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }]
  ]);
  const observed = await observeSse(source, 'chat', 'alias');
  assert.equal(observed.error, undefined);
  assert.deepEqual(observed.usage, { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
});

test('Responses refusal 流可转换为普通文本块', async () => {
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
  assert.match(output, /"output_tokens":2/);
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
