const WINDOWS = { all: null, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };

export function summarizeRequestStatus(items, window = 'all', now = Date.now()) {
  const from = statsWindowStart(window, now);
  let requests = 0;
  let success = 0;
  let durationTotal = 0;
  let upstreamWaitRequests = 0;
  let upstreamWaitTotal = 0;
  let upstreamBodyRequests = 0;
  let upstreamBodyTotal = 0;
  for (const item of items) {
    const timestamp = Date.parse(item.time);
    if (!Number.isFinite(timestamp) || timestamp > now || (from !== null && timestamp < from)) continue;
    requests++;
    if (item.status >= 200 && item.status < 400) success++;
    durationTotal += count(item.duration);
    const upstreamWait = timingValue(item, 'upstreamWaitMs');
    if (upstreamWait !== null) {
      upstreamWaitRequests++;
      upstreamWaitTotal += upstreamWait;
    }
    const upstreamBody = timingValue(item, 'upstreamBodyMs');
    if (upstreamBody !== null) {
      upstreamBodyRequests++;
      upstreamBodyTotal += upstreamBody;
    }
  }
  return {
    requests,
    success,
    successRate: requests ? round(success / requests * 100, 1) : null,
    averageDurationMs: requests ? Math.round(durationTotal / requests) : 0,
    upstreamWaitCoverageRate: requests ? round(upstreamWaitRequests / requests * 100, 1) : null,
    averageUpstreamWaitMs: upstreamWaitRequests ? Math.round(upstreamWaitTotal / upstreamWaitRequests) : 0,
    upstreamBodyCoverageRate: requests ? round(upstreamBodyRequests / requests * 100, 1) : null,
    averageUpstreamBodyMs: upstreamBodyRequests ? Math.round(upstreamBodyTotal / upstreamBodyRequests) : 0
  };
}

export function aggregateRequestStats(items, window = 'all', now = Date.now()) {
  const from = statsWindowStart(window, now);
  const summaryState = createSummaryState();
  const timelineState = createTimelineState(window, now);
  const groupedState = createGroupedState();
  let retainedRequests = 0;
  for (const item of items) {
    retainedRequests++;
    const timestamp = Date.parse(item.time);
    if (!Number.isFinite(timestamp) || timestamp > now || (from !== null && timestamp < from)) continue;
    const measurement = measureSummaryItem(item);
    addSummaryMeasurement(summaryState, measurement, timelineState, timestamp);
    addGroupedDimensions(groupedState, item, measurement);
  }
  const summary = finishSummary(summaryState);
  const timelineStats = finishTimeline(timelineState);
  const grouped = finishGroupedStats(groupedState);
  return {
    generatedAt: new Date(now).toISOString(),
    window,
    from: from === null ? null : new Date(from).toISOString(),
    retainedRequests,
    summary,
    timeline: timelineStats,
    byProvider: grouped.byProvider,
    byCredential: grouped.byCredential,
    byModel: grouped.byModel,
    byProtocol: grouped.byProtocol,
    byClient: grouped.byClient
  };
}

function statsWindowStart(window, now) {
  if (!Object.hasOwn(WINDOWS, window)) throw Object.assign(new Error('统计时间范围仅支持 all、24h 或 7d'), { status: 400 });
  const duration = WINDOWS[window];
  return duration === null ? null : now - duration;
}

function createTimelineState(window, now) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const bucketMs = window === '24h' ? hour : day;
  const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : 14;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (bucketCount - 1) * bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    start: new Date(start + index * bucketMs).toISOString(),
    requests: 0, errors: 0, totalTokens: 0, cachedInputTokens: 0,
    upstreamWaitRequests: 0, upstreamWaitTotalMs: 0,
    upstreamBodyRequests: 0, upstreamBodyTotalMs: 0
  }));
  return {
    bucket: window === '24h' ? 'hour' : 'day',
    range: window === 'all' ? '14d' : window,
    bucketMs,
    start,
    buckets
  };
}

function addTimelineItem(state, timestamp, measurement) {
  const index = Math.floor((timestamp - state.start) / state.bucketMs);
  if (!Number.isFinite(timestamp) || index < 0 || index >= state.buckets.length) return;
  const bucket = state.buckets[index];
  bucket.requests++;
  if (!measurement.successful) bucket.errors++;
  bucket.totalTokens += measurement.inputTokens + measurement.outputTokens;
  bucket.cachedInputTokens += measurement.cachedInputTokens;
  if (measurement.upstreamWait !== null) {
    bucket.upstreamWaitRequests++;
    bucket.upstreamWaitTotalMs += measurement.upstreamWait;
  }
  if (measurement.upstreamBody !== null) {
    bucket.upstreamBodyRequests++;
    bucket.upstreamBodyTotalMs += measurement.upstreamBody;
  }
}

function finishTimeline(state) {
  return {
    bucket: state.bucket,
    range: state.range,
    buckets: state.buckets.map(({ upstreamWaitTotalMs, upstreamBodyTotalMs, ...bucket }) => ({
      ...bucket,
      averageUpstreamWaitMs: bucket.upstreamWaitRequests ? Math.round(upstreamWaitTotalMs / bucket.upstreamWaitRequests) : 0,
      averageUpstreamBodyMs: bucket.upstreamBodyRequests ? Math.round(upstreamBodyTotalMs / bucket.upstreamBodyRequests) : 0
    }))
  };
}

function credentialName(item) {
  const provider = String(item.provider || '未知').toUpperCase();
  const [source, slot] = String(item.credentialId || '').split(':');
  if (source === 'environment' && /^\d+$/.test(slot)) return `${provider} 环境 #${slot}`;
  if (source === 'config') return `${provider} · ${String(item.credentialLabel || '面板 Key').slice(0, 64)}`;
  return `${provider} 旧记录`;
}

function createSummaryState() {
  return {
    requests: 0,
    success: 0,
    durationTotal: 0,
    streamRequests: 0,
    usageRequests: 0,
    cacheHitRequests: 0,
    cacheWriteRequests: 0,
    credentialAttempts: 0,
    failoverRequests: 0,
    upstreamWaitTotal: 0,
    upstreamBodyTotal: 0,
    durations: [],
    upstreamWaitValues: [],
    upstreamBodyValues: [],
    tokens: {
      inputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0
    }
  };
}

function measureSummaryItem(item) {
  const usage = tokenUsage(item);
  return {
    successful: item.status >= 200 && item.status < 400,
    duration: count(item.duration),
    upstreamWait: timingValue(item, 'upstreamWaitMs'),
    upstreamBody: timingValue(item, 'upstreamBodyMs'),
    inputTokens: usage.inputTokens,
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: count(item.outputTokens),
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    reasoningTokens: count(item.reasoningTokens),
    usagePresent: Object.hasOwn(item, 'inputTokens') || Object.hasOwn(item, 'outputTokens')
      || Object.hasOwn(item, 'cachedInputTokens') || Object.hasOwn(item, 'cacheCreationInputTokens')
      || Object.hasOwn(item, 'reasoningTokens'),
    attempts: count(item.credentialAttempts),
    stream: Boolean(item.stream)
  };
}

function addSummaryMeasurement(state, item, timelineState, timestamp) {
  state.requests++;
  if (item.successful) state.success++;
  state.durations.push(item.duration);
  state.durationTotal += item.duration;
  const upstreamWait = item.upstreamWait;
  if (upstreamWait !== null) {
    state.upstreamWaitValues.push(upstreamWait);
    state.upstreamWaitTotal += upstreamWait;
  }
  const upstreamBody = item.upstreamBody;
  if (upstreamBody !== null) {
    state.upstreamBodyValues.push(upstreamBody);
    state.upstreamBodyTotal += upstreamBody;
  }
  state.tokens.inputTokens += item.inputTokens;
  state.tokens.uncachedInputTokens += item.uncachedInputTokens;
  state.tokens.outputTokens += item.outputTokens;
  state.tokens.cachedInputTokens += item.cachedInputTokens;
  state.tokens.cacheCreationInputTokens += item.cacheCreationInputTokens;
  state.tokens.reasoningTokens += item.reasoningTokens;
  if (item.usagePresent) state.usageRequests++;
  if (item.cachedInputTokens > 0) state.cacheHitRequests++;
  if (item.cacheCreationInputTokens > 0) state.cacheWriteRequests++;
  state.credentialAttempts += Math.max(1, item.attempts);
  if (item.attempts > 1) state.failoverRequests++;
  if (item.stream) state.streamRequests++;
  if (timelineState) addTimelineItem(timelineState, timestamp, item);
}

function finishSummary(state) {
  const {
    requests, success, durationTotal, streamRequests, usageRequests, cacheHitRequests, cacheWriteRequests,
    credentialAttempts, failoverRequests, upstreamWaitTotal, upstreamBodyTotal,
    durations, upstreamWaitValues, upstreamBodyValues, tokens
  } = state;
  durations.sort((left, right) => left - right);
  const upstreamWait = timingSummary(upstreamWaitValues, upstreamWaitTotal);
  const upstreamBody = timingSummary(upstreamBodyValues, upstreamBodyTotal);
  return {
    requests,
    success,
    errors: requests - success,
    successRate: requests ? round(success / requests * 100, 1) : null,
    averageDurationMs: durations.length ? Math.round(durationTotal / durations.length) : 0,
    p95DurationMs: durations.length ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] : 0,
    upstreamWaitRequests: upstreamWait.requests,
    upstreamWaitCoverageRate: requests ? round(upstreamWait.requests / requests * 100, 1) : null,
    averageUpstreamWaitMs: upstreamWait.average,
    p95UpstreamWaitMs: upstreamWait.p95,
    upstreamBodyRequests: upstreamBody.requests,
    upstreamBodyCoverageRate: requests ? round(upstreamBody.requests / requests * 100, 1) : null,
    averageUpstreamBodyMs: upstreamBody.average,
    p95UpstreamBodyMs: upstreamBody.p95,
    streamRequests,
    usageRequests,
    missingUsageRequests: requests - usageRequests,
    usageCoverageRate: requests ? round(usageRequests / requests * 100, 1) : null,
    cacheHitRequests,
    cacheWriteRequests,
    credentialAttempts,
    failoverRequests,
    failoverAttempts: Math.max(0, credentialAttempts - requests),
    cacheHitRequestRate: usageRequests ? round(cacheHitRequests / usageRequests * 100, 1) : 0,
    ...tokens,
    cacheReadRate: tokens.inputTokens ? round(tokens.cachedInputTokens / tokens.inputTokens * 100, 1) : 0,
    totalTokens: tokens.inputTokens + tokens.outputTokens,
    averageTokensPerUsageRequest: usageRequests ? Math.round((tokens.inputTokens + tokens.outputTokens) / usageRequests) : 0
  };
}

function timingSummary(values, total) {
  values.sort((left, right) => left - right);
  return {
    requests: values.length,
    average: values.length ? Math.round(total / values.length) : 0,
    p95: values.length ? Math.round(values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]) : 0
  };
}

function timingValue(item, field) {
  if (!Object.hasOwn(item, field)) return null;
  const value = Number(item[field]);
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : null;
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

function createGroupedState() {
  return {
    byProvider: new Map(),
    byCredential: new Map(),
    byModel: new Map(),
    byProtocol: new Map(),
    byClient: new Map()
  };
}

function addGroupedDimensions(state, item, measurement) {
  addGroupedItem(state.byProvider, item.provider || '未知', measurement);
  addGroupedItem(state.byCredential, credentialName(item), measurement);
  addGroupedItem(state.byModel, item.upstreamModel || item.model || '未知', measurement);
  addGroupedItem(state.byProtocol, item.protocol || '未知', measurement);
  addGroupedItem(state.byClient, item.clientName || '主令牌', measurement);
}

function finishGroupedStats(state) {
  return {
    byProvider: summarizeGroups(state.byProvider),
    byCredential: summarizeGroups(state.byCredential, 64),
    byModel: summarizeGroups(state.byModel, 25),
    byProtocol: summarizeGroups(state.byProtocol, 25),
    byClient: summarizeGroups(state.byClient, 25)
  };
}

function addGroupedItem(groups, value, measurement) {
  const key = String(value).slice(0, 256);
  let state = groups.get(key);
  if (!state) {
    state = createSummaryState();
    groups.set(key, state);
  }
  addSummaryMeasurement(state, measurement);
}

function summarizeGroups(groups, limit = groups.size) {
  const ranked = [...groups];
  ranked.sort(([leftName, left], [rightName, right]) => (
    summaryTotalTokens(right) - summaryTotalTokens(left)
    || right.requests - left.requests
    || leftName.localeCompare(rightName, 'zh-CN')
  ));
  if (ranked.length > limit) ranked.length = limit;
  return ranked.map(([name, state]) => ({ name, ...finishSummary(state) }));
}

function summaryTotalTokens(state) {
  return state.tokens.inputTokens + state.tokens.outputTokens;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
