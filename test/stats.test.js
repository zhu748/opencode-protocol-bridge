import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRequestStats } from '../src/stats.js';

const now = Date.parse('2026-08-04T12:00:00.000Z');
const logs = [
  { time: '2026-08-04T11:00:00.000Z', status: 200, duration: 100, upstreamWaitMs: 70, upstreamBodyMs: 20, provider: 'zen', credentialId: 'environment:2', model: 'deepseek-free', upstreamModel: 'deepseek-v4-flash-free', protocol: 'claude → chat', clientName: '工作机', inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2 },
  { time: '2026-08-04T10:00:00.000Z', status: 502, duration: 900, upstreamWaitMs: 800, provider: 'go', model: 'deepseek', protocol: 'responses → chat', clientName: '', stream: true },
  { time: '2026-08-01T10:00:00.000Z', status: 200, duration: 200, upstreamWaitMs: 150, upstreamBodyMs: 40, provider: 'zen', model: 'deepseek-free', protocol: 'chat → chat', clientName: '工作机', inputTokens: 5, outputTokens: 1, cacheCreationInputTokens: 2 }
];

test('统计汇总不会重复计算缓存和推理 token', () => {
  const result = aggregateRequestStats(logs, 'all', now);
  assert.equal(result.retainedRequests, 3);
  assert.deepEqual(result.summary, {
    requests: 3, success: 2, errors: 1, successRate: 66.7,
    averageDurationMs: 400, p95DurationMs: 900, streamRequests: 1,
    upstreamWaitRequests: 3, upstreamWaitCoverageRate: 100, averageUpstreamWaitMs: 340, p95UpstreamWaitMs: 800,
    upstreamBodyRequests: 2, upstreamBodyCoverageRate: 66.7, averageUpstreamBodyMs: 30, p95UpstreamBodyMs: 40,
    usageRequests: 2, missingUsageRequests: 1,
    usageCoverageRate: 66.7, cacheHitRequests: 1, cacheWriteRequests: 1, cacheHitRequestRate: 50,
    credentialAttempts: 3, failoverRequests: 0, failoverAttempts: 0,
    inputTokens: 15, uncachedInputTokens: 12, outputTokens: 5, cachedInputTokens: 3,
    cacheCreationInputTokens: 2, reasoningTokens: 2, cacheReadRate: 20, totalTokens: 20,
    averageTokensPerUsageRequest: 10
  });
  assert.equal(result.byProvider[0].name, 'zen');
  assert.equal(result.byProvider[0].totalTokens, 20);
  assert.equal(result.byModel[0].name, 'deepseek-v4-flash-free');
  assert.equal(result.byCredential[0].name, 'ZEN 环境 #2');
  assert.equal(result.byClient.find((item) => item.name === '主令牌').requests, 1);
});

test('统计请求内 Key 自动切换次数', () => {
  const result = aggregateRequestStats([
    { time: '2026-08-04T11:00:00.000Z', status: 200, credentialAttempts: 2 },
    { time: '2026-08-04T11:30:00.000Z', status: 200, credentialAttempts: 1 }
  ], 'all', now);
  assert.equal(result.summary.credentialAttempts, 3);
  assert.equal(result.summary.failoverRequests, 1);
  assert.equal(result.summary.failoverAttempts, 1);
});

test('空统计不会把未知成功率或用量覆盖率伪装成 100%', () => {
  const result = aggregateRequestStats([], 'all', now);
  assert.equal(result.summary.requests, 0);
  assert.equal(result.summary.successRate, null);
  assert.equal(result.summary.usageCoverageRate, null);
});

test('时间趋势按范围生成固定桶并统计错误与 token', () => {
  const hourly = aggregateRequestStats(logs, '24h', now).timeline;
  assert.equal(hourly.bucket, 'hour');
  assert.equal(hourly.buckets.length, 24);
  assert.equal(hourly.buckets.reduce((sum, item) => sum + item.requests, 0), 2);
  assert.equal(hourly.buckets.reduce((sum, item) => sum + item.errors, 0), 1);
  assert.equal(hourly.buckets.reduce((sum, item) => sum + item.totalTokens, 0), 14);

  const all = aggregateRequestStats(logs, 'all', now).timeline;
  assert.equal(all.bucket, 'day');
  assert.equal(all.range, '14d');
  assert.equal(all.buckets.length, 14);
  assert.equal(all.buckets.reduce((sum, item) => sum + item.requests, 0), 3);
});

test('OpenAI 缓存写入是独立指标，不会从原始输入的未缓存部分重复扣除', () => {
  const result = aggregateRequestStats([
    { time: '2026-08-04T11:00:00.000Z', status: 200, protocol: 'responses → chat', inputTokens: 100, outputTokens: 5, cachedInputTokens: 20, cacheCreationInputTokens: 30, inputTokensIncludeCache: true }
  ], 'all', now);
  assert.equal(result.summary.inputTokens, 100);
  assert.equal(result.summary.cachedInputTokens, 20);
  assert.equal(result.summary.uncachedInputTokens, 80);
  assert.equal(result.summary.cacheCreationInputTokens, 30);
  assert.equal(result.summary.totalTokens, 105);
});

test('Claude 缓存字段按独立输入口径汇总并兼容旧日志', () => {
  const result = aggregateRequestStats([
    { time: '2026-08-04T11:00:00.000Z', status: 200, protocol: 'chat → claude', inputTokens: 5, outputTokens: 2, cachedInputTokens: 20, cacheCreationInputTokens: 10, inputTokensIncludeCache: false },
    { time: '2026-08-04T11:30:00.000Z', status: 200, protocol: 'claude → claude', inputTokens: 4, outputTokens: 1, cachedInputTokens: 6 }
  ], 'all', now);
  assert.equal(result.summary.inputTokens, 45);
  assert.equal(result.summary.uncachedInputTokens, 9);
  assert.equal(result.summary.cachedInputTokens, 26);
  assert.equal(result.summary.cacheCreationInputTokens, 10);
  assert.equal(result.summary.outputTokens, 3);
  assert.equal(result.summary.totalTokens, 48);
  assert.equal(result.summary.cacheReadRate, 57.8);
  assert.equal(result.summary.cacheHitRequestRate, 100);
});

test('24h 时间范围过滤旧日志并保留原始日志数量提示', () => {
  const result = aggregateRequestStats(logs, '24h', now);
  assert.equal(result.retainedRequests, 3);
  assert.equal(result.summary.requests, 2);
  assert.equal(result.summary.totalTokens, 14);
  assert.equal(result.from, '2026-08-03T12:00:00.000Z');
});

test('非法统计时间范围会返回可映射的 400', () => {
  assert.throws(() => aggregateRequestStats(logs, 'month', now), (error) => error.status === 400);
});

test('全部范围不会被损坏或未来时间的日志污染', () => {
  const result = aggregateRequestStats([
    ...logs,
    { time: 'invalid', status: 200, inputTokens: 999 },
    { time: '2026-08-05T12:00:00.000Z', status: 200, inputTokens: 999 }
  ], 'all', now);
  assert.equal(result.retainedRequests, 5);
  assert.equal(result.summary.requests, 3);
  assert.equal(result.summary.totalTokens, 20);
});
