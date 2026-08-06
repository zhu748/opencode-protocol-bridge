import { compactIdentifier, filterRequestLogs, formatCooldownRemaining, requestLogsToCsv } from './log-utils.js';
import { createLatestRequestGate, optionalLoad, summarizeSourceFailures } from './refresh-utils.js';
import { escapeHtml } from './html-utils.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let config = {};
let setupMode = false;
let recentPrompt = {};
let editingPromptRuleIndex = -1;
let editingProviderCredential = null;
let requestLogItems = [];
let clientItems = [];
let serviceStatus = null;
let imageHandoffModels = [];
const discoveredImageModels = new Map();
const dataSourceFailures = new Map();
const refreshGate = createLatestRequestGate();
const dataSourceGates = new Map();
const imageModelDiscoveryGate = createLatestRequestGate();
const dirtyConfigSections = new Set();
let toastTimer;
let configSaveInProgress = false;
let configConflictMessage = '';

function renderConfigDraftStatus() {
  const node = $('#config-draft-status');
  const dirty = dirtyConfigMessage();
  node.textContent = configConflictMessage || (dirty ? `未保存：${dirty}` : '');
  node.classList.toggle('conflict', Boolean(configConflictMessage));
  node.classList.toggle('hidden', !node.textContent);
  node.title = node.textContent;
}

function markConfigDirty(section) {
  dirtyConfigSections.add(section);
  renderConfigDraftStatus();
}

function clearConfigDirty(section) {
  if (section) dirtyConfigSections.delete(section);
  renderConfigDraftStatus();
}

function dirtyConfigMessage() {
  const labels = { settings: '连接设置', routes: '模型路由', images: '图片附件交接', prompts: '提示词规则' };
  return [...dirtyConfigSections].map((section) => labels[section] || section).join('、');
}

function confirmDiscardConfigDrafts(action) {
  return !dirtyConfigSections.size || confirm(`${dirtyConfigMessage()}有未保存修改，${action}会丢弃这些内容。确认继续？`);
}

function discardConfigDrafts() {
  dirtyConfigSections.clear();
  configConflictMessage = '';
  renderConfigDraftStatus();
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (response.ok) throw new Error(`接口返回的 JSON 无效（HTTP ${response.status}）`);
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401 && !['/api/login', '/api/session'].includes(path)) location.reload();
    const error = new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error?.code || data.code || '';
    throw error;
  }
  return data;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

function configPreconditionHeaders() {
  return config.revision ? { 'if-match': `"${config.revision}"` } : {};
}

function acceptConfigRevision(result) {
  if (typeof result?.revision === 'string') config.revision = result.revision;
  return result;
}

async function normalizedConfigMutationError(error) {
  if (error.status !== 412) return error;
  let refreshed = true;
  try { await refresh(); }
  catch { refreshed = false; }
  configConflictMessage = refreshed
    ? '配置已在其他页面更新；最新修订已载入，当前草稿仍保留，请核对后再次操作'
    : '配置已在其他页面更新；当前草稿仍保留，但自动载入最新修订失败，请稍后刷新';
  renderConfigDraftStatus();
  const conflict = new Error(configConflictMessage);
  conflict.status = 412;
  return conflict;
}

async function withPendingControl(control, pendingText, operation) {
  if (!control || control.disabled || control.dataset.pending === 'true') return undefined;
  const originalText = control.textContent;
  control.dataset.pending = 'true';
  control.disabled = true;
  if (pendingText) control.textContent = pendingText;
  try { return await operation(); }
  finally {
    delete control.dataset.pending;
    control.disabled = false;
    control.textContent = originalText;
  }
}

function fillProxyPreset(button) {
  const field = $(button.dataset.proxyTarget);
  if (!field) return;
  field.value = button.dataset.proxyValue;
  if (field.id === 'proxyUrl') {
    markConfigDirty('settings');
    renderDefaultProxyStatus();
  }
  if (field.id === 'providerCredentialProxy') $('#providerCredentialClearProxy').checked = false;
  field.focus();
  toast(`已填入代理：${button.dataset.proxyValue}`);
}

function renderDefaultProxyStatus() {
  const state = $('#default-proxy-state');
  const draft = $('#proxyUrl').value.trim();
  state.classList.toggle('pending', Boolean(draft));
  state.classList.toggle('enabled', !draft && Boolean(config.proxyConfigured));
  state.textContent = draft ? '新代理待保存' : config.proxyConfigured ? '默认代理已启用' : '当前直连';
  state.title = draft ? '检测成功后仍需点击“保存设置”才会正式启用' : state.textContent;
}

function renderDataSourceFailures() {
  const warning = $('#data-source-warning');
  const summary = summarizeSourceFailures(dataSourceFailures);
  warning.textContent = summary.message;
  warning.title = summary.detail;
  warning.classList.toggle('hidden', !summary.message);
}

function dataSourceGate(name) {
  if (!dataSourceGates.has(name)) dataSourceGates.set(name, createLatestRequestGate());
  return dataSourceGates.get(name);
}

async function loadDataSource(name, loader, fallback, apply) {
  const gate = dataSourceGate(name);
  const generation = gate.begin();
  const result = await optionalLoad(() => loader(generation.controller.signal), fallback);
  if (!gate.isCurrent(generation)) return { ...result, current: false };
  if (result.fresh) dataSourceFailures.delete(name);
  else dataSourceFailures.set(name, result.error.message);
  if (result.fresh && apply) apply(result.value);
  renderDataSourceFailures();
  return { ...result, current: true };
}

function renderRuntimeSummary() {
  $('#request-count').textContent = requestLogItems.length;
  const statusStale = dataSourceFailures.has('运行状态');
  const logsStale = dataSourceFailures.has('请求日志');
  if (serviceStatus) {
    const successSummary = serviceStatus.requests ? `${formatPercentage(serviceStatus.successRate)} 成功` : '暂无请求';
    const averageUpstreamBody = serviceStatus.upstreamBodyTimingCoverageRate > 0 ? formatDuration(serviceStatus.averageUpstreamBody) : '—';
    const upstreamTiming = serviceStatus.upstreamTimingCoverageRate > 0
      ? ` · 上游等待 ${formatDuration(serviceStatus.averageUpstreamWait)} · 响应体 ${averageUpstreamBody}`
      : '';
    const httpConnections = Number.isFinite(serviceStatus.activeHttpConnections)
      ? ` · 连接 ${formatNumber(serviceStatus.activeHttpConnections)}/${formatNumber(serviceStatus.maxHttpConnections)}`
      : '';
    const adminMutations = serviceStatus.activeAdminMutations ? ` · 管理写 ${formatNumber(serviceStatus.activeAdminMutations)}/${formatNumber(serviceStatus.maxAdminMutations)}` : '';
    const adminDiscoveries = serviceStatus.activeAdminModelDiscoveries ? ` · 模型发现 ${formatNumber(serviceStatus.activeAdminModelDiscoveries)}/${formatNumber(serviceStatus.maxAdminModelDiscoveries)}` : '';
    $('#request-summary').textContent = `${successSummary} · 活跃 ${serviceStatus.activeRequests}${httpConnections}${adminMutations}${adminDiscoveries} · 平均 ${formatDuration(serviceStatus.averageDuration)}${upstreamTiming} · ${serviceStatus.memoryMb} MiB${serviceStatus.logPersistenceError ? ' · 日志异常' : ''}${statusStale ? ' · 状态未更新' : ''}${logsStale ? ' · 日志未更新' : ''}`;
    $('#request-summary').title = serviceStatus.logPersistenceError || '';
  } else {
    $('#request-summary').textContent = `运行状态暂不可用${logsStale ? ' · 日志未更新' : ''}`;
    $('#request-summary').title = dataSourceFailures.get('运行状态') || '';
  }
  if (statusStale || !serviceStatus) {
    $('#service-state').textContent = serviceStatus ? '● 状态陈旧' : '● 状态未知';
    $('#service-state').classList.add('warning');
  } else {
    $('#service-state').textContent = serviceStatus.ready ? '● READY' : '● 待配置';
    $('#service-state').classList.toggle('warning', !serviceStatus.ready);
  }
}

async function boot() {
  const session = await api('/api/session');
  if (!session.authenticated) {
    setupMode = !session.configured;
    $('#auth-title').textContent = setupMode ? '初始化控制台' : '欢迎回来';
    $('#auth-copy').textContent = setupMode ? '设置管理密码。系统会自动生成客户端访问令牌。' : '输入管理密码以打开控制台。';
    $('#auth-action').textContent = setupMode ? '创建并进入' : '登录';
    $('#auth').classList.remove('hidden');
    return;
  }
  $('#app').classList.remove('hidden');
  await refresh();
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#auth-error').textContent = '';
  try {
    const result = await api(setupMode ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    if (result.clientToken) alert(`请立即保存客户端访问令牌（之后只显示遮罩）：\n\n${result.clientToken}`);
    location.reload();
  } catch (error) { $('#auth-error').textContent = error.message; }
});

async function refresh() {
  const generation = refreshGate.begin();
  dataSourceGate('Claude 提示词快照').invalidate();
  if ($('#stats').classList.contains('active')) dataSourceGate('用量统计').invalidate();
  let nextConfig;
  try {
    [nextConfig] = await Promise.all([
      api('/api/config', { signal: generation.controller.signal }),
      loadDataSource('请求日志', (signal) => api('/api/logs', { signal }), requestLogItems, (value) => { requestLogItems = value; }),
      loadDataSource('运行状态', (signal) => api('/api/status', { signal }), serviceStatus, (value) => { serviceStatus = value; }),
      loadDataSource('客户端列表', (signal) => api('/api/clients', { signal }), clientItems, (value) => { clientItems = value; })
    ]);
  } catch (error) {
    if (!refreshGate.isCurrent(generation)) return { degraded: dataSourceFailures.size, superseded: true };
    throw error;
  }
  if (!refreshGate.isCurrent(generation)) return { degraded: dataSourceFailures.size, superseded: true };
  config = nextConfig;
  configConflictMessage = '';
  renderConfigDraftStatus();
  $('#base-url').textContent = location.origin;
  $('#endpoint-code').textContent = `${location.origin}/zen/v1`;
  $('#go-endpoint-code').textContent = `${location.origin}/go/v1`;
  const providerState = (provider) => {
    const environmentCount = config[`${provider}EnvironmentKeyCount`] || 0;
    const panelCount = (config[`${provider}Credentials`] || []).length;
    return environmentCount ? `环境 Key × ${environmentCount}` : panelCount ? `面板 Key × ${panelCount}` : '未配置';
  };
  $('#zen-state').textContent = providerState('zen');
  $('#go-state').textContent = providerState('go');
  $('#zen-proxy-state').textContent = config.zenProxyConfigured ? '使用 Zen 独立代理' : config.proxyConfigured ? '使用默认代理' : '直连上游';
  $('#go-proxy-state').textContent = config.goProxyConfigured ? '使用 Go 独立代理' : config.proxyConfigured ? '使用默认代理' : '直连上游';
  renderRuntimeSummary();
  if (!dirtyConfigSections.has('settings')) {
    $('#defaultProvider').value = config.defaultProvider;
    for (const [field, configured, fallback] of [['proxyUrl', config.proxyConfigured, 'http://127.0.0.1:7890']]) {
      $(`#${field}`).value = '';
      $(`#${field}`).placeholder = configured ? `当前：${config[field]}` : fallback;
    }
    $('#requestLogLimit').value = config.requestLogLimit;
    $('#persistLogs').checked = Boolean(config.persistLogs);
    $('#upstreamTimeoutMs').value = config.upstreamTimeoutMs;
    $('#maxConcurrentRequests').value = config.maxConcurrentRequests;
    $('#keepAliveUrl').value = config.keepAliveUrl || '';
    $('#keepAliveIntervalSeconds').value = config.keepAliveIntervalSeconds || 60;
    $('#keepAliveUrl').disabled = Boolean(config.urlManagedByEnvironment);
    $('#keepAliveIntervalSeconds').disabled = Boolean(config.intervalManagedByEnvironment);
    $('#set-current-keep-alive').disabled = Boolean(config.urlManagedByEnvironment);
    $('#disable-keep-alive').disabled = Boolean(config.urlManagedByEnvironment);
    $('#keep-alive-url-help').textContent = config.urlManagedByEnvironment
      ? '当前 URL 由 OPENCODE_BRIDGE_KEEP_ALIVE_URL 管理；修改环境变量并重新部署后生效。'
      : '建议使用当前服务的 /healthz；不跟随重定向，也不会读取响应正文。';
    $('#clientToken').placeholder = config.clientToken ? `当前：${config.clientToken}` : '填写客户端访问令牌';
  }
  renderDefaultProxyStatus();
  $('#encryption-state').textContent = config.encryptionEnabled ? '配置已加密' : '配置未加密';
  $('#encryption-state').classList.toggle('enabled', config.encryptionEnabled);
  const singBox = config.singBoxRuntime || {};
  const singBoxSources = { project: '项目内', path: 'PATH', environment: '环境路径' };
  $('#sing-box-state').textContent = singBox.available
    ? `sing-box ${singBox.version || ''} 可用`
    : 'sing-box 未检测到';
  $('#sing-box-state').title = singBox.available
    ? `来源：${singBoxSources[singBox.source] || '未知'}`
    : 'hy2/TUIC/VLESS/VMess 等分享链接需要安装 sing-box';
  $('#sing-box-state').classList.toggle('enabled', Boolean(singBox.available));
  $('#sing-box-state').classList.toggle('unavailable', !singBox.available);
  renderKeepAliveStatus();
  if (!dirtyConfigSections.has('routes')) {
    $('#modelRoutes').value = JSON.stringify(config.modelRoutes || {}, null, 2);
    renderRouteList(config.modelRoutes || {});
  }
  if (!dirtyConfigSections.has('images')) imageHandoffModels = Array.isArray(config.imageHandoffModels) ? config.imageHandoffModels.map((entry) => ({ ...entry })) : [];
  if (!dirtyConfigSections.has('prompts')) {
    $('#promptRules').value = JSON.stringify(config.promptRewriteRules || [], null, 2);
    renderPromptRuleList();
  }
  renderClients(clientItems);
  renderProviderCredentials();
  renderImageHandoffSettings();
  renderLogs();
  renderExamples();
  const secondaryLoads = [loadDataSource('Claude 提示词快照', refreshPrompt, undefined, renderRecentPrompt)];
  if ($('#stats').classList.contains('active')) secondaryLoads.push(loadDataSource('用量统计', refreshStats, undefined, renderStats));
  await Promise.all(secondaryLoads);
  return { degraded: dataSourceFailures.size };
}

async function refreshPrompt(signal) {
  return api('/api/prompt-rewrite/recent', { signal });
}

function renderRecentPrompt(snapshot = {}) {
  recentPrompt = snapshot;
  $('#promptOriginal').value = recentPrompt.original || '';
  $('#promptFinal').value = recentPrompt.final || '';
  if (!recentPrompt.time) {
    $('#prompt-meta').textContent = '还没有收到 Claude Messages 请求';
    renderPromptRuleResults([]);
    renderPromptRuleList();
    return;
  }
  const actions = (recentPrompt.applied || []).map((item) => `${item.action === 'delete' ? '已删除' : '已替换'}${item.name}×${item.count}`).join('，') || '没有规则命中';
  const truncated = recentPrompt.originalTruncated || recentPrompt.finalTruncated ? ' · 内存预览已截断' : '';
  $('#prompt-meta').textContent = `${recentPrompt.model} · ${recentPrompt.protocol} → ${recentPrompt.upstreamProtocol || 'unknown'} · ${new Date(recentPrompt.time).toLocaleString()} · 原始 ${recentPrompt.originalBytes}B → 最终 ${recentPrompt.finalBytes}B · ${actions}${truncated}`;
  renderPromptRuleResults(recentPrompt.ruleResults || []);
  renderPromptRuleList();
}

function promptRulesFromEditor() {
  const rules = JSON.parse($('#promptRules').value || '[]');
  if (!Array.isArray(rules)) throw new Error('规则必须是数组');
  return rules;
}

function setPromptRules(rules) {
  $('#promptRules').value = JSON.stringify(rules, null, 2);
  markConfigDirty('prompts');
  renderPromptRuleList();
}

function promptRuleState(rule) {
  const result = (recentPrompt.ruleResults || []).find((item) => item.id === rule.id);
  if (!recentPrompt.time) return { label: '等待请求', className: 'pending' };
  if (!rule.enabled || result?.status === 'disabled') return { label: '已停用', className: 'disabled' };
  if (result?.status === 'applied') return { label: `已生效 ×${result.count}`, className: 'applied' };
  return { label: '本次未命中', className: 'unmatched' };
}

function renderPromptRuleList() {
  let rules;
  try { rules = promptRulesFromEditor(); }
  catch { return; }
  $('#prompt-rule-list').innerHTML = rules.length ? rules.map((rule, index) => {
    const state = promptRuleState(rule);
    const action = String(rule.replace ?? '') ? '替换' : '删除';
    const preview = String(rule.find ?? '').replace(/\s+/g, ' ').slice(0, 120);
    return `<article class="prompt-rule-item"><div class="prompt-rule-main"><span class="rule-state ${state.className}">${escapeHtml(state.label)}</span><div><strong>${escapeHtml(rule.name || `规则 ${index + 1}`)}</strong><p>${action} · ${escapeHtml(preview || '未填写查找内容')}${String(rule.find ?? '').length > 120 ? '…' : ''}</p></div></div><span class="client-actions"><button class="mini-btn toggle-prompt-rule" data-index="${index}" type="button">${rule.enabled === false ? '启用' : '停用'}</button><button class="mini-btn edit-prompt-rule" data-index="${index}" type="button">编辑</button><button class="mini-btn revoke delete-prompt-rule" data-index="${index}" type="button">删除</button></span></article>`;
  }).join('') : '<p class="empty-inline">还没有提示词规则</p>';
  $$('.toggle-prompt-rule').forEach((button) => button.addEventListener('click', () => {
    const next = promptRulesFromEditor();
    const index = Number(button.dataset.index);
    next[index] = { ...next[index], enabled: next[index].enabled === false };
    setPromptRules(next);
  }));
  $$('.edit-prompt-rule').forEach((button) => button.addEventListener('click', () => beginPromptRuleEdit(Number(button.dataset.index))));
  $$('.delete-prompt-rule').forEach((button) => button.addEventListener('click', () => {
    const next = promptRulesFromEditor();
    next.splice(Number(button.dataset.index), 1);
    setPromptRules(next);
    resetPromptRuleForm();
    toast('规则已从编辑器删除，点击保存设置后生效');
  }));
}

function renderPromptRuleResults(results) {
  const labels = { applied: '已生效', unmatched: '未命中', disabled: '已停用' };
  const classes = { applied: 'applied', unmatched: 'unmatched', disabled: 'disabled' };
  $('#prompt-rule-results').innerHTML = results.length ? results.map((item) => `<div class="prompt-result"><span class="rule-state ${classes[item.status] || 'pending'}">${labels[item.status] || '未知'}</span><strong>${escapeHtml(item.name)}</strong><span>${item.action === 'delete' ? '删除' : '替换'}${item.count ? ` ×${formatNumber(item.count)}` : ''}</span></div>`).join('') : '<p class="empty-inline">收到 Claude 请求后显示</p>';
}

function beginPromptRuleEdit(index) {
  const rule = promptRulesFromEditor()[index];
  if (!rule) return;
  editingPromptRuleIndex = index;
  $('#promptRuleName').value = rule.name || '';
  $('#promptRuleEnabled').checked = rule.enabled !== false;
  $('#promptRuleFind').value = rule.find || '';
  $('#promptRuleReplace').value = rule.replace || '';
  $('#submit-prompt-rule').textContent = '更新规则';
  $('#cancel-prompt-rule').classList.remove('hidden');
  $('#promptRuleName').focus();
}

function resetPromptRuleForm() {
  editingPromptRuleIndex = -1;
  $('#prompt-rule-form').reset();
  $('#promptRuleEnabled').checked = true;
  $('#submit-prompt-rule').textContent = '添加规则';
  $('#cancel-prompt-rule').classList.add('hidden');
}

function filteredLogs() {
  return filterRequestLogs(requestLogItems, {
    query: $('#log-search').value,
    provider: $('#log-provider-filter').value,
    status: $('#log-status-filter').value,
    timeRange: $('#log-time-filter').value
  });
}

function requestIdButton(value, label = '') {
  if (!value) return label || '—';
  return `<button class="log-id-copy" type="button" data-copy-value="${escapeHtml(value)}" aria-label="复制 ${escapeHtml(label || '请求 ID')}" title="复制 ${escapeHtml(label || '请求 ID')}：${escapeHtml(value)}"><code>${escapeHtml(compactIdentifier(value))}</code></button>`;
}

function credentialLabel(item) {
  const provider = String(item.provider || '').toUpperCase();
  const [source, slot] = String(item.credentialId || '').split(':');
  if (source === 'environment' && slot) return `${provider} 环境 #${slot}`;
  if (source === 'config') return `${provider} · ${item.credentialLabel || '面板 Key'}`;
  return item.credentialLabel || '—';
}

function renderLogs() {
  const items = filteredLogs();
  $('#empty-logs').textContent = requestLogItems.length ? '没有符合筛选条件的请求记录' : '还没有请求记录';
  $('#empty-logs').classList.toggle('hidden', items.length > 0);
  $('#log-filter-count').textContent = `显示 ${formatNumber(items.length)} / ${formatNumber(requestLogItems.length)}`;
  $('#export-logs').disabled = items.length === 0;
  $('#log-rows').innerHTML = items.map((item) => {
    const tokens = item.inputTokens === undefined ? '—' : `${item.inputTokens} / ${item.outputTokens}${item.cachedInputTokens ? ` · 缓存读取 ${item.cachedInputTokens}` : ''}${item.cacheCreationInputTokens ? ` · 缓存写入 ${item.cacheCreationInputTokens}` : ''}${item.reasoningTokens ? ` · 推理 ${item.reasoningTokens}` : ''}`;
    const model = item.upstreamModel && item.upstreamModel !== item.model ? `${item.model} → ${item.upstreamModel}` : item.model;
    const statusClass = item.status >= 200 && item.status < 400 ? 'status-ok' : 'status-bad';
    const errorText = [item.errorCode, item.error].filter(Boolean).join(' · ');
    const error = errorText ? `<small class="log-error" title="${escapeHtml(errorText)}">${escapeHtml(errorText)}</small>` : '';
    const upstreamRequestId = item.upstreamRequestId
      ? `<small class="log-upstream-id">上游 ${requestIdButton(item.upstreamRequestId, '上游请求 ID')}</small>`
      : '';
    const retryAfter = item.retryAfter ? `<small class="log-retry-after">等待 ${escapeHtml(item.retryAfter)}</small>` : '';
    const attempts = Number(item.credentialAttempts) > 1 ? `<small class="log-key-attempts">尝试 ${formatNumber(item.credentialAttempts)} 把 Key</small>` : '';
    const credential = `${escapeHtml(credentialLabel(item))}${attempts}`;
    const phases = [
      Object.hasOwn(item, 'upstreamWaitMs') ? `等待 ${formatDuration(item.upstreamWaitMs)}` : '',
      Object.hasOwn(item, 'upstreamBodyMs') ? `响应体 ${formatDuration(item.upstreamBodyMs)}` : ''
    ].filter(Boolean).join(' · ');
    const timing = `${formatDuration(item.duration)}${phases ? `<small class="log-timing">${phases}</small>` : ''}`;
    return `<tr><td>${escapeHtml(new Date(item.time).toLocaleString())}</td><td>${requestIdButton(item.requestId, '本地请求 ID')}${upstreamRequestId}</td><td>${escapeHtml(item.clientName || '主令牌')}</td><td>${escapeHtml(model)}</td><td>${escapeHtml(item.provider)}</td><td class="log-key">${credential}</td><td>${escapeHtml(item.protocol)}</td><td class="${statusClass}">${formatNumber(item.status)}${retryAfter}${error}</td><td>${escapeHtml(tokens)}</td><td>${timing}</td></tr>`;
  }).join('');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatDuration(value) {
  const milliseconds = Number(value) || 0;
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 1 : 2)} s` : `${formatNumber(milliseconds)} ms`;
}

function renderLatency(item) {
  if (!item.requests) return '<div class="stats-latency" title="尚无请求数据"><strong>暂无请求</strong><small>等待 —</small><small>响应体 —</small></div>';
  const averageAndP95 = (average, p95) => `${formatDuration(average)} / ${formatDuration(p95)}`;
  const wait = item.upstreamWaitRequests ? averageAndP95(item.averageUpstreamWaitMs, item.p95UpstreamWaitMs) : '—';
  const body = item.upstreamBodyRequests ? averageAndP95(item.averageUpstreamBodyMs, item.p95UpstreamBodyMs) : '—';
  const phaseCoverage = item.upstreamWaitRequests || item.upstreamBodyRequests
    ? `阶段覆盖：等待 ${formatPercentage(item.upstreamWaitCoverageRate)}，响应体 ${formatPercentage(item.upstreamBodyCoverageRate)}`
    : '旧日志暂无阶段耗时';
  return `<div class="stats-latency" title="${escapeHtml(`格式为平均 / P95；${phaseCoverage}`)}"><strong>总计 ${averageAndP95(item.averageDurationMs, item.p95DurationMs)}</strong><small>等待 ${wait}</small><small>响应体 ${body}</small></div>`;
}

function updateCooldownCountdowns() {
  $$('.cooldown-countdown').forEach((node) => {
    node.textContent = formatCooldownRemaining(node.dataset.cooldownUntil);
  });
}

function renderStatsRows(selector, items) {
  $(selector).innerHTML = items.length ? items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${formatNumber(item.requests)}</td><td>${formatPercentage(item.successRate)}</td><td>${formatNumber(item.totalTokens)}</td><td>${formatPercentage(item.cacheReadRate)}</td><td>${renderLatency(item)}</td></tr>`).join('') : '<tr><td colspan="6" class="stats-empty">暂无数据</td></tr>';
}

function renderCredentialRows(history, health) {
  const historyByName = new Map((history || []).map((item) => [item.name, item]));
  const healthByName = new Map((health || []).map((item) => [item.name, item]));
  const names = [...new Set([...healthByName.keys(), ...historyByName.keys()])];
  const stateLabels = {
    healthy: ['正常', 'credential-healthy'], probing: ['恢复探测', 'credential-probing'], degraded: ['观察中', 'credential-degraded'],
    cooldown: ['冷却', 'credential-cooldown'], unknown: ['未探测', 'credential-unknown'],
    historical: ['历史', 'credential-unknown']
  };
  const failureLabels = { auth: '鉴权失败', rate_limit: '上游限流', transient: '上游 5xx', network: '网络故障' };
  $('#stats-credential-rows').innerHTML = names.length ? names.map((name) => {
    const usage = historyByName.get(name) || { requests: 0, successRate: null, totalTokens: 0, cacheReadRate: 0, averageDurationMs: 0 };
    const current = healthByName.get(name);
    const state = current?.state || 'historical';
    const [stateLabel, stateClass] = stateLabels[state] || stateLabels.unknown;
    const statusDetail = current?.lastFailureKind ? failureLabels[current.lastFailureKind] || '请求失败' : current?.lastStatus ? `HTTP ${current.lastStatus}` : '等待首次请求';
    const eventTime = current?.lastFailureAt || current?.lastSuccessAt;
    const eventLabel = current?.lastFailureAt ? statusDetail : current?.lastSuccessAt ? '最近成功' : current ? '尚无探测' : '已不在当前配置';
    const cooldown = current?.cooldownUntil
      ? `<small>至 ${escapeHtml(new Date(current.cooldownUntil).toLocaleString())} · <span class="cooldown-countdown" data-cooldown-until="${escapeHtml(current.cooldownUntil)}">${escapeHtml(formatCooldownRemaining(current.cooldownUntil))}</span></small>`
      : `<small>${escapeHtml(statusDetail)}</small>`;
    const recent = eventTime ? `${escapeHtml(eventLabel)}<small>${escapeHtml(new Date(eventTime).toLocaleString())}</small>` : escapeHtml(eventLabel);
    const reset = current && !['healthy', 'unknown'].includes(state)
      ? `<button class="mini-btn reset-credential-health" data-provider="${escapeHtml(current.provider)}" data-credential-id="${escapeHtml(current.credentialId)}" type="button">重置</button>`
      : '';
    return `<tr><td>${escapeHtml(name)}</td><td><div class="credential-health-state"><span class="credential-state ${stateClass}">${stateLabel}</span>${reset}</div>${cooldown}</td><td>${formatNumber(current?.consecutiveFailures || 0)}</td><td>${formatNumber(usage.requests)}</td><td>${formatPercentage(usage.successRate)}</td><td>${formatNumber(usage.totalTokens)}</td><td>${formatPercentage(usage.cacheReadRate)}</td><td>${renderLatency(usage)}</td><td class="credential-event">${recent}</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="stats-empty">暂无已配置或历史 Key</td></tr>';
}

function portionClass(value, maximum) {
  if (!maximum || !value) return 'portion-0';
  return `portion-${Math.min(20, Math.max(1, Math.round(value / maximum * 20)))}`;
}

function renderTimeline(timeline) {
  const buckets = timeline?.buckets || [];
  $('#stats-trend').classList.toggle('hourly', timeline?.bucket === 'hour');
  const maximumRequests = Math.max(0, ...buckets.map((item) => item.requests));
  const maximumTokens = Math.max(0, ...buckets.map((item) => item.totalTokens));
  const formatter = new Intl.DateTimeFormat('zh-CN', timeline?.bucket === 'hour' ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' });
  $('#stats-trend-range').textContent = timeline?.range === '24h' ? '最近 24 小时 · 每小时' : timeline?.range === '7d' ? '最近 7 天 · 每日' : '最近 14 天 · 每日';
  $('#stats-trend').innerHTML = buckets.map((item) => {
    const label = formatter.format(new Date(item.start));
    const phaseDetail = [
      item.upstreamWaitRequests ? `平均上游等待 ${formatDuration(item.averageUpstreamWaitMs)}` : '',
      item.upstreamBodyRequests ? `平均响应体阶段 ${formatDuration(item.averageUpstreamBodyMs)}` : ''
    ].filter(Boolean).join('，');
    const title = `${label}：${formatNumber(item.requests)} 个请求，${formatNumber(item.errors)} 个失败，${formatNumber(item.totalTokens)} Token${phaseDetail ? `，${phaseDetail}` : ''}`;
    return `<div class="trend-column" title="${escapeHtml(title)}"><div class="trend-bars"><span class="trend-bar token-bar ${portionClass(item.totalTokens, maximumTokens)}"></span><span class="trend-bar request-bar ${portionClass(item.requests, maximumRequests)}">${item.errors ? `<i class="error-mark" title="${formatNumber(item.errors)} 个失败"></i>` : ''}</span></div><time>${escapeHtml(label)}</time></div>`;
  }).join('');
  const totalRequests = buckets.reduce((sum, item) => sum + item.requests, 0);
  const totalTokens = buckets.reduce((sum, item) => sum + item.totalTokens, 0);
  $('#stats-trend').setAttribute('aria-label', `趋势范围内共 ${totalRequests} 个请求，${totalTokens} Token`);
}

function renderStats(stats) {
  const summary = stats.summary;
  $('#stats-requests').textContent = formatNumber(summary.requests);
  $('#stats-usage-coverage').textContent = summary.requests ? `${formatPercentage(summary.usageCoverageRate)} 含用量 · ${formatNumber(summary.missingUsageRequests)} 条缺失` : '暂无请求数据';
  $('#stats-success-rate').textContent = formatPercentage(summary.successRate);
  $('#stats-success-detail').textContent = `${formatNumber(summary.success)} 成功 · ${formatNumber(summary.errors)} 失败 · ${formatNumber(summary.failoverRequests)} 次自动切换`;
  $('#stats-avg-duration').textContent = formatDuration(summary.averageDurationMs);
  $('#stats-p95-duration').textContent = formatDuration(summary.p95DurationMs);
  $('#stats-avg-phases').textContent = summary.upstreamWaitRequests
    ? `等待 ${formatDuration(summary.averageUpstreamWaitMs)} · 响应体 ${summary.upstreamBodyRequests ? formatDuration(summary.averageUpstreamBodyMs) : '—'} · 覆盖 ${formatPercentage(summary.upstreamWaitCoverageRate)}/${formatPercentage(summary.upstreamBodyCoverageRate)}`
    : '暂无阶段耗时';
  $('#stats-p95-phases').textContent = summary.upstreamWaitRequests
    ? `等待 ${formatDuration(summary.p95UpstreamWaitMs)} · 响应体 ${summary.upstreamBodyRequests ? formatDuration(summary.p95UpstreamBodyMs) : '—'}`
    : '暂无阶段耗时';
  $('#stats-total-tokens').textContent = formatNumber(summary.totalTokens);
  $('#stats-input-tokens').textContent = formatNumber(summary.inputTokens);
  $('#stats-output-tokens').textContent = formatNumber(summary.outputTokens);
  $('#stats-reasoning-tokens').textContent = formatNumber(summary.reasoningTokens);
  $('#stats-average-tokens').textContent = formatNumber(summary.averageTokensPerUsageRequest);
  $('#stats-cached-tokens').textContent = formatNumber(summary.cachedInputTokens);
  $('#stats-cache-write-tokens').textContent = formatNumber(summary.cacheCreationInputTokens);
  $('#stats-uncached-input-tokens').textContent = formatNumber(summary.uncachedInputTokens);
  $('#stats-cache-rate').textContent = formatPercentage(summary.cacheReadRate);
  $('#stats-cache-hit-rate').textContent = summary.usageRequests ? formatPercentage(summary.cacheHitRequestRate) : '—';
  $('#stats-cache-hit-detail').textContent = `${formatNumber(summary.cacheHitRequests)} 个请求命中缓存 · ${formatNumber(summary.cacheWriteRequests)} 个请求写入缓存`;
  const totalInput = summary.inputTokens || 0;
  const readShare = totalInput ? Math.min(100, Math.max(0, summary.cachedInputTokens / totalInput * 100)) : 0;
  const writeShare = totalInput ? summary.cacheCreationInputTokens / totalInput * 100 : 0;
  const uncachedShare = totalInput ? 100 - readShare : 0;
  const meter = $('#stats-cache-meter');
  meter.querySelector('.cache-read').setAttribute('width', readShare.toFixed(4));
  meter.querySelector('.cache-uncached').setAttribute('x', readShare.toFixed(4));
  meter.querySelector('.cache-uncached').setAttribute('width', uncachedShare.toFixed(4));
  meter.setAttribute('aria-label', totalInput
    ? `缓存读取 ${readShare.toFixed(1)}%，未缓存 ${uncachedShare.toFixed(1)}%；缓存写入 ${writeShare.toFixed(1)}% 为独立指标`
    : '尚无输入 Token，暂无缓存用量');
  const range = stats.window === 'all' ? '全部保留记录' : stats.window === '24h' ? '最近 24 小时' : '最近 7 天';
  const trendRange = stats.timeline?.range === '24h' ? '最近 24 小时' : stats.timeline?.range === '7d' ? '最近 7 天' : '最近 14 天';
  $('#stats-scope').textContent = `指标与分组：${range} · 趋势：${trendRange} · 当前共保留 ${formatNumber(stats.retainedRequests)} 条元数据 · 生成于 ${new Date(stats.generatedAt).toLocaleString()}`;
  renderStatsRows('#stats-provider-rows', stats.byProvider);
  renderCredentialRows(stats.byCredential, stats.credentialHealth);
  renderStatsRows('#stats-model-rows', stats.byModel);
  renderStatsRows('#stats-protocol-rows', stats.byProtocol);
  renderStatsRows('#stats-client-rows', stats.byClient);
  renderTimeline(stats.timeline);
}

async function refreshStats(signal) {
  return api(`/api/stats?window=${encodeURIComponent($('#stats-window').value)}`, { signal });
}

function formatPercentage(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `${formatNumber(number)}%` : '—';
}

function renderProviderCredentials() {
  const groups = ['zen', 'go'].map((provider) => {
    const label = provider === 'go' ? 'OpenCode Go' : 'OpenCode Zen';
    const environment = config[`${provider}EnvironmentCredentials`] || [];
    const panel = config[`${provider}Credentials`] || [];
    const rows = [
      ...environment.map((item) => `<div class="provider-credential-row"><div><strong>${escapeHtml(item.name)}<span class="credential-source environment">环境</span></strong><small>${item.proxyConfigured ? '独立代理已配置' : '直连或使用环境默认代理'}</small></div><span class="client-actions"><button class="mini-btn test-provider-row" data-provider="${provider}" data-credential-id="environment:${escapeHtml(item.id)}">测试</button></span></div>`),
      ...panel.map((item) => `<div class="provider-credential-row"><div><strong>${escapeHtml(item.name)}<span class="credential-source">面板</span></strong><small>${escapeHtml(item.apiKey)} · ${item.proxyConfigured ? escapeHtml(item.proxyUrl) : '直连或使用默认代理'}${environment.length ? ' · 当前被环境变量池覆盖' : ''}</small></div><span class="client-actions"><button class="mini-btn test-provider-row" data-provider="${provider}" data-credential-id="config:${escapeHtml(item.id)}">测试</button><button class="mini-btn edit-provider-row" data-provider="${provider}" data-id="${escapeHtml(item.id)}">编辑</button><button class="mini-btn revoke delete-provider-row" data-provider="${provider}" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">删除</button></span></div>`)
    ].join('');
    const detail = environment.length ? `环境池 ${environment.length} 把优先生效 · 面板 ${panel.length} 把待命` : `面板 ${panel.length} 把生效`;
    return `<section class="provider-credential-group"><header><strong>${label}</strong><small>${detail}</small></header>${rows || '<div class="credential-pool-empty">尚未配置 Key</div>'}</section>`;
  });
  $('#provider-credential-list').innerHTML = groups.join('');
}

function imageHandoffKey(provider, model) {
  return `${provider}\n${String(model).toLowerCase()}`;
}

function imageHandoffCredentials(provider) {
  return [
    ...(config[`${provider}EnvironmentCredentials`] || []).map((entry) => ({ value: `environment:${entry.id}`, label: `${entry.name}（环境）` })),
    ...(config[`${provider}Credentials`] || []).map((entry) => ({ value: `config:${entry.id}`, label: `${entry.name}（面板）` }))
  ];
}

function renderImageHandoffCredentialOptions() {
  const provider = $('#imageHandoffProvider').value;
  const previous = $('#imageHandoffCredential').value;
  const credentials = imageHandoffCredentials(provider);
  $('#imageHandoffCredential').innerHTML = `<option value="">Key 池自动选择</option>${credentials.map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`).join('')}`;
  if (credentials.some((entry) => entry.value === previous)) $('#imageHandoffCredential').value = previous;
}

function visibleImageHandoffModels() {
  const provider = $('#imageHandoffProvider').value;
  const query = $('#imageHandoffSearch').value.trim().toLowerCase();
  return (discoveredImageModels.get(provider) || []).filter((model) => !query || model.toLowerCase().includes(query));
}

function renderSelectedImageHandoffModels() {
  $('#image-handoff-selected').innerHTML = imageHandoffModels.length
    ? imageHandoffModels.map((entry) => `<span class="image-handoff-chip"><b>${escapeHtml(entry.provider.toUpperCase())}</b>${escapeHtml(entry.model)}<button class="remove-image-handoff-model" data-provider="${escapeHtml(entry.provider)}" data-model="${escapeHtml(entry.model)}" type="button" aria-label="移除 ${escapeHtml(entry.model)}">×</button></span>`).join('')
    : '<p class="empty-inline">尚未选择任何模型</p>';
}

function renderImageHandoffModelList() {
  const provider = $('#imageHandoffProvider').value;
  const discovered = discoveredImageModels.has(provider);
  const models = visibleImageHandoffModels();
  const selected = new Set(imageHandoffModels.map((entry) => imageHandoffKey(entry.provider, entry.model)));
  $('#image-handoff-model-list').innerHTML = !discovered
    ? '<p class="empty-inline">请选择项目 Key 并拉取模型列表</p>'
    : models.length
      ? models.map((model) => `<label class="image-model-option"><input type="checkbox" data-provider="${escapeHtml(provider)}" data-model="${escapeHtml(model)}" ${selected.has(imageHandoffKey(provider, model)) ? 'checked' : ''}><span>${escapeHtml(model)}</span></label>`).join('')
      : '<p class="empty-inline">没有符合筛选条件的模型</p>';
}

function renderImageHandoffSettings() {
  const labels = { local: '本地路径交接', remote: '远程短时 URL', disabled: '交接传输已关闭' };
  const mode = config.imageHandoffTransport || 'disabled';
  $('#image-handoff-mode').textContent = labels[mode] || labels.disabled;
  $('#image-handoff-mode').classList.toggle('warning', mode === 'disabled');
  const provider = $('#imageHandoffProvider').value;
  const discovered = discoveredImageModels.get(provider);
  $('#image-handoff-status').textContent = discovered
    ? `已缓存 ${provider.toUpperCase()} 的 ${discovered.length} 个模型 · 已选择 ${imageHandoffModels.length} 个`
    : `已配置 ${imageHandoffModels.length} 个模型 · 尚未拉取 ${provider.toUpperCase()} 模型`;
  renderImageHandoffCredentialOptions();
  renderSelectedImageHandoffModels();
  renderImageHandoffModelList();
}

function setImageHandoffModel(provider, model, enabled) {
  const key = imageHandoffKey(provider, model);
  imageHandoffModels = imageHandoffModels.filter((entry) => imageHandoffKey(entry.provider, entry.model) !== key);
  if (enabled) imageHandoffModels.push({ provider, model });
  imageHandoffModels.sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  markConfigDirty('images');
  renderSelectedImageHandoffModels();
}

function resetProviderCredentialForm() {
  editingProviderCredential = null;
  $('#providerCredentialId').value = '';
  $('#providerCredentialProvider').disabled = false;
  $('#providerCredentialProvider').value = config.defaultProvider || 'zen';
  $('#providerCredentialName').value = '';
  $('#providerCredentialKey').value = '';
  $('#providerCredentialKey').required = true;
  $('#providerCredentialKey').placeholder = '填写 API Key';
  $('#providerCredentialProxy').value = '';
  $('#providerCredentialProxy').placeholder = '留空则直连或使用默认代理';
  $('#providerCredentialClearProxy').checked = false;
  $('#providerCredentialClearProxyField').classList.add('hidden');
  $('#provider-credential-form').classList.add('hidden');
}

function openProviderCredentialForm(provider, entry = null) {
  editingProviderCredential = entry ? { provider, id: entry.id } : null;
  $('#providerCredentialId').value = entry?.id || '';
  $('#providerCredentialProvider').value = provider || config.defaultProvider || 'zen';
  $('#providerCredentialProvider').disabled = Boolean(entry);
  $('#providerCredentialName').value = entry?.name || '';
  $('#providerCredentialKey').value = '';
  $('#providerCredentialKey').required = !entry;
  $('#providerCredentialKey').placeholder = entry ? `当前：${entry.apiKey}（留空保持）` : '填写 API Key';
  $('#providerCredentialProxy').value = '';
  $('#providerCredentialProxy').placeholder = entry?.proxyConfigured ? `当前：${entry.proxyUrl}` : '留空则直连或使用默认代理';
  $('#providerCredentialClearProxy').checked = false;
  $('#providerCredentialClearProxyField').classList.toggle('hidden', !entry?.proxyConfigured);
  $('#provider-credential-form').classList.remove('hidden');
  $('#providerCredentialName').focus();
  $('#provider-credential-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function providerCredentialTestPayload(provider, credentialId = '') {
  const apiKey = $('#providerCredentialKey').value.trim();
  const proxyUrl = $('#providerCredentialProxy').value.trim();
  const clearProxy = $('#providerCredentialClearProxy').checked;
  return {
    provider,
    ...(apiKey ? { apiKey } : credentialId ? { credentialId } : {}),
    ...(proxyUrl || clearProxy ? { proxyUrl: clearProxy ? '' : proxyUrl } : {})
  };
}

async function testProviderCredential(payload, button, { pendingText = '连接中…', successText = '连接成功' } = {}) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try {
    const result = await api('/api/models/test', { method: 'POST', body: JSON.stringify(payload) });
    const count = Array.isArray(result.data) ? result.data.length : 0;
    toast(`${successText}，获取到 ${count} 个模型`);
  } catch (error) { toast(`连接失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
}

function renderClients(clients) {
  $('#empty-clients').classList.toggle('hidden', clients.length > 0);
  $('#client-rows').innerHTML = clients.map((client) => `<tr><td>${escapeHtml(client.name)}</td><td><code>${escapeHtml(client.tokenPrefix)}…</code></td><td class="${client.enabled ? 'status-ok' : 'status-bad'}">${client.enabled ? '启用' : '停用'}</td><td>${formatNumber(client.maxConcurrentRequests)}</td><td>${escapeHtml(new Date(client.createdAt).toLocaleString())}</td><td><span class="client-actions"><button class="mini-btn toggle-client" data-id="${escapeHtml(client.id)}" data-enabled="${client.enabled}">${client.enabled ? '停用' : '启用'}</button><button class="mini-btn regenerate-client" data-id="${escapeHtml(client.id)}" data-name="${escapeHtml(client.name)}">轮换</button><button class="mini-btn revoke revoke-client" data-id="${escapeHtml(client.id)}" data-name="${escapeHtml(client.name)}">撤销</button></span></td></tr>`).join('');
  $$('.toggle-client').forEach((button) => button.addEventListener('click', async () => {
    await withPendingControl(button, '更新中…', async () => {
      try {
        acceptConfigRevision(await api(`/api/clients/${button.dataset.id}`, {
          method: 'PUT', headers: configPreconditionHeaders(), body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' })
        }));
        await refresh();
      } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
    });
  }));
  $$('.regenerate-client').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`轮换客户端“${button.dataset.name}”的令牌？旧令牌将立即失效。`)) return;
    await withPendingControl(button, '轮换中…', async () => {
      try {
        const result = await api(`/api/clients/${button.dataset.id}/regenerate`, { method: 'POST', headers: configPreconditionHeaders() });
        acceptConfigRevision(result);
        alert(`客户端“${result.name}”的新令牌（仅显示一次，请立即保存）：\n\n${result.token}`);
        await refresh();
      } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
    });
  }));
  $$('.revoke-client').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`确认撤销客户端“${button.dataset.name}”？该令牌会立即失效。`)) return;
    await withPendingControl(button, '撤销中…', async () => {
      try {
        acceptConfigRevision(await api(`/api/clients/${button.dataset.id}`, { method: 'DELETE', headers: configPreconditionHeaders() }));
        await refresh();
        toast('客户端令牌已撤销');
      } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
    });
  }));
}

function renderRouteList(routes) {
  $('#route-list').innerHTML = Object.entries(routes).map(([model, route]) => `<div class="route-item"><strong>${escapeHtml(model)}</strong><span>${escapeHtml(route.provider || '默认')}</span><span>${escapeHtml(route.protocol || 'auto')}</span><span>${escapeHtml(route.toolChoiceFallback ? `工具→${route.toolChoiceFallback}` : '标准工具')}</span><span>${escapeHtml(route.upstreamModel || model)}</span><button class="route-remove" data-model="${escapeHtml(model)}">删除</button></div>`).join('');
  $$('.route-remove').forEach((button) => button.addEventListener('click', () => {
    try {
      const routes = JSON.parse($('#modelRoutes').value);
      delete routes[button.dataset.model];
      $('#modelRoutes').value = JSON.stringify(routes, null, 2);
      markConfigDirty('routes');
      renderRouteList(routes);
    } catch (error) { toast(`路由 JSON 无效：${error.message}`); }
  }));
}

function renderExamples() {
  const root = location.origin;
  const command = (path, auth, body) => [
    `curl ${root}${path} \\`,
    `  -H "${auth}" \\`,
    '  -H "content-type: application/json" \\',
    `  -d '${JSON.stringify(body)}'`
  ].join('\n');
  $('#claude-example').textContent = command('/zen/v1/messages', 'x-api-key: YOUR_TOKEN', { model: 'claude-haiku-4-5', max_tokens: 1024, messages: [{ role: 'user', content: '你好' }] });
  $('#responses-example').textContent = command('/zen/v1/responses', 'Authorization: Bearer YOUR_TOKEN', { model: 'gpt-5.6-terra', input: '你好' });
  $('#chat-example').textContent = command('/go/v1/chat/completions', 'Authorization: Bearer YOUR_TOKEN', { model: 'kimi-k2.6', messages: [{ role: 'user', content: '你好' }] });
  $('#gemini-example').textContent = command('/v1beta/models/kimi-k2.6:generateContent', 'x-goog-api-key: YOUR_TOKEN', { contents: [{ role: 'user', parts: [{ text: '你好' }] }] });
  $('#opencode-example').textContent = JSON.stringify({
    provider: {
      bridgeZen: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${root}/zen/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' }, models: { 'gpt-5.6-terra': {} } },
      bridgeGo: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${root}/go/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' }, models: { 'kimi-k2.7-code': {} } }
    }
  }, null, 2);
}

const titles = { overview: '运行概览', settings: '连接设置', routes: '模型路由', prompts: '提示词规则', clients: '访问令牌', stats: '用量统计', logs: '请求记录', guide: '接入指南' };
$$('nav button').forEach((button) => button.addEventListener('click', async () => {
  $$('nav button,.view').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); $(`#${button.dataset.view}`).classList.add('active'); $('#page-title').textContent = titles[button.dataset.view];
  if (button.dataset.view === 'logs') {
    const result = await loadDataSource('请求日志', (signal) => api('/api/logs', { signal }), requestLogItems, (value) => { requestLogItems = value; });
    if (result.current) {
      renderLogs();
      renderRuntimeSummary();
    }
  }
  if (button.dataset.view === 'stats') await loadDataSource('用量统计', refreshStats, undefined, renderStats);
  if (button.dataset.view === 'prompts') await loadDataSource('Claude 提示词快照', refreshPrompt, undefined, renderRecentPrompt);
}));

$('#settings-form').addEventListener('input', () => markConfigDirty('settings'));
$('#proxyUrl').addEventListener('input', renderDefaultProxyStatus);
function renderKeepAliveStatus() {
  const status = config.keepAliveStatus || serviceStatus.keepAlive || {};
  const state = $('#keep-alive-state');
  const source = config.urlManagedByEnvironment || config.intervalManagedByEnvironment ? ' · 环境变量' : '';
  if (!config.keepAliveUrl) state.textContent = `当前禁用${source}`;
  else if (status.lastError) state.textContent = `最近失败：${status.lastError}`;
  else if (status.lastSuccessAt) state.textContent = `运行中 · ${new Date(status.lastSuccessAt).toLocaleTimeString()}${source}`;
  else state.textContent = `已启用 · 等待首次请求${source}`;
  state.classList.toggle('enabled', Boolean(config.keepAliveUrl) && !status.lastError);
  state.classList.toggle('unavailable', Boolean(status.lastError));
}

$('#set-current-keep-alive').addEventListener('click', () => {
  $('#keepAliveUrl').value = `${location.origin}/healthz`;
  markConfigDirty('settings');
  toast('已填入当前站点 /healthz，保存设置后生效');
});
$('#disable-keep-alive').addEventListener('click', () => {
  $('#keepAliveUrl').value = '';
  markConfigDirty('settings');
  toast('保存设置后将禁用保活');
});
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const keepAliveOverrides = {
      ...(!config.urlManagedByEnvironment ? { keepAliveUrl: $('#keepAliveUrl').value.trim() } : {}),
      ...(!config.intervalManagedByEnvironment ? { keepAliveIntervalSeconds: Number($('#keepAliveIntervalSeconds').value) } : {})
    };
    const payload = configPayload({
      defaultProvider: $('#defaultProvider').value,
      clientToken: $('#clientToken').value,
      requestLogLimit: Number($('#requestLogLimit').value), persistLogs: $('#persistLogs').checked, upstreamTimeoutMs: Number($('#upstreamTimeoutMs').value), maxConcurrentRequests: Number($('#maxConcurrentRequests').value), modelRoutes: config.modelRoutes,
      ...keepAliveOverrides
    });
    if ($('#proxyUrl').value.trim()) payload.proxyUrl = $('#proxyUrl').value.trim();
    await saveConfig(payload, 'settings');
  } catch (error) { toast(error.message); }
});

function configPayload(overrides = {}) {
  return {
    defaultProvider: config.defaultProvider,
    modelRoutes: config.modelRoutes || {},
    imageHandoffModels: config.imageHandoffModels || [],
    promptRewriteRules: config.promptRewriteRules || [],
    requestLogLimit: config.requestLogLimit,
    persistLogs: Boolean(config.persistLogs),
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests,
    ...(!config.urlManagedByEnvironment ? { keepAliveUrl: config.keepAliveUrl || '' } : {}),
    ...(!config.intervalManagedByEnvironment ? { keepAliveIntervalSeconds: config.keepAliveIntervalSeconds || 60 } : {}),
    ...overrides
  };
}

async function saveConfig(payload, section) {
  if (configSaveInProgress) throw new Error('另一项设置正在保存，请稍候');
  configSaveInProgress = true;
  refreshGate.invalidate();
  const controls = $$('#settings-form button[type="submit"],#save-routes,#save-image-handoff,#save-prompt-rules,.clear-proxy');
  controls.forEach((control) => { control.disabled = true; });
  try {
    config = await api('/api/config', {
      method: 'PUT',
      headers: configPreconditionHeaders(),
      body: JSON.stringify(payload)
    });
    clearConfigDirty(section);
    if (section === 'settings') $('#clientToken').value = '';
    toast('设置已保存');
    try { await refresh(); }
    catch (error) { toast(`设置已保存，但刷新失败：${error.message}`); }
  } catch (error) {
    throw await normalizedConfigMutationError(error);
  } finally {
    configSaveInProgress = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}

$('#save-routes').addEventListener('click', async () => {
  let routes;
  try {
    routes = JSON.parse($('#modelRoutes').value);
  } catch (error) { return toast(`路由 JSON 无效：${error.message}`); }
  try { await saveConfig(configPayload({ modelRoutes: routes }), 'routes'); }
  catch (error) { toast(error.message); }
});

$('#imageHandoffProvider').addEventListener('change', () => {
  imageModelDiscoveryGate.invalidate();
  $('#imageHandoffSearch').value = '';
  renderImageHandoffSettings();
});

$('#imageHandoffSearch').addEventListener('input', renderImageHandoffModelList);

$('#load-image-handoff-models').addEventListener('click', async (event) => {
  const provider = $('#imageHandoffProvider').value;
  const credentialId = $('#imageHandoffCredential').value;
  const generation = imageModelDiscoveryGate.begin();
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '拉取中…';
  $('#image-handoff-status').textContent = '正在使用项目 Key 拉取模型…';
  try {
    const result = credentialId
      ? await api('/api/models/test', { method: 'POST', body: JSON.stringify({ provider, credentialId }), signal: generation.controller.signal })
      : await api(`/api/models?provider=${encodeURIComponent(provider)}`, { signal: generation.controller.signal });
    const models = [...new Set((Array.isArray(result.data) ? result.data : []).map((item) => typeof item?.id === 'string' ? item.id.trim() : '').filter((model) => model && model.length <= 256 && !/[\u0000-\u001f\u007f]/.test(model)))]
      .sort((left, right) => left.localeCompare(right));
    discoveredImageModels.set(provider, models);
    if (!imageModelDiscoveryGate.isCurrent(generation)) return;
    $('#image-handoff-status').textContent = `已从 ${provider.toUpperCase()} 获取 ${models.length} 个模型 · 已选择 ${imageHandoffModels.length} 个`;
    renderImageHandoffModelList();
  } catch (error) {
    if (!imageModelDiscoveryGate.isCurrent(generation)) return;
    $('#image-handoff-status').textContent = `拉取失败：${error.message}`;
    toast(`模型拉取失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$('#image-handoff-model-list').addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  if (checkbox.checked && imageHandoffModels.length >= 500) {
    checkbox.checked = false;
    return toast('图片交接模型最多选择 500 个');
  }
  setImageHandoffModel(checkbox.dataset.provider, checkbox.dataset.model, checkbox.checked);
  $('#image-handoff-status').textContent = `已选择 ${imageHandoffModels.length} 个模型，尚未保存`;
});

$('#image-handoff-selected').addEventListener('click', (event) => {
  const button = event.target.closest('.remove-image-handoff-model');
  if (!button) return;
  setImageHandoffModel(button.dataset.provider, button.dataset.model, false);
  renderImageHandoffModelList();
  $('#image-handoff-status').textContent = `已选择 ${imageHandoffModels.length} 个模型，尚未保存`;
});

$('#select-visible-image-models').addEventListener('click', () => {
  const provider = $('#imageHandoffProvider').value;
  const byKey = new Map(imageHandoffModels.map((entry) => [imageHandoffKey(entry.provider, entry.model), entry]));
  for (const model of visibleImageHandoffModels()) {
    if (byKey.size >= 500) break;
    byKey.set(imageHandoffKey(provider, model), { provider, model });
  }
  imageHandoffModels = [...byKey.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model));
  markConfigDirty('images');
  renderSelectedImageHandoffModels();
  renderImageHandoffModelList();
  $('#image-handoff-status').textContent = `已选择 ${imageHandoffModels.length} 个模型，尚未保存`;
  if (byKey.size >= 500 && visibleImageHandoffModels().length > 500) toast('已达到 500 个模型上限');
});

$('#clear-provider-image-models').addEventListener('click', () => {
  const provider = $('#imageHandoffProvider').value;
  imageHandoffModels = imageHandoffModels.filter((entry) => entry.provider !== provider);
  markConfigDirty('images');
  renderSelectedImageHandoffModels();
  renderImageHandoffModelList();
  $('#image-handoff-status').textContent = `已清除 ${provider.toUpperCase()} 的选择，尚未保存`;
});

$('#save-image-handoff').addEventListener('click', async () => {
  try {
    await saveConfig(configPayload({ imageHandoffModels }), 'images');
    $('#image-handoff-status').textContent = `已保存 ${imageHandoffModels.length} 个模型`;
  }
  catch (error) { toast(error.message); }
});

$('#add-route').addEventListener('click', () => {
  try {
    const model = $('#routeModel').value.trim();
    if (!model) throw new Error('请填写客户端模型名');
    const routes = JSON.parse($('#modelRoutes').value);
    routes[model] = {
      provider: $('#routeProvider').value,
      protocol: $('#routeProtocol').value,
      ...($('#routeToolChoice').value ? { toolChoiceFallback: $('#routeToolChoice').value } : {}),
      ...($('#routeUpstream').value.trim() ? { upstreamModel: $('#routeUpstream').value.trim() } : {})
    };
    $('#modelRoutes').value = JSON.stringify(routes, null, 2);
    markConfigDirty('routes');
    renderRouteList(routes);
    $('#routeModel').value = $('#routeUpstream').value = '';
    $('#routeToolChoice').value = '';
    toast('已添加到编辑器，请点击保存路由');
  } catch (error) { toast(error.message); }
});

$('#modelRoutes').addEventListener('input', () => {
  markConfigDirty('routes');
  try { renderRouteList(JSON.parse($('#modelRoutes').value)); } catch { /* 保存时显示详细错误 */ }
});

$('#save-prompt-rules').addEventListener('click', async () => {
  let promptRewriteRules;
  try {
    promptRewriteRules = JSON.parse($('#promptRules').value);
  } catch (error) { return toast(`提示词规则无效：${error.message}`); }
  try { await saveConfig(configPayload({ promptRewriteRules }), 'prompts'); }
  catch (error) { toast(error.message); }
});

$('#restore-prompt-rules').addEventListener('click', () => {
  setPromptRules(config.promptRewriteDefaults || []);
  resetPromptRuleForm();
  toast('已载入默认规则，点击保存设置后生效');
});

$('#prompt-rule-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const find = $('#promptRuleFind').value;
    if (!find) throw new Error('查找内容不能为空');
    const rules = promptRulesFromEditor();
    const existing = editingPromptRuleIndex >= 0 ? rules[editingPromptRuleIndex] : null;
    const rule = {
      id: existing?.id || `rule-${crypto.randomUUID()}`,
      name: $('#promptRuleName').value.trim() || `规则 ${rules.length + 1}`,
      enabled: $('#promptRuleEnabled').checked,
      find,
      replace: $('#promptRuleReplace').value
    };
    if (editingPromptRuleIndex >= 0) rules[editingPromptRuleIndex] = rule;
    else rules.push(rule);
    setPromptRules(rules);
    resetPromptRuleForm();
    toast(`${existing ? '规则已更新' : '规则已添加'}，点击保存设置后生效`);
  } catch (error) { toast(error.message); }
});

$('#cancel-prompt-rule').addEventListener('click', resetPromptRuleForm);

$('#promptRules').addEventListener('input', () => {
  markConfigDirty('prompts');
  try { renderPromptRuleList(); } catch { /* 保存时显示详细错误 */ }
});

$('#preview-prompt').addEventListener('click', async () => {
  try {
    const rules = JSON.parse($('#promptRules').value);
    const result = await api('/api/prompt-rewrite/preview', { method: 'POST', body: JSON.stringify({ original: $('#promptOriginal').value, rules }) });
    $('#promptFinal').value = result.final;
    renderPromptRuleResults(result.ruleResults || []);
    const actions = result.applied.map((item) => `${item.action === 'delete' ? '删除' : '替换'}${item.name}×${item.count}`).join('，') || '没有规则命中';
    $('#prompt-meta').textContent = `设置预览 · 原始 ${result.originalBytes}B → 最终 ${result.finalBytes}B · ${actions}`;
  } catch (error) { toast(`预览失败：${error.message}`); }
});

$('#refresh-prompt').addEventListener('click', async () => {
  const result = await loadDataSource('Claude 提示词快照', refreshPrompt, undefined, renderRecentPrompt);
  if (result.current) toast(result.fresh ? '已刷新最近请求' : '最近请求暂未更新');
});

$('#clear-prompt').addEventListener('click', async () => {
  const gate = dataSourceGate('Claude 提示词快照');
  gate.invalidate();
  try {
    await api('/api/prompt-rewrite/recent', { method: 'DELETE' });
    gate.invalidate();
    renderRecentPrompt({});
    dataSourceFailures.delete('Claude 提示词快照');
    renderDataSourceFailures();
    toast('内存中的最近请求已清除');
  } catch (error) { toast(`清除失败：${error.message}`); }
});

$('#add-prompt-rule').addEventListener('click', () => {
  try {
    const source = $('#promptOriginal');
    const selected = source.value.slice(source.selectionStart, source.selectionEnd);
    if (!selected) throw new Error('请先在原始提示词中选中要处理的内容');
    resetPromptRuleForm();
    $('#promptRuleName').value = '自定义 Claude 提示词规则';
    $('#promptRuleFind').value = selected;
    $('#promptRuleFind').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#promptRuleReplace').focus();
    toast('已填入选中原文；替换内容留空即删除');
  } catch (error) { toast(error.message); }
});

async function copyPrompt(selector) {
  try { await navigator.clipboard.writeText($(selector).value); toast('已复制'); }
  catch (error) { toast(`复制失败：${error.message}`); }
}

$('#copy-prompt-original').addEventListener('click', () => copyPrompt('#promptOriginal'));
$('#copy-prompt-final').addEventListener('click', () => copyPrompt('#promptFinal'));

$('#client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  await withPendingControl(submit, '创建中…', async () => {
    try {
      const created = await api('/api/clients', {
        method: 'POST', headers: configPreconditionHeaders(),
        body: JSON.stringify({ name: $('#clientName').value, maxConcurrentRequests: Number($('#clientConcurrency').value) })
      });
      acceptConfigRevision(created);
      alert(`客户端“${created.name}”令牌（仅显示一次，请立即保存）：\n\n${created.token}`);
      $('#clientName').value = '';
      await refresh();
    } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
  });
});

$('#regen-token').addEventListener('click', async (event) => {
  if (!confirm('旧访问令牌将立即失效，确认继续？')) return;
  await withPendingControl(event.currentTarget, '轮换中…', async () => {
    try {
      const result = await api('/api/token/regenerate', { method: 'POST', headers: configPreconditionHeaders() });
      acceptConfigRevision(result);
      alert(`新访问令牌（请立即保存）：\n\n${result.token}`);
      await refresh();
    } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
  });
});

$('#add-provider-credential').addEventListener('click', () => openProviderCredentialForm(config.defaultProvider || 'zen'));
$('#cancel-provider-credential').addEventListener('click', resetProviderCredentialForm);

$('#provider-credential-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  await withPendingControl(submit, editingProviderCredential ? '保存中…' : '添加中…', async () => {
    try {
      const wasEditing = Boolean(editingProviderCredential);
      const provider = $('#providerCredentialProvider').value;
      const apiKey = $('#providerCredentialKey').value.trim();
      const proxyUrl = $('#providerCredentialProxy').value.trim();
      const clearProxy = $('#providerCredentialClearProxy').checked;
      const body = {
        provider,
        name: $('#providerCredentialName').value.trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(proxyUrl || clearProxy || !editingProviderCredential ? { proxyUrl: clearProxy ? '' : proxyUrl } : {})
      };
      const path = editingProviderCredential ? `/api/provider-credentials/${provider}/${encodeURIComponent(editingProviderCredential.id)}` : '/api/provider-credentials';
      config = await api(path, { method: editingProviderCredential ? 'PUT' : 'POST', headers: configPreconditionHeaders(), body: JSON.stringify(body) });
      resetProviderCredentialForm();
      toast(wasEditing ? 'Key 已更新' : 'Key 已添加');
      await refresh();
    } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
  });
});

$('#test-provider-credential').addEventListener('click', (event) => {
  const provider = $('#providerCredentialProvider').value;
  const credentialId = editingProviderCredential ? `config:${editingProviderCredential.id}` : '';
  const payload = providerCredentialTestPayload(provider, credentialId);
  if (!payload.apiKey && !payload.credentialId) return toast('请先填写 API Key');
  return testProviderCredential(payload, event.currentTarget);
});

$('#test-default-proxy').addEventListener('click', (event) => {
  const proxyUrl = $('#proxyUrl').value.trim();
  if (!proxyUrl && !config.proxyConfigured) return toast('请先填写代理地址');
  return testProviderCredential({
    provider: $('#defaultProvider').value,
    proxyScope: 'default',
    ...(proxyUrl ? { proxyUrl } : {})
  }, event.currentTarget, { pendingText: '检测中…', successText: '代理可用' });
});

$('#provider-credential-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const provider = button.dataset.provider;
  if (button.classList.contains('test-provider-row')) return testProviderCredential({ provider, credentialId: button.dataset.credentialId }, button);
  if (button.classList.contains('edit-provider-row')) {
    const entry = (config[`${provider}Credentials`] || []).find((item) => item.id === button.dataset.id);
    if (entry) openProviderCredentialForm(provider, entry);
    return;
  }
  if (button.classList.contains('delete-provider-row')) {
    if (!confirm(`确认删除 Key“${button.dataset.name}”？`)) return;
    await withPendingControl(button, '删除中…', async () => {
      try {
        config = await api(`/api/provider-credentials/${provider}/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE', headers: configPreconditionHeaders() });
        if (editingProviderCredential?.id === button.dataset.id && editingProviderCredential.provider === provider) resetProviderCredentialForm();
        toast('Key 已删除');
        await refresh();
      } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
    });
  }
});

$$('.clear-proxy').forEach((button) => button.addEventListener('click', async () => {
  if (!confirm('确认清除默认代理？')) return;
  try { await saveConfig(configPayload({ clearProxy: true })); }
  catch (error) { toast(error.message); }
}));

$$('.proxy-preset').forEach((button) => button.addEventListener('click', () => fillProxyPreset(button)));

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!confirmDiscardConfigDrafts('修改密码并重新登录')) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  await withPendingControl(submit, '修改中…', async () => {
    try {
      await api('/api/password', {
        method: 'PUT', headers: configPreconditionHeaders(),
        body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value })
      });
      alert('密码已修改，请重新登录。');
      discardConfigDrafts();
      location.reload();
    } catch (error) { toast((await normalizedConfigMutationError(error)).message); }
  });
});

$('#clear-logs').addEventListener('click', async () => {
  const gate = dataSourceGate('请求日志');
  gate.invalidate();
  await api('/api/logs', { method: 'DELETE' });
  gate.invalidate();
  requestLogItems = [];
  renderLogs();
  toast('记录已清空');
});
$('#log-search').addEventListener('input', renderLogs);
$('#log-provider-filter').addEventListener('change', renderLogs);
$('#log-status-filter').addEventListener('change', renderLogs);
$('#log-time-filter').addEventListener('change', renderLogs);
$('#export-logs').addEventListener('click', () => {
  const items = filteredLogs();
  if (!items.length) return toast('当前没有可导出的记录');
  const blob = new Blob([`\uFEFF${requestLogsToCsv(items)}`], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `opencode-bridge-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  toast(`已导出 ${items.length} 条记录`);
});
$('#log-rows').addEventListener('click', async (event) => {
  const button = event.target.closest('.log-id-copy');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copyValue);
    toast('请求 ID 已复制');
  } catch { toast('复制失败，请手动复制'); }
});
$('#refresh-stats').addEventListener('click', async () => {
  const result = await loadDataSource('用量统计', refreshStats, undefined, renderStats);
  if (result.current) toast(result.fresh ? '统计已刷新' : '统计暂未更新');
});
$('#stats-window').addEventListener('change', () => loadDataSource('用量统计', refreshStats, undefined, renderStats));
$('#stats-credential-rows').addEventListener('click', async (event) => {
  const button = event.target.closest('.reset-credential-health');
  if (!button) return;
  button.disabled = true;
  try {
    await api('/api/credential-health/reset', {
      method: 'POST',
      body: JSON.stringify({ provider: button.dataset.provider, credentialId: button.dataset.credentialId })
    });
    const result = await loadDataSource('用量统计', refreshStats, undefined, renderStats);
    if (result.current) toast(result.fresh ? 'Key 健康状态已重置' : 'Key 健康状态已重置，统计暂未更新');
  } catch (error) {
    toast(error.message);
  } finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  if (!confirmDiscardConfigDrafts('退出登录')) return;
  try {
    await api('/api/logout', { method: 'POST' });
    discardConfigDrafts();
    location.reload();
  } catch (error) { toast(error.message); }
});
$('#refresh').addEventListener('click', async () => {
  const dirty = [...dirtyConfigSections];
  if (dirty.length && !confirm(`${dirtyConfigMessage()}有未保存修改，刷新会丢弃这些内容。确认继续？`)) return;
  dirtyConfigSections.clear();
  renderConfigDraftStatus();
  try {
    const result = await refresh();
    if (!result.superseded) toast(result.degraded ? '已刷新可用数据' : '已刷新');
  } catch (error) {
    dirty.forEach((section) => dirtyConfigSections.add(section));
    renderConfigDraftStatus();
    toast(error.message);
  }
});
$$('.copy').forEach((button) => button.addEventListener('click', () => navigator.clipboard.writeText(`${location.origin}/${button.dataset.copy}/v1`).then(() => toast(`已复制 ${button.dataset.copy === 'go' ? 'Go' : 'Zen'} 地址`))));
$$('.copy-code').forEach((button) => button.addEventListener('click', () => {
  const target = $(button.dataset.target);
  if (target) navigator.clipboard.writeText(target.textContent).then(() => toast('已复制示例代码'));
}));

window.addEventListener('beforeunload', (event) => {
  if (!dirtyConfigSections.size) return;
  event.preventDefault();
  event.returnValue = '';
});

setInterval(updateCooldownCountdowns, 1000);
boot().catch((error) => { $('#auth').classList.remove('hidden'); $('#auth-error').textContent = `无法连接服务：${error.message}`; });
