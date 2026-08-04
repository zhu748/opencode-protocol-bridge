import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';

test('服务可启动并提供健康检查与管理页面', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/smoke-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, CONFIG_ENCRYPTION_KEY: 'integration-test-master-key', OPENCODE_BRIDGE_ADMIN_PASSWORD: '' },
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

    const setup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password-123' }) });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.ok(setupBody.clientToken.length >= 24);
    const storedConfig = await readFile(configFile, 'utf8');
    assert.doesNotMatch(storedConfig, new RegExp(setupBody.clientToken));
    assert.match(storedConfig, /enc:v1:/);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
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
    const wrongLogin = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
    assert.equal(wrongLogin.status, 401);
    const correctLogin = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-password-123' }) });
    assert.equal(correctLogin.status, 200);
    assert.match(correctLogin.headers.get('set-cookie'), /HttpOnly/);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('可从 Render 环境变量引导完整配置且敏感值加密落盘', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/render-${randomUUID()}.json`);
  const adminPassword = 'render-admin-password';
  const clientToken = 'render-client-token-1234567890';
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: adminPassword })
    });
    assert.equal(login.status, 200);
    const authenticated = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${clientToken}` }, body: '{}'
    });
    assert.equal(authenticated.status, 400);
    const stored = await readFile(configFile, 'utf8');
    assert.match(stored, /enc:v1:/);
    assert.doesNotMatch(stored, /render-admin-password|render-client-token|render-zen-secret/);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
