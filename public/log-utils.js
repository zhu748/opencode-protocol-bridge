const TIME_WINDOWS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };

export function filterRequestLogs(items, { query = '', provider = 'all', status = 'all', timeRange = 'all', now = Date.now() } = {}) {
  const needle = String(query).trim().toLocaleLowerCase();
  const windowMs = TIME_WINDOWS[timeRange];
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (windowMs && (!Number.isFinite(Date.parse(item.time)) || Date.parse(item.time) < now - windowMs)) return false;
    if (provider !== 'all' && item.provider !== provider) return false;
    if (status === 'success' && !(item.status >= 200 && item.status < 400)) return false;
    if (status === 'client-error' && !(item.status >= 400 && item.status < 500 && item.status !== 429)) return false;
    if (status === 'server-error' && item.status < 500) return false;
    if (status === 'rate-limit' && item.status !== 429) return false;
    if (!needle) return true;
    return [item.requestId, item.upstreamRequestId, item.clientName, item.model, item.upstreamModel, item.provider, item.protocol, item.credentialLabel, item.error]
      .some((value) => String(value || '').toLocaleLowerCase().includes(needle));
  });
}

export function requestLogsToCsv(items) {
  const columns = [
    ['时间', 'time'], ['本地请求 ID', 'requestId'], ['上游请求 ID', 'upstreamRequestId'], ['客户端', 'clientName'],
    ['请求模型', 'model'], ['上游模型', 'upstreamModel'], ['上游', 'provider'], ['Key ID', 'credentialId'], ['Key 名称', 'credentialLabel'],
    ['协议转换', 'protocol'], ['状态', 'status'], ['输入 Token', 'inputTokens'], ['输出 Token', 'outputTokens'],
    ['缓存读取 Token', 'cachedInputTokens'], ['缓存写入 Token', 'cacheCreationInputTokens'], ['推理 Token', 'reasoningTokens'],
    ['耗时 ms', 'duration'], ['Key 尝试次数', 'credentialAttempts'], ['Retry-After', 'retryAfter'], ['错误', 'error']
  ];
  const rows = [columns.map(([label]) => csvCell(label))];
  for (const item of Array.isArray(items) ? items : []) rows.push(columns.map(([, field]) => csvCell(item?.[field] ?? '')));
  return rows.map((row) => row.join(',')).join('\r\n');
}

export function compactIdentifier(value) {
  const text = String(value || '');
  return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

export function formatCooldownRemaining(value, now = Date.now()) {
  const remaining = Math.max(0, Date.parse(value) - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return '可重新探测';
  const seconds = Math.ceil(remaining / 1000);
  if (seconds < 60) return `剩余 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `剩余 ${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `剩余 ${hours} 小时 ${minutes % 60} 分`;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
