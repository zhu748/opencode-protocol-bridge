import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decryptConfig, encryptConfig } from '../src/secrets.js';

const configFile = resolve(process.env.CONFIG_FILE || 'data/config.json');
const oldKey = process.env.OLD_CONFIG_ENCRYPTION_KEY || '';
const newKey = process.env.CONFIG_ENCRYPTION_KEY || '';

if (!newKey || newKey.length < 16) throw new Error('请通过 CONFIG_ENCRYPTION_KEY 提供至少 16 个字符的新主密钥');

const parsed = JSON.parse(await readFile(configFile, 'utf8'));
const decrypted = decryptConfig(parsed, oldKey);
const encrypted = encryptConfig(decrypted, newKey);
const temporary = `${configFile}.${process.pid}.rekey.tmp`;
await writeFile(temporary, `${JSON.stringify(encrypted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await rename(temporary, configFile);
console.log(`配置主密钥轮换完成：${configFile}`);
