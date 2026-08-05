import { resolve } from 'node:path';
import { decryptConfig, encryptConfig } from '../src/secrets.js';
import { atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from '../src/file-io.js';

const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;

const configFile = resolve(process.env.CONFIG_FILE || 'data/config.json');
const oldKey = process.env.OLD_CONFIG_ENCRYPTION_KEY || '';
const newKey = process.env.CONFIG_ENCRYPTION_KEY || '';

if (!newKey || newKey.length < 16) throw new Error('请通过 CONFIG_ENCRYPTION_KEY 提供至少 16 个字符的新主密钥');

await cleanupAtomicTemporary(configFile);
const parsed = JSON.parse(await readUtf8FileLimited(configFile, MAX_CONFIG_FILE_BYTES, '配置文件'));
const decrypted = decryptConfig(parsed, oldKey);
const encrypted = encryptConfig(decrypted, newKey);
await atomicWriteFile(configFile, `${JSON.stringify(encrypted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`配置主密钥轮换完成：${configFile}`);
