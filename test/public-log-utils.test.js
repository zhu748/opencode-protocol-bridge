import test from 'node:test';
import assert from 'node:assert/strict';
import { compactIdentifier, filterRequestLogs, requestLogsToCsv } from '../public/log-utils.js';

const logs = [
  { time: '2026-08-04T11:30:00Z', requestId: 'local-success', upstreamRequestId: 'trace-a', provider: 'zen', status: 200, model: 'model-a', clientName: '工作机' },
  { time: '2026-08-04T10:30:00Z', requestId: 'local-rate', upstreamRequestId: 'trace-b', provider: 'go', status: 429, model: 'model-b', error: 'rate limited' },
  { time: '2026-08-04T10:00:00Z', requestId: 'local-canceled', provider: 'go', status: 499, errorCode: 'client_closed', error: '客户端取消' },
  { time: '2026-08-03T11:30:00Z', requestId: 'local-bad', provider: 'go', status: 401, upstreamModel: 'real-model', credentialId: 'config:backup', credentialLabel: '备用', credentialAttempts: 2, retryAfter: '9' },
  { time: 'invalid', requestId: 'local-upstream', provider: 'zen', status: 502, protocol: 'claude → chat', requestKind: 'compaction', requestedReasoningEffort: 'max', reasoningEffort: 'high', bridgeWebSearchCalls: 37, responseDegradations: 'claude_iterations', errorCode: 'upstream_dns_error', error: '连接失败' }
];

test('日志筛选可组合关键词、上游与互斥状态', () => {
  assert.deepEqual(filterRequestLogs(logs, { provider: 'go' }).map((item) => item.requestId), ['local-rate', 'local-canceled', 'local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'rate-limit' }).map((item) => item.requestId), ['local-rate']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'canceled' }).map((item) => item.requestId), ['local-canceled']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'client-error' }).map((item) => item.requestId), ['local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { status: 'server-error' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'TRACE-B', provider: 'go', status: 'rate-limit' }).map((item) => item.requestId), ['local-rate']);
  assert.deepEqual(filterRequestLogs(logs, { query: '备用' }).map((item) => item.requestId), ['local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'config:backup' }).map((item) => item.requestId), ['local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { query: '9' }).map((item) => item.requestId), ['local-bad']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'upstream_dns_error' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: '37' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'claude_iterations' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'max' }).map((item) => item.requestId), ['local-upstream']);
  assert.deepEqual(filterRequestLogs(logs, { query: 'compaction' }).map((item) => item.requestId), ['local-upstream']);
  const now = Date.parse('2026-08-04T12:00:00Z');
  assert.deepEqual(filterRequestLogs(logs, { timeRange: '1h', now }).map((item) => item.requestId), ['local-success']);
  assert.deepEqual(filterRequestLogs(logs, { timeRange: '24h', now }).map((item) => item.requestId), ['local-success', 'local-rate', 'local-canceled']);
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
    clientName: '@evil', model: '-1+1', provider: 'go', status: 429, duration: 900, upstreamWaitMs: 850, upstreamBodyMs: 25,
    requestKind: 'compaction', requestedReasoningEffort: 'max', reasoningEffort: 'high', bridgeWebSearchCalls: 37, responseDegradations: 'claude_cache_creation_ttl', cacheCreation5mInputTokens: 3, cacheCreation1hInputTokens: 4,
    errorCode: 'upstream_connect_timeout', error: '含有,逗号和"引号"',
    apiKey: 'must-not-export', prompt: 'must-not-export-either'
  }]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"'\+cmd"/);
  assert.match(csv, /"'@evil"/);
  assert.match(csv, /"'-1\+1"/);
  assert.match(csv, /upstream_connect_timeout/);
  assert.match(csv, /"上游等待 ms"/);
  assert.match(csv, /"850"/);
  assert.match(csv, /"响应体阶段 ms"/);
  assert.match(csv, /"响应元数据降级"/);
  assert.match(csv, /"客户端思考强度"/);
  assert.match(csv, /"请求类型"/);
  assert.match(csv, /"compaction"/);
  assert.match(csv, /"最终上游思考强度"/);
  assert.match(csv, /"max"/);
  assert.match(csv, /"high"/);
  assert.match(csv, /"本地 Web Search 次数"/);
  assert.match(csv, /"37"/);
  assert.match(csv, /claude_cache_creation_ttl/);
  assert.match(csv, /"5 分钟缓存写入 Token"/);
  assert.match(csv, /"含有,逗号和""引号"""/);
  assert.doesNotMatch(csv, /must-not-export/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('请求 ID 缩略保留首尾，短 ID 保持原样', () => {
  assert.equal(compactIdentifier('short-id'), 'short-id');
  assert.equal(compactIdentifier('1234567890abcdefghij1234567890'), '1234567890…34567890');
});
