import test from 'node:test';
import assert from 'node:assert/strict';

import { applySecurityResponseHeaders, healthEndpointKind, healthResponse } from '../src/http-policy.js';

test('健康检查明确区分兼容、存活和就绪语义', () => {
  assert.equal(healthEndpointKind('/health'), 'legacy');
  assert.equal(healthEndpointKind('/healthz'), 'legacy');
  assert.equal(healthEndpointKind('/livez'), 'liveness');
  assert.equal(healthEndpointKind('/readyz'), 'readiness');
  assert.equal(healthEndpointKind('/other'), null);

  assert.deepEqual(healthResponse('liveness', { ready: false, configured: false, uptime: 1.9 }), {
    status: 200, body: { ok: true, ready: false, configured: false, uptime: 1 }
  });
  assert.deepEqual(healthResponse('readiness', { ready: false, configured: true, uptime: 2 }), {
    status: 503, body: { ok: false, ready: false, configured: true, uptime: 2 }
  });
  assert.equal(healthResponse('readiness', { ready: true, configured: true, uptime: 2 }).status, 200);
});

test('安全响应头保持严格自托管 CSP 并只在 HTTPS 下启用 HSTS', () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  applySecurityResponseHeaders(response, false);
  assert.match(headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(headers.get('content-security-policy'), /style-src 'self'/);
  assert.doesNotMatch(headers.get('content-security-policy'), /https?:/);
  assert.equal(headers.has('strict-transport-security'), false);
  applySecurityResponseHeaders(response, true);
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
});
