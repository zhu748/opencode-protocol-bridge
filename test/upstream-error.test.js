import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_UPSTREAM_ERROR_MESSAGE_CHARS, normalizeUpstreamHttpError, normalizeUpstreamStreamError } from '../src/upstream-error.js';

test('上游 HTTP 错误只保留安全字段并脱敏凭据', () => {
  const failure = normalizeUpstreamHttpError(JSON.stringify({
    error: {
      message: ' request failed\nfor secret-key through socks5://user:pass@127.0.0.1:1080 ',
      type: 'server_error',
      code: 'upstream_busy'
    },
    debug: { authorization: 'Bearer secret-key' },
    privateMarker: 'UPSTREAM_PRIVATE_MARKER'
  }), 503, { secrets: ['secret-key', 'socks5://user:pass@127.0.0.1:1080'] });

  assert.deepEqual(failure, {
    status: 503,
    message: 'request failed for [REDACTED] through [REDACTED]',
    type: 'server_error',
    code: 'upstream_busy'
  });
  assert.doesNotMatch(JSON.stringify(failure), /secret-key|UPSTREAM_PRIVATE_MARKER|user:pass/);
});

test('损坏或非对象错误正文会转换为稳定的本地错误', () => {
  assert.deepEqual(normalizeUpstreamHttpError('{broken', 502), {
    status: 502,
    message: 'OpenCode 上游返回 HTTP 502',
    type: 'upstream_error',
    code: 'upstream_http_error'
  });
  assert.deepEqual(normalizeUpstreamHttpError('[]', 302), {
    status: 502,
    message: 'OpenCode 上游返回 HTTP 302',
    type: 'upstream_error',
    code: 'upstream_http_error'
  });
});

test('上游错误消息与标识符会被限制为安全范围', () => {
  const failure = normalizeUpstreamHttpError(JSON.stringify({
    error: {
      message: `start\u0000 ${'x'.repeat(MAX_UPSTREAM_ERROR_MESSAGE_CHARS + 20)}🙂`,
      type: 'invalid type with spaces',
      code: 'secret-key'
    }
  }), 429, { secrets: ['secret-key'] });

  assert.equal(failure.message.length, MAX_UPSTREAM_ERROR_MESSAGE_CHARS);
  assert.doesNotMatch(failure.message, /[\u0000-\u001f\u007f]/);
  assert.equal(failure.type, 'upstream_error');
  assert.equal(failure.code, 'upstream_http_error');
});

test('流式上游错误脱敏限长并丢弃调试字段', () => {
  const failure = normalizeUpstreamStreamError({
    type: 'server_error',
    code: 'secret-key',
    message: ` failed\nfor secret-key through socks5://user:pass@127.0.0.1:1080 ${'x'.repeat(MAX_UPSTREAM_ERROR_MESSAGE_CHARS)} `,
    param: 'socks5://user:pass@127.0.0.1:1080',
    debug: { authorization: 'Bearer secret-key' }
  }, { secrets: ['secret-key', 'socks5://user:pass@127.0.0.1:1080'] });

  assert.equal(failure.message.length, MAX_UPSTREAM_ERROR_MESSAGE_CHARS);
  assert.match(failure.message, /failed for \[REDACTED\] through \[REDACTED\]/);
  assert.deepEqual({ ...failure, message: undefined }, {
    message: undefined,
    type: 'server_error',
    param: null
  });
  assert.doesNotMatch(JSON.stringify(failure), /secret-key|user:pass|authorization|debug/);
  assert.deepEqual(normalizeUpstreamStreamError(' plain\r\nerror '), {
    message: 'plain error',
    type: 'upstream_error'
  });
});
