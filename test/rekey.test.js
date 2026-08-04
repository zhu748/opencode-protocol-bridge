import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decryptConfig, encryptConfig } from '../src/secrets.js';

test('rekey 命令可原子轮换配置主密钥', async () => {
  const file = resolve(import.meta.dirname, `../data/rekey-${randomUUID()}.json`);
  const oldKey = 'old-integration-master-key';
  const newKey = 'new-integration-master-key';
  const source = {
    zenKey: 'secret-to-preserve', defaultProvider: 'zen',
    goCredentials: [{ id: 'go-main', name: 'Go 主力', apiKey: 'pool-secret-to-preserve', proxyUrl: 'socks5h://user:pass@proxy:1080' }]
  };
  await writeFile(file, JSON.stringify(encryptConfig(source, oldKey)), 'utf8');
  const child = spawn(process.execPath, ['scripts/rekey.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, CONFIG_FILE: file, OLD_CONFIG_ENCRYPTION_KEY: oldKey, CONFIG_ENCRYPTION_KEY: newKey },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(decryptConfig(stored, newKey), source);
    assert.doesNotMatch(JSON.stringify(stored), /secret-to-preserve|user:pass/);
    assert.throws(() => decryptConfig(stored, oldKey), /无法解密/);
  } finally {
    if (!child.killed && child.exitCode === null) child.kill();
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(`${file}.${child.pid}.rekey.tmp`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
