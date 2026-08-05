import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageHandoffStore, localImageHandoffEnabled, normalizeImageHandoffPublicUrl } from '../src/image-handoff.js';
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
    assert.equal(await readFile(store.publicImage(token).filePath, 'utf8'), 'hello');
    now += 60_001;
    assert.equal(store.publicImage(token), null);
  } finally {
    await store.close();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('远程图片公网基址必须是安全可解析的 HTTP(S) URL', () => {
  assert.equal(normalizeImageHandoffPublicUrl('https://bridge.example.com/'), 'https://bridge.example.com');
  assert.equal(normalizeImageHandoffPublicUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.throws(() => normalizeImageHandoffPublicUrl('javascript:alert(1)'), /HTTP\(S\)/);
  assert.throws(() => normalizeImageHandoffPublicUrl('https://user:pass@bridge.example.com'), /不含认证/);
  assert.throws(() => normalizeImageHandoffPublicUrl('http://bridge.example.com'), /必须使用 HTTPS/);
});
