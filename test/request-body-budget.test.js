import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestBodyBudget, RequestBodyBudgetError } from '../src/request-body-budget.js';

test('Content-Length 预留同时受每客户端与全局正文预算约束', () => {
  const budget = new RequestBodyBudget({ maxBytes: 12, maxClientBytes: 8 });
  const first = budget.acquire('client-a', 8);
  assert.deepEqual(budget.status(), { currentBytes: 8, maxBytes: 12, activeClients: 1, maxClientBytes: 8 });
  assert.throws(() => budget.acquire('client-a', 1), (error) => {
    assert.ok(error instanceof RequestBodyBudgetError);
    assert.equal(error.scope, 'client');
    assert.equal(error.status, 429);
    assert.equal(error.code, 'client_inflight_request_body_limit_exceeded');
    return true;
  });
  assert.throws(() => budget.acquire('client-b', 5), (error) => {
    assert.ok(error instanceof RequestBodyBudgetError);
    assert.equal(error.scope, 'global');
    assert.equal(error.status, 503);
    assert.equal(error.code, 'inflight_request_body_capacity_exhausted');
    return true;
  });
  assert.equal(budget.status().currentBytes, 8);
  first.release();
  assert.equal(budget.status().currentBytes, 0);
});

test('chunked 正文按已收字节增量预留，失败增长不污染计数', () => {
  const budget = new RequestBodyBudget({ maxBytes: 10, maxClientBytes: 10 });
  const lease = budget.acquire('client-a');
  assert.equal(lease.reserveTo(4), 4);
  assert.equal(lease.reserveTo(7), 7);
  assert.equal(lease.reserveTo(6), 7);
  assert.throws(() => lease.reserveTo(11), RequestBodyBudgetError);
  assert.deepEqual(budget.status(), { currentBytes: 7, maxBytes: 10, activeClients: 1, maxClientBytes: 10 });
  lease.release();
  lease.release();
  assert.deepEqual(budget.status(), { currentBytes: 0, maxBytes: 10, activeClients: 0, maxClientBytes: 10 });
});

test('完成、解析失败或取消调用 release 都只精确归还自己的预留', () => {
  const budget = new RequestBodyBudget({ maxBytes: 20, maxClientBytes: 20 });
  const completed = budget.acquire('shared-client', 6);
  const failed = budget.acquire('shared-client', 5);
  const canceled = budget.acquire('other-client');
  canceled.reserveTo(4);
  failed.release();
  assert.deepEqual(budget.status(), { currentBytes: 10, maxBytes: 20, activeClients: 2, maxClientBytes: 20 });
  canceled.release();
  assert.deepEqual(budget.status(), { currentBytes: 6, maxBytes: 20, activeClients: 1, maxClientBytes: 20 });
  completed.release();
  assert.deepEqual(budget.status(), { currentBytes: 0, maxBytes: 20, activeClients: 0, maxClientBytes: 20 });
});

test('租约输入校验阻止负数、小数和释放后继续预留', () => {
  assert.throws(() => new RequestBodyBudget({ maxBytes: 0, maxClientBytes: 1 }), /must|\u5fc5须/u);
  const budget = new RequestBodyBudget({ maxBytes: 10, maxClientBytes: 10 });
  assert.throws(() => budget.acquire('', 1), /clientId/);
  assert.throws(() => budget.acquire('client', -1), /initialBytes|requestedBytes|\u975e负/u);
  const lease = budget.acquire('client', 1);
  lease.release();
  assert.throws(() => lease.reserveTo(2), /已释放/);
});
