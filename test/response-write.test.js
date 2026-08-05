import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeResponseChunk } from '../src/response-write.js';

class FakeResponse extends EventEmitter {
  constructor(writeResult = false) {
    super();
    this.writeResult = writeResult;
    this.destroyed = false;
    this.writableEnded = false;
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(chunk);
    return this.writeResult;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

test('流式写入无背压时立即完成', async () => {
  const response = new FakeResponse(true);
  await writeResponseChunk(response, 'data', 20);
  assert.deepEqual(response.chunks, ['data']);
  assert.equal(response.eventNames().length, 0);
});

test('流式写入等待 drain 后清除全部监听器', async () => {
  const response = new FakeResponse(false);
  const pending = writeResponseChunk(response, 'data', 100);
  setImmediate(() => response.emit('drain'));
  await pending;
  assert.equal(response.destroyed, false);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('error'), 0);
});

test('慢客户端超过写入超时后被断开且不会遗留监听器', async () => {
  const response = new FakeResponse(false);
  await assert.rejects(writeResponseChunk(response, 'data', 20), (error) => {
    assert.equal(error.code, 'CLIENT_WRITE_TIMEOUT');
    assert.match(error.message, /读取流式响应超时/);
    return true;
  });
  assert.equal(response.destroyed, true);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('error'), 0);
});

test('客户端在等待 drain 时关闭会返回中性关闭错误', async () => {
  const response = new FakeResponse(false);
  const pending = writeResponseChunk(response, 'data', 100);
  setImmediate(() => response.destroy());
  await assert.rejects(pending, (error) => error.code === 'CLIENT_CLOSED');
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('error'), 0);
});
