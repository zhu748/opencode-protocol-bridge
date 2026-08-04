import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:v1:';
const SENSITIVE_FIELDS = ['clientToken', 'zenKey', 'goKey', 'sessionSecret', 'proxyUrl', 'zenProxyUrl', 'goProxyUrl'];
const SENSITIVE_COLLECTIONS = ['zenCredentials', 'goCredentials'];

function keyFromPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 16) throw new Error('CONFIG_ENCRYPTION_KEY 至少需要 16 个字符');
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

export function encryptValue(value, passphrase, field = 'value') {
  if (!value) return value;
  if (typeof value !== 'string') throw new Error(`配置字段 ${field} 必须是字符串`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromPassphrase(passphrase), iv);
  cipher.setAAD(Buffer.from(`opencode-bridge:${field}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptValue(value, passphrase, field = 'value') {
  if (value?.startsWith(PLAIN_PREFIX)) {
    const encoded = value.slice(PLAIN_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`配置字段 ${field} 的明文转义格式无效`);
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error(`配置字段 ${field} 的明文转义格式无效`);
    return decoded.toString('utf8');
  }
  if (!value?.startsWith(PREFIX)) return value;
  if (!passphrase) throw new Error(`配置字段 ${field} 已加密，但未设置 CONFIG_ENCRYPTION_KEY`);
  const [, version, ivText, tagText, encryptedText] = value.split(':');
  if (version !== 'v1' || !ivText || !tagText || encryptedText === undefined) throw new Error(`配置字段 ${field} 的密文格式无效`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFromPassphrase(passphrase), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(`opencode-bridge:${field}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(`无法解密配置字段 ${field}，请检查 CONFIG_ENCRYPTION_KEY：${error.message}`);
  }
}

export function encryptConfig(config, passphrase) {
  const result = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (!Object.hasOwn(result, field)) continue;
    result[field] = encryptStoredValue(result[field], passphrase, field);
  }
  transformCredentialCollections(result, (value, field) => encryptStoredValue(value, passphrase, field));
  return result;
}

export function decryptConfig(config, passphrase) {
  const result = { ...config };
  for (const field of SENSITIVE_FIELDS) if (Object.hasOwn(result, field)) result[field] = decryptValue(result[field], passphrase, field);
  transformCredentialCollections(result, (value, field) => decryptValue(value, passphrase, field));
  return result;
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

function encryptStoredValue(value, passphrase, field) {
  if (passphrase) return encryptValue(value, passphrase, field);
  if (typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(PLAIN_PREFIX))) {
    return `${PLAIN_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}`;
  }
  return value;
}
