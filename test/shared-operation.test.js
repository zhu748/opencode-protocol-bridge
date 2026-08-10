import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedOperationPool } from '../src/shared-operation.js';

test('相同键的进行中操作只执行一次并向全部等待者返回结果', async () => {
  const pool = new SharedOperationPool();
  let starts = 0;
  let release;
  const operation = async () => {
    starts++;
    await new Promise((resolve) => { release = resolve; });
    return { ok: true };
  };
  const first = pool.run('same', undefined, operation);
  const second = pool.run('same', undefined, operation);
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(pool.size, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
  assert.deepEqual(firstResult, { ok: true });
  assert.equal(pool.size, 0);
});

test('单个等待者取消不会中止仍被其他调用方使用的共享操作', async () => {
  const pool = new SharedOperationPool();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let sharedSignal;
  let release;
  const operation = async (signal) => {
    sharedSignal = signal;
    await new Promise((resolve) => { release = resolve; });
    return 'done';
  };
  const first = pool.run('shared', firstController.signal, operation);
  const second = pool.run('shared', secondController.signal, operation);
  await Promise.resolve();
  firstController.abort();
  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal(sharedSignal.aborted, false);
  assert.equal(pool.size, 1);
  release();
  assert.equal(await second, 'done');
  assert.equal(pool.size, 0);
});

test('最后一个等待者取消会关闭旧操作且新调用不会加入已取消任务', async () => {
  const pool = new SharedOperationPool();
  let starts = 0;
  const operation = (signal) => new Promise((resolve, reject) => {
    starts++;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = pool.run('replace', firstController.signal, operation);
  const second = pool.run('replace', secondController.signal, operation);
  await Promise.resolve();
  firstController.abort();
  secondController.abort();
  await Promise.all([
    assert.rejects(first, (error) => error?.name === 'AbortError'),
    assert.rejects(second, (error) => error?.name === 'AbortError')
  ]);
  assert.equal(pool.size, 0);

  const replacement = pool.run('replace', undefined, async () => {
    starts++;
    return 'replacement';
  });
  assert.equal(await replacement, 'replacement');
  assert.equal(starts, 2);
  assert.equal(pool.size, 0);
});
