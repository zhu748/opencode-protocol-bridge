import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredProviderCredentials, createProviderCredentialResolver, environmentProviderCredentials } from '../src/provider-credentials.js';

test('编号环境变量按序组成多 Key 池并匹配同编号代理', () => {
  const pool = environmentProviderCredentials({
    OPENCODE_PROXY_URL: 'http://default:7890',
    OPENCODE_ZEN_KEY_3: 'zen-three',
    OPENCODE_ZEN_KEY_1: 'zen-one',
    OPENCODE_ZEN_PROXY_URL_1: 'socks5h://proxy-one:1080',
    OPENCODE_ZEN_PROXY_URL_3: 'http://proxy-three:8080'
  }, 'zen');
  assert.deepEqual(pool, [
    { apiKey: 'zen-one', proxyUrl: 'socks5h://proxy-one:1080', credentialId: 'environment:1' },
    { apiKey: 'zen-three', proxyUrl: 'http://proxy-three:8080/', credentialId: 'environment:3' }
  ]);
});

test('KEYS 支持逗号、换行和 JSON 数组并使用提供方代理回退', () => {
  assert.deepEqual(environmentProviderCredentials({
    OPENCODE_GO_KEYS: 'go-one,\ngo-two',
    OPENCODE_GO_PROXY_URL: '127.0.0.1:7890'
  }, 'go'), [
    { apiKey: 'go-one', proxyUrl: 'http://127.0.0.1:7890/', credentialId: 'environment:1' },
    { apiKey: 'go-two', proxyUrl: 'http://127.0.0.1:7890/', credentialId: 'environment:2' }
  ]);
  assert.deepEqual(environmentProviderCredentials({
    OPENCODE_ZEN_KEYS: '["one", "two"]',
    OPENCODE_ZEN_PROXY_URLS: '["", "socks5://second:1080"]'
  }, 'zen'), [
    { apiKey: 'one', proxyUrl: '', credentialId: 'environment:1' },
    { apiKey: 'two', proxyUrl: 'socks5://second:1080', credentialId: 'environment:2' }
  ]);
});

test('环境 Key 优先于旧配置且非法列表和代理会被拒绝', () => {
  const config = { zenKey: 'saved', zenProxyUrl: 'http://saved:80', proxyUrl: '' };
  assert.deepEqual(configuredProviderCredentials(config, 'zen', [{ apiKey: 'env', proxyUrl: '' }]), [{ apiKey: 'env', proxyUrl: '' }]);
  assert.deepEqual(configuredProviderCredentials(config, 'zen'), [{ apiKey: 'saved', proxyUrl: 'http://saved/', credentialId: 'config:legacy-zen', credentialLabel: '默认 Key' }]);
  assert.throws(() => environmentProviderCredentials({ OPENCODE_ZEN_KEYS: '[broken' }, 'zen'), /JSON 数组/);
  assert.throws(() => environmentProviderCredentials({ OPENCODE_ZEN_KEY_1: 'key', OPENCODE_ZEN_PROXY_URL_1: 'ftp:\/\/bad' }, 'zen'), /代理协议/);
});

test('面板多 Key 使用稳定槽位、名称和逐 Key 代理', () => {
  const config = {
    proxyUrl: 'http://default:7890', zenProxyUrl: '', zenKey: '',
    zenCredentials: [
      { id: 'primary', name: '主力套餐', apiKey: 'key-one', proxyUrl: 'socks5h://one:1080' },
      { id: 'backup', name: '备用套餐', apiKey: 'key-two', proxyUrl: '' }
    ]
  };
  assert.deepEqual(configuredProviderCredentials(config, 'zen'), [
    { apiKey: 'key-one', proxyUrl: 'socks5h://one:1080', credentialId: 'config:primary', credentialLabel: '主力套餐' },
    { apiKey: 'key-two', proxyUrl: 'http://default:7890', credentialId: 'config:backup', credentialLabel: '备用套餐' }
  ]);
});

test('凭据解析器按配置快照和 provider 复用规范化结果', () => {
  let credentialReads = 0;
  const zenCredentials = [{
    id: 'cached', name: '缓存套餐',
    get apiKey() { credentialReads++; return 'cached-key'; },
    proxyUrl: ''
  }];
  const config = { proxyUrl: '', zenProxyUrl: '', goProxyUrl: '', zenCredentials, goCredentials: [] };
  const resolveCredentials = createProviderCredentialResolver();
  const first = resolveCredentials(config, 'zen');
  const readsAfterFirst = credentialReads;
  assert.equal(resolveCredentials(config, 'zen'), first);
  assert.equal(credentialReads, readsAfterFirst);
  assert.deepEqual(first.map((credential) => credential.credentialId), ['config:cached']);

  const next = { ...config, zenCredentials: [{ id: 'rotated', name: '轮换套餐', apiKey: 'rotated-key', proxyUrl: '' }] };
  const rotated = resolveCredentials(next, 'zen');
  assert.notEqual(rotated, first);
  assert.deepEqual(rotated.map((credential) => credential.credentialId), ['config:rotated']);
  assert.notEqual(resolveCredentials(config, 'go'), first);
});

test('面板凭据规范化单遍跳过无效槽位而不使用 flatMap 中间数组', () => {
  const flatMap = Array.prototype.flatMap;
  let flatMapCalls = 0;
  Array.prototype.flatMap = function countedFlatMap(...args) {
    flatMapCalls++;
    return Reflect.apply(flatMap, this, args);
  };
  let credentials;
  try {
    credentials = configuredProviderCredentials({
      proxyUrl: '', zenProxyUrl: '',
      zenCredentials: [null, { id: 'valid', name: '有效', apiKey: 'key', proxyUrl: '' }, { apiKey: '' }]
    }, 'zen');
  } finally {
    Array.prototype.flatMap = flatMap;
  }
  assert.equal(flatMapCalls, 0);
  assert.deepEqual(credentials.map((credential) => credential.credentialId), ['config:valid']);
});
