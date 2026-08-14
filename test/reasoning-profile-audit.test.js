import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedReasoningProfile, reasoningProfileAuditError } from '../scripts/reasoning-profile-audit.mjs';

test('reasoning_options 选择真实最高 effort 而不依赖数组顺序', () => {
  assert.equal(expectedReasoningProfile('gpt-test', {
    reasoning_options: [{ type: 'effort', values: ['xhigh', null, 'low', 'max', 'high'] }]
  }, 'responses'), 'max');
  assert.equal(expectedReasoningProfile('claude-opus-4-5', {
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }]
  }, 'claude'), 'legacy-high');
});

test('reasoning_options 的 budget、toggle 和 MiniMax adaptive 使用协议可表达策略', () => {
  assert.equal(expectedReasoningProfile('qwen-test', {
    reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 81_920 }],
    limit: { output: 65_536 }
  }, 'claude'), 'budget:31999');
  assert.equal(expectedReasoningProfile('toggle-only', {
    reasoning_options: [{ type: 'toggle' }], limit: { output: 32_000 }
  }, 'chat'), 'model-default');
  assert.equal(expectedReasoningProfile('minimax-m3', {
    reasoning_options: [{ type: 'toggle' }], limit: { output: 128_000 }
  }, 'claude'), 'adaptive');
  assert.equal(expectedReasoningProfile('missing-options', {}, 'chat'), undefined);
});

test('最高思考目录审计报告策略漂移和损坏的 reasoning_options', () => {
  assert.match(reasoningProfileAuditError({
    model: 'grok-next', protocol: 'responses', actual: 'high',
    metadata: { reasoning_options: [{ type: 'effort', values: ['low', 'xhigh'] }] }
  }), /本地=high.*models\.dev=xhigh/);
  assert.match(reasoningProfileAuditError({
    model: 'broken', protocol: 'responses', actual: 'high',
    metadata: { reasoning_options: [{ type: 'effort', values: ['extreme'] }] }
  }), /包含未知档位/);
  assert.match(reasoningProfileAuditError({
    model: 'new-control', protocol: 'chat', actual: 'model-default',
    metadata: { reasoning_options: [{ type: 'thinking_level', values: ['high'] }] }
  }), /包含未知类型/);
  assert.equal(reasoningProfileAuditError({
    model: 'ok', protocol: 'chat', actual: 'high',
    metadata: { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }
  }), undefined);
});
