const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let config = {};
let setupMode = false;
let recentPrompt = {};
let editingPromptRuleIndex = -1;
let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['/api/login', '/api/session'].includes(path)) location.reload();
    throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
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
  const [nextConfig, requestLogs, status, clients] = await Promise.all([
    api('/api/config'), api('/api/logs'), api('/api/status'), api('/api/clients')
  ]);
  config = nextConfig;
  $('#base-url').textContent = location.origin;
  $('#endpoint-code').textContent = `${location.origin}/zen/v1`;
  $('#go-endpoint-code').textContent = `${location.origin}/go/v1`;
  $('#zen-state').textContent = config.zenKey || '未配置';
  $('#go-state').textContent = config.goKey || '未配置';
  $('#zen-proxy-state').textContent = config.zenProxyConfigured ? '使用 Zen 独立代理' : config.proxyConfigured ? '使用默认代理' : '直连上游';
  $('#go-proxy-state').textContent = config.goProxyConfigured ? '使用 Go 独立代理' : config.proxyConfigured ? '使用默认代理' : '直连上游';
  $('#request-count').textContent = requestLogs.length;
  $('#request-summary').textContent = `${status.successRate}% 成功 · 活跃 ${status.activeRequests} · 平均 ${status.averageDuration} ms · ${status.memoryMb} MiB${status.logPersistenceError ? ' · 日志异常' : ''}`;
  $('#request-summary').title = status.logPersistenceError || '';
  $('#service-state').textContent = status.ready ? '● READY' : '● 待配置';
  $('#service-state').classList.toggle('warning', !status.ready);
  $('#defaultProvider').value = config.defaultProvider;
  for (const [field, configured, fallback] of [
    ['proxyUrl', config.proxyConfigured, 'http://127.0.0.1:7890'],
    ['zenProxyUrl', config.zenProxyConfigured, 'socks5h://user:pass@127.0.0.1:1080'],
    ['goProxyUrl', config.goProxyConfigured, 'http://user:pass@127.0.0.1:7890']
  ]) {
    $(`#${field}`).value = '';
    $(`#${field}`).placeholder = configured ? `当前：${config[field]}` : fallback;
  }
  $('#requestLogLimit').value = config.requestLogLimit;
  $('#persistLogs').checked = Boolean(config.persistLogs);
  $('#upstreamTimeoutMs').value = config.upstreamTimeoutMs;
  $('#maxConcurrentRequests').value = config.maxConcurrentRequests;
  $('#zenKey').placeholder = config.zenKey ? `当前：${config.zenKey}` : '填写 Zen API Key';
  $('#goKey').placeholder = config.goKey ? `当前：${config.goKey}` : '填写 Go API Key';
  $('#clientToken').placeholder = config.clientToken ? `当前：${config.clientToken}` : '填写客户端访问令牌';
  $('#encryption-state').textContent = config.encryptionEnabled ? '配置已加密' : '配置未加密';
  $('#encryption-state').classList.toggle('enabled', config.encryptionEnabled);
  $('#modelRoutes').value = JSON.stringify(config.modelRoutes || {}, null, 2);
  $('#promptRules').value = JSON.stringify(config.promptRewriteRules || [], null, 2);
  renderPromptRuleList();
  renderRouteList(config.modelRoutes || {});
  renderClients(clients);
  renderLogs(requestLogs);
  renderExamples();
  await refreshPrompt();
}

async function refreshPrompt() {
  recentPrompt = await api('/api/prompt-rewrite/recent');
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
    return `<article class="prompt-rule-item"><div class="prompt-rule-main"><span class="rule-state ${state.className}">${state.label}</span><div><strong>${escapeHtml(rule.name || `规则 ${index + 1}`)}</strong><p>${action} · ${escapeHtml(preview || '未填写查找内容')}${String(rule.find ?? '').length > 120 ? '…' : ''}</p></div></div><span class="client-actions"><button class="mini-btn toggle-prompt-rule" data-index="${index}" type="button">${rule.enabled === false ? '启用' : '停用'}</button><button class="mini-btn edit-prompt-rule" data-index="${index}" type="button">编辑</button><button class="mini-btn revoke delete-prompt-rule" data-index="${index}" type="button">删除</button></span></article>`;
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
  $('#prompt-rule-results').innerHTML = results.length ? results.map((item) => `<div class="prompt-result"><span class="rule-state ${classes[item.status] || 'pending'}">${labels[item.status] || '未知'}</span><strong>${escapeHtml(item.name)}</strong><span>${item.action === 'delete' ? '删除' : '替换'}${item.count ? ` ×${item.count}` : ''}</span></div>`).join('') : '<p class="empty-inline">收到 Claude 请求后显示</p>';
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

function renderLogs(items) {
  $('#empty-logs').classList.toggle('hidden', items.length > 0);
  $('#log-rows').innerHTML = items.map((item) => {
    const tokens = item.inputTokens === undefined ? '—' : `${item.inputTokens} / ${item.outputTokens}${item.cachedInputTokens ? ` · 缓存读取 ${item.cachedInputTokens}` : ''}${item.cacheCreationInputTokens ? ` · 缓存写入 ${item.cacheCreationInputTokens}` : ''}${item.reasoningTokens ? ` · 推理 ${item.reasoningTokens}` : ''}`;
    const statusClass = item.status >= 200 && item.status < 400 ? 'status-ok' : 'status-bad';
    const error = item.error ? `<small class="log-error" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</small>` : '';
    return `<tr><td>${new Date(item.time).toLocaleString()}</td><td><code>${escapeHtml(item.requestId || '—')}</code></td><td>${escapeHtml(item.clientName || '主令牌')}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.provider)}</td><td>${escapeHtml(item.protocol)}</td><td class="${statusClass}">${item.status}${error}</td><td>${escapeHtml(tokens)}</td><td>${item.duration} ms</td></tr>`;
  }).join('');
}

function escapeHtml(value = '') { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }

function renderClients(clients) {
  $('#empty-clients').classList.toggle('hidden', clients.length > 0);
  $('#client-rows').innerHTML = clients.map((client) => `<tr><td>${escapeHtml(client.name)}</td><td><code>${escapeHtml(client.tokenPrefix)}…</code></td><td class="${client.enabled ? 'status-ok' : 'status-bad'}">${client.enabled ? '启用' : '停用'}</td><td>${client.maxConcurrentRequests}</td><td>${new Date(client.createdAt).toLocaleString()}</td><td><span class="client-actions"><button class="mini-btn toggle-client" data-id="${client.id}" data-enabled="${client.enabled}">${client.enabled ? '停用' : '启用'}</button><button class="mini-btn regenerate-client" data-id="${client.id}" data-name="${escapeHtml(client.name)}">轮换</button><button class="mini-btn revoke revoke-client" data-id="${client.id}" data-name="${escapeHtml(client.name)}">撤销</button></span></td></tr>`).join('');
  $$('.toggle-client').forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/clients/${button.dataset.id}`, { method: 'PUT', body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }) }); await refresh(); }
    catch (error) { toast(error.message); }
  }));
  $$('.regenerate-client').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`轮换客户端“${button.dataset.name}”的令牌？旧令牌将立即失效。`)) return;
    try {
      const result = await api(`/api/clients/${button.dataset.id}/regenerate`, { method: 'POST' });
      alert(`客户端“${result.name}”的新令牌（仅显示一次，请立即保存）：\n\n${result.token}`);
      await refresh();
    } catch (error) { toast(error.message); }
  }));
  $$('.revoke-client').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`确认撤销客户端“${button.dataset.name}”？该令牌会立即失效。`)) return;
    try { await api(`/api/clients/${button.dataset.id}`, { method: 'DELETE' }); await refresh(); toast('客户端令牌已撤销'); }
    catch (error) { toast(error.message); }
  }));
}

function renderRouteList(routes) {
  $('#route-list').innerHTML = Object.entries(routes).map(([model, route]) => `<div class="route-item"><strong>${escapeHtml(model)}</strong><span>${escapeHtml(route.provider || '默认')}</span><span>${escapeHtml(route.protocol || 'auto')}</span><span>${escapeHtml(route.toolChoiceFallback ? `工具→${route.toolChoiceFallback}` : '标准工具')}</span><span>${escapeHtml(route.upstreamModel || model)}</span><button class="route-remove" data-model="${escapeHtml(model)}">删除</button></div>`).join('');
  $$('.route-remove').forEach((button) => button.addEventListener('click', () => {
    try {
      const routes = JSON.parse($('#modelRoutes').value);
      delete routes[button.dataset.model];
      $('#modelRoutes').value = JSON.stringify(routes, null, 2);
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
  $('#opencode-example').textContent = JSON.stringify({
    provider: {
      bridgeZen: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${root}/zen/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' }, models: { 'gpt-5.6-terra': {} } },
      bridgeGo: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${root}/go/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' }, models: { 'kimi-k2.7-code': {} } }
    }
  }, null, 2);
}

const titles = { overview: '运行概览', settings: '连接设置', routes: '模型路由', prompts: '提示词规则', clients: '访问令牌', logs: '请求记录', guide: '接入指南' };
$$('nav button').forEach((button) => button.addEventListener('click', async () => {
  $$('nav button,.view').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); $(`#${button.dataset.view}`).classList.add('active'); $('#page-title').textContent = titles[button.dataset.view];
  if (button.dataset.view === 'logs') renderLogs(await api('/api/logs'));
  if (button.dataset.view === 'prompts') await refreshPrompt();
}));

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = configPayload({
      defaultProvider: $('#defaultProvider').value,
      zenKey: $('#zenKey').value, goKey: $('#goKey').value, clientToken: $('#clientToken').value,
      requestLogLimit: Number($('#requestLogLimit').value), persistLogs: $('#persistLogs').checked, upstreamTimeoutMs: Number($('#upstreamTimeoutMs').value), maxConcurrentRequests: Number($('#maxConcurrentRequests').value), modelRoutes: config.modelRoutes
    });
    for (const field of ['proxyUrl', 'zenProxyUrl', 'goProxyUrl']) if ($(`#${field}`).value.trim()) payload[field] = $(`#${field}`).value.trim();
    await saveConfig(payload);
  } catch (error) { toast(error.message); }
});

function configPayload(overrides = {}) {
  return {
    defaultProvider: config.defaultProvider,
    modelRoutes: config.modelRoutes || {},
    promptRewriteRules: config.promptRewriteRules || [],
    requestLogLimit: config.requestLogLimit,
    persistLogs: Boolean(config.persistLogs),
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests,
    ...overrides
  };
}

async function saveConfig(payload) {
  config = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
  $('#zenKey').value = $('#goKey').value = $('#clientToken').value = '';
  toast('设置已保存'); await refresh();
}

$('#save-routes').addEventListener('click', async () => {
  try {
    const routes = JSON.parse($('#modelRoutes').value);
    await saveConfig(configPayload({ modelRoutes: routes }));
  } catch (error) { toast(`路由 JSON 无效：${error.message}`); }
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
    renderRouteList(routes);
    $('#routeModel').value = $('#routeUpstream').value = '';
    $('#routeToolChoice').value = '';
    toast('已添加到编辑器，请点击保存路由');
  } catch (error) { toast(error.message); }
});

$('#modelRoutes').addEventListener('input', () => {
  try { renderRouteList(JSON.parse($('#modelRoutes').value)); } catch { /* 保存时显示详细错误 */ }
});

$('#save-prompt-rules').addEventListener('click', async () => {
  try {
    const promptRewriteRules = JSON.parse($('#promptRules').value);
    await saveConfig(configPayload({ promptRewriteRules }));
  } catch (error) { toast(`提示词规则无效：${error.message}`); }
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

$('#refresh-prompt').addEventListener('click', () => refreshPrompt().then(() => toast('已刷新最近请求')).catch((error) => toast(error.message)));

$('#clear-prompt').addEventListener('click', async () => {
  await api('/api/prompt-rewrite/recent', { method: 'DELETE' });
  await refreshPrompt();
  toast('内存中的最近请求已清除');
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
  try {
    const created = await api('/api/clients', { method: 'POST', body: JSON.stringify({ name: $('#clientName').value, maxConcurrentRequests: Number($('#clientConcurrency').value) }) });
    alert(`客户端“${created.name}”令牌（仅显示一次，请立即保存）：\n\n${created.token}`);
    $('#clientName').value = '';
    await refresh();
  } catch (error) { toast(error.message); }
});

$('#regen-token').addEventListener('click', async () => {
  if (!confirm('旧访问令牌将立即失效，确认继续？')) return;
  try { const result = await api('/api/token/regenerate', { method: 'POST' }); alert(`新访问令牌（请立即保存）：\n\n${result.token}`); await refresh(); } catch (error) { toast(error.message); }
});

$$('.test-key').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '连接中…';
  try {
    const provider = button.dataset.provider;
    const request = { provider, apiKey: $(`#${provider}Key`).value };
    const ownProxy = $(`#${provider}ProxyUrl`).value.trim();
    const defaultProxy = $('#proxyUrl').value.trim();
    if (ownProxy) request.proxyUrl = ownProxy;
    else if (!config[`${provider}ProxyConfigured`] && defaultProxy) request.proxyUrl = defaultProxy;
    const result = await api('/api/models/test', { method: 'POST', body: JSON.stringify(request) });
    const count = Array.isArray(result.data) ? result.data.length : 0;
    toast(`连接成功，获取到 ${count} 个模型`);
  } catch (error) { toast(`连接失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = original; }
}));

$$('.clear-key').forEach((button) => button.addEventListener('click', async () => {
  const provider = button.dataset.provider;
  if (!confirm(`确认清除 OpenCode ${provider === 'go' ? 'Go' : 'Zen'} 密钥？`)) return;
  try {
    await saveConfig(configPayload({ [provider === 'go' ? 'clearGoKey' : 'clearZenKey']: true }));
  } catch (error) { toast(error.message); }
}));

$$('.clear-proxy').forEach((button) => button.addEventListener('click', async () => {
  const provider = button.dataset.provider;
  const label = provider === 'default' ? '默认' : provider === 'go' ? 'Go' : 'Zen';
  if (!confirm(`确认清除${label}代理？`)) return;
  const flag = provider === 'default' ? 'clearProxy' : provider === 'go' ? 'clearGoProxy' : 'clearZenProxy';
  try { await saveConfig(configPayload({ [flag]: true })); }
  catch (error) { toast(error.message); }
}));

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await api('/api/password', { method: 'PUT', body: JSON.stringify({ currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value }) }); alert('密码已修改，请重新登录。'); location.reload(); } catch (error) { toast(error.message); }
});

$('#clear-logs').addEventListener('click', async () => { await api('/api/logs', { method: 'DELETE' }); renderLogs([]); toast('记录已清空'); });
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });
$('#refresh').addEventListener('click', () => refresh().then(() => toast('已刷新')).catch((error) => toast(error.message)));
$$('.copy').forEach((button) => button.addEventListener('click', () => navigator.clipboard.writeText(`${location.origin}/${button.dataset.copy}/v1`).then(() => toast(`已复制 ${button.dataset.copy === 'go' ? 'Go' : 'Zen'} 地址`))));

boot().catch((error) => { $('#auth').classList.remove('hidden'); $('#auth-error').textContent = `无法连接服务：${error.message}`; });
