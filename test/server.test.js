import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

test('服务可启动并提供健康检查与管理页面', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/smoke-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, CONFIG_ENCRYPTION_KEY: 'integration-test-master-key', OPENCODE_BRIDGE_ADMIN_PASSWORD: '', OPENCODE_BRIDGE_TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => {
        child.stdout.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
        });
      }),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.ready, false);
    assert.equal(healthBody.configured, false);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /OpenCode Bridge/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const spec = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.match(spec.headers.get('content-type'), /application\/json/);
    assert.equal((await spec.json()).openapi, '3.1.0');
    const traversal = await fetch(`http://127.0.0.1:${port}/..%2Fsrc%2Fserver.js`);
    assert.ok([403, 404].includes(traversal.status));
    assert.doesNotMatch(await traversal.text(), /createServer/);

    const invalidSetup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'abc-12' }) });
    assert.equal(invalidSetup.status, 400);
    const setup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'testpassword123' }) });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.ok(setupBody.clientToken.length >= 24);
    assert.match(setupBody.clientToken, /^[A-Za-z0-9]+$/);
    const storedConfig = await readFile(configFile, 'utf8');
    assert.doesNotMatch(storedConfig, new RegExp(setupBody.clientToken));
    assert.match(storedConfig, /enc:v1:/);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const unauthenticatedStats = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(unauthenticatedStats.status, 401);
    const emptyStats = await fetch(`http://127.0.0.1:${port}/api/stats?window=24h`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(emptyStats.window, '24h');
    assert.equal(emptyStats.summary.requests, 0);
    assert.deepEqual(emptyStats.byProvider, []);
    const invalidStatsWindow = await fetch(`http://127.0.0.1:${port}/api/stats?window=month`, { headers: { cookie } });
    assert.equal(invalidStatsWindow.status, 400);
    const redactedConfig = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((result) => result.json());
    assert.notEqual(redactedConfig.clientToken, setupBody.clientToken);
    assert.doesNotMatch(JSON.stringify(redactedConfig), new RegExp(setupBody.clientToken));
    assert.equal(redactedConfig.encryptionEnabled, true);
    assert.equal(redactedConfig.persistLogs, false);
    assert.equal(redactedConfig.promptRewriteRules.length, 2);
    assert.equal(redactedConfig.promptRewriteDefaults.length, 2);
    assert.equal(redactedConfig.zenProxyUrl, '');
    assert.equal(redactedConfig.goProxyUrl, '');
    assert.equal(redactedConfig.zenProxyConfigured, false);

    const invalidCredential = await fetch(`http://127.0.0.1:${port}/api/provider-credentials`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', name: '错误代理', apiKey: 'panel-secret', proxyUrl: 'ftp://bad' }) });
    assert.equal(invalidCredential.status, 400);
    const invalidConnectionProvider = await fetch(`http://127.0.0.1:${port}/api/models/test`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'typo', apiKey: 'secret' }) });
    assert.equal(invalidConnectionProvider.status, 400);
    const invalidConnectionKey = await fetch(`http://127.0.0.1:${port}/api/models/test`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', apiKey: { secret: true } }) });
    assert.equal(invalidConnectionKey.status, 400);
    assert.match((await invalidConnectionKey.json()).error, /API Key 必须是字符串/);
    const createdCredentialResponse = await fetch(`http://127.0.0.1:${port}/api/provider-credentials`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', name: '主力套餐', apiKey: 'panel-secret', proxyUrl: 'socks5h://user:pass@127.0.0.1:1080' }) });
    assert.equal(createdCredentialResponse.status, 201);
    const createdCredentialConfig = await createdCredentialResponse.json();
    assert.equal(createdCredentialConfig.zenCredentials.length, 1);
    assert.equal(createdCredentialConfig.zenCredentials[0].name, '主力套餐');
    assert.equal(createdCredentialConfig.zenCredentials[0].apiKey, 'pa••••et');
    assert.equal(createdCredentialConfig.zenCredentials[0].proxyUrl, 'socks5h://••••@127.0.0.1:1080');
    assert.doesNotMatch(JSON.stringify(createdCredentialConfig), /panel-secret|user:pass/);
    assert.doesNotMatch(await readFile(configFile, 'utf8'), /panel-secret|user:pass/);
    const credentialId = createdCredentialConfig.zenCredentials[0].id;
    const updatedCredential = await fetch(`http://127.0.0.1:${port}/api/provider-credentials/zen/${credentialId}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '主力套餐 2', apiKey: '', proxyUrl: '' }) }).then((response) => response.json());
    assert.equal(updatedCredential.zenCredentials[0].name, '主力套餐 2');
    assert.equal(updatedCredential.zenCredentials[0].apiKey, createdCredentialConfig.zenCredentials[0].apiKey);
    assert.equal(updatedCredential.zenCredentials[0].proxyConfigured, false);
    const duplicateCredential = await fetch(`http://127.0.0.1:${port}/api/provider-credentials`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', name: '主力套餐 2', apiKey: 'another-secret' }) });
    assert.equal(duplicateCredential.status, 409);
    const deletedCredential = await fetch(`http://127.0.0.1:${port}/api/provider-credentials/zen/${credentialId}`, { method: 'DELETE', headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(deletedCredential.zenCredentials, []);

    const invalidProxy = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, zenProxyUrl: 'ftp://127.0.0.1:21' }) });
    assert.equal(invalidProxy.status, 400);
    const validProxy = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, proxyUrl: '127.0.0.1:7890', zenProxyUrl: 'socks5h://user:pass@127.0.0.1:1080', goProxyUrl: '' }) });
    assert.equal(validProxy.status, 200);
    const proxyConfig = await validProxy.json();
    assert.equal(proxyConfig.proxyUrl, 'http://127.0.0.1:7890');
    assert.equal(proxyConfig.zenProxyUrl, 'socks5h://••••@127.0.0.1:1080');
    assert.equal(proxyConfig.proxyConfigured, true);
    assert.equal(proxyConfig.zenProxyConfigured, true);
    assert.doesNotMatch(JSON.stringify(proxyConfig), /user:pass/);
    assert.doesNotMatch(await readFile(configFile, 'utf8'), /user:pass/);
    const clearedProxy = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, clearZenProxy: true }) }).then((result) => result.json());
    assert.equal(clearedProxy.zenProxyConfigured, false);

    const invalidRoute = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', proxyUrl: '', modelRoutes: { bad: { protocol: 'invalid' } } }) });
    assert.equal(invalidRoute.status, 400);
    const invalidImageHandoff = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, imageHandoffModels: [{ provider: 'other', model: 'bad' }] }) });
    assert.equal(invalidImageHandoff.status, 400);
    assert.match((await invalidImageHandoff.json()).error, /provider 无效/);
    const invalidToolFallback = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', proxyUrl: '', modelRoutes: { bad: { toolChoiceFallback: 'required' } } }) });
    assert.equal(invalidToolFallback.status, 400);
    const invalidPromptRule = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', proxyUrl: '', modelRoutes: {}, promptRewriteRules: [{ name: '空规则', find: '' }] }) });
    assert.equal(invalidPromptRule.status, 400);
    const invalidNumericSetting = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, requestLogLimit: 10.5 }) });
    assert.equal(invalidNumericSetting.status, 400);
    assert.match((await invalidNumericSetting.json()).error, /整数/);
    const invalidBooleanSetting = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, persistLogs: 'false' }) });
    assert.equal(invalidBooleanSetting.status, 400);
    const invalidSecretType = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, zenKey: { value: 'secret' } }) });
    assert.equal(invalidSecretType.status, 400);
    const invalidClientToken = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, clientToken: 'abc-12' }) });
    assert.equal(invalidClientToken.status, 400);

    const invalidClient = await fetch(`http://127.0.0.1:${port}/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '错误客户端', maxConcurrentRequests: 1.5 }) });
    assert.equal(invalidClient.status, 400);
    const validClient = await fetch(`http://127.0.0.1:${port}/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '配置测试客户端', maxConcurrentRequests: 3 }) }).then((result) => result.json());
    const invalidEnabled = await fetch(`http://127.0.0.1:${port}/api/clients/${validClient.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ enabled: 'false' }) });
    assert.equal(invalidEnabled.status, 400);

    const promptPreview = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/preview`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ original: '删除我，替换我', rules: [{ name: '删除', find: '删除我，', replace: '' }, { name: '替换', find: '替换我', replace: '完成' }] }) }).then((result) => result.json());
    assert.equal(promptPreview.final, '完成');
    assert.equal(promptPreview.applied.length, 2);
    assert.deepEqual(promptPreview.ruleResults.map((item) => item.status), ['applied', 'applied']);
    const emptyRecent = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, { headers: { cookie } }).then((result) => result.json());
    assert.deepEqual(emptyRecent, {});

    const crossOrigin = await fetch(`http://127.0.0.1:${port}/api/token/regenerate`, { method: 'POST', headers: { cookie, origin: 'https://malicious.example' } });
    assert.equal(crossOrigin.status, 403);

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(models.status, 503);
    const invalidPublicProvider = await fetch(`http://127.0.0.1:${port}/v1/models?provider=typo`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(invalidPublicProvider.status, 400);
    assert.match((await invalidPublicProvider.json()).error.message, /provider 仅支持 zen、go 或 all/);
    const invalidLookupProvider = await fetch(`http://127.0.0.1:${port}/v1/models/example?provider=typo`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(invalidLookupProvider.status, 400);
    assert.match((await invalidLookupProvider.json()).error.message, /provider 仅支持 zen 或 go/);
    const invalidAdminProvider = await fetch(`http://127.0.0.1:${port}/api/models?provider=typo`, { headers: { cookie } });
    assert.equal(invalidAdminProvider.status, 400);

    const wrongModelsMethod = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: 'POST' });
    assert.equal(wrongModelsMethod.status, 405);
    assert.equal(wrongModelsMethod.headers.get('allow'), 'GET');
    assert.deepEqual(await wrongModelsMethod.json(), { error: { message: '该接口仅支持 GET', type: 'invalid_request_error', code: null } });

    const wrongClaudeMethod = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`);
    assert.equal(wrongClaudeMethod.status, 405);
    assert.equal(wrongClaudeMethod.headers.get('allow'), 'POST');
    assert.deepEqual(await wrongClaudeMethod.json(), { type: 'error', error: { type: 'invalid_request_error', message: '该接口仅支持 POST' } });

    const wrongResponsesMethod = await fetch(`http://127.0.0.1:${port}/go/v1/responses`);
    assert.equal(wrongResponsesMethod.status, 405);
    assert.equal(wrongResponsesMethod.headers.get('allow'), 'POST');
    assert.deepEqual(await wrongResponsesMethod.json(), { error: { message: '该接口仅支持 POST', type: 'invalid_request_error', code: null } });

    const unauthorizedClaude = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [] }) });
    assert.equal(unauthorizedClaude.status, 401);
    assert.deepEqual(await unauthorizedClaude.json(), { type: 'error', error: { type: 'authentication_error', message: '访问令牌无效' } });

    const malformedClaude = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setupBody.clientToken }, body: '{broken' });
    assert.equal(malformedClaude.status, 400);
    assert.deepEqual(await malformedClaude.json(), { type: 'error', error: { type: 'invalid_request_error', message: 'JSON 格式无效' } });
    const oversizedModel = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` }, body: JSON.stringify({ model: 'x'.repeat(257), input: 'test' }) });
    assert.equal(oversizedModel.status, 400);
    assert.match((await oversizedModel.json()).error.message, /1–256/);
    const emptyPrefixedModel = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` }, body: JSON.stringify({ model: 'opencode-go/', input: 'test' }) });
    assert.equal(emptyPrefixedModel.status, 400);
    assert.match((await emptyPrefixedModel.json()).error.message, /上游模型名不能为空/);
    const oversizedModelLookup = await fetch(`http://127.0.0.1:${port}/v1/models/${'x'.repeat(257)}`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(oversizedModelLookup.status, 400);

    const logout = await fetch(`http://127.0.0.1:${port}/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    const wrongLogin = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrongpassword' }) });
    assert.equal(wrongLogin.status, 401);
    const correctLogin = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password: 'testpassword123' }) });
    assert.equal(correctLogin.status, 200);
    assert.match(correctLogin.headers.get('set-cookie'), /HttpOnly/);
    assert.doesNotMatch(correctLogin.headers.get('set-cookie'), /; Secure/);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('流式上游中途断开会向客户端发送协议错误并写入失败日志', { timeout: 10_000 }, async () => {
  let upstreamCalls = 0;
  let resolveDelayedRequest;
  const delayedRequest = new Promise((resolveRequest) => { resolveDelayedRequest = resolveRequest; });
  const upstream = createHttpServer((req, res) => {
    if (req.url === '/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', sequence_number: 12,
        response: { id: 'resp_broken', object: 'response', status: 'in_progress', model: 'response-stream', output: [] }
      })}\n\n`);
      return res.end();
    }
    upstreamCalls++;
    if (upstreamCalls === 7) {
      resolveDelayedRequest();
      const delayedResponse = setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify({ error: { message: '不应到达客户端' } }));
      }, 1_000);
      res.once('close', () => clearTimeout(delayedResponse));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({
      id: 'chat_broken', model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }]
    })}\n\n`);
    if (upstreamCalls <= 2) setImmediate(() => res.destroy());
    else if (upstreamCalls === 4 || upstreamCalls === 6) {
      res.end(`data: ${JSON.stringify({
        id: 'chat_media', model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }]
      })}\n\n`);
    }
    else if (upstreamCalls === 5) res.end();
    else {
      res.end(`data: ${JSON.stringify({
        id: 'chat_recovered', model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 }
      })}\n\ndata: [DONE]\n\n`);
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/stream-failure-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'stream-failure-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY_1: 'zen-stream-key',
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);

    const direct = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(direct.status, 200);
    const directText = await direct.text();
    assert.match(directText, /"type":"upstream_error"/);
    assert.match(directText, /data: \[DONE\]/);

    const translated = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(translated.status, 200);
    const translatedText = await translated.text();
    assert.match(translatedText, /event: error/);
    assert.match(translatedText, /"type":"upstream_error"/);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 2, JSON.stringify(logs, null, 2));
    assert.ok(logs.every((item) => item.status === 502 && item.stream && item.error));
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(stats.summary.errors, 2);
    assert.equal(stats.credentialHealth[0].consecutiveFailures, 2);

    const recovered = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'recover' }] })
    });
    const recoveredText = await recovered.text();
    assert.equal(recovered.status, 200);
    assert.doesNotMatch(recoveredText, /upstream_error/);
    assert.match(recoveredText, /data: \[DONE\]/);
    const recoveredStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(recoveredStats.summary.requests, 3);
    assert.equal(recoveredStats.summary.errors, 2);
    assert.equal(recoveredStats.credentialHealth[0].consecutiveFailures, 0);

    const unsupportedMedia = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'media' }] })
    });
    const unsupportedMediaText = await unsupportedMedia.text();
    assert.match(unsupportedMediaText, /event: error/);
    assert.match(unsupportedMediaText, /image_url/);
    const mediaStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(mediaStats.summary.requests, 4);
    assert.equal(mediaStats.summary.errors, 3);
    assert.equal(mediaStats.credentialHealth[0].consecutiveFailures, 0);

    const cleanlyTruncated = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'truncate cleanly' }] })
    });
    const cleanlyTruncatedText = await cleanlyTruncated.text();
    assert.equal(cleanlyTruncated.status, 200);
    assert.match(cleanlyTruncatedText, /上游 SSE 在完成事件前结束/);
    assert.match(cleanlyTruncatedText, /data: \[DONE\]/);
    const truncatedStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(truncatedStats.summary.requests, 5);
    assert.equal(truncatedStats.summary.errors, 4);
    assert.equal(truncatedStats.credentialHealth[0].consecutiveFailures, 1);

    const crossProtocolTruncated = await fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, input: 'trigger unsupported stream content' })
    });
    const crossProtocolText = await crossProtocolTruncated.text();
    assert.equal(crossProtocolTruncated.status, 200);
    const crossProtocolEvents = crossProtocolText.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
    assert.deepEqual(crossProtocolEvents.map((event) => event.sequence_number), [0, 1, 2, 3, 4]);
    assert.deepEqual(crossProtocolEvents.at(-1), { type: 'error', code: 'upstream_error', message: '跨协议转换无法表达 Chat 流式内容块：image_url', param: null, sequence_number: 4 });

    const responseRoute = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: { 'response-stream': { protocol: 'responses' } } })
    });
    assert.equal(responseRoute.status, 200);
    const responsesTruncated = await fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'response-stream', stream: true, input: 'truncate Responses stream' })
    });
    const responsesTruncatedText = await responsesTruncated.text();
    assert.equal(responsesTruncated.status, 200);
    const responseEvents = responsesTruncatedText.split(/\n\n/).filter(Boolean).map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
    assert.deepEqual(responseEvents.map((event) => event.sequence_number), [12, 13]);
    assert.deepEqual(responseEvents.at(-1), { type: 'error', code: 'upstream_error', message: '上游 SSE 在完成事件前结束', param: null, sequence_number: 13 });

    const cancellation = new AbortController();
    const canceledRequest = fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', signal: cancellation.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'cancel before headers' }] })
    });
    await delayedRequest;
    cancellation.abort();
    await assert.rejects(canceledRequest, (error) => error.name === 'AbortError');
    let canceledStats;
    for (let attempt = 0; attempt < 20; attempt++) {
      canceledStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
      if (canceledStats.summary.requests === 8) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(canceledStats.summary.requests, 8);
    assert.equal(canceledStats.summary.errors, 7);
    assert.equal(canceledStats.credentialHealth[0].consecutiveFailures, 2);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('SIGTERM 会等待活动请求完成并最终刷新持久化日志', {
  timeout: 10_000,
  skip: process.platform === 'win32' ? 'Windows 不会向子进程传递 POSIX SIGTERM' : false
}, async () => {
  let markUpstreamReceived;
  const upstreamReceived = new Promise((resolveReceived) => { markUpstreamReceived = resolveReceived; });
  const upstream = createHttpServer((req, res) => {
    markUpstreamReceived();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chat_shutdown', model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      }));
    }, 150);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const suffix = randomUUID();
  const configFile = resolve(import.meta.dirname, `../data/shutdown-${suffix}.json`);
  const logFile = resolve(import.meta.dirname, `../data/shutdown-logs-${suffix}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, LOG_FILE: logFile,
    CONFIG_ENCRYPTION_KEY: 'shutdown-integration-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY_1: 'zen-shutdown-key',
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString('utf8'); });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, persistLogs: true })
    });
    assert.equal(configured.status, 200);

    const pendingResponse = fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'finish before shutdown' }] })
    });
    await upstreamReceived;
    child.kill('SIGTERM');
    const response = await pendingResponse.catch((error) => {
      throw new Error(`活动请求在退出时失败：${error.message}\n${childOutput}`);
    });
    assert.equal(response.status, 200);
    await response.text();
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0);
    const logs = JSON.parse(await readFile(logFile, 'utf8'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].model, 'deepseek-v4-flash');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(logFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('可从 Render 环境变量引导完整配置且敏感值加密落盘', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/render-${randomUUID()}.json`);
  const adminPassword = 'Admin123';
  const clientToken = 'Api123';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
      CONFIG_ENCRYPTION_KEY: 'render-integration-master-key',
      OPENCODE_BRIDGE_ADMIN_PASSWORD: adminPassword,
      OPENCODE_BRIDGE_CLIENT_TOKEN: clientToken,
      OPENCODE_ZEN_KEY: 'render-zen-secret',
      OPENCODE_GO_KEY: '',
      OPENCODE_ZEN_PROXY_URL: '',
      OPENCODE_BRIDGE_TRUST_PROXY: 'true',
      OPENCODE_BRIDGE_DEFAULT_PROVIDER: 'zen'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => {
        child.stdout.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
        });
      }),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.ready, true);
    assert.equal(health.configured, true);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https, http' }, body: JSON.stringify({ password: adminPassword })
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const runtimeConfig = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(runtimeConfig.clientToken, '••••');
    const authenticated = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${clientToken}` }, body: '{}'
    });
    assert.equal(authenticated.status, 400);
    const stored = await readFile(configFile, 'utf8');
    assert.match(stored, /enc:v1:/);
    assert.doesNotMatch(stored, new RegExp(`${adminPassword}|${clientToken}|render-zen-secret`));
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('Render 强制环境引导会拒绝缺少管理密码或客户端令牌的启动', { timeout: 10_000 }, async () => {
  const scenarios = [
    { name: '管理密码', adminPassword: '', clientToken: 'Api123', pattern: /OPENCODE_BRIDGE_ADMIN_PASSWORD/ },
    { name: '客户端令牌', adminPassword: 'Admin123', clientToken: '', pattern: /OPENCODE_BRIDGE_CLIENT_TOKEN/ }
  ];
  for (const scenario of scenarios) {
    const configFile = resolve(import.meta.dirname, `../data/render-required-${randomUUID()}.json`);
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        HOST: '127.0.0.1', PORT: String(20_000 + Math.floor(Math.random() * 10_000)), CONFIG_FILE: configFile,
        CONFIG_ENCRYPTION_KEY: 'render-required-master-key',
        OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP: 'true',
        OPENCODE_BRIDGE_ADMIN_PASSWORD: scenario.adminPassword,
        OPENCODE_BRIDGE_CLIENT_TOKEN: scenario.clientToken
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    try {
      const [code] = await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`缺少${scenario.name}时服务未按预期退出`)), 5_000))
      ]);
      assert.notEqual(code, 0);
      assert.match(output, scenario.pattern);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit').catch(() => {});
      }
      await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
});

test('日志持久化写盘失败时后台仍可读取内存日志', { timeout: 10_000 }, async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-log-failure', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/log-failure-${randomUUID()}.json`);
  const blocker = resolve(import.meta.dirname, `../data/log-blocker-${randomUUID()}`);
  const logFile = resolve(blocker, 'request-logs.json');
  await writeFile(blocker, 'not a directory', 'utf8');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, LOG_FILE: logFile,
      CONFIG_ENCRYPTION_KEY: 'log-failure-master-key',
      OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123', OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
      OPENCODE_BRIDGE_DEFAULT_PROVIDER: 'go', OPENCODE_GO_KEY: 'log-failure-key',
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const proxy = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'log this request' })
    });
    assert.equal(proxy.status, 200);
    await proxy.json();
    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'go', modelRoutes: {}, persistLogs: true })
    });
    assert.equal(configured.status, 200);
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } });
    assert.equal(logs.status, 200);
    assert.equal((await logs.json()).length, 1);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.match(status.logPersistenceError, /无法写入持久化日志/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(blocker).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('编号环境变量 Key 会按提供方轮询并在面板显示数量', { timeout: 10_000 }, async () => {
  const authorizations = [];
  const upstream = createHttpServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_env', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/environment-pool-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'environment-pool-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY_1: 'zen-key-one',
    OPENCODE_ZEN_KEY_2: 'zen-key-two',
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(authorizations, ['Bearer zen-key-one', 'Bearer zen-key-two']);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const config = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(config.zenEnvironmentKeyCount, 2);
    assert.equal(config.goEnvironmentKeyCount, 0);
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(logs.map((item) => item.credentialId), ['environment:2', 'environment:1']);
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(stats.byCredential.map((item) => item.name).sort(), ['ZEN 环境 #1', 'ZEN 环境 #2']);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('面板多 Key 会安全加密、轮询并按名称统计', { timeout: 10_000 }, async () => {
  const authorizations = [];
  const upstream = createHttpServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_panel', object: 'response', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/panel-pool-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'panel-pool-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const [name, apiKey] of [['主力', 'panel-key-one'], ['备用', 'panel-key-two']]) {
      const created = await fetch(`http://127.0.0.1:${port}/api/provider-credentials`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zen', name, apiKey })
      });
      assert.equal(created.status, 201);
    }
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(authorizations, ['Bearer panel-key-one', 'Bearer panel-key-two', 'Bearer panel-key-one']);
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(stats.byCredential.map((item) => item.name).sort(), ['ZEN · 主力', 'ZEN · 备用'].sort());
    assert.deepEqual(stats.credentialHealth.map((item) => item.state), ['healthy', 'healthy']);
    const stored = await readFile(configFile, 'utf8');
    assert.doesNotMatch(stored, /panel-key-one|panel-key-two/);
    assert.equal((stored.match(/enc:v1:/g) || []).length >= 4, true);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('鉴权失败的环境 Key 会在当前请求内切换并进入冷却', { timeout: 10_000 }, async () => {
  const authorizations = [];
  const upstream = createHttpServer((req, res) => {
    const authorization = req.headers.authorization;
    authorizations.push(authorization);
    if (authorization === 'Bearer rejected-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'resp_ok', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/key-health-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'key-health-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY_1: 'rejected-key',
    OPENCODE_GO_KEY_2: 'healthy-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const request = () => fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: 'ping' })
    });
    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('x-opencode-key-attempts'), '2');
    const healthyResponse = await request();
    assert.equal(healthyResponse.status, 200);
    assert.equal(healthyResponse.headers.get('x-opencode-key-attempts'), null);
    assert.deepEqual(authorizations, ['Bearer rejected-key', 'Bearer healthy-key', 'Bearer healthy-key']);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    const rejected = stats.credentialHealth.find((item) => item.credentialId === 'environment:1');
    const healthy = stats.credentialHealth.find((item) => item.credentialId === 'environment:2');
    assert.equal(rejected.state, 'cooldown');
    assert.equal(rejected.lastFailureKind, 'auth');
    assert.equal(healthy.state, 'healthy');
    assert.equal(stats.summary.requests, 2);
    assert.equal(stats.summary.failoverRequests, 1);
    assert.equal(stats.summary.failoverAttempts, 1);
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(logs.map((item) => item.credentialAttempts), [1, 2]);
    assert.doesNotMatch(JSON.stringify(stats.credentialHealth), /rejected-key|healthy-key/);

    const missingReset = await fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:99' })
    });
    assert.equal(missingReset.status, 404);
    const reset = await fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:1' })
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).credential.state, 'unknown');
    const resetStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(resetStats.credentialHealth.find((item) => item.credentialId === 'environment:1').state, 'unknown');
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('推理 5xx 不会重放，但模型发现会安全切换 Key', { timeout: 10_000 }, async () => {
  const authorizations = [];
  const upstream = createHttpServer((req, res) => {
    authorizations.push(req.headers.authorization);
    if (req.method === 'GET' && req.headers.authorization === 'Bearer first-key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'temporary upstream failure' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/key-no-replay-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'key-no-replay-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY_1: 'first-key',
    OPENCODE_GO_KEY_2: 'second-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: 'ping' })
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('x-opencode-key-attempts'), null);
    assert.deepEqual(authorizations, ['Bearer first-key']);

    const models = await fetch(`http://127.0.0.1:${port}/go/v1/models`, {
      headers: { authorization: 'Bearer Api123' }
    });
    assert.equal(models.status, 200);
    assert.equal(models.headers.get('x-opencode-key-attempts'), '2');
    assert.deepEqual((await models.json()).data.map((item) => item.id), ['gpt-test']);
    assert.deepEqual(authorizations, ['Bearer first-key', 'Bearer second-key', 'Bearer first-key']);

    const combined = await fetch(`http://127.0.0.1:${port}/v1/models?provider=all`, {
      headers: { authorization: 'Bearer Api123' }
    });
    assert.equal(combined.status, 200);
    assert.equal(combined.headers.get('x-opencode-key-attempts'), '2');
    assert.deepEqual((await combined.json()).data.map((item) => item.id), ['opencode-go/gpt-test']);
    assert.deepEqual(authorizations, ['Bearer first-key', 'Bearer second-key', 'Bearer first-key', 'Bearer second-key', 'Bearer first-key']);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('上游限流与追踪响应头会安全透传到同协议、跨协议和模型发现', { timeout: 10_000 }, async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '7',
      'x-request-id': `upstream-${req.headers.authorization === 'Bearer go-rate-key' ? 'go' : 'zen'}`,
      'x-ratelimit-remaining-requests': '0',
      'set-cookie': 'upstream-cookie=must-not-forward'
    });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/upstream-headers-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'upstream-headers-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-rate-key',
    OPENCODE_ZEN_KEY: 'zen-rate-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const models = await fetch(`http://127.0.0.1:${port}/api/models?provider=go`, { headers: { cookie } });
    assert.equal(models.status, 429);
    assert.equal(models.headers.get('retry-after'), '7');
    assert.equal(models.headers.get('x-opencode-upstream-request-id'), 'upstream-go');
    assert.equal(models.headers.get('x-ratelimit-remaining-requests'), '0');
    assert.equal(models.headers.get('set-cookie'), null);

    const reset = await fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:1' })
    });
    assert.equal(reset.status, 200);

    const sameProtocol = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(sameProtocol.status, 429);
    assert.equal(sameProtocol.headers.get('retry-after'), '7');
    assert.equal(sameProtocol.headers.get('x-opencode-upstream-request-id'), 'upstream-zen');
    assert.equal((await sameProtocol.json()).error.message, 'rate limited');

    const crossProtocol = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(crossProtocol.status, 429);
    assert.equal(crossProtocol.headers.get('retry-after'), '7');
    assert.equal(crossProtocol.headers.get('x-opencode-upstream-request-id'), 'upstream-go');
    assert.equal((await crossProtocol.json()).type, 'error');
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.deepEqual(logs.map((item) => item.upstreamRequestId), ['upstream-go', 'upstream-zen']);
    assert.deepEqual(logs.map((item) => item.retryAfter), ['7', '7']);
    assert.doesNotMatch(JSON.stringify(logs), /upstream-cookie/);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
