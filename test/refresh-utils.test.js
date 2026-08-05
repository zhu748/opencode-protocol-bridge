import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequestGate, optionalLoad, summarizeSourceFailures } from '../public/refresh-utils.js';

test('最新请求门只接受最后发起的请求', () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);

  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);

  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(second.controller.signal.aborted, true);
});

test('可选数据源保留失败前的回退值', async () => {
  const fallback = { retained: true };
  const result = await optionalLoad(async () => { throw new Error('暂时不可用'); }, fallback);
  assert.equal(result.fresh, false);
  assert.equal(result.value, fallback);
  assert.equal(result.error.message, '暂时不可用');
});

test('数据源失败摘要包含名称并限制过长详情', () => {
  const summary = summarizeSourceFailures(new Map([
    ['请求日志', '读取失败'],
    ['用量统计', 'x'.repeat(500)]
  ]));
  assert.equal(summary.message, '部分数据未更新：请求日志、用量统计');
  assert.match(summary.detail, /^请求日志：读取失败\n用量统计：x+$/);
  assert.equal(summary.detail.split('\n')[1].length, '用量统计：'.length + 300);
});
