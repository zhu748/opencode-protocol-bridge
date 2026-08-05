import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* 服务尚未开始监听。 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('等待测试服务启动超时');
}

test('非流式大 JSON 响应遵守背压并在慢客户端超时后释放并发槽', { timeout: 20_000 }, async () => {
  let markUpstreamRequest;
  const upstreamRequest = new Promise((resolveRequest) => { markUpstreamRequest = resolveRequest; });
  const outputText = 'x'.repeat(7 * 1024 * 1024);
  const upstream = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* 读取完整请求后再响应。 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_large', object: 'response', status: 'completed', model: 'gpt-test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputText }] }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
    markUpstreamRequest();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/json-backpressure-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'json-backpressure-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-test-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS: '250'
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: 'ignore'
  });
  let slowSocket;
  try {
    await waitForHealth(port, child);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'go', modelRoutes: {}, imageHandoffModels: [], maxConcurrentRequests: 1 })
    });
    assert.equal(configured.status, 200);

    slowSocket = createConnection({ host: '127.0.0.1', port });
    await once(slowSocket, 'connect');
    slowSocket.pause();
    const requestBody = JSON.stringify({ model: 'gpt-test', input: 'ping' });
    slowSocket.write([
      'POST /go/v1/responses HTTP/1.1',
      'Host: localhost',
      'Authorization: Bearer Api123',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(requestBody)}`,
      'Connection: close',
      '',
      requestBody
    ].join('\r\n'));
    await upstreamRequest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    const competing = await fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: 'second' })
    });
    const competingStatus = competing.status;
    await competing.body?.cancel();
    assert.equal(competingStatus, 429);

    const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal((await status()).activeRequests, 1);
    let released = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await status()).activeRequests === 0) { released = true; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(released, true);

    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: { cookie } }).then((response) => response.json());
    assert.equal(logs.length, 1, JSON.stringify(logs, null, 2));
    assert.equal(logs[0].status, 499);
    assert.match(logs[0].error, /客户端/);
  } finally {
    slowSocket?.destroy();
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('管理端大模型列表写入期间保留模型发现槽位', { timeout: 20_000 }, async () => {
  let markUpstreamRequest;
  const upstreamRequest = new Promise((resolveRequest) => { markUpstreamRequest = resolveRequest; });
  const upstream = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* 读取完整请求后再响应。 */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'gpt-large', object: 'model', metadata: 'x'.repeat(7 * 1024 * 1024) }]
    }));
    markUpstreamRequest();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/model-json-backpressure-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'model-json-backpressure-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-test-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES: '1',
    OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS: '250'
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: 'ignore'
  });
  let slowSocket;
  try {
    await waitForHealth(port, child);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    slowSocket = createConnection({ host: '127.0.0.1', port });
    await once(slowSocket, 'connect');
    slowSocket.pause();
    slowSocket.write([
      'GET /api/models?provider=go HTTP/1.1',
      'Host: localhost',
      `Cookie: ${cookie}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
    await upstreamRequest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());
    assert.equal((await status()).activeAdminModelDiscoveries, 1);
    const competing = await fetch(`http://127.0.0.1:${port}/api/models?provider=go`, { headers: { cookie } });
    assert.equal(competing.status, 429);
    assert.equal(competing.headers.get('retry-after'), '1');

    let released = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await status()).activeAdminModelDiscoveries === 0) { released = true; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(released, true);
  } finally {
    slowSocket?.destroy();
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
