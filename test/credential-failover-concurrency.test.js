import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

async function within(promise, message, timeoutMs = 3_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('并发推理 failover 不会因共享 cursor 再次选择当前请求已尝试的 Key', { timeout: 15_000 }, async () => {
  const firstKey = 'concurrency-key-a';
  const secondKey = 'concurrency-key-b';
  const firstRequestSelectedA = deferred();
  const secondRequestSelectedB = deferred();
  const releaseFirstRequestA = deferred();
  const releaseSecondRequestB = deferred();
  const calls = [];

  const upstream = createHttpServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const marker = body.input;
      const authorization = req.headers.authorization;
      calls.push({ marker, authorization });

      if (marker === 'degrade-both') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'degraded for concurrency test' } }));
      }
      if (marker === 'request-a' && authorization === `Bearer ${firstKey}`) {
        firstRequestSelectedA.resolve();
        await releaseFirstRequestA.promise;
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'request A must fail over' } }));
      }
      if (marker === 'request-b' && authorization === `Bearer ${secondKey}`) {
        secondRequestSelectedB.resolve();
        await releaseSecondRequestB.promise;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: `resp_${marker}`, object: 'response', status: 'completed', output: [],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const id = randomUUID();
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/credential-concurrency-${id}.json`);
  const logFile = resolve(import.meta.dirname, `../data/credential-concurrency-${id}-logs.json`);
  const statsFile = resolve(import.meta.dirname, `../data/credential-concurrency-${id}-stats.json`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^OPENCODE_(ZEN|GO)_(KEY|KEYS|PROXY_URL)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, LOG_FILE: logFile, STATS_FILE: statsFile,
    CONFIG_ENCRYPTION_KEY: 'credential-concurrency-test-master-key',
    OPENCODE_BRIDGE_ADMIN_PASSWORD: 'Admin123',
    OPENCODE_BRIDGE_CLIENT_TOKEN: 'Api123',
    OPENCODE_GO_KEY_1: firstKey,
    OPENCODE_GO_KEY_2: secondKey,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`
  });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    await within(Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`服务提前退出：${code}\n${stderr}`); })
    ]), '服务启动超时', 5_000);

    const request = (marker) => fetch(`http://127.0.0.1:${port}/go/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer Api123' },
      body: JSON.stringify({ model: 'gpt-test', input: marker })
    });

    // 一次请求依次收到两次 401，把 A、B 都置为 degraded，并把 cursor 归零。
    const primed = await request('degrade-both');
    assert.equal(primed.status, 401);
    assert.equal(primed.headers.get('x-opencode-key-attempts'), '2');
    await primed.text();

    const requestA = request('request-a');
    await within(firstRequestSelectedA.promise, '请求 A 未选择 Key A');
    const requestB = request('request-b');
    await within(secondRequestSelectedB.promise, '请求 B 未选择 Key B');

    // 此时 B 已把共享 cursor 从 1 移到 0；若 failover 不排除已尝试项，A 会再次选到 A。
    releaseFirstRequestA.resolve();
    const responseA = await within(requestA, '请求 A failover 未完成');
    assert.equal(responseA.status, 200);
    assert.equal(responseA.headers.get('x-opencode-key-attempts'), '2');
    await responseA.text();

    releaseSecondRequestB.resolve();
    const responseB = await within(requestB, '请求 B 未完成');
    assert.equal(responseB.status, 200);
    assert.equal(responseB.headers.get('x-opencode-key-attempts'), null);
    await responseB.text();

    assert.deepEqual(calls, [
      { marker: 'degrade-both', authorization: `Bearer ${firstKey}` },
      { marker: 'degrade-both', authorization: `Bearer ${secondKey}` },
      { marker: 'request-a', authorization: `Bearer ${firstKey}` },
      { marker: 'request-b', authorization: `Bearer ${secondKey}` },
      { marker: 'request-a', authorization: `Bearer ${secondKey}` }
    ]);
  } finally {
    releaseFirstRequestA.resolve();
    releaseSecondRequestB.resolve();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    upstream.closeAllConnections();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    for (const file of [configFile, logFile, statsFile]) {
      await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
});
