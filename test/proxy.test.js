import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';

const SLOW_RESPONSE_DELAY_MS = 5_000;

function nestedObject(depth) {
  let value = null;
  for (let index = 0; index < depth; index++) value = { value };
  return value;
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('Claude 请求经本地桥接转换为 Responses 并转换响应', { timeout: 15_000 }, async () => {
  let captured;
  let streamFinished = false;
  let upstreamRequestCount = 0;
  const rawVendorResponse = [
    '',
    '{',
    '  "id": "resp_vendor", "model": "responses-vendor", "status": "completed",',
    '  "output": [{"type":"custom_tool_call","call_id":"custom_1","name":"shell","input":"dir"}],',
    '  "usage": {"input_tokens":3,"output_tokens":1}, "vendor_extension": {"preserved":true}',
    '}',
    ''
  ].join('\n');
  const upstream = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      captured = { path: req.url, authorization: req.headers.authorization };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
    }
    upstreamRequestCount += 1;
    const current = { path: req.url, authorization: req.headers.authorization, anthropicBeta: req.headers['anthropic-beta'], anthropicVersion: req.headers['anthropic-version'], openaiBeta: req.headers['openai-beta'], body: await requestBody(req) };
    captured = current;
    if (current.body.model === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (JSON.stringify(current.body.input).includes('UTF-8')) {
        return res.end(Buffer.from([0x7b, 0x22, 0x6f, 0x75, 0x74, 0x70, 0x75, 0x74, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
      }
      return res.end('{broken');
    }
    if (current.body.model === 'bad-shape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (current.body.model === 'bad-output-item') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_bad_output', model: current.body.model, status: 'completed', output: [null],
        usage: { input_tokens: 1, output_tokens: 0 }
      }));
    }
    if (current.body.model === 'complex-json-response') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_complex', model: current.body.model, status: 'completed', output: [],
        usage: { input_tokens: 1, output_tokens: 0 }, vendor_extension: nestedObject(257)
      }));
    }
    if (current.body.model === 'no-usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_no_usage', model: current.body.model, status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '无用量字段' }] }], usage: {}
      }));
    }
    if (current.body.model === 'filtered-response') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_filtered', model: current.body.model, status: 'incomplete',
        incomplete_details: { reason: 'content_filter' }, output: [],
        usage: { input_tokens: 2, output_tokens: 0 }
      }));
    }
    if (current.body.model === 'refusal-response') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_refusal', model: current.body.model, status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: '无法协助' }] }],
        usage: { input_tokens: 2, output_tokens: 2 }
      }));
    }
    if (current.body.model === 'gemini-tool-alias-response') {
      const name = current.body.tools?.[0]?.name;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_gemini_tool_alias', model: current.body.model, status: 'completed',
        output: [{ id: 'fc_alias', type: 'function_call', status: 'completed', call_id: 'call_alias', name, arguments: '{"value":1}' }],
        usage: { input_tokens: 3, output_tokens: 2 }
      }));
    }
    if (current.body.model === 'gemini-search-response') {
      const annotation = { type: 'url_citation', start_index: 0, end_index: 2, title: '搜索来源', url: 'https://example.invalid/search' };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_gemini_search', model: current.body.model, status: 'completed',
        output: [
          { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '新闻' } },
          { id: 'msg_search', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '搜索答案', annotations: [annotation] }] }
        ],
        usage: { input_tokens: 4, output_tokens: 3 }
      }));
    }
    if (current.body.model === 'stream-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'resp_not_streaming', model: current.body.model, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (current.body.model === 'responses-vendor') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(rawVendorResponse);
    }
    if (current.body.model === 'slow-response') await new Promise((resolveWait) => setTimeout(resolveWait, SLOW_RESPONSE_DELAY_MS));
    if (new URL(req.url, 'http://upstream.local').pathname === '/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_upstream', type: 'message', role: 'assistant', model: current.body.model, content: [{ type: 'text', text: 'Claude 透传成功' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3, ...(current.body.speed ? { speed: current.body.speed } : {}) }, vendor_extension: { preserved: true } }));
    }
    if (req.url === '/chat/completions') {
      const toolNames = (current.body.tools || []).map((tool) => tool.function.name);
      const codexExecName = toolNames.find((name) => name === 'functions__exec' || name.startsWith('functions__exec__'));
      const customName = toolNames.find((name) => name === 'shell' || name.startsWith('shell__custom_'));
      const toolSearchName = toolNames.find((name) => name.startsWith('tool_search__tool_search_')) || toolNames.find((name) => name === 'tool_search');
      const toolCalls = codexExecName
        ? [{ id: 'call_codex_exec', type: 'function', function: { name: codexExecName, arguments: '{"input":"text(\\"SERVER_OK\\")"}' } }]
        : customName && toolSearchName
        ? [
            { id: 'call_custom', type: 'function', function: { name: customName, arguments: '{"input":"dir /b"}' } },
            { id: 'call_search', type: 'function', function: { name: toolSearchName, arguments: '{"query":"tests"}' } }
          ]
        : [{ id: 'call_ns', type: 'function', function: { name: 'multi_agent_v1__spawn_agent', arguments: '{"task":"检查"}' } }];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chat_codex', object: 'chat.completion', model: current.body.model,
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls
          }
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }));
    }
    if (current.body.model === 'stream-error-secret' && current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response: { error: {
          type: 'server_error', code: 'upstream-secret',
          message: 'failure for upstream-secret',
          debug: { authorization: req.headers.authorization }
        } }
      })}\n\n`);
    }
    if (current.body.model === 'stream-explicit-error-secret' && current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end([
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 2, response: { id: 'resp_explicit_error' } })}`,
        `event: response.failed\ndata: ${JSON.stringify({ sequence_number: 5, message: 'explicit failure for upstream-secret', debug: { authorization: req.headers.authorization } })}`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 6 })}`,
        ''
      ].join('\n\n'));
    }
    if (current.body.model === 'stream-invalid-secret' && current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (JSON.stringify(current.body.input).includes('UTF-8')) {
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_invalid_utf8', object: 'response', model: current.body.model, status: 'in_progress' } })}\n\n`);
        return res.end(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]));
      }
      return res.end(`event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_invalid_secret', object: 'upstream-secret', model: current.body.model }
      })}\n\n`);
    }
    if (current.body.model === 'stream-complex-response' && current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', response: {
          id: 'resp_stream_complex', model: current.body.model, status: 'in_progress',
          vendor_extension: nestedObject(257)
        }
      })}\n\n`);
    }
    if (current.body.model === 'multi-stream-response' && current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: 'resp_multi_stream', model: current.body.model, status: 'in_progress' } });
      send('response.output_item.added', { output_index: 0, item: { id: 'msg_multi_stream', type: 'message', role: 'assistant', content: [] } });
      send('response.content_part.added', { item_id: 'msg_multi_stream', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send('response.output_text.delta', { item_id: 'msg_multi_stream', output_index: 0, content_index: 0, delta: '第一段' });
      send('response.content_part.done', { item_id: 'msg_multi_stream', output_index: 0, content_index: 0, part: { type: 'output_text', text: '第一段', annotations: [] } });
      send('response.content_part.added', { item_id: 'msg_multi_stream', output_index: 0, content_index: 1, part: { type: 'output_text', text: '', annotations: [] } });
      send('response.output_text.delta', { item_id: 'msg_multi_stream', output_index: 0, content_index: 1, delta: '第二段' });
      send('response.content_part.done', { item_id: 'msg_multi_stream', output_index: 0, content_index: 1, part: { type: 'output_text', text: '第二段', annotations: [] } });
      send('response.output_item.done', { output_index: 0, item: { id: 'msg_multi_stream', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一段', annotations: [] }, { type: 'output_text', text: '第二段', annotations: [] }] } });
      send('response.completed', { response: { id: 'resp_multi_stream', model: current.body.model, status: 'completed', usage: { input_tokens: 2, output_tokens: 4 } } });
      return res.end();
    }
    if (current.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: 'resp_stream', model: 'gpt-test', status: 'in_progress' } });
      send('response.output_item.added', { output_index: 0, item: { id: 'item_1', type: 'message', role: 'assistant', content: [] } });
      send('response.output_text.delta', { output_index: 0, content_index: 0, delta: '实时' });
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      send('response.output_item.done', { output_index: 0, item: { id: 'item_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '实时转换' }] } });
      send('response.completed', { response: { id: 'resp_stream', model: 'gpt-test', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 2 } } });
      streamFinished = true;
      return res.end();
    }
    const payload = JSON.stringify({
      id: 'resp_upstream', model: 'gpt-test', status: 'completed',
      ...(current.body.service_tier ? { service_tier: current.body.service_tier } : {}),
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '转换成功' }] }],
      usage: { input_tokens: 7, output_tokens: 3 }
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;

  const bridgePort = 30_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/proxy-${randomUUID()}.json`);
  const logFile = resolve(import.meta.dirname, `../data/proxy-log-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(bridgePort), CONFIG_FILE: configFile, LOG_FILE: logFile, OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`, OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`桥接服务提前退出：${code}`); })]);
    const setup = await fetch(`http://127.0.0.1:${bridgePort}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'proxytestpassword' }) });
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const saved = await fetch(`http://127.0.0.1:${bridgePort}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'zen', proxyUrl: '', zenKey: 'upstream-secret', goKey: 'go-secret', clientToken: '', requestLogLimit: 100, persistLogs: true, upstreamTimeoutMs: 1000, maxConcurrentRequests: 10, modelRoutes: { alias: { provider: 'zen', protocol: 'responses', upstreamModel: 'gpt-test' }, 'stream-error-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-error-secret' }, 'stream-explicit-error-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-explicit-error-secret' }, 'stream-invalid-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-invalid-secret' }, 'complex-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'complex-json-response' }, 'stream-complex-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-complex-response' }, 'gemini-tool-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'gemini-tool-alias-response' }, 'gemini-search': { provider: 'zen', protocol: 'responses', upstreamModel: 'gemini-search-response' }, 'thinking-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'gpt-5.6-luna' }, 'responses-same': { provider: 'zen', protocol: 'responses', upstreamModel: 'responses-vendor' }, 'filtered-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'filtered-response' }, 'refusal-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'refusal-response' }, 'multi-stream-alias': { provider: 'zen', protocol: 'responses', upstreamModel: 'multi-stream-response' }, 'missing-usage': { provider: 'zen', protocol: 'responses', upstreamModel: 'no-usage' }, 'stream-json': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-json' }, broken: { provider: 'zen', protocol: 'responses', upstreamModel: 'bad-json' }, malformed: { provider: 'zen', protocol: 'responses', upstreamModel: 'bad-shape' }, 'malformed-item': { provider: 'zen', protocol: 'responses', upstreamModel: 'bad-output-item' }, slow: { provider: 'zen', protocol: 'responses', upstreamModel: 'slow-response' }, 'claude-alias': { provider: 'zen', protocol: 'claude', upstreamModel: 'claude-upstream' }, 'chat-alias': { provider: 'zen', protocol: 'chat', upstreamModel: 'deepseek-v4-flash' } }, promptRewriteRules: [{ id: 'integration', name: '集成替换', enabled: true, find: '系统提示', replace: '处理后系统提示' }] })
    });
    assert.equal(saved.status, 200);

    const createdClientResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '测试客户端', maxConcurrentRequests: 1 })
    });
    assert.equal(createdClientResponse.status, 201);
    const createdClient = await createdClientResponse.json();
    assert.match(createdClient.token, /^ocb[a-f0-9]{64}$/);
    const clients = await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(clients.length, 1);
    assert.equal(clients[0].name, '测试客户端');
    assert.equal(clients[0].maxConcurrentRequests, 1);
    assert.equal('token' in clients[0], false);
    assert.equal('tokenHash' in clients[0], false);

    const concurrentNames = ['并发客户端 A', '并发客户端 B'];
    const concurrentCreates = await Promise.all(concurrentNames.map((name) => fetch(`http://127.0.0.1:${bridgePort}/api/clients`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name, maxConcurrentRequests: 2 })
    })));
    assert.deepEqual(concurrentCreates.map((result) => result.status).sort((left, right) => left - right), [201, 412]);
    const concurrentClients = [];
    for (let index = 0; index < concurrentCreates.length; index++) {
      const result = concurrentCreates[index];
      if (result.status === 201) {
        concurrentClients.push(await result.json());
        continue;
      }
      assert.match((await result.json()).error, /其他页面修改/);
      const latestConfig = await fetch(`http://127.0.0.1:${bridgePort}/api/config`, { headers: { cookie } }).then((response) => response.json());
      const retry = await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'if-match': `"${latestConfig.revision}"` },
        body: JSON.stringify({ name: concurrentNames[index], maxConcurrentRequests: 2 })
      });
      assert.equal(retry.status, 201);
      concurrentClients.push(await retry.json());
    }
    assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, { headers: { cookie } }).then((result) => result.json())).length, 3);
    for (const client of concurrentClients) {
      const latestConfig = await fetch(`http://127.0.0.1:${bridgePort}/api/config`, { headers: { cookie } }).then((result) => result.json());
      const deleted = await fetch(`http://127.0.0.1:${bridgePort}/api/clients/${client.id}`, {
        method: 'DELETE', headers: { cookie, 'if-match': `"${latestConfig.revision}"` }
      });
      assert.equal(deleted.status, 200);
    }

    const tokenCountBodies = [
      { model: 'chat-alias', messages: [{ role: 'user', content: '简短文本' }] },
      { model: 'chat-alias', messages: [{ role: 'user', content: '用于压缩前估算的较长文本 '.repeat(200) }] },
      { model: 'chat-alias', messages: [{ role: 'user', content: '第三段并发估算' }] }
    ];
    const tokenCounts = await Promise.all(tokenCountBodies.map((request) => fetch(`http://127.0.0.1:${bridgePort}/go/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token }, body: JSON.stringify(request)
    })));
    assert.deepEqual(tokenCounts.map((result) => result.status), [200, 200, 200]);
    assert.ok(tokenCounts.every((result) => result.headers.get('x-opencode-token-count') === 'estimated'));
    const tokenCountValues = await Promise.all(tokenCounts.map((result) => result.json()));
    assert.ok(tokenCountValues.every((result) => Number.isSafeInteger(result.input_tokens) && result.input_tokens > 0));
    assert.ok(tokenCountValues[1].input_tokens > tokenCountValues[0].input_tokens);
    const countTokens = async (request) => fetch(`http://127.0.0.1:${bridgePort}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token }, body: JSON.stringify(request)
    }).then((result) => result.json()).then((result) => result.input_tokens);
    const oldThinkingMessages = [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '旧轮推理 '.repeat(2000), signature: 'signed' }, { type: 'text', text: '旧答案' }] },
      { role: 'user', content: '新问题' }
    ];
    const strippedThinkingMessages = oldThinkingMessages.map((message) => message.role === 'assistant'
      ? { ...message, content: message.content.filter((part) => part.type !== 'thinking') }
      : message);
    assert.equal(
      await countTokens({ model: 'chat-alias', messages: oldThinkingMessages }),
      await countTokens({ model: 'chat-alias', messages: strippedThinkingMessages })
    );
    const loadedTokenTool = { name: 'ToolSearch', description: '搜索并加载工具', input_schema: { type: 'object' } };
    const loadedToolCount = await countTokens({ model: 'chat-alias', messages: [{ role: 'user', content: '工具计数' }], tools: [loadedTokenTool] });
    const deferredToolCount = await countTokens({
      model: 'chat-alias', messages: [{ role: 'user', content: '工具计数' }],
      tools: [loadedTokenTool, { name: 'DeferredToolPlaceholder', description: '延迟工具 '.repeat(2000), input_schema: { type: 'object' }, defer_loading: true }]
    });
    assert.equal(deferredToolCount, loadedToolCount);
    const imageTokenCount = await countTokens({
      model: 'chat-alias', messages: [{ role: 'user', content: [{
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1024 * 1024) }
      }] }]
    });
    assert.ok(imageTokenCount >= 4784 && imageTokenCount < 10_000);
    const invalidTokenCount = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token }, body: JSON.stringify({ model: 'chat-alias', messages: [] })
    });
    assert.equal(invalidTokenCount.status, 400);
    assert.equal((await invalidTokenCount.json()).type, 'error');
    const tokenCountWrongMethod = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages/count_tokens`, { headers: { 'x-api-key': createdClient.token } });
    assert.equal(tokenCountWrongMethod.status, 405);
    assert.equal(tokenCountWrongMethod.headers.get('allow'), 'POST');

    const response = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages?beta=true`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token, 'anthropic-beta': 'must-not-cross-protocols' },
      body: JSON.stringify({
        model: 'alias', max_tokens: 256,
        system: [{ type: 'text', text: 'x-anthropic-billing-header: test\n\n系统提示' }, { text: '附加 system 块' }],
        messages: [{ role: 'user', content: '你好' }, { role: 'system', content: '会话中途约束' }]
      })
    });
    assert.equal(response.status, 200);
    const localRequestId = response.headers.get('x-request-id');
    assert.match(localRequestId, /^[a-f0-9]{32}$/);
    const output = await response.json();
    assert.equal(output.type, 'message');
    assert.equal(output.content[0].text, '转换成功');
    assert.deepEqual(output.usage, { input_tokens: 7, output_tokens: 3 });

    assert.equal(captured.path, '/responses');
    assert.equal(captured.authorization, 'Bearer upstream-secret');
    assert.equal(captured.anthropicBeta, undefined);
    assert.equal(captured.body.model, 'gpt-test');
    assert.equal('instructions' in captured.body, false);
    assert.equal(captured.body.input[0].role, 'system');
    assert.equal(captured.body.input[0].content.map((part) => part.text).join(''), '处理后系统提示\n附加 system 块');
    assert.equal(captured.body.input[1].content[0].text, '你好');
    assert.equal(captured.body.input[2].role, 'system');
    assert.equal(captured.body.input[2].content[0].text, '会话中途约束');
    const recentPrompt = await fetch(`http://127.0.0.1:${bridgePort}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(recentPrompt.original, 'x-anthropic-billing-header: test\n\n系统提示\n附加 system 块\n会话中途约束');
    assert.equal(recentPrompt.final, '处理后系统提示\n附加 system 块\n会话中途约束');
    assert.equal(recentPrompt.messageSystemCount, 1);
    assert.equal(recentPrompt.upstreamProtocol, 'responses');
    assert.deepEqual(recentPrompt.applied.map((item) => [item.name, item.count]), [['集成替换', 1]]);
    assert.deepEqual(recentPrompt.ruleResults.map((item) => [item.name, item.status, item.count]), [['集成替换', 'applied', 1]]);

    const logs = await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(logs.length, 1);
    assert.equal(logs[0].requestId, localRequestId);
    assert.equal(logs[0].protocol, 'claude → responses (reasoning_effort_forced_maximum adapted)');
    assert.equal(logs[0].clientId, createdClient.id);
    assert.equal(logs[0].clientName, '测试客户端');
    assert.equal(logs[0].model, 'alias');
    assert.equal(logs[0].upstreamModel, 'gpt-test');
    assert.equal(logs[0].credentialId, 'config:legacy-zen');
    assert.equal(logs[0].credentialLabel, '默认 Key');
    assert.equal(logs[0].inputTokens, 7);
    assert.ok(Number.isFinite(logs[0].upstreamWaitMs) && logs[0].upstreamWaitMs >= 0);
    assert.ok(Number.isFinite(logs[0].upstreamBodyMs) && logs[0].upstreamBodyMs >= 0);
    const stats = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(stats.summary.requests, 1);
    assert.equal(stats.summary.totalTokens, 10);
    assert.equal(stats.summary.inputTokens, 7);
    assert.equal(stats.summary.outputTokens, 3);
    assert.equal(stats.summary.usageRequests, 1);
    assert.equal(stats.summary.upstreamWaitRequests, 1);
    assert.equal(stats.summary.upstreamBodyRequests, 1);
    assert.equal(stats.summary.upstreamWaitCoverageRate, 100);
    assert.equal(stats.byProvider[0].name, 'zen');
    assert.equal(stats.byClient[0].name, '测试客户端');
    assert.equal(stats.byCredential[0].name, 'ZEN · 默认 Key');
    const runtimeStatus = await fetch(`http://127.0.0.1:${bridgePort}/api/status`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(runtimeStatus.upstreamTimingCoverageRate, 100);
    assert.equal(runtimeStatus.upstreamBodyTimingCoverageRate, 100);
    assert.ok(runtimeStatus.averageUpstreamWait >= 0);
    assert.ok(runtimeStatus.averageUpstreamBody >= 0);
    const noUsage = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'missing-usage', input: '不返回 usage' })
    });
    assert.equal(noUsage.status, 200);
    const statsWithMissingUsage = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(statsWithMissingUsage.summary.requests, 2);
    assert.equal(statsWithMissingUsage.summary.usageRequests, 1);
    assert.equal(statsWithMissingUsage.summary.missingUsageRequests, 1);
    assert.equal(statsWithMissingUsage.summary.usageCoverageRate, 50);
    const persistedLogs = JSON.parse(await readFile(logFile, 'utf8'));
    assert.equal(persistedLogs[0].requestId, logs[0].requestId);

    const sanitizedStreamError = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'stream-error-alias', max_tokens: 16, stream: true,
        messages: [{ role: 'user', content: '触发安全流错误' }]
      })
    });
    assert.equal(sanitizedStreamError.status, 200);
    const sanitizedStreamErrorText = await sanitizedStreamError.text();
    assert.match(sanitizedStreamErrorText, /failure for \[REDACTED\]/);
    assert.doesNotMatch(sanitizedStreamErrorText, /upstream-secret|authorization|debug/);
    const sanitizedStreamLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(sanitizedStreamLog.error, 'failure for [REDACTED]');
    assert.equal(sanitizedStreamLog.errorCode, 'server_error');
    assert.doesNotMatch(JSON.stringify(sanitizedStreamLog), /upstream-secret|authorization|debug/);

    const sanitizedInvalidStream = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'stream-invalid-alias', max_tokens: 16, stream: true,
        messages: [{ role: 'user', content: '触发损坏流事件' }]
      })
    });
    assert.equal(sanitizedInvalidStream.status, 200);
    const sanitizedInvalidStreamText = await sanitizedInvalidStream.text();
    assert.match(sanitizedInvalidStreamText, /object 无效：\[REDACTED\]/);
    assert.doesNotMatch(sanitizedInvalidStreamText, /upstream-secret/);
    const sanitizedInvalidLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.match(sanitizedInvalidLog.error, /object 无效：\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(sanitizedInvalidLog), /upstream-secret/);

    const sanitizedSameProtocol = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'stream-error-alias', input: '同协议安全错误', stream: true })
    });
    assert.equal(sanitizedSameProtocol.status, 200);
    const sanitizedSameProtocolText = await sanitizedSameProtocol.text();
    assert.match(sanitizedSameProtocolText, /event: error/);
    assert.match(sanitizedSameProtocolText, /failure for \[REDACTED\]/);
    assert.doesNotMatch(sanitizedSameProtocolText, /upstream-secret|authorization|debug/);
    const sanitizedSameProtocolLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(sanitizedSameProtocolLog.error, 'failure for [REDACTED]');
    assert.equal(sanitizedSameProtocolLog.errorCode, 'server_error');

    const sanitizedExplicitSameProtocol = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'stream-explicit-error-alias', input: '显式非标准安全错误', stream: true })
    });
    assert.equal(sanitizedExplicitSameProtocol.status, 200);
    const sanitizedExplicitSameProtocolText = await sanitizedExplicitSameProtocol.text();
    assert.match(sanitizedExplicitSameProtocolText, /event: response\.created/);
    assert.match(sanitizedExplicitSameProtocolText, /event: error/);
    assert.match(sanitizedExplicitSameProtocolText, /explicit failure for \[REDACTED\]/);
    assert.match(sanitizedExplicitSameProtocolText, /"sequence_number":5/);
    assert.doesNotMatch(sanitizedExplicitSameProtocolText, /upstream-secret|authorization|debug|response\.completed/);
    const sanitizedExplicitSameProtocolLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(sanitizedExplicitSameProtocolLog.error, 'explicit failure for [REDACTED]');
    assert.equal(sanitizedExplicitSameProtocolLog.errorCode, 'upstream_error');
    assert.doesNotMatch(JSON.stringify(sanitizedExplicitSameProtocolLog), /upstream-secret|authorization|debug/);

    const invalidUtf8SameStream = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'stream-invalid-alias', input: '触发无效 UTF-8', stream: true })
    });
    assert.equal(invalidUtf8SameStream.status, 200);
    const invalidUtf8SameStreamText = await invalidUtf8SameStream.text();
    assert.match(invalidUtf8SameStreamText, /event: error/);
    assert.match(invalidUtf8SameStreamText, /upstream_invalid_utf8/);
    assert.doesNotMatch(invalidUtf8SameStreamText, /�/);
    const invalidUtf8SameStreamLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(invalidUtf8SameStreamLog.errorCode, 'upstream_invalid_utf8');

    const invalidUtf8CrossStream = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'stream-invalid-alias', max_tokens: 16, stream: true, messages: [{ role: 'user', content: '触发无效 UTF-8' }] })
    });
    assert.equal(invalidUtf8CrossStream.status, 200);
    const invalidUtf8CrossStreamText = await invalidUtf8CrossStream.text();
    assert.match(invalidUtf8CrossStreamText, /event: error/);
    assert.match(invalidUtf8CrossStreamText, /上游 SSE 包含无效 UTF-8/);
    assert.doesNotMatch(invalidUtf8CrossStreamText, /�/);
    const invalidUtf8CrossStreamLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(invalidUtf8CrossStreamLog.errorCode, 'upstream_invalid_utf8');

    const complexityHealthBefore = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    const zenFailuresBefore = complexityHealthBefore.credentialHealth
      .find((item) => item.provider === 'zen' && item.credentialId === 'config:legacy-zen')?.consecutiveFailures;
    const complexJson = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'complex-alias', input: '触发复杂 JSON' })
    });
    assert.equal(complexJson.status, 502);
    const complexJsonBody = await complexJson.json();
    assert.equal(complexJsonBody.error.code, 'upstream_response_too_complex');
    assert.match(complexJsonBody.error.message, /256 层/);

    const complexStream = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'stream-complex-alias', max_tokens: 16, stream: true,
        messages: [{ role: 'user', content: '触发复杂 SSE' }]
      })
    });
    assert.equal(complexStream.status, 200);
    const complexStreamText = await complexStream.text();
    assert.match(complexStreamText, /event: error/);
    assert.match(complexStreamText, /SSE 事件 JSON.*256 层/);
    const complexStreamLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(complexStreamLog.errorCode, 'upstream_response_too_complex');
    const complexityHealthAfter = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    const zenFailuresAfter = complexityHealthAfter.credentialHealth
      .find((item) => item.provider === 'zen' && item.credentialId === 'config:legacy-zen')?.consecutiveFailures;
    assert.equal(zenFailuresAfter, zenFailuresBefore);

    const invalidUtf8Json = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'broken', input: '触发无效 UTF-8' })
    });
    assert.equal(invalidUtf8Json.status, 502);
    const invalidUtf8JsonBody = await invalidUtf8Json.json();
    assert.equal(invalidUtf8JsonBody.error.code, 'upstream_invalid_utf8');
    assert.match(invalidUtf8JsonBody.error.message, /包含无效 UTF-8/);
    const invalidUtf8Health = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    for (const entry of invalidUtf8Health.credentialHealth.filter((item) => item.consecutiveFailures > 0)) {
      const reset = await fetch(`http://127.0.0.1:${bridgePort}/api/credential-health/reset`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ provider: entry.provider, credentialId: entry.credentialId })
      });
      assert.equal(reset.status, 200);
    }

    const invalidJson = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'broken', max_tokens: 32, messages: [{ role: 'user', content: '损坏 JSON 测试' }] })
    });
    assert.equal(invalidJson.status, 502);
    assert.match((await invalidJson.json()).error.message, /JSON 响应格式无效/);
    const failedLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(failedLog.status, 502);
    assert.match(failedLog.error, /JSON 响应格式无效/);

    const malformedShape = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'malformed', max_tokens: 32, messages: [{ role: 'user', content: '结构损坏测试' }] })
    });
    assert.equal(malformedShape.status, 502);
    assert.match((await malformedShape.json()).error.message, /缺少 output 数组/);
    const malformedLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(malformedLog.status, 502);
    assert.match(malformedLog.error, /缺少 output 数组/);

    const malformedItem = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'malformed-item', max_tokens: 32, messages: [{ role: 'user', content: '输出项损坏测试' }] })
    });
    assert.equal(malformedItem.status, 502);
    assert.match((await malformedItem.json()).error.message, /output\[0\] 必须是对象/);
    const malformedItemLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(malformedItemLog.status, 502);
    assert.match(malformedItemLog.error, /output\[0\] 必须是对象/);

    const timedOut = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'slow', max_tokens: 32, messages: [{ role: 'user', content: '超时测试' }] })
    });
    assert.equal(timedOut.status, 504);
    const timeoutBody = await timedOut.json();
    assert.match(timeoutBody.error.message, /等待上游响应超时/);
    assert.equal(timeoutBody.error.code, 'upstream_response_timeout');
    const timeoutLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(timeoutLog.errorCode, 'upstream_response_timeout');
    assert.ok(timeoutLog.upstreamWaitMs >= 900);
    assert.equal(Object.hasOwn(timeoutLog, 'upstreamBodyMs'), false);

    const sameClaude = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token, 'anthropic-version': '2024-01-01', 'anthropic-beta': 'interleaved-thinking-test' },
      body: JSON.stringify({ model: 'claude-alias', max_tokens: 32, messages: [{ role: 'user', content: '同协议 Claude' }] })
    });
    assert.equal(sameClaude.status, 200);
    const sameClaudeBody = await sameClaude.json();
    assert.equal(sameClaudeBody.content[0].text, 'Claude 透传成功');
    assert.deepEqual(sameClaudeBody.vendor_extension, { preserved: true });
    assert.equal(captured.anthropicVersion, '2024-01-01');
    assert.equal(captured.anthropicBeta, 'interleaved-thinking-test');
    assert.equal(captured.path, '/messages?beta=true');

    const claudeFast = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'alias', max_tokens: 32, speed: 'fast', messages: [{ role: 'user', content: '快速模式' }] })
    });
    assert.equal(claudeFast.status, 200);
    assert.equal(claudeFast.headers.get('x-opencode-service-adaptations'), 'claude_fast_speed_to_openai_fast_tier');
    assert.equal(captured.body.service_tier, 'fast');
    assert.equal((await claudeFast.json()).usage.speed, 'fast');
    const claudeFastLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(claudeFastLog.protocol, 'claude → responses (reasoning_effort_forced_maximum adapted, claude_fast_speed_to_openai_fast_tier adapted)');

    const responsesFast = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'claude-alias', input: '快速模式', service_tier: 'fast' })
    });
    assert.equal(responsesFast.status, 200);
    assert.equal(responsesFast.headers.get('x-opencode-service-adaptations'), 'openai_fast_tier_to_claude_fast_speed');
    assert.equal(captured.body.speed, 'fast');
    assert.equal((await responsesFast.json()).service_tier, 'fast');

    const sameClaudeSteeringText = 'The user sent a new message while you were working:\n同协议运行中引导\n\nAddress the message above as you continue this turn.';
    const sameClaudeSteering = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'claude-alias', max_tokens: 32, system: '系统提示',
        messages: [{ role: 'user', content: '任务' }, { role: 'system', content: sameClaudeSteeringText }]
      })
    });
    assert.equal(sameClaudeSteering.status, 200);
    assert.equal(captured.body.messages[1].role, 'system', '原生 Claude 路由应保留 Claude Code 包装');
    assert.equal(captured.body.messages[1].content, sameClaudeSteeringText);
    const sameClaudePrompt = await fetch(`http://127.0.0.1:${bridgePort}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(sameClaudePrompt.original, '系统提示');
    assert.equal(sameClaudePrompt.final, '处理后系统提示');
    assert.equal(sameClaudePrompt.messageSystemCount, 0);
    assert.equal(sameClaudePrompt.messageUserSteeringCount, 1);

    const forcedGo = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'alias', max_tokens: 64, messages: [{ role: 'user', content: '强制 Go' }] })
    });
    assert.equal(forcedGo.status, 200);
    assert.equal(captured.authorization, 'Bearer go-secret', '路径中的 /go/v1 应覆盖模型路由的 Zen provider');

    streamFinished = false;
    const streamResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'alias', stream: true, max_tokens: 256, messages: [{ role: 'user', content: '流式测试' }] })
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const first = await reader.read();
    assert.equal(streamFinished, false, '桥接端应在上游完成之前发送首个事件');
    const limited = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'alias', max_tokens: 16, messages: [{ role: 'user', content: '并发测试' }] })
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    let streamText = new TextDecoder().decode(first.value);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamText += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamText, /message_start/);
    assert.match(streamText, /text_delta/);
    assert.match(streamText, /实时/);
    assert.match(streamText, /message_stop/);

    streamFinished = false;
    const passthroughResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token, 'openai-beta': 'responses-test' },
      body: JSON.stringify({ model: 'alias', stream: true, input: '同协议流式测试' })
    });
    const passthroughText = await passthroughResponse.text();
    assert.match(passthroughText, /event: response\.created/);
    assert.match(passthroughText, /event: response\.completed/);
    assert.equal(captured.openaiBeta, 'responses-test');
    const passthroughLogs = await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(passthroughLogs[0].protocol, 'responses → responses (reasoning_effort_forced_maximum adapted)');
    assert.equal(passthroughLogs[0].inputTokens, 4);
    assert.equal(passthroughLogs[0].outputTokens, 2);

    streamFinished = false;
    const chatStreamResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'alias', stream: true,
        stream_options: { include_usage: true, include_obfuscation: false },
        messages: [{ role: 'user', content: 'Chat 跨到 Responses 流式测试' }]
      })
    });
    assert.equal(chatStreamResponse.status, 200);
    const chatStreamText = await chatStreamResponse.text();
    const chatChunks = chatStreamText.split(/\n\n/)
      .filter((block) => block.startsWith('data: {'))
      .map((block) => JSON.parse(block.slice(6)));
    assert.deepEqual(captured.body.stream_options, { include_obfuscation: false });
    assert.ok(chatChunks.filter((chunk) => chunk.choices?.length).every((chunk) => chunk.usage === null));
    assert.deepEqual(chatChunks.find((chunk) => chunk.choices?.length === 0)?.usage, {
      prompt_tokens: 4, completion_tokens: 2, total_tokens: 6
    });
    assert.match(chatStreamText, /data: \[DONE\]/);

    const multiContentStream = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'multi-stream-alias', stream: true, stream_options: { include_obfuscation: false }, messages: [{ role: 'user', content: '多内容块测试' }] })
    });
    assert.equal(multiContentStream.status, 200);
    const multiContentText = await multiContentStream.text();
    const multiContentChunks = multiContentText.split(/\n\n/).filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)));
    assert.deepEqual(multiContentChunks.flatMap((chunk) => chunk.choices || []).map((choice) => choice.delta?.content).filter(Boolean), ['第一段', '第二段']);
    assert.equal((multiContentText.match(/第一段/g) || []).length, 1);
    assert.equal((multiContentText.match(/第二段/g) || []).length, 1);

    const sameResponses = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'responses-same', input: '同协议非流式扩展测试' })
    });
    assert.equal(sameResponses.status, 200);
    const sameResponsesText = await sameResponses.text();
    assert.equal(sameResponsesText, rawVendorResponse);
    const sameResponsesBody = JSON.parse(sameResponsesText);
    assert.equal(sameResponsesBody.output[0].type, 'custom_tool_call');
    assert.deepEqual(sameResponsesBody.vendor_extension, { preserved: true });

    const filteredChat = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'filtered-alias', messages: [{ role: 'user', content: '过滤终止测试' }] })
    });
    assert.equal(filteredChat.status, 200);
    assert.equal((await filteredChat.json()).choices[0].finish_reason, 'content_filter');

    const filteredClaude = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'filtered-alias', max_tokens: 32, messages: [{ role: 'user', content: '过滤终止测试' }] })
    });
    assert.equal(filteredClaude.status, 200);
    assert.equal((await filteredClaude.json()).stop_reason, 'refusal');

    const refusalChat = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'refusal-alias', messages: [{ role: 'user', content: '拒答字段测试' }] })
    });
    assert.equal(refusalChat.status, 200);
    const refusalChatBody = await refusalChat.json();
    assert.equal(refusalChatBody.choices[0].message.content, null);
    assert.equal(refusalChatBody.choices[0].message.refusal, '无法协助');
    assert.equal(refusalChatBody.choices[0].finish_reason, 'stop');

    const geminiResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Gemini 系统提示' }] },
        contents: [{ role: 'user', parts: [{ text: 'Gemini 非流式测试' }] }],
        generationConfig: {
          maxOutputTokens: 64, responseMimeType: 'application/json', responseLogprobs: true, logprobs: 4,
          responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
        }
      })
    });
    assert.equal(geminiResponse.status, 200);
    const geminiBody = await geminiResponse.json();
    assert.equal(geminiBody.candidates[0].content.parts[0].text, '转换成功');
    assert.equal(geminiBody.candidates[0].finishReason, 'STOP');
    assert.deepEqual(geminiBody.usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });
    assert.equal(captured.path, '/responses');
    assert.equal(captured.body.model, 'gpt-test');
    assert.equal('instructions' in captured.body, false);
    assert.equal(captured.body.input[0].role, 'system');
    assert.equal(captured.body.input[0].content[0].text, 'Gemini 系统提示');
    assert.equal(captured.body.input[1].content[0].text, 'Gemini 非流式测试');
    assert.equal(captured.body.top_logprobs, 4);
    assert.deepEqual(captured.body.text.format, {
      type: 'json_schema', name: 'gemini_response', strict: true,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    });

    const geminiSearch = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/gemini-search:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '搜索新闻' }] }],
        tools: [{ googleSearch: {} }]
      })
    });
    assert.equal(geminiSearch.status, 200);
    assert.equal(geminiSearch.headers.get('x-opencode-tool-adaptations'), 'gemini_google_search_to_web_search');
    const geminiSearchBody = await geminiSearch.json();
    assert.equal(geminiSearchBody.candidates[0].content.parts[0].text, '搜索答案');
    assert.deepEqual(geminiSearchBody.candidates[0].groundingMetadata, {
      webSearchQueries: ['新闻'],
      groundingChunks: [{ web: { uri: 'https://example.invalid/search', title: '搜索来源' } }],
      groundingSupports: [{
        segment: { partIndex: 0, startIndex: 0, endIndex: 2, text: '搜索' },
        groundingChunkIndices: [0]
      }]
    });
    assert.equal(captured.path, '/responses');
    assert.equal(captured.body.model, 'gemini-search-response');
    assert.deepEqual(captured.body.tools, [{ type: 'web_search' }]);
    const geminiSearchLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(geminiSearchLog.protocol, 'gemini → responses (gemini_google_search_to_web_search adapted, reasoning_effort_forced_maximum adapted)');

    const longGeminiToolName = `lookup_${'x'.repeat(80)}`;
    const geminiToolAliasResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/gemini-tool-alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '调用长名称工具' }] }],
        tools: [{ functionDeclarations: [{
          name: longGeminiToolName, description: '长名称查询工具', parameters: { type: 'object' },
          responseJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
        }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [longGeminiToolName] } }
      })
    });
    assert.equal(geminiToolAliasResponse.status, 200);
    assert.match(geminiToolAliasResponse.headers.get('x-opencode-tool-adaptations'), /gemini_function_names_aliased/);
    assert.match(geminiToolAliasResponse.headers.get('x-opencode-tool-adaptations'), /gemini_response_schema_to_description/);
    const geminiToolAliasBody = await geminiToolAliasResponse.json();
    assert.equal(geminiToolAliasBody.candidates[0].content.parts[0].functionCall.name, longGeminiToolName);
    assert.ok(captured.body.tools[0].name.length <= 64);
    assert.notEqual(captured.body.tools[0].name, longGeminiToolName);
    assert.match(captured.body.tools[0].description, /Gemini function response JSON Schema/);
    assert.equal(captured.body.tool_choice.name, captured.body.tools[0].name);

    const claudeTextAttachment = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 64,
        system: '系统提示',
        messages: [
          { role: 'system', content: 'Claude Code 会话上下文' },
          { role: 'user', content: [
            { type: 'document', title: 'www.temporary-mail.net.txt', source: { type: 'text', media_type: 'text/plain', data: '实际收到了注册邮件' } },
            { type: 'text', text: '请检查附件' }
          ] }
        ]
      })
    });
    assert.equal(claudeTextAttachment.status, 200);
    assert.equal(captured.path, '/chat/completions');
    assert.equal(captured.body.model, 'deepseek-v4-flash');
    assert.deepEqual(captured.body.messages.map((message) => message.role), ['system', 'system', 'user']);
    assert.equal(captured.body.messages[0].content, '处理后系统提示');
    assert.equal(captured.body.messages[1].content, 'Claude Code 会话上下文');
    assert.match(captured.body.messages[2].content[0].text, /www\.temporary-mail\.net\.txt/);
    assert.match(captured.body.messages[2].content[0].text, /实际收到了注册邮件/);
    assert.equal(captured.body.messages[2].content[1].text, '请检查附件');
    const recentChatPrompt = await fetch(`http://127.0.0.1:${bridgePort}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(recentChatPrompt.original, '系统提示\nClaude Code 会话上下文');
    assert.equal(recentChatPrompt.final, '处理后系统提示\nClaude Code 会话上下文');
    assert.equal(recentChatPrompt.messageSystemCount, 1);
    assert.equal(recentChatPrompt.upstreamProtocol, 'chat');

    const steeringText = 'The user sent a new message while you were working:\n你好看到请先暂停工作再继续任务\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn. Address the message above as you continue this turn.';
    const claudeSteering = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 64, system: '系统提示',
        messages: [
          { role: 'user', content: '执行原任务' },
          { role: 'system', content: '会话上下文' },
          { role: 'assistant', content: [{ type: 'text', text: '正在工作' }] },
          { role: 'system', content: [{ type: 'text', text: steeringText }] }
        ]
      })
    });
    assert.equal(claudeSteering.status, 200);
    assert.deepEqual(captured.body.messages.map((message) => message.role), ['system', 'user', 'system', 'assistant', 'user']);
    assert.equal(captured.body.messages.at(-1).content, steeringText);
    const steeringPrompt = await fetch(`http://127.0.0.1:${bridgePort}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(steeringPrompt.original, '系统提示\n会话上下文');
    assert.equal(steeringPrompt.final, '处理后系统提示\n会话上下文');
    assert.equal(steeringPrompt.messageSystemCount, 1);
    assert.equal(steeringPrompt.messageUserSteeringCount, 1);
    assert.doesNotMatch(steeringPrompt.original, /你好看到/);

    const claudeOpaqueThinking = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 64,
        messages: [
          { role: 'user', content: '读取文件' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: '先检查路径', signature: 'opaque-claude-signature' },
            { type: 'redacted_thinking', data: 'opaque-redacted-thinking' },
            { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }
          ] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: '文件内容' }] }
        ],
        tools: [{ name: 'Read', description: '读取文件', input_schema: { type: 'object' } }]
      })
    });
    assert.equal(claudeOpaqueThinking.status, 200);
    assert.equal(claudeOpaqueThinking.headers.get('x-opencode-input-degradations'), 'claude_thinking_signature,claude_redacted_thinking');
    assert.equal(claudeOpaqueThinking.headers.get('x-opencode-reasoning-adaptations'), 'reasoning_effort_forced_maximum,reasoning_history_to_chat_reasoning_content');
    await claudeOpaqueThinking.json();
    assert.equal(captured.path, '/chat/completions');
    assert.deepEqual(captured.body.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
    assert.equal(captured.body.messages[1].reasoning_content, '先检查路径');
    assert.equal(captured.body.messages[1].tool_calls[0].function.name, 'Read');
    assert.equal(JSON.stringify(captured.body).includes('opaque-claude-signature'), false);
    assert.equal(JSON.stringify(captured.body).includes('opaque-redacted-thinking'), false);
    const claudeOpaqueLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(claudeOpaqueLog.protocol, 'claude → chat (claude thinking signature degraded, claude redacted thinking degraded, reasoning_effort_forced_maximum adapted, reasoning_history_to_chat_reasoning_content adapted)');

    const geminiStream = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1beta/models/alias:streamGenerateContent?alt=sse`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Gemini 流式测试' }] }],
        tools: [{ functionDeclarations: [{ name: 'stream_tool', parameters: { type: 'object' } }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO', streamFunctionCallArguments: true } }
      })
    });
    assert.equal(geminiStream.status, 200);
    assert.match(geminiStream.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(geminiStream.headers.get('x-opencode-tool-adaptations'), 'gemini_stream_function_args_reencoded');
    const geminiStreamText = await geminiStream.text();
    assert.match(geminiStreamText, /"text":"实时"/);
    assert.match(geminiStreamText, /"finishReason":"STOP"/);
    assert.match(geminiStreamText, /"promptTokenCount":4/);
    assert.doesNotMatch(geminiStreamText, /\[DONE\]/);
    assert.equal(captured.path, '/responses');
    assert.equal(captured.body.tools[0].name, 'stream_tool');
    assert.equal(JSON.stringify(captured.body).includes('streamFunctionCallArguments'), false);

    const unsupportedGemini = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '多候选测试' }] }], generationConfig: { candidateCount: 2 } })
    });
    assert.equal(unsupportedGemini.status, 400);
    assert.deepEqual(await unsupportedGemini.json(), { error: { code: 400, message: '跨协议转换仅支持 Gemini candidateCount=1', status: 'INVALID_ARGUMENT' } });

    const geminiAllowedTools = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/chat-alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: '只允许只读工具' }] }],
        tools: [{ functionDeclarations: [
          { name: 'inspect', parameters: { type: 'object' } },
          { name: 'list', parameters: { type: 'object' } },
          { name: 'delete', parameters: { type: 'object' } }
        ] }],
        toolConfig: { functionCallingConfig: { mode: 'VALIDATED', allowedFunctionNames: ['inspect', 'list'] } }
      })
    });
    assert.equal(geminiAllowedTools.status, 200);
    assert.equal(geminiAllowedTools.headers.get('x-opencode-tool-adaptations'), 'gemini_allowed_functions_filtered,gemini_validated_best_effort');
    await geminiAllowedTools.json();
    assert.equal(captured.path, '/chat/completions');
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['inspect', 'list']);
    assert.equal(captured.body.tool_choice, 'auto');
    const geminiToolsLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(geminiToolsLog.protocol, 'gemini → chat (gemini_allowed_functions_filtered adapted, gemini_validated_best_effort adapted, reasoning_effort_forced_maximum adapted)');

    const geminiSignedHistory = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/chat-alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: '查询天气' }] },
          { role: 'model', parts: [
            { text: '先确认城市', thought: true, thoughtSignature: 'opaque-thought-state' },
            { functionCall: { id: 'call_signed', name: 'lookup', args: { city: '上海' } }, thoughtSignature: 'opaque-gemini-state' }
          ] },
          { role: 'user', parts: [{ functionResponse: { id: 'call_signed', name: 'lookup', response: { weather: '晴' } } }] }
        ]
      })
    });
    assert.equal(geminiSignedHistory.status, 200);
    assert.equal(geminiSignedHistory.headers.get('x-opencode-input-degradations'), 'gemini_thought_signature');
    assert.equal(geminiSignedHistory.headers.get('x-opencode-reasoning-adaptations'), 'reasoning_effort_forced_maximum,reasoning_history_to_chat_reasoning_content');
    await geminiSignedHistory.json();
    assert.equal(captured.path, '/chat/completions');
    assert.deepEqual(captured.body.messages.map((message) => message.role), ['user', 'assistant', 'tool']);
    assert.equal(captured.body.messages[1].reasoning_content, '先确认城市');
    assert.equal(captured.body.messages[1].tool_calls[0].function.name, 'lookup');
    assert.equal(JSON.stringify(captured.body).includes('opaque-gemini-state'), false);
    const geminiSignatureLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(geminiSignatureLog.protocol, 'gemini → chat (gemini thought signature degraded, reasoning_effort_forced_maximum adapted, reasoning_history_to_chat_reasoning_content adapted)');

    const geminiThinking = await fetch(`http://127.0.0.1:${bridgePort}/v1beta/models/thinking-alias:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': createdClient.token },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'thinking 配置测试' }] }], generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } } })
    });
    assert.equal(geminiThinking.status, 200);
    assert.equal(geminiThinking.headers.get('x-opencode-reasoning-adaptations'), 'reasoning_effort_forced_maximum,thinking_budget_to_effort');
    await geminiThinking.json();
    assert.equal(captured.path, '/responses');
    assert.equal(captured.body.model, 'gpt-5.6-luna');
    assert.deepEqual(captured.body.reasoning, { effort: 'max', summary: 'auto' });
    const thinkingLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(thinkingLog.protocol, 'gemini → responses (reasoning_effort_forced_maximum adapted, thinking_budget_to_effort adapted)');

    const codexCrossProtocol = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias',
        instructions: '代理规则', metadata: { trace: 'codex-cross' },
        max_output_tokens: 512, temperature: 0.4, top_p: 0.8,
        reasoning: { effort: 'low', summary: 'auto' }, store: false, truncation: 'disabled',
        text: { verbosity: 'low' }, user: 'legacy-user', safety_identifier: 'safe-user',
        client_metadata: { 'x-codex-turn-metadata': '{"session_id":"session_probe","request_kind":"turn"}' },
        input: [
          { type: 'reasoning', id: 'rs_cross', status: 'completed', encrypted_content: 'opaque-state', summary: [{ type: 'summary_text', text: '先检查任务边界' }] },
          { type: 'message', id: 'msg_progress', status: 'completed', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '正在分派检查任务' }] },
          { type: 'message', id: 'msg_empty', status: 'incomplete', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '' }] },
          { type: 'agent_message', id: 'agent_cross', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nPayload:\n子代理检查完成' }] },
          { type: 'message', id: 'msg_cross', status: 'completed', role: 'user', content: [{ type: 'input_text', text: '搜索并分派检查任务' }] }
        ],
        tools: [
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            description: '多代理工具',
            tools: [{ type: 'function', name: 'spawn_agent', description: '创建代理', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } }]
          },
          { type: 'web_search', external_web_access: true }
        ]
      })
    });
    assert.equal(codexCrossProtocol.status, 200);
    assert.equal(codexCrossProtocol.headers.get('x-opencode-tool-degradations'), null);
    assert.ok(codexCrossProtocol.headers.get('x-opencode-tool-adaptations').split(',').includes('responses_web_search_to_mcp'));
    assert.equal(codexCrossProtocol.headers.get('x-opencode-input-degradations'), 'responses_client_metadata,responses_item_metadata,responses_item_phase,responses_empty_assistant_placeholder,responses_agent_message_to_user,encrypted_reasoning');
    assert.equal(codexCrossProtocol.headers.get('x-opencode-reasoning-adaptations'), 'reasoning_effort_forced_maximum,reasoning_summary_best_effort_chat,reasoning_history_to_chat_reasoning_content');
    const codexBody = await codexCrossProtocol.json();
    assert.equal(codexBody.output[0].type, 'function_call');
    assert.equal(codexBody.output[0].namespace, 'multi_agent_v1');
    assert.equal(codexBody.output[0].name, 'spawn_agent');
    assert.equal(codexBody.output[0].arguments, '{"task":"检查"}');
    assert.deepEqual(codexBody.tools.map((tool) => tool.type), ['namespace', 'web_search']);
    assert.equal(codexBody.error, null);
    assert.equal(codexBody.incomplete_details, null);
    assert.equal(codexBody.instructions, '代理规则');
    assert.deepEqual(codexBody.metadata, { trace: 'codex-cross' });
    assert.equal(codexBody.max_output_tokens, 512);
    assert.equal(codexBody.temperature, 0.4);
    assert.equal(codexBody.top_p, 0.8);
    assert.deepEqual(codexBody.reasoning, { effort: 'low', summary: 'auto' });
    assert.deepEqual(codexBody.text, { verbosity: 'low' });
    assert.equal(codexBody.store, false);
    assert.equal(codexBody.truncation, 'disabled');
    assert.equal(codexBody.user, 'legacy-user');
    assert.equal(codexBody.safety_identifier, 'safe-user');
    assert.ok(Number.isSafeInteger(codexBody.completed_at));
    assert.equal(captured.path, '/chat/completions');
    assert.equal(captured.body.model, 'deepseek-v4-flash');
    assert.equal(captured.body.reasoning_effort, 'max');
    assert.equal(captured.body.client_metadata, undefined);
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['multi_agent_v1__spawn_agent', 'web_search']);
    assert.equal(captured.body.messages.some((message) => message.role === 'developer'), false);
    assert.equal(captured.body.messages.some((message) => message.role === 'assistant' && message.content === '正在分派检查任务'), true);
    assert.equal(captured.body.messages.some((message) => message.role === 'assistant' && message.content === ''), false);
    assert.equal(captured.body.messages.some((message) => message.role === 'user' && message.content === 'Agent message from /root/worker to /root:\nMessage Type: MESSAGE\nPayload:\n子代理检查完成'), true);
    assert.doesNotMatch(captured.body.messages.find((message) => message.role === 'system').content, /cannot execute the hosted web_search tool/);
    assert.match(captured.body.messages.find((message) => message.role === 'system').content, /完整 HTTP\(S\) URL/);
    assert.equal(captured.body.messages.find((message) => message.role === 'assistant').reasoning_content, '先检查任务边界');
    const codexLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(codexLog.protocol, 'responses → chat (responses_web_search_to_mcp adapted, reasoning degraded, responses client metadata dropped, responses item metadata degraded, responses item phase degraded, empty responses assistant placeholder dropped, responses agent message adapted to user, reasoning_effort_forced_maximum adapted, reasoning_summary_best_effort_chat adapted, reasoning_history_to_chat_reasoning_content adapted)');
    assert.equal(codexLog.requestedReasoningEffort, 'low');
    assert.equal(codexLog.reasoningEffort, 'max');
    assert.equal(codexLog.requestKind, 'turn');
    const effortStats = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    assert.ok(effortStats.byReasoningEffort.some((item) => item.name === 'max' && item.requests >= 1));
    assert.ok(effortStats.summary.reasoningEffortChangedRequests >= 1);
    assert.equal(effortStats.summary.reasoningEffortDroppedRequests, 0);

    const requestsBeforeStatefulInput = upstreamRequestCount;
    const statefulResponses = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'chat-alias', input: '继续', previous_response_id: 'resp_server_state' })
    });
    assert.equal(statefulResponses.status, 400);
    assert.match((await statefulResponses.json()).error.message, /previous_response_id.*完整 input 历史.*responses/);
    assert.equal(upstreamRequestCount, requestsBeforeStatefulInput);

    const requestsBeforeUnknownFields = upstreamRequestCount;
    const unknownResponsesField = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'chat-alias', input: '继续', future_state: { id: 'state_1' } })
    });
    assert.equal(unknownResponsesField.status, 400);
    assert.match((await unknownResponsesField.json()).error.message, /暂不支持 Responses 请求字段：future_state/);
    const elevatedInstruction = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', instructions: [{ type: 'message', role: 'user', content: '不应提升' }], input: '继续'
      })
    });
    assert.equal(elevatedInstruction.status, 400);
    assert.match((await elevatedInstruction.json()).error.message, /role 只能是 system 或 developer/);
    assert.equal(upstreamRequestCount, requestsBeforeUnknownFields);

    const requestsBeforeEmptyMessage = upstreamRequestCount;
    const emptyChatMessage = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: null }] })
    });
    assert.equal(emptyChatMessage.status, 400);
    assert.match((await emptyChatMessage.json()).error.message, /Chat messages\[0\]\.content 必须是非空/);
    assert.equal(upstreamRequestCount, requestsBeforeEmptyMessage);

    const claudeToolError = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 128,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'failed_call', name: 'lookup', input: { q: 'status' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed_call', content: '连接超时', is_error: true }] }
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }]
      })
    });
    assert.equal(claudeToolError.status, 200);
    assert.equal(claudeToolError.headers.get('x-opencode-tool-adaptations'), 'claude_tool_error_to_content');
    await claudeToolError.json();
    assert.equal(captured.body.messages.find((message) => message.role === 'tool').content, '[Claude tool_result is_error=true]\n连接超时');
    const toolErrorLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(toolErrorLog.protocol, 'claude → chat (claude_tool_error_to_content adapted, reasoning_effort_forced_maximum adapted)');

    const loadedTool = { type: 'function', name: 'inspect_file', description: '检查文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
    const codexAdaptedTools = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '执行命令并搜索工具' }] },
          { type: 'tool_search_call', execution: 'client', call_id: 'search_previous', arguments: { query: 'file' } },
          { type: 'tool_search_output', execution: 'client', call_id: 'search_previous', status: 'completed', tools: [loadedTool] }
        ],
        tools: [
          { type: 'custom', name: 'shell', description: '运行命令', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
          { type: 'function', name: 'tool_search', description: '同名普通函数', parameters: { type: 'object' } },
          { type: 'tool_search', execution: 'client', description: '搜索工具', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
        ]
      })
    });
    assert.equal(codexAdaptedTools.status, 200);
    assert.equal(codexAdaptedTools.headers.get('x-opencode-tool-adaptations'), 'custom,client_tool_search');
    assert.equal(codexAdaptedTools.headers.get('x-opencode-input-degradations'), 'responses_item_metadata');
    const adaptedBody = await codexAdaptedTools.json();
    assert.deepEqual(adaptedBody.output.map((item) => item.type), ['custom_tool_call', 'tool_search_call']);
    assert.equal(adaptedBody.output[0].name, 'shell');
    assert.equal(adaptedBody.output[0].input, 'dir /b');
    assert.deepEqual(adaptedBody.output[1].arguments, { query: 'tests' });
    assert.deepEqual(adaptedBody.tools.map((tool) => tool.type), ['custom', 'function', 'tool_search', 'function']);
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['shell', 'tool_search', 'tool_search__tool_search_2', 'inspect_file']);
    assert.match(captured.body.tools[0].function.description, /Original lark grammar/);
    assert.deepEqual(captured.body.messages.slice(-2).map((message) => message.role), ['assistant', 'tool']);
    assert.deepEqual(JSON.parse(captured.body.messages.at(-1).content), { tools: [loadedTool] });
    const adaptedLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(adaptedLog.protocol, 'responses → chat (custom adapted, client_tool_search adapted, responses item metadata degraded, reasoning_effort_forced_maximum adapted)');

    const solAdditionalTools = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', stream: false, store: false, parallel_tool_calls: false,
        text: { verbosity: 'low' },
        input: [
          { type: 'additional_tools', role: 'developer', tools: [{
            type: 'namespace', name: 'functions', tools: [{
              type: 'custom', name: 'exec', description: '执行代码',
              format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
            }]
          }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '执行' }] }
        ]
      })
    });
    assert.equal(solAdditionalTools.status, 200);
    assert.equal(solAdditionalTools.headers.get('x-opencode-tool-adaptations'), 'additional_tools_to_top_level,custom');
    const solAdditionalBody = await solAdditionalTools.json();
    assert.deepEqual(solAdditionalBody.output[0], {
      id: 'ctc_0', type: 'custom_tool_call', status: 'completed', call_id: 'call_codex_exec',
      namespace: 'functions', name: 'exec', input: 'text("SERVER_OK")'
    });
    assert.equal(solAdditionalBody.tools[0].type, 'namespace');
    assert.equal(captured.body.tools[0].function.name, 'functions__exec');

    const cachedOnlySearch = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', stream: false, input: '不要联网，只执行普通任务',
        tools: [
          { type: 'web_search', external_web_access: false },
          { type: 'function', name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
        ]
      })
    });
    assert.equal(cachedOnlySearch.status, 200);
    assert.match(cachedOnlySearch.headers.get('x-opencode-tool-adaptations') || '', /responses_web_search_external_access_disabled/);
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['echo']);
    assert.equal(JSON.stringify(captured.body).includes('web_search'), false);

    const callsBeforeForcedCachedSearch = upstreamRequestCount;
    const forcedCachedOnlySearch = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', input: '必须搜索',
        tools: [{ type: 'web_search', external_web_access: false }],
        tool_choice: { type: 'web_search' }
      })
    });
    assert.equal(forcedCachedOnlySearch.status, 400);
    assert.match((await forcedCachedOnlySearch.json()).error.message, /external_web_access:false/);
    assert.equal(upstreamRequestCount, callsBeforeForcedCachedSearch);

    const programmaticTools = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', input: '检查库存', tools: [
          {
            type: 'function', name: 'inventory', description: '查询库存', parameters: { type: 'object' },
            output_schema: { type: 'object', properties: { available: { type: 'number' } } },
            allowed_callers: ['direct', 'programmatic']
          },
          { type: 'programmatic_tool_calling' }
        ]
      })
    });
    assert.equal(programmaticTools.status, 200);
    assert.equal(programmaticTools.headers.get('x-opencode-tool-adaptations'), 'programmatic_tool_calling_disabled,output_schema_to_description,allowed_callers_direct_only');
    await programmaticTools.json();
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['inventory']);
    assert.match(captured.body.tools[0].function.description, /Responses output_schema/);
    const programmaticLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(programmaticLog.protocol, 'responses → chat (programmatic_tool_calling_disabled adapted, output_schema_to_description adapted, allowed_callers_direct_only adapted, reasoning_effort_forced_maximum adapted)');

    const allowedTools = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', input: '只允许检查',
        tools: [
          { type: 'function', name: 'inspect', parameters: { type: 'object' } },
          { type: 'function', name: 'remove', parameters: { type: 'object' } }
        ],
        tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'inspect' }] }
      })
    });
    assert.equal(allowedTools.status, 200);
    assert.equal(allowedTools.headers.get('x-opencode-tool-adaptations'), 'allowed_tools_filtered');
    await allowedTools.json();
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['inspect']);
    assert.equal(captured.body.tool_choice, 'required');
    const allowedToolsLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(allowedToolsLog.protocol, 'responses → chat (allowed_tools_filtered adapted, reasoning_effort_forced_maximum adapted)');

    const claudeDeferredTools = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 128, messages: [{ role: 'user', content: '继续任务' }],
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        tools: [
          { name: 'ToolSearch', description: '加载工具', input_schema: { type: 'object' }, strict: true },
          { name: 'DeferredToolPlaceholder', description: '延迟占位', input_schema: { type: 'object' }, defer_loading: true }
        ]
      })
    });
    assert.equal(claudeDeferredTools.status, 200);
    assert.equal(claudeDeferredTools.headers.get('x-opencode-tool-adaptations'), 'deferred_tools_hidden');
    assert.equal(claudeDeferredTools.headers.get('x-opencode-context-adaptations'), 'claude_keep_all_thinking_local');
    await claudeDeferredTools.json();
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['ToolSearch']);
    assert.equal(captured.body.tools[0].function.strict, true);
    const claudeDeferredLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(claudeDeferredLog.protocol, 'claude → chat (deferred_tools_hidden adapted, reasoning_effort_forced_maximum adapted, claude_keep_all_thinking_local adapted)');

    const claudeLoadedDeferred = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 128,
        messages: [
          { role: 'user', content: '搜索工具' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'search_1', name: 'ToolSearch', input: { query: 'Read' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: [{ type: 'tool_reference', tool_name: 'Read' }] }] }
        ],
        tools: [
          { name: 'ToolSearch', description: '加载工具', input_schema: { type: 'object' } },
          {
            name: 'Read', description: '读取文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } },
            defer_loading: true, strict: true, input_examples: [{ path: 'README.md' }], allowed_callers: ['direct', 'code_execution_20260120']
          }
        ]
      })
    });
    assert.equal(claudeLoadedDeferred.status, 200);
    assert.equal(claudeLoadedDeferred.headers.get('x-opencode-tool-adaptations'), 'deferred_tools_loaded,input_examples_to_description,allowed_callers_direct_only');
    await claudeLoadedDeferred.json();
    assert.deepEqual(captured.body.tools.map((tool) => tool.function.name), ['ToolSearch', 'Read']);
    assert.equal(captured.body.tools[1].function.strict, true);
    assert.match(captured.body.tools[1].function.description, /Claude input_examples/);
    const claudeLoadedLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(claudeLoadedLog.protocol, 'claude → chat (deferred_tools_loaded adapted, input_examples_to_description adapted, allowed_callers_direct_only adapted, reasoning_effort_forced_maximum adapted)');

    const eagerToolStream = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'alias', max_tokens: 128, stream: true, messages: [{ role: 'user', content: '生成长工具参数' }],
        tools: [{
          name: 'Write', description: '写文件', input_schema: { type: 'object', properties: { content: { type: 'string' } } },
          input_examples: [{ content: 'hello' }], allowed_callers: ['direct', 'code_execution_20260521'], eager_input_streaming: true
        }]
      })
    });
    assert.equal(eagerToolStream.status, 200);
    assert.equal(eagerToolStream.headers.get('x-opencode-tool-adaptations'), 'input_examples_to_description,allowed_callers_direct_only,eager_input_streaming_best_effort');
    assert.match(await eagerToolStream.text(), /event: message_stop/);
    assert.match(captured.body.tools[0].description, /Claude input_examples/);
    const eagerToolLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(eagerToolLog.protocol, 'claude → responses (input_examples_to_description adapted, allowed_callers_direct_only adapted, eager_input_streaming_best_effort adapted, reasoning_effort_forced_maximum adapted)');

    const claudePromptCache = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'thinking-alias', max_tokens: 64, cache_control: { type: 'ephemeral', ttl: '1h' },
        system: [{ type: 'text', text: '缓存系统提示', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '缓存问题', cache_control: { type: 'ephemeral', ttl: '5m' } }] }]
      })
    });
    assert.equal(claudePromptCache.status, 200);
    assert.equal(claudePromptCache.headers.get('x-opencode-cache-adaptations'), 'claude_cache_to_responses,claude_cache_ttl_to_30m');
    await claudePromptCache.json();
    assert.deepEqual(captured.body.prompt_cache_options, { mode: 'implicit' });
    assert.deepEqual(captured.body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    const claudePromptCacheLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(claudePromptCacheLog.protocol, 'claude → responses (reasoning_effort_forced_maximum adapted, claude_cache_to_responses adapted, claude_cache_ttl_to_30m adapted)');

    const responsesPromptCache = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'claude-alias', max_output_tokens: 64,
        prompt_cache_options: { mode: 'implicit', ttl: '30m' }, prompt_cache_key: 'shared-responses-prefix',
        input: [{ role: 'user', content: [{
          type: 'input_text', text: 'Responses 缓存问题', prompt_cache_breakpoint: { mode: 'explicit' }
        }] }]
      })
    });
    assert.equal(responsesPromptCache.status, 200);
    assert.equal(responsesPromptCache.headers.get('x-opencode-cache-adaptations'), 'responses_cache_to_claude,responses_cache_ttl_to_5m,responses_cache_key_dropped');
    await responsesPromptCache.json();
    assert.deepEqual(captured.body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(captured.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    const responsesPromptCacheLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(responsesPromptCacheLog.protocol, 'responses → claude (reasoning_effort_forced_maximum adapted, responses_cache_to_claude adapted, responses_cache_ttl_to_5m adapted, responses_cache_key_dropped adapted)');

    const chatPromptCache = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'thinking-alias', max_tokens: 64,
        prompt_cache_options: { mode: 'explicit', ttl: '30m' }, prompt_cache_key: 'shared-chat-prefix',
        messages: [{ role: 'user', content: [{
          type: 'text', text: 'Chat 缓存问题', prompt_cache_breakpoint: { mode: 'explicit' }
        }] }]
      })
    });
    assert.equal(chatPromptCache.status, 200);
    assert.equal(chatPromptCache.headers.get('x-opencode-cache-adaptations'), 'chat_cache_to_responses');
    await chatPromptCache.json();
    assert.deepEqual(captured.body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.equal(captured.body.prompt_cache_key, 'shared-chat-prefix');
    assert.deepEqual(captured.body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    const chatPromptCacheLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(chatPromptCacheLog.protocol, 'chat → responses (reasoning_effort_forced_maximum adapted, chat_cache_to_responses adapted)');

    const chatToolCache = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'claude-alias', messages: [{
          role: 'user', content: '执行', cache_control: { type: 'ephemeral', ttl: '1h' }
        }],
        tools: [{
          type: 'function', cache_control: { type: 'ephemeral', ttl: '1h' },
          function: { name: 'run', parameters: { type: 'object' } }
        }]
      })
    });
    assert.equal(chatToolCache.status, 200);
    assert.equal(chatToolCache.headers.get('x-opencode-cache-adaptations'), 'chat_cache_to_claude');
    await chatToolCache.json();
    assert.equal(captured.path, '/messages');
    assert.deepEqual(captured.body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(captured.body.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    const chatToolCacheLog = (await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json()))[0];
    assert.equal(chatToolCacheLog.protocol, 'chat → claude (reasoning_effort_forced_maximum adapted, chat_cache_to_claude adapted)');

    const typedServerTool = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({
        model: 'chat-alias', max_tokens: 64, messages: [{ role: 'user', content: '搜索网页' }],
        tools: [{ type: 'computer_20250124', name: 'computer' }]
      })
    });
    assert.equal(typedServerTool.status, 400);
    assert.match((await typedServerTool.json()).error.message, /typed\/server tool.*路由设为 claude/);

    const wrongStreamType = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'stream-json', stream: true, max_tokens: 16, messages: [{ role: 'user', content: '不能伪装成 SSE' }] })
    });
    assert.equal(wrongStreamType.status, 502);
    const wrongStreamTypeBody = await wrongStreamType.json();
    assert.equal(wrongStreamTypeBody.type, 'error');
    assert.match(wrongStreamTypeBody.error.message, /上游流式响应格式无效.*application\/json/);

    const modelList = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/models`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(modelList.status, 200);
    assert.equal((await modelList.json()).data[0].id, 'gpt-test');
    assert.equal(captured.authorization, 'Bearer upstream-secret');

    const combinedModels = await fetch(`http://127.0.0.1:${bridgePort}/v1/models?provider=all`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } }).then((result) => result.json());
    assert.equal(combinedModels.data[0].id, 'gpt-test');
    assert.equal(combinedModels.data[0].provider, 'zen');
    assert.equal(combinedModels.data[1].id, 'opencode-go/gpt-test');
    assert.equal(combinedModels.data[1].provider, 'go');

    const goModel = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/models/${encodeURIComponent('gpt-test')}`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(goModel.status, 200);
    assert.equal((await goModel.json()).id, 'gpt-test');

    const connectionTest = await fetch(`http://127.0.0.1:${bridgePort}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', apiKey: 'ephemeral-key', proxyUrl: '' })
    });
    assert.equal(connectionTest.status, 200);
    assert.equal(captured.authorization, 'Bearer ephemeral-key');

    const rotated = await fetch(`http://127.0.0.1:${bridgePort}/api/clients/${createdClient.id}/regenerate`, { method: 'POST', headers: { cookie } }).then((result) => result.json());
    assert.notEqual(rotated.token, createdClient.token);
    const oldTokenRejected = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, { headers: { authorization: `Bearer ${createdClient.token}` } });
    assert.equal(oldTokenRejected.status, 401);
    const newTokenAccepted = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, { headers: { authorization: `Bearer ${rotated.token}` } });
    assert.equal(newTokenAccepted.status, 200);

    const disabled = await fetch(`http://127.0.0.1:${bridgePort}/api/clients/${createdClient.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.status, 200);
    const rejected = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': rotated.token },
      body: JSON.stringify({ model: 'alias', max_tokens: 16, messages: [{ role: 'user', content: '停用测试' }] })
    });
    assert.equal(rejected.status, 401);
    const removed = await fetch(`http://127.0.0.1:${bridgePort}/api/clients/${createdClient.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, { headers: { cookie } }).then((result) => result.json()), []);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(logFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
