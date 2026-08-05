import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('Claude 请求经本地桥接转换为 Responses 并转换响应', { timeout: 15_000 }, async () => {
  let captured;
  let streamFinished = false;
  const upstream = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      captured = { path: req.url, authorization: req.headers.authorization };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
    }
    const current = { path: req.url, authorization: req.headers.authorization, anthropicBeta: req.headers['anthropic-beta'], anthropicVersion: req.headers['anthropic-version'], openaiBeta: req.headers['openai-beta'], body: await requestBody(req) };
    captured = current;
    if (current.body.model === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{broken');
    }
    if (current.body.model === 'bad-shape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (current.body.model === 'no-usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_no_usage', model: current.body.model, status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '无用量字段' }] }], usage: {}
      }));
    }
    if (current.body.model === 'stream-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'resp_not_streaming', model: current.body.model, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (current.body.model === 'responses-vendor') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_vendor', model: current.body.model, status: 'completed',
        output: [{ type: 'custom_tool_call', call_id: 'custom_1', name: 'shell', input: 'dir' }],
        usage: { input_tokens: 3, output_tokens: 1 }, vendor_extension: { preserved: true }
      }));
    }
    if (current.body.model === 'slow-response') await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    if (req.url === '/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_upstream', type: 'message', role: 'assistant', model: current.body.model, content: [{ type: 'text', text: 'Claude 透传成功' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 }, vendor_extension: { preserved: true } }));
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
      body: JSON.stringify({ defaultProvider: 'zen', proxyUrl: '', zenKey: 'upstream-secret', goKey: 'go-secret', clientToken: '', requestLogLimit: 100, persistLogs: true, upstreamTimeoutMs: 1000, maxConcurrentRequests: 10, modelRoutes: { alias: { provider: 'zen', protocol: 'responses', upstreamModel: 'gpt-test' }, 'responses-same': { provider: 'zen', protocol: 'responses', upstreamModel: 'responses-vendor' }, 'missing-usage': { provider: 'zen', protocol: 'responses', upstreamModel: 'no-usage' }, 'stream-json': { provider: 'zen', protocol: 'responses', upstreamModel: 'stream-json' }, broken: { provider: 'zen', protocol: 'responses', upstreamModel: 'bad-json' }, malformed: { provider: 'zen', protocol: 'responses', upstreamModel: 'bad-shape' }, slow: { provider: 'zen', protocol: 'responses', upstreamModel: 'slow-response' }, 'claude-alias': { provider: 'zen', protocol: 'claude', upstreamModel: 'claude-upstream' } }, promptRewriteRules: [{ id: 'integration', name: '集成替换', enabled: true, find: '系统提示', replace: '处理后系统提示' }] })
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

    const concurrentCreates = await Promise.all(['并发客户端 A', '并发客户端 B'].map((name) => fetch(`http://127.0.0.1:${bridgePort}/api/clients`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name, maxConcurrentRequests: 2 })
    })));
    assert.deepEqual(concurrentCreates.map((result) => result.status), [201, 201]);
    const concurrentClients = await Promise.all(concurrentCreates.map((result) => result.json()));
    assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/api/clients`, { headers: { cookie } }).then((result) => result.json())).length, 3);
    await Promise.all(concurrentClients.map((client) => fetch(`http://127.0.0.1:${bridgePort}/api/clients/${client.id}`, { method: 'DELETE', headers: { cookie } })));

    const response = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token, 'anthropic-beta': 'must-not-cross-protocols' },
      body: JSON.stringify({ model: 'alias', max_tokens: 256, system: 'x-anthropic-billing-header: test\n\n系统提示', messages: [{ role: 'user', content: '你好' }] })
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('x-request-id'));
    const output = await response.json();
    assert.equal(output.type, 'message');
    assert.equal(output.content[0].text, '转换成功');
    assert.deepEqual(output.usage, { input_tokens: 7, output_tokens: 3 });

    assert.equal(captured.path, '/responses');
    assert.equal(captured.authorization, 'Bearer upstream-secret');
    assert.equal(captured.anthropicBeta, undefined);
    assert.equal(captured.body.model, 'gpt-test');
    assert.equal(captured.body.instructions, '处理后系统提示');
    assert.equal(captured.body.input[0].content[0].text, '你好');
    const recentPrompt = await fetch(`http://127.0.0.1:${bridgePort}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(recentPrompt.original, 'x-anthropic-billing-header: test\n\n系统提示');
    assert.equal(recentPrompt.final, '处理后系统提示');
    assert.equal(recentPrompt.upstreamProtocol, 'responses');
    assert.deepEqual(recentPrompt.applied.map((item) => [item.name, item.count]), [['集成替换', 1]]);
    assert.deepEqual(recentPrompt.ruleResults.map((item) => [item.name, item.status, item.count]), [['集成替换', 'applied', 1]]);

    const logs = await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(logs.length, 1);
    assert.equal(logs[0].protocol, 'claude → responses');
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

    const sameClaude = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/messages`, {
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
    assert.equal(passthroughLogs[0].protocol, 'responses → responses');
    assert.equal(passthroughLogs[0].inputTokens, 4);
    assert.equal(passthroughLogs[0].outputTokens, 2);

    const sameResponses = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'responses-same', input: '同协议非流式扩展测试' })
    });
    assert.equal(sameResponses.status, 200);
    const sameResponsesBody = await sameResponses.json();
    assert.equal(sameResponsesBody.output[0].type, 'custom_tool_call');
    assert.deepEqual(sameResponsesBody.vendor_extension, { preserved: true });

    const unsupportedCrossProtocol = await fetch(`http://127.0.0.1:${bridgePort}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': createdClient.token },
      body: JSON.stringify({ model: 'claude-alias', input: '搜索', tools: [{ type: 'web_search' }] })
    });
    assert.equal(unsupportedCrossProtocol.status, 400);
    const unsupportedBody = await unsupportedCrossProtocol.json();
    assert.match(unsupportedBody.error.message, /web_search/);
    assert.equal(unsupportedBody.error.type, 'invalid_request_error');

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
