import { normalizeProxyUrl } from './proxy.js';

export const MAX_PROVIDER_KEYS = 32;

export function environmentProviderCredentials(env, provider) {
  const name = provider === 'go' ? 'GO' : 'ZEN';
  const prefix = `OPENCODE_${name}`;
  const defaultProxy = normalizedProxy(env.OPENCODE_PROXY_URL, 'OPENCODE_PROXY_URL');
  const providerProxy = normalizedProxy(env[`${prefix}_PROXY_URL`], `${prefix}_PROXY_URL`) || defaultProxy;
  const listedKeys = parseList(env[`${prefix}_KEYS`], `${prefix}_KEYS`);
  const numberedKeys = numberedValues(env, `${prefix}_KEY_`);
  const keys = listedKeys.length ? listedKeys : numberedKeys.length ? numberedKeys.map((item) => item.value) : cleanSingle(env[`${prefix}_KEY`]);
  if (keys.length > MAX_PROVIDER_KEYS) throw new Error(`${prefix} 最多支持 ${MAX_PROVIDER_KEYS} 把环境变量密钥`);

  const listedProxies = parseList(env[`${prefix}_PROXY_URLS`], `${prefix}_PROXY_URLS`, true);
  const numberedProxies = new Map(numberedValues(env, `${prefix}_PROXY_URL_`, true).map((item) => [item.index, item.value]));
  return keys.map((apiKey, offset) => {
    if (apiKey.length > 4096) throw new Error(`${prefix} 第 ${offset + 1} 把密钥不能超过 4096 个字符`);
    const index = numberedKeys.length && !listedKeys.length ? numberedKeys[offset].index : offset + 1;
    const rawProxy = listedProxies[offset] ?? numberedProxies.get(index) ?? '';
    return {
      apiKey,
      proxyUrl: normalizedProxy(rawProxy, `${prefix} 第 ${offset + 1} 个代理`) || providerProxy,
      credentialId: `environment:${index}`
    };
  });
}

export function configuredProviderCredentials(config, provider, environmentPool = []) {
  if (environmentPool.length) return environmentPool;
  const ownProxy = provider === 'go' ? config.goProxyUrl : config.zenProxyUrl;
  return storedProviderCredentialEntries(config, provider).map((entry) => ({
    apiKey: entry.apiKey,
    proxyUrl: entry.proxyUrl || ownProxy || config.proxyUrl || '',
    credentialId: `config:${entry.id}`,
    credentialLabel: entry.name
  }));
}

export function storedProviderCredentialEntries(config, provider) {
  const field = provider === 'go' ? 'goCredentials' : 'zenCredentials';
  const listed = Array.isArray(config[field]) ? config[field] : [];
  if (listed.length > MAX_PROVIDER_KEYS) throw new Error(`${provider.toUpperCase()} 面板最多支持 ${MAX_PROVIDER_KEYS} 把密钥`);
  const entries = listed.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.apiKey !== 'string' || !entry.apiKey.trim()) return [];
    const id = typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ? entry.id : `slot-${index + 1}`;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 64) : `Key ${index + 1}`;
    return [{ id, name, apiKey: entry.apiKey.trim(), proxyUrl: normalizedProxy(entry.proxyUrl, `${provider.toUpperCase()} ${name} 代理`) }];
  });
  if (entries.length) return entries;
  const apiKey = String(provider === 'go' ? config.goKey || '' : config.zenKey || '').trim();
  if (!apiKey) return [];
  return [{
    id: `legacy-${provider}`,
    name: '默认 Key',
    apiKey,
    proxyUrl: normalizedProxy(provider === 'go' ? config.goProxyUrl : config.zenProxyUrl, `${provider.toUpperCase()} 默认 Key 代理`)
  }];
}

function numberedValues(env, prefix, allowEmpty = false) {
  return Object.entries(env)
    .flatMap(([name, raw]) => {
      if (!name.startsWith(prefix)) return [];
      const suffix = name.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) return [];
      const value = String(raw ?? '').trim();
      if (!value && !allowEmpty) return [];
      return [{ index: Number(suffix), value }];
    })
    .filter((item) => Number.isSafeInteger(item.index) && item.index > 0)
    .sort((left, right) => left.index - right.index);
}

function parseList(raw, name, allowEmpty = false) {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${name} 必须是有效的 JSON 数组，或使用逗号/换行分隔`); }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error(`${name} 必须是字符串数组`);
    return parsed.map((item) => item.trim()).filter((item) => allowEmpty || item);
  }
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter((item) => allowEmpty || item);
}

function cleanSingle(raw) {
  const value = String(raw ?? '').trim();
  return value ? [value] : [];
}

function normalizedProxy(raw, name) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.length > 2048) throw new Error(`${name} 不能超过 2048 个字符`);
  try { return normalizeProxyUrl(value); }
  catch (error) { throw new Error(`${name} 无效：${error.message}`); }
}
