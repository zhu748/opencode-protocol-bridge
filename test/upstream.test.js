import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_UPSTREAM_JSON_BYTES, readResponseJson, readResponseText, upstreamBase } from '../src/upstream.js';

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
