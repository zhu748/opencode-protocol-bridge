import test from 'node:test';
import assert from 'node:assert/strict';
import { assertJsonComplexity, MAX_JSON_NESTING_DEPTH, MAX_JSON_STRUCTURE_NODES } from '../src/json-complexity.js';

function nestedObject(depth) {
  let value = null;
  for (let index = 0; index < depth; index++) value = { value };
  return value;
}

test('JSON 复杂度检查允许边界值并拒绝更深的结构', () => {
  assert.doesNotThrow(() => assertJsonComplexity(nestedObject(MAX_JSON_NESTING_DEPTH)));
  assert.throws(
    () => assertJsonComplexity(nestedObject(MAX_JSON_NESTING_DEPTH + 1), {
      label: '测试 JSON', code: 'TOO_COMPLEX', depthStatus: 400
    }),
    (error) => error.code === 'TOO_COMPLEX' && error.status === 400 && /256 层/.test(error.message)
  );
});

test('JSON 复杂度检查把根值计入节点上限', () => {
  assert.doesNotThrow(() => assertJsonComplexity(new Array(MAX_JSON_STRUCTURE_NODES - 1).fill(null)));
  assert.throws(
    () => assertJsonComplexity(new Array(MAX_JSON_STRUCTURE_NODES).fill(null), {
      label: '测试 JSON', code: 'TOO_COMPLEX', nodesStatus: 413
    }),
    (error) => error.code === 'TOO_COMPLEX' && error.status === 413 && /250000 个值/.test(error.message)
  );
});

test('JSON 复杂度检查在宽原始值与对象子树混合时保持精确计数和深度', () => {
  const allowed = new Array(MAX_JSON_STRUCTURE_NODES - 3).fill('text');
  allowed.push({ value: null });
  assert.doesNotThrow(() => assertJsonComplexity(allowed));

  allowed.push(true);
  assert.throws(
    () => assertJsonComplexity(allowed, { code: 'TOO_COMPLEX' }),
    (error) => error.code === 'TOO_COMPLEX' && /250000 个值/.test(error.message)
  );

  const nested = new Array(MAX_JSON_NESTING_DEPTH - 1).fill(null);
  let branch = null;
  for (let index = 0; index < nested.length; index++) branch = [branch];
  assert.doesNotThrow(() => assertJsonComplexity(['primitive', branch]));
  assert.throws(() => assertJsonComplexity([[branch]]), /256 层/);
});
