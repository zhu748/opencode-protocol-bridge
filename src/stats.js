const WINDOWS = { all: null, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };

export function aggregateRequestStats(items, window = 'all', now = Date.now()) {
  if (!Object.hasOwn(WINDOWS, window)) throw Object.assign(new Error('统计时间范围仅支持 all、24h 或 7d'), { status: 400 });
  const duration = WINDOWS[window];
  const from = duration === null ? null : now - duration;
  const filtered = items.filter((item) => {
    const timestamp = Date.parse(item.time);
    return Number.isFinite(timestamp) && timestamp <= now && (from === null || timestamp >= from);
  });
  return {
    generatedAt: new Date(now).toISOString(),
    window,
    from: from === null ? null : new Date(from).toISOString(),
    retainedRequests: items.length,
    summary: summarize(filtered),
    timeline: timeline(filtered, window, now),
    byProvider: group(filtered, (item) => item.provider || '未知'),
    byCredential: group(filtered, credentialName).slice(0, 64),
    byModel: group(filtered, (item) => item.upstreamModel || item.model || '未知').slice(0, 25),
    byProtocol: group(filtered, (item) => item.protocol || '未知').slice(0, 25),
    byClient: group(filtered, (item) => item.clientName || '主令牌').slice(0, 25)
  };
}

function timeline(items, window, now) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const bucketMs = window === '24h' ? hour : day;
  const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : 14;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (bucketCount - 1) * bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(start + index * bucketMs).toISOString(),
    requests: 0, errors: 0, totalTokens: 0, cachedInputTokens: 0
  }));
  for (const item of items) {
    const timestamp = Date.parse(item.time);
    const index = Math.floor((timestamp - start) / bucketMs);
    if (!Number.isFinite(timestamp) || index < 0 || index >= buckets.length) continue;
    const usage = tokenUsage(item);
    buckets[index].requests++;
    if (!(item.status >= 200 && item.status < 400)) buckets[index].errors++;
    buckets[index].totalTokens += usage.inputTokens + count(item.outputTokens);
    buckets[index].cachedInputTokens += usage.cachedInputTokens;
  }
  return { bucket: window === '24h' ? 'hour' : 'day', range: window === 'all' ? '14d' : window, buckets };
}

function credentialName(item) {
  const provider = String(item.provider || '未知').toUpperCase();
  const [source, slot] = String(item.credentialId || '').split(':');
  if (source === 'environment' && /^\d+$/.test(slot)) return `${provider} 环境 #${slot}`;
  if (source === 'config') return `${provider} · ${String(item.credentialLabel || '面板 Key').slice(0, 64)}`;
  return `${provider} 旧记录`;
}

function summarize(items) {
  const success = items.filter((item) => item.status >= 200 && item.status < 400).length;
  const durations = items.map((item) => count(item.duration)).sort((left, right) => left - right);
  const upstreamWait = timingSummary(items, 'upstreamWaitMs');
  const upstreamBody = timingSummary(items, 'upstreamBodyMs');
  const tokens = items.reduce((total, item) => {
    const usage = tokenUsage(item);
    return {
      inputTokens: total.inputTokens + usage.inputTokens,
      uncachedInputTokens: total.uncachedInputTokens + usage.uncachedInputTokens,
      outputTokens: total.outputTokens + count(item.outputTokens),
      cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      reasoningTokens: total.reasoningTokens + count(item.reasoningTokens)
    };
  }, { inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  const usageRequests = items.filter((item) => ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens'].some((key) => Object.hasOwn(item, key))).length;
  const cacheHitRequests = items.filter((item) => count(item.cachedInputTokens) > 0).length;
  const cacheWriteRequests = items.filter((item) => count(item.cacheCreationInputTokens) > 0).length;
  const credentialAttempts = items.reduce((total, item) => total + Math.max(1, count(item.credentialAttempts)), 0);
  const failoverRequests = items.filter((item) => count(item.credentialAttempts) > 1).length;
  return {
    requests: items.length,
    success,
    errors: items.length - success,
    successRate: items.length ? round(success / items.length * 100, 1) : null,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p95DurationMs: durations.length ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] : 0,
    upstreamWaitRequests: upstreamWait.requests,
    upstreamWaitCoverageRate: items.length ? round(upstreamWait.requests / items.length * 100, 1) : null,
    averageUpstreamWaitMs: upstreamWait.average,
    p95UpstreamWaitMs: upstreamWait.p95,
    upstreamBodyRequests: upstreamBody.requests,
    upstreamBodyCoverageRate: items.length ? round(upstreamBody.requests / items.length * 100, 1) : null,
    averageUpstreamBodyMs: upstreamBody.average,
    p95UpstreamBodyMs: upstreamBody.p95,
    streamRequests: items.filter((item) => item.stream).length,
    usageRequests,
    missingUsageRequests: items.length - usageRequests,
    usageCoverageRate: items.length ? round(usageRequests / items.length * 100, 1) : null,
    cacheHitRequests,
    cacheWriteRequests,
    credentialAttempts,
    failoverRequests,
    failoverAttempts: Math.max(0, credentialAttempts - items.length),
    cacheHitRequestRate: usageRequests ? round(cacheHitRequests / usageRequests * 100, 1) : 0,
    ...tokens,
    cacheReadRate: tokens.inputTokens ? round(tokens.cachedInputTokens / tokens.inputTokens * 100, 1) : 0,
    totalTokens: tokens.inputTokens + tokens.outputTokens,
    averageTokensPerUsageRequest: usageRequests ? Math.round((tokens.inputTokens + tokens.outputTokens) / usageRequests) : 0
  };
}

function timingSummary(items, field) {
  const values = items.filter((item) => Object.hasOwn(item, field)).map((item) => Number(item[field]))
    .filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  return {
    requests: values.length,
    average: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0,
    p95: values.length ? Math.round(values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]) : 0
  };
}

function tokenUsage(item) {
  const rawInputTokens = count(item.inputTokens);
  const cachedInputTokens = count(item.cachedInputTokens);
  const cacheCreationInputTokens = count(item.cacheCreationInputTokens);
  const inputTokensIncludeCache = typeof item.inputTokensIncludeCache === 'boolean'
    ? item.inputTokensIncludeCache
    : !String(item.protocol || '').split('→').at(-1)?.trim().startsWith('claude');
  const uncachedInputTokens = inputTokensIncludeCache
    ? Math.max(0, rawInputTokens - cachedInputTokens)
    : rawInputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    inputTokens: inputTokensIncludeCache ? rawInputTokens : uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens
  };
}

function group(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = String(keyFor(item)).slice(0, 256);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].map(([name, entries]) => ({ name, ...summarize(entries) }))
    .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.name.localeCompare(right.name, 'zh-CN'));
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
