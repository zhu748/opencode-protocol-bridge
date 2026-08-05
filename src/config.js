import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptConfig, encryptConfig } from './secrets.js';
import { DEFAULT_PROMPT_REWRITE_RULES, migratePromptRules } from './prompt-rewrite.js';
import { storedProviderCredentialEntries } from './provider-credentials.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = process.env.CONFIG_FILE || resolve(ROOT, 'data', 'config.json');
const ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || '';
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

let state;
let saveQueue = Promise.resolve();

export async function loadConfig() {
  if (state) return state;
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    state = { ...defaults, ...decryptConfig(parsed, ENCRYPTION_KEY) };
    state.imageHandoffModels = normalizeImageHandoffModels(state.imageHandoffModels);
    state.promptRewriteRules = migratePromptRules(state.promptRewriteRules);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { ...defaults };
  }
  return state;
}

export async function saveConfig(next) {
  const snapshot = structuredClone({ ...defaults, ...next, version: 1 });
  snapshot.imageHandoffModels = normalizeImageHandoffModels(snapshot.imageHandoffModels);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await persist(snapshot);
    state = snapshot;
  });
  await saveQueue;
  return snapshot;
}

export async function updateConfig(mutator) {
  await loadConfig();
  let snapshot;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const next = await mutator(structuredClone(state));
    snapshot = structuredClone({ ...defaults, ...next, version: 1 });
    snapshot.imageHandoffModels = normalizeImageHandoffModels(snapshot.imageHandoffModels);
    await persist(snapshot);
    state = snapshot;
  });
  await saveQueue;
  return snapshot;
}

async function persist(snapshot) {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  const temporary = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  const stored = encryptConfig(snapshot, ENCRYPTION_KEY);
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, CONFIG_FILE);
}

export function publicConfig(config) {
  const mask = (value) => {
    if (!value) return '';
    if (value.length <= 8) return '••••';
    if (value.length <= 12) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  };
  const maskProxy = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.username || url.password ? '••••@' : ''}${url.host}`;
    } catch { return '••••'; }
  };
  const zenCredentials = storedProviderCredentialEntries(config, 'zen');
  const goCredentials = storedProviderCredentialEntries(config, 'go');
  return {
    configured: Boolean(config.password),
    encryptionEnabled: Boolean(ENCRYPTION_KEY),
    clientToken: mask(config.clientToken),
    zenKey: mask(zenCredentials[0]?.apiKey || ''),
    goKey: mask(goCredentials[0]?.apiKey || ''),
    zenCredentials: zenCredentials.map((entry) => ({ id: entry.id, name: entry.name, apiKey: mask(entry.apiKey), proxyUrl: maskProxy(entry.proxyUrl), proxyConfigured: Boolean(entry.proxyUrl) })),
    goCredentials: goCredentials.map((entry) => ({ id: entry.id, name: entry.name, apiKey: mask(entry.apiKey), proxyUrl: maskProxy(entry.proxyUrl), proxyConfigured: Boolean(entry.proxyUrl) })),
    proxyUrl: maskProxy(config.proxyUrl),
    zenProxyUrl: maskProxy(config.zenProxyUrl),
    goProxyUrl: maskProxy(config.goProxyUrl),
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
