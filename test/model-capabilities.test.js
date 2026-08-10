import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCODE_GO_MODEL_CAPABILITIES,
  OPENCODE_GO_TEXT_ONLY_MODELS,
  OPENCODE_ZEN_MODEL_CAPABILITIES,
  OPENCODE_ZEN_TEXT_ONLY_MODELS,
  openCodeGoModelCapability,
  openCodeModelCapability,
  openCodeZenModelCapability,
  normalizeRequestedModel
} from '../src/model-capabilities.js';

test('OpenCode Go 官方模型协议覆盖 Responses、Claude 和 Chat 三类入口', () => {
  assert.equal(openCodeGoModelCapability('gpt-5.6-luna').protocol, 'responses');
  assert.equal(openCodeGoModelCapability('opencode-go/minimax-m3').protocol, 'claude');
  assert.equal(openCodeGoModelCapability(' QWEN3.8-MAX ').protocol, 'claude');
  assert.equal(openCodeGoModelCapability('kimi-k3').protocol, 'chat');
  assert.equal(openCodeGoModelCapability('unknown-model'), null);
  assert.equal(Object.keys(OPENCODE_GO_MODEL_CAPABILITIES).length, 25);
});

test('请求模型 ID 会统一修剪并拒绝控制字符或超长输入', () => {
  assert.equal(normalizeRequestedModel('  opencode-go/gpt-5.6-luna  '), 'opencode-go/gpt-5.6-luna');
  for (const value of [undefined, '', '   ', 'bad\nmodel', `model-${'x'.repeat(251)}`]) {
    assert.throws(() => normalizeRequestedModel(value), /model 必须是长度 1–256/);
  }
});

test('OpenCode Go 文本模型列表严格来自图片输入模态', () => {
  assert.deepEqual(OPENCODE_GO_TEXT_ONLY_MODELS, [
    'deepseek-v4-flash', 'deepseek-v4-pro',
    'glm-5', 'glm-5.1', 'glm-5.2',
    'hy3', 'hy3-preview',
    'mimo-v2-pro', 'mimo-v2.5-pro',
    'minimax-m2.5', 'minimax-m2.7',
    'qwen3.7-max'
  ]);
  for (const model of OPENCODE_GO_TEXT_ONLY_MODELS) {
    assert.equal(OPENCODE_GO_MODEL_CAPABILITIES[model].imageInput, false, model);
  }
  for (const model of ['gpt-5.6-luna', 'grok-4.5', 'kimi-k3', 'mimo-v2.5', 'minimax-m3', 'qwen3.8-max']) {
    assert.equal(OPENCODE_GO_MODEL_CAPABILITIES[model].imageInput, true, model);
  }
});

test('OpenCode Go 能力表包含生成 OpenCode 自定义模型所需元数据', () => {
  for (const [model, capability] of Object.entries(OPENCODE_GO_MODEL_CAPABILITIES)) {
    assert.equal(capability.reasoning, true, model);
    assert.equal(capability.toolCall, true, model);
    assert.equal(typeof capability.temperature, 'boolean', model);
    assert.equal(Object.isFrozen(capability.inputModalities), true, model);
    assert.equal(capability.inputModalities.includes('image'), capability.imageInput, model);
    assert.equal(Number.isSafeInteger(capability.contextLimit), true, model);
    assert.equal(Number.isSafeInteger(capability.outputLimit), true, model);
    assert.ok(capability.contextLimit >= capability.outputLimit, model);
  }
  assert.equal(OPENCODE_GO_MODEL_CAPABILITIES['gpt-5.6-luna'].inputLimit, 922_000);
  assert.deepEqual(OPENCODE_GO_MODEL_CAPABILITIES['mimo-v2-omni'].inputModalities, ['text', 'image', 'audio', 'pdf']);
});

test('OpenCode Zen 能力表按模型选择 Responses、Claude、Chat 与原生 Gemini', () => {
  assert.equal(openCodeZenModelCapability('opencode/gemini-3.6-flash').protocol, 'gemini');
  assert.equal(openCodeZenModelCapability(' GPT-5.6-TERRA ').protocol, 'responses');
  assert.equal(openCodeZenModelCapability('claude-fable-5').protocol, 'claude');
  assert.equal(openCodeZenModelCapability('deepseek-v4-flash').protocol, 'chat');
  assert.equal(openCodeZenModelCapability('unknown-model'), null);
  assert.equal(Object.keys(OPENCODE_ZEN_MODEL_CAPABILITIES).length, 63);
  assert.equal(openCodeModelCapability('zen', 'grok-4.5').protocol, 'responses');
  assert.equal(openCodeModelCapability('go', 'grok-4.5').protocol, 'chat');
});

test('OpenCode Zen 文本模型列表严格来自图片输入模态', () => {
  assert.deepEqual(OPENCODE_ZEN_TEXT_ONLY_MODELS, [
    'big-pickle',
    'deepseek-v4-flash', 'deepseek-v4-flash-free', 'deepseek-v4-pro',
    'glm-5', 'glm-5.1', 'glm-5.2',
    'gpt-5.3-codex-spark',
    'laguna-s-2.1-free', 'ling-3.0-flash-free', 'ling-3.0-tiny-free', 'longcat-2.0-free',
    'minimax-m2.5', 'minimax-m2.7',
    'nemotron-3-ultra-free', 'north-mini-code-free', 'qwen3.7-max'
  ]);
  for (const model of OPENCODE_ZEN_TEXT_ONLY_MODELS) {
    assert.equal(OPENCODE_ZEN_MODEL_CAPABILITIES[model].imageInput, false, model);
  }
  for (const model of ['gemini-3.6-flash', 'gpt-5.6-terra', 'claude-opus-4-8', 'kimi-k3', 'minimax-m3']) {
    assert.equal(OPENCODE_ZEN_MODEL_CAPABILITIES[model].imageInput, true, model);
  }
});

test('OpenCode Zen 能力表包含生成 OpenCode 自定义模型所需元数据', () => {
  for (const [model, capability] of Object.entries(OPENCODE_ZEN_MODEL_CAPABILITIES)) {
    assert.ok(['responses', 'claude', 'chat', 'gemini'].includes(capability.protocol), model);
    assert.equal(capability.reasoning, true, model);
    assert.equal(capability.toolCall, true, model);
    assert.equal(typeof capability.temperature, 'boolean', model);
    assert.equal(Object.isFrozen(capability.inputModalities), true, model);
    assert.equal(capability.inputModalities.includes('image'), capability.imageInput, model);
    assert.equal(Number.isSafeInteger(capability.contextLimit), true, model);
    assert.equal(Number.isSafeInteger(capability.outputLimit), true, model);
    assert.ok(capability.contextLimit >= capability.outputLimit, model);
  }
});
