import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialHealthTracker, credentialDisplayName } from '../src/credential-health.js';

const credentials = [
  { apiKey: 'first-secret', credentialId: 'environment:1' },
  { apiKey: 'second-secret', credentialId: 'environment:2' }
];

test('健康 Key 按槽位轮询，鉴权失败仅降级排序而不封锁', () => {
  const health = new CredentialHealthTracker({ now: () => Date.parse('2026-08-04T12:00:00Z') });
  const first = health.select('go', credentials).credential;
  assert.equal(first.credentialId, 'environment:1');
  health.recordResponse('go', first, 401);
  assert.equal(health.select('go', credentials).credential.credentialId, 'environment:2');
  const snapshot = health.snapshot('go', credentials);
  assert.equal(snapshot[0].state, 'degraded');
  assert.equal(snapshot[0].lastFailureKind, 'auth');
  assert.equal(snapshot[0].retryAfterMs, 0);
  assert.equal(snapshot[0].cooldownUntil, null);
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  health.recordSuccess('go', credentials[0]);
  assert.equal(health.snapshot('go', credentials)[0].state, 'healthy');
});

test('所有 Key 均失败时仍返回可用槽位且不暴露密钥', () => {
  const health = new CredentialHealthTracker({ now: () => 1_000_000 });
  health.recordResponse('zen', credentials[0], 429, '45');
  health.recordResponse('zen', credentials[1], 429, '90');
  const selected = health.select('zen', credentials);
  assert.equal(selected.credential, credentials[0]);
  assert.equal(selected.reason, null);
  assert.equal(selected.retryAfterMs, 0);
  assert.doesNotMatch(JSON.stringify(health.snapshot('zen', credentials)), /first-secret|second-secret/);
});

test('网络和 5xx 只累计失败状态，普通 4xx 会恢复健康', () => {
  const health = new CredentialHealthTracker({ now: () => 10_000 });
  health.recordNetworkFailure('go', credentials[0]);
  health.recordResponse('go', credentials[0], 503);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
  health.recordResponse('go', credentials[0], 500);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
  assert.equal(health.snapshot('go', [credentials[0]])[0].retryAfterMs, 0);
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  health.recordResponse('go', credentials[0], 400);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'healthy');
});

test('同一槽位更换 Key 后不会继承旧 Key 的失败状态', () => {
  const health = new CredentialHealthTracker({ now: () => 1000 });
  health.recordResponse('go', credentials[0], 401);
  const replacement = { ...credentials[0], apiKey: 'replacement-secret' };
  assert.equal(health.select('go', [replacement]).credential, replacement);
});

test('同一凭据对象复用身份哈希且字段变更时自动失效', () => {
  let apiKeyStringifications = 0;
  let proxyStringifications = 0;
  const credential = {
    apiKey: { toString() { apiKeyStringifications++; return 'cached-key'; } },
    proxyUrl: { toString() { proxyStringifications++; return 'http://cached-proxy/'; } },
    credentialId: 'environment:1'
  };
  const health = new CredentialHealthTracker({ now: () => 1000 });
  assert.equal(health.select('go', [credential]).credential, credential);
  health.recordSuccess('go', credential);
  health.snapshot('go', [credential]);
  assert.equal(apiKeyStringifications, 1);
  assert.equal(proxyStringifications, 1);

  credential.apiKey = { toString() { apiKeyStringifications++; return 'rotated-key'; } };
  health.recordResponse('go', credential, 401);
  assert.equal(apiKeyStringifications, 2);
  assert.equal(proxyStringifications, 2);
  assert.equal(health.states.size, 2);
  assert.equal(health.snapshot('go', [credential])[0].state, 'degraded');
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

test('失败 Key 不进入半开探测且单 Key 始终可继续使用', () => {
  const health = new CredentialHealthTracker({ now: () => 1_000 });
  health.recordResponse('go', credentials[0], 401);
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
  health.recordNetworkFailure('go', credentials[0]);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
});

test('客户端取消或本地转换错误的兼容释放操作不改变失败状态', () => {
  const health = new CredentialHealthTracker({ now: () => 1_000 });
  health.recordResponse('go', credentials[0], 401);
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  assert.equal(health.releaseProbe('go', credentials[0]), false);
  assert.equal(health.snapshot('go', [credentials[0]])[0].state, 'degraded');
  assert.equal(health.select('go', [credentials[0]]).credential, credentials[0]);
  assert.equal(health.releaseProbe('go', credentials[0]), false);
  assert.equal(health.snapshot('go', [credentials[0]])[0].consecutiveFailures, 1);
});

test('大 Key 池故障切换原地跳过已尝试项且不计算其密钥指纹', () => {
  const count = 2048;
  let excludedApiKeyReads = 0;
  const largePool = Array.from({ length: count }, (_, index) => new Proxy({
    apiKey: `key-${index}`,
    credentialId: `environment:${index + 1}`
  }, {
    get(target, key, receiver) {
      if (key === 'apiKey' && target.credentialId !== `environment:${count}`) excludedApiKeyReads++;
      return Reflect.get(target, key, receiver);
    }
  }));
  const attempted = new Set(largePool.slice(0, -1).map((credential) => credential.credentialId));
  const health = new CredentialHealthTracker({ now: () => 1000 });
  assert.equal(health.select('go', largePool, attempted).credential, largePool.at(-1));
  assert.equal(excludedApiKeyReads, 0);
  assert.deepEqual(health.select('go', largePool, new Set(largePool.map((credential) => credential.credentialId))), {
    credential: null, reason: 'exhausted', retryAfterMs: 0
  });

  const degraded = new CredentialHealthTracker({ now: () => 1000 });
  degraded.recordResponse('go', largePool[0], 429, '10');
  degraded.recordResponse('go', largePool[1], 429, '20');
  assert.deepEqual(degraded.select('go', largePool.slice(0, 2), new Set([largePool[0].credentialId])), {
    credential: largePool[1], reason: null, retryAfterMs: 0
  });
});

test('健康状态容量淘汰单遍寻找最旧项而不排序全表', () => {
  let now = 1000;
  const health = new CredentialHealthTracker({ now: () => now++, maxStates: 64 });
  const sort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function countedSort(...args) {
    sortCalls++;
    return Reflect.apply(sort, this, args);
  };
  try {
    for (let index = 0; index < 256; index++) {
      health.recordSuccess('go', { apiKey: `key-${index}`, credentialId: `environment:${index}` });
    }
  } finally {
    Array.prototype.sort = sort;
  }
  assert.equal(sortCalls, 0);
  assert.equal(health.states.size, 64);
  assert.equal(health.snapshot('go', [{ apiKey: 'key-0', credentialId: 'environment:0' }])[0].state, 'unknown');
  assert.equal(health.snapshot('go', [{ apiKey: 'key-255', credentialId: 'environment:255' }])[0].state, 'healthy');
});

test('Key 展示名称只包含提供方、来源和槽位', () => {
  assert.equal(credentialDisplayName('zen', 'environment:3'), 'ZEN 环境 #3');
  assert.equal(credentialDisplayName('go', 'config:1'), 'GO · 面板 Key');
  assert.equal(credentialDisplayName('go', 'config:1', '编程套餐'), 'GO · 编程套餐');
});
