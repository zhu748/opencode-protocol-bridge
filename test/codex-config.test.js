import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_BRIDGE_ENV_KEY,
  codexStreamIdleTimeout,
  createCodexConfig,
  createCodexPowerShellEnvironment,
  selectCodexProvider
} from '../public/codex-config.js';

test('Codex 配置默认使用 Zen 原生 Responses 模型且只从环境变量读取令牌', () => {
  const output = createCodexConfig('http://127.0.0.1:8787/');
  assert.match(output, /^model = "gpt-5\.6-terra"$/m);
  assert.match(output, /^model_provider = "opencode_bridge"$/m);
  assert.match(output, /^\[model_providers\.opencode_bridge\]$/m);
  assert.match(output, /^base_url = "http:\/\/127\.0\.0\.1:8787\/zen\/v1"$/m);
  assert.match(output, new RegExp(`^env_key = "${CODEX_BRIDGE_ENV_KEY}"$`, 'm'));
  assert.match(output, /^wire_api = "responses"$/m);
  assert.match(output, /^requires_openai_auth = false$/m);
  assert.match(output, /^request_max_retries = 4$/m);
  assert.match(output, /^stream_max_retries = 5$/m);
  assert.match(output, /^stream_idle_timeout_ms = 330000$/m);
  assert.match(output, /^supports_websockets = false$/m);
  assert.match(output, /^supports_standalone_web_search = false$/m);
  assert.doesNotMatch(output, /YOUR_BRIDGE_TOKEN|experimental_bearer_token|model_reasoning_effort/);
});

test('Codex 配置可选择 Go 并规范化 Bridge 地址', () => {
  const output = createCodexConfig('https://bridge.example/base/?ignored=yes#fragment', {
    provider: 'go', upstreamStreamIdleTimeoutMs: 600_000
  });
  assert.match(output, /^model = "gpt-5\.6-luna"$/m);
  assert.match(output, /^name = "OpenCode Bridge \(Go\)"$/m);
  assert.match(output, /^base_url = "https:\/\/bridge\.example\/base\/go\/v1"$/m);
  assert.match(output, /^stream_idle_timeout_ms = 630000$/m);
  assert.throws(() => createCodexConfig('ftp://bridge.example', { provider: 'zen' }), /HTTP 或 HTTPS/);
  assert.throws(() => createCodexConfig('https://user:pass@bridge.example', { provider: 'zen' }), /用户名或密码/);
  assert.throws(() => createCodexConfig('https://bridge.example', { provider: 'other' }), /zen 或 go/);
});

test('Codex 探针可复用生成器并安全转义 TOML 字符串', () => {
  const output = createCodexConfig('http://127.0.0.1:8787/', {
    provider: 'zen', model: 'probe"model\\name', providerId: 'bridge_probe',
    providerName: 'Bridge "Probe"', endpointPath: '/v1', envKey: 'BRIDGE_PROBE_API_KEY'
  });
  assert.match(output, /^model = "probe\\"model\\\\name"$/m);
  assert.match(output, /^model_provider = "bridge_probe"$/m);
  assert.match(output, /^\[model_providers\.bridge_probe\]$/m);
  assert.match(output, /^name = "Bridge \\"Probe\\""$/m);
  assert.match(output, /^base_url = "http:\/\/127\.0\.0\.1:8787\/v1"$/m);
  assert.match(output, /^env_key = "BRIDGE_PROBE_API_KEY"$/m);
  assert.throws(() => createCodexConfig('https://bridge.example', { providerId: 'bad.id' }), /provider ID/);
  assert.throws(() => createCodexConfig('https://bridge.example', { envKey: 'bad-key' }), /env_key/);
  assert.throws(() => createCodexConfig('https://bridge.example', { endpointPath: '/../secret' }), /安全的绝对/);
});

test('Codex 流空闲超时始终比 Bridge 上游超时多出安全窗口', () => {
  assert.equal(codexStreamIdleTimeout(0), 300_000);
  assert.equal(codexStreamIdleTimeout(269_999), 300_000);
  assert.equal(codexStreamIdleTimeout(300_000), 330_000);
  assert.equal(codexStreamIdleTimeout(3_600_000), 3_630_000);
  assert.throws(() => codexStreamIdleTimeout(-1), /非负数/);
  assert.throws(() => codexStreamIdleTimeout('invalid'), /非负数/);
});

test('Codex 管理页按已配置上游选择默认项并只生成令牌占位命令', () => {
  assert.equal(selectCodexProvider(['go'], 'zen'), 'go');
  assert.equal(selectCodexProvider(['zen', 'go'], 'go'), 'go');
  assert.equal(selectCodexProvider([], 'go'), 'go');
  assert.equal(selectCodexProvider([], 'invalid'), 'zen');
  assert.equal(createCodexPowerShellEnvironment(), '$env:OPENCODE_BRIDGE_TOKEN = "YOUR_BRIDGE_TOKEN"');
});
