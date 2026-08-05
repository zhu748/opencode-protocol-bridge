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

async function partialRequest(port, request) {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write(request);
  return socket;
}

async function readEarlyResponse(port, request) {
  const socket = await partialRequest(port, request);
  socket.setTimeout(2000, () => socket.destroy(new Error('等待提前响应超时')));
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function waitForStatus(status, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = await status();
    if (predicate(current)) return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('等待运行状态变化超时');
}

test('请求体上传中断会静默释放公开和管理并发槽', { timeout: 20_000 }, async () => {
  let upstreamCalls = 0;
  const upstream = createHttpServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '不应调用上游' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/request-body-abort-${randomUUID()}.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'request-body-abort-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-test-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let publicSocket;
  let adminSocket;
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
    const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((response) => response.json());

    const unauthenticated = await readEarlyResponse(port, [
      'POST /go/v1/responses HTTP/1.1',
      'Host: localhost',
      'Content-Type: application/json',
      `Content-Length: ${1024 * 1024}`,
      'Connection: keep-alive',
      '',
      '{"model":"gpt-test","input":"partial'
    ].join('\r\n'));
    assert.match(unauthenticated, /^HTTP\/1\.1 401 Unauthorized\r\n/);
    assert.match(unauthenticated, /\r\nconnection: close\r\n/i);

    publicSocket = await partialRequest(port, [
      'POST /go/v1/responses HTTP/1.1',
      'Host: localhost',
      'Authorization: Bearer Api123',
      'Content-Type: application/json',
      `Content-Length: ${1024 * 1024}`,
      '',
      '{"model":"gpt-test","input":"partial'
    ].join('\r\n'));
    await waitForStatus(status, (current) => current.activeRequests === 1);
    publicSocket.destroy();
    publicSocket = null;
    await waitForStatus(status, (current) => current.activeRequests === 0);

    adminSocket = await partialRequest(port, [
      'PUT /api/config HTTP/1.1',
      'Host: localhost',
      `Cookie: ${cookie}`,
      'Content-Type: application/json',
      `Content-Length: ${1024 * 1024}`,
      '',
      '{"defaultProvider":"go"'
    ].join('\r\n'));
    await waitForStatus(status, (current) => current.activeAdminMutations === 1);
    adminSocket.destroy();
    adminSocket = null;
    await waitForStatus(status, (current) => current.activeAdminMutations === 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    assert.equal(upstreamCalls, 0);
    assert.equal(stderr, '');
  } finally {
    publicSocket?.destroy();
    adminSocket?.destroy();
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
