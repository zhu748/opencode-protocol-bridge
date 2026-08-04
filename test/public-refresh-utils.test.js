import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalLoad, summarizeSourceFailures } from '../public/refresh-utils.js';

test('可选数据源失败时保留旧值且不传播异常', async () => {
  const previous = [{ id: 'preserved' }];
  const failed = await optionalLoad(async () => { throw new Error('temporary outage'); }, previous);
  assert.equal(failed.fresh, false);
  assert.equal(failed.value, previous);
  assert.equal(failed.error.message, 'temporary outage');

  const succeeded = await optionalLoad(async () => [{ id: 'fresh' }], previous);
  assert.equal(succeeded.fresh, true);
  assert.deepEqual(succeeded.value, [{ id: 'fresh' }]);
  assert.equal(succeeded.error, null);
});

test('数据源故障摘要保持简洁并限制详细错误长度', () => {
  const summary = summarizeSourceFailures(new Map([
    ['请求日志', '读取失败'],
    ['运行状态', 'x'.repeat(500)]
  ]));
  assert.equal(summary.message, '部分数据未更新：请求日志、运行状态');
  assert.match(summary.detail, /^请求日志：读取失败\n运行状态：x+$/);
  assert.ok(summary.detail.length < 340);
  assert.deepEqual(summarizeSourceFailures(new Map()), { message: '', detail: '' });
});
