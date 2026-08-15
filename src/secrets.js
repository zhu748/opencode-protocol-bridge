import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const V2_PREFIX = 'enc:v2:';
const V1_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:v1:';
const SENSITIVE_FIELDS = ['clientToken', 'zenKey', 'goKey', 'sessionSecret', 'proxyUrl', 'zenProxyUrl', 'goProxyUrl'];
const SENSITIVE_COLLECTIONS = ['zenCredentials', 'goCredentials'];
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function assertPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 16) throw new Error('CONFIG_ENCRYPTION_KEY 至少需要 16 个字符');
}

function legacyKeyFromPassphrase(passphrase) {
  assertPassphrase(passphrase);
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

function keyFromPassphrase(passphrase, salt) {
  assertPassphrase(passphrase);
  return scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
}

function encryptedValue(value, key, salt, field) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`opencode-bridge:v2:${field}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V2_PREFIX}${salt.toString('base64url')}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function encryptValue(value, passphrase, field = 'value') {
  if (!value) return value;
  if (typeof value !== 'string') throw new Error(`配置字段 ${field} 必须是字符串`);
  const salt = randomBytes(16);
  return encryptedValue(value, keyFromPassphrase(passphrase, salt), salt, field);
}

export function decryptValue(value, passphrase, field = 'value', keyCache = new Map()) {
  if (value?.startsWith(PLAIN_PREFIX)) return decodePlainValue(value, field);
  if (!value?.startsWith(V1_PREFIX) && !value?.startsWith(V2_PREFIX)) return value;
  if (!passphrase) throw new Error(`配置字段 ${field} 已加密，但未设置 CONFIG_ENCRYPTION_KEY`);
  try {
    if (value.startsWith(V2_PREFIX)) return decryptV2Value(value, passphrase, field, keyCache);
    return decryptV1Value(value, passphrase, field);
  } catch (error) {
    throw new Error(`无法解密配置字段 ${field}，请检查 CONFIG_ENCRYPTION_KEY：${error.message}`);
  }
}

export function encryptConfig(config, passphrase) {
  const result = { ...config };
  let transform;
  if (passphrase) {
    const salt = randomBytes(16);
    const key = keyFromPassphrase(passphrase, salt);
    transform = (value, field) => {
      if (!value) return value;
      if (typeof value !== 'string') throw new Error(`配置字段 ${field} 必须是字符串`);
      return encryptedValue(value, key, salt, field);
    };
  } else {
    transform = (value) => escapeStoredPlaintext(value);
  }
  for (const field of SENSITIVE_FIELDS) {
    if (!Object.hasOwn(result, field)) continue;
    result[field] = transform(result[field], field);
  }
  transformCredentialCollections(result, transform);
  return result;
}

export function decryptConfig(config, passphrase) {
  const result = { ...config };
  const keyCache = new Map();
  const transform = (value, field) => decryptValue(value, passphrase, field, keyCache);
  for (const field of SENSITIVE_FIELDS) if (Object.hasOwn(result, field)) result[field] = transform(result[field], field);
  transformCredentialCollections(result, transform);
  return result;
}

function decryptV2Value(value, passphrase, field, keyCache) {
  const parts = value.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== 'v2') throw new Error('密文格式无效');
  const salt = decodeBase64Url(parts[2], 16, '盐');
  const iv = decodeBase64Url(parts[3], 12, 'IV');
  const tag = decodeBase64Url(parts[4], 16, '认证标签');
  const encrypted = decodeBase64Url(parts[5], null, '密文');
  let key = keyCache.get(parts[2]);
  if (!key) {
    key = keyFromPassphrase(passphrase, salt);
    keyCache.set(parts[2], key);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`opencode-bridge:v2:${field}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function decryptV1Value(value, passphrase, field) {
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('密文格式无效');
  const iv = decodeBase64Url(parts[2], 12, 'IV');
  const tag = decodeBase64Url(parts[3], 16, '认证标签');
  const encrypted = decodeBase64Url(parts[4], null, '密文');
  const decipher = createDecipheriv('aes-256-gcm', legacyKeyFromPassphrase(passphrase), iv);
  decipher.setAAD(Buffer.from(`opencode-bridge:${field}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function decodePlainValue(value, field) {
  const encoded = value.slice(PLAIN_PREFIX.length);
  try {
    return decodeBase64Url(encoded, null, '明文转义').toString('utf8');
  } catch {
    throw new Error(`配置字段 ${field} 的明文转义格式无效`);
  }
}

function decodeBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label}格式无效`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedBytes !== null && decoded.length !== expectedBytes)) {
    throw new Error(`${label}格式无效`);
  }
  return decoded;
}

function transformCredentialCollections(config, transform) {
  for (const collection of SENSITIVE_COLLECTIONS) {
    if (!Array.isArray(config[collection])) continue;
    config[collection] = config[collection].map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const identity = typeof entry.id === 'string' && entry.id ? entry.id : String(index + 1);
      return {
        ...entry,
        ...(Object.hasOwn(entry, 'apiKey') ? { apiKey: transform(entry.apiKey, `${collection}.${identity}.apiKey`) } : {}),
        ...(Object.hasOwn(entry, 'proxyUrl') ? { proxyUrl: transform(entry.proxyUrl, `${collection}.${identity}.proxyUrl`) } : {})
      };
    });
  }
}

function escapeStoredPlaintext(value) {
  if (typeof value === 'string' && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX) || value.startsWith(PLAIN_PREFIX))) {
    return `${PLAIN_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}`;
  }
  return value;
}
