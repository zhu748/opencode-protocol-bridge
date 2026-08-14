import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { callUpstream, closeDirectUpstreamDispatcher, DIRECT_CONNECT_TIMEOUT_MS, directUpstreamDispatcher, discardUpstreamResponse, isUpstreamConnectionError, listModels, MAX_UPSTREAM_JSON_BYTES, readResponseJson, readResponseJsonPayload, readResponseText, upstreamBase, upstreamConnectionFailure, withStreamIdleTimeout } from '../src/upstream.js';

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

test('Responses compact 使用专用上游路径且拒绝其它协议', async () => {
  let received;
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_compact', object: 'response', status: 'completed', output: [] }));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  try {
    const response = await callUpstream({
      provider: 'zen', protocol: 'responses', operation: 'compact', apiKey: 'test',
      body: { model: 'gpt-test', input: 'long context' }
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(received, {
      url: '/v1/responses/compact', body: { model: 'gpt-test', input: 'long context' }
    });
    await assert.rejects(() => callUpstream({
      provider: 'zen', protocol: 'chat', operation: 'compact', apiKey: 'test', body: {}
    }), /只支持 Responses 上游/);
    await assert.rejects(() => callUpstream({
      provider: 'zen', protocol: 'responses', operation: 'unknown', apiKey: 'test', body: {}
    }), /不支持的上游操作/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeDirectUpstreamDispatcher({ force: true });
    upstream.close();
    await once(upstream, 'close').catch(() => {});
  }
});

test('Gemini 上游使用原生 generateContent 路径、Google 鉴权并移除桥接控制字段', async () => {
  const received = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        googleKey: req.headers['x-goog-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      });
      res.writeHead(200, { 'content-type': req.url.includes('streamGenerateContent') ? 'text/event-stream' : 'application/json' });
      res.end(req.url.includes('streamGenerateContent') ? 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n' : '{"candidates":[]}');
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${upstream.address().port}/zen/v1`;
  try {
    for (const stream of [false, true]) {
      const response = await callUpstream({
        provider: 'zen', protocol: 'gemini', apiKey: 'gemini-test-key',
        body: {
          model: 'gemini-3.6-flash', stream,
          contents: [{ role: 'user', parts: [{ text: '你好' }] }],
          safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }]
        }
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.deepEqual(received.map((entry) => entry.url), [
      '/zen/v1/models/gemini-3.6-flash:generateContent',
      '/zen/v1/models/gemini-3.6-flash:streamGenerateContent?alt=sse'
    ]);
    for (const entry of received) {
      assert.equal(entry.authorization, 'Bearer gemini-test-key');
      assert.equal(entry.googleKey, 'gemini-test-key');
      assert.equal('model' in entry.body, false);
      assert.equal('stream' in entry.body, false);
      assert.equal(entry.body.contents[0].parts[0].text, '你好');
      assert.equal(entry.body.safetySettings[0].threshold, 'BLOCK_NONE');
    }
    await assert.rejects(() => callUpstream({
      provider: 'zen', protocol: 'gemini', apiKey: 'test', body: { contents: [] }
    }), /缺少模型名/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeDirectUpstreamDispatcher({ force: true });
    upstream.close();
    await once(upstream, 'close').catch(() => {});
  }
});

test('流式上游超时只限制响应头且客户端取消在响应头后仍然生效', async () => {
  let markCanceledBodyClosed;
  const canceledBodyClosed = new Promise((resolve) => { markCanceledBodyClosed = resolve; });
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model === 'slow-headers') {
        return setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
        }, 250);
      }
      if (body.model === 'error-body') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.write('{"error":{"message":"delayed');
        return setTimeout(() => {
          if (!res.destroyed) res.end(' failure"}}');
        }, 800);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      if (body.model === 'client-abort') {
        res.once('close', markCanceledBodyClosed);
        return;
      }
      setTimeout(() => {
        if (!res.destroyed) res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
      }, 800);
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const longStream = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 400,
      body: { model: 'long-stream', stream: true }
    });
    assert.match(await longStream.text(), /response\.completed/);

    await assert.rejects(
      () => callUpstream({
        provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 50,
        body: { model: 'slow-headers', stream: true }
      }),
      (error) => error?.name === 'TimeoutError'
        && upstreamConnectionFailure(error).code === 'upstream_response_timeout'
    );

    const errorResponse = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 400,
      body: { model: 'error-body', stream: true }
    });
    assert.equal(errorResponse.status, 500);
    await assert.rejects(() => errorResponse.text(), (error) => error?.name === 'TimeoutError');

    const cancellation = new AbortController();
    const canceledStream = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 5000,
      signal: cancellation.signal, body: { model: 'client-abort', stream: true }
    });
    cancellation.abort();
    await assert.rejects(() => canceledStream.text(), (error) => error?.name === 'AbortError');
    await Promise.race([
      canceledBodyClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('客户端取消后上游 SSE 未及时关闭')), 1000))
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeDirectUpstreamDispatcher({ force: true });
    upstream.close();
    await once(upstream, 'close').catch(() => {});
  }
});

test('上游响应在读取或丢弃后立即释放流式错误、非流式和模型发现总超时', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"temporary"}}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const tracked = [];
  const cleared = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if ([61_234, 61_235, 61_236, 61_237, 61_238].includes(delay)) tracked.push({ delay, timer });
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (tracked.some((entry) => entry.timer === timer)) cleared.add(timer);
    return originalClearTimeout(timer);
  };
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const consumed = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 61_234,
      body: { model: 'error-consumed', stream: true }
    });
    const consumedTimer = tracked.find((entry) => entry.delay === 61_234)?.timer;
    assert.ok(consumedTimer);
    assert.equal(cleared.has(consumedTimer), false, '错误正文完成前应继续受总超时限制');
    assert.match(await readResponseText(consumed, 1024), /temporary/);
    assert.equal(cleared.has(consumedTimer), true);

    const discarded = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 61_235,
      body: { model: 'error-discarded', stream: true }
    });
    const discardedTimer = tracked.find((entry) => entry.delay === 61_235)?.timer;
    assert.ok(discardedTimer);
    assert.equal(cleared.has(discardedTimer), false);
    await discardUpstreamResponse(discarded);
    assert.equal(cleared.has(discardedTimer), true);

    const nonStreaming = await callUpstream({
      provider: 'zen', protocol: 'responses', apiKey: 'test', timeoutMs: 61_236,
      body: { model: 'non-stream-error' }
    });
    const nonStreamingTimer = tracked.find((entry) => entry.delay === 61_236)?.timer;
    assert.ok(nonStreamingTimer);
    assert.equal(cleared.has(nonStreamingTimer), false);
    await readResponseText(nonStreaming, 1024);
    assert.equal(cleared.has(nonStreamingTimer), true);

    const models = await listModels({ provider: 'zen', apiKey: 'test', timeoutMs: 61_237 });
    const modelsTimer = tracked.find((entry) => entry.delay === 61_237)?.timer;
    assert.ok(modelsTimer);
    assert.equal(cleared.has(modelsTimer), false);
    await readResponseText(models, 1024);
    assert.equal(cleared.has(modelsTimer), true);

    const discardedModels = await listModels({ provider: 'zen', apiKey: 'test', timeoutMs: 61_238 });
    const discardedModelsTimer = tracked.find((entry) => entry.delay === 61_238)?.timer;
    assert.ok(discardedModelsTimer);
    assert.equal(cleared.has(discardedModelsTimer), false);
    await discardUpstreamResponse(discardedModels);
    assert.equal(cleared.has(discardedModelsTimer), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const { timer } of tracked) originalClearTimeout(timer);
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeDirectUpstreamDispatcher({ force: true });
    upstream.close();
    await once(upstream, 'close').catch(() => {});
  }
});

test('上游流空闲超时逐块重置并取消失去响应的正文', async () => {
  const encoder = new TextEncoder();
  let step = 0;
  const active = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (++step <= 3) controller.enqueue(encoder.encode(String(step)));
      else controller.close();
    }
  });
  const chunks = [];
  for await (const chunk of withStreamIdleTimeout(active, 200)) chunks.push(Buffer.from(chunk).toString('utf8'));
  assert.deepEqual(chunks, ['1', '2', '3']);

  let cancellationReason;
  const stalled = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('first')); },
    cancel(reason) { cancellationReason = reason; }
  });
  const iterator = withStreamIdleTimeout(stalled, 50)[Symbol.asyncIterator]();
  assert.equal(Buffer.from((await iterator.next()).value).toString('utf8'), 'first');
  await assert.rejects(() => iterator.next(), (error) => error?.name === 'TimeoutError' && error?.code === 'UPSTREAM_STREAM_IDLE_TIMEOUT');
  assert.equal(cancellationReason?.code, 'UPSTREAM_STREAM_IDLE_TIMEOUT');
  assert.deepEqual(upstreamConnectionFailure(cancellationReason), {
    status: 504,
    code: 'upstream_stream_idle_timeout',
    message: '读取上游流超时：长时间未收到任何数据'
  });
  const eventIdle = Object.assign(new Error('event idle'), { name: 'TimeoutError', code: 'UPSTREAM_STREAM_EVENT_IDLE_TIMEOUT' });
  assert.equal(isUpstreamConnectionError(eventIdle), true);
  assert.deepEqual(upstreamConnectionFailure(eventIdle), {
    status: 504,
    code: 'upstream_stream_event_idle_timeout',
    message: '读取上游流超时：长时间未收到有效 SSE 事件'
  });

  const disabled = new Response('unlimited').body;
  let disabledText = '';
  for await (const chunk of withStreamIdleTimeout(disabled, 0)) disabledText += Buffer.from(chunk).toString('utf8');
  assert.equal(disabledText, 'unlimited');
  const observedChunks = [];
  for await (const chunk of withStreamIdleTimeout(new Response('observed').body, 100, (value) => observedChunks.push(value.byteLength))) {
    void chunk;
  }
  assert.ok(observedChunks.length >= 1);
  assert.ok(observedChunks.every((size) => size > 0));
  await assert.rejects(async () => {
    for await (const _ of withStreamIdleTimeout(new Response('').body, -1)) void _;
  }, /非负整数/);
  await assert.rejects(async () => {
    for await (const _ of withStreamIdleTimeout(new Response('').body, 100, true)) void _;
  }, /回调必须是函数/);
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

test('上游响应读取器拒绝无效 UTF-8 而不是静默插入替换字符', async () => {
  const response = new Response(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
  await assert.rejects(
    () => readResponseText(response, 1024, '上游 JSON 响应'),
    (error) => error?.code === 'UPSTREAM_INVALID_UTF8' && error.message === '上游 JSON 响应包含无效 UTF-8'
  );
});

test('上游 JSON 读取器返回对象并拒绝损坏 JSON', async () => {
  assert.deepEqual(await readResponseJson(new Response('{"ok":true}')), { ok: true });
  const raw = Buffer.from(' \n{ "vendor": true, "value": "你好" }\r\n', 'utf8');
  const payload = await readResponseJsonPayload(new Response(raw));
  assert.deepEqual(payload.value, { vendor: true, value: '你好' });
  assert.deepEqual(payload.bytes, raw);
  await assert.rejects(() => readResponseJson(new Response('{broken'), MAX_UPSTREAM_JSON_BYTES), /格式无效/);
});

test('上游 JSON 读取器在协议适配前拒绝异常深层结构', async () => {
  let nested = null;
  for (let depth = 0; depth < 257; depth++) nested = { value: nested };
  await assert.rejects(
    () => readResponseJson(new Response(JSON.stringify(nested))),
    (error) => error.code === 'UPSTREAM_JSON_TOO_COMPLEX' && /256 层/.test(error.message)
  );
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
  const terminated = new TypeError('terminated');
  assert.equal(isUpstreamConnectionError(terminated), true);
  assert.deepEqual(upstreamConnectionFailure(terminated), {
    status: 502,
    code: 'upstream_connection_reset',
    message: '连接上游失败：连接被意外断开'
  });
  assert.deepEqual(upstreamConnectionFailure(Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })), {
    status: 502,
    code: 'upstream_connection_reset',
    message: '连接上游失败：连接被意外断开'
  });
  const generic = upstreamConnectionFailure(new Error('https://user:password@secret.invalid/private'));
  assert.equal(isUpstreamConnectionError(new Error('application conversion failed')), false);
  assert.equal(generic.code, 'upstream_network_error');
  assert.doesNotMatch(JSON.stringify(generic), /user|password|secret\.invalid/);
});
