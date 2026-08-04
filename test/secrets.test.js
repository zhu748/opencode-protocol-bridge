import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptValue, decryptValue, encryptConfig, decryptConfig } from '../src/secrets.js';

test('敏感配置使用带随机 IV 和认证标签的 AES-256-GCM 加密', () => {
  const key = 'a-strong-config-master-key';
  const first = encryptValue('secret-value', key, 'zenKey');
  const second = encryptValue('secret-value', key, 'zenKey');
  assert.match(first, /^enc:v1:/);
  assert.notEqual(first, second);
  assert.equal(decryptValue(first, key, 'zenKey'), 'secret-value');
  assert.throws(() => decryptValue(first, 'different-master-key', 'zenKey'), /无法解密/);
  assert.throws(() => decryptValue(first, '', 'zenKey'), /未设置/);
  const prefixLikeSecret = 'enc:v1:user-provided-key';
  const encryptedPrefixLikeSecret = encryptValue(prefixLikeSecret, key, 'zenKey');
  assert.notEqual(encryptedPrefixLikeSecret, prefixLikeSecret);
  assert.equal(decryptValue(encryptedPrefixLikeSecret, key, 'zenKey'), prefixLikeSecret);
});

test('配置加密只处理敏感字段并可完整还原', () => {
  const source = { zenKey: 'zen-secret', goKey: 'go-secret', clientToken: 'client-secret', sessionSecret: 'session-secret', proxyUrl: 'http://user:pass@proxy', zenProxyUrl: 'socks5://zen-user:pass@proxy:1080', goProxyUrl: 'https://go-user:pass@proxy:443', defaultProvider: 'zen' };
  const encrypted = encryptConfig(source, 'another-strong-master-key');
  assert.equal(encrypted.defaultProvider, 'zen');
  assert.doesNotMatch(JSON.stringify(encrypted), /zen-secret|go-secret|zen-user|go-user|user:pass/);
  assert.deepEqual(decryptConfig(encrypted, 'another-strong-master-key'), source);
});

test('未配置主密钥时保持向后兼容的明文配置', () => {
  const source = { zenKey: 'plain', defaultProvider: 'zen' };
  assert.deepEqual(encryptConfig(source, ''), source);
  assert.deepEqual(decryptConfig(source, ''), source);
  const prefixLikeSource = { zenKey: 'enc:v1:user-provided-key', goKey: 'plain:v1:user-provided-key' };
  const escaped = encryptConfig(prefixLikeSource, '');
  assert.notDeepEqual(escaped, prefixLikeSource);
  assert.deepEqual(decryptConfig(escaped, ''), prefixLikeSource);
  assert.throws(() => encryptValue('x', 'short', 'zenKey'), /至少需要 16/);
});
