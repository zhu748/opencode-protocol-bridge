import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { clientAbortController, clientAbortSignal } from '../src/request-abort.js';

function requestPair() {
  const req = new EventEmitter();
  req.aborted = false;
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  return { req, res };
}

test('客户端在异步请求准备期间断开会立即中止并清理监听器', () => {
  const { req, res } = requestPair();
  const controller = clientAbortController(req, res);
  assert.equal(controller.signal.aborted, false);

  res.emit('close');
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason?.code, 'CLIENT_CLOSED');
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('finish'), 0);
});

test('已断开的请求不会错过取消事件，正常完成不会误报取消', () => {
  const disconnected = requestPair();
  disconnected.res.destroyed = true;
  const signal = clientAbortSignal(disconnected.req, disconnected.res);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason?.code, 'CLIENT_CLOSED');

  const completed = requestPair();
  const controller = clientAbortController(completed.req, completed.res);
  completed.res.writableEnded = true;
  completed.res.emit('finish');
  completed.res.emit('close');
  assert.equal(controller.signal.aborted, false);
  assert.equal(completed.req.listenerCount('aborted'), 0);
  assert.equal(completed.res.listenerCount('close'), 0);
});
