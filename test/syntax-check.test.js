import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';

const projectDir = resolve(import.meta.dirname, '..');

test('语法检查器会自动发现新增源码并报告失败文件', async () => {
  const name = `syntax-check-invalid-${randomUUID()}.mjs`;
  const fixture = resolve(projectDir, 'test-fixtures', name);
  await writeFile(fixture, 'export const broken = ;\n', 'utf8');
  try {
    const result = spawnSync(process.execPath, ['scripts/check-syntax.mjs'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 30_000
    });
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`语法检查失败：test-fixtures[\\\\/]${name}`));
  } finally {
    await unlink(fixture).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});

test('语法检查器不会把扫描后消失的临时源码误报为语法错误', async () => {
  const name = `zzzz-syntax-check-transient-${randomUUID()}.mjs`;
  const fixture = resolve(projectDir, 'test-fixtures', name);
  await writeFile(fixture, 'export const transient = true;\n', 'utf8');
  const child = spawn(process.execPath, ['scripts/check-syntax.mjs'], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await unlink(fixture).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0, stderr || stdout);
    assert.doesNotMatch(stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await unlink(fixture).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
