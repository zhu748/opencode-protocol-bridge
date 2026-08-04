import test from 'node:test';
import assert from 'node:assert/strict';
import { compactIdentifier, filterRequestLogs, formatCooldownRemaining, requestLogsToCsv } from '../public/log-utils.js';

const logs = [
  { time: '2026-08-04T11:30:00Z', requestId: 'local-success', upstreamRequestId: 'trace-a', provider: 'zen', status: 200, model: 'model-a', clientName: '工作机' },
  { time: '2026-08-04T10:30:00Z', requestId: 'local-rate', upstreamRequestId: 'trace-b', provider: 'go', status: 429, model: 'model-b', error: 'rate limited' },
  { time: '2026-08-03T11:30:00Z', requestId: 'local-bad', provider: 'go', status: 401, upstreamModel: 'real-model', credentialLabel: '备用' },
  { time: 'invalid', requestId: 'local-upstream', provider: 'zen', status: 502, protocol: 'claude → chat', error: '连接失败' }
];

test('日志筛选可组合关键词、上游与互斥状态', () => {
  assert.deepEqual(filterRequestLogs(logs, { provider: 'go' }).map((item) => item.requestId), ['local-rate', 'local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'rate-limit' }).map((item) => item.requestId), ['local-rate']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'client-error' }).map((item) => item.requestId), ['local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'server-error' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'TRACE-B', provider: 'go', status: 'rate-limit' }).map((item) => item.requestId), ['local-rate']);
  assert.deepEqual(filterRequestLogs(logs, { query: '备用' }).map((item) => item.requestId), ['local-bad']);
  const now = Date.parse('2026-08-04T12:00:00Z');
  assert.deepEqual(filterRequestLogs(logs, { timeRange: '1h', now }).map((item) => item.requestId), ['local-success']);
  assert.deepEqual(filterRequestLogs(logs, { timeRange: '24h', now }).map((item) => item.requestId), ['local-success', 'local-rate']);
});

test('日志时间筛选不会把未来时间记录混入当前窗口', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  const items = [
    { time: '2026-08-04T11:00:00.000Z', status: 200 },
    { time: '2026-08-04T13:00:00.000Z', status: 200 }
  ];
  assert.deepEqual(filterRequestLogs(items, { timeRange: '1h', now }), [items[0]]);
});

test('CSV 导出限定元数据字段并防止公式注入', () => {
  const csv = requestLogsToCsv([{
    time: '2026-08-04T12:00:00Z', requestId: '=HYPERLINK("bad")', upstreamRequestId: '+cmd',
    clientName: '@evil', model: '-1+1', provider: 'go', status: 429, error: '含有,逗号和"引号"',
    apiKey: 'must-not-export', prompt: 'must-not-export-either'
  }]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"'\+cmd"/);
  assert.match(csv, /"'@evil"/);
  assert.match(csv, /"'-1\+1"/);
  assert.match(csv, /"含有,逗号和""引号"""/);
  assert.doesNotMatch(csv, /must-not-export/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('请求 ID 缩略保留首尾，短 ID 保持原样', () => {
  assert.equal(compactIdentifier('short-id'), 'short-id');
  assert.equal(compactIdentifier('1234567890abcdefghij1234567890'), '1234567890…34567890');
});

test('冷却倒计时覆盖秒、分钟、小时、过期和非法时间', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  assert.equal(formatCooldownRemaining('2026-08-04T12:00:07Z', now), '剩余 7 秒');
  assert.equal(formatCooldownRemaining('2026-08-04T12:02:07Z', now), '剩余 2 分 7 秒');
  assert.equal(formatCooldownRemaining('2026-08-04T14:05:00Z', now), '剩余 2 小时 5 分');
  assert.equal(formatCooldownRemaining('2026-08-04T11:59:59Z', now), '可重新探测');
  assert.equal(formatCooldownRemaining('invalid', now), '可重新探测');
});
