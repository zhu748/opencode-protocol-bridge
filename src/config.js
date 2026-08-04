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
    state.promptRewriteRules = migratePromptRules(state.promptRewriteRules);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { ...defaults };
  }
  return state;
}

export async function saveConfig(next) {
  const snapshot = structuredClone({ ...defaults, ...next, version: 1 });
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
