import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RequestStatsStore } from '../src/request-stats-store.js';

const now = Date.parse('2026-08-12T12:00:00.000Z');

test('统计存储不受 100 条日志上限影响并可由新实例恢复', async () => {
  const file = resolve(import.meta.dirname, `../data/stats-${randomUUID()}.json`);
  try {
    const store = new RequestStatsStore(file);
    for (let index = 0; index < 250; index++) {
      await store.add({
        requestId: `stats-${index}`,
        time: new Date(now - index * 1000).toISOString(),
        status: 200,
        inputTokens: index,
        prompt: '绝不能写入',
        error: '上游错误正文也不能写入',
        apiKey: 'secret'
      }, { retentionDays: 7, now });
    }
    await store.flush();
    assert.equal(store.size, 250);
    const persistedText = await readFile(file, 'utf8');
    assert.equal(JSON.parse(persistedText).length, 250);
    assert.doesNotMatch(persistedText, /绝不能写入|上游错误正文|secret/);
    assert.equal(persistedText.split('\n').length, 2, '统计快照应使用紧凑 JSON，避免格式化空白放大写盘量');

    const reloaded = new RequestStatsStore(file);
    await reloaded.ensureLoaded({ retentionDays: 7, now });
    assert.equal(reloaded.size, 250);
    assert.ok(reloaded.version > 0);
    assert.equal([...reloaded.values()][0].requestId, 'stats-0');
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
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((item) => item.requestId), ['recent']);
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
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
