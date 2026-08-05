import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
