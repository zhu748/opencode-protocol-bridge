import test from 'node:test';
import assert from 'node:assert/strict';
import { KeepAliveService, normalizeKeepAliveUrl, resolveKeepAliveConfig } from '../src/keep-alive.js';

const waitFor = async (predicate, timeoutMs = 500) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('等待保活请求超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('保活 URL 规范化并拒绝危险或不支持的格式', () => {
  assert.equal(normalizeKeepAliveUrl(' https://example.com/healthz '), 'https://example.com/healthz');
  assert.equal(normalizeKeepAliveUrl(''), '');
  assert.throws(() => normalizeKeepAliveUrl('file:///tmp/a'), /仅支持 HTTP 或 HTTPS/);
  assert.throws(() => normalizeKeepAliveUrl('https://user:pass@example.com'), /用户名或密码/);
  assert.throws(() => normalizeKeepAliveUrl('https://example.com/#secret'), /片段标识/);
});

test('环境变量可直接指定完整保活 URL 和间隔', () => {
  const stored = { keepAliveUrl: 'https://stored.example/healthz', keepAliveIntervalSeconds: 90 };
  assert.deepEqual(resolveKeepAliveConfig(stored, {
    OPENCODE_BRIDGE_KEEP_ALIVE_URL: 'https://bridge.onrender.com/healthz',
    OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS: '15'
  }), {
    keepAliveUrl: 'https://bridge.onrender.com/healthz', keepAliveIntervalSeconds: 15,
    urlManagedByEnvironment: true, intervalManagedByEnvironment: true
  });
  assert.equal(resolveKeepAliveConfig(stored, { OPENCODE_BRIDGE_KEEP_ALIVE_URL: 'https://custom.example/ping' }).keepAliveUrl, 'https://custom.example/ping');
  assert.throws(() => resolveKeepAliveConfig(stored, { OPENCODE_BRIDGE_KEEP_ALIVE_URL: 'auto' }), /格式无效/);
  assert.throws(() => resolveKeepAliveConfig(stored, { OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS: '4' }), /5–86400/);
});

test('保活服务立即请求、记录状态并可热更新和关闭', async () => {
  const calls = [];
  const service = new KeepAliveService({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 204, body: null };
  } });
  service.configure({ keepAliveUrl: 'https://first.example/healthz', keepAliveIntervalSeconds: 60 });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(service.status().lastStatus, 204);
  assert.ok(service.status().lastSuccessAt);

  service.configure({ keepAliveUrl: 'https://second.example/healthz', keepAliveIntervalSeconds: 5 });
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].url, 'https://second.example/healthz');
  assert.equal(service.status().intervalSeconds, 5);

  service.configure({ keepAliveUrl: '', keepAliveIntervalSeconds: 60 });
  assert.equal(service.status().enabled, false);
  service.close();
});

test('保活服务记录非成功响应且不抛出到调用方', async () => {
  const service = new KeepAliveService({ fetchImpl: async () => ({ ok: false, status: 502, body: null }) });
  service.configure({ keepAliveUrl: 'https://example.com/healthz', keepAliveIntervalSeconds: 60 });
  await waitFor(() => service.status().lastStatus === 502);
  assert.equal(service.status().lastError, 'HTTP 502');
  service.close();
});
