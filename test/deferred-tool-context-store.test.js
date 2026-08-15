import test from 'node:test';
import assert from 'node:assert/strict';

import { DeferredToolContextStore } from '../src/deferred-tool-context-store.js';

test('延迟工具上下文按作用域和任一并行调用 ID 命中并一次性消费', () => {
  const store = new DeferredToolContextStore();
  const value = { assistant: { role: 'assistant' }, results: ['search-result'] };
  assert.equal(store.remember('client-a', ['call-1', 'call-2', 'call-1'], value), true);
  assert.equal(store.find('client-b', ['call-1']), null);
  const found = store.find('client-a', ['call-2']);
  assert.equal(found.value, value);
  assert.equal(store.consume(found.id), true);
  assert.equal(store.find('client-a', ['call-1', 'call-2']), null);
  assert.equal(store.bytes, 0);
});

test('延迟工具上下文按 TTL、条目数和总字节数有界淘汰', () => {
  let now = 1000;
  const store = new DeferredToolContextStore({ ttlMs: 10, maxEntries: 2, maxBytes: 80, now: () => now });
  assert.equal(store.remember('scope', ['one'], { text: 'a'.repeat(20) }), true);
  assert.equal(store.remember('scope', ['two'], { text: 'b'.repeat(20) }), true);
  assert.equal(store.remember('scope', ['three'], { text: 'c'.repeat(20) }), true);
  assert.equal(store.find('scope', ['one']), null);
  assert.ok(store.entries.size <= 2);
  assert.ok(store.bytes <= 80);
  now += 11;
  assert.equal(store.find('scope', ['three']), null);
  assert.equal(store.entries.size, 0);
  assert.equal(store.aliases.size, 0);
});

test('超过总容量或不可序列化的上下文会被拒绝且不污染已有状态', () => {
  const store = new DeferredToolContextStore({ maxBytes: 32 });
  assert.equal(store.remember('scope', ['large'], { text: 'x'.repeat(100) }), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(store.remember('scope', ['cyclic'], cyclic), false);
  assert.equal(store.entries.size, 0);
  assert.equal(store.aliases.size, 0);
  assert.equal(store.bytes, 0);
});
