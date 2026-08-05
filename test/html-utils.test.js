import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../public/html-utils.js';

test('HTML 转义同时保护文本节点和双引号属性上下文', () => {
  const malicious = `"><button data-name='x'>& 攻击</button>`;
  assert.equal(
    escapeHtml(malicious),
    '&quot;&gt;&lt;button data-name=&#39;x&#39;&gt;&amp; 攻击&lt;/button&gt;'
  );
  const rendered = `<button data-name="${escapeHtml(malicious)}">安全文本</button>`;
  assert.equal((rendered.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(rendered, /data-name=""><button/);
});

test('HTML 转义规范化非字符串值且不重复改写普通文本', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml('普通文本_123'), '普通文本_123');
});
