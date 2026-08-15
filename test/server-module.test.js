import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

test('服务模块可导入而不会隐式监听端口，并支持进程内启动与停止', async () => {
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/server-module-${randomUUID()}.json`);
  const previous = Object.fromEntries(['HOST', 'PORT', 'CONFIG_FILE', 'CONFIG_ENCRYPTION_KEY'].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile,
    CONFIG_ENCRYPTION_KEY: 'server-module-test-master-key'
  });
  try {
    const module = await import('../src/server.js');
    assert.equal(module.server.listening, false);
    assert.equal(typeof module.startBridgeServer, 'function');
    assert.equal(typeof module.stopBridgeServer, 'function');
    await module.startBridgeServer();
    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).ok, true);
    await module.stopBridgeServer();
    assert.equal(module.server.listening, false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
