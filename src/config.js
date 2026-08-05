import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptConfig, encryptConfig } from './secrets.js';
import { DEFAULT_PROMPT_REWRITE_RULES, migratePromptRules, normalizePromptRules } from './prompt-rewrite.js';
import { storedProviderCredentialEntries } from './provider-credentials.js';
import { maskProxyUrl, normalizeProxyUrl } from './proxy.js';
import { atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from './file-io.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.CONFIG_FILE || resolve(ROOT, 'data', 'config.json');
const ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || '';
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
if (ENCRYPTION_KEY && ENCRYPTION_KEY.length < 16) throw new Error('CONFIG_ENCRYPTION_KEY 至少需要 16 个字符');

export const DEFAULT_IMAGE_HANDOFF_MODELS = Object.freeze(['zen', 'go'].flatMap((provider) => [
  { provider, model: 'deepseek-v4-flash' },
  { provider, model: 'deepseek-v4-flash-free' }
]));

export function normalizeImageHandoffModels(value = DEFAULT_IMAGE_HANDOFF_MODELS) {
  if (!Array.isArray(value)) throw new Error('图片交接模型必须是数组');
  if (value.length > 500) throw new Error('图片交接模型不能超过 500 个');
  const seen = new Set();
  return value.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error(`图片交接模型第 ${index + 1} 项格式无效`);
    const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
    const model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!['zen', 'go'].includes(provider)) throw new Error(`图片交接模型第 ${index + 1} 项 provider 无效`);
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error(`图片交接模型第 ${index + 1} 项 model 无效`);
    const key = `${provider}\n${model.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`图片交接模型重复：${provider}/${model}`);
    seen.add(key);
    return { provider, model };
  });
}

const defaults = {
  version: 1,
  password: null,
  sessionSecret: null,
  clientToken: '',
  zenKey: '',
  goKey: '',
  zenCredentials: [],
  goCredentials: [],
  proxyUrl: '',
  zenProxyUrl: '',
  goProxyUrl: '',
  defaultProvider: 'zen',
  modelRoutes: {},
  imageHandoffModels: DEFAULT_IMAGE_HANDOFF_MODELS,
  promptRewriteRules: DEFAULT_PROMPT_REWRITE_RULES,
  requestLogLimit: 100,
  upstreamTimeoutMs: 120000,
  maxConcurrentRequests: 20,
  persistLogs: false,
  apiClients: []
};

export function normalizeModelRoutes(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw configError('模型路由必须是 JSON 对象');
  const entries = Object.entries(value);
  if (entries.length > 500) throw configError('模型路由不能超过 500 条');
  const routes = {};
  const models = new Set();
  for (const [rawModel, route] of entries) {
    const model = rawModel.trim();
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model) || !route || Array.isArray(route) || typeof route !== 'object') {
      throw configError(`模型路由 ${model || '(空)'} 格式无效`);
    }
    if (['__proto__', 'prototype', 'constructor'].includes(model)) throw configError(`模型路由名称 ${model} 不允许使用`);
    if (models.has(model)) throw configError(`模型路由名称重复：${model}`);
    models.add(model);
    const provider = route.provider === undefined || route.provider === '' ? undefined : route.provider;
    const protocol = route.protocol === undefined || route.protocol === '' ? undefined : route.protocol;
    if (provider !== undefined && !['zen', 'go'].includes(provider)) throw configError(`模型 ${model} 的 provider 无效`);
    if (protocol !== undefined && !['auto', 'claude', 'responses', 'chat'].includes(protocol)) throw configError(`模型 ${model} 的 protocol 无效`);
    let upstreamModel;
    if (route.upstreamModel !== undefined) {
      if (typeof route.upstreamModel !== 'string') throw configError(`模型 ${model} 的 upstreamModel 无效`);
      upstreamModel = route.upstreamModel.trim();
      if (!upstreamModel || upstreamModel.length > 256 || /[\u0000-\u001f\u007f]/.test(upstreamModel)) throw configError(`模型 ${model} 的 upstreamModel 无效`);
    }
    if (route.toolChoiceFallback !== undefined && route.toolChoiceFallback !== 'auto') throw configError(`模型 ${model} 的 toolChoiceFallback 无效`);
    routes[model] = {
      ...(provider ? { provider } : {}),
      ...(protocol ? { protocol } : {}),
      ...(upstreamModel ? { upstreamModel } : {}),
      ...(route.toolChoiceFallback ? { toolChoiceFallback: route.toolChoiceFallback } : {})
    };
  }
  return routes;
}

export function normalizeStoredConfig(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw configError('配置文件根节点必须是 JSON 对象');
  if (value.version !== undefined && value.version !== 1) throw configError(`不支持的配置版本：${String(value.version)}`);
  const source = { ...defaults, ...value };
  const maxConcurrentRequests = configInteger(source.maxConcurrentRequests, '最大并发请求', 1, 1000);
  return {
    version: 1,
    password: nullableConfigString(source.password, '管理密码摘要', 512),
    sessionSecret: nullableConfigString(source.sessionSecret, '会话密钥', 512),
    clientToken: configString(source.clientToken, '主访问令牌', 256, { allowEmpty: true, pattern: /^(?:[A-Za-z0-9]{6,256})?$/ }),
    zenKey: configString(source.zenKey, 'Zen Key', 4096, { allowEmpty: true, trim: true }),
    goKey: configString(source.goKey, 'Go Key', 4096, { allowEmpty: true, trim: true }),
    zenCredentials: normalizeCredentialCollection(source.zenCredentials, 'ZEN'),
    goCredentials: normalizeCredentialCollection(source.goCredentials, 'GO'),
    proxyUrl: normalizeConfigProxy(source.proxyUrl, '默认代理'),
    zenProxyUrl: normalizeConfigProxy(source.zenProxyUrl, 'Zen 代理'),
    goProxyUrl: normalizeConfigProxy(source.goProxyUrl, 'Go 代理'),
    defaultProvider: configEnum(source.defaultProvider, '默认提供方', ['zen', 'go']),
    modelRoutes: normalizeModelRoutes(source.modelRoutes),
    imageHandoffModels: normalizeWithConfigError(() => normalizeImageHandoffModels(source.imageHandoffModels)),
    promptRewriteRules: normalizeWithConfigError(() => normalizePromptRules(migratePromptRules(source.promptRewriteRules))),
    requestLogLimit: configInteger(source.requestLogLimit, '日志保留条数', 10, 1000),
    upstreamTimeoutMs: configInteger(source.upstreamTimeoutMs, '上游超时', 1000, 600000),
    maxConcurrentRequests,
    persistLogs: configBoolean(source.persistLogs, '日志持久化开关'),
    apiClients: normalizeApiClients(source.apiClients, maxConcurrentRequests)
  };
}

let state;
let saveQueue = Promise.resolve();
const revisions = new WeakMap();

export function configRevision(config) {
  if (!config || typeof config !== 'object') throw new TypeError('配置快照无效');
  let revision = revisions.get(config);
  if (!revision) {
    revision = randomBytes(16).toString('hex');
    revisions.set(config, revision);
  }
  return revision;
}

export async function loadConfig() {
  if (state) return state;
  try {
    await cleanupAtomicTemporary(CONFIG_FILE);
    const parsed = JSON.parse(await readUtf8FileLimited(CONFIG_FILE, MAX_CONFIG_FILE_BYTES, '配置文件'));
    state = normalizeStoredConfig(decryptConfig(parsed, ENCRYPTION_KEY));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = normalizeStoredConfig();
  }
  return state;
}

export async function saveConfig(next) {
  const snapshot = normalizeStoredConfig(structuredClone({ ...defaults, ...next }));
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await persist(snapshot);
    state = snapshot;
  });
  await saveQueue;
  return snapshot;
}

export async function updateConfig(mutator, { expectedRevision } = {}) {
  await loadConfig();
  let snapshot;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (expectedRevision !== undefined && expectedRevision !== configRevision(state)) {
      throw Object.assign(new Error('配置已被其他页面修改，请刷新后重新确认'), {
        status: 412,
        code: 'CONFIG_PRECONDITION_FAILED'
      });
    }
    const next = await mutator(structuredClone(state));
    snapshot = normalizeStoredConfig(structuredClone({ ...defaults, ...next }));
    await persist(snapshot);
    state = snapshot;
  });
  await saveQueue;
  return snapshot;
}

async function persist(snapshot) {
  const stored = encryptConfig(snapshot, ENCRYPTION_KEY);
  const serialized = `${JSON.stringify(stored, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_FILE_BYTES) {
    throw Object.assign(new Error('配置序列化后超过 2 MiB 安全上限'), { status: 413, code: 'CONFIG_TOO_LARGE' });
  }
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await atomicWriteFile(CONFIG_FILE, serialized, { encoding: 'utf8', mode: 0o600 });
}

export function publicConfig(config) {
  const mask = (value) => {
    if (!value) return '';
    if (value.length <= 8) return '••••';
    if (value.length <= 12) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  };
  const zenCredentials = storedProviderCredentialEntries(config, 'zen');
  const goCredentials = storedProviderCredentialEntries(config, 'go');
  return {
    revision: configRevision(config),
    configured: Boolean(config.password),
    encryptionEnabled: Boolean(ENCRYPTION_KEY),
    clientToken: mask(config.clientToken),
    zenKey: mask(zenCredentials[0]?.apiKey || ''),
    goKey: mask(goCredentials[0]?.apiKey || ''),
    zenCredentials: zenCredentials.map((entry) => ({ id: entry.id, name: entry.name, apiKey: mask(entry.apiKey), proxyUrl: maskProxyUrl(entry.proxyUrl), proxyConfigured: Boolean(entry.proxyUrl) })),
    goCredentials: goCredentials.map((entry) => ({ id: entry.id, name: entry.name, apiKey: mask(entry.apiKey), proxyUrl: maskProxyUrl(entry.proxyUrl), proxyConfigured: Boolean(entry.proxyUrl) })),
    proxyUrl: maskProxyUrl(config.proxyUrl),
    zenProxyUrl: maskProxyUrl(config.zenProxyUrl),
    goProxyUrl: maskProxyUrl(config.goProxyUrl),
    proxyConfigured: Boolean(config.proxyUrl),
    zenProxyConfigured: Boolean(config.zenProxyUrl) || zenCredentials.some((entry) => entry.proxyUrl),
    goProxyConfigured: Boolean(config.goProxyUrl) || goCredentials.some((entry) => entry.proxyUrl),
    defaultProvider: config.defaultProvider,
    modelRoutes: config.modelRoutes,
    imageHandoffModels: normalizeImageHandoffModels(config.imageHandoffModels),
    promptRewriteRules: config.promptRewriteRules,
    promptRewriteDefaults: DEFAULT_PROMPT_REWRITE_RULES,
    requestLogLimit: config.requestLogLimit,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests,
    persistLogs: config.persistLogs,
    clientCount: Array.isArray(config.apiClients) ? config.apiClients.length : 0
  };
}

export { ROOT };

function normalizeCredentialCollection(value, provider) {
  if (!Array.isArray(value)) throw configError(`${provider} Key 列表必须是数组`);
  if (value.length > 32) throw configError(`${provider} 面板最多支持 32 把密钥`);
  const ids = new Set();
  const names = new Set();
  return value.map((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw configError(`${provider} 第 ${index + 1} 把 Key 格式无效`);
    const id = configString(entry.id ?? `slot-${index + 1}`, `${provider} 第 ${index + 1} 把 Key ID`, 64, { pattern: /^[A-Za-z0-9_-]{1,64}$/ });
    const name = configString(entry.name ?? `Key ${index + 1}`, `${provider} 第 ${index + 1} 把 Key 名称`, 64, { trim: true, pattern: /^[^\u0000-\u001f\u007f]{1,64}$/ });
    const apiKey = configString(entry.apiKey, `${provider} 第 ${index + 1} 把 API Key`, 4096, { trim: true });
    if (!apiKey) throw configError(`${provider} 第 ${index + 1} 把 API Key 不能为空`);
    const normalizedName = name.toLocaleLowerCase();
    if (ids.has(id)) throw configError(`${provider} Key ID 重复：${id}`);
    if (names.has(normalizedName)) throw configError(`${provider} Key 名称重复：${name}`);
    ids.add(id);
    names.add(normalizedName);
    return { id, name, apiKey, proxyUrl: normalizeConfigProxy(entry.proxyUrl ?? '', `${provider} ${name} 代理`) };
  });
}

function normalizeApiClients(value, fallbackConcurrency) {
  if (!Array.isArray(value)) throw configError('命名客户端列表必须是数组');
  if (value.length > 100) throw configError('命名客户端不能超过 100 个');
  const ids = new Set();
  const names = new Set();
  return value.map((client, index) => {
    if (!client || Array.isArray(client) || typeof client !== 'object') throw configError(`命名客户端第 ${index + 1} 项格式无效`);
    const id = configString(client.id, `命名客户端第 ${index + 1} 项 ID`, 16, { pattern: /^[a-f0-9]{16}$/ });
    const name = configString(client.name, `命名客户端第 ${index + 1} 项名称`, 64, { trim: true, pattern: /^[^\u0000-\u001f\u007f]{1,64}$/ });
    const tokenHash = configString(client.tokenHash, `命名客户端 ${name} 的令牌摘要`, 43, { pattern: /^[A-Za-z0-9_-]{43}$/ });
    const tokenPrefix = configString(client.tokenPrefix, `命名客户端 ${name} 的令牌前缀`, 32, { pattern: /^[A-Za-z0-9_-]{1,32}$/ });
    const createdAt = configString(client.createdAt, `命名客户端 ${name} 的创建时间`, 64);
    if (!Number.isFinite(Date.parse(createdAt))) throw configError(`命名客户端 ${name} 的创建时间无效`);
    const normalizedName = name.toLocaleLowerCase();
    if (ids.has(id)) throw configError(`命名客户端 ID 重复：${id}`);
    if (names.has(normalizedName)) throw configError(`命名客户端名称重复：${name}`);
    ids.add(id);
    names.add(normalizedName);
    return {
      id, name, tokenHash, tokenPrefix,
      enabled: client.enabled === undefined ? true : configBoolean(client.enabled, `命名客户端 ${name} 的 enabled`),
      maxConcurrentRequests: client.maxConcurrentRequests === undefined
        ? fallbackConcurrency
        : configInteger(client.maxConcurrentRequests, `命名客户端 ${name} 的并发上限`, 1, 1000),
      createdAt: new Date(createdAt).toISOString()
    };
  });
}

function configString(value, label, maximum, { allowEmpty = false, trim = false, pattern } = {}) {
  if (typeof value !== 'string') throw configError(`${label}必须是字符串`);
  const normalized = trim ? value.trim() : value;
  if ((!allowEmpty && !normalized) || normalized.length > maximum || (pattern && !pattern.test(normalized))) throw configError(`${label}格式无效`);
  return normalized;
}

function nullableConfigString(value, label, maximum) {
  if (value === null) return null;
  return configString(value, label, maximum);
}

function configInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw configError(`${label}必须是 ${minimum}–${maximum} 的整数`);
  return value;
}

function configBoolean(value, label) {
  if (typeof value !== 'boolean') throw configError(`${label}必须是布尔值`);
  return value;
}

function configEnum(value, label, allowed) {
  if (!allowed.includes(value)) throw configError(`${label}仅支持 ${allowed.join(' 或 ')}`);
  return value;
}

function normalizeConfigProxy(value, label) {
  const proxy = configString(value, label, 4096, { allowEmpty: true, trim: true });
  try { return normalizeProxyUrl(proxy); }
  catch (error) { throw configError(`${label}无效：${error.message}`); }
}

function normalizeWithConfigError(operation) {
  try { return operation(); }
  catch (error) { throw configError(error.message); }
}

function configError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_CONFIG' });
}
