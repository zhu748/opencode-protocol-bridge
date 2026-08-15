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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* 等待监听。 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('等待测试服务启动超时');
}

async function openPartialRequest(port, token, contentLength) {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write([
    'POST /go/v1/responses HTTP/1.1',
    'Host: localhost',
    `Authorization: Bearer ${token}`,
    'Content-Type: application/json',
    `Content-Length: ${contentLength}`,
    '',
    '{"model":"gpt-test","input":"partial'
  ].join('\r\n'));
  return socket;
}

async function earlyResponse(port, token, contentLength) {
  const socket = await openPartialRequest(port, token, contentLength);
  socket.setTimeout(3_000, () => socket.destroy(new Error('等待预算拒绝响应超时')));
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function waitForStatus(status, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await status();
    if (predicate(current)) return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('等待正文预算状态变化超时');
}

test('Content-Length 入场预留分别返回每客户端 429 与全局 503，取消后归还', { timeout: 20_000 }, async () => {
  let upstreamCalls = 0;
  let pendingUpstreamResponse;
  let notifyUpstreamRequest;
  const upstreamRequest = new Promise((resolveRequest) => { notifyUpstreamRequest = resolveRequest; });
  const upstream = createHttpServer((_req, res) => {
    upstreamCalls++;
    pendingUpstreamResponse = res;
    notifyUpstreamRequest();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/request-body-budget-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'request-body-budget-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-test-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_BRIDGE_MAX_INFLIGHT_REQUEST_BODY_BYTES: String(15 * 1024 * 1024),
    OPENCODE_BRIDGE_MAX_CLIENT_INFLIGHT_REQUEST_BODY_BYTES: String(10 * 1024 * 1024)
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let heldSocket;
  try {
    await waitForHealth(port, child);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const createdClientResponse = await fetch(`http://127.0.0.1:${port}/api/clients`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'secondary', maxConcurrentRequests: 2 })
    });
    assert.equal(createdClientResponse.status, 201);
    const secondaryToken = (await createdClientResponse.json()).token;
    const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());

    heldSocket = await openPartialRequest(port, 'Api123', 10 * 1024 * 1024);
    const busy = await waitForStatus(status, (current) => current.inflightRequestBody?.currentBytes === 10 * 1024 * 1024);
    assert.equal(busy.inflightRequestBody.activeClients, 1);

    const clientRejected = await earlyResponse(port, 'Api123', 1);
    assert.match(clientRejected, /^HTTP\/1\.1 429 Too Many Requests\r\n/);
    assert.match(clientRejected, /retry-after: 1\r\n/i);
    assert.match(clientRejected, /"type":"rate_limit_error"/);
    assert.match(clientRejected, /"code":"client_inflight_request_body_limit_exceeded"/);

    const globalRejected = await earlyResponse(port, secondaryToken, 6 * 1024 * 1024);
    assert.match(globalRejected, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.match(globalRejected, /retry-after: 1\r\n/i);
    assert.match(globalRejected, /"type":"overloaded_error"/);
    assert.match(globalRejected, /"code":"inflight_request_body_capacity_exhausted"/);
    assert.equal((await status()).inflightRequestBody.currentBytes, 10 * 1024 * 1024);

    heldSocket.destroy();
    heldSocket = null;
    const idle = await waitForStatus(status, (current) => current.inflightRequestBody?.currentBytes === 0);
    assert.equal(idle.inflightRequestBody.activeClients, 0);
    assert.equal(upstreamCalls, 0);

    const retainedPayload = JSON.stringify({
      model: 'gpt-test', stream: false,
      input: `budget-retained-${'x'.repeat(1024 * 1024)}`
    });
    const retainedBytes = Buffer.byteLength(retainedPayload);
    const retainedRequest = fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secondaryToken}`, 'content-type': 'application/json' },
      body: retainedPayload
    });
    await upstreamRequest;
    const retained = await waitForStatus(status, (current) => current.inflightRequestBody?.currentBytes === retainedBytes);
    assert.equal(retained.inflightRequestBody.activeClients, 1);
    pendingUpstreamResponse.writeHead(500, { 'content-type': 'application/json' });
    pendingUpstreamResponse.end(JSON.stringify({ error: { message: 'expected test response' } }));
    assert.equal((await retainedRequest).status, 500);
    const releasedAfterResponse = await waitForStatus(status, (current) => current.inflightRequestBody?.currentBytes === 0);
    assert.equal(releasedAfterResponse.inflightRequestBody.activeClients, 0);
    assert.equal(upstreamCalls, 1);
    assert.equal(stderr, '');
  } finally {
    heldSocket?.destroy();
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
