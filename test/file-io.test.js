import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicTemporaryPath, atomicWriteFile, cleanupAtomicTemporary, readUtf8FileLimited } from '../src/file-io.js';

test('有界文件读取在精确上限内成功并拒绝额外字节', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-file-read-test-'));
  const file = join(directory, 'data.json');
  try {
    await writeFile(file, '你好', 'utf8');
    assert.equal(await readUtf8FileLimited(file, 6, '测试文件'), '你好');
    await assert.rejects(
      readUtf8FileLimited(file, 5, '测试文件'),
      (error) => error.code === 'FILE_TOO_LARGE' && error.maxBytes === 5 && /测试文件/.test(error.message)
    );
    await writeFile(file, Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    await assert.rejects(
      readUtf8FileLimited(file, 6, '测试文件'),
      (error) => error.code === 'FILE_INVALID_UTF8' && error.message === '测试文件不是有效的 UTF-8 文件'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('原子写入刷新并替换目标文件且不遗留临时副本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-atomic-write-test-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, 'old', 'utf8');
    await atomicWriteFile(file, 'new', { encoding: 'utf8', mode: 0o600 });
    assert.equal(await readFile(file, 'utf8'), 'new');
    await assert.rejects(readFile(atomicTemporaryPath(file), 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('原子重命名失败会清除临时副本并保留原始错误', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-atomic-failure-test-'));
  const targetDirectory = join(directory, 'target');
  try {
    await mkdir(targetDirectory);
    await assert.rejects(atomicWriteFile(targetDirectory, 'data', { encoding: 'utf8', mode: 0o600 }));
    await assert.rejects(readFile(atomicTemporaryPath(targetDirectory), 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('启动恢复只清理目标文件对应的固定临时副本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-atomic-cleanup-test-'));
  const file = join(directory, 'config.json');
  const temporary = atomicTemporaryPath(file);
  try {
    await writeFile(temporary, 'stale-secret', 'utf8');
    assert.equal(await cleanupAtomicTemporary(file), true);
    assert.equal(await cleanupAtomicTemporary(file), false);
    await assert.rejects(readFile(temporary, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
