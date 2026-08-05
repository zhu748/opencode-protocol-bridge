import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalStaticRoot, ifNoneMatchMatches, resolveStaticFile } from '../src/static-files.js';

test('静态资源解析规范化路径并生成稳定缓存元数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-static-test-'));
  try {
    await writeFile(join(directory, 'index.html'), 'hello', 'utf8');
    const root = await canonicalStaticRoot(directory);
    const entry = await resolveStaticFile(root, '/');
    assert.equal(entry.size, 5);
    assert.match(entry.etag, /^W\/"[a-f0-9]+-[a-f0-9]+"$/);
    assert.ok(Number.isFinite(Date.parse(entry.lastModified)));
    assert.equal(ifNoneMatchMatches(entry.etag, entry.etag), true);
    assert.equal(ifNoneMatchMatches(entry.etag.replace(/^W\//, ''), entry.etag), true);
    assert.equal(ifNoneMatchMatches(`"other", ${entry.etag}`, entry.etag), true);
    assert.equal(ifNoneMatchMatches('*', entry.etag), true);
    assert.equal(ifNoneMatchMatches('"other"', entry.etag), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('静态资源拒绝编码穿越、非法编码和目录请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-static-boundary-test-'));
  try {
    await mkdir(join(directory, 'folder'));
    const root = await canonicalStaticRoot(directory);
    await assert.rejects(resolveStaticFile(root, '/..%2Fsecret.txt'), (error) => error.status === 403);
    await assert.rejects(resolveStaticFile(root, '/..%5Csecret.txt'), (error) => [403, 404].includes(error.status));
    await assert.rejects(resolveStaticFile(root, '/bad%ZZ'), (error) => error.status === 400);
    await assert.rejects(resolveStaticFile(root, '/folder'), (error) => error.status === 404);
    await assert.rejects(resolveStaticFile(root, '/missing.txt'), (error) => error.status === 404);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('静态资源不会跟随 public 目录内指向外部的链接', async (context) => {
  const parent = await mkdtemp(join(tmpdir(), 'bridge-static-link-test-'));
  const rootDirectory = join(parent, 'public');
  const outsideDirectory = join(parent, 'outside');
  try {
    await mkdir(rootDirectory);
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, 'secret.txt'), 'never expose', 'utf8');
    try {
      await symlink(outsideDirectory, join(rootDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return context.skip(`当前环境不能创建测试链接：${error.code}`);
      throw error;
    }
    const root = await canonicalStaticRoot(rootDirectory);
    await assert.rejects(resolveStaticFile(root, '/linked/secret.txt'), (error) => error.status === 403);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
