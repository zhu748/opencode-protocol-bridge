import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { encryptValue, decryptValue, encryptConfig, decryptConfig } from '../src/secrets.js';

function legacyEncryptedValue(value, passphrase, field) {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(passphrase, 'utf8').digest(), iv);
  cipher.setAAD(Buffer.from(`opencode-bridge:${field}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

test('敏感配置使用带随机 IV 和认证标签的 AES-256-GCM 加密', () => {
  const key = 'a-strong-config-master-key';
  const first = encryptValue('secret-value', key, 'zenKey');
  const second = encryptValue('secret-value', key, 'zenKey');
  assert.match(first, /^enc:v2:/);
  assert.notEqual(first, second);
  assert.equal(decryptValue(first, key, 'zenKey'), 'secret-value');
  assert.throws(() => decryptValue(first, 'different-master-key', 'zenKey'), /无法解密/);
  assert.throws(() => decryptValue(first, '', 'zenKey'), /未设置/);
  const prefixLikeSecret = 'enc:v1:user-provided-key';
  const encryptedPrefixLikeSecret = encryptValue(prefixLikeSecret, key, 'zenKey');
  assert.notEqual(encryptedPrefixLikeSecret, prefixLikeSecret);
  assert.equal(decryptValue(encryptedPrefixLikeSecret, key, 'zenKey'), prefixLikeSecret);
  assert.equal(decryptValue(legacyEncryptedValue('legacy-secret', key, 'zenKey'), key, 'zenKey'), 'legacy-secret');
});

test('配置加密只处理敏感字段并可完整还原', () => {
  const source = {
    zenKey: 'zen-secret', goKey: 'go-secret', clientToken: 'client-secret', sessionSecret: 'session-secret',
    proxyUrl: 'http://user:pass@proxy', zenProxyUrl: 'socks5://zen-user:pass@proxy:1080', goProxyUrl: 'https://go-user:pass@proxy:443',
    zenCredentials: [{ id: 'zen-1', name: '主力', apiKey: 'zen-pool-secret', proxyUrl: 'socks5://pool-user:pass@proxy:1080' }],
    goCredentials: [{ id: 'go-1', name: '备用', apiKey: 'go-pool-secret', proxyUrl: '' }], defaultProvider: 'zen'
  };
  const encrypted = encryptConfig(source, 'another-strong-master-key');
  assert.equal(encrypted.defaultProvider, 'zen');
  assert.doesNotMatch(JSON.stringify(encrypted), /zen-secret|go-secret|pool-secret|zen-user|go-user|pool-user|user:pass/);
  assert.match(encrypted.zenCredentials[0].apiKey, /^enc:v2:/);
  assert.match(encrypted.zenCredentials[0].proxyUrl, /^enc:v2:/);
  assert.equal(encrypted.zenCredentials[0].apiKey.split(':')[2], encrypted.zenCredentials[0].proxyUrl.split(':')[2]);
  assert.notEqual(encrypted.zenCredentials[0].apiKey.split(':')[3], encrypted.zenCredentials[0].proxyUrl.split(':')[3]);
  assert.deepEqual(decryptConfig(encrypted, 'another-strong-master-key'), source);
});

test('未配置主密钥时保持向后兼容的明文配置', () => {
  const source = { zenKey: 'plain', defaultProvider: 'zen' };
  assert.deepEqual(encryptConfig(source, ''), source);
  assert.deepEqual(decryptConfig(source, ''), source);
  const prefixLikeSource = { zenKey: 'enc:v1:user-provided-key', goKey: 'enc:v2:user-provided-key', proxyUrl: 'plain:v1:user-provided-proxy' };
  const escaped = encryptConfig(prefixLikeSource, '');
  assert.notDeepEqual(escaped, prefixLikeSource);
  assert.deepEqual(decryptConfig(escaped, ''), prefixLikeSource);
  assert.throws(() => encryptValue('x', 'short', 'zenKey'), /至少需要 16/);
});

test('多 Key 中看似密文前缀的真实值在明文模式下可逆转义', () => {
  const source = { zenCredentials: [{ id: 'prefix', name: '前缀测试', apiKey: 'enc:v1:user-key', proxyUrl: 'plain:v1:user-proxy' }] };
  const stored = encryptConfig(source, '');
  assert.notDeepEqual(stored, source);
  assert.deepEqual(decryptConfig(stored, ''), source);
});
