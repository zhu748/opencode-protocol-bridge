import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_HANDOFF_MODELS,
  configRevision,
  migrateImageHandoffDefaults,
  normalizeImageHandoffModels,
  normalizeModelRoutes,
  normalizeStoredConfig,
  publicConfig
} from '../src/config.js';
import { OPENCODE_GO_TEXT_ONLY_MODELS, OPENCODE_ZEN_TEXT_ONLY_MODELS } from '../src/model-capabilities.js';

test('配置修订号对同一快照稳定且不同快照互不复用', () => {
  const first = normalizeStoredConfig();
  const second = normalizeStoredConfig();
  assert.match(configRevision(first), /^[a-f0-9]{32}$/);
  assert.equal(configRevision(first), configRevision(first));
  assert.notEqual(configRevision(first), configRevision(second));
  assert.throws(() => configRevision(null), /配置快照无效/);
});

test('图片交接模型默认覆盖 Zen 与 Go 能力表中的纯文本模型', () => {
  assert.deepEqual(normalizeImageHandoffModels(), DEFAULT_IMAGE_HANDOFF_MODELS);
  assert.deepEqual(DEFAULT_IMAGE_HANDOFF_MODELS, [
    ...OPENCODE_ZEN_TEXT_ONLY_MODELS.map((model) => ({ provider: 'zen', model })),
    ...OPENCODE_GO_TEXT_ONLY_MODELS.map((model) => ({ provider: 'go', model }))
  ]);
  assert.deepEqual(new Set(DEFAULT_IMAGE_HANDOFF_MODELS.map((entry) => entry.provider)), new Set(['zen', 'go']));
  assert.equal(DEFAULT_IMAGE_HANDOFF_MODELS.length, 29);
  assert.ok(DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'zen' && entry.model === 'gpt-5.3-codex-spark'));
  assert.ok(DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'zen' && entry.model === 'north-mini-code-free'));
  assert.ok(!DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'zen' && entry.model === 'gemini-3.6-flash'));
  assert.ok(!DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'zen' && entry.model === 'claude-opus-4-8'));
  assert.ok(DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'go' && entry.model === 'qwen3.7-max'));
  assert.ok(DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'go' && entry.model === 'minimax-m2.7'));
  assert.ok(!DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'go' && entry.model === 'deepseek-v4-flash-free'));
  assert.ok(!DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'go' && entry.model === 'minimax-m3'));
  assert.ok(!DEFAULT_IMAGE_HANDOFF_MODELS.some((entry) => entry.provider === 'go' && entry.model === 'kimi-k3'));
});

test('旧版未修改的四项和十五项图片默认会迁移，自定义选择保持不变', () => {
  const legacy = ['zen', 'go'].flatMap((provider) => [
    { provider, model: 'deepseek-v4-flash' },
    { provider, model: 'deepseek-v4-flash-free' }
  ]).reverse();
  assert.deepEqual(migrateImageHandoffDefaults(legacy), DEFAULT_IMAGE_HANDOFF_MODELS);
  const previous = [
    { provider: 'zen', model: 'deepseek-v4-flash' },
    { provider: 'zen', model: 'deepseek-v4-flash-free' },
    ...[
      'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5', 'glm-5.1', 'glm-5.2',
      'hy3', 'hy3-preview', 'mimo-v2-pro', 'mimo-v2.5-pro', 'minimax-m2.5',
      'minimax-m2.7', 'qwen3.7-max'
    ].map((model) => ({ provider: 'go', model })),
    { provider: 'go', model: 'deepseek-v4-flash-free' }
  ].reverse();
  assert.equal(previous.length, 15);
  assert.deepEqual(migrateImageHandoffDefaults(previous), DEFAULT_IMAGE_HANDOFF_MODELS);
  const custom = [{ provider: 'go', model: 'custom-text-model' }];
  assert.deepEqual(migrateImageHandoffDefaults(custom), custom);
});

test('公开配置提供非敏感的 Zen 与 Go 协议和视觉能力表', () => {
  const exposed = publicConfig(normalizeStoredConfig());
  assert.equal(exposed.upstreamStreamIdleTimeoutMs, 300000);
  assert.equal(exposed.bridgeWebSearchEnabled, true);
  assert.equal(exposed.bridgeWebSearchProvider, 'auto');
  assert.deepEqual(exposed.goModelCapabilities['gpt-5.6-luna'], {
    protocol: 'responses', imageInput: true, inputModalities: ['text', 'image', 'pdf'], reasoning: true, toolCall: true, temperature: false,
    contextLimit: 1_050_000, inputLimit: 922_000, outputLimit: 128_000
  });
  assert.deepEqual(exposed.goModelCapabilities['minimax-m2.7'], {
    protocol: 'claude', imageInput: false, inputModalities: ['text'], reasoning: true, toolCall: true, temperature: true,
    contextLimit: 204_800, outputLimit: 131_072
  });
  assert.equal(exposed.zenModelCapabilities['gemini-3.6-flash'].protocol, 'gemini');
  assert.equal(exposed.zenModelCapabilities['gemini-3.6-flash'].imageInput, true);
  assert.equal(exposed.zenModelCapabilities['gpt-5.3-codex-spark'].imageInput, false);
});

test('公开配置按快照复用脱敏结果且与源配置深度隔离', () => {
  const config = normalizeStoredConfig({
    clientToken: 'abcdefghijklmnop',
    zenCredentials: [{ id: 'primary', name: '主力', apiKey: 'sensitive-provider-key', proxyUrl: 'http://user:password@127.0.0.1:7890' }],
    modelRoutes: { alias: { provider: 'zen', protocol: 'responses', upstreamModel: 'gpt-5.6-sol' } },
    imageHandoffModels: [{ provider: 'go', model: 'text-model' }],
    promptRewriteRules: [{ id: 'custom', name: '自定义', enabled: true, find: 'before', replace: 'after' }]
  });
  const first = publicConfig(config);
  const second = publicConfig(config);

  assert.strictEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.zenCredentials), true);
  assert.equal(Object.isFrozen(first.zenCredentials[0]), true);
  assert.equal(Object.isFrozen(first.modelRoutes), true);
  assert.equal(Object.isFrozen(first.modelRoutes.alias), true);
  assert.equal(Object.isFrozen(first.imageHandoffModels[0]), true);
  assert.equal(Object.isFrozen(first.promptRewriteRules[0]), true);
  assert.notStrictEqual(first.modelRoutes, config.modelRoutes);
  assert.notStrictEqual(first.imageHandoffModels, config.imageHandoffModels);
  assert.notStrictEqual(first.promptRewriteRules, config.promptRewriteRules);
  assert.equal(Object.isFrozen(config.modelRoutes), false);
  assert.equal(Object.isFrozen(config.imageHandoffModels), false);
  assert.equal(Object.isFrozen(config.promptRewriteRules), false);
  assert.throws(() => { first.modelRoutes.alias.protocol = 'chat'; }, TypeError);
  assert.equal(config.modelRoutes.alias.protocol, 'responses');
  assert.doesNotMatch(JSON.stringify(first), /sensitive-provider-key|password/);

  const changed = normalizeStoredConfig({ clientToken: 'qrstuvwxyzabcdef' });
  const changedPublic = publicConfig(changed);
  assert.notStrictEqual(changedPublic, first);
  assert.notEqual(changedPublic.revision, first.revision);
  assert.notEqual(changedPublic.clientToken, first.clientToken);
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
  assert.equal(config.upstreamStreamIdleTimeoutMs, 300000);
  assert.equal(config.persistLogs, false);
  assert.equal(config.statsRetentionDays, 7);
  assert.equal(config.bridgeWebSearchEnabled, true);
  assert.equal(config.bridgeWebSearchProvider, 'auto');
  assert.equal(config.keepAliveUrl, '');
  assert.equal(config.keepAliveIntervalSeconds, 60);
  assert.deepEqual(config.imageHandoffModels, DEFAULT_IMAGE_HANDOFF_MODELS);
  assert.notStrictEqual(config.imageHandoffModels, DEFAULT_IMAGE_HANDOFF_MODELS);
});

test('模型路由规范化拒绝修剪后重复、保留名称和非法控制字符', () => {
  assert.deepEqual(normalizeModelRoutes({ gemini: { provider: 'zen', protocol: 'gemini' } }), {
    gemini: { provider: 'zen', protocol: 'gemini' }
  });
  assert.throws(() => normalizeModelRoutes({ ' alias ': {}, alias: {} }), /名称重复/);
  assert.throws(() => normalizeModelRoutes(JSON.parse('{"__proto__":{}}')), /不允许使用/);
  assert.throws(() => normalizeModelRoutes({ 'bad\nmodel': {} }), /格式无效/);
  assert.throws(() => normalizeModelRoutes({ model: { upstreamModel: 'bad\tmodel' } }), /upstreamModel 无效/);
});

test('持久化配置拒绝错误类型、越界值和未知版本', () => {
  assert.throws(() => normalizeStoredConfig({ version: 2 }), /不支持的配置版本/);
  assert.throws(() => normalizeStoredConfig({ maxConcurrentRequests: '20' }), /最大并发请求必须是 1–1000 的整数/);
  assert.throws(() => normalizeStoredConfig({ upstreamTimeoutMs: 0 }), /上游超时必须是 1000–600000 的整数/);
  assert.equal(normalizeStoredConfig({ upstreamStreamIdleTimeoutMs: 0 }).upstreamStreamIdleTimeoutMs, 0);
  assert.throws(() => normalizeStoredConfig({ upstreamStreamIdleTimeoutMs: 999 }), /上游流空闲超时必须是 0 或 1000–3600000 的整数/);
  assert.throws(() => normalizeStoredConfig({ persistLogs: 'false' }), /日志持久化开关必须是布尔值/);
  assert.throws(() => normalizeStoredConfig({ statsRetentionDays: 0 }), /统计保留天数必须是 1–365 的整数/);
  assert.throws(() => normalizeStoredConfig({ bridgeWebSearchEnabled: 'false' }), /本地 Web Search 开关必须是布尔值/);
  assert.throws(() => normalizeStoredConfig({ bridgeWebSearchProvider: 'other' }), /本地 Web Search 提供方仅支持 auto 或 exa 或 parallel/);
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
