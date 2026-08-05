import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { rm, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* 服务尚未开始监听 */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('等待测试服务启动超时');
}

test('远程桥接会提供短时图片 URL 并限制慢速附件下载', { timeout: 20_000 }, async () => {
  const upstreamBodies = [];
  const upstream = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat_remote_image', model: 'deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: '准备调用视觉技能' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 }
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const id = randomUUID();
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/image-handoff-${id}.json`);
  const imageDirectory = resolve(import.meta.dirname, `../data/image-handoff-${id}`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'image-handoff-test-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY: 'go-test-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_BRIDGE_IMAGE_HANDOFF_DIR: imageDirectory,
    OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL: `http://127.0.0.1:${port}`,
    OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS: '250'
  });
  const child = spawn(process.execPath, ['src/server.js'], { cwd: resolve(import.meta.dirname, '..'), env, stdio: 'ignore' });
  try {
    await waitForHealth(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', max_tokens: 32,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '看看图片' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
        ] }]
      })
    });
    assert.equal(response.status, 200);
    await response.json();
    const serialized = JSON.stringify(upstreamBodies.at(-1));
    const imageUrl = serialized.match(/http:\/\/127\.0\.0\.1:\d+\/_bridge\/images\/[a-f0-9]{64}/)?.[0];
    assert.ok(imageUrl);
    assert.match(serialized, /下载到 Claude Code 本机临时文件.*vision 技能/);
    assert.doesNotMatch(serialized, /image_url|aGVsbG8=/);

    const image = await fetch(imageUrl);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('content-disposition'), 'inline; filename="image.png"');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await image.arrayBuffer()).toString('utf8'), 'hello');
    const imageHead = await fetch(imageUrl, { method: 'HEAD' });
    assert.equal(imageHead.status, 200);
    assert.equal(imageHead.headers.get('content-length'), '5');

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Admin123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const largeResponse = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', max_tokens: 32,
        messages: [{ role: 'user', content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: Buffer.alloc(7 * 1024 * 1024, 0x61).toString('base64') }
        }] }]
      })
    });
    assert.equal(largeResponse.status, 200);
    await largeResponse.json();
    const largeImageUrl = JSON.stringify(upstreamBodies.at(-1)).match(/http:\/\/127\.0\.0\.1:\d+\/_bridge\/images\/[a-f0-9]{64}/)?.[0];
    assert.ok(largeImageUrl);
    const largeImagePath = new URL(largeImageUrl).pathname;
    const slowSocket = createConnection({ host: '127.0.0.1', port });
    try {
      await once(slowSocket, 'connect');
      slowSocket.pause();
      slowSocket.write(`GET ${largeImagePath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } }).then((result) => result.json());
      let stalledObserved = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await status()).activeHttpRequests >= 2) { stalledObserved = true; break; }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(stalledObserved, true);
      let released = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await status()).activeHttpRequests <= 1) { released = true; break; }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.equal(released, true);
    } finally {
      slowSocket.destroy();
    }

    const configured = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ defaultProvider: 'go', modelRoutes: {}, imageHandoffModels: [] })
    });
    assert.equal(configured.status, 200);
    const passthrough = await fetch(`http://127.0.0.1:${port}/go/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'Api123' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', max_tokens: 32,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'd29ybGQ=' } }] }]
      })
    });
    assert.equal(passthrough.status, 200);
    await passthrough.json();
    assert.match(JSON.stringify(upstreamBodies.at(-1)), /image_url|d29ybGQ=/);
    assert.doesNotMatch(JSON.stringify(upstreamBodies.at(-1)), /远程图片附件/);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rm(imageDirectory, { recursive: true, force: true });
  }
});
