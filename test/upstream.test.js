import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDirectUpstreamDispatcher, DIRECT_CONNECT_TIMEOUT_MS, directUpstreamDispatcher, isUpstreamConnectionError, listModels, MAX_UPSTREAM_JSON_BYTES, readResponseJson, readResponseText, upstreamBase, upstreamConnectionFailure } from '../src/upstream.js';

test('自定义上游地址会清理空白和末尾斜杠', () => {
  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  try {
    process.env.OPENCODE_ZEN_BASE_URL = '  http://127.0.0.1:8788/custom/v1///  ';
    assert.equal(upstreamBase('zen'), 'http://127.0.0.1:8788/custom/v1');
    process.env.OPENCODE_ZEN_BASE_URL = '   ';
    assert.equal(upstreamBase('zen'), 'https://opencode.ai/zen/v1');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
  }
});

test('直连上游复用连接池并可在退出时安全重建', async () => {
  assert.equal(DIRECT_CONNECT_TIMEOUT_MS, 60_000);
  const first = directUpstreamDispatcher();
  assert.equal(directUpstreamDispatcher(), first);
  assert.equal(first.closed, false);
  await closeDirectUpstreamDispatcher();
  assert.equal(first.closed, true);
  const second = directUpstreamDispatcher();
  assert.notEqual(second, first);
  await closeDirectUpstreamDispatcher();
  const third = directUpstreamDispatcher();
  await closeDirectUpstreamDispatcher({ force: true });
  assert.equal(third.destroyed, true);
});

test('模型发现会响应调用方取消信号', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => listModels({ provider: 'zen', apiKey: 'test', signal: controller.signal, timeoutMs: 5000 }),
    (error) => error?.name === 'AbortError'
  );
  await closeDirectUpstreamDispatcher({ force: true });
});

test('上游响应读取器限制声明长度和实际流大小', async () => {
  const declared = new Response('small', { headers: { 'content-length': '999' } });
  await assert.rejects(() => readResponseText(declared, 10), /超过/);

  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123456'));
      controller.enqueue(new TextEncoder().encode('789012'));
      controller.close();
    }
  }));
  await assert.rejects(() => readResponseText(streamed, 10), /超过/);
});

test('上游 JSON 读取器返回对象并拒绝损坏 JSON', async () => {
  assert.deepEqual(await readResponseJson(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(() => readResponseJson(new Response('{broken'), MAX_UPSTREAM_JSON_BYTES), /格式无效/);
});

test('上游连接错误会转换为安全且可操作的诊断信息', () => {
  const connectTimeout = new TypeError('fetch failed', { cause: Object.assign(new Error('attempted secret-proxy:443'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.equal(isUpstreamConnectionError(connectTimeout), true);
  assert.deepEqual(upstreamConnectionFailure(connectTimeout), {
    status: 504,
    code: 'upstream_connect_timeout',
    message: '连接上游失败：建立连接超时，请检查网络或该 Key 的代理'
  });
  assert.deepEqual(upstreamConnectionFailure(Object.assign(new Error('dns'), { code: 'ENOTFOUND' })), {
    status: 502,
    code: 'upstream_dns_error',
    message: '连接上游失败：域名解析失败'
  });
  const generic = upstreamConnectionFailure(new Error('https://user:password@secret.invalid/private'));
  assert.equal(isUpstreamConnectionError(new Error('application conversion failed')), false);
  assert.equal(generic.code, 'upstream_network_error');
  assert.doesNotMatch(JSON.stringify(generic), /user|password|secret\.invalid/);
});
