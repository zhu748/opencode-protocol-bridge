import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageHandoffStore, imageHandoffStorageOptions, localImageHandoffEnabled, normalizeImageHandoffPublicUrl } from '../src/image-handoff.js';
import { prepareUpstreamRequest } from '../src/adapters.js';

test('本地监听默认开启图片交接，远程监听默认关闭且允许显式覆盖', () => {
  assert.equal(localImageHandoffEnabled('127.0.0.1'), true);
  assert.equal(localImageHandoffEnabled('::1'), true);
  assert.equal(localImageHandoffEnabled('0.0.0.0'), false);
  assert.equal(localImageHandoffEnabled('0.0.0.0', 'true'), true);
  assert.equal(localImageHandoffEnabled('127.0.0.1', 'false'), false);
});

test('已选择模型的 Claude 图片会落入进程目录并替换为 vision 技能可用的路径', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-image-handoff-test-'));
  const store = new ImageHandoffStore({ baseDirectory });
  const original = {
    model: 'alias',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '看看图片' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
    ] }]
  };
  try {
    const prepared = await store.prepareClaudeRequest(original, true);
    const handoff = prepared.messages[0].content[1];
    assert.equal(handoff.type, 'text');
    assert.match(handoff.text, /本地图片附件：.*\.png.*vision 技能/);
    const filePath = handoff.text.match(/本地图片附件：(.*?)。/)[1];
    assert.equal(await readFile(filePath, 'utf8'), 'hello');
    assert.equal(original.messages[0].content[1].type, 'image');
    const upstream = prepareUpstreamRequest(prepared, 'claude', 'chat', 'deepseek-v4-flash', { imageHandoffEnabled: true });
    assert.match(JSON.stringify(upstream), /本地图片附件/);
    assert.doesNotMatch(JSON.stringify(upstream), /image_url|aGVsbG8=/);

    const untouched = await store.prepareClaudeRequest(original, false);
    assert.equal(untouched, original);
    await store.close();
    await assert.rejects(readFile(filePath), (error) => error.code === 'ENOENT');
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('关闭图片交接时保留原请求，由协议适配层执行普通文本降级', async () => {
  const store = new ImageHandoffStore({ enabled: false });
  const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }] };
  assert.equal(await store.prepareClaudeRequest(body, true), body);
  await store.close();
});

test('远程图片交接生成短时随机 URL 并拒绝过期令牌', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-remote-image-test-'));
  let now = 1_000;
  const store = new ImageHandoffStore({
    enabled: false,
    baseDirectory,
    publicBaseUrl: 'https://bridge.example.com/',
    publicTtlMs: 60_000,
    now: () => now
  });
  const body = { messages: [{ role: 'user', content: [{
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
  }] }] };
  try {
    const prepared = await store.prepareClaudeRequest(body, true);
    const text = prepared.messages[0].content[0].text;
    const url = text.match(/远程图片附件：(https:\/\/[^（]+)/)[1];
    const token = url.split('/').at(-1);
    assert.match(token, /^[a-f0-9]{64}$/);
    const filePath = store.publicImage(token).filePath;
    assert.equal(await readFile(filePath, 'utf8'), 'hello');
    now += 60_001;
    assert.equal(store.publicImage(token), null);
    await waitFor(async () => !await readFile(filePath).then(() => true).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }), 1000);
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('远程附件过期删除与同内容重新发布不会互相覆盖', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-remote-image-republish-test-'));
  let now = 1_000;
  const store = new ImageHandoffStore({
    baseDirectory, publicBaseUrl: 'https://bridge.example.com', publicTtlMs: 60_000, now: () => now
  });
  const body = { messages: [{ role: 'user', content: [{
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
  }] }] };
  try {
    const first = await store.prepareClaudeRequest(body, true);
    const firstToken = first.messages[0].content[0].text.match(/[a-f0-9]{64}/)[0];
    now += 60_001;
    assert.equal(store.publicImage(firstToken), null);

    const second = await store.prepareClaudeRequest(body, true);
    const secondToken = second.messages[0].content[0].text.match(/[a-f0-9]{64}/)[0];
    assert.notEqual(secondToken, firstToken);
    const republished = store.publicImage(secondToken);
    assert.ok(republished);
    assert.equal(await readFile(republished.filePath, 'utf8'), 'hello');
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('远程附件在活跃下载期间不会删除，释放读取租约后立即清理', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-image-active-read-test-'));
  let now = 1_000;
  const store = new ImageHandoffStore({
    baseDirectory, publicBaseUrl: 'https://bridge.example.com', publicTtlMs: 100, now: () => now
  });
  const body = { messages: [{ role: 'user', content: [{
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
  }] }] };
  try {
    const prepared = await store.prepareClaudeRequest(body, true);
    const token = prepared.messages[0].content[0].text.match(/[a-f0-9]{64}/)[0];
    const image = store.acquirePublicImage(token);
    assert.ok(image);
    now += 101;
    assert.equal(store.publicImage(token), null);
    await Promise.all(store.deletingByPath.values());
    assert.equal(await readFile(image.filePath, 'utf8'), 'hello');

    image.release();
    await Promise.all(store.deletingByPath.values());
    await assert.rejects(readFile(image.filePath), (error) => error.code === 'ENOENT');
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('并发保存相同附件只记账一次并保留每个待发布引用', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-image-concurrency-test-'));
  let now = 1_000;
  const store = new ImageHandoffStore({
    baseDirectory, publicBaseUrl: 'https://bridge.example.com', publicTtlMs: 100, maxBytes: 5, now: () => now
  });
  const image = { data: Buffer.from('hello'), extension: 'png' };
  try {
    const paths = await Promise.all(Array.from({ length: 8 }, () => store.save(image)));
    assert.equal(new Set(paths).size, 1);
    assert.equal(store.totalBytes, 5);
    assert.equal(store.pendingPublications.get(paths[0]), 8);

    const firstUrl = store.publish(paths[0], 'image/png', 'png');
    assert.equal(store.pendingPublications.get(paths[0]), 7);
    now += 101;
    assert.equal(store.publicImage(firstUrl.split('/').at(-1)), null);
    await Promise.all(store.deletingByPath.values());
    assert.equal(await readFile(paths[0], 'utf8'), 'hello');

    for (let index = 1; index < paths.length; index++) store.publish(paths[index], 'image/png', 'png');
    assert.equal(store.pendingPublications.has(paths[0]), false);
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('本地附件重复使用会刷新保留期，过期后删除并释放容量', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-image-retention-test-'));
  let now = 1_000;
  const store = new ImageHandoffStore({ baseDirectory, localRetentionMs: 100, maxBytes: 5, now: () => now });
  const image = { data: Buffer.from('hello'), extension: 'png' };
  try {
    const filePath = await store.save(image);
    now += 50;
    assert.equal(await store.save(image), filePath);
    now += 51;
    store.pruneExpiredLocalImages();
    await Promise.all(store.deletingByPath.values());
    assert.equal(await readFile(filePath, 'utf8'), 'hello');

    now += 50;
    store.pruneExpiredLocalImages();
    await Promise.all(store.deletingByPath.values());
    await assert.rejects(readFile(filePath), (error) => error.code === 'ENOENT');
    assert.equal(store.totalBytes, 0);
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('图片交接容量满时返回明确错误，重复内容不重复占用容量', async () => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'bridge-image-capacity-test-'));
  const store = new ImageHandoffStore({ baseDirectory, maxBytes: 5, localRetentionMs: 0 });
  try {
    await Promise.all(Array.from({ length: 8 }, () => store.save({ data: Buffer.from('hello'), extension: 'png' })));
    assert.equal(store.totalBytes, 5);
    await assert.rejects(
      store.save({ data: Buffer.from('!'), extension: 'png' }),
      (error) => error.status === 507 && error.code === 'IMAGE_HANDOFF_STORAGE_FULL'
    );
    assert.equal(store.totalBytes, 5);
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('图片交接存储环境变量使用安全默认值并严格校验', () => {
  assert.deepEqual(imageHandoffStorageOptions({}), {
    maxBytes: 256 * 1024 * 1024,
    localRetentionMs: 24 * 60 * 60 * 1000
  });
  assert.deepEqual(imageHandoffStorageOptions({
    OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES: String(1024 * 1024),
    OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS: '60000'
  }), { maxBytes: 1024 * 1024, localRetentionMs: 60_000 });
  assert.deepEqual(imageHandoffStorageOptions({
    OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES: '0',
    OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS: '0'
  }), { maxBytes: 0, localRetentionMs: 0 });
  assert.throws(() => imageHandoffStorageOptions({ OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES: '1048575' }), /必须是 0 或/);
  assert.throws(() => imageHandoffStorageOptions({ OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS: '-1' }), /必须是 0 或/);
});

test('远程图片公网基址必须是安全可解析的 HTTP(S) URL', () => {
  assert.equal(normalizeImageHandoffPublicUrl('https://bridge.example.com/'), 'https://bridge.example.com');
  assert.equal(normalizeImageHandoffPublicUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.throws(() => normalizeImageHandoffPublicUrl('javascript:alert(1)'), /HTTP\(S\)/);
  assert.throws(() => normalizeImageHandoffPublicUrl('https://user:pass@bridge.example.com'), /不含认证/);
  assert.throws(() => normalizeImageHandoffPublicUrl('http://bridge.example.com'), /必须使用 HTTPS/);
});

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`等待条件在 ${timeoutMs}ms 内未满足`);
}
