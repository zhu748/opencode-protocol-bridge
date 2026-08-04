import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword, createSession, verifySession, loginAllowed, recordLogin, cookieValue, hashClientToken, clientAddress } from '../src/auth.js';

test('密码使用随机盐 scrypt 哈希并可安全验证', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.match(first, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('anything', 'invalid'), false);
  assert.equal(await verifyPassword('anything', 'scrypt::'), false);
  assert.equal(await verifyPassword('x'.repeat(257), first), false);
});

test('管理会话验证签名和过期时间', () => {
  const secret = 'session-secret';
  const valid = createSession(secret);
  assert.equal(verifySession(valid, secret), true);
  assert.equal(verifySession(`${valid}x`, secret), false);
  assert.equal(verifySession(valid, 'other-secret'), false);

  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifySession(`${payload}.${signature}`, secret), false);
});

test('登录失败达到阈值后限速，成功登录会清除记录', () => {
  const ip = `test-${Date.now()}-${Math.random()}`;
  for (let index = 0; index < 10; index++) recordLogin(ip, false);
  assert.equal(loginAllowed(ip), false);
  recordLogin(ip, true);
  assert.equal(loginAllowed(ip), true);
});

test('Cookie 解析支持多个值', () => {
  assert.equal(cookieValue('foo=1; bridge_session=a.b.c; theme=dark', 'bridge_session'), 'a.b.c');
  assert.equal(cookieValue('', 'missing'), '');
});

test('客户端令牌使用稳定的单向摘要', () => {
  assert.equal(hashClientToken('ocb_test-token'), hashClientToken('ocb_test-token'));
  assert.notEqual(hashClientToken('ocb_test-token'), hashClientToken('ocb_other-token'));
  assert.match(hashClientToken('ocb_test-token'), /^[A-Za-z0-9_-]{43}$/);
});

test('仅在显式信任反向代理时使用有效的首个转发地址', () => {
  const request = {
    socket: { remoteAddress: '10.0.0.8' },
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.7' }
  };
  assert.equal(clientAddress(request, false), '10.0.0.8');
  assert.equal(clientAddress(request, true), '203.0.113.9');
  assert.equal(clientAddress({ ...request, headers: { 'x-forwarded-for': 'not-an-ip' } }, true), '10.0.0.8');
});
