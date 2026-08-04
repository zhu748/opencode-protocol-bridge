import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialHealthTracker, credentialDisplayName } from '../src/credential-health.js';

const credentials = [
  { apiKey: 'first-secret', credentialId: 'environment:1' },
  { apiKey: 'second-secret', credentialId: 'environment:2' }
];

test('健康 Key 按槽位轮询，鉴权失败后跳过并在冷却结束后恢复', () => {
  let now = Date.parse('2026-08-04T12:00:00Z');
  const health = new CredentialHealthTracker({ now: () => now, authCooldownMs: 10_000 });
  const first = health.select('go', credentials).credential;
  assert.equal(first.credentialId, 'environment:1');
  health.recordResponse('go', first, 401);
  assert.equal(health.select('go', credentials).credential.credentialId, 'environment:2');
  const snapshot = health.snapshot('go', credentials);
  assert.equal(snapshot[0].state, 'cooldown');
  assert.equal(snapshot[0].lastFailureKind, 'auth');
  assert.equal(snapshot[0].retryAfterMs, 10_000);

  now += 10_001;
  health.recordSuccess('go', credentials[1]);
  assert.equal(health.select('go', credentials).credential.credentialId, 'environment:1');
  health.recordSuccess('go', credentials[0]);
  assert.equal(health.snapshot('go', credentials)[0].state, 'healthy');
});

test('所有 Key 冷却时返回重试时间且不暴露密钥', () => {
  let now = 1_000_000;
  const health = new CredentialHealthTracker({ now: () => now, rateLimitCooldownMs: 30_000, maxCooldownMs: 60_000 });
  health.recordResponse('zen', credentials[0], 429, '45');
  health.recordResponse('zen', credentials[1], 429, new Date(now + 90_000).toUTCString());
  const selected = health.select('zen', credentials);
  assert.equal(selected.credential, null);
  assert.equal(selected.reason, 'cooldown');
  assert.equal(selected.retryAfterMs, 45_000);
  assert.doesNotMatch(JSON.stringify(health.snapshot('zen', credentials)), /first-secret|second-secret/);
});

test('网络和 5xx 连续三次后指数冷却，普通 4xx 会恢复健康', () => {
  let now = 10_000;
  const health = new CredentialHealthTracker({ now: () => now, transientThreshold: 3, transientCooldownMs: 1_000, maxCooldownMs: 8_000 });
  health.recordNetworkFailure('go', credentials[0]);
  health.recordResponse('go', credentials[0], 503);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
  health.recordResponse('go', credentials[0], 500);
  assert.equal(health.snapshot('go', [credentials[0]])[0].retryAfterMs, 1_000);
  now += 1_001;
  health.recordResponse('go', credentials[0], 400);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'healthy');
});

test('同一槽位更换 Key 后不会继承旧 Key 的冷却状态', () => {
  const health = new CredentialHealthTracker({ now: () => 1000 });
  health.recordResponse('go', credentials[0], 401);
  const replacement = { ...credentials[0], apiKey: 'replacement-secret' };
  assert.equal(health.select('go', [replacement]).credential, replacement);
});

test('管理员重置只清除指定 Key 的运行状态', () => {
  const health = new CredentialHealthTracker({ now: () => 1000 });
  health.recordResponse('go', credentials[0], 401);
  health.recordSuccess('go', credentials[1]);
  assert.equal(health.reset('go', credentials[0]), true);
  assert.equal(health.snapshot('go', credentials)[0].state, 'unknown');
  assert.equal(health.snapshot('go', credentials)[1].state, 'healthy');
  assert.equal(health.reset('go', credentials[0]), false);
});

test('冷却结束只放行一个半开探测请求，避免并发重试风暴', () => {
  let now = 1_000;
  const health = new CredentialHealthTracker({ now: () => now, authCooldownMs: 1_000 });
  health.recordResponse('go', credentials[0], 401);
  now += 1_001;
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  const concurrent = health.select('go', [credentials[0]]);
  assert.equal(concurrent.credential, null);
  assert.equal(concurrent.retryAfterMs, 1_000);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'probing');
  health.recordNetworkFailure('go', credentials[0]);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'cooldown');
});

test('Key 展示名称只包含提供方、来源和槽位', () => {
  assert.equal(credentialDisplayName('zen', 'environment:3'), 'ZEN 环境 #3');
  assert.equal(credentialDisplayName('go', 'config:1'), 'GO · 面板 Key');
  assert.equal(credentialDisplayName('go', 'config:1', '编程套餐'), 'GO · 编程套餐');
});
