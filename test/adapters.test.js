import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol, upstreamProtocol, normalizeRequest, formatRequest, prepareUpstreamRequest, normalizeResponse, formatResponse, geminiGroundingMetadata, geminiToolNameAliases, hasUsageData, reasoningRequestAdaptations, requestReasoningEffort, contextRequestAdaptations, responseMetadataDegradations, serviceRequestAdaptations, generationRequestAdaptations, claudeToolAdaptations, responsesToolAdaptations, geminiToolAdaptations, claudeCacheAdaptations, responsesCacheAdaptations, chatCacheAdaptations, inputRequestDegradations } from '../src/adapters.js';
import { decodeReasoningState, encodeReasoningStateBundle } from '../src/reasoning-state.js';

test('识别四种兼容端点', () => {
  assert.equal(detectProtocol('/v1/messages'), 'claude');
  assert.equal(detectProtocol('/v1/responses'), 'responses');
  assert.equal(detectProtocol('/v1/chat/completions'), 'chat');
  assert.equal(detectProtocol('/zen/v1/messages'), 'claude');
  assert.equal(detectProtocol('/go/v1/messages/count_tokens'), 'claude');
  assert.equal(detectProtocol('/go/v1/responses'), 'responses');
  assert.equal(detectProtocol('/go/v1/responses/compact'), 'responses');
  assert.equal(detectProtocol('/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini');
  assert.equal(detectProtocol('/zen/v1/models/google%2Fgemini:streamGenerateContent'), 'gemini');
});

test('Claude Code 运行中用户引导转换为真实 user 消息', () => {
  const steering = `The user sent a new message while you were working:\n你好看到请先暂停工作再继续任务\n\nThis is how Claude Code surfaces messages the user sends mid-turn.`;
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: '开始工作' },
      { role: 'assistant', content: [{ type: 'text', text: '处理中' }] },
      { role: 'system', content: [{ type: 'text', text: steering }] }
    ]
  };
  const normalized = normalizeRequest(body, 'claude');
  assert.equal(normalized.messages[2].role, 'user');
  assert.equal(normalized.messages[2].parts[0].text, steering);
  const chat = prepareUpstreamRequest(body, 'claude', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.equal(chat.messages[2].content, steering);
  const responses = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-test');
  assert.equal(responses.input[2].role, 'user');
  assert.equal(responses.input[2].content[0].text, steering);
});

test('跨协议工具参数字符串会在递归处理前检查 JSON 复杂度', () => {
  let nested = null;
  for (let depth = 0; depth < 257; depth++) nested = { value: nested };
  const argumentsText = JSON.stringify(nested);
  const request = {
    model: 'chat-test',
    messages: [{
      role: 'assistant',
      tool_calls: [{ id: 'call_complex', type: 'function', function: { name: 'probe', arguments: argumentsText } }]
    }]
  };
  assert.throws(
    () => prepareUpstreamRequest(request, 'chat', 'responses', 'responses-test'),
    (error) => error.status === 400 && /JSON 嵌套深度不能超过 256 层/.test(error.message)
  );

  const response = {
    id: 'chatcmpl_complex', model: 'chat-test',
    choices: [{ index: 0, message: request.messages[0], finish_reason: 'tool_calls' }]
  };
  assert.throws(
    () => normalizeResponse(response, 'chat', 'chat-test'),
    (error) => error.code === 'UPSTREAM_JSON_TOO_COMPLEX' && /256 层/.test(error.message)
  );
});

test('Gemini generateContent 请求可转换为 Responses', () => {
  const source = {
    model: 'gemini-alias', stream: false,
    systemInstruction: { parts: [{ text: '你是助手' }] },
    contents: [
      { role: 'user', parts: [{ text: '看看图片' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
      { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { city: '上海' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { weather: '晴' } } }] }
    ],
    tools: [{ functionDeclarations: [{ name: 'lookup', description: '查询', parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
    generationConfig: { maxOutputTokens: 512, temperature: 0.2, topP: 0.9 }
  };
  const output = prepareUpstreamRequest(source, 'gemini', 'responses', 'gpt-5.6-terra');
  assert.equal(output.model, 'gpt-5.6-terra');
  assert.equal('instructions' in output, false);
  assert.equal(output.input[0].role, 'system');
  assert.equal(output.input[0].content[0].text, '你是助手');
  assert.equal(output.max_output_tokens, 512);
  assert.equal(output.input[1].content[1].type, 'input_image');
  assert.match(output.input[1].content[1].image_url, /^data:image\/png;base64,/);
  assert.deepEqual(output.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(output.input[2].type, 'function_call');
  assert.equal(output.input[3].type, 'function_call_output');
  assert.equal(output.tools[0].name, 'lookup');
  assert.equal(output.tools[0].parameters.properties.city.type, 'string');
});

test('Gemini 并行同名函数调用使用唯一 ID 并把乱序结果关联到原调用', () => {
  const legacy = {
    contents: [
      { role: 'model', parts: [
        { functionCall: { name: 'lookup', args: { city: '上海' } } },
        { functionCall: { name: 'lookup', args: { city: '北京' } } },
        { functionCall: { id: 'gemini_call_0', name: 'clock', args: {} } }
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'lookup', response: { weather: '晴' } } },
        { functionResponse: { name: 'lookup', response: { error: { code: 'offline', message: '暂不可用' } } } },
        { functionResponse: { id: 'gemini_call_0', name: 'clock', response: { time: '12:00' } } }
      ] }
    ]
  };
  const responses = prepareUpstreamRequest(legacy, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
    ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']
  );
  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']
  );
  assert.deepEqual(
    JSON.parse(responses.input.filter((item) => item.type === 'function_call_output')[1].output),
    { error: { code: 'offline', message: '暂不可用' } }
  );

  const chat = prepareUpstreamRequest(legacy, 'gemini', 'chat', 'chat-test');
  assert.deepEqual(chat.messages[0].tool_calls.map((call) => call.id), ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']);
  assert.deepEqual(chat.messages.slice(1).map((message) => message.tool_call_id), ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']);
  assert.deepEqual(JSON.parse(chat.messages[2].content), { error: { code: 'offline', message: '暂不可用' } });

  const claude = prepareUpstreamRequest(legacy, 'gemini', 'claude', 'claude-test');
  assert.deepEqual(claude.messages[0].content.map((part) => part.id), ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']);
  assert.deepEqual(claude.messages[1].content.map((part) => part.tool_use_id), ['gemini_call_1', 'gemini_call_2', 'gemini_call_0']);

  const reversed = prepareUpstreamRequest({
    contents: [
      { role: 'model', parts: [
        { functionCall: { id: 'call_a', name: 'lookup', args: { city: '上海' } } },
        { functionCall: { id: 'call_b', name: 'lookup', args: { city: '北京' } } }
      ] },
      { role: 'user', parts: [
        { functionResponse: { id: 'call_b', name: 'lookup', response: { weather: '雨' } } },
        { functionResponse: { id: 'call_a', name: 'lookup', response: { weather: '晴' } } }
      ] }
    ]
  }, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(
    reversed.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['call_b', 'call_a']
  );

  const mixed = prepareUpstreamRequest({
    contents: [
      { role: 'model', parts: ['call_a', 'call_b', 'call_c'].map((id) => ({ functionCall: { id, name: 'lookup', args: {} } })) },
      { role: 'user', parts: [
        { functionResponse: { id: 'call_b', name: 'lookup', response: { order: 1 } } },
        { functionResponse: { name: 'lookup', response: { order: 2 } } },
        { functionResponse: { name: 'lookup', response: { order: 3 } } }
      ] }
    ]
  }, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(
    mixed.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['call_b', 'call_a', 'call_c']
  );
});

test('Gemini 大量无 ID 同名函数结果只线性检查待处理调用', () => {
  const count = 256;
  const request = {
    contents: [
      { role: 'model', parts: Array.from({ length: count }, (_, index) => ({ functionCall: { name: 'lookup', args: { index } } })) },
      { role: 'user', parts: Array.from({ length: count }, (_, index) => ({ functionResponse: { name: 'lookup', response: { index } } })) }
    ]
  };
  const originalHas = Map.prototype.has;
  let mapChecks = 0;
  Map.prototype.has = function instrumentedMapHas(...args) {
    mapChecks++;
    return Reflect.apply(originalHas, this, args);
  };
  let normalized;
  try { normalized = normalizeRequest(request, 'gemini'); }
  finally { Map.prototype.has = originalHas; }

  assert.equal(normalized.messages.flatMap((message) => message.parts).length, count * 2);
  assert.ok(mapChecks <= count * 8, `待处理调用检查次数不应随历史长度平方增长：${mapChecks}`);
});

test('Gemini 函数结果严格校验 ID、名称和不可移植的异步字段', () => {
  const request = (calls, results) => ({
    contents: [
      { role: 'model', parts: calls.map((functionCall) => ({ functionCall })) },
      { role: 'user', parts: results.map((functionResponse) => ({ functionResponse })) }
    ]
  });
  assert.throws(
    () => normalizeRequest(request([{ id: 'call_1', name: 'lookup', args: {} }], [{ id: 'call_1', name: 'other', response: {} }]), 'gemini'),
    /name=other.*name=lookup 不一致/
  );
  assert.throws(
    () => normalizeRequest(request([{ id: 'call_1', name: 'lookup', args: {} }], [{ id: 'missing', name: 'lookup', response: {} }]), 'gemini'),
    /没有匹配的前置 functionCall/
  );
  assert.throws(
    () => normalizeRequest(request([{ id: 'dup', name: 'lookup', args: {} }, { id: 'dup', name: 'lookup', args: {} }], []), 'gemini'),
    /functionCall.id 重复/
  );
  assert.throws(
    () => normalizeRequest(request([{ id: 1, name: 'lookup', args: {} }], []), 'gemini'),
    /functionCall.id 必须是非空字符串/
  );
  assert.throws(
    () => normalizeRequest(request([{ id: 'call_1', name: 'lookup', args: {} }], [{ id: 'call_1', name: 'lookup' }]), 'gemini'),
    /functionResponse.response 必须是对象/
  );
  assert.throws(
    () => normalizeRequest(request([{ id: 'call_1', name: 'lookup', args: {} }], [{ id: 'call_1', name: 'lookup', response: {}, willContinue: true }]), 'gemini'),
    /暂不支持 Gemini functionResponse 字段：willContinue/
  );
});

test('Gemini 长函数名和专属标点跨三种上游使用可逆且无冲突的 64 字符别名', () => {
  const prefix = 'x'.repeat(64);
  const longA = `${prefix}a`;
  const longB = `${prefix}b`;
  const body = {
    contents: [
      { role: 'model', parts: [{ functionCall: { id: 'call_a', name: longA, args: { value: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_a', name: longA, response: { ok: true } } }] }
    ],
    tools: [{ functionDeclarations: [
      { name: prefix, parameters: { type: 'object' } },
      { name: longA, parameters: { type: 'object' } },
      { name: longB, parameters: { type: 'object' } }
    ] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [longB] } }
  };
  const aliases = geminiToolNameAliases(body);
  assert.equal(aliases.length, 2);
  assert.equal(new Set(aliases.map((entry) => entry.alias)).size, 2);
  assert.ok(aliases.every((entry) => entry.alias.length <= 64 && entry.alias !== prefix));
  assert.deepEqual(geminiToolAdaptations(body), ['gemini_function_names_aliased', 'gemini_allowed_functions_filtered']);
  const aliasA = aliases.find((entry) => entry.name === longA).alias;
  const aliasB = aliases.find((entry) => entry.name === longB).alias;

  const responses = prepareUpstreamRequest(body, 'gemini', 'responses', 'gpt-test');
  assert.equal(responses.tools[0].name, aliasB);
  assert.deepEqual(responses.tool_choice, { type: 'function', name: aliasB });
  assert.equal(responses.input.find((item) => item.type === 'function_call').name, aliasA);

  const chat = prepareUpstreamRequest(body, 'gemini', 'chat', 'chat-test');
  assert.equal(chat.tools[0].function.name, aliasB);
  assert.equal(chat.tool_choice.function.name, aliasB);
  assert.equal(chat.messages[0].tool_calls[0].function.name, aliasA);

  const claude = prepareUpstreamRequest(body, 'gemini', 'claude', 'claude-test');
  assert.equal(claude.tools[0].name, aliasB);
  assert.equal(claude.tool_choice.name, aliasB);
  assert.equal(claude.messages[0].content[0].name, aliasA);

  const gemini = formatResponse({
    id: 'resp_alias', model: 'model', inputTokens: 1, outputTokens: 1, reasoningTokens: 0,
    cachedInputTokens: 0, cacheCreationInputTokens: 0, stopReason: 'tool_calls',
    parts: [{ type: 'tool_call', id: 'call_b', name: aliasB, arguments: { value: 2 } }]
  }, 'gemini', { geminiToolAliases: aliases });
  assert.equal(gemini.candidates[0].content.parts[0].functionCall.name, longB);

  const punctuated = 'workspace.lookup:v1';
  const punctuatedBody = {
    contents: [
      { role: 'model', parts: [{ functionCall: { id: 'call_dot', name: punctuated, args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_dot', name: punctuated, response: { ok: true } } }] }
    ],
    tools: [{ functionDeclarations: [
      { name: punctuated, parameters: { type: 'object' } },
      { name: 'workspace_lookup_v1', parameters: { type: 'object' } }
    ] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [punctuated] } }
  };
  const punctuatedAliases = geminiToolNameAliases(punctuatedBody);
  assert.equal(punctuatedAliases.length, 1);
  assert.equal(punctuatedAliases[0].name, punctuated);
  assert.match(punctuatedAliases[0].alias, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(punctuatedAliases[0].alias, 'workspace_lookup_v1');
  const punctuatedResponses = prepareUpstreamRequest(punctuatedBody, 'gemini', 'responses', 'gpt-test');
  assert.equal(punctuatedResponses.tools[0].name, punctuatedAliases[0].alias);
  assert.equal(punctuatedResponses.tool_choice.name, punctuatedAliases[0].alias);
  assert.equal(punctuatedResponses.input.find((item) => item.type === 'function_call').name, punctuatedAliases[0].alias);
  const restoredPunctuated = formatResponse({
    id: 'resp_punctuated', model: 'model', inputTokens: 1, outputTokens: 1, reasoningTokens: 0,
    cachedInputTokens: 0, cacheCreationInputTokens: 0, stopReason: 'tool_calls',
    parts: [{ type: 'tool_call', id: 'call_dot_2', name: punctuatedAliases[0].alias, arguments: {} }]
  }, 'gemini', { geminiToolAliases: punctuatedAliases });
  assert.equal(restoredPunctuated.candidates[0].content.parts[0].functionCall.name, punctuated);
  assert.deepEqual(geminiToolAdaptations({
    contents: [{ role: 'user', parts: [{ text: 'x' }] }],
    tools: [{ functionDeclarations: [{ name: longA, parameters: { type: 'object' } }] }]
  }), ['gemini_function_names_aliased']);

  assert.throws(
    () => normalizeRequest({ contents: [{ role: 'model', parts: [{ functionCall: { name: 'x'.repeat(129), args: {} } }] }] }, 'gemini'),
    /functionCall.name 必须匹配/
  );
  assert.throws(
    () => normalizeRequest({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: [{ functionDeclarations: [{ name: 'bad/name' }] }] }, 'gemini'),
    /functionDeclarations\[0\]\.name 必须匹配/
  );
});

test('Gemini 大工具别名表在非流式响应中只构建一次还原索引', () => {
  const count = 128;
  let aliasReads = 0;
  const aliases = Array.from({ length: count }, (_, index) => {
    const entry = { name: `original.tool:${index}` };
    Object.defineProperty(entry, 'alias', {
      enumerable: true,
      get() {
        aliasReads++;
        return `gemini_alias_${index}`;
      }
    });
    return entry;
  });
  const parts = Array.from({ length: count }, (_, index) => ({
    type: 'tool_call', id: `call_${index}`, name: `gemini_alias_${index}`, arguments: { index }
  }));

  const gemini = formatResponse({
    id: 'resp_many_aliases', model: 'model', inputTokens: 1, outputTokens: 1,
    reasoningTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0,
    stopReason: 'tool_calls', parts
  }, 'gemini', { geminiToolAliases: aliases });

  assert.ok(aliasReads <= count * 2, `Gemini alias 属性读取 ${aliasReads} 次，预期为 O(n)`);
  assert.deepEqual(
    gemini.candidates[0].content.parts.map((part) => part.functionCall.name),
    Array.from({ length: count }, (_, index) => `original.tool:${index}`)
  );
});

test('Gemini 历史 thoughtSignature 被校验、内部保留并明确标记跨协议降级', () => {
  const source = {
    contents: [
      { role: 'model', parts: [
        { text: '需要调用工具', thought: true, thought_signature: 'text-signature' },
        { functionCall: { id: 'call_1', name: 'lookup', args: { city: '上海' } }, thoughtSignature: 'call-signature' }
      ] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { weather: '晴' } } }] }
    ]
  };
  assert.deepEqual(inputRequestDegradations(source, 'gemini', 'responses'), ['gemini_thought_signature']);
  assert.deepEqual(inputRequestDegradations(source, 'gemini', 'gemini'), []);
  const normalized = normalizeRequest(source, 'gemini');
  assert.equal(normalized.messages[0].parts[0].signature, 'text-signature');
  assert.equal(normalized.messages[0].parts[1].signature, 'call-signature');

  const responses = prepareUpstreamRequest(source, 'gemini', 'responses', 'gpt-5.6-terra');
  assert.equal(responses.input.find((item) => item.type === 'function_call')?.name, 'lookup');
  assert.equal(JSON.stringify(responses).includes('thoughtSignature'), false);
  assert.equal(JSON.stringify(responses).includes('thought_signature'), false);
  assert.equal(JSON.stringify(responses).includes('call-signature'), false);
  assert.equal(responses.input.find((item) => item.role === 'assistant')?.content[0].text, '需要调用工具');
  assert.deepEqual(reasoningRequestAdaptations(source, 'gemini', 'responses', 'gpt-5.6-terra'), ['reasoning_history_to_assistant_text']);

  const claude = prepareUpstreamRequest(source, 'gemini', 'claude', 'minimax-m3');
  assert.equal(claude.messages[0].content[0].text, '需要调用工具');
  assert.deepEqual(reasoningRequestAdaptations(source, 'gemini', 'claude', 'minimax-m3'), ['reasoning_history_to_assistant_text']);

  const reasoningChat = prepareUpstreamRequest(source, 'gemini', 'chat', 'deepseek-v4-flash');
  assert.equal(reasoningChat.messages[0].reasoning_content, '需要调用工具');
  assert.deepEqual(reasoningRequestAdaptations(source, 'gemini', 'chat', 'deepseek-v4-flash'), ['reasoning_history_to_chat_reasoning_content']);

  const plainChat = prepareUpstreamRequest(source, 'gemini', 'chat', 'chat-test');
  assert.equal(plainChat.messages[0].content, '需要调用工具');
  assert.deepEqual(reasoningRequestAdaptations(source, 'gemini', 'chat', 'chat-test'), ['reasoning_history_to_assistant_text']);

  const invalid = (part) => ({ contents: [{ role: 'model', parts: [part] }] });
  assert.throws(() => normalizeRequest(invalid({ text: 'x', thoughtSignature: '' }), 'gemini'), /必须是非空字符串/);
  assert.throws(() => normalizeRequest(invalid({ text: 'x', thoughtSignature: 123 }), 'gemini'), /必须是非空字符串/);
  assert.throws(() => normalizeRequest(invalid({ text: 'x', thoughtSignature: 'a', thought_signature: 'b' }), 'gemini'), /不能冲突/);
  assert.throws(() => normalizeRequest(invalid({ text: 'x', thought: 'true' }), 'gemini'), /thought 必须是布尔值/);
  assert.throws(() => normalizeRequest({ contents: [{ role: 'user', parts: [{ text: 'x', thought: true }] }] }, 'gemini'), /只有 model role/);
  assert.throws(() => normalizeRequest({ contents: [{ role: 'user', parts: [{ functionCall: { name: 'lookup', args: {} } }] }] }, 'gemini'), /只有 model role 可以包含 functionCall/);
  assert.throws(() => normalizeRequest({ contents: [{ role: 'model', parts: [{ functionResponse: { name: 'lookup', response: {} } }] }] }, 'gemini'), /model role 不能包含 functionResponse/);
  assert.throws(() => normalizeRequest(invalid({ functionCall: { name: 'lookup', args: {} }, thought: true }), 'gemini'), /thought=true 只能用于文本/);
});

test('Claude 与 Chat 历史推理转 Responses 时保留为 assistant 文本', () => {
  const claude = prepareUpstreamRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Claude 历史推理摘要', signature: 'signed' }] },
      { role: 'user', content: '继续' }
    ]
  }, 'claude', 'responses', 'gpt-5.6-luna');
  assert.equal(claude.input[0].role, 'assistant');
  assert.equal(claude.input[0].content[0].text, 'Claude 历史推理摘要');
  assert.deepEqual(reasoningRequestAdaptations({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }] }, 'claude', 'responses', 'gpt-5.6-luna'), ['reasoning_history_to_assistant_text']);

  const chat = prepareUpstreamRequest({
    messages: [
      { role: 'assistant', reasoning_content: 'Chat 历史推理摘要', content: null },
      { role: 'user', content: '继续' }
    ]
  }, 'chat', 'responses', 'gpt-5.6-luna');
  assert.equal(chat.input[0].content[0].text, 'Chat 历史推理摘要');
  assert.deepEqual(reasoningRequestAdaptations({ messages: [{ role: 'assistant', reasoning_content: 'x' }] }, 'chat', 'responses', 'gpt-5.6-luna'), ['reasoning_history_to_assistant_text']);
});

test('Claude thinking 签名与 redacted_thinking 跨协议时被校验并明确降级', () => {
  const source = {
    model: 'alias', max_tokens: 256,
    messages: [
      { role: 'user', content: '检查文件' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '先读取文件', signature: 'opaque-signature' },
        { type: 'redacted_thinking', data: 'opaque-redacted-state' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'README.md' } }
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '内容' }] }
    ],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }]
  };
  assert.deepEqual(inputRequestDegradations(source, 'claude', 'responses'), [
    'claude_thinking_signature', 'claude_redacted_thinking'
  ]);
  assert.deepEqual(inputRequestDegradations(source, 'claude', 'claude'), []);

  const responses = prepareUpstreamRequest(source, 'claude', 'responses', 'gpt-5.6-luna');
  assert.equal(responses.input.find((item) => item.role === 'assistant')?.content[0].text, '先读取文件');
  assert.equal(responses.input.find((item) => item.type === 'function_call')?.name, 'Read');
  assert.equal(JSON.stringify(responses).includes('opaque-signature'), false);
  assert.equal(JSON.stringify(responses).includes('opaque-redacted-state'), false);

  const native = prepareUpstreamRequest(source, 'claude', 'claude', 'claude-upstream');
  assert.deepEqual(native.messages[1].content.slice(0, 2), source.messages[1].content.slice(0, 2));

  const invalid = (block) => normalizeRequest({ messages: [{ role: 'assistant', content: [block] }] }, 'claude');
  assert.throws(() => invalid({ type: 'thinking', thinking: 'x' }), /signature 必须是非空字符串/);
  assert.throws(() => invalid({ type: 'thinking', thinking: 1, signature: 'signed' }), /thinking 必须是字符串/);
  assert.throws(() => invalid({ type: 'redacted_thinking', data: '' }), /data 必须是非空字符串/);
  const redactedResponse = normalizeResponse({
    id: 'msg_redacted', model: 'claude-test', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'redacted_thinking', data: 'opaque' }], usage: { input_tokens: 1, output_tokens: 1 }
  }, 'claude', 'alias', { rejectUnknown: true });
  assert.equal(redactedResponse.parts[0].providerState.value.data, 'opaque');
});

test('Gemini 多个 allowedFunctionNames 可等价过滤到三种目标协议', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: '只使用只读工具' }] }],
    tools: [{ functionDeclarations: [
      { name: 'read', parameters: { type: 'object' } },
      { name: 'list', parameters: { type: 'object' } },
      { name: 'write', parameters: { type: 'object' } }
    ] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read', 'list'] } }
  };
  assert.deepEqual(geminiToolAdaptations(body), ['gemini_allowed_functions_filtered']);

  const responses = prepareUpstreamRequest(body, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.tools.map((tool) => tool.name), ['read', 'list']);
  assert.equal(responses.tool_choice, 'required');

  const chat = prepareUpstreamRequest(body, 'gemini', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['read', 'list']);
  assert.equal(chat.tool_choice, 'required');

  const claude = prepareUpstreamRequest(body, 'gemini', 'claude', 'minimax-m3');
  assert.deepEqual(claude.tools.map((tool) => tool.name), ['read', 'list']);
  assert.deepEqual(claude.tool_choice, { type: 'any' });
});

test('Gemini VALIDATED 工具子集以可观察的 auto 模式转换', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: '按需检查' }] }],
    tools: [{ functionDeclarations: [
      { name: 'inspect', parameters: { type: 'object' } },
      { name: 'delete', parameters: { type: 'object' } }
    ] }],
    toolConfig: { functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['inspect'] } }
  };
  assert.deepEqual(geminiToolAdaptations(body), ['gemini_allowed_functions_filtered', 'gemini_validated_best_effort']);
  const responses = prepareUpstreamRequest(body, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.tools.map((tool) => tool.name), ['inspect']);
  assert.equal(responses.tool_choice, 'auto');
});

test('Gemini 流式函数参数请求会转换并标记重编码', () => {
  const body = {
    stream: true,
    contents: [{ role: 'user', parts: [{ text: '流式调用工具' }] }],
    tools: [{ functionDeclarations: [{ name: 'inspect', parameters: { type: 'object' } }] }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO', streamFunctionCallArguments: true } }
  };
  assert.deepEqual(geminiToolAdaptations(body), ['gemini_stream_function_args_reencoded']);
  const responses = prepareUpstreamRequest(body, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.equal(responses.stream, true);
  assert.equal(responses.tool_choice, 'auto');
  assert.equal(responses.tools[0].name, 'inspect');
  assert.equal(JSON.stringify(responses).includes('streamFunctionCallArguments'), false);
});

test('Gemini 采样、logprobs 与结构化输出按目标协议无损转换', () => {
  const contents = [{ role: 'user', parts: [{ text: '返回结构化结果' }] }];
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

  const responses = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: {
      responseMimeType: 'application/json', responseJsonSchema: schema,
      responseLogprobs: true, logprobs: 5
    }
  }, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.equal(responses.top_logprobs, 5);
  assert.deepEqual(responses.text.format, { type: 'json_schema', name: 'gemini_response', schema, strict: true });

  const chat = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: {
      responseFormat: { text: { mimeType: 'application/json', schema } },
      seed: 42, presencePenalty: 0.2, frequencyPenalty: -0.1,
      responseLogprobs: true, logprobs: 3
    }
  }, 'gemini', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.seed, 42);
  assert.equal(chat.presence_penalty, 0.2);
  assert.equal(chat.frequency_penalty, -0.1);
  assert.equal(chat.logprobs, true);
  assert.equal(chat.top_logprobs, 3);
  assert.deepEqual(chat.response_format, {
    type: 'json_schema',
    json_schema: { name: 'gemini_response', schema, strict: true }
  });

  const claude = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { topK: 40, responseMimeType: 'application/json', responseJsonSchema: schema }
  }, 'gemini', 'claude', 'minimax-m3');
  assert.equal(claude.top_k, 40);
  assert.deepEqual(claude.output_config, { format: { type: 'json_schema', schema } });
});

test('Gemini thinkingConfig 按 Responses 与 Claude 原生能力转换', () => {
  const contents = [{ role: 'user', parts: [{ text: '分析问题' }] }];
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  const responses = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } }
  }, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.reasoning, { effort: 'high', summary: 'auto' });

  const claude = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: {
      responseMimeType: 'application/json', responseJsonSchema: schema,
      thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true }
    }
  }, 'gemini', 'claude', 'minimax-m3');
  assert.deepEqual(claude.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(claude.output_config, {
    format: { type: 'json_schema', schema }, effort: 'medium'
  });

  const fixedBudget = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: false } }
  }, 'gemini', 'claude', 'minimax-m3');
  assert.deepEqual(fixedBudget.thinking, { type: 'enabled', budget_tokens: 4096, display: 'omitted' });
  assert.equal(fixedBudget.max_tokens, 8192);

  const adaptiveBudget = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { thinkingConfig: { thinkingBudget: 4096 } }
  }, 'gemini', 'claude', 'claude-opus-4-8');
  assert.deepEqual(adaptiveBudget.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptiveBudget.output_config, { effort: 'medium' });

  const disabled = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: true } }
  }, 'gemini', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(disabled.reasoning, { effort: 'none' });
  const claudeDisabled = prepareUpstreamRequest({
    model: 'alias', contents,
    generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: true } }
  }, 'gemini', 'claude', 'minimax-m3');
  assert.deepEqual(claudeDisabled.thinking, { type: 'disabled' });
});

test('Gemini thinkingConfig 的近似映射可观察且不可表达时明确报错', () => {
  const contents = [{ role: 'user', parts: [{ text: '分析问题' }] }];
  const request = (thinkingConfig) => ({ model: 'alias', contents, generationConfig: { thinkingConfig } });
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingLevel: 'minimal' }), 'gemini', 'responses', 'gpt-5.6-luna'), ['thinking_level_minimal_to_low']);
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingBudget: 4096 }), 'gemini', 'responses', 'gpt-5.6-luna'), ['thinking_budget_to_effort']);
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingBudget: 4096 }), 'gemini', 'claude', 'claude-opus-4-8'), ['thinking_budget_to_adaptive']);
  const deepSeekChat = prepareUpstreamRequest(request({ thinkingLevel: 'high' }), 'gemini', 'chat', 'deepseek-v4-flash');
  assert.equal(deepSeekChat.reasoning_effort, 'high');
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingLevel: 'high' }), 'gemini', 'chat', 'deepseek-v4-flash'), []);
  const chatWithThoughts = prepareUpstreamRequest(request({ thinkingLevel: 'high', includeThoughts: true }), 'gemini', 'chat', 'gpt-5.6-luna');
  assert.equal(chatWithThoughts.reasoning_effort, 'high');
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingLevel: 'high', includeThoughts: true }), 'gemini', 'chat', 'gpt-5.6-luna'), ['reasoning_summary_best_effort_chat']);
  const unknownResponsesModel = prepareUpstreamRequest(request({ thinkingLevel: 'high' }), 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(unknownResponsesModel.reasoning, { effort: 'high' });
  assert.throws(() => prepareUpstreamRequest({
    ...request({ thinkingBudget: 4096 }), generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 4096 } }
  }, 'gemini', 'claude', 'minimax-m3'), /budget_tokens 必须小于 max_tokens/);
  assert.throws(() => prepareUpstreamRequest(request({ thinkingBudget: 512 }), 'gemini', 'claude', 'minimax-m3'), /最低为 1024/);
  assert.throws(() => prepareUpstreamRequest({
    ...request({ thinkingLevel: 'high' }), generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'high' } }
  }, 'gemini', 'claude', 'minimax-m3'), /temperature 必须为 1/);
  assert.throws(() => prepareUpstreamRequest(request({ thinkingBudget: 0 }), 'gemini', 'claude', 'claude-fable-5'), /不允许关闭 thinking/);
  assert.deepEqual(reasoningRequestAdaptations(request({ thinkingBudget: 4096 }), 'gemini', 'claude', 'claude-opus-5'), ['thinking_budget_to_adaptive']);
});

test('Gemini 无法表达的生成配置不会被静默忽略', () => {
  const request = (generationConfig) => ({ contents: [{ role: 'user', parts: [{ text: '测试' }] }], generationConfig });
  assert.throws(() => normalizeRequest(request({ thinkingConfig: { thinkingBudget: 2048, thinkingLevel: 'high' } }), 'gemini'), /不能同时设置/);
  assert.throws(() => normalizeRequest(request({ thinkingConfig: { thinkingLevel: 'extreme' } }), 'gemini'), /thinkingLevel/);
  assert.throws(() => normalizeRequest(request({ thinkingConfig: { thinkingBudget: -2 } }), 'gemini'), /thinkingBudget/);
  assert.throws(() => normalizeRequest(request({ thinkingConfig: { includeThoughts: 'yes' } }), 'gemini'), /includeThoughts/);
  assert.throws(() => normalizeRequest(request({ thinkingConfig: { unknownThinkingOption: true } }), 'gemini'), /thinkingConfig 字段/);
  assert.throws(() => normalizeRequest(request({ responseLogprobs: false, logprobs: 3 }), 'gemini'), /responseLogprobs=true/);
  assert.throws(() => normalizeRequest(request({ responseMimeType: 'application\/json', responseSchema: {}, responseJsonSchema: {} }), 'gemini'), /不能同时设置/);
  const responses = prepareUpstreamRequest(request({ topK: 40 }), 'gemini', 'responses', 'gpt-5.6-luna');
  assert.equal(responses.top_k, undefined);
  assert.deepEqual(generationRequestAdaptations(request({ topK: 40 }), 'gemini', 'responses'), ['gemini_top_k_dropped']);
  const chat = prepareUpstreamRequest(request({ topK: 40 }), 'gemini', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.top_k, undefined);
  assert.deepEqual(generationRequestAdaptations(request({ topK: 40 }), 'gemini', 'chat'), ['gemini_top_k_dropped']);
  assert.throws(() => prepareUpstreamRequest(request({ seed: 42 }), 'gemini', 'claude', 'minimax-m3'), /seed/);
  assert.throws(() => normalizeRequest({ ...request({}), labels: { request: 'test' } }, 'gemini'), /Gemini 请求字段：labels/);
});

test('Gemini 函数返回 Schema 跨协议写入工具描述并可观察', () => {
  const responseSchema = {
    type: 'object', properties: { temperature: { type: 'number' } }, required: ['temperature']
  };
  const body = {
    contents: [{ role: 'user', parts: [{ text: '查询天气' }] }],
    tools: [{ functionDeclarations: [{
      name: 'lookup_weather', description: '查询天气',
      parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
      responseJsonSchema: responseSchema
    }] }]
  };
  assert.deepEqual(geminiToolAdaptations(body), ['gemini_response_schema_to_description']);
  const expected = '查询天气\n\nGemini function response JSON Schema:\n'
    + '{"properties":{"temperature":{"type":"number"}},"required":["temperature"],"type":"object"}';
  assert.equal(prepareUpstreamRequest(body, 'gemini', 'responses', 'gpt-test').tools[0].description, expected);
  assert.equal(prepareUpstreamRequest(body, 'gemini', 'chat', 'chat-test').tools[0].function.description, expected);
  assert.equal(prepareUpstreamRequest(body, 'gemini', 'claude', 'claude-test').tools[0].description, expected);

  const legacy = structuredClone(body);
  legacy.tools[0].functionDeclarations[0].response = legacy.tools[0].functionDeclarations[0].responseJsonSchema;
  delete legacy.tools[0].functionDeclarations[0].responseJsonSchema;
  assert.equal(prepareUpstreamRequest(legacy, 'gemini', 'responses', 'gpt-test').tools[0].description, expected);

  const declaration = (extra) => ({
    contents: [{ role: 'user', parts: [{ text: '测试' }] }],
    tools: [{ functionDeclarations: [{ name: 'lookup', ...extra }] }]
  });
  assert.throws(() => normalizeRequest(declaration({ response: {}, responseJsonSchema: {} }), 'gemini'), /不能同时设置 response/);
  assert.throws(() => normalizeRequest(declaration({ responseJsonSchema: [] }), 'gemini'), /responseJsonSchema 必须是 JSON Schema 对象/);
  assert.throws(() => normalizeRequest(declaration({ description: { text: 'bad' } }), 'gemini'), /description 必须是字符串/);
});

test('Gemini 大型工具适配统计只读取一次声明表并保留全部标记顺序', () => {
  const count = 512;
  const declarations = Array.from({ length: count }, (_, index) => ({
    name: index === 0 ? 'namespace.tool' : `tool_${index}`,
    parametersJsonSchema: { type: 'object' },
    ...(index === 1 ? { responseJsonSchema: { type: 'object' } } : {})
  }));
  let declarationReads = 0;
  const observedDeclarations = new Proxy(declarations, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) declarationReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const body = {
    tools: [{ functionDeclarations: observedDeclarations }, { googleSearch: {} }],
    contents: [{ role: 'model', parts: [{ functionCall: { name: 'namespace.tool', args: {} } }] }],
    toolConfig: { functionCallingConfig: {
      mode: 'VALIDATED', allowedFunctionNames: ['namespace.tool', 'tool_1'],
      streamFunctionCallArguments: true
    } }
  };

  assert.deepEqual(geminiToolAdaptations(body, 'responses'), [
    'gemini_function_names_aliased', 'gemini_google_search_to_web_search',
    'gemini_allowed_functions_filtered', 'gemini_validated_best_effort',
    'gemini_response_schema_to_description', 'gemini_stream_function_args_reencoded'
  ]);
  assert.ok(declarationReads <= count,
    `Gemini 工具适配统计读取了 ${declarationReads} 个声明，预期只遍历一次`);
});

test('JSON Schema 结构化输出在 Claude、Responses 与 Chat 间双向转换', () => {
  const schema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
  const messages = [{ role: 'user', content: '返回 JSON' }];

  const chatToResponses = prepareUpstreamRequest({
    model: 'alias', messages,
    response_format: { type: 'json_schema', json_schema: { name: 'result', description: '结果', schema, strict: true } }
  }, 'chat', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(chatToResponses.text.format, { type: 'json_schema', name: 'result', description: '结果', schema, strict: true });

  const responsesToChat = prepareUpstreamRequest({
    model: 'alias', input: '返回 JSON',
    text: { format: { type: 'json_schema', name: 'result', description: '结果', schema, strict: true } }
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(responsesToChat.response_format, {
    type: 'json_schema', json_schema: { name: 'result', description: '结果', schema, strict: true }
  });

  const claudeToResponses = prepareUpstreamRequest({
    model: 'alias', max_tokens: 128, messages: [{ role: 'user', content: '返回 JSON' }],
    output_config: { format: { type: 'json_schema', schema } }
  }, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(claudeToResponses.text.format, { type: 'json_schema', name: 'bridge_response', schema });

  const responsesToClaude = prepareUpstreamRequest({
    model: 'alias', input: '返回 JSON', text: { format: { type: 'json_schema', name: 'result', schema, strict: true } }
  }, 'responses', 'claude', 'minimax-m3');
  assert.deepEqual(responsesToClaude.output_config, { format: { type: 'json_schema', schema } });

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages,
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: 'true' } }
  }, 'chat', 'responses', 'gpt-5.6-luna'), /Chat JSON Schema strict 必须是布尔值/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '返回 JSON', text: { format: { type: 'json_schema', name: 'result', schema, strict: 1 } }
  }, 'responses', 'chat', 'deepseek-v4-flash'), /Responses JSON Schema strict 必须是布尔值/);
});

test('Responses reasoning summary 与 Claude thinking display 双向转换', () => {
  const responsesToClaude = prepareUpstreamRequest({
    model: 'alias', input: '分析',
    reasoning: { effort: 'minimal', summary: 'detailed', mode: 'standard', context: 'auto' }
  }, 'responses', 'claude', 'minimax-m3');
  assert.deepEqual(responsesToClaude.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(responsesToClaude.output_config, { effort: 'low' });
  assert.deepEqual(reasoningRequestAdaptations({
    reasoning: { effort: 'minimal', summary: 'detailed' }
  }, 'responses', 'claude', 'minimax-m3'), [
    'reasoning_summary_to_claude_display', 'reasoning_effort_minimal_to_low'
  ]);

  const claudeToResponses = prepareUpstreamRequest({
    model: 'alias', max_tokens: 4096,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(claudeToResponses.reasoning, { effort: 'max', summary: 'auto' });
  assert.deepEqual(reasoningRequestAdaptations({
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' }
  }, 'claude', 'responses', 'gpt-5.6-luna'), [
    'thinking_display_to_reasoning_summary', 'claude_effort_to_reasoning_effort'
  ]);

  const disabled = prepareUpstreamRequest({
    model: 'alias', max_tokens: 128, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: '直接回答' }]
  }, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(disabled.reasoning, { effort: 'none' });

  const disabledWithEffortBody = {
    model: 'alias', max_tokens: 128, thinking: { type: 'disabled' }, output_config: { effort: 'high' },
    messages: [{ role: 'user', content: '直接但完整地回答' }]
  };
  const disabledWithEffort = prepareUpstreamRequest(disabledWithEffortBody, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(disabledWithEffort.reasoning, { effort: 'none' });
  assert.deepEqual(reasoningRequestAdaptations(disabledWithEffortBody, 'claude', 'responses', 'gpt-5.6-luna'), ['claude_effort_unavailable_with_disabled_thinking']);
});

test('Responses 专属 reasoning 控制不会在跨协议时静默丢失', () => {
  const request = (reasoning) => ({ model: 'alias', input: '分析', reasoning });
  assert.throws(() => prepareUpstreamRequest(request({ mode: 'pro' }), 'responses', 'claude', 'minimax-m3'), /reasoning\.mode=pro/);
  assert.throws(() => prepareUpstreamRequest(request({ context: 'all_turns' }), 'responses', 'chat', 'deepseek-v4-flash'), /reasoning\.context=all_turns/);
  assert.throws(() => normalizeRequest(request({ summary: 'verbose' }), 'responses'), /reasoning\.summary/);
  assert.throws(() => normalizeRequest(request({ summary: 'auto', generate_summary: 'concise' }), 'responses'), /不能同时设置/);
  assert.throws(() => normalizeRequest(request({ mode: 'turbo' }), 'responses'), /reasoning\.mode/);
  assert.throws(() => normalizeRequest(request({ context: 'session' }), 'responses'), /reasoning\.context/);
  assert.throws(() => normalizeRequest(request({ effort: 'extreme' }), 'responses'), /reasoning\.effort/);
  assert.throws(() => normalizeRequest(request({ effort: 'high', vendor_option: true }), 'responses'), /reasoning 字段/);

  const deprecatedSummary = prepareUpstreamRequest(request({ generate_summary: 'concise' }), 'responses', 'claude', 'minimax-m3');
  assert.deepEqual(deprecatedSummary.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(deprecatedSummary.output_config, { effort: 'high' });

  const chat = prepareUpstreamRequest(request({ summary: 'auto' }), 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal('reasoning_effort' in chat, false);
  assert.deepEqual(reasoningRequestAdaptations(request({ summary: 'auto' }), 'responses', 'chat', 'deepseek-v4-flash'), ['reasoning_summary_best_effort_chat']);
});

test('Claude 推理配置跨协议时严格校验不支持字段和组合', () => {
  const request = (extra) => ({ model: 'alias', max_tokens: 4096, messages: [{ role: 'user', content: '分析' }], ...extra });
  assert.throws(() => normalizeRequest(request({ output_config: { task_budget: { type: 'tokens', total: 1000 } } }), 'claude'), /output_config 字段：task_budget/);
  assert.throws(() => normalizeRequest(request({ output_config: { effort: 'extreme' } }), 'claude'), /output_config\.effort/);
  assert.throws(() => normalizeRequest(request({ thinking: { type: 'enabled' } }), 'claude'), /必须提供 budget_tokens/);
  assert.throws(() => normalizeRequest(request({ thinking: { type: 'adaptive', budget_tokens: 2048 } }), 'claude'), /不能设置 budget_tokens/);
  assert.throws(() => normalizeRequest(request({ thinking: { type: 'disabled', display: 'omitted' } }), 'claude'), /不能设置 display/);
  assert.throws(() => normalizeRequest(request({ thinking: { type: 'adaptive', display: 'full' } }), 'claude'), /thinking\.display/);
  assert.throws(() => normalizeRequest(request({ thinking: { type: 'adaptive', vendor_option: true } }), 'claude'), /thinking 字段/);
});

test('Claude keep-all context management 与 deferred tools 可安全跨协议执行', () => {
  const body = {
    model: 'alias', max_tokens: 4096, messages: [{ role: 'user', content: '继续任务' }],
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    tools: [
      { name: 'ToolSearch', description: '加载工具', input_schema: { type: 'object' }, strict: true },
      { name: 'DeferredToolPlaceholder', description: '延迟占位', input_schema: { type: 'object' }, defer_loading: true }
    ]
  };
  const chat = prepareUpstreamRequest(body, 'claude', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['ToolSearch']);
  assert.equal(chat.tools[0].function.strict, true);
  const responses = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.tools.map((tool) => tool.name), ['ToolSearch']);
  assert.equal(responses.tools[0].strict, true);
  assert.deepEqual(claudeToolAdaptations(body.tools, body.messages), ['deferred_tools_hidden']);
  assert.deepEqual(contextRequestAdaptations(body, 'claude', 'chat'), ['claude_keep_all_thinking_local']);
});

test('Claude tool_reference 会在跨协议时加载对应 deferred tool', () => {
  const body = {
    model: 'alias', max_tokens: 4096, stream: true,
    messages: [
      { role: 'user', content: '搜索工具' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'search_1', name: 'ToolSearch', input: { query: 'Read' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'Read' }] }] }
    ],
    tools: [
      { name: 'ToolSearch', description: '加载工具', input_schema: { type: 'object' } },
      { name: 'Read', description: '读取文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, defer_loading: true, strict: true }
    ],
    tool_choice: { type: 'tool', name: 'Read' }
  };
  const chat = prepareUpstreamRequest(body, 'claude', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['ToolSearch', 'Read']);
  assert.equal(chat.tools[1].function.strict, true);
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'Read' } });
  const responses = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.tools.map((tool) => tool.name), ['ToolSearch', 'Read']);
  assert.equal(responses.tools[1].strict, true);
  assert.deepEqual(responses.tool_choice, { type: 'function', name: 'Read' });
  assert.deepEqual(claudeToolAdaptations(body.tools, body.messages), ['deferred_tools_loaded']);
});

test('普通工具参数和内容块内的同形 JSON 不会被误判为 Claude tool_reference', () => {
  const body = {
    model: 'alias', max_tokens: 1024,
    messages: [
      { role: 'user', content: '检查普通 JSON' },
      { role: 'assistant', content: [{
        type: 'tool_use', id: 'search_1', name: 'ToolSearch',
        input: { query: { type: 'tool_reference', tool_name: 'Hidden' } }
      }] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'search_1',
        content: [{ type: 'text', text: '未加载', metadata: { type: 'tool_reference', tool_name: 'Hidden' } }]
      }] }
    ],
    tools: [
      { name: 'ToolSearch', input_schema: { type: 'object' } },
      { name: 'Hidden', input_schema: { type: 'object' }, defer_loading: true }
    ]
  };

  const chat = prepareUpstreamRequest(body, 'claude', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['ToolSearch']);
  assert.deepEqual(claudeToolAdaptations(body.tools, body.messages), ['deferred_tools_hidden']);
});

test('Claude 新工具属性跨协议时可观察地适配且保留直接调用能力', () => {
  const body = {
    model: 'alias', max_tokens: 2048, stream: true, messages: [{ role: 'user', content: '处理文件' }],
    tools: [{
      name: 'convert_file', description: '转换文件',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, format: { type: 'string' } }, required: ['path', 'format'] },
      input_examples: [{ format: 'pdf', path: 'report.docx' }],
      allowed_callers: ['direct', 'code_execution_20260120'], eager_input_streaming: true
    }]
  };
  const chat = prepareUpstreamRequest(body, 'claude', 'chat', 'deepseek-v4-flash');
  assert.match(chat.tools[0].function.description, /Claude input_examples:\n\[{"format":"pdf","path":"report\.docx"}\]/);
  const responses = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-5.6-luna');
  assert.equal(responses.tools[0].description, chat.tools[0].function.description);
  assert.deepEqual(claudeToolAdaptations(body.tools, body.messages, true), [
    'input_examples_to_description', 'allowed_callers_direct_only', 'eager_input_streaming_best_effort'
  ]);
  assert.deepEqual(claudeToolAdaptations(body.tools, body.messages, false), [
    'input_examples_to_description', 'allowed_callers_direct_only'
  ]);
  const directOnly = structuredClone(body.tools);
  directOnly[0].allowed_callers = ['direct'];
  assert.deepEqual(claudeToolAdaptations(directOnly, body.messages, false), ['input_examples_to_description']);
});

test('Claude context management 与 deferred tool 的不可移植组合会明确报错', () => {
  const request = (extra) => ({ model: 'alias', max_tokens: 1024, messages: [{ role: 'user', content: '继续' }], ...extra });
  assert.throws(() => prepareUpstreamRequest(request({
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } }] }
  }), 'claude', 'chat', 'deepseek-v4-flash'), /仅能精确执行.*keep="all"/);
  assert.throws(() => prepareUpstreamRequest(request({
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] }
  }), 'claude', 'responses', 'gpt-5.6-luna'), /无法执行.*clear_tool_uses/);
  assert.throws(() => prepareUpstreamRequest(request({
    tools: [{ name: 'Hidden', input_schema: { type: 'object' }, defer_loading: true }]
  }), 'claude', 'chat', 'deepseek-v4-flash'), /全部标记为 defer_loading/);
  assert.throws(() => prepareUpstreamRequest(request({
    tool_choice: { type: 'tool', name: 'Hidden' },
    tools: [
      { name: 'ToolSearch', input_schema: { type: 'object' } },
      { name: 'Hidden', input_schema: { type: 'object' }, defer_loading: true }
    ]
  }), 'claude', 'responses', 'gpt-5.6-luna'), /不能强制选择.*Hidden/);
  assert.throws(() => normalizeRequest(request({
    tools: [{ name: 'Hidden', input_schema: { type: 'object' }, defer_loading: 'yes' }]
  }), 'claude'), /defer_loading 必须是布尔值/);
  assert.throws(() => prepareUpstreamRequest(request({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'Missing' }] }] }],
    tools: [{ name: 'ToolSearch', input_schema: {} }, { name: 'Read', input_schema: {}, defer_loading: true }]
  }), 'claude', 'chat', 'deepseek-v4-flash'), /引用了未定义工具：Missing/);
  assert.throws(() => prepareUpstreamRequest(request({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'Read' }] }] }],
    tools: [{ name: 'ToolSearch', input_schema: {} }, { name: 'Read', input_schema: {} }]
  }), 'claude', 'responses', 'gpt-5.6-luna'), /只能引用 defer_loading=true 的工具：Read/);
  assert.throws(() => prepareUpstreamRequest(request({
    tools: [{ name: 'sandbox_only', input_schema: {}, allowed_callers: ['code_execution_20260120'] }]
  }), 'claude', 'chat', 'deepseek-v4-flash'), /仅允许程序化调用/);
  assert.throws(() => normalizeRequest(request({
    tools: [{ name: 'bad', input_schema: {}, allowed_callers: ['direct', 'direct'] }]
  }), 'claude'), /allowed_callers/);
  assert.throws(() => normalizeRequest(request({
    tools: [{ name: 'bad', input_schema: {}, input_examples: [null] }]
  }), 'claude'), /input_examples/);
  assert.throws(() => normalizeRequest(request({
    tools: [{ name: 'bad', input_schema: {}, eager_input_streaming: 'yes' }]
  }), 'claude'), /eager_input_streaming/);
  assert.throws(() => normalizeRequest(request({
    tools: [{ name: 'bad', input_schema: {}, vendor_option: true }]
  }), 'claude'), /tools\[0\] 字段：vendor_option/);
});

test('OpenAI 响应可转换为 Gemini GenerateContentResponse', () => {
  const source = {
    id: 'chat_1', model: 'kimi-k2.6',
    choices: [{
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: '先查询', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"city":"上海"}' } }] },
      logprobs: { content: [{ token: '先', logprob: -0.2, bytes: [229, 133, 136], top_logprobs: [{ token: '先', logprob: -0.2, bytes: [229, 133, 136] }, { token: '请', logprob: -1.5, bytes: [232, 175, 183] }] }] }
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }
  };
  const output = formatResponse(normalizeResponse(source, 'chat'), 'gemini');
  assert.equal(output.candidates[0].content.role, 'model');
  assert.equal(output.candidates[0].content.parts[0].text, '先查询');
  assert.deepEqual(output.candidates[0].content.parts[1].functionCall, { name: 'lookup', args: { city: '上海' }, id: 'call_1' });
  assert.equal(output.candidates[0].finishReason, 'STOP');
  assert.equal(output.candidates[0].avgLogprobs, -0.2);
  assert.deepEqual(output.candidates[0].logprobsResult, {
    topCandidates: [{ candidates: [{ token: '先', logProbability: -0.2 }, { token: '请', logProbability: -1.5 }] }],
    chosenCandidates: [{ token: '先', logProbability: -0.2 }],
    logProbabilitySum: -0.2
  });
  assert.deepEqual(output.usageMetadata, { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 12, cachedContentTokenCount: 2, thoughtsTokenCount: 1 });

  const roundTrip = formatResponse(normalizeResponse(output, 'gemini'), 'responses');
  assert.equal(roundTrip.usage.output_tokens, 4);
  assert.equal(roundTrip.usage.output_tokens_details.reasoning_tokens, 1);
  assert.deepEqual(roundTrip.output[0].content[0].logprobs, [{
    token: '先', logprob: -0.2,
    top_logprobs: [{ token: '先', logprob: -0.2 }, { token: '请', logprob: -1.5 }]
  }]);
});

test('非流式复合推理状态通过 Gemini functionCall 单签名完整续轮', () => {
  const source = {
    id: 'msg_compound', model: 'claude-test', role: 'assistant', stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '分析请求', signature: 'claude-thinking-signature' },
      { type: 'redacted_thinking', data: 'claude-redacted-state' },
      { type: 'tool_use', id: 'call_read', name: 'read', input: { filePath: 'package.json' } }
    ],
    usage: { input_tokens: 3, output_tokens: 2 }
  };
  const gemini = formatResponse(normalizeResponse(source, 'claude', 'claude-test', { rejectUnknown: true }), 'gemini');
  const parts = gemini.candidates[0].content.parts;
  assert.deepEqual(parts.map((part) => part.functionCall ? 'functionCall' : part.thought ? 'thought' : 'other'), ['thought', 'functionCall']);
  assert.equal(parts[0].thoughtSignature, undefined);
  const bundled = decodeReasoningState(parts[1].thoughtSignature);
  assert.equal(bundled.protocol, 'bridge');
  assert.deepEqual(bundled.value.states.map((state) => state.kind), ['thinking', 'redacted_thinking']);

  const replay = prepareUpstreamRequest({
    model: 'alias',
    contents: [
      { role: 'model', parts },
      { role: 'user', parts: [{ functionResponse: { id: 'call_read', name: 'read', response: { result: 'ok' } } }] }
    ]
  }, 'gemini', 'claude', 'claude-upstream');
  assert.deepEqual(replay.messages[0].content.map((part) => part.type), ['thinking', 'redacted_thinking', 'tool_use']);
  assert.equal(replay.messages[0].content[0].signature, 'claude-thinking-signature');
  assert.equal(replay.messages[0].content[1].data, 'claude-redacted-state');
  assert.equal(replay.messages[1].content[0].type, 'tool_result');
});

test('Gemini 状态回放只移除对应数量的重复可读 thought', () => {
  const providerState = {
    protocol: 'claude', kind: 'thinking',
    value: { type: 'thinking', thinking: '相同分析', signature: 'opaque-thinking' }
  };
  const gemini = formatResponse({
    id: 'duplicate_thought', model: 'claude-test', stopReason: 'tool_use',
    inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 1,
    parts: [
      { type: 'reasoning', text: '相同分析', providerState },
      { type: 'reasoning', text: '相同分析' },
      { type: 'tool_call', id: 'call_duplicate', name: 'lookup', arguments: { value: 1 } }
    ]
  }, 'gemini');
  const replay = prepareUpstreamRequest({
    model: 'alias', contents: [
      gemini.candidates[0].content,
      { role: 'user', parts: [{ functionResponse: { id: 'call_duplicate', name: 'lookup', response: { result: 'ok' } } }] }
    ]
  }, 'gemini', 'claude', 'claude-test');
  const assistant = replay.messages[0].content;
  assert.equal(assistant.filter((part) => part.type === 'thinking').length, 1);
  assert.equal(assistant.find((part) => part.type === 'thinking').signature, 'opaque-thinking');
  assert.equal(assistant.filter((part) => part.type === 'text' && part.text === '相同分析').length, 1);
});

test('非流式无工具响应把单一私有状态绑定到可读 Gemini thought', () => {
  const source = {
    id: 'resp_no_tool', model: 'gpt-test', status: 'completed',
    output: [
      {
        id: 'rs_no_tool', type: 'reasoning', status: 'completed', encrypted_content: 'responses-private-state',
        summary: [{ type: 'summary_text', text: '先分析' }]
      },
      { id: 'msg_no_tool', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [] }] }
    ],
    usage: { input_tokens: 2, output_tokens: 2 }
  };
  const gemini = formatResponse(normalizeResponse(source, 'responses', 'gpt-test', { rejectUnknown: true }), 'gemini');
  const thought = gemini.candidates[0].content.parts.find((part) => part.thought === true);
  assert.equal(thought.text, '先分析');
  assert.equal(decodeReasoningState(thought.thoughtSignature).protocol, 'responses');

  const replay = prepareUpstreamRequest({
    model: 'alias', contents: [
      gemini.candidates[0].content,
      { role: 'user', parts: [{ text: '继续' }] }
    ]
  }, 'gemini', 'responses', 'gpt-upstream');
  const restored = replay.input.filter((item) => item.type === 'reasoning');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].encrypted_content, 'responses-private-state');
  assert.ok(replay.input.some((item) => item.role === 'assistant' && item.content?.[0]?.text === '答案'));
});

test('Gemini 复合状态封装不会被其它协议当作单一供应商签名', () => {
  const bundle = encodeReasoningStateBundle([
    { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: '分析', signature: 'sig' } },
    { protocol: 'claude', kind: 'redacted_thinking', value: { type: 'redacted_thinking', data: 'hidden' } }
  ]);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', max_tokens: 128,
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '分析', signature: bundle }] }]
  }, 'claude', 'responses', 'gpt-test'), /Gemini 专用的复合推理状态/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'reasoning', summary: [], encrypted_content: bundle }]
  }, 'responses', 'claude', 'claude-test'), /Gemini 专用的复合推理状态/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: bundle }] }]
  }, 'chat', 'responses', 'gpt-test'), /Gemini 专用的复合推理状态/);
});

test('Gemini usage 按候选与思考拆分且合法的 prompt 拦截响应可跨协议转换', () => {
  const normalized = normalizeResponse({
    responseId: 'gemini_blocked', modelVersion: 'gemini-test',
    candidates: [], promptFeedback: { blockReason: 'BLOCKLIST' },
    usageMetadata: {
      promptTokenCount: 7, candidatesTokenCount: 0, thoughtsTokenCount: 2,
      totalTokenCount: 9, cachedContentTokenCount: 3
    }
  }, 'gemini');
  assert.deepEqual(normalized, {
    id: 'gemini_blocked', model: 'gemini-test', parts: [],
    inputTokens: 7, outputTokens: 2, cachedInputTokens: 3,
    cacheCreationInputTokens: 0, reasoningTokens: 2, stopReason: 'BLOCKLIST'
  });
  const responses = formatResponse(normalized, 'responses');
  assert.equal(responses.status, 'incomplete');
  assert.deepEqual(responses.incomplete_details, { reason: 'content_filter' });
  assert.deepEqual(responses.output, []);
  assert.equal(responses.usage.output_tokens, 2);
  assert.equal(responses.usage.output_tokens_details.reasoning_tokens, 2);

  const filteredCandidate = normalizeResponse({
    candidates: [{ finishReason: 'SAFETY', safetyRatings: [] }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0 }
  }, 'gemini', 'gemini-fallback');
  assert.deepEqual(filteredCandidate.parts, []);
  assert.equal(filteredCandidate.stopReason, 'SAFETY');
  assert.equal(formatResponse(filteredCandidate, 'chat').choices[0].finish_reason, 'content_filter');

  assert.throws(
    () => normalizeResponse({ candidates: [], promptFeedback: {} }, 'gemini'),
    /缺少 promptFeedback\.blockReason/
  );
  assert.throws(
    () => normalizeResponse({ candidates: [{ finishReason: 'STOP' }] }, 'gemini'),
    /缺少 candidates\[0\]\.content\.parts/
  );
});

test('Gemini 不可无损转换的原生能力会返回明确错误', () => {
  assert.throws(() => normalizeRequest({ contents: [{ role: 'user', parts: [{ text: '执行代码' }] }], tools: [{ codeExecution: {} }] }, 'gemini'), /内置工具/);
  assert.throws(() => normalizeRequest({ contents: [{ role: 'user', parts: [{ text: '缓存' }] }], cachedContent: 'cachedContents/1' }, 'gemini'), /cachedContent/);
  assert.throws(() => normalizeRequest({ contents: [], toolConfig: {} }, 'gemini'), /contents/);
  const toolRequest = (functionCallingConfig, functionDeclarations = [{ name: 'a' }, { name: 'b' }]) => ({
    contents: [{ role: 'user', parts: [{ text: '工具' }] }],
    tools: [{ functionDeclarations }], toolConfig: { functionCallingConfig }
  });
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'ANY', allowedFunctionNames: ['a', ''] }), 'gemini'), /非空字符串/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'ANY', allowedFunctionNames: ['a', 'a'] }), 'gemini'), /重复名称/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'ANY', allowedFunctionNames: ['missing'] }), 'gemini'), /未定义工具/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'AUTO', allowedFunctionNames: ['a'] }), 'gemini'), /ANY 或 VALIDATED/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'ANY' }, []), 'gemini'), /至少需要一个/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'AUTO' }, [{ name: 'a' }, { name: 'a' }]), 'gemini'), /工具名称重复/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'AUTO', streamFunctionCallArguments: 'yes' }), 'gemini'), /必须是布尔值/);
  assert.throws(() => normalizeRequest(toolRequest({ mode: 'AUTO', streamFunctionCallArguments: true }), 'gemini'), /只能用于 streamGenerateContent/);
  assert.throws(() => normalizeRequest({ contents: [{ role: 'system', parts: [{ text: '错误角色' }] }] }, 'gemini'), /Content role/);
  assert.throws(() => normalizeRequest({ systemInstruction: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }, contents: [{ parts: [{ text: '测试' }] }] }, 'gemini'), /systemInstruction/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [] }] }, 'gemini'), /parts 必须是非空数组/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [{ text: '冲突', inlineData: { mimeType: 'image/png', data: 'AA==' } }] }] }, 'gemini'), /只能包含一种/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png' } }] }] }, 'gemini'), /inlineData/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [{ functionCall: { name: 'run', args: 'bad' } }] }] }, 'gemini'), /args 必须是对象/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [{ text: '多候选' }] }], generationConfig: { candidateCount: 2 } }, 'gemini'), /candidateCount=1/);
  assert.throws(() => normalizeRequest({ contents: [{ parts: [{ text: '安全设置' }] }], safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT' }] }, 'gemini'), /safetySettings/);
});

test('Gemini 文本 Google Search 仅转换到 Responses 托管 web_search', () => {
  const source = {
    model: 'gemini-alias',
    contents: [{ role: 'user', parts: [{ text: '搜索今天的新闻' }] }],
    tools: [{ googleSearch: {} }]
  };
  const responses = prepareUpstreamRequest(source, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(responses.tools, [{ type: 'web_search' }]);
  assert.equal(responses.tool_choice, undefined);
  assert.deepEqual(geminiToolAdaptations(source, 'responses'), ['gemini_google_search_to_web_search']);

  const explicitWeb = prepareUpstreamRequest({
    ...source,
    tools: [{ googleSearch: { searchTypes: { webSearch: {} } } }]
  }, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(explicitWeb.tools, [{ type: 'web_search' }]);

  const functionsDisabled = prepareUpstreamRequest({
    ...source,
    tools: [{
      googleSearch: {},
      functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }]
    }],
    toolConfig: { functionCallingConfig: { mode: 'NONE' } }
  }, 'gemini', 'responses', 'gpt-test');
  assert.deepEqual(functionsDisabled.tools, [{ type: 'web_search' }]);
  assert.equal(functionsDisabled.tool_choice, undefined);

  assert.throws(() => prepareUpstreamRequest(source, 'gemini', 'chat', 'chat-test'), /需要原生 Responses/);
  assert.throws(() => prepareUpstreamRequest(source, 'gemini', 'claude', 'claude-test'), /需要原生 Responses/);
  assert.throws(() => normalizeRequest({ ...source, tools: [{ googleSearch: {} }, { googleSearch: {} }] }, 'gemini'), /只能声明一次/);
  assert.throws(() => normalizeRequest({ ...source, tools: [{ googleSearch: { timeRangeFilter: { startTime: '2026-01-01T00:00:00Z' } } }] }, 'gemini'), /timeRangeFilter/);
  assert.throws(() => normalizeRequest({ ...source, tools: [{ googleSearch: { searchTypes: { imageSearch: {} } } }] }, 'gemini'), /图片搜索/);
  assert.throws(() => normalizeRequest({ ...source, tools: [{ googleSearch: { searchTypes: {} } }] }, 'gemini'), /必须启用 webSearch/);
  assert.throws(() => normalizeRequest({ ...source, tools: [{ googleSearch: { unknown: true } }] }, 'gemini'), /googleSearch 字段/);
});

test('Responses 搜索执行轨迹仅在已映射 Google Search 时放行并转换为 Gemini groundingMetadata', () => {
  const annotation = { type: 'url_citation', start_index: 0, end_index: 2, title: '官方来源', url: 'https://example.invalid/search-result' };
  const secondAnnotation = { type: 'url_citation', start_index: 0, end_index: 2, title: '第二来源', url: 'https://example.invalid/second-result' };
  const source = {
    id: 'resp_search', model: 'gpt-test', status: 'completed',
    output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '新闻' } },
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [annotation, secondAnnotation, annotation] }] }
    ],
    usage: { input_tokens: 3, output_tokens: 4 }
  };
  assert.throws(() => normalizeResponse(source, 'responses', '', { rejectUnknown: true }), /web_search_call/);
  assert.throws(() => normalizeResponse({ ...source, output: [{ type: 'web_search_call', status: 'completed' }] }, 'responses', '', {
    rejectUnknown: true,
    allowWebSearchCall: true
  }), /id 必须是非空字符串/);
  const gemini = formatResponse(normalizeResponse(source, 'responses', '', {
    rejectUnknown: true,
    allowWebSearchCall: true
  }), 'gemini');
  assert.equal(gemini.candidates[0].content.parts[0].text, '答案');
  assert.deepEqual(gemini.candidates[0].groundingMetadata, {
    webSearchQueries: ['新闻'],
    groundingChunks: [
      { web: { uri: 'https://example.invalid/search-result', title: '官方来源' } },
      { web: { uri: 'https://example.invalid/second-result', title: '第二来源' } }
    ],
    groundingSupports: [{
      segment: { partIndex: 0, startIndex: 0, endIndex: 2, text: '答案' },
      groundingChunkIndices: [0, 1]
    }]
  });

  const queryOnly = formatResponse(normalizeResponse({
    ...source,
    output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '新闻' } },
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '暂未找到结果', annotations: [] }] }
    ]
  }, 'responses', '', {
    rejectUnknown: true,
    allowWebSearchCall: true
  }), 'gemini');
  assert.deepEqual(queryOnly.candidates[0].groundingMetadata, { webSearchQueries: ['新闻'] });
});

test('搜索查询与 grounding 引用大集合保持首次顺序并使用集合去重', () => {
  const count = 256;
  const output = Array.from({ length: count }, (_, index) => ({
    id: `ws_${index}`, type: 'web_search_call', status: 'completed',
    action: { type: 'search', queries: [`query_${index}`, 'shared'], query: `query_${index}` }
  }));
  output.push({
    id: 'msg_search_many', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '完成', annotations: [] }]
  });
  const normalized = normalizeResponse({
    id: 'resp_search_many', model: 'gpt-test', status: 'completed', output,
    usage: { input_tokens: 1, output_tokens: 1 }
  }, 'responses', '', { rejectUnknown: true, allowWebSearchCall: true });
  assert.equal(normalized.webSearchQueries.length, count + 1);
  assert.deepEqual(normalized.webSearchQueries.slice(0, 3), ['query_0', 'shared', 'query_1']);
  assert.equal(normalized.webSearchQueries.at(-1), `query_${count - 1}`);

  const annotations = Array.from({ length: count }, (_, index) => ({
    type: 'url_citation', start_index: 0, end_index: 1,
    title: `source_${index}`, url: `https://example.invalid/source/${index}`
  }));
  annotations.push(annotations[0]);
  const originalIncludes = Array.prototype.includes;
  let includesCalls = 0;
  Array.prototype.includes = function instrumentedIncludes(...args) {
    includesCalls++;
    return Reflect.apply(originalIncludes, this, args);
  };
  let grounding;
  try { grounding = geminiGroundingMetadata([{ type: 'text', text: '答', annotations }]); }
  finally { Array.prototype.includes = originalIncludes; }

  assert.equal(grounding.groundingChunks.length, count);
  assert.equal(grounding.groundingSupports.length, 1);
  assert.deepEqual(grounding.groundingSupports[0].groundingChunkIndices, Array.from({ length: count }, (_, index) => index));
  assert.equal(includesCalls, 0, 'grounding 引用去重不应反复扫描已收集的 chunk 索引');
});

test('根据模型选择 OpenCode 官方协议', () => {
  assert.equal(upstreamProtocol('gpt-5.6-terra'), 'responses');
  assert.equal(upstreamProtocol('gpt-5.6-luna', {}, 'go'), 'responses');
  assert.equal(upstreamProtocol('claude-haiku-4-5'), 'claude');
  assert.equal(upstreamProtocol('qwen3.7-max'), 'claude');
  assert.equal(upstreamProtocol('qwen3.8-max', {}, 'go'), 'claude');
  assert.equal(upstreamProtocol('minimax-m3', {}, 'go'), 'claude');
  assert.equal(upstreamProtocol('kimi-k2.6'), 'chat');
  assert.equal(upstreamProtocol('grok-4.5', {}, 'go'), 'chat');
  assert.equal(upstreamProtocol('minimax-m2.7', {}, 'zen'), 'chat');
  assert.equal(upstreamProtocol('minimax-m2.7', {}, 'go'), 'claude');
  assert.equal(upstreamProtocol('o3'), 'responses');
  assert.equal(upstreamProtocol('gpt-oss-120b'), 'chat');
  assert.equal(upstreamProtocol('gemini-future-preview', {}, 'zen'), 'gemini');
  assert.equal(upstreamProtocol('  gemini-future-preview  ', {}, 'zen'), 'gemini');
  assert.equal(upstreamProtocol('gemini-future-preview', {}, 'go'), 'chat');
  assert.equal(upstreamProtocol('anything', { protocol: 'responses' }), 'responses');
  assert.equal(upstreamProtocol('gpt-5.6-luna', { protocol: 'chat' }, 'go'), 'chat');
});

test('四种协议都拒绝非布尔 stream，避免真值转换改变请求语义', () => {
  const labels = { claude: 'Claude', responses: 'Responses', chat: 'Chat', gemini: 'Gemini' };
  for (const protocol of Object.keys(labels)) {
    for (const stream of ['false', 1, null, {}]) {
      assert.throws(
        () => normalizeRequest({ model: 'test', stream }, protocol),
        new RegExp(`${labels[protocol]} stream 必须是布尔值`)
      );
    }
  }
});

test('跨协议 token 上限和采样数字不会被真值取值或字符串改写', () => {
  const claude = { model: 'alias', messages: [{ role: 'user', content: '回答' }] };
  const responses = { model: 'alias', input: '回答' };
  const chat = { model: 'alias', messages: [{ role: 'user', content: '回答' }] };

  assert.throws(() => prepareUpstreamRequest({ ...claude, max_tokens: 0 }, 'claude', 'responses', 'gpt-test'), /Claude max_tokens/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, max_output_tokens: '128' }, 'responses', 'chat', 'chat-test'), /Responses max_output_tokens/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, max_tokens: 64, max_completion_tokens: 128 }, 'chat', 'responses', 'gpt-test'), /不能同时/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, max_completion_tokens: 0 }, 'chat', 'responses', 'gpt-test'), /Chat 输出 token 上限/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, temperature: '0.5' }, 'chat', 'responses', 'gpt-test'), /Chat temperature/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, top_p: 1.1 }, 'responses', 'chat', 'chat-test'), /Responses top_p/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, seed: 1.5 }, 'chat', 'responses', 'gpt-test'), /Chat seed/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, presence_penalty: 3 }, 'chat', 'responses', 'gpt-test'), /Chat presence_penalty/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, temperature: 1.5 }, 'responses', 'claude', 'claude-test'), /Claude Messages temperature/);

  const output = prepareUpstreamRequest({ ...chat, max_completion_tokens: 128, temperature: 0, top_p: 0 }, 'chat', 'responses', 'gpt-test');
  assert.equal(output.max_output_tokens, 128);
  assert.equal(output.temperature, 0);
  assert.equal(output.top_p, 0);
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
  assert.equal('instructions' in output, false);
  assert.equal(output.input[0].role, 'system');
  assert.equal(output.input[0].content[0].text, '你是助手');
  assert.equal(output.max_output_tokens, 2048);
  assert.equal(output.tools[0].name, 'weather');
  assert.equal(output.input[2].type, 'function_call');
  assert.equal(output.input[3].type, 'function_call_output');
});

test('Claude 会话中途 developer 转 Chat 时按原位置降级为 system', () => {
  const output = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, system: '顶层系统提示',
    messages: [
      { role: 'system', content: '会话系统上下文' },
      { role: 'developer', content: '会话开发者上下文' },
      { role: 'user', content: '用户问题' },
      { role: 'assistant', content: '历史回答' }
    ]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(output.messages.map((message) => message.role), ['system', 'system', 'system', 'user', 'assistant']);
  assert.equal(output.messages[0].content, '顶层系统提示');
  assert.equal(output.messages[1].content, '会话系统上下文');
  assert.equal(output.messages[2].content, '会话开发者上下文');

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'tool', content: '非法角色' }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /role：tool/.test(error.message));
});

test('Responses 指令数组与历史 reasoning summary 可降级到 Chat', () => {
  const output = prepareUpstreamRequest({
    model: 'alias',
    instructions: [{ role: 'developer', content: [{ type: 'input_text', text: '数组指令' }] }],
    input: [
      { type: 'reasoning', encrypted_content: 'opaque-state', summary: [{ type: 'summary_text', text: '历史推理摘要' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ]
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(output.messages[0].role, 'system');
  assert.equal(output.messages[0].content, '数组指令');
  assert.equal(output.messages[1].role, 'assistant');
  assert.equal(output.messages[1].reasoning_content, '历史推理摘要');
  assert.equal(output.messages[2].content, '继续');
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

test('Responses 与 Chat 非流式响应保留公共追踪元数据', () => {
  const responses = formatResponse(normalizeResponse({
    id: 'chat_meta', object: 'chat.completion', created: 1_725_000_123,
    model: 'chat-test', service_tier: 'flex', system_fingerprint: 'fp_chat_1',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '完成' } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 }
  }, 'chat'), 'responses');
  assert.equal(responses.created_at, 1_725_000_123);
  assert.equal(responses.service_tier, 'flex');
  assert.equal('system_fingerprint' in responses, false);

  const chat = formatResponse(normalizeResponse({
    id: 'resp_meta', object: 'response', created_at: 1_725_000_456,
    status: 'completed', model: 'gpt-test', service_tier: 'priority',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }],
    usage: { input_tokens: 2, output_tokens: 1 }
  }, 'responses'), 'chat');
  assert.equal(chat.created, 1_725_000_456);
  assert.equal(chat.service_tier, 'priority');
  assert.equal('system_fingerprint' in chat, false);
});

test('非流式上游响应缺少协议最小结构时拒绝伪成功', () => {
  assert.throws(() => normalizeResponse(null, 'responses'), /JSON 对象/);
  assert.throws(() => normalizeResponse({}, 'claude'), /content 数组/);
  assert.throws(() => normalizeResponse({}, 'responses'), /output 数组/);
  assert.throws(() => normalizeResponse({ choices: [] }, 'chat'), /choices\[0\]\.message/);
  assert.throws(() => normalizeResponse({ output: [null] }, 'responses', '', { rejectUnknown: true }), /output\[0\] 必须是对象/);
  assert.throws(() => normalizeResponse({
    output: [{ type: 'message', content: null }]
  }, 'responses', '', { rejectUnknown: true }), /output\[0\]\.content 必须是数组/);
  assert.throws(() => normalizeResponse({
    output: [{ type: 'function_call', call_id: 'call_bad', name: 'run', arguments: '{bad' }]
  }, 'responses', '', { rejectUnknown: true }), /arguments 必须是有效 JSON 对象/);
  assert.throws(() => normalizeResponse({
    output: [{ type: 'reasoning', summary: [{ type: 'unknown_summary', text: '不能静默丢弃' }] }]
  }, 'responses', '', { rejectUnknown: true }), /summary\[0\].*summary_text/);
  assert.throws(() => normalizeResponse({
    choices: [
      { message: { content: '第一候选' } },
      { message: { content: '第二候选' } }
    ]
  }, 'chat', '', { rejectUnknown: true }), /2 个候选/);
  assert.throws(() => normalizeResponse({
    choices: [{ index: 1, message: { content: '错误候选索引' } }]
  }, 'chat', '', { rejectUnknown: true }), /index=1/);
  assert.throws(() => normalizeResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'run', arguments: 'null' } }] } }]
  }, 'chat', '', { rejectUnknown: true }), /arguments 必须是 JSON 对象/);
  assert.throws(() => normalizeResponse({
    content: [null]
  }, 'claude', '', { rejectUnknown: true }), /内容块类型：null/);
  assert.throws(() => normalizeResponse({
    content: [{ type: 'tool_use', id: 'call_bad', name: 'run', input: 'not-an-object' }]
  }, 'claude', '', { rejectUnknown: true }), /tool_use\.input 必须是对象/);
  assert.throws(() => normalizeResponse({
    candidates: [
      { content: { parts: [{ text: '第一候选' }] } },
      { content: { parts: [{ text: '第二候选' }] } }
    ]
  }, 'gemini', '', { rejectUnknown: true }), /2 个候选/);
  assert.throws(() => normalizeResponse({
    candidates: [{ index: 1, content: { parts: [{ text: '错误候选索引' }] } }]
  }, 'gemini', '', { rejectUnknown: true }), /index=1/);
  assert.throws(() => normalizeResponse({ output: [{ type: 'custom_tool_call' }] }, 'responses', '', { rejectUnknown: true }), /custom_tool_call/);
  for (const status of ['failed', 'cancelled', 'queued', 'in_progress', 'unexpected']) {
    assert.throws(() => normalizeResponse({ status, output: [] }, 'responses', '', { rejectUnknown: true }), new RegExp(`status=${status}`));
  }
  assert.throws(() => normalizeResponse({ status: 'completed', error: { message: '失败' }, output: [] }, 'responses', '', { rejectUnknown: true }), /包含 error/);
  assert.throws(() => normalizeResponse({
    status: 'incomplete', incomplete_details: { reason: 'vendor_limit' }, output: []
  }, 'responses', '', { rejectUnknown: true }), /incomplete_details\.reason.*vendor_limit/);
  assert.doesNotThrow(() => normalizeResponse({
    status: 'failed', error: { message: '同协议保留' }, output: []
  }, 'responses'));
});

test('Claude、Chat 与 Gemini 跨协议终态必须使用合法且与工具一致的停止原因', () => {
  const claudeText = { content: [{ type: 'text', text: '完成' }], usage: {} };
  for (const stopReason of [undefined, 'vendor_stop']) {
    assert.throws(
      () => normalizeResponse({ ...claudeText, stop_reason: stopReason }, 'claude', '', { rejectUnknown: true }),
      /stop_reason 无法跨协议转换/
    );
  }
  assert.throws(
    () => normalizeResponse({ ...claudeText, stop_reason: 'tool_use' }, 'claude', '', { rejectUnknown: true }),
    /不包含工具调用/
  );
  const claudeTool = {
    content: [{ type: 'tool_use', id: 'call_claude', name: 'lookup', input: { q: 'x' } }], usage: {}
  };
  assert.throws(
    () => normalizeResponse({ ...claudeTool, stop_reason: 'end_turn' }, 'claude', '', { rejectUnknown: true }),
    /包含工具调用.*end_turn/
  );
  assert.doesNotThrow(() => normalizeResponse({ ...claudeTool, stop_reason: 'tool_use' }, 'claude', '', { rejectUnknown: true }));
  assert.doesNotThrow(() => normalizeResponse({ ...claudeText, stop_reason: 'vendor_stop' }, 'claude'));

  const chatText = { choices: [{ message: { role: 'assistant', content: '完成' } }], usage: {} };
  for (const finishReason of [undefined, 'vendor_stop']) {
    assert.throws(
      () => normalizeResponse({ ...chatText, choices: [{ ...chatText.choices[0], finish_reason: finishReason }] }, 'chat', '', { rejectUnknown: true }),
      /finish_reason 无法跨协议转换/
    );
  }
  assert.throws(
    () => normalizeResponse({ ...chatText, choices: [{ ...chatText.choices[0], finish_reason: 'tool_calls' }] }, 'chat', '', { rejectUnknown: true }),
    /不包含工具调用/
  );
  const chatToolMessage = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_chat', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }]
  };
  assert.throws(
    () => normalizeResponse({ choices: [{ message: chatToolMessage, finish_reason: 'stop' }] }, 'chat', '', { rejectUnknown: true }),
    /包含工具调用.*stop/
  );
  assert.doesNotThrow(() => normalizeResponse({
    choices: [{ message: chatToolMessage, finish_reason: 'tool_calls' }]
  }, 'chat', '', { rejectUnknown: true }));
  assert.doesNotThrow(() => normalizeResponse({
    choices: [{ ...chatText.choices[0], finish_reason: 'vendor_stop' }]
  }, 'chat'));

  const geminiCandidate = { content: { parts: [{ text: '完成' }] }, index: 0 };
  for (const finishReason of [undefined, 'FINISH_REASON_UNSPECIFIED', 'OTHER', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'vendor_stop']) {
    assert.throws(
      () => normalizeResponse({ candidates: [{ ...geminiCandidate, finishReason }] }, 'gemini', '', { rejectUnknown: true }),
      /finishReason 无法跨协议转换/
    );
  }
  assert.equal(normalizeResponse({ candidates: [{ ...geminiCandidate, finishReason: 'SAFETY' }] }, 'gemini', '', { rejectUnknown: true }).stopReason, 'SAFETY');
  assert.throws(
    () => normalizeResponse({ candidates: [], promptFeedback: { blockReason: 'VENDOR_BLOCK' } }, 'gemini', '', { rejectUnknown: true }),
    /blockReason 无法跨协议转换/
  );
  assert.doesNotThrow(() => normalizeResponse({ candidates: [{ ...geminiCandidate, finishReason: 'OTHER' }] }, 'gemini'));
});

test('跨协议响应会拒绝错误角色及与总终态矛盾的子状态', () => {
  const claude = {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: '完成' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: {}
  };
  for (const override of [
    { type: 'vendor_message' },
    { role: 'user' },
    { stop_sequence: 'END' },
    { stop_reason: 'stop_sequence', stop_sequence: null }
  ]) {
    assert.throws(
      () => normalizeResponse({ ...claude, ...override }, 'claude', '', { rejectUnknown: true }),
      /type 无效|role 无效|stop_sequence/
    );
  }
  assert.doesNotThrow(() => normalizeResponse({ ...claude, stop_reason: 'stop_sequence', stop_sequence: 'END' }, 'claude', '', { rejectUnknown: true }));
  assert.doesNotThrow(() => normalizeResponse({ ...claude, role: 'vendor_assistant' }, 'claude'));

  assert.throws(() => normalizeResponse({
    choices: [{ message: { role: 'user', content: '错误角色' }, finish_reason: 'stop' }]
  }, 'chat', '', { rejectUnknown: true }), /message\.role 无效/);
  assert.doesNotThrow(() => normalizeResponse({
    choices: [{ message: { role: 'vendor_assistant', content: '原生扩展' }, finish_reason: 'vendor_stop' }]
  }, 'chat'));

  assert.throws(() => normalizeResponse({
    candidates: [{ content: { role: 'user', parts: [{ text: '错误角色' }] }, finishReason: 'STOP' }]
  }, 'gemini', '', { rejectUnknown: true }), /content\.role 无效/);
  assert.doesNotThrow(() => normalizeResponse({
    candidates: [{ content: { role: 'vendor_model', parts: [{ text: '原生扩展' }] }, finishReason: 'OTHER' }]
  }, 'gemini'));

  const responseItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] };
  for (const [status, itemStatus, pattern] of [
    ['completed', 'in_progress', /in_progress.*completed/],
    ['completed', 'incomplete', /incomplete.*completed/],
    ['incomplete', 'in_progress', /in_progress.*终态/],
    ['incomplete', 'vendor_status', /status 无效/]
  ]) {
    assert.throws(() => normalizeResponse({
      status,
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: [{ ...responseItem, status: itemStatus }]
    }, 'responses', '', { rejectUnknown: true }), pattern);
  }
  assert.doesNotThrow(() => normalizeResponse({
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ ...responseItem, status: 'completed' }, { type: 'reasoning', status: 'incomplete' }]
  }, 'responses', '', { rejectUnknown: true }));
  assert.doesNotThrow(() => normalizeResponse({
    status: 'completed', output: [{ ...responseItem, status: 'vendor_status' }]
  }, 'responses'));
});

test('跨协议非流式响应拒绝损坏的身份字段和 Chat 文本别名', () => {
  const cases = [
    [{ id: 7, model: 'claude', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }, 'claude', /id 必须是非空字符串/],
    [{ id: 'msg_1', model: {}, content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }, 'claude', /model 必须是非空字符串/],
    [{ id: 'resp_1', object: 'chat.completion', model: 'gpt', status: 'completed', output: [] }, 'responses', /object 无效/],
    [{ id: 'resp_item_id', model: 'gpt', status: 'completed', output: [{ id: 7, type: 'message', role: 'assistant', content: [] }] }, 'responses', /output\[0\]\.id 必须是非空字符串/],
    [{ id: 'resp_item_type', model: 'gpt', status: 'completed', output: [{ id: 'item_1', type: {}, content: [] }] }, 'responses', /output\[0\]\.type 必须是非空字符串/],
    [{ id: 'resp_encrypted', model: 'gpt', status: 'completed', output: [{ id: 'rs_1', type: 'reasoning', encrypted_content: {}, summary: [] }] }, 'responses', /encrypted_content 必须是非空字符串或 null/],
    [{ id: 'chat_1', object: 'chat.completion', model: 42, choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] }, 'chat', /model 必须是非空字符串/],
    [{ responseId: [], modelVersion: 'gemini', candidates: [{ content: { role: 'model', parts: [{ text: '完成' }] }, finishReason: 'STOP' }] }, 'gemini', /responseId 必须是非空字符串/]
  ];
  for (const [body, protocol, pattern] of cases) {
    assert.throws(() => normalizeResponse(body, protocol, 'fallback', { rejectUnknown: true }), pattern);
  }

  for (const [field, value] of [['refusal', {}], ['reasoning_content', 1], ['reasoning', []]]) {
    assert.throws(() => normalizeResponse({
      id: 'chat_alias', model: 'chat',
      choices: [{ message: { role: 'assistant', content: null, [field]: value }, finish_reason: 'stop' }]
    }, 'chat', '', { rejectUnknown: true }), new RegExp(`${field} 必须是字符串或 null`));
  }

  assert.doesNotThrow(() => normalizeResponse({
    id: 7, object: 'vendor.response', model: {}, status: 'completed', output: []
  }, 'responses'));
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
  const claude = {
    model: 'alias', max_tokens: 64, cache_control: { type: 'ephemeral', ttl: '1h' },
    messages: [{ role: 'user', content: 'test' }], vendor_extension: true
  };
  assert.deepEqual(prepareUpstreamRequest(claude, 'claude', 'claude', 'claude-upstream'), { ...claude, model: 'claude-upstream' });
});

test('Responses 服务端状态和执行语义跨协议时不会静默丢失', () => {
  const base = { model: 'alias', input: '继续任务' };
  const unsupported = [
    [{ previous_response_id: 'resp_previous' }, /previous_response_id.*完整 input 历史/],
    [{ conversation: 'conv_123' }, /conversation.*完整 input 历史/],
    [{ background: true }, /background.*responses/],
    [{ store: true }, /store.*持久化/],
    [{ truncation: 'auto' }, /truncation=auto/],
    [{ prompt: { id: 'pmpt_123', variables: { name: 'Codex' } } }, /prompt 服务端模板/],
    [{ max_tool_calls: 2 }, /max_tool_calls/],
    [{ context_management: [{ type: 'compaction', compact_threshold: 100000 }] }, /context_management.*服务端压缩/],
    [{ include: ['web_search_call.action.sources'] }, /include.*web_search_call\.action\.sources/]
  ];
  for (const [fields, message] of unsupported) {
    assert.throws(() => prepareUpstreamRequest({ ...base, ...fields }, 'responses', 'chat', 'chat-test'), (error) => error.status === 400 && message.test(error.message));
    assert.throws(() => prepareUpstreamRequest({ ...base, ...fields }, 'responses', 'claude', 'claude-test'), (error) => error.status === 400 && message.test(error.message));
  }
  assert.throws(() => prepareUpstreamRequest({ ...base, include: 'reasoning.encrypted_content' }, 'responses', 'chat', 'chat-test'), /include 必须是字符串数组/);
  assert.throws(() => prepareUpstreamRequest({ ...base, input: [{ role: 'assistant', phase: 'commentary', content: '处理中' }] }, 'responses', 'chat', 'chat-test'), /input\[0\]\.phase=commentary/);
});

test('Codex Responses 安全默认值和加密推理 include 可跨协议', () => {
  const body = {
    model: 'alias', input: '继续任务', store: false, background: false, truncation: 'disabled',
    include: ['reasoning.encrypted_content', 'message.output_text.logprobs'], previous_response_id: null, conversation: null,
    prompt: null, max_tool_calls: null, context_management: []
  };
  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'chat-test');
  assert.equal(chat.messages.at(-1).content, '继续任务');
  for (const field of ['store', 'background', 'truncation', 'include', 'previous_response_id', 'conversation', 'prompt', 'max_tool_calls', 'context_management']) {
    assert.equal(field in chat, false);
  }
  assert.deepEqual(prepareUpstreamRequest(body, 'responses', 'responses', 'gpt-test'), { ...body, model: 'gpt-test' });
  assert.throws(() => prepareUpstreamRequest(body, 'responses', 'claude', 'claude-test'), /message\.output_text\.logprobs/);
});

test('OpenAI 跨协议流选项会严格校验且保留可重编码语义', () => {
  const responses = prepareUpstreamRequest({
    model: 'alias', stream: true, stream_options: { include_obfuscation: false }, input: '测试'
  }, 'responses', 'chat', 'chat-test');
  assert.equal(responses.stream, true);

  const chat = prepareUpstreamRequest({
    model: 'alias', stream: true, stream_options: { include_usage: true, include_obfuscation: false },
    messages: [{ role: 'user', content: '测试' }]
  }, 'chat', 'responses', 'gpt-test');
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.stream_options, { include_obfuscation: false });

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stream: true, stream_options: { include_obfuscation: 'yes' }, input: '测试'
  }, 'responses', 'chat', 'chat-test'), /include_obfuscation.*布尔值/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stream: true, stream_options: { vendor_option: true }, messages: []
  }, 'chat', 'responses', 'gpt-test'), /stream_options 字段：vendor_option/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stream_options: { include_obfuscation: false }, input: '测试'
  }, 'responses', 'chat', 'chat-test'), /仅可在 stream=true/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stream: false, stream_options: { include_usage: true }, messages: []
  }, 'chat', 'responses', 'gpt-test'), /仅可在 stream=true/);
});

test('Responses 与 Chat 双向保留 OpenAI 通用服务控制字段', () => {
  const responses = prepareUpstreamRequest({
    model: 'alias', input: '简短回答', service_tier: 'fast', safety_identifier: 'user_hash', user: 'legacy_user',
    moderation: { model: 'omni-moderation-latest', policy: { input: { mode: 'block' } } },
    text: { verbosity: 'low', format: { type: 'text' } }
  }, 'responses', 'chat', 'gpt-5.6-terra');
  assert.equal(responses.service_tier, 'fast');
  assert.equal(responses.safety_identifier, 'user_hash');
  assert.equal(responses.user, 'legacy_user');
  assert.equal(responses.verbosity, 'low');
  assert.deepEqual(responses.moderation, { model: 'omni-moderation-latest', policy: { input: { mode: 'block' } } });

  const chat = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '详细回答' }], service_tier: 'flex',
    safety_identifier: 'safe_hash', user: 'legacy_user', verbosity: 'high',
    moderation: { model: 'omni-moderation-latest' }
  }, 'chat', 'responses', 'gpt-5.6-luna');
  assert.equal(chat.service_tier, 'flex');
  assert.equal(chat.safety_identifier, 'safe_hash');
  assert.equal(chat.user, 'legacy_user');
  assert.equal(chat.text.verbosity, 'high');
  assert.deepEqual(chat.moderation, { model: 'omni-moderation-latest' });

  assert.throws(() => prepareUpstreamRequest({ model: 'alias', input: 'test', service_tier: 'priority' }, 'responses', 'claude', 'claude-test'), /service_tier=priority/);
  assert.throws(() => prepareUpstreamRequest({ model: 'alias', messages: [{ role: 'user', content: 'test' }], store: true }, 'chat', 'responses', 'gpt-test'), /Chat store.*存储语义/);
  assert.throws(() => prepareUpstreamRequest({ model: 'alias', input: 'test', text: { verbosity: 'extreme' } }, 'responses', 'chat', 'chat-test'), /text\.verbosity/);
});

test('Claude speed 与 OpenAI default/fast service tier 双向转换并保留响应速度', () => {
  const fastResponses = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, speed: 'fast', messages: [{ role: 'user', content: '快速回答' }]
  }, 'claude', 'responses', 'gpt-5.6-luna');
  assert.equal(fastResponses.service_tier, 'fast');
  const standardChat = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, speed: 'standard', messages: [{ role: 'user', content: '普通回答' }]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.equal(standardChat.service_tier, 'default');

  const fastClaude = prepareUpstreamRequest({
    model: 'alias', input: '快速回答', service_tier: 'fast'
  }, 'responses', 'claude', 'minimax-m3');
  assert.equal(fastClaude.speed, 'fast');
  const standardClaude = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '普通回答' }], service_tier: 'default'
  }, 'chat', 'claude', 'minimax-m3');
  assert.equal(standardClaude.speed, 'standard');

  assert.deepEqual(serviceRequestAdaptations({ speed: 'fast' }, 'claude', 'responses'), ['claude_fast_speed_to_openai_fast_tier']);
  assert.deepEqual(serviceRequestAdaptations({ speed: 'standard' }, 'claude', 'chat'), ['claude_standard_speed_to_openai_default_tier']);
  assert.deepEqual(serviceRequestAdaptations({ service_tier: 'fast' }, 'responses', 'claude'), ['openai_fast_tier_to_claude_fast_speed']);
  assert.deepEqual(serviceRequestAdaptations({ service_tier: 'default' }, 'chat', 'claude'), ['openai_default_tier_to_claude_standard_speed']);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', max_tokens: 64, speed: 'turbo', messages: [{ role: 'user', content: 'test' }]
  }, 'claude', 'responses', 'gpt-test'), /Claude speed/);

  const responsesOutput = formatResponse(normalizeResponse({
    id: 'msg_speed', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '完成' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1, speed: 'fast' }
  }, 'claude', undefined, { rejectUnknown: true }), 'responses');
  assert.equal(responsesOutput.service_tier, 'fast');
  const claudeOutput = formatResponse(normalizeResponse({
    id: 'resp_speed', object: 'response', status: 'completed', model: 'gpt-test', service_tier: 'default',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }],
    usage: { input_tokens: 2, output_tokens: 1 }
  }, 'responses'), 'claude');
  assert.equal(claudeOutput.usage.speed, 'standard');
});

test('Chat 多候选、音频和托管能力跨协议时不会静默丢失', () => {
  const base = { model: 'alias', messages: [{ role: 'user', content: '回答' }] };
  for (const [fields, message] of [
    [{ n: 2 }, /n=1.*候选响应/],
    [{ modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } }, /modalities.*音频输出/],
    [{ prediction: { type: 'content', content: '预期文本' } }, /prediction/],
    [{ logit_bias: { 123: -100 } }, /logit_bias/],
    [{ web_search_options: { search_context_size: 'high' } }, /web_search_options/]
  ]) {
    assert.throws(() => prepareUpstreamRequest({ ...base, ...fields }, 'chat', 'responses', 'gpt-test'), (error) => error.status === 400 && message.test(error.message));
  }
  const textOnly = prepareUpstreamRequest({ ...base, n: 1, modalities: ['text'] }, 'chat', 'responses', 'gpt-test');
  assert.equal(textOnly.input[0].content[0].text, '回答');
});

test('Chat 旧式 functions 和 function_call 可转换为现代目标工具', () => {
  const body = {
    model: 'alias', messages: [{ role: 'user', content: '查询天气' }],
    functions: [{ name: 'weather', description: '查询天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    function_call: { name: 'weather' }
  };
  const responses = prepareUpstreamRequest(body, 'chat', 'responses', 'gpt-test');
  assert.equal(responses.tools[0].name, 'weather');
  assert.deepEqual(responses.tool_choice, { type: 'function', name: 'weather' });
  const claude = prepareUpstreamRequest(body, 'chat', 'claude', 'claude-test');
  assert.equal(claude.tools[0].name, 'weather');
  assert.deepEqual(claude.tool_choice, { type: 'tool', name: 'weather' });
  assert.throws(() => prepareUpstreamRequest({ ...body, tool_choice: 'auto' }, 'chat', 'responses', 'gpt-test'), /function_call.*tool_choice/);
});

test('跨协议工具选择严格校验协议形状和强制工具引用', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }], tool_choice: 'auto'
  }, 'claude', 'responses', 'gpt-test'), /Claude tool_choice 必须是对象/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '执行', tool_choice: 'any'
  }, 'responses', 'chat', 'chat-test'), /Responses tool_choice 必须是 none、auto 或 required/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }], tool_choice: 1
  }, 'chat', 'responses', 'gpt-test'), /Chat tool_choice 必须是对象/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }], tool_choice: { type: 'allowed_tools' }
  }, 'chat', 'responses', 'gpt-test'), /仅支持 Chat function tool_choice/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '执行', tool_choice: { type: 'function', name: 'missing' },
    tools: [{ type: 'function', name: 'available', parameters: { type: 'object' } }]
  }, 'responses', 'claude', 'claude-test'), /工具选择引用了未定义工具：missing/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }],
    tool_choice: { type: 'function', function: { name: 'missing' } },
    tools: [{ type: 'function', function: { name: 'available', parameters: { type: 'object' } } }]
  }, 'chat', 'responses', 'gpt-test'), /工具选择引用了未定义工具：missing/);
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

  const claude = prepareUpstreamRequest({
    model: 'alias', stop: 'DONE', messages: [{ role: 'user', content: '继续' }]
  }, 'chat', 'claude', 'claude-test');
  assert.deepEqual(claude.stop_sequences, ['DONE']);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop_sequences: ['END'], messages: [{ role: 'user', content: '继续' }]
  }, 'claude', 'responses', 'gpt-test'), (error) => error.status === 400 && /stop/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop_sequences: 'END', messages: [{ role: 'user', content: '继续' }]
  }, 'claude', 'chat', 'chat-test'), /stop_sequences 必须是字符串数组/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop: ['A', 2], messages: [{ role: 'user', content: '继续' }]
  }, 'chat', 'claude', 'claude-test'), /stop 只能包含字符串/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop: ['A', 'B', 'C', 'D', 'E'], messages: [{ role: 'user', content: '继续' }]
  }, 'chat', 'claude', 'claude-test'), /最多支持 4 个停止序列/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', stop_sequences: ['A', 'B', 'C', 'D', 'E'], messages: [{ role: 'user', content: '继续' }]
  }, 'claude', 'chat', 'chat-test'), /Chat stop 最多支持 4 个停止序列/);
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

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '你好', metadata: 'user-1'
  }, 'responses', 'claude', 'claude-test'), /Responses metadata 必须是对象/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '你好', metadata: { user_id: 1 }
  }, 'responses', 'claude', 'claude-test'), /metadata\.user_id/);

  const openAiMetadata = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '你好' }], metadata: { trace: 'request-1' }
  }, 'chat', 'responses', 'gpt-test');
  assert.deepEqual(openAiMetadata.metadata, { trace: 'request-1' });
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '你好' }], metadata: { nested: { value: 'x' } }
  }, 'chat', 'responses', 'gpt-test'), /Responses metadata\.nested.*字符串/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '你好' }],
    metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key-${index}`, 'value']))
  }, 'chat', 'responses', 'gpt-test'), /最多支持 16 个键值对/);
});

test('跨协议请求严格校验消息、输入、工具和系统容器形状', () => {
  for (const [body, source, target, message] of [
    [{ model: 'alias', messages: { role: 'user', content: '你好' }, max_tokens: 8 }, 'claude', 'chat', /Claude messages 必须是数组/],
    [{ model: 'alias', messages: [], max_tokens: 8, tools: { name: 'run', input_schema: {} } }, 'claude', 'chat', /Claude tools 必须是数组/],
    [{ model: 'alias', messages: [], max_tokens: 8, system: { type: 'text', text: '规则' } }, 'claude', 'chat', /Claude system 必须是字符串或文本块数组/],
    [{ model: 'alias', input: { role: 'user', content: '你好' } }, 'responses', 'chat', /Responses input 必须是字符串或输入项数组/],
    [{ model: 'alias', input: '你好', tools: { type: 'function', name: 'run' } }, 'responses', 'chat', /Responses tools 必须是数组/],
    [{ model: 'alias', messages: { role: 'user', content: '你好' } }, 'chat', 'responses', /Chat messages 必须是数组/],
    [{ model: 'alias', messages: [], tools: { type: 'function', function: { name: 'run' } } }, 'chat', 'responses', /Chat tools 必须是数组/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: { id: 'call_1' } }] }, 'chat', 'responses', /tool_calls 必须是数组/]
  ]) {
    assert.throws(() => prepareUpstreamRequest(body, source, target, `${target}-test`), message);
  }
});

test('跨协议请求拒绝未知顶层和结构化输出字段，同协议仍保留扩展', () => {
  const responses = { model: 'alias', input: '你好' };
  const claude = { model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: '你好' }] };
  const chat = { model: 'alias', messages: [{ role: 'user', content: '你好' }] };

  assert.throws(() => prepareUpstreamRequest({ ...responses, future_state: { id: 'state_1' } }, 'responses', 'chat', 'chat-test'),
    /暂不支持 Responses 请求字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({ ...claude, inference_geo: 'global' }, 'claude', 'responses', 'gpt-test'),
    /暂不支持 Claude 请求字段：inference_geo/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, thinking_config: { budget: 1 } }, 'chat', 'claude', 'claude-test'),
    /暂不支持 Chat 请求字段：thinking_config/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, text: { verbosity: 'low', future_option: true } }, 'responses', 'chat', 'chat-test'),
    /Responses text 包含不支持的字段：future_option/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, response_format: { type: 'json_object', future_option: true } }, 'chat', 'responses', 'gpt-test'),
    /json_object 输出格式 包含不支持的字段：future_option/);

  const sameProtocol = prepareUpstreamRequest({ ...responses, future_state: { id: 'state_1' } }, 'responses', 'responses', 'gpt-test');
  assert.deepEqual(sameProtocol.future_state, { id: 'state_1' });
  assert.throws(() => normalizeRequest(null, 'responses'), /请求体必须是 JSON 对象/);
});

test('Responses client_metadata 跨协议时校验并作为客户端遥测显式移除', () => {
  const metadata = {
    'x-codex-installation-id': 'install_probe',
    'x-codex-turn-metadata': '{"session_id":"session_probe","turn_id":"turn_probe"}'
  };
  const request = { model: 'alias', input: '你好', client_metadata: metadata };

  const chat = prepareUpstreamRequest(request, 'responses', 'chat', 'chat-test');
  assert.equal(chat.client_metadata, undefined);
  assert.deepEqual(inputRequestDegradations(request, 'responses', 'chat'), ['responses_client_metadata']);
  assert.deepEqual(inputRequestDegradations(request, 'responses', 'responses'), []);
  assert.deepEqual(prepareUpstreamRequest(request, 'responses', 'responses', 'gpt-test').client_metadata, metadata);

  assert.throws(() => prepareUpstreamRequest({ ...request, client_metadata: [] }, 'responses', 'chat', 'chat-test'),
    /client_metadata 必须是对象/);
  assert.throws(() => prepareUpstreamRequest({ ...request, client_metadata: { session_id: 42 } }, 'responses', 'chat', 'chat-test'),
    /client_metadata\.session_id 必须是最长 1 MiB 的字符串/);
  assert.throws(() => prepareUpstreamRequest({ ...request, client_metadata: { ['x'.repeat(129)]: 'value' } }, 'responses', 'chat', 'chat-test'),
    /client_metadata 键名必须是长度 1–128/);
});

test('Responses 历史项 id/status 被严格校验并明确标记跨协议降级', () => {
  const request = {
    model: 'alias',
    instructions: [{ type: 'message', id: 'msg_instruction', status: 'completed', role: 'developer', content: '系统规则' }],
    input: [
      { type: 'message', id: 'msg_user', status: 'completed', role: 'user', content: '执行任务' },
      { type: 'reasoning', id: 'rs_history', status: 'completed', summary: [{ type: 'summary_text', text: '历史摘要' }] },
      { type: 'function_call', id: 'fc_history', status: 'completed', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', id: 'fco_history', status: 'completed', call_id: 'call_1', output: '完成' }
    ],
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }]
  };

  const chat = prepareUpstreamRequest(request, 'responses', 'chat', 'chat-test');
  assert.deepEqual(chat.messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(inputRequestDegradations(request, 'responses', 'chat'), ['responses_item_metadata']);
  assert.deepEqual(inputRequestDegradations(request, 'responses', 'responses'), []);

  for (const [field, value, message] of [
    ['id', '', /message\.id 必须是非空字符串/],
    ['status', 'queued', /message\.status 必须是 in_progress、completed、incomplete 之一/]
  ]) {
    assert.throws(() => prepareUpstreamRequest({
      model: 'alias', input: [{ type: 'message', role: 'user', content: '任务', [field]: value }]
    }, 'responses', 'chat', 'chat-test'), message);
  }
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'message', role: 'assistant', content: '处理中', phase: 'analysis' }]
  }, 'responses', 'chat', 'chat-test'), /phase 必须是 commentary、final_answer 之一/);
});

test('Responses instructions 只接受系统层角色并为 Chat 降级 developer', () => {
  const invalid = (role) => prepareUpstreamRequest({
    model: 'alias', instructions: [{ type: 'message', role, content: '越权指令' }], input: '继续'
  }, 'responses', 'chat', 'chat-test');
  assert.throws(() => invalid('user'), /role 只能是 system 或 developer/);
  assert.throws(() => invalid('assistant'), /role 只能是 system 或 developer/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', instructions: [{ type: 'message', role: 'developer', content: '规则', future_state: true }], input: '继续'
  }, 'responses', 'chat', 'chat-test'), /instructions\[0\] 包含不支持的字段：future_state/);

  const output = prepareUpstreamRequest({
    model: 'alias',
    instructions: [
      { type: 'message', role: 'system', content: '系统规则' },
      { type: 'message', role: 'developer', content: '开发规则' }
    ],
    input: '继续'
  }, 'responses', 'chat', 'chat-test');
  assert.deepEqual(output.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(output.messages[0].content, '系统规则\n开发规则');
});

test('跨协议已知容器中的未知字段不会再被静默删除', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: '问题', future_state: true }]
  }, 'responses', 'chat', 'chat-test'), /input\[0\] message 包含不支持的字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [{ type: 'input_text', text: '问题', future_state: true }] }]
  }, 'responses', 'chat', 'chat-test'), /input_text 内容块 包含不支持的字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '问题', future_state: true }]
  }, 'chat', 'responses', 'gpt-test'), /Chat messages\[0\] 包含不支持的字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}', future_state: true }
    }] }]
  }, 'chat', 'claude', 'claude-test'), /tool_calls\[0\]\.function 包含不支持的字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: '问题', future_state: true }]
  }, 'claude', 'responses', 'gpt-test'), /Claude messages\[0\] 包含不支持的字段：future_state/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '问题', tools: [{ type: 'function', name: 'run', parameters: {}, future_state: true }]
  }, 'responses', 'chat', 'chat-test'), /Responses tools\[0\] 包含不支持的字段：future_state/);
});

test('跨协议请求拒绝会消失的空消息和不可移植 Chat 历史字段', () => {
  const invalid = [
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: null }] }, 'claude', 'chat', /Claude messages\[0\]\.content 必须是非空/],
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: [] }] }, 'claude', 'responses', /Claude messages\[0\]\.content 必须是非空/],
    [{ model: 'alias', input: [{ role: 'user', content: null }] }, 'responses', 'chat', /Responses input\[0\]\.content 必须是非空/],
    [{ model: 'alias', input: [{ role: 'assistant', content: [] }] }, 'responses', 'claude', /Responses input\[0\]\.content 必须是非空/],
    [{ model: 'alias', messages: [{ role: 'user', content: null }] }, 'chat', 'responses', /Chat messages\[0\]\.content 必须是非空/],
    [{ model: 'alias', messages: [{ role: 'system', content: [] }, { role: 'user', content: '继续' }] }, 'chat', 'claude', /Chat messages\[0\]\.content 必须是非空/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null }] }, 'chat', 'responses', /Chat messages\[0\]\.content 必须是非空/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, name: 'agent-a', reasoning_content: '思考' }] }, 'chat', 'responses', /无法保留.*\.name/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, audio: { id: 'audio_1' } }] }, 'chat', 'claude', /无法保留.*\.audio/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, refusal: {} }] }, 'chat', 'responses', /refusal 必须是字符串或 null/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, reasoning_content: { text: '思考' } }] }, 'chat', 'responses', /reasoning_content 必须是字符串或 null/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, reasoning_content: '甲', reasoning: '乙' }] }, 'chat', 'responses', /reasoning_content 与 reasoning 不能冲突/],
    [{ model: 'alias', messages: [{ role: 'user', content: '问题', tool_calls: [] }] }, 'chat', 'responses', /tool_calls 仅可用于 assistant/],
    [{ model: 'alias', messages: [{ role: 'user', content: '问题', refusal: '拒答' }] }, 'chat', 'claude', /refusal 仅可用于 assistant/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, reasoning_details: [{ type: 'vendor.secret', data: 'opaque' }] }] }, 'chat', 'responses', /暂不支持 Chat reasoning_details 类型/]
  ];
  for (const [body, source, target, pattern] of invalid) {
    assert.throws(() => prepareUpstreamRequest(body, source, target, `${target}-test`), (error) => error.status === 400 && pattern.test(error.message));
  }

  const reasoningOnly = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'assistant', content: null, reasoning_content: '保留的历史推理' }]
  }, 'chat', 'responses', 'gpt-test');
  assert.equal(reasoningOnly.input[0].role, 'assistant');
  assert.equal(reasoningOnly.input[0].content[0].text, '保留的历史推理');

  const detailOnly = { model: 'alias', messages: [{
    role: 'assistant', content: null,
    reasoning_details: [{ type: 'reasoning.summary', summary: '详情中的可读摘要' }]
  }] };
  const detailOutput = prepareUpstreamRequest(detailOnly, 'chat', 'claude', 'claude-test');
  assert.equal(detailOutput.messages[0].content[0].text, '详情中的可读摘要');
  assert.deepEqual(reasoningRequestAdaptations(detailOnly, 'chat', 'claude', 'claude-test'), ['reasoning_history_to_assistant_text']);

  const opaque = { model: 'alias', messages: [{
    role: 'assistant', content: null,
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'external-state' }]
  }] };
  assert.deepEqual(inputRequestDegradations(opaque, 'chat', 'responses'), ['chat_reasoning_state']);
});

test('跨协议请求严格校验消息 role 与内容块类型的协议组合', () => {
  const cases = [
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }] }] }, 'claude', 'responses', /tool_use 内容块不能用于 user role/],
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '结果' }] }] }, 'claude', 'chat', /tool_result 内容块不能用于 assistant role/],
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'assistant', content: [{ type: 'image', source: { type: 'url', url: 'https:\/\/example.com\/x.png' } }] }] }, 'claude', 'responses', /image 内容块不能用于 assistant role/],
    [{ model: 'alias', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'thinking', thinking: '不合法', signature: 's' }] }] }, 'claude', 'chat', /thinking 内容块不能用于 user role/],
    [{ model: 'alias', max_tokens: 8, system: [{ type: 'image', source: { type: 'url', url: 'https:\/\/example.com\/x.png' } }], messages: [{ role: 'user', content: '问题' }] }, 'claude', 'responses', /Claude system\[0\].*image 内容块不能用于 system role/],
    [{ model: 'alias', input: [{ role: 'system', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] }, { role: 'user', content: '问题' }] }, 'responses', 'claude', /input_image 内容块不能用于 system role/],
    [{ model: 'alias', input: [{ role: 'assistant', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] }] }, 'responses', 'chat', /input_image 内容块不能用于 assistant role/],
    [{ model: 'alias', input: [{ role: 'user', content: [{ type: 'output_text', text: '错误别名' }] }] }, 'responses', 'claude', /output_text 内容块不能用于 user role/],
    [{ model: 'alias', input: [{ role: 'user', content: [{ type: 'refusal', refusal: '错误拒答' }] }] }, 'responses', 'chat', /refusal 内容块不能用于 user role/],
    [{ model: 'alias', messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }, { role: 'user', content: '问题' }] }, 'chat', 'responses', /image_url 内容块不能用于 system role/],
    [{ model: 'alias', messages: [{ role: 'user', content: [{ type: 'refusal', refusal: '错误拒答' }] }] }, 'chat', 'claude', /refusal 内容块不能用于 user role/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] }, 'chat', 'responses', /image_url 内容块不能用于 assistant role/]
  ];
  for (const [body, source, target, pattern] of cases) {
    assert.throws(() => prepareUpstreamRequest(body, source, target, `${target}-test`), (error) => error.status === 400 && pattern.test(error.message));
  }

  const valid = prepareUpstreamRequest({
    model: 'alias', max_tokens: 32,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'run', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '完成' }] }
    ]
  }, 'claude', 'responses', 'gpt-test');
  assert.deepEqual(valid.input.map((item) => item.type), ['function_call', 'function_call_output']);
});

test('Responses 历史 reasoning 输入严格校验并保留 summary 与 reasoning_text', () => {
  const output = prepareUpstreamRequest({
    model: 'alias', input: [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '摘要一' }, { type: 'summary_text', text: '摘要二' }],
        content: [{ type: 'reasoning_text', text: '详细推理' }]
      },
      { type: 'reasoning', summary: null, content: null, encrypted_content: null },
      { role: 'user', content: '继续' }
    ]
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(output.messages[0].role, 'assistant');
  assert.equal(output.messages[0].reasoning_content, '摘要一\n摘要二\n详细推理');
  assert.equal(output.messages[1].content, '继续');

  const invalid = [
    [{ type: 'reasoning', summary: { type: 'summary_text', text: '错误容器' } }, /summary 必须是数组/],
    [{ type: 'reasoning', summary: [{ type: 'summary_text', text: { value: '错误类型' } }] }, /summary\[0\] 必须是 summary_text 文本块/],
    [{ type: 'reasoning', summary: [{ type: 'vendor_summary', text: '错误类型' }] }, /summary\[0\] 必须是 summary_text 文本块/],
    [{ type: 'reasoning', content: { type: 'reasoning_text', text: '错误容器' } }, /content 必须是数组/],
    [{ type: 'reasoning', content: [{ type: 'summary_text', text: '错误类型' }] }, /content\[0\] 必须是 reasoning_text 文本块/],
    [{ type: 'reasoning', encrypted_content: { secret: true }, summary: [] }, /encrypted_content 必须是非空字符串或 null/],
    [{ type: 'reasoning', encrypted_content: '', summary: [] }, /encrypted_content 必须是非空字符串或 null/]
  ];
  for (const [item, pattern] of invalid) {
    assert.throws(() => prepareUpstreamRequest({
      model: 'alias', input: [item, { role: 'user', content: '继续' }]
    }, 'responses', 'claude', 'claude-test'), (error) => error.status === 400 && pattern.test(error.message));
  }
});

test('跨协议函数定义与 Chat tool 文本结果不会以畸形 JSON 发往上游', () => {
  const toolResult = prepareUpstreamRequest({
    model: 'alias', messages: [{
      role: 'tool', tool_call_id: 'call_1',
      content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]
    }]
  }, 'chat', 'responses', 'gpt-test');
  assert.equal(toolResult.input[0].output, '第一段第二段');

  const invalid = [
    [{ model: 'alias', input: '问题', tools: [{ type: 'function', name: 'run', description: { text: '错误' }, parameters: { type: 'object' } }] }, 'responses', 'chat', /description 必须是字符串/],
    [{ model: 'alias', input: '问题', tools: [{ type: 'function', name: 'run', parameters: 'object' }] }, 'responses', 'claude', /parameters 必须是 JSON Schema 对象/],
    [{ model: 'alias', messages: [{ role: 'user', content: '问题' }], tools: [{ type: 'function', function: { name: 'run', description: ['错误'], parameters: { type: 'object' } } }] }, 'chat', 'responses', /description 必须是字符串/],
    [{ model: 'alias', messages: [{ role: 'user', content: '问题' }], tools: [{ type: 'function', function: { name: 'run', parameters: [] } }] }, 'chat', 'claude', /parameters 必须是 JSON Schema 对象/],
    [{ model: 'alias', messages: [{ role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: { value: '错误' } }] }] }, 'chat', 'responses', /content\[0\]\.text 必须是字符串/]
  ];
  for (const [body, source, target, pattern] of invalid) {
    assert.throws(() => prepareUpstreamRequest(body, source, target, `${target}-test`), (error) => error.status === 400 && pattern.test(error.message));
  }
});

test('Claude 工具失败状态跨到 OpenAI 协议时保留为显式结果标记', () => {
  const source = {
    model: 'alias', max_tokens: 64,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '连接超时', is_error: true }] }
    ]
  };
  const responses = prepareUpstreamRequest(source, 'claude', 'responses', 'gpt-test');
  assert.equal(responses.input.find((item) => item.type === 'function_call_output').output, '[Claude tool_result is_error=true]\n连接超时');
  const chat = prepareUpstreamRequest(source, 'claude', 'chat', 'chat-test');
  assert.equal(chat.messages.find((message) => message.role === 'tool').content, '[Claude tool_result is_error=true]\n连接超时');
  assert.deepEqual(claudeToolAdaptations([], source.messages), ['claude_tool_error_to_content']);

  assert.throws(() => prepareUpstreamRequest({
    ...source,
    messages: [source.messages[0], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '失败', is_error: 'true' }] }]
  }, 'claude', 'responses', 'gpt-test'), /tool_result\.is_error 必须是布尔值/);
});

test('Zen 原生 Gemini 支持同协议透传以及 Chat、Responses、Claude 请求互转', () => {
  assert.equal(upstreamProtocol('gemini-3.6-flash', {}, 'zen'), 'gemini');
  assert.equal(upstreamProtocol('grok-4.5', {}, 'zen'), 'responses');
  assert.equal(upstreamProtocol('grok-4.5', {}, 'go'), 'chat');

  const direct = prepareUpstreamRequest({
    contents: [{ role: 'user', parts: [{ text: '你好' }] }],
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    stream: true
  }, 'gemini', 'gemini', 'gemini-3.6-flash');
  assert.equal(direct.model, 'gemini-3.6-flash');
  assert.equal(direct.stream, true);
  assert.equal(direct.safetySettings[0].threshold, 'BLOCK_NONE');

  const chat = prepareUpstreamRequest({
    model: 'alias', stream: true,
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: [{ type: 'text', text: '查图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"上海"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' }
    ],
    tools: [{ type: 'function', function: { name: 'lookup', description: '查询', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    max_completion_tokens: 64, temperature: 0.2, response_format: { type: 'json_object' }, reasoning_effort: 'high'
  }, 'chat', 'gemini', 'gemini-3.6-flash');
  assert.deepEqual(chat.systemInstruction, { parts: [{ text: '规则' }] });
  assert.deepEqual(chat.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AA==' } });
  assert.deepEqual(chat.contents[1].parts[0].functionCall, { name: 'lookup', args: { q: '上海' }, id: 'call_1' });
  assert.deepEqual(chat.contents[2].parts[0].functionResponse, { name: 'lookup', response: { result: '晴' }, id: 'call_1' });
  assert.deepEqual(chat.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['lookup'] });
  assert.deepEqual(chat.generationConfig, {
    maxOutputTokens: 64, temperature: 0.2, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'high' }
  });

  const responses = prepareUpstreamRequest({
    model: 'alias', input: '搜索今天的新闻', tools: [{ type: 'web_search' }]
  }, 'responses', 'gemini', 'gemini-3.6-flash');
  assert.deepEqual(responses.tools, [{ googleSearch: {} }]);
  assert.equal(responses.contents[0].parts[0].text, '搜索今天的新闻');

  const opaqueReasoning = prepareUpstreamRequest({
    model: 'alias', input: [
      { type: 'reasoning', encrypted_content: 'responses-private-state', summary: [{ type: 'summary_text', text: '可读摘要' }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ]
  }, 'responses', 'gemini', 'gemini-3.6-flash');
  assert.deepEqual(opaqueReasoning.contents[0].parts, [{ text: '可读摘要', thought: true }]);
  assert.equal(JSON.stringify(opaqueReasoning).includes('responses-private-state'), false);
  assert.equal(JSON.stringify(opaqueReasoning).includes('thoughtSignature'), false);
  assert.deepEqual(inputRequestDegradations({
    input: [{ type: 'reasoning', encrypted_content: 'responses-private-state', summary: [] }]
  }, 'responses', 'gemini'), ['encrypted_reasoning']);

  const claude = prepareUpstreamRequest({
    model: 'alias', max_tokens: 128, system: '规则',
    messages: [{ role: 'user', content: '你好' }],
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' }
  }, 'claude', 'gemini', 'gemini-3.6-flash');
  assert.equal(claude.generationConfig.maxOutputTokens, 128);
  assert.deepEqual(claude.generationConfig.thinkingConfig, { thinkingLevel: 'high' });

  const cachedClaude = {
    model: 'alias', max_tokens: 64,
    system: [{ type: 'text', text: '缓存规则', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]
  };
  const cachedGemini = prepareUpstreamRequest(cachedClaude, 'claude', 'gemini', 'gemini-3.6-flash');
  assert.equal(JSON.stringify(cachedGemini).includes('cache_control'), false);
  assert.deepEqual(claudeCacheAdaptations(cachedClaude, 'gemini', 'gemini-3.6-flash'), ['claude_cache_control_dropped']);

  const failedToolResult = [{ type: 'tool_result', tool_use_id: 'call_1', content: '失败', is_error: true }];
  assert.deepEqual(claudeToolAdaptations([], [{ role: 'user', content: failedToolResult }], false, 'gemini'), []);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '搜索', tools: [{ type: 'web_search', search_context_size: 'high' }]
  }, 'responses', 'gemini', 'gemini-3.6-flash'), /无法表达.*search_context_size/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'tool', tool_call_id: 'future', content: '提前结果' }]
  }, 'chat', 'gemini', 'gemini-3.6-flash'), /无法找到 call id=future/);
});

test('跨协议历史工具调用严格校验关联 ID、名称和 JSON 对象参数', () => {
  const validChat = prepareUpstreamRequest({
    model: 'alias', messages: [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: { z: 1, a: 2 } } }]
    }]
  }, 'chat', 'responses', 'gpt-test');
  assert.deepEqual(JSON.parse(validChat.input[0].arguments), { a: 2, z: 1 });

  const validResponses = prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'function_call', id: 'call_fallback', name: 'run', arguments: { ok: true } }]
  }, 'responses', 'chat', 'chat-test');
  assert.equal(validResponses.messages[0].tool_calls[0].id, 'call_fallback');
  assert.deepEqual(JSON.parse(validResponses.messages[0].tool_calls[0].function.arguments), { ok: true });

  for (const [body, source, target, message] of [
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [null] }] }, 'chat', 'responses', /tool_calls\[0\] 必须是对象/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'run', arguments: '{}' } }] }] }, 'chat', 'responses', /tool_calls\[0\]\.id 必须是非空字符串/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { arguments: '{}' } }] }] }, 'chat', 'responses', /function\.name 必须是非空字符串/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{bad' } }] }] }, 'chat', 'responses', /function\.arguments 必须是对象/],
    [{ model: 'alias', messages: [{ role: 'tool', content: '完成' }] }, 'chat', 'responses', /tool_call_id 必须是非空字符串/],
    [{ model: 'alias', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}' } }], function_call: { name: 'legacy', arguments: '{}' } }] }, 'chat', 'responses', /不能同时包含 tool_calls.*function_call/],
    [{ model: 'alias', input: [{ type: 'function_call', name: 'run', arguments: '{}' }] }, 'responses', 'chat', /function_call\.call_id\/id 必须是非空字符串/],
    [{ model: 'alias', input: [{ type: 'function_call', call_id: 'call_1', arguments: '{}' }] }, 'responses', 'chat', /function_call\.name 必须是非空字符串/],
    [{ model: 'alias', input: [{ type: 'function_call', call_id: 'call_1', name: 'run', arguments: '0' }] }, 'responses', 'chat', /function_call\.arguments 必须是 JSON 对象/],
    [{ model: 'alias', input: [{ type: 'function_call_output', output: '完成' }] }, 'responses', 'chat', /function_call_output\.call_id 必须是非空字符串/],
    [{ model: 'alias', input: [{ type: 'function_call_output', call_id: 'call_1' }] }, 'responses', 'chat', /function_call_output 缺少 output/],
    [{ model: 'alias', input: [{ type: 'custom_tool_call', name: 'patch', input: 'diff' }] }, 'responses', 'chat', /custom_tool_call\.call_id\/id 必须是非空字符串/],
    [{ model: 'alias', input: [{ type: 'tool_search_output', execution: 'client', tools: [] }] }, 'responses', 'chat', /tool_search_output\.call_id 必须是非空字符串/]
  ]) {
    assert.throws(() => prepareUpstreamRequest(body, source, target, `${target}-test`), (error) => error.status === 400 && message.test(error.message));
  }
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

test('选中的文本模型会在任意目标协议移除图片块', () => {
  const directResponses = prepareUpstreamRequest({
    model: 'alias', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }]
  }, 'responses', 'responses', 'text-responses', { imageHandoffEnabled: true });
  assert.equal(directResponses.input[0].content[0].type, 'input_text');
  assert.match(directResponses.input[0].content[0].text, /https:\/\/example\.com\/a\.png/);
  assert.match(directResponses.input[0].content[0].text, /vision 技能或图片识别工具/);

  const chatToClaude = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/b.png' } }] }]
  }, 'chat', 'claude', 'text-claude', { imageHandoffEnabled: true });
  assert.equal(chatToClaude.messages[0].content[0].type, 'text');
  assert.match(chatToClaude.messages[0].content[0].text, /https:\/\/example\.com\/b\.png/);

  const geminiToResponses = prepareUpstreamRequest({
    model: 'alias', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }]
  }, 'gemini', 'responses', 'text-responses', { imageHandoffEnabled: true });
  assert.deepEqual(geminiToResponses.input[0].content[0], { type: 'input_text', text: '[图片未发送：当前模型不支持图片输入。]' });
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

test('Claude 文本附件可按原始顺序内联到 Chat 消息', () => {
  const chat = prepareUpstreamRequest({
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '附件前' },
      {
        type: 'document', title: 'www.temporary-mail.net.txt', context: '注册邮件',
        source: { type: 'text', media_type: 'text/plain', data: '邮件正文' },
        cache_control: { type: 'ephemeral' }
      },
      { type: 'text', text: '附件后' }
    ] }]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.messages[0].content.length, 3);
  assert.equal(chat.messages[0].content[0].text, '附件前');
  assert.match(chat.messages[0].content[1].text, /www\.temporary-mail\.net\.txt/);
  assert.match(chat.messages[0].content[1].text, /注册邮件/);
  assert.match(chat.messages[0].content[1].text, /邮件正文/);
  assert.deepEqual(chat.messages[0].content[1].cache_control, { type: 'ephemeral' });
  assert.equal(chat.messages[0].content[2].text, '附件后');

  const base64 = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{
      type: 'document', filename: '邮件.txt',
      source: { type: 'base64', media_type: 'text/plain; charset=utf-8', data: Buffer.from('你好 UTF-8').toString('base64') }
    }] }]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.match(base64.messages[0].content[0].text, /你好 UTF-8/);

  const custom = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{
      type: 'document', title: '分块文档', source: { type: 'content', content: [
        { type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }
      ] }
    }] }]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.match(custom.messages[0].content[0].text, /第一段\n第二段/);
});

test('Claude 文本附件拒绝无效编码且非文本文件仍需原生路由', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{
      type: 'document', source: { type: 'base64', media_type: 'text/plain', data: '/w==' }
    }] }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /UTF-8/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{
      type: 'document', source: { type: 'content', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }
    }] }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /全部由文本块/.test(error.message));
});

test('Codex namespace 工具可展开到 Chat 并在响应中还原命名空间', () => {
  const responsesTools = [
    { type: 'function', name: 'shell_command', description: '执行命令', parameters: { type: 'object' } },
    { type: 'namespace', name: 'multi_agent_v1', description: '管理子代理', tools: [
      { type: 'function', name: 'spawn_agent', description: '创建子代理', strict: false, parameters: { type: 'object', properties: { task: { type: 'string' } } } }
    ] },
    { type: 'web_search', external_web_access: true }
  ];
  const chat = prepareUpstreamRequest({
    model: 'alias', instructions: '基础规则', input: [
      { type: 'function_call', call_id: 'old_call', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: '{"task":"旧任务"}' },
      { type: 'function_call_output', call_id: 'old_call', output: '完成' },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ],
    tools: responsesTools,
    tool_choice: { type: 'function', namespace: 'multi_agent_v1', name: 'spawn_agent' }
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['shell_command', 'multi_agent_v1__spawn_agent']);
  assert.match(chat.tools[1].function.description, /Responses namespace: multi_agent_v1/);
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'multi_agent_v1__spawn_agent' } });
  assert.match(chat.messages[0].content, /web_search.*unavailable/);
  assert.equal(chat.messages[1].tool_calls[0].function.name, 'multi_agent_v1__spawn_agent');

  const restored = formatResponse(normalizeResponse({
    id: 'chat_codex', model: 'deepseek-v4-flash',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'multi_agent_v1__spawn_agent', arguments: '{"task":"新任务"}' } }
    ] } }], usage: { prompt_tokens: 3, completion_tokens: 2 }
  }, 'chat'), 'responses', { tools: responsesTools, toolChoice: 'auto', parallelToolCalls: true });
  assert.deepEqual(restored.output[0], {
    id: 'fc_0', type: 'function_call', status: 'completed', call_id: 'call_1',
    namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: '{"task":"新任务"}'
  });
});

test('Responses 托管搜索降级不会强迫模型误调用其他函数', () => {
  const chat = prepareUpstreamRequest({
    model: 'alias', input: '搜索或检查', tool_choice: 'required', tools: [
      { type: 'web_search', external_web_access: true },
      { type: 'function', name: 'inspect', parameters: { type: 'object' } }
    ]
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.tool_choice, 'auto');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['inspect']);
  assert.match(chat.messages[0].content, /web_search.*unavailable/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查', tools: [
      { type: 'function', name: 'inspect', parameters: { type: 'object' } },
      { type: 'function', name: 'inspect', parameters: { type: 'object' } }
    ]
  }, 'responses', 'chat', 'chat-test'), /function tool 名称重复/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查', tools: [{
      type: 'namespace', name: 'tools', tools: [
        { type: 'function', name: 'inspect', parameters: { type: 'object' } },
        { type: 'function', name: 'inspect', parameters: { type: 'object' } }
      ]
    }]
  }, 'responses', 'chat', 'chat-test'), /namespace tools.*名称重复/);
});

test('Responses 程序化工具调用跨协议时只保留可用的 direct 语义', () => {
  const body = {
    model: 'alias', input: '检查库存', tools: [
      {
        type: 'function', name: 'inventory', description: '查询库存',
        parameters: { type: 'object', properties: { sku: { type: 'string' } } },
        output_schema: { type: 'object', properties: { available: { type: 'number' } }, required: ['available'] },
        allowed_callers: ['direct', 'programmatic']
      },
      { type: 'programmatic_tool_calling' }
    ]
  };
  assert.deepEqual(responsesToolAdaptations(body.tools, body.input), [
    'programmatic_tool_calling_disabled', 'output_schema_to_description', 'allowed_callers_direct_only'
  ]);

  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['inventory']);
  assert.match(chat.tools[0].function.description, /Responses output_schema/);
  assert.match(chat.tools[0].function.description, /"available"/);

  const claude = prepareUpstreamRequest(body, 'responses', 'claude', 'claude-test');
  assert.deepEqual(claude.tools.map((tool) => tool.name), ['inventory']);
  assert.match(claude.tools[0].description, /Responses output_schema/);
});

test('Responses 仅程序调用工具和程序历史不会被伪装成普通工具调用', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查库存', tools: [
      { type: 'function', name: 'inventory', parameters: { type: 'object' }, allowed_callers: ['programmatic'] },
      { type: 'programmatic_tool_calling' }
    ]
  }, 'responses', 'chat', 'chat-test'), /仅允许 programmatic.*responses/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查库存', tool_choice: { type: 'programmatic_tool_calling' },
    tools: [{ type: 'programmatic_tool_calling' }]
  }, 'responses', 'claude', 'claude-test'), /强制选择.*programmatic_tool_calling/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查库存',
    tools: [{ type: 'function', name: 'inventory', parameters: {}, allowed_callers: ['direct', 'direct'] }]
  }, 'responses', 'chat', 'chat-test'), /allowed_callers/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '检查库存',
    tools: [{ type: 'function', name: 'inventory', parameters: {}, output_schema: 'object' }]
  }, 'responses', 'chat', 'chat-test'), /output_schema/);

  for (const item of [
    { type: 'program', call_id: 'call_program', code: 'text("ok")', fingerprint: 'opaque' },
    { type: 'program_output', call_id: 'call_program', result: 'ok', status: 'completed' },
    { type: 'function_call', call_id: 'call_nested', name: 'inventory', arguments: '{}', caller: { type: 'program', caller_id: 'call_program' } },
    { type: 'function_call_output', call_id: 'call_nested', output: '{}', caller: { type: 'program', caller_id: 'call_program' } }
  ]) {
    assert.throws(() => prepareUpstreamRequest({
      model: 'alias', input: [item], tools: [{ type: 'function', name: 'inventory', parameters: { type: 'object' } }]
    }, 'responses', 'chat', 'chat-test'), /程序|caller/);
  }
});

test('Responses 程序化字段同协议保持原样透传', () => {
  const body = {
    model: 'alias', store: false,
    input: [
      { type: 'program', call_id: 'call_program', code: 'text("ok")', fingerprint: 'opaque' },
      { type: 'function_call_output', call_id: 'call_nested', output: '{}', caller: { type: 'program', caller_id: 'call_program' } }
    ],
    tools: [
      { type: 'function', name: 'inventory', parameters: { type: 'object' }, output_schema: { type: 'object' }, allowed_callers: ['programmatic'] },
      { type: 'programmatic_tool_calling' }
    ]
  };
  assert.deepEqual(prepareUpstreamRequest(body, 'responses', 'responses', 'gpt-5.6-sol'), { ...body, model: 'gpt-5.6-sol' });
});

test('Responses allowed_tools 跨协议会过滤工具并保留 mode 约束', () => {
  const body = {
    model: 'alias', input: '只执行检查',
    tools: [
      { type: 'function', name: 'inspect', parameters: { type: 'object' } },
      { type: 'function', name: 'remove', parameters: { type: 'object' } },
      { type: 'namespace', name: 'workspace', tools: [
        { type: 'function', name: 'read', parameters: { type: 'object' } },
        { type: 'function', name: 'write', parameters: { type: 'object' } }
      ] }
    ],
    tool_choice: {
      type: 'allowed_tools', mode: 'required', tools: [
        { type: 'function', name: 'inspect' },
        { type: 'function', namespace: 'workspace', name: 'read' }
      ]
    }
  };
  assert.deepEqual(responsesToolAdaptations(body.tools, body.input, body.tool_choice), ['allowed_tools_filtered']);

  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'deepseek-v4-flash');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['inspect', 'workspace__read']);
  assert.equal(chat.tool_choice, 'required');

  const claude = prepareUpstreamRequest(body, 'responses', 'claude', 'claude-test');
  assert.deepEqual(claude.tools.map((tool) => tool.name), ['inspect', 'workspace__read']);
  assert.deepEqual(claude.tool_choice, { type: 'any' });

  const auto = prepareUpstreamRequest({
    ...body, tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'inspect' }] }
  }, 'responses', 'chat', 'chat-test');
  assert.deepEqual(auto.tools.map((tool) => tool.function.name), ['inspect']);
  assert.equal(auto.tool_choice, 'auto');
});

test('Responses allowed_tools 保留完整缓存工具表但不转换未选能力', () => {
  const body = {
    model: 'alias', input: '只执行检查',
    tools: [
      { type: 'function', name: 'inspect', parameters: { type: 'object' } },
      {
        type: 'function', name: 'program_only', parameters: { type: 'object' },
        allowed_callers: ['programmatic']
      },
      { type: 'programmatic_tool_calling' },
      { type: 'image_generation' }
    ],
    tool_choice: {
      type: 'allowed_tools', mode: 'auto',
      tools: [{ type: 'function', name: 'inspect' }]
    }
  };

  assert.deepEqual(responsesToolAdaptations(body.tools, body.input, body.tool_choice), ['allowed_tools_filtered']);
  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'chat-test');
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['inspect']);
  assert.equal(chat.tool_choice, 'auto');

  assert.deepEqual(
    prepareUpstreamRequest(body, 'responses', 'responses', 'gpt-5.6-sol'),
    { ...body, model: 'gpt-5.6-sol' }
  );
});

test('Responses allowed_tools 使用完整工具表分配稳定别名', () => {
  const tools = [
    { type: 'function', name: 'workspace__read', parameters: {} },
    { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: {} }] }
  ];
  const body = {
    model: 'alias', input: '读取', tools,
    tool_choice: {
      type: 'allowed_tools', mode: 'required',
      tools: [{ type: 'function', namespace: 'workspace', name: 'read' }]
    }
  };
  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'chat-test');
  const alias = chat.tools[0].function.name;
  assert.notEqual(alias, 'workspace__read');

  const restored = formatResponse(normalizeResponse({
    id: 'chat_allowed', model: 'chat-test',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_read', type: 'function', function: { name: alias, arguments: '{}' } }
    ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 }
  }, 'chat'), 'responses', { tools, toolChoice: body.tool_choice, parallelToolCalls: true });
  assert.equal(restored.output[0].namespace, 'workspace');
  assert.equal(restored.output[0].name, 'read');
});

test('Responses allowed_tools 大子集使用键集合线性校验可用工具', () => {
  const count = 256;
  const children = Array.from({ length: count }, (_, index) => ({
    type: 'function', name: `tool_${index}`, parameters: { type: 'object' }
  }));
  const selected = children.map((tool) => ({ type: 'function', namespace: 'workspace', name: tool.name }));
  const originalSome = Array.prototype.some;
  let someVisits = 0;
  Array.prototype.some = function instrumentedSome(callback, thisArg) {
    return Reflect.apply(originalSome, this, [function countedCallback(...args) {
      someVisits++;
      return Reflect.apply(callback, thisArg, args);
    }]);
  };
  let chat;
  try {
    chat = prepareUpstreamRequest({
      model: 'alias', input: '执行', tools: [{ type: 'namespace', name: 'workspace', tools: children }],
      tool_choice: { type: 'allowed_tools', mode: 'required', tools: selected }
    }, 'responses', 'chat', 'chat-test');
  } finally {
    Array.prototype.some = originalSome;
  }

  assert.equal(chat.tools.length, count);
  assert.equal(chat.tools[0].function.name, 'workspace__tool_0');
  assert.equal(chat.tools.at(-1).function.name, `workspace__tool_${count - 1}`);
  assert.equal(chat.tool_choice, 'required');
  assert.ok(someVisits <= count * 8, `allowed_tools 不应为每个选择器重复扫描完整工具表：${someVisits}`);
});

test('Responses allowed_tools 严格拒绝无效、未定义和不可执行子集', () => {
  const tools = [{ type: 'function', name: 'inspect', parameters: {} }];
  for (const toolChoice of [
    { type: 'allowed_tools', mode: 'sometimes', tools: [{ type: 'function', name: 'inspect' }] },
    { type: 'allowed_tools', mode: 'auto', tools: [] },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'missing' }] },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'inspect' }, { type: 'function', name: 'inspect' }] }
  ]) {
    assert.throws(() => prepareUpstreamRequest({ model: 'alias', input: '检查', tools, tool_choice: toolChoice }, 'responses', 'chat', 'chat-test'), /allowed_tools/);
  }

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '搜索', tools: [{ type: 'web_search' }],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search_preview' }] }
  }, 'responses', 'chat', 'chat-test'), /要求调用工具.*无法.*非 Responses/);
});

test('Responses namespace 别名处理直接函数冲突、非法字符和长度限制', () => {
  const longNamespace = `mcp.${'very-long-namespace-'.repeat(4)}`;
  const tools = [
    { type: 'function', name: 'tools__inspect', parameters: { type: 'object' } },
    { type: 'namespace', name: 'tools', tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }] },
    { type: 'namespace', name: longNamespace, tools: [{ type: 'function', name: 'run.command', parameters: { type: 'object' } }] }
  ];
  const chat = prepareUpstreamRequest({ model: 'alias', input: '检查', tools }, 'responses', 'chat', 'chat-test');
  const names = chat.tools.map((tool) => tool.function.name);
  assert.equal(names[0], 'tools__inspect');
  assert.equal(names[1], 'tools__inspect__n1t0');
  assert.ok(names[2].length <= 64);
  assert.match(names[2], /^[A-Za-z0-9_-]+$/);

  const restored = formatResponse({
    id: 'chat_collision', model: 'chat-test', inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls',
    parts: [{ type: 'tool_call', id: 'call_2', name: names[2], arguments: { ok: true } }]
  }, 'responses', { tools });
  assert.equal(restored.output[0].namespace, longNamespace);
  assert.equal(restored.output[0].name, 'run.command');

  const ambiguous = formatResponse({
    id: 'chat_ambiguous', model: 'chat-test', inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls',
    parts: [{ type: 'tool_call', id: 'call_raw', name: 'inspect', arguments: {} }]
  }, 'responses', { tools: [
    { type: 'namespace', name: 'first', tools: [{ type: 'function', name: 'inspect', parameters: {} }] },
    { type: 'namespace', name: 'second', tools: [{ type: 'function', name: 'inspect', parameters: {} }] }
  ] });
  assert.equal(ambiguous.output[0].namespace, undefined);
  assert.equal(ambiguous.output[0].name, 'inspect');

  const directWins = formatResponse({
    id: 'chat_direct', model: 'chat-test', inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls',
    parts: [{ type: 'tool_call', id: 'call_direct', name: 'inspect', arguments: {} }]
  }, 'responses', { tools: [
    { type: 'function', name: 'inspect', parameters: {} },
    { type: 'namespace', name: 'tools', tools: [{ type: 'function', name: 'inspect', parameters: {} }] }
  ] });
  assert.equal(directWins.output[0].namespace, undefined);
  assert.equal(directWins.output[0].name, 'inspect');
});

test('Responses 大工具表的非流式别名恢复只构建一次索引', () => {
  const count = 256;
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
  const restored = formatResponse({
    id: 'chat_many_tools', model: 'chat-test', inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls',
    parts: Array.from({ length: count }, (_, index) => ({
      type: 'tool_call', id: `call_${index}`, name: `workspace__tool_${index}`, arguments: { index }
    }))
  }, 'responses', { tools: [namespace] });

  assert.equal(restored.output.length, count);
  assert.deepEqual(restored.output.at(-1), {
    id: `fc_${count - 1}`, type: 'function_call', status: 'completed', call_id: `call_${count - 1}`,
    namespace: 'workspace', name: `tool_${count - 1}`, arguments: `{"index":${count - 1}}`
  });
  assert.ok(namespaceToolReads <= count * 3, `别名索引不应为每个返回调用重建工具表：${namespaceToolReads}`);
});

test('无法无损跨协议的工具和文件会明确拒绝', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '搜索', tools: [{ type: 'file_search' }]
  }, 'responses', 'claude', 'claude-test'), (error) => error.status === 400 && /file_search/.test(error.message));

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] }]
  }, 'claude', 'chat', 'chat-test'), (error) => error.status === 400 && /文件内容块/.test(error.message));

  const passthrough = { model: 'alias', input: '搜索', tools: [{ type: 'web_search', external_web_access: true, filters: { allowed_domains: ['example.com'] } }] };
  assert.deepEqual(prepareUpstreamRequest(passthrough, 'responses', 'responses', 'gpt-test'), { ...passthrough, model: 'gpt-test' });
});

test('Codex custom tool 的自由文本调用可包装为函数并还原', () => {
  const tools = [{
    type: 'custom', name: 'apply_patch', description: '应用补丁',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
  }];
  const chat = prepareUpstreamRequest({
    model: 'alias', tools, input: [
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Done!' }
    ]
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(chat.tools[0].function.name, 'apply_patch');
  assert.equal(chat.tools[0].function.parameters.properties.input.type, 'string');
  assert.match(chat.tools[0].function.description, /Original lark grammar/);
  assert.deepEqual(chat.messages.map((message) => message.role), ['assistant', 'tool']);
  assert.equal(chat.messages[0].tool_calls[0].function.arguments, '{"input":"*** Begin Patch"}');

  const restored = formatResponse({
    id: 'chat_patch', model: 'chat-test', parts: [{ type: 'tool_call', id: 'call_patch_2', name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch' } }],
    inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls'
  }, 'responses', { tools });
  assert.deepEqual(restored.output[0], {
    id: 'ctc_0', type: 'custom_tool_call', status: 'completed', call_id: 'call_patch_2', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch'
  });
});

test('Codex client tool_search 可包装为函数并保留动态加载工具', () => {
  const tools = [
    { type: 'function', name: 'tool_search', parameters: { type: 'object' } },
    { type: 'tool_search', execution: 'client', description: '搜索项目工具', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
  ];
  const loadedTool = { type: 'function', name: 'loaded_tool', description: '动态工具', parameters: { type: 'object' }, defer_loading: true };
  const chat = prepareUpstreamRequest({
    model: 'alias', tools, input: [
      { type: 'tool_search_call', execution: 'client', call_id: 'call_search', arguments: { query: 'files' } },
      { type: 'tool_search_output', execution: 'client', call_id: 'call_search', status: 'completed', tools: [loadedTool] }
    ]
  }, 'responses', 'chat', 'chat-test');
  const searchName = chat.tools[1].function.name;
  assert.notEqual(searchName, 'tool_search');
  assert.match(searchName, /^tool_search__tool_search_/);
  assert.equal(chat.tools[2].function.name, 'loaded_tool');
  assert.equal(chat.messages[0].tool_calls[0].function.name, searchName);
  assert.equal(chat.messages[1].tool_call_id, 'call_search');

  const restored = formatResponse({
    id: 'chat_search', model: 'chat-test', parts: [{ type: 'tool_call', id: 'call_search_2', name: searchName, arguments: { query: 'tests' } }],
    inputTokens: 1, outputTokens: 1, stopReason: 'tool_calls'
  }, 'responses', { tools });
  assert.deepEqual(restored.output[0], {
    id: 'tsc_0', type: 'tool_search_call', status: 'completed', execution: 'client', call_id: 'call_search_2', arguments: { query: 'tests' }
  });

  const hosted = prepareUpstreamRequest({
    model: 'alias', input: '查找', tools: [
      { type: 'function', name: 'deferred', defer_loading: true, parameters: { type: 'object' } },
      { type: 'tool_search' }
    ]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(hosted.tools.map((tool) => tool.name), ['deferred']);
});

test('Codex custom 与 client tool_search 的畸形数据不会被静默伪装', () => {
  assert.throws(() => normalizeRequest({
    input: [{ type: 'custom_tool_call', call_id: 'call_custom', name: 'shell', input: { command: 'dir' } }],
    tools: [{ type: 'custom', name: 'shell' }]
  }, 'responses'), /custom_tool_call\.input 必须是字符串/);
  assert.throws(() => normalizeRequest({
    input: [{ type: 'tool_search_call', execution: 'client', call_id: 'call_search', arguments: 'not-json' }],
    tools: [{ type: 'tool_search', execution: 'client', parameters: { type: 'object' } }]
  }, 'responses'), /tool_search_call\.arguments 必须是对象/);
  assert.throws(() => normalizeRequest({
    input: [{ type: 'tool_search_output', execution: 'client', call_id: 'call_search', tools: null }]
  }, 'responses'), /tool_search_output\.tools 必须是数组/);
  assert.throws(() => normalizeRequest({
    input: 'test', tools: [{ type: 'custom', name: 'shell', format: { type: 'grammar' } }]
  }, 'responses'), /grammar 缺少 definition/);
});

test('未知内容块与服务端工具不会静默转换为空消息', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }]
  }, 'chat', 'claude', 'claude-test'), (error) => error.status === 400 && /input_audio/.test(error.message));

  const opaqueReasoning = prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(opaqueReasoning.messages, []);

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

test('Responses 与 Chat 的会话中途 system 跨协议时保留原始位置', () => {
  const responsesToClaude = prepareUpstreamRequest({
    model: 'alias', instructions: '顶层规则', input: [
      { role: 'developer', content: [{ type: 'input_text', text: '开头规则' }] },
      { role: 'user', content: [{ type: 'input_text', text: '第一问' }] },
      { role: 'developer', content: [{ type: 'input_text', text: '中途规则' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }
    ]
  }, 'responses', 'claude', 'claude-test');
  assert.equal(responsesToClaude.system, '顶层规则\n开头规则');
  assert.deepEqual(responsesToClaude.messages.map((message) => message.role), ['user', 'system', 'assistant']);
  assert.equal(responsesToClaude.messages[1].content[0].text, '中途规则');

  const chatToResponses = prepareUpstreamRequest({
    model: 'alias', messages: [
      { role: 'system', content: '开头规则' },
      { role: 'user', content: '第一问' },
      { role: 'developer', content: '中途规则' },
      { role: 'assistant', content: '回答' }
    ]
  }, 'chat', 'responses', 'gpt-5.6-terra');
  assert.equal('instructions' in chatToResponses, false);
  assert.deepEqual(chatToResponses.input.map((message) => message.role), ['system', 'user', 'developer', 'assistant']);
  assert.equal(chatToResponses.input[0].content[0].text, '开头规则');
  assert.equal(chatToResponses.input[2].content[0].text, '中途规则');
});

test('Responses reasoning summary 转 Claude 时作为历史助手文本保留', () => {
  const output = prepareUpstreamRequest({
    model: 'alias', input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '历史推理摘要' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '内容' }
    ]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(output.messages.map((message) => message.role), ['assistant', 'user']);
  assert.equal(output.messages[0].content[0].type, 'text');
  assert.equal(output.messages[0].content[0].text, '历史推理摘要');
  assert.equal(output.messages[0].content[1].type, 'tool_use');
});

test('跨协议请求拒绝非法角色，Responses 输出消息不会静默丢弃未知内容块', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'function', name: 'legacy', content: '结果' }]
  }, 'chat', 'responses', 'gpt-test'), /Chat messages\[0\].*role：function/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: [{ type: 'message', role: 'tool', content: [{ type: 'input_text', text: '结果' }] }]
  }, 'responses', 'chat', 'chat-test'), /Responses input\[0\].*role：tool/);

  assert.throws(() => normalizeResponse({
    id: 'resp_media', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_audio', audio: 'opaque' }] }]
  }, 'responses', 'alias', { rejectUnknown: true }), /output_audio/);
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
  assert.equal(hasUsageData({ usage: { prompt_tokens: 'not-a-number', completion_tokens: -1 } }), false);
});

test('跨协议 usage 规范为非负安全整数并正确计算总量', () => {
  const normalized = normalizeResponse({
    id: 'chat_usage_bounds', model: 'chat-model',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: '12', completion_tokens: -3,
      cache_read_input_tokens: 1.5, prompt_cache_hit_tokens: '4',
      completion_tokens_details: { reasoning_tokens: 1e100 }
    }
  }, 'chat');
  assert.deepEqual({
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    reasoningTokens: normalized.reasoningTokens
  }, {
    inputTokens: 12,
    outputTokens: 0,
    cachedInputTokens: 4,
    reasoningTokens: Number.MAX_SAFE_INTEGER
  });
  const response = formatResponse(normalized, 'responses');
  assert.equal(response.usage.total_tokens, 12);
  assert.equal(typeof response.usage.total_tokens, 'number');
  const saturated = formatResponse({ ...normalized, inputTokens: 1e100, outputTokens: 1e100 }, 'chat');
  assert.equal(saturated.usage.prompt_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(saturated.usage.completion_tokens, Number.MAX_SAFE_INTEGER);
  assert.equal(saturated.usage.total_tokens, Number.MAX_SAFE_INTEGER);
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
  assert.deepEqual(maximum.reasoning, { effort: 'max' });

  const deepSeekMaximum = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024,
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'chat', 'deepseek-v4-flash');
  assert.equal(deepSeekMaximum.reasoning_effort, 'max');
  assert.equal(requestReasoningEffort(deepSeekMaximum, 'chat'), 'max');
  assert.deepEqual(reasoningRequestAdaptations({
    thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'max' }
  }, 'claude', 'chat', 'deepseek-v4-flash'), []);

  const unsupported = prepareUpstreamRequest({
    model: 'alias', max_tokens: 1024, thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: '分析' }]
  }, 'claude', 'chat', 'deepseek-v4-flash-free');
  assert.equal('reasoning_effort' in unsupported, false);

  const codexMaximum = prepareUpstreamRequest({
    model: 'gpt5.5', reasoning: { effort: 'max', summary: 'auto' }, input: '分析'
  }, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal(codexMaximum.reasoning_effort, 'max');
  assert.equal(requestReasoningEffort(codexMaximum, 'chat'), 'max');
});

test('思考强度日志标签拒绝畸形值并识别 Gemini 动态预算', () => {
  assert.equal(requestReasoningEffort({ reasoning: { effort: ' max ' } }, 'responses'), 'max');
  assert.equal(requestReasoningEffort({ reasoning: { effort: 'max\n伪造日志' } }, 'responses'), undefined);
  assert.equal(requestReasoningEffort({ thinking: { type: 'enabled', budget_tokens: '4096' } }, 'claude'), undefined);
  assert.equal(requestReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 4096 } }, 'claude'), 'budget:4096');
  assert.equal(requestReasoningEffort({ generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }, 'gemini'), 'adaptive');
  assert.equal(requestReasoningEffort({ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, 'gemini'), 'none');
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

test('规范化请求会复用 Claude tool_reference 摘要并避免目标格式化重复预检', () => {
  const count = 512;
  const normalized = normalizeRequest({
    model: 'deepseek-v4-flash', max_tokens: 1024,
    messages: [{
      role: 'user',
      content: Array.from({ length: count }, (_, index) => ({ type: 'text', text: `part-${index};` }))
    }]
  }, 'claude');
  const parts = normalized.messages[0].parts;
  for (const [protocol, maximumPasses] of [['responses', 1], ['gemini', 1], ['chat', 2]]) {
    let partReads = 0;
    normalized.messages[0].parts = new Proxy(parts, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) partReads++;
        return Reflect.get(target, property, receiver);
      }
    });

    const output = formatRequest(normalized, protocol);
    assert.ok(partReads <= count * maximumPasses,
      `${protocol} 格式化读取了 ${partReads} 个内容项，预期最多执行 ${maximumPasses} 次 O(n) 遍历`);
    if (protocol === 'chat') {
      assert.ok(output.messages[0].content.startsWith('part-0;'));
      assert.ok(output.messages[0].content.endsWith(`part-${count - 1};`));
    }
  }
});

test('Claude 大型消息内容规范化只读取两遍并保留缓存与隐藏推理语义', () => {
  const count = 512;
  const content = Array.from({ length: count }, (_, index) => ({
    type: 'text', text: `part-${index}`,
    ...(index === count - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {})
  }));
  let partReads = 0;
  const observedContent = new Proxy(content, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) partReads++;
      return Reflect.get(target, property, receiver);
    }
  });

  const normalized = normalizeRequest({
    model: 'alias', max_tokens: 1024,
    messages: [{ role: 'assistant', content: observedContent }]
  }, 'claude');
  assert.equal(normalized.messages[0].parts.length, count);
  assert.deepEqual(normalized.messages[0].parts.at(-1).cacheControl, { type: 'ephemeral', ttl: '1h' });
  assert.ok(partReads <= count * 2,
    `Claude 内容规范化读取了 ${partReads} 个内容项，预期最多执行两次 O(n) 遍历`);

  const hiddenReasoning = normalizeRequest({
    model: 'alias', max_tokens: 1024,
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque-state' }] }]
  }, 'claude');
  assert.deepEqual(hiddenReasoning.messages[0].parts, []);
});

test('Chat 大型非流式响应只读取两遍内容并保留全部公共字段', () => {
  const count = 512;
  const parts = Array.from({ length: count - 4 }, (_, index) => ({ type: 'text', text: `part-${index};` }));
  parts[0].logprobs = [{ token: 'p', logprob: -0.25, topLogprobs: [{ token: 'p', logprob: -0.25 }] }];
  parts.push(
    { type: 'reasoning', text: '分析过程' },
    {
      type: 'provider_state',
      providerState: { protocol: 'responses', kind: 'reasoning', value: { type: 'reasoning', encrypted_content: 'opaque' } }
    },
    { type: 'refusal', text: '部分拒答' },
    { type: 'tool_call', id: 'call_1', name: 'lookup', arguments: { city: '上海' } }
  );
  let partReads = 0;
  const observedParts = new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) partReads++;
      return Reflect.get(target, property, receiver);
    }
  });

  const output = formatResponse({
    id: 'resp_large', model: 'gpt-test', parts: observedParts,
    inputTokens: 8, outputTokens: 4, stopReason: 'end_turn'
  }, 'chat');
  const message = output.choices[0].message;
  assert.ok(message.content.startsWith('part-0;'));
  assert.ok(message.content.endsWith(`part-${count - 5};`));
  assert.equal(message.reasoning_content, '分析过程');
  assert.equal(message.reasoning_details.length, 1);
  assert.equal(message.refusal, '部分拒答');
  assert.deepEqual(message.tool_calls[0].function, { name: 'lookup', arguments: '{"city":"上海"}' });
  assert.equal(output.choices[0].finish_reason, 'tool_calls');
  assert.equal(output.choices[0].logprobs.content[0].token, 'p');
  assert.ok(partReads <= count * 2,
    `Chat 响应格式化读取了 ${partReads} 个内容项，预期最多执行两次 O(n) 遍历`);
});

test('Gemini 大型非流式响应按需读取两遍或三遍并保留聚合状态', () => {
  const count = 512;
  const parts = Array.from({ length: count - 3 }, (_, index) => ({ type: 'text', text: `part-${index};` }));
  parts[0].logprobs = [{ token: 'p', logprob: -0.25, topLogprobs: [{ token: 'p', logprob: -0.25 }] }];
  parts.push(
    {
      type: 'reasoning', text: '分析过程',
      providerState: {
        protocol: 'claude', kind: 'thinking',
        value: { type: 'thinking', thinking: '分析过程', signature: 'claude-signature' }
      }
    },
    {
      type: 'provider_state',
      providerState: {
        protocol: 'responses', kind: 'reasoning',
        value: { type: 'reasoning', encrypted_content: 'responses-state' }
      }
    },
    { type: 'tool_call', id: 'call_1', name: 'lookup', arguments: { city: '上海' } }
  );
  let plainReads = 0;
  const observedParts = new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) plainReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const output = formatResponse({
    id: 'resp_gemini_large', model: 'gemini-test', parts: observedParts,
    inputTokens: 8, outputTokens: 4, stopReason: 'tool_calls'
  }, 'gemini');
  const toolPart = output.candidates[0].content.parts.find((part) => part.functionCall);
  const state = decodeReasoningState(toolPart.thoughtSignature);
  assert.equal(state.protocol, 'bridge');
  assert.deepEqual(state.value.states.map((entry) => entry.kind), ['thinking', 'reasoning']);
  assert.equal(output.candidates[0].logprobsResult.chosenCandidates[0].token, 'p');
  assert.ok(plainReads <= count * 2,
    `无网页引用的 Gemini 响应读取了 ${plainReads} 个内容项，预期最多执行两次 O(n) 遍历`);

  const citedParts = Array.from({ length: count }, (_, index) => ({ type: 'text', text: `citation-${index}` }));
  citedParts.at(-1).annotations = [{
    type: 'url_citation', start_index: 0, end_index: 8,
    title: '官方资料', url: 'https://example.invalid/source'
  }];
  let citedReads = 0;
  const observedCitedParts = new Proxy(citedParts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) citedReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const cited = formatResponse({
    id: 'resp_gemini_cited', model: 'gemini-test', parts: observedCitedParts,
    inputTokens: 8, outputTokens: 4, stopReason: 'end_turn'
  }, 'gemini');
  assert.equal(cited.candidates[0].groundingMetadata.groundingChunks[0].web.uri, 'https://example.invalid/source');
  assert.ok(citedReads <= count * 3,
    `带网页引用的 Gemini 响应读取了 ${citedReads} 个内容项，预期最多执行三次 O(n) 遍历`);
});

test('Responses 大型 reasoning 输出单遍解析 summary 与 content', () => {
  const count = 512;
  const summary = Array.from({ length: count }, (_, index) => ({
    type: 'summary_text', text: index === count - 1 ? '' : `summary-${index}`
  }));
  const content = Array.from({ length: count }, (_, index) => ({
    type: 'reasoning_text', text: index === count - 1 ? '' : `content-${index}`
  }));
  let summaryReads = 0;
  let contentReads = 0;
  const observedSummary = new Proxy(summary, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) summaryReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const observedContent = new Proxy(content, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) contentReads++;
      return Reflect.get(target, property, receiver);
    }
  });

  const normalized = normalizeResponse({
    id: 'resp_reasoning_large', status: 'completed',
    output: [{
      type: 'reasoning', encrypted_content: 'opaque-state',
      summary: observedSummary, content: observedContent
    }],
    usage: { input_tokens: 8, output_tokens: 4 }
  }, 'responses', 'gpt-test', { rejectUnknown: true });
  assert.equal(normalized.parts.length, count * 2 - 2);
  assert.equal(normalized.parts[0].reasoningKind, 'summary');
  assert.equal(normalized.parts[count - 1].reasoningKind, 'content');
  assert.equal(normalized.parts.filter((part) => part.providerState).length, 1);
  assert.ok(summaryReads <= count,
    `Responses summary 读取了 ${summaryReads} 个内容项，预期最多执行一次 O(n) 遍历`);
  assert.ok(contentReads <= count,
    `Responses content 读取了 ${contentReads} 个内容项，预期最多执行一次 O(n) 遍历`);

  const tolerant = normalizeResponse({
    output: [{
      type: 'reasoning',
      summary: [null, { type: 'vendor_summary', text: '忽略' }, { type: 'summary_text', text: '保留' }],
      content: { type: 'reasoning_text', text: '兼容对象容器' }
    }]
  }, 'responses');
  assert.deepEqual(tolerant.parts.map((part) => part.text), ['保留', '兼容对象容器']);
});

test('Claude 工具适配统计在一次内容遍历中识别延迟引用和失败结果', () => {
  const count = 512;
  const content = Array.from({ length: count - 2 }, (_, index) => ({ type: 'text', text: `part-${index}` }));
  content.push(
    { type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'Read' }] },
    { type: 'tool_result', tool_use_id: 'read_1', content: '失败', is_error: true }
  );
  let partReads = 0;
  const observedContent = new Proxy(content, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) partReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const adaptations = claudeToolAdaptations([
    { name: 'ToolSearch', input_schema: { type: 'object' } },
    { name: 'Read', input_schema: { type: 'object' }, defer_loading: true }
  ], [{ role: 'user', content: observedContent }], false, 'chat');

  assert.deepEqual(adaptations, ['deferred_tools_loaded', 'claude_tool_error_to_content']);
  assert.ok(partReads <= count, `Claude 工具适配统计读取了 ${partReads} 个内容项，预期只遍历一次`);
});

test('大型 Claude 工具表在适配统计和跨协议选择中只读取一次原数组', () => {
  const count = 512;
  const rawTools = Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: `工具 ${index}`,
    input_schema: { type: 'object' },
    ...(index === 0 ? { input_examples: [{ value: 'example' }] } : {}),
    ...(index === 1 ? { allowed_callers: ['direct', 'code_execution_20260120'] } : {}),
    ...(index === 2 ? { eager_input_streaming: true } : {}),
    ...(index === 3 ? { defer_loading: true } : {})
  }));

  let rawReads = 0;
  const observedRawTools = new Proxy(rawTools, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) rawReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.deepEqual(claudeToolAdaptations(observedRawTools, [], true, 'chat'), [
    'deferred_tools_hidden', 'input_examples_to_description',
    'allowed_callers_direct_only', 'eager_input_streaming_best_effort'
  ]);
  assert.ok(rawReads <= count, `Claude 工具适配统计读取了 ${rawReads} 个工具，预期只遍历一次`);

  const normalized = normalizeRequest({
    model: 'alias', max_tokens: 1024, messages: [{ role: 'user', content: '执行任务' }], tools: rawTools
  }, 'claude');
  const normalizedTools = normalized.tools;
  for (const protocol of ['responses', 'gemini', 'chat']) {
    let normalizedReads = 0;
    normalized.tools = new Proxy(normalizedTools, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) normalizedReads++;
        return Reflect.get(target, property, receiver);
      }
    });
    const output = formatRequest(normalized, protocol);
    assert.ok(normalizedReads <= count,
      `${protocol} 工具选择读取了 ${normalizedReads} 个规范化工具，预期只遍历一次`);
    const outputCount = protocol === 'responses' ? output.tools.length
      : protocol === 'gemini' ? output.tools[0].functionDeclarations.length : output.tools.length;
    assert.equal(outputCount, count - 1);
  }
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

  const explicitBody = {
    model: 'alias', max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: '问题', cache_control: { type: 'ephemeral' } }] }]
  };
  const responses = prepareUpstreamRequest(explicitBody, 'claude', 'responses', 'gpt-5.6-terra');
  assert.deepEqual(responses.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(responses.prompt_cache_options, { mode: 'explicit' });
  assert.deepEqual(claudeCacheAdaptations(explicitBody, 'responses', 'gpt-5.6-terra'), [
    'claude_cache_to_responses', 'claude_cache_ttl_to_30m'
  ]);
  const gptChat = prepareUpstreamRequest(explicitBody, 'claude', 'chat', 'gpt-5.6-terra');
  assert.deepEqual(gptChat.prompt_cache_options, { mode: 'explicit' });
  assert.deepEqual(gptChat.messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(claudeCacheAdaptations(explicitBody, 'chat', 'gpt-5.6-terra'), [
    'claude_cache_to_chat', 'claude_cache_ttl_to_30m'
  ]);

  const legacyResponses = prepareUpstreamRequest(explicitBody, 'claude', 'responses', 'gpt-test');
  assert.equal('prompt_cache_breakpoint' in legacyResponses.input[0].content[0], false);
  assert.equal('prompt_cache_options' in legacyResponses, false);
  assert.deepEqual(claudeCacheAdaptations(explicitBody, 'responses', 'gpt-test'), ['claude_cache_control_dropped']);
});

test('Claude 自动缓存转为 GPT-5.6 Responses implicit 模式并标记无法映射的缓存点', () => {
  const body = {
    model: 'alias', max_tokens: 64, cache_control: { type: 'ephemeral', ttl: '1h' },
    system: [{ type: 'text', text: '系统', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '问题', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' }, cache_control: { type: 'ephemeral' } }
      ] },
      { role: 'assistant', content: [{ type: 'text', text: '回答', cache_control: { type: 'ephemeral' } }] }
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]
  };
  const result = prepareUpstreamRequest(body, 'claude', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(result.prompt_cache_options, { mode: 'implicit' });
  assert.deepEqual(result.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(result.input[1].content.map((part) => part.prompt_cache_breakpoint), [
    { mode: 'explicit' }, { mode: 'explicit' }
  ]);
  assert.equal('prompt_cache_breakpoint' in result.input[2].content[0], false);
  assert.deepEqual(claudeCacheAdaptations(body, 'responses', 'gpt-5.6-luna'), [
    'claude_cache_to_responses', 'claude_cache_ttl_to_30m', 'claude_cache_control_dropped'
  ]);
});

test('Claude cache_control 严格校验官方 type 与 ttl', () => {
  const base = { model: 'alias', max_tokens: 64, messages: [{ role: 'user', content: '问题' }] };
  assert.throws(() => prepareUpstreamRequest({ ...base, cache_control: { type: 'persistent' } }, 'claude', 'responses', 'gpt-5.6-terra'), /type 必须是 ephemeral/);
  assert.throws(() => prepareUpstreamRequest({ ...base, cache_control: { type: 'ephemeral', ttl: '30m' } }, 'claude', 'responses', 'gpt-5.6-terra'), /ttl 必须是 5m 或 1h/);
  assert.throws(() => prepareUpstreamRequest({ ...base, cache_control: { type: 'ephemeral', vendor: true } }, 'claude', 'responses', 'gpt-5.6-terra'), /不支持的字段/);
});

test('Responses prompt cache 模式和显式断点可转换为 Claude 缓存控制', () => {
  const body = {
    model: 'alias', max_output_tokens: 64,
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    prompt_cache_key: 'tenant-session', prompt_cache_retention: '24h',
    instructions: [{ role: 'developer', content: [{
      type: 'input_text', text: '缓存系统提示', prompt_cache_breakpoint: { mode: 'explicit' }
    }] }],
    input: [{ type: 'message', role: 'user', content: [{
      type: 'input_text', text: '缓存问题', prompt_cache_breakpoint: { mode: 'explicit' }
    }] }]
  };
  const result = prepareUpstreamRequest(body, 'responses', 'claude', 'claude-upstream');
  assert.deepEqual(result.cache_control, { type: 'ephemeral' });
  assert.deepEqual(result.system, [{ type: 'text', text: '缓存系统提示', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(result.messages[0].content[0], {
    type: 'text', text: '缓存问题', cache_control: { type: 'ephemeral' }
  });
  assert.deepEqual(responsesCacheAdaptations(body, 'claude'), [
    'responses_cache_to_claude', 'responses_cache_ttl_to_5m',
    'responses_cache_key_dropped', 'responses_cache_retention_dropped'
  ]);

  const explicit = prepareUpstreamRequest({
    model: 'alias', prompt_cache_options: { mode: 'explicit' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: '断点', prompt_cache_breakpoint: { mode: 'explicit' } }] }]
  }, 'responses', 'claude', 'claude-upstream');
  assert.equal('cache_control' in explicit, false);
  assert.deepEqual(explicit.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('Responses prompt cache 跨到 Chat 时明确标记丢失并严格校验结构', () => {
  const body = {
    model: 'alias', prompt_cache_options: { mode: 'implicit' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: '问题', prompt_cache_breakpoint: { mode: 'explicit' } }] }]
  };
  const chat = prepareUpstreamRequest(body, 'responses', 'chat', 'deepseek-v4-flash');
  assert.equal('cache_control' in chat.messages[0], false);
  assert.doesNotMatch(JSON.stringify(chat.messages[0]), /cache_control/);
  assert.deepEqual(responsesCacheAdaptations(body, 'chat'), ['responses_cache_control_dropped']);

  const gptBody = {
    ...body, prompt_cache_key: 'shared-prefix',
    input: [{ role: 'user', content: [
      ...body.input[0].content,
      { type: 'input_file', filename: 'context.pdf', file_data: 'data:application/pdf;base64,AAAA', prompt_cache_breakpoint: { mode: 'explicit' } }
    ] }]
  };
  const gptChat = prepareUpstreamRequest(gptBody, 'responses', 'chat', 'gpt-5.6-terra');
  assert.deepEqual(gptChat.prompt_cache_options, { mode: 'implicit' });
  assert.equal(gptChat.prompt_cache_key, 'shared-prefix');
  assert.deepEqual(gptChat.messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(gptChat.messages[0].content[1], {
    type: 'file',
    file: { filename: 'context.pdf', file_data: 'data:application/pdf;base64,AAAA' },
    prompt_cache_breakpoint: { mode: 'explicit' }
  });
  assert.deepEqual(responsesCacheAdaptations(gptBody, 'chat', 'gpt-5.6-terra'), ['responses_cache_to_chat']);

  const base = { model: 'alias', input: [{ role: 'user', content: [{ type: 'input_text', text: '问题' }] }] };
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_options: 'implicit' }, 'responses', 'claude', 'claude-upstream'), /prompt_cache_options 必须是对象/);
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_options: { mode: 'automatic' } }, 'responses', 'claude', 'claude-upstream'), /mode 必须是 implicit 或 explicit/);
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_options: { mode: 'implicit', ttl: '1h' } }, 'responses', 'claude', 'claude-upstream'), /ttl 当前只支持 30m/);
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_key: {} }, 'responses', 'claude', 'claude-upstream'), /prompt_cache_key 必须是非空字符串/);
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_retention: 'forever' }, 'responses', 'claude', 'claude-upstream'), /prompt_cache_retention 必须是 in_memory 或 24h/);
  assert.throws(() => prepareUpstreamRequest({ ...base, input: [{ role: 'user', content: [{ type: 'input_text', text: '问题', prompt_cache_breakpoint: { mode: 'implicit' } }] }] }, 'responses', 'claude', 'claude-upstream'), /mode 必须是 explicit/);
  assert.throws(() => prepareUpstreamRequest({ ...base, input: [{ role: 'assistant', content: [{ type: 'output_text', text: '回答', prompt_cache_breakpoint: { mode: 'explicit' } }] }] }, 'responses', 'claude', 'claude-upstream'), /不受支持的 output_text/);
  assert.deepEqual(responsesCacheAdaptations({ input: [{ type: 'function_call', arguments: { prompt_cache_breakpoint: true } }] }, 'chat', 'gpt-5.6-terra'), []);
});

test('Chat prompt cache 可无损转换到 GPT-5.6 Responses 并降级到 Claude 5m 缓存', () => {
  const body = {
    model: 'alias', prompt_cache_options: { mode: 'implicit', ttl: '30m' }, prompt_cache_key: 'shared-chat-prefix',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '系统规则', prompt_cache_breakpoint: { mode: 'explicit' } }] },
      { role: 'user', content: [
        { type: 'text', text: '问题', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'file', file: { filename: 'context.pdf', file_data: 'data:application/pdf;base64,AAAA' }, prompt_cache_breakpoint: { mode: 'explicit' } }
      ] }
    ]
  };
  const responses = prepareUpstreamRequest(body, 'chat', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
  assert.equal(responses.prompt_cache_key, 'shared-chat-prefix');
  assert.deepEqual(responses.input.map((item) => item.role), ['system', 'user']);
  assert.deepEqual(responses.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(responses.input[1].content.map((part) => part.prompt_cache_breakpoint), [
    { mode: 'explicit' }, { mode: 'explicit' }, { mode: 'explicit' }
  ]);
  assert.deepEqual(chatCacheAdaptations(body, 'responses', 'gpt-5.6-luna'), ['chat_cache_to_responses']);

  const claude = prepareUpstreamRequest(body, 'chat', 'claude', 'claude-upstream');
  assert.deepEqual(claude.cache_control, { type: 'ephemeral' });
  assert.deepEqual(claude.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(claude.messages[0].content.map((part) => part.cache_control), [
    { type: 'ephemeral' }, { type: 'ephemeral' }, { type: 'ephemeral' }
  ]);
  assert.deepEqual(chatCacheAdaptations(body, 'claude', 'claude-upstream'), [
    'chat_cache_to_claude', 'responses_cache_ttl_to_5m', 'responses_cache_key_dropped'
  ]);
});

test('Chat 工具级 cache_control 转 Claude 时保留，转 Responses 时明确标记丢失', () => {
  const body = {
    model: 'alias', messages: [{ role: 'user', content: '执行' }],
    tools: [{
      type: 'function', cache_control: { type: 'ephemeral', ttl: '1h' },
      function: { name: 'run', parameters: { type: 'object' } }
    }]
  };
  const claude = prepareUpstreamRequest(body, 'chat', 'claude', 'claude-test');
  assert.deepEqual(claude.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(chatCacheAdaptations(body, 'claude', 'claude-test'), ['chat_cache_to_claude']);

  const responses = prepareUpstreamRequest(body, 'chat', 'responses', 'gpt-5.6-luna');
  assert.equal('cache_control' in responses.tools[0], false);
  assert.deepEqual(chatCacheAdaptations(body, 'responses', 'gpt-5.6-luna'), ['responses_cache_control_dropped']);
  assert.throws(() => prepareUpstreamRequest({
    ...body, tools: [{ ...body.tools[0], cache_control: { type: 'ephemeral', ttl: '30m' } }]
  }, 'chat', 'claude', 'claude-test'), /ttl 必须是 5m 或 1h/);

  const history = {
    model: 'alias', messages: [
      { role: 'user', content: '执行' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1', type: 'function', cache_control: { type: 'ephemeral', ttl: '1h' },
        function: { name: 'run', arguments: '{}' }
      }] },
      { role: 'tool', tool_call_id: 'call_1', content: '完成' }
    ],
    tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }]
  };
  const historyClaude = prepareUpstreamRequest(history, 'chat', 'claude', 'claude-test');
  assert.deepEqual(historyClaude.messages[1].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(chatCacheAdaptations(history, 'claude', 'claude-test'), ['chat_cache_to_claude']);
  const historyResponses = prepareUpstreamRequest(history, 'chat', 'responses', 'gpt-5.6-luna');
  assert.equal('cache_control' in historyResponses.input.find((item) => item.type === 'function_call'), false);
  assert.deepEqual(chatCacheAdaptations(history, 'responses', 'gpt-5.6-luna'), ['responses_cache_control_dropped']);
});

test('OpenCode Chat 消息级 cache_control 映射到最后一个可缓存内容块', () => {
  const body = {
    model: 'alias', messages: [
      { role: 'system', content: '系统规则', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { role: 'user', content: [{ type: 'text', text: '前缀' }, { type: 'text', text: '问题' }], cache_control: { type: 'ephemeral' } }
    ]
  };

  const claude = prepareUpstreamRequest(body, 'chat', 'claude', 'claude-test');
  assert.deepEqual(claude.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(claude.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(claude.messages[0].content[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(chatCacheAdaptations(body, 'claude', 'claude-test'), ['chat_cache_to_claude']);

  const responses = prepareUpstreamRequest(body, 'chat', 'responses', 'gpt-5.6-luna');
  assert.deepEqual(responses.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(responses.input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.deepEqual(responses.input[1].content[1].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.deepEqual(chatCacheAdaptations(body, 'responses', 'gpt-5.6-luna'), [
    'chat_cache_to_responses', 'claude_cache_ttl_to_30m'
  ]);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '问题', cache_control: { type: 'ephemeral', ttl: '30m' } }]
  }, 'chat', 'claude', 'claude-test'), /ttl 必须是 5m 或 1h/);
});

test('Chat prompt cache 结构在跨协议前严格校验且不误发给旧模型', () => {
  const base = { model: 'alias', messages: [{ role: 'user', content: '问题' }] };
  assert.throws(() => prepareUpstreamRequest({ ...base, prompt_cache_options: { mode: 'auto' } }, 'chat', 'responses', 'gpt-5.6-luna'), /mode 必须是 implicit 或 explicit/);
  assert.throws(() => prepareUpstreamRequest({ ...base, messages: [{ role: 'user', content: [{ type: 'text', text: '问题', prompt_cache_breakpoint: true }] }] }, 'chat', 'responses', 'gpt-5.6-luna'), /必须是对象/);
  assert.throws(() => prepareUpstreamRequest({ ...base, messages: [{ role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '结果', prompt_cache_breakpoint: { mode: 'explicit' } }] }] }, 'chat', 'claude', 'claude-upstream'), /暂不支持 Chat tool/);

  const oldTarget = prepareUpstreamRequest({
    ...base, prompt_cache_options: { mode: 'implicit' }, prompt_cache_key: 'shared',
    messages: [{ role: 'user', content: [{ type: 'text', text: '问题', prompt_cache_breakpoint: { mode: 'explicit' } }] }]
  }, 'chat', 'responses', 'gpt-test');
  assert.equal('prompt_cache_options' in oldTarget, false);
  assert.equal('prompt_cache_key' in oldTarget, false);
  assert.doesNotMatch(JSON.stringify(oldTarget.input), /prompt_cache_breakpoint/);

  const assistantBreakpoint = {
    model: 'alias', messages: [{ role: 'assistant', content: [{
      type: 'refusal', refusal: '不能执行', prompt_cache_breakpoint: { mode: 'explicit' }
    }] }]
  };
  const assistantResponses = prepareUpstreamRequest(assistantBreakpoint, 'chat', 'responses', 'gpt-5.6-terra');
  assert.doesNotMatch(JSON.stringify(assistantResponses.input), /prompt_cache_breakpoint/);
  assert.deepEqual(chatCacheAdaptations(assistantBreakpoint, 'responses', 'gpt-5.6-terra'), ['responses_cache_control_dropped']);
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
  assert.equal(normalized.parts[0].type, 'refusal');
  assert.equal(result.content[0].text, '无法协助');
  assert.equal(result.stop_reason, 'refusal');
  assert.equal(result.usage.input_tokens, 9);
  assert.equal(result.usage.output_tokens, 2);
  assert.equal(result.usage.cache_read_input_tokens, 4);
  assert.equal(result.usage.cache_creation_input_tokens, 3);
  assert.equal(normalized.reasoningTokens, 1);
});

test('Claude 新版响应元数据会精确标记跨协议降级并保留缓存 TTL usage', () => {
  const source = {
    id: 'msg_metadata', type: 'message', role: 'assistant', model: 'claude-test',
    content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', stop_sequence: null,
    container: { id: 'container_1' },
    context_management: { applied_edits: [{ type: 'clear_thinking_20251015' }] },
    diagnostics: { cache: { status: 'miss' } },
    stop_details: { type: 'refusal', category: 'general_harms' },
    usage: {
      input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 2 },
      fallback_credit: { status: 'not_eligible' }, inference_geo: 'us',
      iterations: [{ type: 'message', input_tokens: 12, output_tokens: 3 }],
      server_tool_use: { web_search_requests: 1 }, service_tier: 'priority'
    }
  };
  assert.deepEqual(responseMetadataDegradations(source, 'claude', 'responses'), [
    'claude_container', 'claude_context_management', 'claude_diagnostics', 'claude_stop_details',
    'claude_cache_creation_ttl', 'claude_fallback_credit', 'claude_inference_geo',
    'claude_iterations', 'claude_server_tool_use', 'claude_usage_service_tier'
  ]);
  assert.deepEqual(responseMetadataDegradations(source, 'claude', 'claude'), []);
  assert.deepEqual(responseMetadataDegradations(source, 'chat', 'responses'), []);
  const normalized = normalizeResponse(source, 'claude');
  assert.equal(normalized.cacheCreationInputTokens, 7);
  assert.equal(normalized.cacheCreation5mInputTokens, 5);
  assert.equal(normalized.cacheCreation1hInputTokens, 2);
  assert.equal(hasUsageData({ usage: { cache_creation: { ephemeral_5m_input_tokens: 1 } } }), true);

  assert.deepEqual(responseMetadataDegradations({
    type: 'message_delta', context_management: { applied_edits: [] },
    delta: { stop_reason: 'end_turn', container: { id: 'container_2' }, stop_details: { type: 'refusal' } },
    usage: { output_tokens: 3, iterations: [], server_tool_use: {} }
  }, 'claude', 'chat'), [
    'claude_container', 'claude_context_management', 'claude_stop_details', 'claude_iterations', 'claude_server_tool_use'
  ]);
});

test('Responses 返回的有效 reasoning context 在跨协议时不会静默消失', () => {
  assert.deepEqual(responseMetadataDegradations({
    id: 'resp_context', reasoning: { effort: 'medium', context: 'all_turns' }
  }, 'responses', 'claude'), ['responses_reasoning_context']);
  assert.deepEqual(responseMetadataDegradations({
    type: 'response.completed', response: { reasoning: { context: 'current_turn' } }
  }, 'responses', 'chat'), ['responses_reasoning_context']);
  assert.deepEqual(responseMetadataDegradations({
    id: 'resp_context', reasoning: { context: 'all_turns' }
  }, 'responses', 'responses'), []);
});

test('Responses output_text annotations 在跨协议时保留为可读来源', () => {
  const annotations = [
    { type: 'url_citation', start_index: 0, end_index: 2, title: '官方资料', url: 'https://example.invalid/source' },
    { type: 'file_citation', index: 0, file_id: 'file_123', filename: 'report.txt' }
  ];
  const normalized = normalizeResponse({
    id: 'resp_citations', model: 'gpt', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations }] }],
    usage: { input_tokens: 1, output_tokens: 2 }
  }, 'responses');
  assert.deepEqual(normalized.parts[0].annotations, annotations);
  assert.deepEqual(formatResponse(normalized, 'responses').output[0].content[0].annotations, annotations);

  const chatText = formatResponse(normalized, 'chat').choices[0].message.content;
  assert.match(chatText, /答案\n\nSources:/);
  assert.match(chatText, /官方资料 — https:\/\/example\.invalid\/source/);
  assert.match(chatText, /report\.txt \(file_id: file_123\)/);
  assert.match(formatResponse(normalized, 'claude').content[0].text, /https:\/\/example\.invalid\/source/);
  const gemini = formatResponse(normalized, 'gemini');
  assert.match(gemini.candidates[0].content.parts[0].text, /file_123/);
  assert.doesNotMatch(gemini.candidates[0].content.parts[0].text, /example\.invalid\/source/);
  assert.deepEqual(gemini.candidates[0].groundingMetadata, {
    groundingChunks: [{ web: { uri: 'https://example.invalid/source', title: '官方资料' } }],
    groundingSupports: [{
      segment: { partIndex: 0, startIndex: 0, endIndex: 2, text: '答案' },
      groundingChunkIndices: [0]
    }]
  });

  const history = prepareUpstreamRequest({
    model: 'alias', input: [
      { role: 'assistant', content: [{ type: 'output_text', text: '旧答案', annotations }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ]
  }, 'responses', 'chat', 'chat-upstream');
  assert.match(history.messages[0].content, /旧答案\n\nSources:/);
  assert.throws(() => normalizeResponse({
    id: 'resp_bad_citation', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '答案', annotations: [{ type: 'unknown_citation' }] }] }]
  }, 'responses'), /不支持的类型：unknown_citation/);
  assert.throws(() => formatResponse({ ...normalized, parts: [{ ...normalized.parts[0], annotations: [{
    type: 'url_citation', start_index: 0, end_index: 3, title: '越界', url: 'https://example.invalid/out-of-range'
  }] }] }, 'gemini'), /文本索引超出/);
});

test('拒答内容在 Responses、Chat、Claude 与 Gemini 间保留独立终止语义', () => {
  const normalized = normalizeResponse({
    id: 'resp_refusal', model: 'gpt', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '无法协助' }] }],
    usage: { input_tokens: 2, output_tokens: 2 }
  }, 'responses');

  const responses = formatResponse(normalized, 'responses');
  assert.equal(responses.status, 'completed');
  assert.equal(responses.output[0].status, 'completed');
  assert.deepEqual(responses.output[0].content, [{ type: 'refusal', refusal: '无法协助' }]);

  const chat = formatResponse(normalized, 'chat');
  assert.equal(chat.choices[0].message.content, null);
  assert.equal(chat.choices[0].message.refusal, '无法协助');
  assert.equal(chat.choices[0].finish_reason, 'stop');

  const claude = formatResponse(normalized, 'claude');
  assert.deepEqual(claude.content, [{ type: 'text', text: '无法协助' }]);
  assert.equal(claude.stop_reason, 'refusal');
  assert.equal(formatResponse(normalized, 'gemini').candidates[0].finishReason, 'SAFETY');

  const fromClaude = normalizeResponse({
    id: 'msg_refusal', model: 'claude', content: [{ type: 'text', text: '不能回答' }],
    stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 1 }
  }, 'claude');
  assert.deepEqual(fromClaude.parts, [{ type: 'refusal', text: '不能回答' }]);
  assert.equal(formatResponse(fromClaude, 'responses').status, 'completed');
});

test('历史 assistant refusal 在 Chat 与 Responses 请求互转时不会混入普通文本', () => {
  const toResponses = prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'assistant', content: null, refusal: '拒答历史' }, { role: 'user', content: '换个问题' }]
  }, 'chat', 'responses', 'gpt-5.6-terra');
  assert.deepEqual(toResponses.input[0], {
    role: 'assistant', content: [{ type: 'refusal', refusal: '拒答历史' }]
  });

  const toChat = prepareUpstreamRequest({
    model: 'alias', input: [
      { role: 'assistant', content: [{ type: 'refusal', refusal: '拒答历史' }] },
      { role: 'user', content: [{ type: 'input_text', text: '换个问题' }] }
    ]
  }, 'responses', 'chat', 'chat-upstream');
  assert.equal(toChat.messages[0].content, null);
  assert.equal(toChat.messages[0].refusal, '拒答历史');
});

test('停止原因转换为目标协议的合法枚举', () => {
  const base = { id: 'x', model: 'm', parts: [{ type: 'text', text: 'a' }], inputTokens: 1, outputTokens: 1 };
  assert.equal(formatResponse({ ...base, stopReason: 'length' }, 'claude').stop_reason, 'max_tokens');
  assert.equal(formatResponse({ ...base, stopReason: 'model_context_window_exceeded' }, 'claude').stop_reason, 'model_context_window_exceeded');
  assert.equal(formatResponse({ ...base, stopReason: 'end_turn' }, 'chat').choices[0].finish_reason, 'stop');
  assert.equal(formatResponse({ ...base, parts: [{ type: 'tool_call', id: 'c', name: 'f', arguments: {} }] }, 'chat').choices[0].finish_reason, 'tool_calls');

  const truncatedTool = { ...base, stopReason: 'length', parts: [{ type: 'tool_call', id: 'c', name: 'f', arguments: {} }] };
  assert.equal(formatResponse(truncatedTool, 'chat').choices[0].finish_reason, 'length');
  assert.equal(formatResponse(truncatedTool, 'claude').stop_reason, 'max_tokens');
  assert.equal(formatResponse(truncatedTool, 'responses').output[0].status, 'incomplete');

  const responses = formatResponse({ ...base, stopReason: 'max_tokens' }, 'responses');
  assert.equal(responses.status, 'incomplete');
  assert.equal(responses.incomplete_details.reason, 'max_output_tokens');
  assert.equal(responses.completed_at, null);
});

test('内容过滤终止不会被跨协议伪装成正常完成', () => {
  const normalized = normalizeResponse({
    id: 'resp_filtered', model: 'gpt-test', status: 'incomplete',
    incomplete_details: { reason: 'content_filter' }, output: [], usage: { input_tokens: 2, output_tokens: 0 }
  }, 'responses');
  assert.equal(normalized.stopReason, 'content_filter');
  assert.equal(formatResponse(normalized, 'chat').choices[0].finish_reason, 'content_filter');
  assert.equal(formatResponse(normalized, 'claude').stop_reason, 'refusal');
  assert.equal(formatResponse(normalized, 'gemini').candidates[0].finishReason, 'SAFETY');
  const responses = formatResponse(normalized, 'responses');
  assert.equal(responses.status, 'incomplete');
  assert.deepEqual(responses.incomplete_details, { reason: 'content_filter' });
  assert.equal(responses.completed_at, null);
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
  assert.equal(response.temperature, 1);
  assert.equal(response.top_p, 1);
});

test('转换到 Responses 保留客户端的工具和并行设置', () => {
  const tools = [{ type: 'function', name: 'lookup', description: '查找信息', parameters: { type: 'object' } }];
  const response = formatResponse({ id: 'resp_tools', model: 'gpt-test', parts: [], inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0, stopReason: 'end_turn' }, 'responses', {
    parallelToolCalls: false,
    toolChoice: { type: 'function', name: 'lookup' },
    tools,
    instructions: '遵循项目规则',
    metadata: { request: 'integration' },
    temperature: 0.4,
    topP: 0.8,
    maxOutputTokens: 128,
    reasoning: { effort: 'high', summary: 'auto' },
    store: false,
    text: { format: { type: 'text' }, verbosity: 'low' },
    truncation: 'disabled',
    user: 'legacy-user',
    safetyIdentifier: 'safe-user'
  });
  assert.equal(response.parallel_tool_calls, false);
  assert.deepEqual(response.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(response.tools, tools);
  assert.equal(response.error, null);
  assert.equal(response.incomplete_details, null);
  assert.equal(response.instructions, '遵循项目规则');
  assert.deepEqual(response.metadata, { request: 'integration' });
  assert.equal(response.temperature, 0.4);
  assert.equal(response.top_p, 0.8);
  assert.equal(response.max_output_tokens, 128);
  assert.deepEqual(response.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(response.text, { format: { type: 'text' }, verbosity: 'low' });
  assert.equal(response.truncation, 'disabled');
  assert.equal(response.user, 'legacy-user');
  assert.equal(response.safety_identifier, 'safe-user');
  assert.ok(Number.isSafeInteger(response.completed_at));
  assert.ok(response.completed_at >= response.created_at);
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

test('跨协议布尔控制字段拒绝字符串和数字而不改变语义', () => {
  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }],
    tools: [{ name: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: 'false' }
  }, 'claude', 'responses', 'gpt-test'), /Claude tool_choice\.disable_parallel_tool_use 必须是布尔值/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', input: '执行', parallel_tool_calls: 1,
    tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }]
  }, 'responses', 'claude', 'claude-test'), /Responses parallel_tool_calls 必须是布尔值/);

  assert.throws(() => prepareUpstreamRequest({
    model: 'alias', messages: [{ role: 'user', content: '执行' }], parallel_tool_calls: 'true',
    tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }]
  }, 'chat', 'responses', 'gpt-test'), /Chat parallel_tool_calls 必须是布尔值/);
});

test('OpenAI logprobs 跨协议转换严格校验开关和数量', () => {
  const chat = { model: 'alias', messages: [{ role: 'user', content: '回答' }] };
  const responses = { model: 'alias', input: '回答' };
  assert.throws(() => prepareUpstreamRequest({ ...chat, logprobs: 'false' }, 'chat', 'responses', 'gpt-test'), /Chat logprobs 必须是布尔值/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, top_logprobs: 3 }, 'chat', 'responses', 'gpt-test'), /top_logprobs.*logprobs=true/);
  assert.throws(() => prepareUpstreamRequest({ ...chat, logprobs: true, top_logprobs: 21 }, 'chat', 'responses', 'gpt-test'), /Chat top_logprobs/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, top_logprobs: '3' }, 'responses', 'chat', 'chat-test'), /Responses top_logprobs/);
  assert.throws(() => prepareUpstreamRequest({ ...responses, top_logprobs: -1 }, 'responses', 'chat', 'chat-test'), /Responses top_logprobs/);

  const output = prepareUpstreamRequest({ ...chat, logprobs: true, top_logprobs: 4 }, 'chat', 'responses', 'gpt-test');
  assert.equal(output.top_logprobs, 4);
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

  assert.throws(() => prepareUpstreamRequest({
    ...source, tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' }, strict: 'true' } }]
  }, 'chat', 'responses', 'gpt-test'), /Chat tools\[0\]\.function\.strict 必须是布尔值/);
  assert.throws(() => prepareUpstreamRequest({
    model: 'x', input: '执行', tools: [{ type: 'function', name: 'run', parameters: { type: 'object' }, strict: 1 }]
  }, 'responses', 'chat', 'chat-test'), /Responses tools\[0\]\.strict 必须是布尔值/);
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

test('Responses 非流式多段 summary 与 reasoning_text 分别保留并可按原类型重编码', () => {
  const source = {
    id: 'resp_reasoning_parts', model: 'gpt-test', status: 'completed',
    output: [{
      id: 'rs_parts', type: 'reasoning', encrypted_content: 'encrypted-state',
      summary: [{ type: 'summary_text', text: '摘要一' }, { type: 'summary_text', text: '摘要二' }],
      content: [{ type: 'reasoning_text', text: '内容一' }, { type: 'reasoning_text', text: '内容二' }]
    }],
    usage: { input_tokens: 2, output_tokens: 4 }
  };
  const normalized = normalizeResponse(source, 'responses');
  assert.deepEqual(normalized.parts.map((part) => [part.reasoningKind, part.text]), [
    ['summary', '摘要一'], ['summary', '摘要二'], ['content', '内容一'], ['content', '内容二']
  ]);
  assert.equal(normalized.parts.filter((part) => part.providerState).length, 1);

  const responses = formatResponse(normalized, 'responses');
  assert.deepEqual(responses.output.map((item) => item.summary?.[0]?.text), ['摘要一', '摘要二', undefined, undefined]);
  assert.deepEqual(responses.output.map((item) => item.content?.[0]?.text), [undefined, undefined, '内容一', '内容二']);
  assert.equal(responses.output.filter((item) => item.encrypted_content).length, 1);

  const hiddenOnly = normalizeResponse({
    id: 'resp_hidden_only', status: 'completed',
    output: [{ id: 'rs_hidden', type: 'reasoning', summary: [{ type: 'summary_text', text: '' }], encrypted_content: 'hidden-state' }],
    usage: { input_tokens: 1, output_tokens: 1 }
  }, 'responses');
  assert.deepEqual(hiddenOnly.parts.map((part) => part.type), ['provider_state']);
});

test('Responses compaction 跨 Claude 与 Chat 客户端可逆回放且不暴露密文', () => {
  const compaction = {
    type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-responses-compaction', created_by: 'server'
  };
  const source = {
    id: 'resp_compaction', object: 'response', model: 'gpt-test', status: 'completed',
    output: [compaction], usage: { input_tokens: 120000, output_tokens: 0 }
  };
  const normalized = normalizeResponse(source, 'responses', 'gpt-test', { rejectUnknown: true });
  assert.equal(normalized.parts[0].type, 'provider_state');
  assert.equal(normalized.parts[0].providerState.kind, 'compaction');
  assert.deepEqual(formatResponse(normalized, 'responses').output, [compaction]);

  const claudeClient = formatResponse(normalized, 'claude');
  assert.equal(claudeClient.content[0].type, 'redacted_thinking');
  assert.doesNotMatch(JSON.stringify(claudeClient), /opaque-responses-compaction/);
  const claudeReplay = prepareUpstreamRequest({
    model: 'alias', max_tokens: 128,
    messages: [
      { role: 'assistant', content: claudeClient.content },
      { role: 'user', content: '继续任务' }
    ]
  }, 'claude', 'responses', 'gpt-test');
  assert.deepEqual(claudeReplay.input[0], compaction);
  assert.equal(claudeReplay.input[1].content[0].text, '继续任务');

  const chatClient = formatResponse(normalized, 'chat');
  assert.equal(chatClient.choices[0].message.reasoning_details[0].type, 'reasoning.encrypted');
  assert.doesNotMatch(JSON.stringify(chatClient), /opaque-responses-compaction/);
  const chatReplay = prepareUpstreamRequest({
    model: 'alias', messages: [
      chatClient.choices[0].message,
      { role: 'user', content: '继续任务' }
    ]
  }, 'chat', 'responses', 'gpt-test');
  assert.deepEqual(chatReplay.input[0], compaction);

  assert.deepEqual(inputRequestDegradations({ model: 'alias', input: [compaction] }, 'responses', 'claude'), [
    'responses_item_metadata', 'responses_compaction_state'
  ]);
  assert.throws(() => normalizeResponse({ ...source, output: [{ ...compaction, status: 'completed' }] }, 'responses', 'gpt-test', { rejectUnknown: true }), /包含不支持的字段：status/);
  assert.throws(() => normalizeRequest({ model: 'alias', input: [{ ...compaction, encrypted_content: '' }] }, 'responses'), /encrypted_content 必须是非空字符串/);
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
  assert.equal(typeof output.output[0].encrypted_content, 'string');
  assert.equal(output.usage.input_tokens_details.cached_tokens, 2);
  assert.equal(output.parallel_tool_calls, true);
  assert.equal(output.tool_choice, 'auto');
  assert.deepEqual(output.tools, []);
});

test('Claude fallback 边界跨 Responses 客户端续轮后可原位恢复', () => {
  const fallback = { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } };
  const source = {
    id: 'msg_fallback', model: 'claude-opus-4-8', stop_reason: 'end_turn',
    content: [fallback, { type: 'text', text: '回退后的答案' }],
    usage: { input_tokens: 5, output_tokens: 3 }
  };
  const normalized = normalizeResponse(source, 'claude');
  assert.equal(normalized.parts[0].type, 'provider_state');
  assert.equal(normalized.parts[0].providerState.kind, 'fallback');

  const clientResponse = formatResponse(normalized, 'responses');
  const replay = prepareUpstreamRequest({
    model: 'alias', input: [
      ...clientResponse.output,
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ]
  }, 'responses', 'claude', 'claude-opus-4-8');
  assert.deepEqual(replay.messages[0].content[0], fallback);
  assert.equal(replay.messages[0].content[1].text, '回退后的答案');
});

test('Claude compaction 摘要与不透明状态跨 Responses 续轮后逐字恢复', () => {
  const compaction = { type: 'compaction', content: '压缩后的会话摘要', encrypted_content: 'opaque-compaction-state' };
  const source = {
    id: 'msg_compaction', model: 'claude-test', stop_reason: 'compaction',
    content: [compaction], usage: { input_tokens: 120000, output_tokens: 800 }
  };
  const normalized = normalizeResponse(source, 'claude', 'claude-test', { rejectUnknown: true });
  assert.equal(normalized.parts[0].type, 'reasoning');
  assert.equal(normalized.parts[0].text, compaction.content);
  assert.equal(normalized.parts[0].providerState.kind, 'compaction');

  const clientResponse = formatResponse(normalized, 'responses');
  assert.equal(clientResponse.status, 'incomplete');
  assert.equal(clientResponse.output[0].summary[0].text, compaction.content);
  assert.equal(typeof clientResponse.output[0].encrypted_content, 'string');
  const replay = prepareUpstreamRequest({
    model: 'alias', input: [
      ...clientResponse.output,
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] }
    ]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(replay.messages[0].content[0], compaction);
  assert.equal(replay.messages[1].content[0].text, '继续任务');

  const requestCompaction = { ...compaction, cache_control: { type: 'ephemeral', ttl: '1h' } };
  const responsesRequest = prepareUpstreamRequest({
    model: 'alias', max_tokens: 256,
    messages: [{ role: 'assistant', content: [requestCompaction] }, { role: 'user', content: '继续' }]
  }, 'claude', 'responses', 'gpt-test');
  assert.equal(responsesRequest.input[0].content[0].text, compaction.content);
  assert.deepEqual(inputRequestDegradations({
    model: 'alias', messages: [{ role: 'assistant', content: [requestCompaction] }]
  }, 'claude', 'responses'), ['claude_compaction_encrypted_content']);

  assert.throws(() => normalizeResponse({ ...source, content: [{ type: 'compaction', content: '摘要' }] }, 'claude', 'claude-test', { rejectUnknown: true }), /必须同时包含 content 与 encrypted_content/);
  assert.throws(() => normalizeRequest({ model: 'alias', messages: [{ role: 'assistant', content: [{ type: 'compaction', content: '', encrypted_content: null }] }] }, 'claude'), /content 必须是非空字符串或 null/);
});

test('Claude 签名与隐藏思考经 Responses 客户端工具循环后可逐字还原', () => {
  const source = {
    id: 'msg_reasoning_tool', model: 'claude-test', stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '先检查文件', signature: 'claude-signature' },
      { type: 'redacted_thinking', data: 'claude-redacted-data' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'README.md' } }
    ],
    usage: { input_tokens: 6, output_tokens: 4 }
  };
  const clientResponse = formatResponse(normalizeResponse(source, 'claude'), 'responses');
  const replay = prepareUpstreamRequest({
    model: 'alias', input: [
      ...clientResponse.output,
      { type: 'function_call_output', call_id: 'call_1', output: '内容' }
    ],
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }]
  }, 'responses', 'claude', 'claude-test');
  assert.deepEqual(replay.messages[0].content.slice(0, 3), source.content);
  assert.equal(replay.messages[1].content[0].type, 'tool_result');
  assert.deepEqual(reasoningRequestAdaptations({ model: 'alias', input: clientResponse.output }, 'responses', 'claude', 'claude-test'), []);
});

test('Responses encrypted_content 经 Claude 客户端工具循环后可逐字还原', () => {
  const source = {
    id: 'resp_encrypted_tool', model: 'gpt-test', status: 'completed',
    output: [
      { id: 'rs_original', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: '先检查文件' }], encrypted_content: 'responses-encrypted-state' },
      { id: 'fc_original', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'read', arguments: '{"path":"README.md"}' }
    ],
    usage: { input_tokens: 6, output_tokens: 4 }
  };
  const clientResponse = formatResponse(normalizeResponse(source, 'responses'), 'claude');
  assert.deepEqual(clientResponse.content.map((part) => part.type), ['thinking', 'tool_use']);
  const replay = prepareUpstreamRequest({
    model: 'alias', max_tokens: 256,
    messages: [
      { role: 'assistant', content: clientResponse.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '内容' }] }
    ],
    tools: [{ name: 'read', input_schema: { type: 'object' } }]
  }, 'claude', 'responses', 'gpt-test');
  const reasoning = replay.input.find((item) => item.type === 'reasoning');
  assert.equal(reasoning.id, 'rs_original');
  assert.equal(reasoning.encrypted_content, 'responses-encrypted-state');
  assert.deepEqual(inputRequestDegradations({ messages: [{ role: 'assistant', content: clientResponse.content }] }, 'claude', 'responses'), []);
  assert.deepEqual(reasoningRequestAdaptations({ messages: [{ role: 'assistant', content: clientResponse.content }] }, 'claude', 'responses', 'gpt-test'), []);
});

test('Claude omitted thinking 不生成伪摘要并以加密状态保留 thinking token', () => {
  const normalized = normalizeResponse({
    id: 'msg_omitted', model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: '直接答案' }],
    usage: { input_tokens: 8, output_tokens: 14, output_tokens_details: { thinking_tokens: 9 } }
  }, 'claude');
  assert.deepEqual(normalized.parts.map((part) => part.type), ['provider_state', 'text']);
  assert.equal(normalized.parts[0].providerState.value.signature, 'signed');
  assert.equal(normalized.reasoningTokens, 9);
  const responses = formatResponse(normalized, 'responses');
  assert.deepEqual(responses.output.map((item) => item.type), ['reasoning', 'message']);
  assert.deepEqual(responses.output[0].summary, []);
  assert.equal(typeof responses.output[0].encrypted_content, 'string');
  assert.equal(responses.usage.output_tokens_details.reasoning_tokens, 9);
  const claude = formatResponse({ ...normalized, parts: [{ type: 'text', text: '答案' }] }, 'claude');
  assert.deepEqual(claude.usage.output_tokens_details, { thinking_tokens: 9 });
});
