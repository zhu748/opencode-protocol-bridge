import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RequestLogStore } from '../src/request-log.js';

test('持久化日志遵守数量上限并可由新实例恢复', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    const store = new RequestLogStore(file);
    for (let index = 0; index < 15; index++) {
      await store.add({ requestId: `r${index}`, time: new Date(1_700_000_000_000 + index).toISOString(), status: 200, prompt: '绝不能写入', apiKey: 'secret' }, { persist: true, limit: 20 });
    }
    await store.flush();
    assert.equal(store.list().length, 15);
    assert.equal(store.list()[0].requestId, 'r14');
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.length, 15);
    assert.doesNotMatch(JSON.stringify(persisted), /绝不能写入|secret/);

    const reloaded = new RequestLogStore(file);
    await reloaded.ensureLoaded({ persist: true, limit: 20 });
    assert.deepEqual(reloaded.list().map((item) => item.requestId), store.list().map((item) => item.requestId));
    await reloaded.configure({ persist: true, limit: 10 });
    assert.equal(reloaded.list().length, 10);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 10);
    await reloaded.clear({ persist: false, limit: 10 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('首次加载持久化日志时并发写入不会互相覆盖', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    await writeFile(file, `${JSON.stringify([{ requestId: 'persisted', time: '2026-08-04T00:00:00.000Z', status: 200 }])}\n`, 'utf8');
    const store = new RequestLogStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.add({
      requestId: `concurrent-${index}`,
      time: new Date(Date.parse('2026-08-04T01:00:00.000Z') + index).toISOString(),
      status: 200
    }, { persist: true, limit: 100 })));
    await store.flush();
    const ids = new Set(store.list(100).map((item) => item.requestId));
    assert.equal(ids.size, 21);
    assert.ok(ids.has('persisted'));
    for (let index = 0; index < 20; index++) assert.ok(ids.has(`concurrent-${index}`));
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('损坏的日志文件不会阻止服务启动并会暴露诊断信息', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    await writeFile(file, '{broken', 'utf8');
    const store = new RequestLogStore(file);
    await store.ensureLoaded({ persist: true, limit: 100 });
    assert.deepEqual(store.list(), []);
    assert.match(store.lastError, /无法读取持久化日志/);
    await store.configure({ persist: false, limit: 100 });
    assert.equal(store.lastError, '');
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('持久化日志加载会清理异常退出遗留的固定临时副本', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    await writeFile(file, '[]\n', 'utf8');
    await writeFile(`${file}.tmp`, '[{"requestId":"stale"}]', 'utf8');
    const store = new RequestLogStore(file);
    await store.ensureLoaded({ persist: true, limit: 100 });
    assert.deepEqual(store.list(), []);
    await assert.rejects(readFile(`${file}.tmp`, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(`${file}.tmp`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('临时副本无法清理时仍加载正式日志并保留诊断', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    await writeFile(file, '[{"requestId":"persisted","status":200}]\n', 'utf8');
    await rmdir(`${file}.tmp`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await mkdir(`${file}.tmp`);
    const store = new RequestLogStore(file);
    await store.ensureLoaded({ persist: true, limit: 100 });
    assert.equal(store.list()[0].requestId, 'persisted');
    assert.match(store.lastError, /无法清理日志临时文件/);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(`${file}.tmp`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('日志会保留阶段耗时、缓存读取、缓存写入和推理 token', async () => {
  const store = new RequestLogStore('unused.json');
  await store.add({ requestId: 'usage', model: 'alias', upstreamModel: 'real-model', credentialId: 'environment:2', upstreamRequestId: 'upstream-trace', retryAfter: '7', errorCode: 'upstream_connect_timeout', upstreamWaitMs: 123, upstreamBodyMs: 45, inputTokens: 10, outputTokens: 4, inputTokensIncludeCache: true, cachedInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1 });
  assert.deepEqual(store.list()[0], {
    time: '', requestId: 'usage', clientId: '', clientName: '', model: 'alias', upstreamModel: 'real-model', provider: '', credentialId: 'environment:2', credentialLabel: '', credentialAttempts: 1, upstreamRequestId: 'upstream-trace', retryAfter: '7', protocol: '',
    status: 0, duration: 0, upstreamWaitMs: 123, upstreamBodyMs: 45, stream: false, inputTokens: 10, outputTokens: 4, inputTokensIncludeCache: true,
    cachedInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1, errorCode: 'upstream_connect_timeout'
  });
});

test('日志会钳制异常数值，避免持久化数据污染统计', async () => {
  const store = new RequestLogStore('unused.json');
  await store.add({
    requestId: 'numeric-bounds', status: 1e100, duration: Infinity,
    credentialAttempts: 1e100, upstreamWaitMs: -5,
    inputTokens: 1e100, outputTokens: -2, cachedInputTokens: '3'
  });
  const entry = store.list()[0];
  assert.equal(entry.status, 999);
  assert.equal(entry.duration, 0);
  assert.equal(entry.credentialAttempts, 1000);
  assert.equal(entry.upstreamWaitMs, 0);
  assert.equal(entry.inputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(entry.outputTokens, 0);
  assert.equal(entry.cachedInputTokens, 3);
});

test('关闭持久化会取消尚未执行的延迟写盘', async () => {
  const file = resolve(import.meta.dirname, `../data/log-${randomUUID()}.json`);
  try {
    const store = new RequestLogStore(file);
    await store.add({ requestId: 'pending', status: 200 }, { persist: true, limit: 100 });
    await store.configure({ persist: false, limit: 100 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('日志写盘临时失败后可在下一次 flush 重试', async () => {
  const directory = resolve(import.meta.dirname, `../data/log-dir-${randomUUID()}`);
  const file = resolve(directory, 'request-logs.json');
  try {
    await writeFile(directory, '暂时阻止创建目录', 'utf8');
    const store = new RequestLogStore(file);
    await store.add({ requestId: 'retryable', status: 200 }, { persist: true, limit: 100 });
    await assert.rejects(store.flush());
    assert.match(store.lastError, /无法写入持久化日志/);

    await unlink(directory);
    await store.flush();
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].requestId, 'retryable');
    assert.equal(store.lastError, '');
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(directory).catch((error) => { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) throw error; });
    await rmdir(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
