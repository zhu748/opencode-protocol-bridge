import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUERY_PARAMETERS, MAX_REQUEST_TARGET_BYTES, parseRequestTarget } from '../src/request-target.js';

test('请求目标解析仅接受 origin-form 路径', () => {
  const url = parseRequestTarget('/v1/models?provider=go');
  assert.equal(url.origin, 'http://localhost');
  assert.equal(url.pathname, '/v1/models');
  assert.equal(url.searchParams.get('provider'), 'go');

  for (const target of [
    '',
    'health',
    'http://attacker.invalid/health',
    '//attacker.invalid/health',
    '/\\attacker.invalid/health',
    '/health#fragment'
  ]) {
    assert.throws(() => parseRequestTarget(target), { status: 400 });
  }
});

test('请求目标限制编码后的字节长度', () => {
  assert.equal(parseRequestTarget(`/${'a'.repeat(MAX_REQUEST_TARGET_BYTES - 1)}`).pathname.length, MAX_REQUEST_TARGET_BYTES);
  assert.throws(() => parseRequestTarget(`/${'a'.repeat(MAX_REQUEST_TARGET_BYTES)}`), { status: 414 });
  assert.throws(() => parseRequestTarget(`/${'中'.repeat(Math.ceil(MAX_REQUEST_TARGET_BYTES / 3))}`), { status: 414 });
});

test('查询参数限制数量并拒绝重复的单值参数', () => {
  const allowed = Array.from({ length: MAX_QUERY_PARAMETERS }, (_, index) => `q${index}=1`).join('&');
  assert.equal([...parseRequestTarget(`/health?${allowed}`).searchParams].length, MAX_QUERY_PARAMETERS);

  const excessive = `${allowed}&extra=1`;
  assert.throws(() => parseRequestTarget(`/health?${excessive}`), { status: 400 });
  assert.throws(() => parseRequestTarget('/v1/models?provider=zen&provider=go'), /provider 不能重复/);
  assert.throws(() => parseRequestTarget('/api/stats?window=24h&window=7d'), /window 不能重复/);
  assert.throws(() => parseRequestTarget('/v1/messages?beta=true&beta=false'), /beta 不能重复/);

  const repeatedUnknown = parseRequestTarget('/health?tag=one&tag=two');
  assert.deepEqual(repeatedUnknown.searchParams.getAll('tag'), ['one', 'two']);
});
