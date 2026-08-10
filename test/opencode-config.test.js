import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenCodeConfig, SDK_BY_PROTOCOL } from '../public/opencode-config.js';
import { OPENCODE_GO_MODEL_CAPABILITIES, OPENCODE_ZEN_MODEL_CAPABILITIES } from '../src/model-capabilities.js';

test('OpenCode 配置按 Go 模型原生协议选择 AI SDK 并覆盖完整目录', () => {
  const config = createOpenCodeConfig('https://bridge.example/', OPENCODE_GO_MODEL_CAPABILITIES, []);
  const provider = config.provider['bridge-go'];
  assert.equal(config.model, 'bridge-go/gpt-5.6-luna');
  assert.equal(provider.options.baseURL, 'https://bridge.example/go/v1');
  assert.equal(provider.options.apiKey, '{env:OPENCODE_BRIDGE_TOKEN}');
  assert.deepEqual(Object.keys(provider.models).sort(), Object.keys(OPENCODE_GO_MODEL_CAPABILITIES).sort());
  assert.equal(provider.models['gpt-5.6-luna'].provider.npm, '@ai-sdk/openai');
  assert.equal(provider.models['minimax-m3'].provider.npm, '@ai-sdk/anthropic');
  assert.equal(provider.models['kimi-k3'].provider.npm, '@ai-sdk/openai-compatible');
  assert.deepEqual(new Set(Object.values(provider.models).map((model) => model.provider.npm)), new Set([
    SDK_BY_PROTOCOL.responses, SDK_BY_PROTOCOL.claude, SDK_BY_PROTOCOL.chat
  ]));
});

test('OpenCode 配置保留能力、上下文上限和图片交接语义', () => {
  const config = createOpenCodeConfig('http://127.0.0.1:8787', OPENCODE_GO_MODEL_CAPABILITIES, [
    { provider: 'go', model: 'deepseek-v4-flash' },
    { provider: 'zen', model: 'deepseek-v4-flash' }
  ], { imageHandoffTransport: 'local' });
  const models = config.provider['bridge-go'].models;
  assert.deepEqual(models['gpt-5.6-luna'].limit, { context: 1_050_000, input: 922_000, output: 128_000 });
  assert.equal(models['gpt-5.6-luna'].attachment, true);
  assert.deepEqual(models['gpt-5.6-luna'].modalities.input, ['text', 'image', 'pdf']);
  assert.deepEqual(models['mimo-v2.5'].modalities.input, ['text', 'image', 'audio', 'video']);
  assert.equal(models['deepseek-v4-flash'].attachment, true);
  assert.deepEqual(models['deepseek-v4-flash'].modalities.input, ['text', 'image']);
  assert.equal(models['glm-5'].attachment, false);
  assert.deepEqual(models['glm-5'].modalities.input, ['text']);
  assert.equal(models['kimi-k3'].reasoning, true);
  assert.equal(models['kimi-k3'].tool_call, true);
  assert.equal(models['kimi-k3'].temperature, false);
});

test('图片交接传输关闭时不会向 OpenCode 虚报文本模型附件能力', () => {
  const config = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [
    { provider: 'go', model: 'deepseek-v4-flash' }
  ], { imageHandoffTransport: 'disabled' });
  const models = config.provider['bridge-go'].models;
  assert.equal(models['deepseek-v4-flash'].attachment, false);
  assert.deepEqual(models['deepseek-v4-flash'].modalities.input, ['text']);
  assert.equal(models['gpt-5.6-luna'].attachment, true);
  assert.deepEqual(models['gpt-5.6-luna'].modalities.input, ['text', 'image', 'pdf']);
});

test('Zen 示例按完整目录为每个模型选择原生 SDK', () => {
  const config = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [], {
    defaultProvider: 'zen',
    zenCapabilities: OPENCODE_ZEN_MODEL_CAPABILITIES
  });
  const provider = config.provider['bridge-zen'];
  assert.equal(config.model, 'bridge-zen/gpt-5.6-terra');
  assert.equal(provider.npm, '@ai-sdk/openai');
  assert.equal(provider.options.baseURL, 'https://bridge.example/zen/v1');
  assert.deepEqual(Object.keys(provider.models).sort(), Object.keys(OPENCODE_ZEN_MODEL_CAPABILITIES).sort());
  assert.deepEqual(provider.models['gpt-5.6-terra'].limit, { context: 1_050_000, input: 922_000, output: 128_000 });
  assert.equal(provider.models['gpt-5.6-terra'].provider.npm, '@ai-sdk/openai');
  assert.equal(provider.models['claude-opus-4-8'].provider.npm, '@ai-sdk/anthropic');
  assert.equal(provider.models['deepseek-v4-flash'].provider.npm, '@ai-sdk/openai-compatible');
  assert.equal(provider.models['gemini-3.6-flash'].provider.npm, '@ai-sdk/google');
  assert.deepEqual(provider.models['gemini-3.6-flash'].modalities.input, ['text', 'image', 'video', 'audio', 'pdf']);
});

test('Zen 文本模型只在图片交接可用且已选中时声明附件能力', () => {
  const enabled = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [
    { provider: 'zen', model: 'deepseek-v4-flash' }
  ], { imageHandoffTransport: 'remote', zenCapabilities: OPENCODE_ZEN_MODEL_CAPABILITIES });
  assert.equal(enabled.provider['bridge-zen'].models['deepseek-v4-flash'].attachment, true);
  assert.deepEqual(enabled.provider['bridge-zen'].models['deepseek-v4-flash'].modalities.input, ['text', 'image']);
  assert.equal(enabled.provider['bridge-zen'].models['gemini-3.6-flash'].attachment, true);

  const disabled = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [
    { provider: 'zen', model: 'deepseek-v4-flash' }
  ], { imageHandoffTransport: 'disabled', zenCapabilities: OPENCODE_ZEN_MODEL_CAPABILITIES });
  assert.equal(disabled.provider['bridge-zen'].models['deepseek-v4-flash'].attachment, false);
});

test('OpenCode 默认模型始终来自所选上游的实际目录并在目录为空时回退', () => {
  const customZen = {
    'custom-chat': {
      protocol: 'chat', imageInput: false, inputModalities: ['text'], reasoning: true,
      toolCall: true, temperature: true, contextLimit: 32_000, outputLimit: 8_000
    }
  };
  const selectedZen = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [], {
    defaultProvider: 'zen', zenCapabilities: customZen
  });
  assert.equal(selectedZen.model, 'bridge-zen/custom-chat');

  const fallbackGo = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [], {
    defaultProvider: 'zen', zenCapabilities: {}
  });
  assert.equal(fallbackGo.model, 'bridge-go/gpt-5.6-luna');

  const configuredGoOnly = createOpenCodeConfig('https://bridge.example', OPENCODE_GO_MODEL_CAPABILITIES, [], {
    availableProviders: ['go'], defaultProvider: 'zen', zenCapabilities: customZen
  });
  assert.equal(configuredGoOnly.model, 'bridge-go/gpt-5.6-luna');

  const empty = createOpenCodeConfig('https://bridge.example', {}, [], {
    defaultProvider: 'zen', zenCapabilities: {}
  });
  assert.equal('model' in empty, false);
});
