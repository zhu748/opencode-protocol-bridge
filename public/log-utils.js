const TIME_WINDOWS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };

export function filterRequestLogs(items, { query = '', provider = 'all', status = 'all', timeRange = 'all', now = Date.now() } = {}) {
  const needle = String(query).trim().toLocaleLowerCase();
  const windowMs = TIME_WINDOWS[timeRange];
  return (Array.isArray(items) ? items : []).filter((item) => {
    const timestamp = Date.parse(item.time);
    if (windowMs && (!Number.isFinite(timestamp) || timestamp < now - windowMs || timestamp > now)) return false;
    if (provider !== 'all' && item.provider !== provider) return false;
    if (status === 'success' && !(item.status >= 200 && item.status < 400)) return false;
    if (status === 'canceled' && item.status !== 499) return false;
    if (status === 'client-error' && !(item.status >= 400 && item.status < 500 && ![429, 499].includes(item.status))) return false;
    if (status === 'server-error' && item.status < 500) return false;
    if (status === 'rate-limit' && item.status !== 429) return false;
    if (!needle) return true;
    return [item.requestId, item.upstreamRequestId, item.clientName, item.model, item.upstreamModel, item.provider, item.protocol, item.requestKind, item.requestedReasoningEffort, item.reasoningEffort, item.bridgeWebSearchCalls, item.responseDegradations, item.credentialId, item.credentialLabel, item.credentialAttempts, item.retryAfter, item.errorCode, item.error]
      .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
  });
}

export function requestLogsToCsv(items) {
  const columns = [
    ['时间', 'time'], ['本地请求 ID', 'requestId'], ['上游请求 ID', 'upstreamRequestId'], ['客户端', 'clientName'],
    ['请求模型', 'model'], ['上游模型', 'upstreamModel'], ['上游', 'provider'], ['Key ID', 'credentialId'], ['Key 名称', 'credentialLabel'],
    ['协议转换', 'protocol'], ['请求类型', 'requestKind'], ['客户端思考强度', 'requestedReasoningEffort'], ['最终上游思考强度', 'reasoningEffort'], ['本地 Web Search 次数', 'bridgeWebSearchCalls'], ['响应元数据降级', 'responseDegradations'], ['状态', 'status'], ['输入 Token', 'inputTokens'], ['输出 Token', 'outputTokens'],
    ['缓存读取 Token', 'cachedInputTokens'], ['缓存写入 Token', 'cacheCreationInputTokens'], ['5 分钟缓存写入 Token', 'cacheCreation5mInputTokens'], ['1 小时缓存写入 Token', 'cacheCreation1hInputTokens'], ['推理 Token', 'reasoningTokens'],
    ['总耗时 ms', 'duration'], ['上游等待 ms', 'upstreamWaitMs'], ['响应体阶段 ms', 'upstreamBodyMs'],
    ['Key 尝试次数', 'credentialAttempts'], ['Retry-After', 'retryAfter'], ['错误代码', 'errorCode'], ['错误', 'error']
  ];
  const rows = [columns.map(([label]) => csvCell(label))];
  for (const item of Array.isArray(items) ? items : []) rows.push(columns.map(([, field]) => csvCell(item?.[field] ?? '')));
  return rows.map((row) => row.join(',')).join('\r\n');
}

export function compactIdentifier(value) {
  const text = String(value || '');
  return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
