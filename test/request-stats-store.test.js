import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RequestStatsStore } from '../src/request-stats-store.js';

const now = Date.parse('2026-08-12T12:00:00.000Z');

function persistedEntries(text) {
  const lines = text.trimEnd().split('\n');
  const header = JSON.parse(lines.shift());
  assert.equal(header.format, 'opencode-request-stats-ndjson');
  assert.equal(header.version, 1);
  return { header, entries: lines.filter(Boolean).map((line) => JSON.parse(line)) };
}

test('统计存储不受 100 条日志上限影响并可由新实例恢复', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const store = new RequestStatsStore(file);
    for (let index = 0; index < 250; index++) {
      await store.add({
        requestId: `stats-${index}`,
        time: new Date(now - index * 1000).toISOString(),
        status: 200,
        requestedReasoningEffort: 'max',
        reasoningEffort: 'max',
        inputTokens: index,
        prompt: '绝不能写入',
        error: '上游错误正文也不能写入',
        apiKey: 'secret'
      }, { retentionDays: 7, now });
    }
    await store.flush();
    assert.equal(store.size, 250);
    const persistedText = await readFile(file, 'utf8');
    assert.equal(persistedEntries(persistedText).entries.length, 250);
    assert.doesNotMatch(persistedText, /绝不能写入|上游错误正文|secret/);
    assert.equal(persistedText.split('\n').length, 252, 'NDJSON 应为一个头部、一条记录一行和结尾换行');

    const reloaded = new RequestStatsStore(file);
    await reloaded.ensureLoaded({ retentionDays: 7, now });
    assert.equal(reloaded.size, 250);
    assert.ok(reloaded.version > 0);
    assert.equal([...reloaded.values()][0].requestId, 'stats-0');
    assert.equal([...reloaded.values()][0].requestedReasoningEffort, 'max');
    assert.equal([...reloaded.values()][0].reasoningEffort, 'max');
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('统计存储按配置天数清理过期数据并立即持久化', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const store = new RequestStatsStore(file);
    await store.add({ requestId: 'recent', time: new Date(now - 12 * 60 * 60 * 1000).toISOString(), status: 200 }, { retentionDays: 7, now });
    await store.add({ requestId: 'two-days', time: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), status: 200 }, { retentionDays: 7, now });
    await store.add({ requestId: 'expired', time: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(), status: 200 }, { retentionDays: 7, now });
    assert.deepEqual([...store.values()].map((item) => item.requestId), ['recent', 'two-days']);

    await store.configure({ retentionDays: 1, now });
    assert.deepEqual([...store.values()].map((item) => item.requestId), ['recent']);
    assert.deepEqual(persistedEntries(await readFile(file, 'utf8')).entries.map((item) => item.requestId), ['recent']);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('旧日志迁移和持久化文件加载都会按请求 ID 去重', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const duplicate = { requestId: 'same', time: new Date(now - 1000).toISOString(), status: 200 };
    await writeFile(file, `${JSON.stringify([duplicate, duplicate])}\n`, 'utf8');
    const store = new RequestStatsStore(file);
    await store.ensureLoaded({ retentionDays: 7, now });
    assert.equal(store.size, 1);
    assert.equal(await store.merge([duplicate, { requestId: 'legacy', time: new Date(now - 2000).toISOString(), status: 500 }], { retentionDays: 7, now }), true);
    assert.equal(store.size, 2);
    assert.equal(await store.merge([duplicate], { retentionDays: 7, now }), false);
    await store.flush();
    assert.equal(persistedEntries(await readFile(file, 'utf8')).entries.length, 2);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('常规刷新只追加新增统计，旧 JSON 数组会自动迁移为 NDJSON', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const legacy = { requestId: 'legacy', time: new Date(now - 1000).toISOString(), status: 200 };
    await writeFile(file, `${JSON.stringify([legacy])}\n`, 'utf8');
    const store = new RequestStatsStore(file);
    await store.ensureLoaded({ retentionDays: 7, now });
    await store.flush();
    const migrated = await readFile(file, 'utf8');
    assert.deepEqual(persistedEntries(migrated).entries.map((item) => item.requestId), ['legacy']);

    await store.add({ requestId: 'new', time: new Date(now).toISOString(), status: 200 }, { retentionDays: 7, now });
    await store.flush();
    const appended = await readFile(file, 'utf8');
    assert.ok(appended.startsWith(migrated), '常规写盘应保留已有字节并只追加新记录');
    assert.deepEqual(persistedEntries(appended).entries.map((item) => item.requestId), ['legacy', 'new']);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('统计存储达到容量上限时批量淘汰最旧记录并持久化诊断', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const store = new RequestStatsStore(file, { maxBytes: 4096 });
    for (let index = 0; index < 100; index++) {
      await store.add({
        requestId: `bounded-${index}`,
        time: new Date(now - (100 - index) * 1000).toISOString(),
        model: `model-${index}-${'x'.repeat(120)}`,
        status: 200
      }, { retentionDays: 7, now });
    }
    await store.flush();
    const status = store.status();
    const persisted = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(persisted) <= status.maxBytes);
    assert.ok(store.size < 100);
    assert.ok(status.capacityDroppedEntries > 0);
    assert.ok(status.capacityLimitedAt);
    assert.match([...store.values()][0].requestId, /^bounded-99$/);

    const reloaded = new RequestStatsStore(file, { maxBytes: 4096 });
    await reloaded.ensureLoaded({ retentionDays: 7, now });
    assert.equal(reloaded.size, store.size);
    assert.equal(reloaded.status().capacityDroppedEntries, status.capacityDroppedEntries);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('统计存储可恢复写入中断留下的尾部残行', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const store = new RequestStatsStore(file);
    await store.add({ requestId: 'complete', time: new Date(now).toISOString(), status: 200 }, { retentionDays: 7, now });
    await store.flush();
    await appendFile(file, '{"requestId":"partial"', 'utf8');

    const recovered = new RequestStatsStore(file);
    await recovered.ensureLoaded({ retentionDays: 7, now });
    assert.equal(recovered.size, 1);
    assert.match(recovered.lastError, /不完整或无效/);
    await recovered.flush();
    assert.deepEqual(persistedEntries(await readFile(file, 'utf8')).entries.map((item) => item.requestId), ['complete']);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('完全无法解析的统计文件会保留到确有新数据时再原子替换', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const damaged = 'not-json-and-not-ndjson\n';
    await writeFile(file, damaged, 'utf8');
    const store = new RequestStatsStore(file);
    await store.ensureLoaded({ retentionDays: 7, now });
    assert.equal(store.size, 0);
    assert.match(store.lastError, /无法读取持久化统计/);
    assert.equal(await readFile(file, 'utf8'), damaged);

    await store.add({ requestId: 'replacement', time: new Date(now).toISOString(), status: 200 }, { retentionDays: 7, now });
    await store.flush();
    assert.deepEqual(persistedEntries(await readFile(file, 'utf8')).entries.map((item) => item.requestId), ['replacement']);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
