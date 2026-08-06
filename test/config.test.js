import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_HANDOFF_MODELS,
  configRevision,
  normalizeImageHandoffModels,
  normalizeModelRoutes,
  normalizeStoredConfig
} from '../src/config.js';

test('配置修订号对同一快照稳定且不同快照互不复用', () => {
  const first = normalizeStoredConfig();
  const second = normalizeStoredConfig();
  assert.match(configRevision(first), /^[a-f0-9]{32}$/);
  assert.equal(configRevision(first), configRevision(first));
  assert.notEqual(configRevision(first), configRevision(second));
  assert.throws(() => configRevision(null), /配置快照无效/);
});

test('图片交接模型默认覆盖 Zen/Go 的两个 DeepSeek V4 Flash 型号', () => {
  assert.deepEqual(normalizeImageHandoffModels(), DEFAULT_IMAGE_HANDOFF_MODELS);
  assert.deepEqual(new Set(DEFAULT_IMAGE_HANDOFF_MODELS.map((entry) => entry.provider)), new Set(['zen', 'go']));
  assert.equal(DEFAULT_IMAGE_HANDOFF_MODELS.length, 4);
});

test('图片交接模型配置规范化并拒绝重复或非法项', () => {
  assert.deepEqual(normalizeImageHandoffModels([{ provider: ' GO ', model: ' custom-model ' }]), [{ provider: 'go', model: 'custom-model' }]);
  assert.throws(() => normalizeImageHandoffModels('go/model'), /必须是数组/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'other', model: 'm' }]), /provider 无效/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'go', model: '' }]), /model 无效/);
  assert.throws(() => normalizeImageHandoffModels([{ provider: 'go', model: 'bad\nmodel' }]), /model 无效/);
  assert.throws(() => normalizeImageHandoffModels([
    { provider: 'go', model: 'Model-A' },
    { provider: 'go', model: 'model-a' }
  ]), /重复/);
});

test('旧版部分配置会补齐默认字段并规范化模型路由和 Key 池', () => {
  const config = normalizeStoredConfig({
    zenKey: ' legacy-key ',
    zenCredentials: [{ apiKey: ' pooled-key ', proxyUrl: '' }],
    modelRoutes: {
      ' alias-model ': {
        provider: 'go',
        protocol: 'chat',
        upstreamModel: ' upstream-model ',
        ignored: true
      }
    }
  });

  assert.equal(config.version, 1);
  assert.equal(config.zenKey, 'legacy-key');
  assert.deepEqual(config.zenCredentials, [{ id: 'slot-1', name: 'Key 1', apiKey: 'pooled-key', proxyUrl: '' }]);
  assert.deepEqual(config.modelRoutes, {
    'alias-model': { provider: 'go', protocol: 'chat', upstreamModel: 'upstream-model' }
  });
  assert.equal(config.maxConcurrentRequests, 20);
  assert.equal(config.upstreamTimeoutMs, 120000);
  assert.equal(config.persistLogs, false);
  assert.equal(config.keepAliveUrl, '');
  assert.equal(config.keepAliveIntervalSeconds, 60);
  assert.deepEqual(config.imageHandoffModels, DEFAULT_IMAGE_HANDOFF_MODELS);
  assert.notStrictEqual(config.imageHandoffModels, DEFAULT_IMAGE_HANDOFF_MODELS);
});

test('模型路由规范化拒绝修剪后重复、保留名称和非法控制字符', () => {
  assert.throws(() => normalizeModelRoutes({ ' alias ': {}, alias: {} }), /名称重复/);
  assert.throws(() => normalizeModelRoutes(JSON.parse('{"__proto__":{}}')), /不允许使用/);
  assert.throws(() => normalizeModelRoutes({ 'bad\nmodel': {} }), /格式无效/);
  assert.throws(() => normalizeModelRoutes({ model: { upstreamModel: 'bad\tmodel' } }), /upstreamModel 无效/);
});

test('持久化配置拒绝错误类型、越界值和未知版本', () => {
  assert.throws(() => normalizeStoredConfig({ version: 2 }), /不支持的配置版本/);
  assert.throws(() => normalizeStoredConfig({ maxConcurrentRequests: '20' }), /最大并发请求必须是 1–1000 的整数/);
  assert.throws(() => normalizeStoredConfig({ upstreamTimeoutMs: 0 }), /上游超时必须是 1000–600000 的整数/);
  assert.throws(() => normalizeStoredConfig({ persistLogs: 'false' }), /日志持久化开关必须是布尔值/);
  assert.throws(() => normalizeStoredConfig({ keepAliveUrl: 'file:///tmp/test' }), /仅支持 HTTP 或 HTTPS/);
  assert.throws(() => normalizeStoredConfig({ keepAliveIntervalSeconds: 4 }), /保活间隔必须是 5–86400 的整数/);
  assert.throws(() => normalizeStoredConfig({ modelRoutes: null }), /模型路由必须是 JSON 对象/);
  assert.throws(() => normalizeStoredConfig({ zenCredentials: [{ apiKey: 'a' }, { apiKey: 'b', id: 'slot-1' }] }), /Key ID 重复/);
});

test('命名客户端会规范化时间和缺省并发，并拒绝重复名称', () => {
  const client = {
    id: '0123456789abcdef',
    name: ' Automation ',
    tokenHash: 'a'.repeat(43),
    tokenPrefix: 'ocb123',
    createdAt: '2026-08-05T08:00:00+08:00'
  };
  const config = normalizeStoredConfig({ maxConcurrentRequests: 37, apiClients: [client] });
  assert.deepEqual(config.apiClients[0], {
    ...client,
    name: 'Automation',
    enabled: true,
    maxConcurrentRequests: 37,
    createdAt: '2026-08-05T00:00:00.000Z'
  });
  assert.throws(() => normalizeStoredConfig({ apiClients: [
    client,
    { ...client, id: 'fedcba9876543210', name: 'automation' }
  ] }), /客户端名称重复/);
});
