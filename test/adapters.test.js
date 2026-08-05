import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol, upstreamProtocol, normalizeRequest, formatRequest, prepareUpstreamRequest, normalizeResponse, formatResponse, hasUsageData } from '../src/adapters.js';

test('识别三种兼容端点', () => {
  assert.equal(detectProtocol('/v1/messages'), 'claude');
  assert.equal(detectProtocol('/v1/responses'), 'responses');
  assert.equal(detectProtocol('/v1/chat/completions'), 'chat');
  assert.equal(detectProtocol('/zen/v1/messages'), 'claude');
  assert.equal(detectProtocol('/go/v1/responses'), 'responses');
});

test('根据模型选择 OpenCode 官方协议', () => {
  assert.equal(upstreamProtocol('gpt-5.6-terra'), 'responses');
  assert.equal(upstreamProtocol('claude-haiku-4-5'), 'claude');
  assert.equal(upstreamProtocol('qwen3.7-max'), 'claude');
  assert.equal(upstreamProtocol('kimi-k2.6'), 'chat');
  assert.equal(upstreamProtocol('minimax-m2.7', {}, 'zen'), 'chat');
  assert.equal(upstreamProtocol('minimax-m2.7', {}, 'go'), 'claude');
  assert.equal(upstreamProtocol('o3'), 'responses');
  assert.equal(upstreamProtocol('gpt-oss-120b'), 'chat');
  assert.equal(upstreamProtocol('anything', { protocol: 'responses' }), 'responses');
});

test('Claude 请求转换为 Responses，保留系统提示和工具', () => {
  const source = {
    model: 'gpt-5.6-terra', max_tokens: 2048, system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '天气？' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '上海' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] }
    ],
    tools: [{ name: 'weather', description: '查询天气', input_schema: { type: 'object' } }]
  };
  const output = formatRequest(normalizeRequest(source, 'claude'), 'responses');
  assert.equal(output.instructions, '你是助手');
  assert.equal(output.max_output_tokens, 2048);
  assert.equal(output.tools[0].name, 'weather');
  assert.equal(output.input[1].type, 'function_call');
  assert.equal(output.input[2].type, 'function_call_output');
});

test('Responses 响应转换为 Claude 响应', () => {
  const source = {
    id: 'resp_1', model: 'gpt-5.6-terra', status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] },
      { type: 'function_call', call_id: 'call_1', name: 'save', arguments: '{"ok":true}' }
    ],
    usage: { input_tokens: 12, output_tokens: 6 }
  };
  const output = formatResponse(normalizeResponse(source, 'responses'), 'claude');
  assert.equal(output.content[0].text, '完成');
  assert.equal(output.content[1].type, 'tool_use');
  assert.deepEqual(output.content[1].input, { ok: true });
  assert.equal(output.stop_reason, 'tool_use');
});

test('非流式上游响应缺少协议最小结构时拒绝伪成功', () => {
  assert.throws(() => normalizeResponse(null, 'responses'), /JSON 对象/);
  assert.throws(() => normalizeResponse({}, 'claude'), /content 数组/);
  assert.throws(() => normalizeResponse({}, 'responses'), /output 数组/);
  assert.throws(() => normalizeResponse({ choices: [] }, 'chat'), /choices\[0\]\.message/);
  assert.throws(() => normalizeResponse({ output: [{ type: 'custom_tool_call' }] }, 'responses', '', { rejectUnknown: true }), /custom_tool_call/);
});

test('Chat 工具调用转换为 Claude 工具块', () => {
  const source = {
    id: 'chat_1', model: 'kimi-k2.6',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'run', arguments: '{"cmd":"dir"}' } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 }
  };
  const output = formatResponse(normalizeResponse(source, 'chat'), 'claude');
  assert.equal(output.content[0].name, 'run');
  assert.deepEqual(output.content[0].input, { cmd: 'dir' });
});

test('同协议转发完整保留厂商扩展参数，仅替换模型名', () => {
  const body = { model: 'alias', input: 'test', stream: true, reasoning: { effort: 'high' }, service_tier: 'priority', custom_extension: 42 };
  assert.deepEqual(prepareUpstreamRequest(body, 'responses', 'responses', 'gpt-5.6-terra'), { ...body, model: 'gpt-5.6-terra' });
});

test('模型路由可显式将不兼容工具选择降级为 auto', () => {
  const cross = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, messages: [{ role: 'user', content: '调用工具' }],
    tools: [{ name: 'add', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'add' }
  }, 'claude', 'chat', 'deepseek-v4-flash-free', { toolChoiceFallback: 'auto' });
  assert.equal(cross.tool_choice, 'auto');

  const passthrough = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '调用工具' }],
    tools: [{ type: 'function', function: { name: 'add' } }], tool_choice: 'required', vendor_option: true
  }, 'chat', 'chat', 'deepseek-v4-flash-free', { toolChoiceFallback: 'auto' });
  assert.equal(passthrough.tool_choice, 'auto');
  assert.equal(passthrough.vendor_option, true);

  const standard = prepareUpstreamRequest({
    model: 'alias', messages: [], tools: [{ type: 'function', function: { name: 'add' } }], tool_choice: 'required'
  }, 'chat', 'chat', 'other-model');
  assert.equal(standard.tool_choice, 'required');
});

test('跨协议转换保留采样、工具选择和图片', () => {
  const body = {
    model: 'alias', max_tokens: 100, top_p: 0.8, tool_choice: { type: 'tool', name: 'inspect' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }],
    tools: [{ name: 'inspect', input_schema: { type: 'object' } }]
  };
  const output = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-5.6-terra');
  assert.equal(output.top_p, 0.8);
  assert.deepEqual(output.tool_choice, { type: 'function', name: 'inspect' });
  assert.equal(output.input[0].content[1].image_url, 'data:image/png;base64,AA==');
});

test('停止词仅发送到支持的目标协议', () => {
  const chat = prepareUpstreamRequest({
    model: 'alias', stop_sequences: ['END'], messages: [{ role: 'user', content: '继续' }]
  }, 'claude', 'chat', 'chat-test');
  assert.deepEqual(chat.stop, ['END']);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop_sequences: ['END'], messages: [{ role: 'user', content: '继续' }]
  }, 'claude', 'responses', 'gpt-test'), (error) => error.status === 400 && /stop/.test(error.message));
});

test('转换到 Claude 时 metadata 仅保留合法 user_id', () => {
  const withUser = prepareUpstreamRequest({
    model: 'alias', input: '你好', metadata: { user_id: 'user-1', project: 'internal', nested: { unsafe: true } }
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(withUser.metadata, { user_id: 'user-1' });

  const withoutUser = prepareUpstreamRequest({
    model: 'alias', input: '你好', metadata: { project: 'internal' }
  }, 'responses', 'claude', 'claude-test');
  assert.equal('metadata' in withoutUser, false);
});

test('Responses 与 Chat 跨协议保留图片 detail', () => {
  const toChat = prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' }] }]
  }, 'responses', 'chat', 'vision-chat');
  assert.deepEqual(toChat.messages[0].content[0], { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } });

  const toResponses = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/b.png', detail: 'original' } }] }]
  }, 'chat', 'responses', 'gpt-test');
  assert.deepEqual(toResponses.input[0].content[0], { type: 'input_image', image_url: 'https://example.com/b.png', detail: 'original' });
});

test('DeepSeek V4 Flash 的 Chat 请求将不支持的图片替换为明确文本提示', () => {
  const fromClaude = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '解释这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
    ] }]
  }, 'claude', 'chat', 'deepseek-v4-flash', { imageHandoffEnabled: true });
  assert.deepEqual(fromClaude.messages[0].content, [
    { type: 'text', text: '解释这张图' },
    { type: 'text', text: '[图片未发送：当前模型不支持图片输入。]' }
  ]);
  assert.doesNotMatch(JSON.stringify(fromClaude), /image_url/);

  const directChat = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [
      { type: 'text', text: '历史文本' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ] }]
  }, 'chat', 'chat', 'deepseek-v4-flash-free', { imageHandoffEnabled: true });
  assert.deepEqual(directChat.messages[0].content[1], {
    type: 'text', text: '[图片未发送：当前模型不支持图片输入。]'
  });

  const visionModel = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }]
  }, 'claude', 'chat', 'vision-chat');
  assert.equal(visionModel.messages[0].content[0].type, 'image_url');
});

test('Chat 目标不会生成缺失 URL 的 image_url', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_image_1' }] }]
  }, 'responses', 'chat', 'vision-chat'), (error) => error.status === 400 && /image file_id/.test(error.message));

  const claude = prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_image_1' }] }]
  }, 'responses', 'claude', 'claude-vision');
  assert.deepEqual(claude.messages[0].content[0], { type: 'image', source: { type: 'file', file_id: 'file_image_1' } });
});

test('Claude Documents 与 Responses 文件块可转换', () => {
  const toResponses = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }] }]
  }, 'claude', 'responses', 'gpt-test');
  assert.deepEqual(toResponses.input[0].content[0], {
    type: 'input_file', filename: 'document.pdf', file_data: 'data:application/pdf;base64,AA=='
  });

  const toClaude = prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [
      { type: 'input_file', file_url: 'https://example.com/report.pdf', detail: 'high' },
      { type: 'input_file', file_id: 'file_123', filename: '附件.pdf' }
    ] }]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(toClaude.messages[0].content, [
    { type: 'document', source: { type: 'url', url: 'https://example.com/report.pdf' } },
    { type: 'document', source: { type: 'file', file_id: 'file_123' }, title: '附件.pdf' }
  ]);
});

test('无法无损跨协议的工具和文件会明确拒绝', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '搜索', tools: [{ type: 'web_search' }]
  }, 'responses', 'claude', 'claude-test'), (error) => error.status === 400 && /web_search/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: 'dir' }]
  }, 'responses', 'chat', 'chat-test'), (error) => error.status === 400 && /custom tool/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /文件内容块/.test(error.message));

  const passthrough = { model: 'alias', input: '搜索', tools: [{ type: 'web_search' }] };
  assert.deepEqual(prepareUpstreamRequest(passthrough, 'responses', 'responses', 'gpt-test'), { ...passthrough, model: 'gpt-test' });
});

test('未知内容块与服务端工具不会静默转换为空消息', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }]
  }, 'chat', 'claude', 'claude-test'), (error) => error.status === 400 && /input_audio/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }]
  }, 'responses', 'claude', 'claude-test'), (error) => error.status === 400 && /reasoning/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '搜索' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /server tool/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }], tools: [{ type: 'custom', custom: { name: 'shell' } }]
  }, 'chat', 'claude', 'claude-test'), (error) => error.status === 400 && /Chat 工具类型/.test(error.message));
});

test('Claude 图片与文档响应转 OpenAI 协议时不会静默丢失', () => {
  const normalized = normalizeResponse({
    id: 'msg_media', model: 'claude-test', stop_reason: 'end_turn', usage: {},
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }
    ]
  }, 'claude', '', { rejectUnknown: true });
  assert.throws(() => formatResponse(normalized, 'responses'), /image, file/);
  assert.throws(() => formatResponse(normalized, 'chat'), /image, file/);
  assert.deepEqual(formatResponse(normalized, 'claude').content.map((part) => part.type), ['image', 'document']);
});

test('Responses developer 消息转换为目标系统提示', () => {
  const output = prepareUpstreamRequest({
    model: 'alias', instructions: '基础规则', input: [
      { role: 'developer', content: [{ type: 'input_text', text: '开发者规则' }] },
      { role: 'user', content: [{ type: 'input_text', text: '问题' }] }
    ]
  }, 'responses', 'claude', 'claude-test');
  assert.equal(output.system, '基础规则\n开发者规则');
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0].content[0].text, '问题');
});

test('跨协议流式 Chat 请求主动请求 usage 事件', () => {
  const result = prepareUpstreamRequest({
    model: 'claude-test', stream: true, max_tokens: 32,
    messages: [{ role: 'user', content: '你好' }]
  }, 'claude', 'chat', 'kimi-test');
  assert.deepEqual(result.stream_options, { include_usage: true });
});

test('同协议流式 Chat 也会请求 usage 且只把真实 token 字段算作用量', () => {
  const result = prepareUpstreamRequest({
    model: 'alias', stream: true, stream_options: { vendor: true }, messages: []
  }, 'chat', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(result.stream_options, { vendor: true, include_usage: true });
  assert.equal(hasUsageData({ usage: {} }), false);
  assert.equal(hasUsageData({ usage: { prompt_tokens: 0, completion_tokens: 0 } }), true);
  assert.equal(hasUsageData({ usage: { prompt_tokens_details: { cached_tokens: 0 } } }), true);
  assert.equal(hasUsageData({ usage: { input_tokens_details: { cache_write_tokens: 0 } } }), true);
  assert.equal(hasUsageData({ usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 } }), true);
});

test('o 系列 Chat 请求使用 max_completion_tokens', () => {
  const reasoning = prepareUpstreamRequest({
    model: 'alias', max_tokens: 4096, messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'chat', 'o3-mini');
  assert.equal(reasoning.max_completion_tokens, 4096);
  assert.equal('max_tokens' in reasoning, false);

  const regular = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024, messages: [{ role: 'user', content: '回答' }]
  }, 'claude', 'chat', 'gpt-4o');
  assert.equal(regular.max_tokens, 1024);
  assert.equal('max_completion_tokens' in regular, false);
});

test('Claude thinking 与 output_config 转为 OpenAI reasoning effort', () => {
  const low = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'chat', 'o3');
  assert.equal(low.reasoning_effort, 'low');

  const maximum = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024, output_config: { effort: 'max' },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'responses', 'gpt-5.6-terra');
  assert.deepEqual(maximum.reasoning, { effort: 'xhigh' });

  const unsupported = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024, thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal('reasoning_effort' in unsupported, false);
});

test('DeepSeek 工具历史保留 reasoning_content 并提供兼容兜底', () => {
  const withThinking = prepareUpstreamRequest({
    model: 'deepseek-v4-flash-free', max_tokens: 128,
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: '先查询天气', signature: 'signed' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '上海' } }
    ] }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal(withThinking.messages[0].reasoning_content, '先查询天气');

  const withoutThinking = prepareUpstreamRequest({
    model: 'deepseek-v4-flash-free', max_tokens: 128,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: '北京' } }] }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal(withoutThinking.messages[0].reasoning_content, 'tool call');
});

test('DeepSeek V4 Flash 工具请求自动关闭 Thinking 模式', () => {
  const request = {
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: '查询天气' }],
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'get_weather' }
  };
  const free = prepareUpstreamRequest(request, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal(free.reasoning_effort, 'none');
  assert.equal(free.tool_choice.function.name, 'get_weather');

  const paid = prepareUpstreamRequest(request, 'claude', 'chat', 'deepseek-v4-flash');
  assert.equal(paid.reasoning_effort, 'none');

  const unrelated = prepareUpstreamRequest(request, 'claude', 'chat', 'deepseek-v3');
  assert.equal('reasoning_effort' in unrelated, false);

  const explicitThinking = prepareUpstreamRequest({
    ...request, thinking: { type: 'enabled', budget_tokens: 2048 }
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal('reasoning_effort' in explicitThinking, false);

  const explicitNone = prepareUpstreamRequest({
    model: 'alias', input: '直接回答', reasoning: { effort: 'none' }
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(explicitNone.reasoning_effort, 'none');
});

test('空 tools 会移除工具约束并清理不兼容 URI Schema', () => {
  const noTools = prepareUpstreamRequest({
    model: 'alias', input: '你好', tools: [], tool_choice: 'required', parallel_tool_calls: true
  }, 'responses', 'chat', 'deepseek-v4-flash-free');
  assert.equal('tool_choice' in noTools, false);
  assert.equal('parallel_tool_calls' in noTools, false);

  const withTool = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, messages: [{ role: 'user', content: '打开链接' }],
    tools: [{ name: 'open_url', input_schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, day: { type: 'string', format: 'date-time' } } } }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  const properties = withTool.tools[0].function.parameters.properties;
  assert.equal('format' in properties.url, false);
  assert.equal(properties.day.format, 'date-time');
});

test('Claude 计费头仅从 system 开头移除且 DeepSeek 纯图片消息会明确降级', () => {
  const result = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    system: 'x-anthropic-billing-header: cch=test\n\n真实系统提示',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free', { imageHandoffEnabled: true });
  assert.equal(result.messages[0].content, '真实系统提示');
  assert.deepEqual(result.messages[1].content[0], { type: 'text', text: '[图片未发送：当前模型不支持图片输入。]' });
});

test('Claude 转 Chat 保留兼容代理使用的 cache_control', () => {
  const result = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    system: [{ type: 'text', text: '系统提示', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '问题', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.deepEqual(result.messages[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(result.messages[1].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(result.tools[0].cache_control, { type: 'ephemeral' });

  const responses = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '问题', cache_control: { type: 'ephemeral' } }] }]
  }, 'claude', 'responses', 'gpt-5.6-terra');
  assert.equal('cache_control' in responses.input[0].content[0], false);
});

test('工具参数与结构化结果使用稳定 JSON 键顺序', () => {
  const result = prepareUpstreamRequest({
    model: 'deepseek-v4-flash-free', max_tokens: 64,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'demo', input: { z: 1, a: { y: 2, b: 3 } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: { z: 4, a: 5 } }] }
    ]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal(result.messages[0].tool_calls[0].function.arguments, '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(result.messages[1].content, '{"a":5,"z":4}');
});

test('转换到 Claude 时仅移除 Read 工具的空 pages', () => {
  const read = formatResponse(normalizeResponse({
    id: 'resp_read', model: 'gpt', status: 'completed',
    output: [{ type: 'function_call', call_id: 'call_read', name: 'Read', arguments: '{"file_path":"demo.js","pages":""}' }]
  }, 'responses'), 'claude');
  assert.deepEqual(read.content[0].input, { file_path: 'demo.js' });

  const other = formatResponse(normalizeResponse({
    id: 'resp_other', model: 'gpt', status: 'completed',
    output: [{ type: 'function_call', call_id: 'call_other', name: 'Other', arguments: '{"pages":""}' }]
  }, 'responses'), 'claude');
  assert.deepEqual(other.content[0].input, { pages: '' });
});

test('Chat 非流式响应兼容 reasoning 字段别名', () => {
  const result = formatResponse(normalizeResponse({
    id: 'chat_reasoning', model: 'kimi', choices: [{ message: { reasoning: '别名推理', content: '答案' }, finish_reason: 'stop' }]
  }, 'chat'), 'claude');
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, '别名推理');
  assert.equal(result.content[1].text, '答案');
});

test('Chat 旧 function_call、refusal 与 usage 别名可转换', () => {
  const result = formatResponse(normalizeResponse({
    id: 'legacy', model: 'legacy-chat',
    choices: [{ finish_reason: 'function_call', message: { content: null, refusal: '受限说明', function_call: { name: 'lookup', arguments: '{"q":"test"}' } } }],
    usage: { input_tokens: 7, output_tokens: 3, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 2 }
  }, 'chat'), 'claude');
  assert.equal(result.content[0].text, '受限说明');
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.content[1].name, 'lookup');
  assert.deepEqual(result.content[1].input, { q: 'test' });
  assert.equal(result.usage.input_tokens, 7);
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(result.usage.cache_read_input_tokens, 5);
});

test('Responses refusal 与 OpenAI usage 字段别名可转换', () => {
  const normalized = normalizeResponse({
    id: 'resp_refusal', model: 'gpt', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: '无法协助' }] }],
    usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } }
  }, 'responses');
  const result = formatResponse(normalized, 'claude');
  assert.equal(result.content[0].text, '无法协助');
  assert.equal(result.usage.input_tokens, 9);
  assert.equal(result.usage.output_tokens, 2);
  assert.equal(result.usage.cache_read_input_tokens, 4);
  assert.equal(result.usage.cache_creation_input_tokens, 3);
  assert.equal(normalized.reasoningTokens, 1);
});

test('停止原因转换为目标协议的合法枚举', () => {
  const base = { id: 'x', model: 'm', parts: [{ type: 'text', text: 'a' }], inputTokens: 1, outputTokens: 1 };
  assert.equal(formatResponse({ ...base, stopReason: 'length' }, 'claude').stop_reason, 'max_tokens');
  assert.equal(formatResponse({ ...base, stopReason: 'end_turn' }, 'chat').choices[0].finish_reason, 'stop');
  assert.equal(formatResponse({ ...base, parts: [{ type: 'tool_call', id: 'c', name: 'f', arguments: {} }] }, 'chat').choices[0].finish_reason, 'tool_calls');

  const responses = formatResponse({ ...base, stopReason: 'max_tokens' }, 'responses');
  assert.equal(responses.status, 'incomplete');
  assert.equal(responses.incomplete_details.reason, 'max_output_tokens');
});

test('响应转换保留缓存创建 token 并规范 Responses 停止原因', () => {
  const source = {
    id: 'resp_cache', model: 'gpt-test', status: 'incomplete', incomplete_details: {}, output: [],
    usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 } }
  };
  const normalized = normalizeResponse(source, 'responses');
  assert.equal(normalized.stopReason, 'max_tokens');
  const claude = formatResponse(normalized, 'claude');
  assert.equal(claude.stop_reason, 'max_tokens');
  assert.equal(claude.usage.cache_read_input_tokens, 5);
  assert.equal(claude.usage.cache_creation_input_tokens, 3);
  const responses = formatResponse(normalized, 'responses');
  assert.equal(responses.usage.input_tokens_details.cache_write_tokens, 3);
  assert.equal('cache_creation_tokens' in responses.usage.input_tokens_details, false);
});

test('转换到 Responses 始终保留标准零值 usage 明细', () => {
  const response = formatResponse({ id: 'resp_zero_usage', model: 'gpt-test', parts: [], inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, stopReason: 'end_turn' }, 'responses');
  assert.deepEqual(response.usage, {
    input_tokens: 2,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 3
  });
});

test('转换到 Responses 保留客户端的工具和并行设置', () => {
  const tools = [{ type: 'function', name: 'lookup', description: '查找信息', parameters: { type: 'object' } }];
  const response = formatResponse({ id: 'resp_tools', model: 'gpt-test', parts: [], inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, stopReason: 'end_turn' }, 'responses', {
    parallelToolCalls: false,
    toolChoice: { type: 'function', name: 'lookup' },
    tools
  });
  assert.equal(response.parallel_tool_calls, false);
  assert.deepEqual(response.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(response.tools, tools);
});

test('Responses 输入项保持文本、工具调用和工具结果的语义顺序', () => {
  const source = {
    model: 'x', messages: [
      { role: 'assistant', content: [{ type: 'text', text: '先查询' }, { type: 'tool_use', id: 'c1', name: 'query', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '结果' }, { type: 'text', text: '继续' }] }
    ]
  };
  const output = prepareUpstreamRequest(source, 'claude', 'responses', 'gpt-test');
  assert.deepEqual(output.input.map((item) => item.type || item.role), ['assistant', 'function_call', 'function_call_output', 'user']);
});

test('Claude 工具结果转 Chat 时紧跟 assistant tool_calls 并先于后续用户文本', () => {
  const source = {
    model: 'alias', messages: [
      { role: 'assistant', content: [{ type: 'text', text: '先查询' }, { type: 'tool_use', id: 'c1', name: 'query', input: { city: '北京' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '晴' }, { type: 'text', text: '继续总结' }] }
    ]
  };
  const output = prepareUpstreamRequest(source, 'claude', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(output.messages.map((message) => message.role), ['assistant', 'tool', 'user']);
  assert.equal(output.messages[0].tool_calls[0].id, 'c1');
  assert.equal(output.messages[1].tool_call_id, 'c1');
  assert.equal(output.messages[2].content, '继续总结');
});

test('并行工具调用与结果跨协议保留全部 ID 和顺序', () => {
  const source = { model: 'x', input: [
    { type: 'function_call', call_id: 'c1', name: 'first', arguments: '{"value":1}' },
    { type: 'function_call', call_id: 'c2', name: 'second', arguments: '{"value":2}' },
    { type: 'function_call_output', call_id: 'c1', output: 'one' },
    { type: 'function_call_output', call_id: 'c2', output: 'two' }
  ] };
  const claude = prepareUpstreamRequest(source, 'responses', 'claude', 'claude-test');
  assert.deepEqual(claude.messages[0].content.map((part) => [part.type, part.id]), [['tool_use', 'c1'], ['tool_use', 'c2']]);
  assert.deepEqual(claude.messages[1].content.map((part) => [part.type, part.tool_use_id]), [['tool_result', 'c1'], ['tool_result', 'c2']]);

  const chat = prepareUpstreamRequest(source, 'responses', 'chat', 'chat-test');
  assert.deepEqual(chat.messages[0].tool_calls.map((call) => call.id), ['c1', 'c2']);
  assert.deepEqual(chat.messages.slice(1).map((message) => message.tool_call_id), ['c1', 'c2']);
});

test('Claude 与 OpenAI 双向转换并行工具开关', () => {
  const responses = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }],
    tools: [{ name: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true }
  }, 'claude', 'responses', 'gpt-test');
  assert.equal(responses.parallel_tool_calls, false);
  assert.equal(responses.tool_choice, 'auto');

  const claude = prepareUpstreamRequest({
    model: 'alias', input: '执行', parallel_tool_calls: true,
    tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(claude.tool_choice, { type: 'auto', disable_parallel_tool_use: false });
});

test('转换到 Claude 时合并连续的同角色消息', () => {
  const source = { model: 'x', input: [
    { role: 'assistant', content: [{ type: 'output_text', text: '准备' }] },
    { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '完成' },
    { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
  ] };
  const output = prepareUpstreamRequest(source, 'responses', 'claude', 'claude-test');
  assert.equal(output.messages.length, 2);
  assert.deepEqual(output.messages[0].content.map((part) => part.type), ['text', 'tool_use']);
  assert.deepEqual(output.messages[1].content.map((part) => part.type), ['tool_result', 'text']);
});

test('Chat 与 Responses 转换保留 strict 工具定义', () => {
  const source = { model: 'x', messages: [{ role: 'user', content: '执行' }], tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' }, strict: true } }] };
  const output = prepareUpstreamRequest(source, 'chat', 'responses', 'gpt-test');
  assert.equal(output.tools[0].strict, true);
});

test('Responses 推理摘要可转换为 Claude thinking 和 Chat reasoning_content', () => {
  const source = {
    id: 'resp_reasoning', model: 'gpt-test', status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '先分析问题' }] },
      { type: 'message', content: [{ type: 'output_text', text: '最终答案' }] }
    ],
    usage: { input_tokens: 10, output_tokens: 8, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } }
  };
  const normalized = normalizeResponse(source, 'responses');
  const claude = formatResponse(normalized, 'claude');
  const chat = formatResponse(normalized, 'chat');
  assert.deepEqual(claude.content.map((part) => part.type), ['thinking', 'text']);
  assert.equal(claude.content[0].thinking, '先分析问题');
  assert.equal(claude.usage.cache_read_input_tokens, 4);
  assert.equal(chat.choices[0].message.reasoning_content, '先分析问题');
  assert.equal(chat.usage.completion_tokens_details.reasoning_tokens, 3);
});

test('Claude thinking 可转换为 Responses reasoning 输出项', () => {
  const source = {
    id: 'msg_reasoning', model: 'claude-test', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '检查约束', signature: 'signed' }, { type: 'text', text: '完成' }],
    usage: { input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 2 }
  };
  const output = formatResponse(normalizeResponse(source, 'claude'), 'responses');
  assert.equal(output.output[0].type, 'reasoning');
  assert.equal(output.output[0].summary[0].text, '检查约束');
  assert.equal(output.usage.input_tokens_details.cached_tokens, 2);
  assert.equal(output.parallel_tool_calls, true);
  assert.equal(output.tool_choice, 'auto');
  assert.deepEqual(output.tools, []);
});
