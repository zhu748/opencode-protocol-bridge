import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateClaudeInputTokens } from '../src/token-count.js';

test('Claude token 估算覆盖英文、中文、system 与工具定义', () => {
  const short = estimateClaudeInputTokens({ model: 'test', messages: [{ role: 'user', content: 'hello' }] });
  const long = estimateClaudeInputTokens({
    model: 'test', system: '系统约束', messages: [{ role: 'user', content: 'hello 你好世界 '.repeat(100) }],
    tools: [{ name: 'read', description: '读取文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]
  });
  assert.ok(Number.isSafeInteger(short) && short > 0);
  assert.ok(long > short);
});

test('Claude token 估算拒绝无效请求并能处理深层 JSON', () => {
  assert.throws(() => estimateClaudeInputTokens(null), /JSON 对象/);
  assert.throws(() => estimateClaudeInputTokens({ model: '', messages: [{}] }), /model/);
  assert.throws(() => estimateClaudeInputTokens({ model: 'test', messages: [] }), /messages/);
  let content = '末端';
  for (let index = 0; index < 20_000; index++) content = { child: content };
  assert.ok(estimateClaudeInputTokens({ model: 'test', messages: [{ role: 'user', content }] }) > 0);
});

test('Claude token 估算不计 deferred tools 并保留当前工具链 thinking', () => {
  const messages = [{ role: 'user', content: '执行任务' }];
  const loadedTool = { name: 'ToolSearch', description: '搜索并加载工具', input_schema: { type: 'object' } };
  const withoutDeferred = estimateClaudeInputTokens({ model: 'test', messages, tools: [loadedTool] });
  const deferred = estimateClaudeInputTokens({
    model: 'test', messages,
    tools: [loadedTool, { name: 'hidden', description: '很长的隐藏工具 '.repeat(1000), input_schema: { type: 'object' }, defer_loading: true }]
  });
  const visible = estimateClaudeInputTokens({
    model: 'test', messages,
    tools: [loadedTool, { name: 'visible', description: '很长的可见工具 '.repeat(1000), input_schema: { type: 'object' } }]
  });
  assert.equal(deferred, withoutDeferred);
  assert.ok(visible > deferred + 1000);

  const ongoing = [
    { role: 'user', content: '先读取文件' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '当前工具链推理 '.repeat(1000), signature: 'signed' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '结果' }] }
  ];
  const withCurrentThinking = estimateClaudeInputTokens({ model: 'test', messages: ongoing });
  const withoutCurrentThinking = estimateClaudeInputTokens({
    model: 'test', messages: ongoing.map((message) => message.role === 'assistant'
      ? { ...message, content: message.content.filter((part) => part.type !== 'thinking') }
      : message)
  });
  assert.ok(withCurrentThinking > withoutCurrentThinking + 1000);
});

test('Claude token 估算接受有效 redacted_thinking 并校验不透明思考状态', () => {
  const body = {
    model: 'test',
    messages: [
      { role: 'user', content: '调用工具' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'signed-empty-thinking' },
        { type: 'redacted_thinking', data: 'encrypted-state' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: {} }
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '结果' }] }
    ]
  };
  assert.ok(estimateClaudeInputTokens(body) > 0);
  const withBlock = (block) => estimateClaudeInputTokens({ model: 'test', messages: [{ role: 'assistant', content: [block] }] });
  assert.throws(() => withBlock({ type: 'thinking', thinking: '' }), /signature 必须是非空字符串/);
  assert.throws(() => withBlock({ type: 'redacted_thinking', data: '' }), /data 必须是非空字符串/);
});

test('Claude token 估算接受并校验 fallback 边界块', () => {
  const withBlock = (block) => estimateClaudeInputTokens({
    model: 'test', messages: [{ role: 'assistant', content: [block, { type: 'text', text: '答案' }] }]
  });
  assert.ok(withBlock({ type: 'fallback', from: { model: 'claude-primary' }, to: { model: 'claude-fallback' } }) > 0);
  assert.throws(
    () => withBlock({ type: 'fallback', from: { model: 'claude-primary' }, to: {} }),
    /to\.model 必须是非空字符串/
  );
});

test('Claude token 估算验证 compaction 且不把不透明密文当作提示文本', () => {
  const estimate = (block) => estimateClaudeInputTokens({
    model: 'test', messages: [{ role: 'assistant', content: [block] }, { role: 'user', content: '继续' }]
  });
  const short = estimate({ type: 'compaction', content: '压缩摘要', encrypted_content: 'x' });
  const long = estimate({ type: 'compaction', content: '压缩摘要', encrypted_content: 'x'.repeat(100000) });
  assert.equal(long, short);
  assert.ok(estimate({ type: 'compaction', content: '压缩摘要 '.repeat(100), encrypted_content: null }) > short);
  assert.throws(() => estimate({ type: 'compaction', content: '', encrypted_content: null }), /content 必须是非空字符串或 null/);
  assert.throws(() => estimate({ type: 'compaction', content: '摘要', encrypted_content: 1 }), /encrypted_content 必须是非空字符串或 null/);
});

test('Claude token 估算在 tool_reference 加载后计入 deferred tool 定义', () => {
  const tools = [
    { name: 'ToolSearch', description: '搜索并加载工具', input_schema: { type: 'object' } },
    { name: 'hidden', description: '加载后应计数的长工具定义 '.repeat(1000), input_schema: { type: 'object' }, defer_loading: true }
  ];
  const beforeMessages = [{ role: 'user', content: '寻找合适工具' }];
  const afterMessages = [
    ...beforeMessages,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'search_1', name: 'ToolSearch', input: { query: 'hidden' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'hidden' }] }] }
  ];
  const before = estimateClaudeInputTokens({ model: 'test', messages: beforeMessages, tools });
  const after = estimateClaudeInputTokens({ model: 'test', messages: afterMessages, tools });
  assert.ok(after > before + 1000);
});

test('Claude token 估算不会把工具参数中的同形 JSON 当作 tool_reference', () => {
  const messages = [
    { role: 'user', content: '检查参数' },
    { role: 'assistant', content: [{
      type: 'tool_use', id: 'call_1', name: 'ToolSearch',
      input: { payload: { type: 'tool_reference', tool_name: 'hidden' } }
    }] }
  ];
  const visible = { name: 'ToolSearch', description: '搜索', input_schema: { type: 'object' } };
  const hidden = {
    name: 'hidden', description: '未实际加载的长工具定义 '.repeat(1000),
    input_schema: { type: 'object' }, defer_loading: true
  };

  assert.equal(
    estimateClaudeInputTokens({ model: 'test', messages, tools: [visible, hidden] }),
    estimateClaudeInputTokens({ model: 'test', messages, tools: [visible] })
  );
});

test('Claude token 估算忽略旧轮 thinking 并按视觉 token 上限估算 base64 图片', () => {
  const oldThinking = '已经结束的历史推理 '.repeat(5000);
  const history = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: oldThinking, signature: 'signed' }, { type: 'text', text: '旧答案' }] },
    { role: 'user', content: '新问题' }
  ];
  const strippedHistory = history.map((message) => message.role === 'assistant'
    ? { ...message, content: message.content.filter((part) => part.type !== 'thinking') }
    : message);
  assert.equal(
    estimateClaudeInputTokens({ model: 'test', messages: history }),
    estimateClaudeInputTokens({ model: 'test', messages: strippedHistory })
  );

  const imageTokens = estimateClaudeInputTokens({
    model: 'test',
    messages: [{ role: 'user', content: [{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1024 * 1024) }
    }, { type: 'text', text: '识别图片' }] }]
  });
  assert.ok(imageTokens >= 4784);
  assert.ok(imageTokens < 10_000);
});

test('Claude token 估算严格校验 deferred tool 形状', () => {
  const base = { model: 'test', messages: [{ role: 'user', content: '测试' }] };
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: {} }), /tools 必须是数组/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [null] }), /tools\[0\] 必须是对象/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ input_schema: {} }] }), /name 必须是非空字符串/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'same' }, { name: 'same' }] }), /工具名称重复/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', defer_loading: 'yes' }] }), /defer_loading 必须是布尔值/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'hidden', defer_loading: true }] }), /至少一个工具/);
  const referenceMessages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'missing' }] }] }];
  assert.throws(() => estimateClaudeInputTokens({ model: 'test', messages: referenceMessages, tools: [{ name: 'ToolSearch' }] }), /引用了未定义工具/);
  assert.throws(() => estimateClaudeInputTokens({ model: 'test', messages: referenceMessages, tools: [{ name: 'ToolSearch' }, { name: 'missing' }] }), /只能引用 defer_loading=true/);
});

test('Claude token 估算与发送链路统一校验新工具字段和 cache_control', () => {
  const base = { model: 'test', messages: [{ role: 'user', content: '测试' }] };
  const valid = estimateClaudeInputTokens({
    ...base, cache_control: { type: 'ephemeral', ttl: '1h' },
    tools: [{
      type: 'web_search_20260318', name: 'web_search', description: '搜索', input_schema: { type: 'object' },
      cache_control: { type: 'ephemeral', ttl: '5m' }, strict: true,
      allowed_callers: ['direct', 'code_execution_20260521'], input_examples: [{ query: 'news' }], eager_input_streaming: true
    }]
  });
  assert.ok(valid > 0);
  assert.throws(() => estimateClaudeInputTokens({ ...base, cache_control: { type: 'ephemeral', ttl: '30m' } }), /ttl 必须是 5m 或 1h/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', description: 1 }] }), /description 必须是字符串/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', input_schema: [] }] }), /input_schema 必须是对象/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', strict: 'yes' }] }), /strict 必须是布尔值/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', allowed_callers: ['direct', 'direct'] }] }), /allowed_callers/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', input_examples: ['bad'] }] }), /input_examples/);
  assert.throws(() => estimateClaudeInputTokens({ ...base, tools: [{ name: 'bad', eager_input_streaming: 1 }] }), /eager_input_streaming/);
});
