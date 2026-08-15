export const CODEX_BRIDGE_ENV_KEY = 'OPENCODE_BRIDGE_TOKEN';

const CODEX_PROVIDER_DEFAULTS = Object.freeze({
  zen: Object.freeze({ model: 'gpt-5.6-terra', path: '/zen/v1', name: 'OpenCode Bridge (Zen)' }),
  go: Object.freeze({ model: 'gpt-5.6-luna', path: '/go/v1', name: 'OpenCode Bridge (Go)' })
});

function tomlString(value) {
  return JSON.stringify(String(value));
}

function normalizedRoot(root) {
  const url = new URL(root);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Codex Bridge 地址必须使用 HTTP 或 HTTPS');
  if (url.username || url.password) throw new TypeError('Codex Bridge 地址不能包含用户名或密码');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

export function codexStreamIdleTimeout(upstreamStreamIdleTimeoutMs = 300_000) {
  const upstreamIdle = Number(upstreamStreamIdleTimeoutMs);
  if (!Number.isFinite(upstreamIdle) || upstreamIdle < 0) throw new TypeError('Bridge 上游流空闲超时必须是非负数');
  return Math.max(300_000, Math.trunc(upstreamIdle) + 30_000);
}

export function selectCodexProvider(availableProviders = [], defaultProvider = 'zen') {
  const available = [...new Set(availableProviders)].filter((provider) => provider in CODEX_PROVIDER_DEFAULTS);
  if (available.includes(defaultProvider)) return defaultProvider;
  return available[0] || (defaultProvider === 'go' ? 'go' : 'zen');
}

export function createCodexConfig(root, {
  provider = 'zen',
  upstreamStreamIdleTimeoutMs = 300_000,
  model,
  providerId = 'opencode_bridge',
  providerName,
  endpointPath,
  envKey = CODEX_BRIDGE_ENV_KEY
} = {}) {
  const defaults = CODEX_PROVIDER_DEFAULTS[provider];
  if (!defaults) throw new TypeError('Codex Bridge 上游必须是 zen 或 go');
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) throw new TypeError('Codex provider ID 只能包含英文字母、数字、下划线或连字符');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) throw new TypeError('Codex env_key 必须是有效的环境变量名');
  const selectedModel = model === undefined ? defaults.model : String(model);
  const selectedName = providerName === undefined ? defaults.name : String(providerName);
  if (!selectedModel.trim() || !selectedName.trim()) throw new TypeError('Codex 模型名与提供方名称不能为空');
  const path = endpointPath === undefined ? defaults.path : String(endpointPath);
  if (path && (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path) || path.includes('..'))) {
    throw new TypeError('Codex 上游路径必须是安全的绝对 URL 路径');
  }
  const baseUrl = `${normalizedRoot(root)}${path}`;
  const streamIdleTimeoutMs = codexStreamIdleTimeout(upstreamStreamIdleTimeoutMs);
  return [
    `model = ${tomlString(selectedModel)}`,
    `model_provider = ${tomlString(providerId)}`,
    '',
    `[model_providers.${providerId}]`,
    `name = ${tomlString(selectedName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `env_key_instructions = ${tomlString(`请先设置 ${envKey} 为管理面板生成的客户端访问令牌`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 4',
    'stream_max_retries = 5',
    `stream_idle_timeout_ms = ${streamIdleTimeoutMs}`,
    'supports_websockets = false',
    'supports_standalone_web_search = false'
  ].join('\n');
}

export function createCodexPowerShellEnvironment() {
  return `$env:${CODEX_BRIDGE_ENV_KEY} = "YOUR_BRIDGE_TOKEN"`;
}
