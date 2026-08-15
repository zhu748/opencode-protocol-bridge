import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

async function rawHttpRequest(port, request) {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(3000, () => socket.destroy(new Error('原始 HTTP 请求等待响应超时')));
  await once(socket, 'connect');
  socket.end(request);
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('服务可启动并提供健康检查与管理页面', { timeout: 30_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/smoke-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, CONFIG_ENCRYPTION_KEY: 'integration-test-master-key', OPENCODE_BRIDGE_ADMIN_PASSWORD: '', OPENCODE_BRIDGE_TRUST_PROXY: '', OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS: '' },
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
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-request-id': 'client-controlled' } });
    assert.equal(health.status, 200);
    assert.match(health.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    assert.notEqual(health.headers.get('x-request-id'), 'client-controlled');
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.ready, false);
    assert.equal(healthBody.configured, false);
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal(healthz.headers.get('cache-control'), 'no-store');
    const healthzBody = await healthz.json();
    assert.equal(healthzBody.ok, healthBody.ok);
    assert.equal(healthzBody.ready, healthBody.ready);
    assert.equal(healthzBody.configured, healthBody.configured);
    const manyHeaders = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`x-test-${index}`, '1']));
    const excessiveHeaders = await fetch(`http://127.0.0.1:${port}/health`, { headers: manyHeaders });
    assert.equal(excessiveHeaders.status, 431);
    assert.match(excessiveHeaders.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    assert.match((await excessiveHeaders.json()).error, /128/);
    const conflictingFraming = await rawHttpRequest(port,
      'POST /api/setup HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n');
    assert.match(conflictingFraming, /^HTTP\/1\.1 400 Bad Request\r\n/);
    const missingHost = await rawHttpRequest(port, 'GET /health HTTP/1.1\r\nConnection: close\r\n\r\n');
    assert.match(missingHost, /^HTTP\/1\.1 400 Bad Request\r\n/);
    for (const target of ['http://attacker.invalid/health', '//attacker.invalid/health', '/\\attacker.invalid/health', '/health#fragment']) {
      const malformedTarget = await rawHttpRequest(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      assert.match(malformedTarget, /^HTTP\/1\.1 400 Bad Request\r\n/);
      assert.match(malformedTarget, /\r\nx-request-id: [a-f0-9]{32}\r\n/i);
    }
    const oversizedTarget = await rawHttpRequest(port, `GET /${'a'.repeat(9 * 1024)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    assert.match(oversizedTarget, /^HTTP\/1\.1 414 URI Too Long\r\n/);
    assert.match(oversizedTarget, /\r\nx-request-id: [a-f0-9]{32}\r\n/i);
    const excessiveQuery = Array.from({ length: 65 }, (_, index) => `q${index}=1`).join('&');
    const excessiveQueryResponse = await fetch(`http://127.0.0.1:${port}/health?${excessiveQuery}`);
    assert.equal(excessiveQueryResponse.status, 400);
    assert.match((await excessiveQueryResponse.json()).error, /64/);
    const duplicateProvider = await fetch(`http://127.0.0.1:${port}/v1/models?provider=zen&provider=go`);
    assert.equal(duplicateProvider.status, 400);
    assert.match((await duplicateProvider.json()).error, /provider.*不能重复/);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    assert.notEqual(page.headers.get('x-request-id'), health.headers.get('x-request-id'));
    assert.match(await page.text(), /OpenCode Bridge/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(page.headers.get('x-xss-protection'), '0');
    assert.equal(page.headers.get('strict-transport-security'), null);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('etag'), /^W\//);
    const pageHead = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    assert.equal(pageHead.status, 200);
    assert.equal(pageHead.headers.get('etag'), page.headers.get('etag'));
    assert.ok(Number(pageHead.headers.get('content-length')) > 0);
    assert.equal(await pageHead.text(), '');
    const notModified = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'if-none-match': page.headers.get('etag') } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), '');
    const wrongStaticMethod = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    assert.equal(wrongStaticMethod.status, 405);
    assert.equal(wrongStaticMethod.headers.get('allow'), 'GET, HEAD');
    const spec = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.match(spec.headers.get('content-type'), /application\/json/);
    assert.equal((await spec.json()).openapi, '3.1.0');
    const traversal = await fetch(`http://127.0.0.1:${port}/..%2Fsrc%2Fserver.js`);
    assert.ok([403, 404].includes(traversal.status));
    assert.match(traversal.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    assert.doesNotMatch(await traversal.text(), /createServer/);

    const wrongSetupMethod = await fetch(`http://127.0.0.1:${port}/api/setup`);
    assert.equal(wrongSetupMethod.status, 405);
    assert.equal(wrongSetupMethod.headers.get('allow'), 'POST');
    assert.match(wrongSetupMethod.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
    const wrongSetupHead = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'HEAD' });
    assert.equal(wrongSetupHead.status, 405);
    assert.ok(Number(wrongSetupHead.headers.get('content-length')) > 0);
    assert.equal(await wrongSetupHead.text(), '');

    const wrongMediaType = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ password: 'testpassword123' })
    });
    assert.equal(wrongMediaType.status, 415);
    assert.match((await wrongMediaType.json()).error, /Content-Type/);
    const compressedJson = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}'
    });
    assert.equal(compressedJson.status, 415);
    assert.match((await compressedJson.json()).error, /Content-Encoding/);
    const vendorJson = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/vnd.bridge+json; charset=utf-8' }, body: JSON.stringify({ password: 'abc-12' })
    });
    assert.equal(vendorJson.status, 400);

    const oversizedSetup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }) });
    assert.equal(oversizedSetup.status, 413);
    assert.match((await oversizedSetup.json()).error, /64 KiB/);
    const oversizedChunk = JSON.stringify({ padding: 'x'.repeat(64 * 1024) });
    const chunkedOversizedSetup = await rawHttpRequest(port, [
      'POST /api/setup HTTP/1.1',
      'Host: localhost',
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      oversizedChunk.length.toString(16),
      oversizedChunk,
      '0',
      '',
      ''
    ].join('\r\n'));
    assert.match(chunkedOversizedSetup, /^HTTP\/1\.1 413 Payload Too Large\r\n/);
    assert.match(chunkedOversizedSetup, /请求体超过 64 KiB 上限/);
    const invalidUtf8Setup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat([Buffer.from('{"password":"'), Buffer.from([0xff]), Buffer.from('"}')]) });
    assert.equal(invalidUtf8Setup.status, 400);
    assert.deepEqual(await invalidUtf8Setup.json(), { error: 'JSON 格式无效' });
    const deeplyNestedSetupBody = `${'{"x":'.repeat(257)}0${'}'.repeat(257)}`;
    const deeplyNestedSetup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: deeplyNestedSetupBody });
    assert.equal(deeplyNestedSetup.status, 400);
    assert.match((await deeplyNestedSetup.json()).error, /JSON 嵌套深度不能超过 256 层/);
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
    const duplicatedApiKey = await rawHttpRequest(port,
      'GET /v1/models HTTP/1.1\r\nHost: localhost\r\nx-api-key: first-token\r\nx-api-key: second-token\r\nConnection: close\r\n\r\n');
    assert.match(duplicatedApiKey, /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.match(duplicatedApiKey, /\r\nx-request-id: [a-f0-9]{32}\r\n/i);
    assert.match(duplicatedApiKey, /x-api-key[^\r\n]*不能重复/);
    const connectionStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.ok(connectionStatus.activeHttpConnections >= 1);
    assert.ok(connectionStatus.activeHttpRequests >= 1);
    assert.equal(connectionStatus.maxHttpConnections, 256);
    assert.equal(connectionStatus.streamWriteTimeoutMs, 30_000);
    assert.equal(connectionStatus.sseHeartbeatMs, 15_000);
    assert.equal(connectionStatus.activeInferenceRequests, 0);
    assert.equal(connectionStatus.activeStreamingRequests, 0);
    assert.equal(connectionStatus.activeUpstreamWaitRequests, 0);
    assert.equal(connectionStatus.activeEstablishedStreams, 0);
    assert.equal(connectionStatus.activeStreamWrites, 0);
    assert.equal(connectionStatus.oldestActiveInferenceMs, 0);
    assert.equal(connectionStatus.longestActiveStreamSilenceMs, 0);
    assert.equal(connectionStatus.activeStreamHeartbeats, 0);
    const wrongStatusMethod = await fetch(`http://127.0.0.1:${port}/api/status`, { method: 'POST', headers: { cookie } });
    assert.equal(wrongStatusMethod.status, 405);
    assert.equal(wrongStatusMethod.headers.get('allow'), 'GET');
    assert.deepEqual(await wrongStatusMethod.json(), { error: '该接口仅支持 GET' });
    const wrongConfigMethod = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PATCH', headers: { cookie } });
    assert.equal(wrongConfigMethod.status, 405);
    assert.equal(wrongConfigMethod.headers.get('allow'), 'GET, PUT');
    const unauthenticatedStats = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(unauthenticatedStats.status, 401);
    const emptyStats = await fetch(`http://127.0.0.1:${port}/api/stats?window=24h&timezoneOffsetMinutes=-480`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(emptyStats.window, '24h');
    assert.equal(emptyStats.timezoneOffsetMinutes, -480);
    assert.equal(emptyStats.summary.requests, 0);
    assert.deepEqual(emptyStats.byProvider, []);
    const invalidStatsWindow = await fetch(`http://127.0.0.1:${port}/api/stats?window=month`, { headers: { cookie } });
    assert.equal(invalidStatsWindow.status, 400);
    const invalidStatsTimezone = await fetch(`http://127.0.0.1:${port}/api/stats?timezoneOffsetMinutes=841`, { headers: { cookie } });
    assert.equal(invalidStatsTimezone.status, 400);
    const redactedConfigResponse = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } });
    const redactedConfig = await redactedConfigResponse.json();
    assert.equal(typeof redactedConfig.singBoxRuntime?.available, 'boolean');
    assert.doesNotMatch(JSON.stringify(redactedConfig.singBoxRuntime), /vendor|sing-box\.exe|[A-Z]:\\/i);
    assert.notEqual(redactedConfig.clientToken, setupBody.clientToken);
    assert.doesNotMatch(JSON.stringify(redactedConfig), new RegExp(setupBody.clientToken));
    assert.equal(redactedConfig.encryptionEnabled, true);
    assert.equal(redactedConfig.persistLogs, false);
    assert.equal(redactedConfig.forceMaximumReasoningEffort, true);
    assert.equal(redactedConfig.upstreamStreamIdleTimeoutMs, 300000);
    assert.equal(redactedConfig.promptRewriteRules.length, 3);
    assert.equal(redactedConfig.promptRewriteDefaults.length, 3);
    assert.equal(redactedConfig.zenProxyUrl, '');
    assert.equal(redactedConfig.goProxyUrl, '');
    assert.equal(redactedConfig.zenProxyConfigured, false);
    assert.equal(typeof redactedConfig.zenConfigured, 'boolean');
    assert.equal(typeof redactedConfig.goConfigured, 'boolean');
    assert.match(redactedConfig.revision, /^[a-f0-9]{32}$/);
    assert.equal(redactedConfigResponse.headers.get('etag'), `"${redactedConfig.revision}"`);

    const malformedRevision = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'if-match': 'not-an-etag' },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {} })
    });
    assert.equal(malformedRevision.status, 400);
    assert.match((await malformedRevision.json()).error, /If-Match/);

    const concurrentConfigWrites = await Promise.all([101, 102].map((requestLogLimit) => fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'if-match': `"${redactedConfig.revision}"` },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, requestLogLimit })
    })));
    assert.deepEqual(concurrentConfigWrites.map((response) => response.status).sort(), [200, 412]);
    const configWriteBodies = await Promise.all(concurrentConfigWrites.map((response) => response.json()));
    const acceptedConfig = configWriteBodies[concurrentConfigWrites.findIndex((response) => response.status === 200)];
    const rejectedConfig = configWriteBodies[concurrentConfigWrites.findIndex((response) => response.status === 412)];
    assert.notEqual(acceptedConfig.revision, redactedConfig.revision);
    assert.equal(concurrentConfigWrites.find((response) => response.status === 200).headers.get('etag'), `"${acceptedConfig.revision}"`);
    assert.match(rejectedConfig.error, /其他页面修改/);
    const configAfterConflict = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(configAfterConflict.revision, acceptedConfig.revision);
    assert.equal(configAfterConflict.requestLogLimit, acceptedConfig.requestLogLimit);

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
    const invalidStreamIdleTimeout = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, upstreamStreamIdleTimeoutMs: 999 }) });
    assert.equal(invalidStreamIdleTimeout.status, 400);
    assert.match((await invalidStreamIdleTimeout.json()).error, /0 或 1000–3600000/);
    const invalidKeepAlive = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, keepAliveUrl: 'file:///tmp/healthz' }) });
    assert.equal(invalidKeepAlive.status, 400);
    const enabledKeepAlive = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, keepAliveUrl: `http://127.0.0.1:${port}/healthz`, keepAliveIntervalSeconds: 5 }) });
    assert.equal(enabledKeepAlive.status, 200);
    let keepAliveStatus;
    for (let attempt = 0; attempt < 50; attempt++) {
      keepAliveStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
      if (keepAliveStatus.keepAlive?.lastStatus === 200) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(keepAliveStatus.keepAlive?.lastStatus, 200);
    assert.equal(keepAliveStatus.keepAlive?.enabled, true);
    const disabledKeepAlive = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, keepAliveUrl: '', keepAliveIntervalSeconds: 60 }) }).then((response) => response.json());
    assert.equal(disabledKeepAlive.keepAliveStatus.enabled, false);
    const invalidBooleanSetting = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, persistLogs: 'false' }) });
    assert.equal(invalidBooleanSetting.status, 400);
    const invalidReasoningSetting = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, forceMaximumReasoningEffort: 'true' }) });
    assert.equal(invalidReasoningSetting.status, 400);
    const invalidSecretType = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, zenKey: { value: 'secret' } }) });
    assert.equal(invalidSecretType.status, 400);
    const invalidClientToken = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, clientToken: 'abc-12' }) });
    assert.equal(invalidClientToken.status, 400);

    const invalidClient = await fetch(`http://127.0.0.1:${port}/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '错误客户端', maxConcurrentRequests: 1.5 }) });
    assert.equal(invalidClient.status, 400);
    const validClient = await fetch(`http://127.0.0.1:${port}/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: '配置测试客户端', maxConcurrentRequests: 3 }) }).then((result) => result.json());
    const wrongClientMethod = await fetch(`http://127.0.0.1:${port}/api/clients/${validClient.id}`, { headers: { cookie } });
    assert.equal(wrongClientMethod.status, 405);
    assert.equal(wrongClientMethod.headers.get('allow'), 'PUT, DELETE');
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
    const wrongSchemeOrigin = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, { method: 'DELETE', headers: { cookie, origin: `https://127.0.0.1:${port}` } });
    assert.equal(wrongSchemeOrigin.status, 403);
    const crossSiteMetadata = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSiteMetadata.status, 403);
    const sameOriginMutation = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, { method: 'DELETE', headers: { cookie, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(sameOriginMutation.status, 200);

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

    const wrongClaudeMedia = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'text/plain', 'x-api-key': setupBody.clientToken },
      body: JSON.stringify({ model: 'x', messages: [] })
    });
    assert.equal(wrongClaudeMedia.status, 415);
    assert.match((await wrongClaudeMedia.json()).error.message, /Content-Type/);

    const malformedClaude = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setupBody.clientToken }, body: '{broken' });
    assert.equal(malformedClaude.status, 400);
    assert.deepEqual(await malformedClaude.json(), { type: 'error', error: { type: 'invalid_request_error', message: 'JSON 格式无效' } });
    const excessiveJsonNodes = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setupBody.clientToken },
      body: JSON.stringify({ model: 'x', input: Array(250_000).fill(0) })
    });
    assert.equal(excessiveJsonNodes.status, 413);
    assert.match((await excessiveJsonNodes.json()).error.message, /JSON 结构不能超过 250000 个值/);
    for (const [path, request] of [
      ['/go/v1/messages', { model: 'x', stream: 'false', max_tokens: 1, messages: [] }],
      ['/go/v1/responses', { model: 'x', stream: 1, input: 'test' }],
      ['/go/v1/chat/completions', { model: 'x', stream: null, messages: [] }]
    ]) {
      const invalidStream = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
        body: JSON.stringify(request)
      });
      assert.equal(invalidStream.status, 400);
      assert.match(JSON.stringify(await invalidStream.json()), /stream 必须是布尔值/);
    }
    for (const [path, request, message] of [
      ['/go/v1/messages', {
        model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'run', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: 'false' }
      }, /disable_parallel_tool_use 必须是布尔值/],
      ['/go/v1/responses', {
        model: 'x', input: 'test', parallel_tool_calls: 1,
        tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }]
      }, /parallel_tool_calls 必须是布尔值/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'test' }], logprobs: 'true'
      }, /logprobs 必须是布尔值/],
      ['/go/v1/responses', {
        model: 'x', input: 'test', max_output_tokens: 0
      }, /max_output_tokens/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'test' }], tool_choice: 1
      }, /Chat tool_choice 必须是对象/],
      ['/go/v1/messages', {
        model: 'x', max_tokens: 1, messages: { role: 'user', content: 'test' }
      }, /Claude messages 必须是数组/],
      ['/go/v1/responses', {
        model: 'x', input: { role: 'user', content: 'test' }
      }, /Responses input 必须是字符串或输入项数组/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'test' }], stop: 1
      }, /Chat stop 必须是字符串或字符串数组/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'user', content: 'test' }], metadata: { nested: { value: 'x' } }
      }, /Responses metadata\.nested.*字符串/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'assistant', content: null, tool_calls: [null] }]
      }, /tool_calls\[0\] 必须是对象/],
      ['/go/v1/chat/completions', {
        model: 'gpt-test', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{bad' } }] }]
      }, /function\.arguments 必须是对象/],
      ['/go/v1/responses', {
        model: 'x', input: [{ type: 'function_call', name: 'run', arguments: '{}' }]
      }, /function_call\.call_id\/id 必须是非空字符串/]
    ]) {
      const invalidCrossProtocolControl = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
        body: JSON.stringify(request)
      });
      assert.equal(invalidCrossProtocolControl.status, 400);
      assert.match(JSON.stringify(await invalidCrossProtocolControl.json()), message);
    }
    const geminiReservedFields = await fetch(`http://127.0.0.1:${port}/go/v1beta/models/x:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': setupBody.clientToken },
      body: JSON.stringify({ model: 'other', stream: true, contents: [{ role: 'user', parts: [{ text: 'test' }] }] })
    });
    assert.equal(geminiReservedFields.status, 400);
    assert.match(JSON.stringify(await geminiReservedFields.json()), /由 URL 决定的字段：model, stream/);
    const oversizedModel = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` }, body: JSON.stringify({ model: 'x'.repeat(257), input: 'test' }) });
    assert.equal(oversizedModel.status, 400);
    assert.match((await oversizedModel.json()).error.message, /1–256/);
    const controlCharacterModel = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` }, body: JSON.stringify({ model: 'bad\nmodel', input: 'test' }) });
    assert.equal(controlCharacterModel.status, 400);
    assert.match((await controlCharacterModel.json()).error.message, /控制字符/);
    const emptyPrefixedModel = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` }, body: JSON.stringify({ model: 'opencode-go/', input: 'test' }) });
    assert.equal(emptyPrefixedModel.status, 400);
    assert.match((await emptyPrefixedModel.json()).error.message, /上游模型名不能为空/);
    const oversizedModelLookup = await fetch(`http://127.0.0.1:${port}/v1/models/${'x'.repeat(257)}`, { headers: { authorization: `Bearer ${setupBody.clientToken}` } });
    assert.equal(oversizedModelLookup.status, 400);

    const beforeClientRotation = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    const clientRotations = await Promise.all([0, 1].map(() => fetch(`http://127.0.0.1:${port}/api/clients/${validClient.id}/regenerate`, {
      method: 'POST', headers: { cookie, 'if-match': `"${beforeClientRotation.revision}"` }
    })));
    assert.deepEqual(clientRotations.map((response) => response.status).sort(), [200, 412]);
    const clientRotationBodies = await Promise.all(clientRotations.map((response) => response.json()));
    const successfulClientRotation = clientRotations.findIndex((response) => response.status === 200);
    assert.match(clientRotationBodies[successfulClientRotation].token, /^ocb[a-f0-9]{64}$/);
    assert.match(clientRotationBodies[successfulClientRotation].revision, /^[a-f0-9]{32}$/);
    assert.equal(clientRotations[successfulClientRotation].headers.get('etag'), `"${clientRotationBodies[successfulClientRotation].revision}"`);
    assert.match(clientRotationBodies[clientRotations.findIndex((response) => response.status === 412)].error, /其他页面修改/);

    const beforeTokenRotation = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    const tokenRotations = await Promise.all([0, 1].map(() => fetch(`http://127.0.0.1:${port}/api/token/regenerate`, {
      method: 'POST', headers: { cookie, 'if-match': `"${beforeTokenRotation.revision}"` }
    })));
    assert.deepEqual(tokenRotations.map((response) => response.status).sort(), [200, 412]);
    const tokenRotationBodies = await Promise.all(tokenRotations.map((response) => response.json()));
    const successfulTokenRotation = tokenRotations.findIndex((response) => response.status === 200);
    assert.match(tokenRotationBodies[successfulTokenRotation].token, /^[A-Za-z0-9]{24,}$/);
    assert.match(tokenRotationBodies[successfulTokenRotation].revision, /^[a-f0-9]{32}$/);
    assert.equal(tokenRotations[successfulTokenRotation].headers.get('etag'), `"${tokenRotationBodies[successfulTokenRotation].revision}"`);
    assert.match(tokenRotationBodies[tokenRotations.findIndex((response) => response.status === 412)].error, /其他页面修改/);

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

test('并发首次初始化和密码变更都只允许一个请求写入配置', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/setup-race-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CONFIG_FILE: configFile,
      CONFIG_ENCRYPTION_KEY: 'setup-race-integration-key',
      OPENCODE_BRIDGE_ADMIN_PASSWORD: '',
      OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP: ''
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

    const openSetupRequest = async (password) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(3000, () => socket.destroy(new Error('并发初始化等待响应超时')));
      await once(socket, 'connect');
      const body = JSON.stringify({ password });
      socket.write(
        `POST /api/setup HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`
      );
      return { socket, body, password };
    };
    const attempts = await Promise.all([openSetupRequest('racepass001'), openSetupRequest('racepass002')]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const responses = attempts.map(({ socket, password }) => new Promise((resolveResponse, rejectResponse) => {
      const chunks = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]);
        resolveResponse({ status, password });
      });
      socket.on('error', rejectResponse);
    }));
    for (const attempt of attempts) attempt.socket.write(attempt.body);

    const settled = await Promise.all(responses);
    assert.deepEqual(settled.map(({ status }) => status).sort((left, right) => left - right), [200, 409]);
    const winner = settled.find(({ status }) => status === 200);
    const loser = settled.find(({ status }) => status === 409);
    const login = (password) => fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const winnerLogin = await login(winner.password);
    assert.equal(winnerLogin.status, 200);
    assert.equal((await login(loser.password)).status, 401);

    const winnerCookie = winnerLogin.headers.get('set-cookie').split(';', 1)[0];
    const changePassword = (newPassword) => fetch(`http://127.0.0.1:${port}/api/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: winnerCookie },
      body: JSON.stringify({ currentPassword: winner.password, newPassword })
    }).then((response) => ({ response, newPassword }));
    const passwordChanges = await Promise.all([changePassword('newpass001'), changePassword('newpass002')]);
    assert.deepEqual(passwordChanges.map(({ response }) => response.status).sort((left, right) => left - right), [200, 412]);
    const acceptedPassword = passwordChanges.find(({ response }) => response.status === 200).newPassword;
    const rejectedPassword = passwordChanges.find(({ response }) => response.status === 412).newPassword;
    assert.equal((await login(acceptedPassword)).status, 200);
    assert.equal((await login(rejectedPassword)).status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    await unlink(configFile).catch(() => {});
    await unlink(`${configFile}.tmp`).catch(() => {});
  }
});

test('HTTP 总连接上限会拒绝额外连接并在连接关闭后恢复', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/http-connections-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
      OPENCODE_BRIDGE_ADMIN_PASSWORD: '', OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP: '',
      OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let reserved;
  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    reserved = createConnection({ host: '127.0.0.1', port });
    await once(reserved, 'connect');
    reserved.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');

    const started = Date.now();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
    assert.ok(Date.now() - started < 1500, '超过连接上限时应快速关闭新连接');

    reserved.destroy();
    await once(reserved, 'close');
    reserved = null;
    const recovered = await fetch(`http://127.0.0.1:${port}/health`, { headers: { connection: 'close' } });
    assert.equal(recovered.status, 200);
    assert.match(recovered.headers.get('x-request-id'), /^[a-f0-9]{32}$/);
  } finally {
    reserved?.destroy();
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('流式上游中途断开会向客户端发送协议错误并写入失败日志', { timeout: 15_000 }, async () => {
  let upstreamCalls = 0;
  let resolveDelayedRequest;
  const delayedRequest = new Promise((resolveRequest) => { resolveDelayedRequest = resolveRequest; });
  let resolveStreamingBodyClosed;
  const streamingBodyClosed = new Promise((resolveClosed) => { resolveStreamingBodyClosed = resolveClosed; });
  let resolveIdleBodyClosed;
  const idleBodyClosed = new Promise((resolveClosed) => { resolveIdleBodyClosed = resolveClosed; });
  let resolveEventIdleBodyClosed;
  const eventIdleBodyClosed = new Promise((resolveClosed) => { resolveEventIdleBodyClosed = resolveClosed; });
  let resolveTerminalBodyClosed;
  const terminalBodyClosed = new Promise((resolveClosed) => { resolveTerminalBodyClosed = resolveClosed; });
  let responseUpstreamCalls = 0;
  let resolveCrossProtocolBodyClosed;
  const crossProtocolBodyClosed = new Promise((resolveClosed) => { resolveCrossProtocolBodyClosed = resolveClosed; });
  const upstream = createHttpServer((req, res) => {
    if (req.url === '/responses') {
      responseUpstreamCalls++;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      if (responseUpstreamCalls === 2) {
        res.flushHeaders();
        res.once('close', resolveCrossProtocolBodyClosed);
        return;
      }
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
    if (upstreamCalls === 8) {
      res.flushHeaders();
      res.once('close', resolveStreamingBodyClosed);
      return;
    }
    if (upstreamCalls === 10) {
      res.flushHeaders();
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': upstream keep-alive\n\n');
      }, 100);
      res.once('close', () => {
        clearInterval(heartbeat);
        resolveEventIdleBodyClosed();
      });
      return;
    }
    if (upstreamCalls === 11) {
      res.write(`data: ${JSON.stringify({
        id: 'chat_terminal_linger', model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'completed' }, finish_reason: null }]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chat_terminal_linger', model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } }
      })}\n\n`);
      res.once('close', resolveTerminalBodyClosed);
      return;
    }
    const streamId = upstreamCalls === 3 ? 'chat_recovered'
      : (upstreamCalls === 4 || upstreamCalls === 6) ? 'chat_media'
        : 'chat_broken';
    res.write(`data: ${JSON.stringify({
      id: streamId, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }]
    })}\n\n`);
    if (upstreamCalls === 9) {
      res.once('close', resolveIdleBodyClosed);
      return;
    }
    if (upstreamCalls <= 2) setImmediate(() => res.destroy());
    else if (upstreamCalls === 4 || upstreamCalls === 6) {
      res.end(`data: ${JSON.stringify({
        id: streamId, model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }, finish_reason: null }]
      })}\n\n`);
    }
    else if (upstreamCalls === 5) res.end();
    else {
      res.end(`data: ${JSON.stringify({
        id: streamId, model: 'deepseek-v4-flash',
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
    OPENCODE_BRIDGE_SSE_HEARTBEAT_MS: '1000',
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
    assert.equal(direct.headers.get('cache-control'), 'no-store, no-transform');
    const directText = await direct.text();
    assert.match(directText, /"type":"upstream_error"/);
    assert.match(directText, /"code":"upstream_connection_reset"/);
    assert.match(directText, /连接被意外断开/);
    assert.match(directText, /data: \[DONE\]/);

    const translated = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(translated.status, 200);
    assert.equal(translated.headers.get('cache-control'), 'no-store, no-transform');
    const translatedText = await translated.text();
    assert.match(translatedText, /event: error/);
    assert.match(translatedText, /"type":"upstream_error"/);
    assert.match(translatedText, /连接被意外断开/);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 2, JSON.stringify(logs, null, 2));
    assert.ok(logs.every((item) => item.status === 502 && item.stream && item.error));
    assert.ok(logs.every((item) => item.errorCode === 'upstream_connection_reset'));
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
    assert.equal(canceledStats.summary.errors, 6);
    assert.equal(canceledStats.summary.canceledRequests, 1);
    assert.equal(canceledStats.credentialHealth[0].consecutiveFailures, 2);

    const streamingCancellation = new AbortController();
    const streamingResponse = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.any([streamingCancellation.signal, AbortSignal.timeout(2_000)]),
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'cancel after headers before first event' }] })
    });
    assert.equal(streamingResponse.status, 200);
    assert.equal(streamingResponse.headers.get('x-accel-buffering'), 'no');
    const streamingReader = streamingResponse.body.getReader();
    const directHeartbeat = await Promise.race([
      streamingReader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('同协议静默 SSE 未按时发送心跳')), 2_000))
    ]);
    assert.equal(Buffer.from(directHeartbeat.value).toString('utf8'), ': opencode-bridge keep-alive\n\n');
    const directRuntime = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(directRuntime.activeInferenceRequests, 1);
    assert.equal(directRuntime.activeStreamingRequests, 1);
    assert.equal(directRuntime.activeUpstreamWaitRequests, 0);
    assert.equal(directRuntime.activeEstablishedStreams, 1);
    assert.equal(directRuntime.activeStreamWrites, 0);
    assert.ok(directRuntime.oldestActiveInferenceMs >= directRuntime.longestActiveStreamSilenceMs);
    assert.ok(directRuntime.longestActiveStreamSilenceMs >= 900);
    assert.equal(directRuntime.activeStreamHeartbeats, 1);
    streamingCancellation.abort();
    await assert.rejects(() => streamingReader.read(), (error) => error.name === 'AbortError');
    await Promise.race([
      streamingBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('客户端断开后上游 SSE 正文连接未及时关闭')), 1_000))
    ]);
    let streamingCanceledStats;
    for (let attempt = 0; attempt < 20; attempt++) {
      streamingCanceledStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
      if (streamingCanceledStats.summary.requests === 9) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(streamingCanceledStats.summary.requests, 9);
    assert.equal(streamingCanceledStats.summary.errors, 6);
    assert.equal(streamingCanceledStats.summary.canceledRequests, 2);
    assert.equal(streamingCanceledStats.credentialHealth[0].consecutiveFailures, 2);

    const crossFlushConfig = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        defaultProvider: 'zen',
        modelRoutes: {
          'response-stream': { protocol: 'responses' },
          'cross-flush': { protocol: 'responses' }
        }
      })
    });
    assert.equal(crossFlushConfig.status, 200);
    const crossCancellation = new AbortController();
    const crossFlushResponse = await fetch(`http://127.0.0.1:${port}/zen/v1/messages`, {
      method: 'POST', signal: AbortSignal.any([crossCancellation.signal, AbortSignal.timeout(2_000)]),
      headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'cross-flush', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'cancel translated stream before first event' }] })
    });
    assert.equal(crossFlushResponse.status, 200);
    assert.equal(crossFlushResponse.headers.get('x-accel-buffering'), 'no');
    const crossReader = crossFlushResponse.body.getReader();
    const heartbeatChunk = await Promise.race([
      crossReader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('跨协议静默 SSE 未按时发送心跳')), 2_000))
    ]);
    assert.equal(Buffer.from(heartbeatChunk.value).toString('utf8'), ': opencode-bridge keep-alive\n\n');
    const crossRuntime = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(crossRuntime.activeInferenceRequests, 1);
    assert.equal(crossRuntime.activeStreamingRequests, 1);
    assert.equal(crossRuntime.activeEstablishedStreams, 1);
    assert.ok(crossRuntime.longestActiveStreamSilenceMs >= 900);
    assert.equal(crossRuntime.activeStreamHeartbeats, 1);
    crossCancellation.abort();
    await assert.rejects(() => crossReader.read(), (error) => error.name === 'AbortError');
    await Promise.race([
      crossProtocolBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('跨协议客户端在首事件前断开后，上游 SSE 未及时关闭')), 1_000))
    ]);
    let crossCanceledStats;
    for (let attempt = 0; attempt < 20; attempt++) {
      crossCanceledStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
      if (crossCanceledStats.summary.requests === 10) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.equal(crossCanceledStats.summary.requests, 10);
    assert.equal(crossCanceledStats.summary.errors, 6);
    assert.equal(crossCanceledStats.summary.canceledRequests, 3);
    assert.equal(crossCanceledStats.credentialHealth[0].consecutiveFailures, 2);
    const cancellationLogs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    const streamCancellationLogs = cancellationLogs.filter((item) => item.status === 499 && item.stream);
    assert.equal(streamCancellationLogs.length, 2);
    assert.ok(streamCancellationLogs.every((item) => item.errorCode === 'client_closed'));

    const idleConfig = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        defaultProvider: 'zen',
        modelRoutes: {
          'response-stream': { protocol: 'responses' },
          'cross-flush': { protocol: 'responses' }
        },
        upstreamStreamIdleTimeoutMs: 1_000
      })
    });
    assert.equal(idleConfig.status, 200);
    assert.equal((await idleConfig.json()).upstreamStreamIdleTimeoutMs, 1_000);
    const idleResponse = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'stall after first chunk' }] })
    });
    assert.equal(idleResponse.status, 200);
    const idleText = await idleResponse.text();
    assert.match(idleText, /"code":"upstream_stream_(?:event_)?idle_timeout"/);
    assert.match(idleText, /data: \[DONE\]/);
    await Promise.race([
      idleBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('上游流空闲超时后 SSE 正文连接未及时关闭')), 1_000))
    ]);
    const idleStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(idleStats.summary.requests, 11);
    assert.equal(idleStats.summary.errors, 7);
    assert.equal(idleStats.summary.canceledRequests, 3);
    assert.equal(idleStats.credentialHealth[0].consecutiveFailures, 3);
    const resetAfterIdle = await fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'zen', credentialId: 'environment:1' })
    });
    assert.equal(resetAfterIdle.status, 200);
    const eventIdleResponse = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'user', content: 'comments without events' }] })
    });
    assert.equal(eventIdleResponse.status, 200);
    const eventIdleText = await eventIdleResponse.text();
    assert.match(eventIdleText, /"code":"upstream_stream_event_idle_timeout"/);
    assert.match(eventIdleText, /data: \[DONE\]/);
    await Promise.race([
      eventIdleBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('有效 SSE 事件空闲超时后上游连接未及时关闭')), 1_000))
    ]);
    const eventIdleStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(eventIdleStats.summary.requests, 12);
    assert.equal(eventIdleStats.summary.errors, 8);
    assert.equal(eventIdleStats.summary.canceledRequests, 3);
    assert.equal(eventIdleStats.credentialHealth[0].consecutiveFailures, 1);
    const runtime = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(runtime.activeRequests, 0);
    assert.equal(runtime.activeInferenceRequests, 0);
    assert.equal(runtime.activeStreamingRequests, 0);
    assert.equal(runtime.activeUpstreamWaitRequests, 0);
    assert.equal(runtime.activeEstablishedStreams, 0);
    assert.equal(runtime.activeStreamWrites, 0);
    assert.equal(runtime.oldestActiveInferenceMs, 0);
    assert.equal(runtime.longestActiveStreamSilenceMs, 0);
    assert.equal(runtime.activeStreamHeartbeats, 0);

    const terminalResponse = await fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, input: 'close immediately after response.completed' })
    });
    const terminalRequestId = terminalResponse.headers.get('x-request-id');
    const terminalReader = terminalResponse.body.getReader();
    let terminalText = '';
    while (!terminalText.includes('event: response.completed')) {
      const chunk = await terminalReader.read();
      assert.equal(chunk.done, false, 'Responses 终态到达前不应结束');
      terminalText += Buffer.from(chunk.value).toString('utf8');
    }
    await terminalReader.cancel();
    await Promise.race([
      terminalBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('客户端收到终态后关闭时，上游连接未及时释放')), 1_000))
    ]);
    let terminalLogs;
    for (let attempt = 0; attempt < 20; attempt++) {
      terminalLogs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
      if (terminalLogs.some((item) => item.requestId === terminalRequestId)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const terminalLog = terminalLogs.find((item) => item.requestId === terminalRequestId);
    assert.equal(terminalLog.status, 200);
    assert.equal(terminalLog.errorCode, undefined);
    assert.equal(terminalLog.inputTokens, 7);
    assert.equal(terminalLog.outputTokens, 2);
    const terminalStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(terminalStats.summary.requests, 13);
    assert.equal(terminalStats.summary.errors, 8);
    assert.equal(terminalStats.summary.canceledRequests, 3);
    assert.equal(terminalStats.credentialHealth[0].consecutiveFailures, 0);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('非流式上游正文断开会累计 Key 网络失败但不阻断后续请求', { timeout: 10_000 }, async () => {
  let upstreamCalls = 0;
  let markDelayedBodyStarted;
  let markDelayedErrorBodyStarted;
  const delayedBodyStarted = new Promise((resolveStarted) => { markDelayedBodyStarted = resolveStarted; });
  const delayedErrorBodyStarted = new Promise((resolveStarted) => { markDelayedErrorBodyStarted = resolveStarted; });
  const upstream = createHttpServer((req, res) => {
    upstreamCalls++;
    if (upstreamCalls <= 3) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"chat_partial"');
      return setTimeout(() => res.destroy(), 20);
    }
    if (upstreamCalls === 4) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chat_recovered', model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      }));
    }
    if (upstreamCalls === 5) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"broken":');
    }
    if (upstreamCalls === 7) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.write('{"error":{"message":"delayed error body"');
      markDelayedErrorBodyStarted();
      const delayedErrorResponse = setTimeout(() => {
        if (!res.destroyed) res.end('}}');
      }, 1_000);
      res.once('close', () => clearTimeout(delayedErrorResponse));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"id":"chat_delayed"');
    markDelayedBodyStarted();
    const delayedResponse = setTimeout(() => {
      if (!res.destroyed) res.end('}');
    }, 1_000);
    res.once('close', () => clearTimeout(delayedResponse));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/nonstream-body-failure-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'nonstream-body-failure-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY: 'zen-body-key',
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

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] })
      });
      assert.equal(response.status, 502);
      const error = await response.json();
      assert.equal(error.error.code, 'upstream_connection_reset');
    }

    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(stats.credentialHealth[0].state, 'degraded');
    assert.equal(stats.credentialHealth[0].consecutiveFailures, 3);
    assert.equal(stats.credentialHealth[0].lastFailureKind, 'network');

    const continued = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'continue' }] })
    });
    assert.equal(continued.status, 200);
    assert.equal((await continued.json()).choices[0].message.content, 'done');
    assert.equal(upstreamCalls, 4);

    const malformed = await fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'malformed' }] })
    });
    assert.equal(malformed.status, 502);
    assert.equal((await malformed.json()).error.code, 'upstream_invalid_json');
    const malformedStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(malformedStats.credentialHealth[0].state, 'healthy');
    assert.equal(malformedStats.credentialHealth[0].consecutiveFailures, 0);
    assert.equal(upstreamCalls, 5);

    const cancellation = new AbortController();
    const canceledRequest = fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', signal: cancellation.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'cancel body' }] })
    });
    await delayedBodyStarted;
    cancellation.abort();
    await assert.rejects(canceledRequest, (error) => error.name === 'AbortError');
    let canceledLogs;
    for (let attempt = 0; attempt < 20; attempt++) {
      canceledLogs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
      if (canceledLogs.some((item) => item.status === 499)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const canceledLog = canceledLogs.find((item) => item.status === 499);
    assert.ok(canceledLog);
    assert.match(canceledLog.error, /读取上游响应时断开/);
    assert.equal(canceledLog.errorCode, 'client_closed');
    const canceledStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(canceledStats.credentialHealth[0].state, 'healthy');
    assert.equal(canceledStats.credentialHealth[0].consecutiveFailures, 0);
    assert.equal(upstreamCalls, 6);

    const errorCancellation = new AbortController();
    const canceledErrorRequest = fetch(`http://127.0.0.1:${port}/zen/v1/chat/completions`, {
      method: 'POST', signal: errorCancellation.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'cancel error body' }] })
    });
    await delayedErrorBodyStarted;
    errorCancellation.abort();
    await assert.rejects(canceledErrorRequest, (error) => error.name === 'AbortError');
    for (let attempt = 0; attempt < 20; attempt++) {
      canceledLogs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
      if (canceledLogs.some((item) => item.status === 499 && /上游错误响应/.test(item.error))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const canceledErrorLog = canceledLogs.find((item) => item.status === 499 && /上游错误响应/.test(item.error));
    assert.ok(canceledErrorLog);
    assert.equal(canceledErrorLog.errorCode, 'client_closed');
    assert.equal(upstreamCalls, 7);
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
    assert.equal(login.headers.get('strict-transport-security'), 'max-age=31536000');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const secureSameOriginMutation = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, {
      method: 'DELETE', headers: { cookie, origin: `https://127.0.0.1:${port}`, 'x-forwarded-proto': 'https' }
    });
    assert.equal(secureSameOriginMutation.status, 200);
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

test('模型发现共享全局和客户端并发上限且取消后释放名额', { timeout: 10_000 }, async () => {
  let upstreamCalls = 0;
  const requestResolvers = [];
  const closeResolvers = [];
  const upstreamRequests = Array.from({ length: 2 }, (_, index) => new Promise((resolveRequest) => { requestResolvers[index] = resolveRequest; }));
  const upstreamClosed = Array.from({ length: 2 }, (_, index) => new Promise((resolveClosed) => { closeResolvers[index] = resolveClosed; }));
  const upstream = createHttpServer((_req, res) => {
    const index = upstreamCalls++;
    if (index < 2) {
      requestResolvers[index]();
      res.once('close', closeResolvers[index]);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/model-abort-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'model-abort-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY: 'zen-model-key',
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
    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, maxConcurrentRequests: 2 })
    });
    assert.equal(configured.status, 200);
    const namedClient = await fetch(`http://127.0.0.1:${port}/api/clients`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '模型发现客户端', maxConcurrentRequests: 1 })
    }).then((response) => response.json());

    const namedController = new AbortController();
    const namedModels = fetch(`http://127.0.0.1:${port}/zen/v1/models`, {
      headers: { authorization: `Bearer ${namedClient.token}` }, signal: namedController.signal
    });
    await upstreamRequests[0];
    const clientLimited = await fetch(`http://127.0.0.1:${port}/zen/v1/models`, {
      headers: { authorization: `Bearer ${namedClient.token}` }
    });
    assert.equal(clientLimited.status, 429);
    assert.equal(clientLimited.headers.get('retry-after'), '1');
    assert.match((await clientLimited.json()).error.message, /模型发现客户端.*上限 1/);
    assert.equal(upstreamCalls, 1);

    const primaryController = new AbortController();
    const primaryInference = fetch(`http://127.0.0.1:${port}/zen/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: 'hold the global slot' }),
      signal: primaryController.signal
    });
    await upstreamRequests[1];
    const globallyLimited = await fetch(`http://127.0.0.1:${port}/zen/v1/models`, {
      headers: { authorization: 'Bearer Api123' }
    });
    assert.equal(globallyLimited.status, 429);
    assert.match((await globallyLimited.json()).error.message, /并发请求已达到上限 2/);
    assert.equal(upstreamCalls, 2);
    const busyStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(busyStatus.activeRequests, 2);
    assert.equal(busyStatus.activeInferenceRequests, 1);
    assert.equal(busyStatus.activeStreamingRequests, 0);
    assert.equal(busyStatus.activeUpstreamWaitRequests, 1);
    assert.equal(busyStatus.activeEstablishedStreams, 0);
    assert.ok(busyStatus.oldestActiveInferenceMs >= 0);

    namedController.abort();
    primaryController.abort();
    await Promise.all([
      assert.rejects(namedModels, (error) => error?.name === 'AbortError'),
      assert.rejects(primaryInference, (error) => error?.name === 'AbortError')
    ]);
    await Promise.all(upstreamClosed.map(async (closed, index) => {
      let closeTimeout;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => { closeTimeout = setTimeout(() => reject(new Error(`取消后第 ${index + 1} 条上游连接未及时关闭`)), 1000); })
        ]);
      } finally { clearTimeout(closeTimeout); }
    }));

    let idleStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      idleStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
      if (idleStatus.activeRequests === 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(idleStatus.activeRequests, 0);
    assert.equal(idleStatus.activeInferenceRequests, 0);
    const recovered = await fetch(`http://127.0.0.1:${port}/zen/v1/models`, { headers: { authorization: 'Bearer Api123' } });
    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).data.map((model) => model.id), ['gpt-test']);
    assert.equal(upstreamCalls, 3);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('并发模型发现合并上游请求且单个客户端取消相互隔离', { timeout: 10_000 }, async () => {
  let upstreamCalls = 0;
  let heldResponse;
  let heldResponseClosed = false;
  let resolveFirstRequest;
  const firstRequest = new Promise((resolveRequest) => { resolveFirstRequest = resolveRequest; });
  const modelBody = JSON.stringify({ object: 'list', data: [{ id: 'gpt-shared', object: 'model' }] });
  const upstream = createHttpServer((_req, res) => {
    upstreamCalls++;
    if (upstreamCalls === 1) {
      heldResponse = res;
      res.once('close', () => { heldResponseClosed = true; });
      resolveFirstRequest();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(modelBody);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/model-shared-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'model-shared-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY: 'zen-shared-key',
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
    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'zen', modelRoutes: {}, maxConcurrentRequests: 4 })
    });
    assert.equal(configured.status, 200);

    const firstController = new AbortController();
    const first = fetch(`http://127.0.0.1:${port}/zen/v1/models`, {
      headers: { authorization: 'Bearer Api123' }, signal: firstController.signal
    });
    await firstRequest;
    const second = fetch(`http://127.0.0.1:${port}/zen/v1/models`, { headers: { authorization: 'Bearer Api123' } });

    let sharedStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      sharedStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
      if (sharedStatus.activeRequests === 2 && sharedStatus.activeSharedModelDiscoveries === 1) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(sharedStatus.activeRequests, 2);
    assert.equal(sharedStatus.activeSharedModelDiscoveries, 1);
    assert.equal(upstreamCalls, 1);

    firstController.abort();
    await assert.rejects(first, (error) => error?.name === 'AbortError');
    for (let attempt = 0; attempt < 20; attempt++) {
      sharedStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
      if (sharedStatus.activeRequests === 1) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(sharedStatus.activeRequests, 1);
    assert.equal(sharedStatus.activeSharedModelDiscoveries, 1);
    assert.equal(heldResponseClosed, false);

    heldResponse.writeHead(200, { 'content-type': 'application/json' });
    heldResponse.end(modelBody);
    const secondResponse = await second;
    assert.equal(secondResponse.status, 200);
    assert.deepEqual((await secondResponse.json()).data.map((model) => model.id), ['gpt-shared']);
    assert.equal(upstreamCalls, 1);

    const afterCompletion = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(afterCompletion.activeSharedModelDiscoveries, 0);
    const fresh = await fetch(`http://127.0.0.1:${port}/zen/v1/models`, { headers: { authorization: 'Bearer Api123' } });
    assert.equal(fresh.status, 200);
    assert.equal(upstreamCalls, 2);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('管理变更并发达到上限时快速拒绝并在完成后释放名额', { timeout: 10_000 }, async () => {
  const heldResponses = [];
  let resolveBothRequests;
  const bothRequests = new Promise((resolveRequests) => { resolveBothRequests = resolveRequests; });
  const upstream = createHttpServer((_req, res) => {
    heldResponses.push(res);
    if (heldResponses.length === 2) resolveBothRequests();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/admin-limit-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'admin-limit-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_MAX_ADMIN_MUTATIONS: '2',
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
    const modelTest = () => fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'zen', apiKey: 'temporary-test-key' })
    });
    const pending = [modelTest(), modelTest()];
    await bothRequests;

    const busyStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(busyStatus.activeAdminMutations, 2);
    assert.equal(busyStatus.maxAdminMutations, 2);
    const limited = await fetch(`http://127.0.0.1:${port}/api/prompt-rewrite/recent`, { method: 'DELETE', headers: { cookie } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.match((await limited.json()).error, /管理操作并发已达到上限 2/);

    for (const response of heldResponses) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
    }
    const completed = await Promise.all(pending);
    assert.deepEqual(completed.map((response) => response.status), [200, 200]);
    const idleStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(idleStatus.activeAdminMutations, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('管理端模型发现达到上限时拒绝新请求并在取消后释放名额', { timeout: 10_000 }, async () => {
  let upstreamRequests = 0;
  let firstResponse;
  let resolveFirstRequest;
  const firstRequest = new Promise((resolveRequest) => { resolveFirstRequest = resolveRequest; });
  const upstream = createHttpServer((_req, res) => {
    upstreamRequests++;
    if (upstreamRequests === 1) {
      firstResponse = res;
      resolveFirstRequest();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/admin-model-limit-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'admin-model-limit-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_ZEN_KEY: 'admin-model-key',
    OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES: '1',
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
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/models?provider=zen`, { headers: { cookie }, signal: controller.signal });
    await firstRequest;

    const busyStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(busyStatus.activeAdminModelDiscoveries, 1);
    assert.equal(busyStatus.maxAdminModelDiscoveries, 1);
    const limited = await fetch(`http://127.0.0.1:${port}/api/models?provider=zen`, { headers: { cookie } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.match((await limited.json()).error, /模型发现并发已达到上限 1/);
    assert.equal(upstreamRequests, 1);

    controller.abort();
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    let idleStatus;
    for (let attempt = 0; attempt < 40; attempt++) {
      idleStatus = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
      if (idleStatus.activeAdminModelDiscoveries === 0) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(idleStatus.activeAdminModelDiscoveries, 0);

    const retry = await fetch(`http://127.0.0.1:${port}/api/models?provider=zen`, { headers: { cookie } });
    assert.equal(retry.status, 200);
    assert.equal(upstreamRequests, 2);
  } finally {
    firstResponse?.destroy();
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('Key 池和客户端配置变更使用同一修订链并拒绝并发覆盖', { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/subresource-revision-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'subresource-revision-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123'
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
    const initial = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } }).then((response) => response.json());
    const conditionalHeaders = (revision) => ({ 'content-type': 'application/json', cookie, 'if-match': `"${revision}"` });

    const credentialCreates = await Promise.all(['主力', '备用'].map((name, index) => fetch(`http://127.0.0.1:${port}/api/provider-credentials`, {
      method: 'POST', headers: conditionalHeaders(initial.revision),
      body: JSON.stringify({ provider: 'zen', name, apiKey: `panel-key-${index + 1}` })
    })));
    assert.deepEqual(credentialCreates.map((response) => response.status).sort(), [201, 412]);
    const credentialBodies = await Promise.all(credentialCreates.map((response) => response.json()));
    const createdCredentialIndex = credentialCreates.findIndex((response) => response.status === 201);
    const createdCredential = credentialBodies[createdCredentialIndex];
    assert.match(createdCredential.revision, /^[a-f0-9]{32}$/);
    assert.equal(credentialCreates[createdCredentialIndex].headers.get('etag'), `"${createdCredential.revision}"`);
    assert.doesNotMatch(JSON.stringify(credentialBodies[1 - createdCredentialIndex]), /panel-key-/);
    const credential = createdCredential.zenCredentials[0];

    const updatedCredentialResponse = await fetch(`http://127.0.0.1:${port}/api/provider-credentials/zen/${credential.id}`, {
      method: 'PUT', headers: conditionalHeaders(createdCredential.revision), body: JSON.stringify({ name: `${credential.name} 更新` })
    });
    assert.equal(updatedCredentialResponse.status, 200);
    const updatedCredential = await updatedCredentialResponse.json();
    assert.notEqual(updatedCredential.revision, createdCredential.revision);
    assert.equal(updatedCredentialResponse.headers.get('etag'), `"${updatedCredential.revision}"`);

    const clientCreates = await Promise.all(['桌面端', '移动端'].map((name) => fetch(`http://127.0.0.1:${port}/api/clients`, {
      method: 'POST', headers: conditionalHeaders(updatedCredential.revision),
      body: JSON.stringify({ name, maxConcurrentRequests: 2 })
    })));
    assert.deepEqual(clientCreates.map((response) => response.status).sort(), [201, 412]);
    const clientBodies = await Promise.all(clientCreates.map((response) => response.json()));
    const createdClientIndex = clientCreates.findIndex((response) => response.status === 201);
    const client = clientBodies[createdClientIndex];
    assert.match(client.token, /^ocb[a-f0-9]{64}$/);
    assert.match(client.revision, /^[a-f0-9]{32}$/);
    assert.equal(clientCreates[createdClientIndex].headers.get('etag'), `"${client.revision}"`);
    assert.doesNotMatch(JSON.stringify(clientBodies[1 - createdClientIndex]), /ocb[a-f0-9]{64}/);

    const toggledResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${client.id}`, {
      method: 'PUT', headers: conditionalHeaders(client.revision), body: JSON.stringify({ enabled: false })
    });
    assert.equal(toggledResponse.status, 200);
    const toggled = await toggledResponse.json();
    assert.equal(toggled.enabled, false);
    assert.notEqual(toggled.revision, client.revision);
    assert.equal(toggledResponse.headers.get('etag'), `"${toggled.revision}"`);

    const deletedClientResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${client.id}`, {
      method: 'DELETE', headers: conditionalHeaders(toggled.revision)
    });
    assert.equal(deletedClientResponse.status, 200);
    const deletedClient = await deletedClientResponse.json();
    assert.equal(deletedClient.ok, true);
    assert.notEqual(deletedClient.revision, toggled.revision);
    assert.equal(deletedClientResponse.headers.get('etag'), `"${deletedClient.revision}"`);

    const staleDelete = await fetch(`http://127.0.0.1:${port}/api/provider-credentials/zen/${credential.id}`, {
      method: 'DELETE', headers: conditionalHeaders(updatedCredential.revision)
    });
    assert.equal(staleDelete.status, 412);
    const deletedCredentialResponse = await fetch(`http://127.0.0.1:${port}/api/provider-credentials/zen/${credential.id}`, {
      method: 'DELETE', headers: conditionalHeaders(deletedClient.revision)
    });
    assert.equal(deletedCredentialResponse.status, 200);
    const finalConfig = await deletedCredentialResponse.json();
    assert.deepEqual(finalConfig.zenCredentials, []);
    assert.notEqual(finalConfig.revision, deletedClient.revision);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
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

test('鉴权失败的环境 Key 会在当前请求内切换并降低后续优先级', { timeout: 10_000 }, async () => {
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
    assert.equal(rejected.state, 'degraded');
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

test('模型发现会在 200 正文断开后切换 Key 并保持取消中性', { timeout: 10_000 }, async () => {
  const authorizations = [];
  let firstKeyCalls = 0;
  let markDelayedBodyStarted;
  let markDelayedBodyClosed;
  const delayedBodyStarted = new Promise((resolveStarted) => { markDelayedBodyStarted = resolveStarted; });
  const delayedBodyClosed = new Promise((resolveClosed) => { markDelayedBodyClosed = resolveClosed; });
  const upstream = createHttpServer((req, res) => {
    const authorization = req.headers.authorization;
    authorizations.push(authorization);
    if (authorization === 'Bearer html-error-key') {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html>UPSTREAM_PRIVATE_MARKER</html>');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (authorization === 'Bearer first-model-key') {
      firstKeyCalls++;
      res.write('{"object":"list","data":[');
      if (firstKeyCalls <= 2) return setTimeout(() => res.destroy(), 20);
      markDelayedBodyStarted();
      const delayedResponse = setTimeout(() => {
        if (!res.destroyed) res.end(']}');
      }, 1_000);
      res.once('close', () => {
        clearTimeout(delayedResponse);
        markDelayedBodyClosed();
      });
      return;
    }
    if (authorization === 'Bearer malformed-model-key') return res.end('{"broken":');
    if (authorization === 'Bearer invalid-shape-key') return res.end(JSON.stringify({ object: 'list', data: [{ object: 'model' }] }));
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-model', object: 'model' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/model-body-failover-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'model-body-failover-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_ZEN_KEY: 'html-error-key',
    OPENCODE_GO_KEY_1: 'first-model-key',
    OPENCODE_GO_KEY_2: 'second-model-key',
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
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
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const models = await fetch(`http://127.0.0.1:${port}/go/v1/models`, { headers: { authorization: 'Bearer Api123' } });
    assert.equal(models.status, 200);
    assert.equal(models.headers.get('x-opencode-key-attempts'), '2');
    assert.deepEqual((await models.json()).data.map((model) => model.id), ['gpt-model']);
    assert.deepEqual(authorizations, ['Bearer first-model-key', 'Bearer second-model-key']);
    const failoverStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    const failed = failoverStats.credentialHealth.find((item) => item.provider === 'go' && item.credentialId === 'environment:1');
    const healthy = failoverStats.credentialHealth.find((item) => item.provider === 'go' && item.credentialId === 'environment:2');
    assert.equal(failed.state, 'degraded');
    assert.equal(failed.consecutiveFailures, 1);
    assert.equal(failed.lastFailureKind, 'network');
    assert.equal(healthy.state, 'healthy');

    const resetFirst = () => fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:1' })
    });
    assert.equal((await resetFirst()).status, 200);
    const tested = await fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:1' })
    });
    assert.equal(tested.status, 502);
    assert.equal((await tested.json()).code, 'upstream_connection_reset');
    const testedStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(testedStats.credentialHealth.find((item) => item.provider === 'go' && item.credentialId === 'environment:1').consecutiveFailures, 1);

    assert.equal((await resetFirst()).status, 200);
    const cancellation = new AbortController();
    const canceled = fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', signal: cancellation.signal,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', credentialId: 'environment:1' })
    });
    await delayedBodyStarted;
    cancellation.abort();
    await assert.rejects(canceled, (error) => error.name === 'AbortError');
    await Promise.race([
      delayedBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('取消后模型正文连接未及时关闭')), 1_000))
    ]);
    const canceledStats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    const canceledCredential = canceledStats.credentialHealth.find((item) => item.provider === 'go' && item.credentialId === 'environment:1');
    assert.equal(canceledCredential.state, 'unknown');
    assert.equal(canceledCredential.consecutiveFailures, 0);

    const malformed = await fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', apiKey: 'malformed-model-key' })
    });
    assert.equal(malformed.status, 502);
    assert.equal((await malformed.json()).code, 'upstream_invalid_json');

    const invalidShape = await fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'go', apiKey: 'invalid-shape-key' })
    });
    assert.equal(invalidShape.status, 502);
    assert.equal((await invalidShape.json()).code, 'upstream_invalid_response');

    const directHtmlError = await fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'zen', apiKey: 'html-error-key' })
    });
    assert.equal(directHtmlError.status, 403);
    assert.match(directHtmlError.headers.get('content-type'), /^application\/json/);
    const directHtmlBody = await directHtmlError.json();
    assert.equal(directHtmlBody.error.code, 'upstream_http_error');
    assert.doesNotMatch(JSON.stringify(directHtmlBody), /UPSTREAM_PRIVATE_MARKER/);

    const adminHtmlError = await fetch(`http://127.0.0.1:${port}/api/models?provider=zen`, { headers: { cookie } });
    assert.equal(adminHtmlError.status, 403);
    assert.match(adminHtmlError.headers.get('content-type'), /^application\/json/);
    assert.doesNotMatch(JSON.stringify(await adminHtmlError.json()), /UPSTREAM_PRIVATE_MARKER/);
    const resetZen = await fetch(`http://127.0.0.1:${port}/api/credential-health/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'zen', credentialId: 'environment:1' })
    });
    assert.equal(resetZen.status, 200);
    const publicHtmlError = await fetch(`http://127.0.0.1:${port}/zen/v1/models`, { headers: { authorization: 'Bearer Api123' } });
    assert.equal(publicHtmlError.status, 403);
    assert.match(publicHtmlError.headers.get('content-type'), /^application\/json/);
    const publicHtmlBody = await publicHtmlError.json();
    assert.equal(publicHtmlBody.error.code, 'upstream_http_error');
    assert.doesNotMatch(JSON.stringify(publicHtmlBody), /UPSTREAM_PRIVATE_MARKER/);
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
    return res.end(JSON.stringify({
      error: {
        message: 'temporary upstream failure for first-key',
        type: 'server_error',
        code: 'upstream_busy'
      },
      debug: { authorization: req.headers.authorization },
      privateMarker: 'UPSTREAM_PRIVATE_MARKER'
    }));
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
    assert.deepEqual(await response.json(), {
      error: {
        message: 'temporary upstream failure for [REDACTED]',
        type: 'server_error',
        code: 'upstream_busy'
      }
    });
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
    assert.equal(combined.headers.get('x-opencode-key-attempts'), null);
    assert.deepEqual((await combined.json()).data.map((item) => item.id), ['opencode-go/gpt-test']);
    assert.deepEqual(authorizations, ['Bearer first-key', 'Bearer second-key', 'Bearer first-key', 'Bearer first-key']);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('三种推理协议会规范化上游 HTTP 错误并安全记录日志', { timeout: 10_000 }, async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    if (req.url.endsWith('/chat/completions')) {
      return res.end('{broken UPSTREAM_PRIVATE_MARKER first-key');
    }
    return res.end(JSON.stringify({
      error: {
        message: `failure for first-key on ${req.url}`,
        type: req.url.endsWith('/messages') ? 'overloaded_error' : 'server_error',
        code: 'upstream_busy'
      },
      debug: { authorization: req.headers.authorization },
      privateMarker: 'UPSTREAM_PRIVATE_MARKER'
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/normalized-errors-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'normalized-errors-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'first-key',
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

    const responses = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: 'ping' })
    });
    assert.equal(responses.status, 503);
    assert.deepEqual(await responses.json(), {
      error: {
        message: 'failure for [REDACTED] on /responses',
        type: 'server_error',
        code: 'upstream_busy'
      }
    });

    const chat = await fetch(`http://127.0.0.1:${port}/go/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-test', messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(chat.status, 503);
    assert.deepEqual(await chat.json(), {
      error: {
        message: 'OpenCode 上游返回 HTTP 503',
        type: 'upstream_error',
        code: 'upstream_http_error'
      }
    });

    const claude = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(claude.status, 503);
    assert.deepEqual(await claude.json(), {
      type: 'error',
      error: {
        message: 'failure for [REDACTED] on /messages',
        type: 'overloaded_error'
      }
    });

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 3, JSON.stringify(logs, null, 2));
    assert.deepEqual(logs.map((item) => item.errorCode), ['upstream_busy', 'upstream_http_error', 'upstream_busy']);
    assert.doesNotMatch(JSON.stringify(logs), /first-key|UPSTREAM_PRIVATE_MARKER|Bearer/);
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

test('Responses compact 仅向原生 Responses 上游透传并保留 compaction 项', { timeout: 10_000 }, async () => {
  let received;
  let upstreamCalls = 0;
  const compaction = {
    id: 'cmp_server', type: 'compaction', encrypted_content: 'opaque-server-compaction', created_by: 'server'
  };
  const upstream = createHttpServer((req, res) => {
    upstreamCalls++;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_compact', object: 'response', model: received.body.model, status: 'completed',
        output: [compaction], usage: { input_tokens: 1000, output_tokens: 0 }
      }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/responses-compact-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'responses-compact-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123', OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-responses-compact-key', OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
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

    const body = { model: 'gpt-5.6-luna', input: [{ role: 'user', content: 'long context' }] };
    const response = await fetch(`http://127.0.0.1:${port}/go/v1/responses/compact`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).output, [compaction]);
    assert.deepEqual(received, { url: '/responses/compact', body });

    const wrongProtocol = await fetch(`http://127.0.0.1:${port}/go/v1/responses/compact`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', input: 'context' })
    });
    assert.equal(wrongProtocol.status, 400);
    assert.match((await wrongProtocol.json()).error.message, /只能透传到原生 Responses 模型/);

    const streamed = await fetch(`http://127.0.0.1:${port}/go/v1/responses/compact`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ ...body, stream: true })
    });
    assert.equal(streamed.status, 400);
    assert.match((await streamed.json()).error.message, /仅支持非流式请求/);
    assert.equal(upstreamCalls, 1);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/go/v1/responses/compact`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('Claude 新版响应元数据在同协议透传，跨协议通过响应头和日志精确标记', { timeout: 10_000 }, async () => {
  const upstream = createHttpServer((req, res) => {
    const response = {
      id: 'msg_response_metadata', type: 'message', role: 'assistant', model: 'minimax-m2.5',
      content: [{ type: 'text', text: '受限说明' }], stop_reason: 'refusal', stop_sequence: null,
      container: { id: 'container_1' }, context_management: { applied_edits: [] }, diagnostics: { cache: { status: 'miss' } },
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'policy', fallback_credit_token: 'opaque-token' },
      usage: {
        input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 2 },
        fallback_credit: { status: 'not_eligible' }, inference_geo: 'us',
        iterations: [{ type: 'message', input_tokens: 12, output_tokens: 3 }],
        server_tool_use: { web_search_requests: 1 }, service_tier: 'priority'
      }
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/response-metadata-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'response-metadata-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123', OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-response-metadata-key', OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
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

    const sameProtocol = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({ model: 'minimax-m2.5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] })
    });
    assert.equal(sameProtocol.status, 200);
    assert.equal(sameProtocol.headers.get('x-opencode-response-degradations'), null);
    assert.equal((await sameProtocol.json()).stop_details.fallback_credit_token, 'opaque-token');

    const crossProtocol = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'minimax-m2.5', input: 'ping' })
    });
    assert.equal(crossProtocol.status, 200);
    assert.equal(crossProtocol.headers.get('x-opencode-response-degradations'), [
      'claude_container', 'claude_context_management', 'claude_diagnostics', 'claude_stop_details',
      'claude_cache_creation_ttl', 'claude_fallback_credit', 'claude_inference_geo',
      'claude_iterations', 'claude_server_tool_use', 'claude_usage_service_tier'
    ].join(','));
    const translated = await crossProtocol.json();
    assert.equal(translated.output[0].content[0].type, 'refusal');
    assert.equal(translated.usage.input_tokens_details.cache_write_tokens, 7);
    assert.equal('stop_details' in translated, false);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 2);
    assert.equal(logs[0].cacheCreationInputTokens, 7);
    assert.equal(logs[0].cacheCreation5mInputTokens, 5);
    assert.equal(logs[0].cacheCreation1hInputTokens, 2);
    assert.match(logs[0].responseDegradations, /claude_stop_details/);
    assert.equal(logs[1].responseDegradations, undefined);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('统计超过 100 条日志上限并在服务重启后恢复', { timeout: 30_000 }, async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stats', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const suffix = randomUUID();
  const configFile = resolve(import.meta.dirname, `../data/stats-server-${suffix}.json`);
  const statsFile = resolve(import.meta.dirname, `../data/stats-server-items-${suffix}.json`);
  const env = {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, STATS_FILE: statsFile,
    CONFIG_ENCRYPTION_KEY: 'stats-integration-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123', OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_BRIDGE_DEFAULT_PROVIDER: 'go', OPENCODE_GO_KEY: 'stats-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  };
  const start = async () => {
    const service = spawn(process.execPath, ['src/server.js'], {
      cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
    });
    await Promise.race([
      new Promise((resolveStarted) => service.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(service, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}`); })
    ]);
    return service;
  };
  const loginCookie = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };

  let child;
  try {
    child = await start();
    for (let index = 0; index < 105; index++) {
      const response = await fetch(`http://127.0.0.1:${port}/go/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: `request ${index}` }] })
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    const cookie = await loginCookie();
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 100);
    assert.equal(stats.summary.requests, 105);
    assert.equal(stats.retentionDays, 7);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));

    child.kill();
    await once(child, 'exit');
    child = await start();
    const restoredCookie = await loginCookie();
    const restored = await fetch(`http://127.0.0.1:${port}/api/stats`, { headers: { cookie: restoredCookie } }).then((response) => response.json());
    assert.equal(restored.summary.requests, 105);
    assert.equal(restored.retainedRequests, 105);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(statsFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
