import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRequestStats, summarizeRequestStatus } from '../src/stats.js';

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
  assert.equal(result.byModel[0].averageUpstreamWaitMs, 70);
  assert.equal(result.byModel[0].p95UpstreamWaitMs, 70);
  assert.equal(result.byModel[0].averageUpstreamBodyMs, 20);
  assert.equal(result.byCredential[0].name, 'ZEN 环境 #2');
  assert.equal(result.byClient.find((item) => item.name === '主令牌').requests, 1);
});

test('单次统计汇总复用缓存与凭据字段读取', () => {
  let cachedInputReads = 0;
  let cacheCreationReads = 0;
  let credentialAttemptReads = 0;
  let upstreamWaitReads = 0;
  let upstreamBodyReads = 0;
  let timeReads = 0;
  const item = {
    status: 200, duration: 100,
    provider: 'zen', credentialId: 'environment:1',
    model: 'model', protocol: 'responses → chat', clientName: 'client',
    inputTokens: 10, outputTokens: 4, reasoningTokens: 1, inputTokensIncludeCache: true
  };
  Object.defineProperty(item, 'cachedInputTokens', {
    enumerable: true,
    get() {
      cachedInputReads++;
      return 3;
    }
  });
  Object.defineProperty(item, 'cacheCreationInputTokens', {
    enumerable: true,
    get() {
      cacheCreationReads++;
      return 2;
    }
  });
  Object.defineProperty(item, 'credentialAttempts', {
    enumerable: true,
    get() {
      credentialAttemptReads++;
      return 2;
    }
  });
  Object.defineProperty(item, 'upstreamWaitMs', {
    enumerable: true,
    get() {
      upstreamWaitReads++;
      return 70;
    }
  });
  Object.defineProperty(item, 'upstreamBodyMs', {
    enumerable: true,
    get() {
      upstreamBodyReads++;
      return 20;
    }
  });
  Object.defineProperty(item, 'time', {
    enumerable: true,
    get() {
      timeReads++;
      return '2026-08-04T11:00:00.000Z';
    }
  });

  const result = aggregateRequestStats([item], 'all', now);
  assert.equal(result.summary.cachedInputTokens, 3);
  assert.equal(result.summary.cacheCreationInputTokens, 2);
  assert.equal(result.summary.credentialAttempts, 2);
  assert.equal(result.summary.failoverRequests, 1);
  assert.equal(cachedInputReads, 1, '总汇总、时间线和五类分组应共享一次缓存字段规范化');
  assert.equal(cacheCreationReads, 1, '总汇总、时间线和五类分组应共享一次缓存写入字段规范化');
  assert.equal(credentialAttemptReads, 1, '总汇总和五类分组应共享一次凭据尝试次数规范化');
  assert.equal(upstreamWaitReads, 1, '总汇总、时间线和五类分组应共享一次上游等待值规范化');
  assert.equal(upstreamBodyReads, 1, '总汇总、时间线和五类分组应共享一次上游正文耗时规范化');
  assert.equal(timeReads, 1, '过滤与时间线应共享一次时间戳读取和解析');
});

test('状态摘要与完整统计口径一致', () => {
  const summary = aggregateRequestStats(logs, '24h', now).summary;
  assert.deepEqual(summarizeRequestStatus(logs, '24h', now), {
    requests: summary.requests,
    success: summary.success,
    successRate: summary.successRate,
    averageDurationMs: summary.averageDurationMs,
    upstreamWaitCoverageRate: summary.upstreamWaitCoverageRate,
    averageUpstreamWaitMs: summary.averageUpstreamWaitMs,
    upstreamBodyCoverageRate: summary.upstreamBodyCoverageRate,
    averageUpstreamBodyMs: summary.averageUpstreamBodyMs
  });
});

test('状态摘要在大日志下不构建时间线、分组、Token 或 p95 数据', () => {
  const item = {
    time: '2026-08-04T11:00:00.000Z',
    status: 200,
    duration: 100,
    upstreamWaitMs: 70,
    upstreamBodyMs: 20
  };
  for (const field of [
    'provider', 'credentialId', 'credentialLabel', 'upstreamModel', 'model', 'protocol', 'clientName',
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens',
    'credentialAttempts', 'stream'
  ]) {
    Object.defineProperty(item, field, {
      get() {
        throw new Error(`状态摘要不应读取 ${field}`);
      }
    });
  }
  const source = Array(2048).fill(item);
  const originalFrom = Array.from;
  const originalSort = Array.prototype.sort;
  let arrayFromCalls = 0;
  let sortCalls = 0;
  Array.from = (...args) => {
    arrayFromCalls++;
    return originalFrom(...args);
  };
  Array.prototype.sort = function(...args) {
    sortCalls++;
    return originalSort.apply(this, args);
  };
  let summary;
  try {
    summary = summarizeRequestStatus(source, 'all', now);
  } finally {
    Array.from = originalFrom;
    Array.prototype.sort = originalSort;
  }
  assert.equal(summary.requests, 2048);
  assert.equal(summary.averageDurationMs, 100);
  assert.equal(arrayFromCalls, 0, '状态摘要不应创建时间线桶');
  assert.equal(sortCalls, 0, '状态摘要不应为 p95 排序');
});

test('五类统计分组共享一次日志数组遍历', () => {
  const source = [...logs];
  const originalIterator = source[Symbol.iterator].bind(source);
  let sourceIterations = 0;
  source[Symbol.iterator] = () => {
    sourceIterations++;
    return originalIterator();
  };
  source.filter = () => { throw new Error('统计不应分配中间过滤数组'); };

  const result = aggregateRequestStats(source, 'all', now);
  assert.equal(sourceIterations, 1, '过滤、总汇总、时间线和全部分组应共享一次日志数组遍历');
  assert.deepEqual(result.byProvider.map((item) => item.name), ['zen', 'go']);
  assert.equal(result.byCredential[0].name, 'ZEN 环境 #2');
  assert.equal(result.byModel[0].name, 'deepseek-v4-flash-free');
  assert.equal(result.byProtocol[0].name, 'claude → chat');
  assert.equal(result.byClient[0].name, '工作机');
});

test('完整统计支持无 length 的有界迭代源并正确报告保留数', () => {
  let iterations = 0;
  const source = {
    *[Symbol.iterator]() {
      iterations++;
      yield* logs;
    }
  };
  const result = aggregateRequestStats(source, '24h', now);
  assert.equal(iterations, 1);
  assert.equal(result.retainedRequests, 3);
  assert.equal(result.summary.requests, 2);
  assert.equal(result.summary.totalTokens, 14);
});

test('分组桶即时累加且完成阶段不再扫描测量对象数组', () => {
  const originalIterator = Array.prototype[Symbol.iterator];
  let measurementArrayScans = 0;
  Array.prototype[Symbol.iterator] = function(...args) {
    const first = this[0];
    if (first && typeof first === 'object'
      && Object.hasOwn(first, 'successful') && Object.hasOwn(first, 'duration')) {
      measurementArrayScans++;
    }
    return originalIterator.apply(this, args);
  };
  let result;
  try {
    result = aggregateRequestStats(logs, 'all', now);
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator;
  }

  assert.equal(measurementArrayScans, 0);
  assert.equal(result.byProvider.find((item) => item.name === 'zen').totalTokens, 20);
  assert.equal(result.byProvider.find((item) => item.name === 'go').errors, 1);
});

test('高基数分组先截取展示项再计算完整汇总与 p95', () => {
  const manyGroups = Array.from({ length: 100 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return {
      time: '2026-08-04T11:00:00.000Z',
      status: 200,
      duration: index + 1,
      upstreamWaitMs: index + 2,
      upstreamBodyMs: index + 3,
      provider: 'zen',
      credentialId: `config:key-${suffix}`,
      credentialLabel: `Key ${suffix}`,
      upstreamModel: `model-${suffix}`,
      protocol: `protocol-${suffix}`,
      clientName: `client-${suffix}`,
      inputTokens: index + 1,
      outputTokens: 0,
      inputTokensIncludeCache: true
    };
  });
  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function(...args) {
    sortCalls++;
    return originalSort.apply(this, args);
  };
  let result;
  try {
    result = aggregateRequestStats(manyGroups, 'all', now);
  } finally {
    Array.prototype.sort = originalSort;
  }

  assert.equal(result.byCredential.length, 64);
  assert.equal(result.byModel.length, 25);
  assert.equal(result.byProtocol.length, 25);
  assert.equal(result.byClient.length, 25);
  assert.equal(result.byModel[0].name, 'model-099');
  assert.equal(result.byModel.at(-1).name, 'model-075');
  assert.equal(result.byModel[0].totalTokens, 100);
  assert.equal(result.byModel[0].p95DurationMs, 100);
  assert.ok(sortCalls <= 430, `只应完成最终展示的分组，实际排序 ${sortCalls} 次`);
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
  const failedBucket = hourly.buckets.find((item) => item.errors === 1);
  assert.equal(failedBucket.upstreamWaitRequests, 1);
  assert.equal(failedBucket.averageUpstreamWaitMs, 800);
  assert.equal(failedBucket.upstreamBodyRequests, 0);
  assert.equal(failedBucket.averageUpstreamBodyMs, 0);

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
