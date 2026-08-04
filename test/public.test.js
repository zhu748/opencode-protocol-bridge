import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const publicDir = resolve(import.meta.dirname, '../public');
const projectDir = resolve(publicDir, '..');

test('管理面板脚本引用的静态元素均存在', async () => {
  const [html, script, settings] = await Promise.all([
    readFile(resolve(publicDir, 'index.html'), 'utf8'),
    readFile(resolve(publicDir, 'app.js'), 'utf8'),
    readFile(resolve(publicDir, 'settings.css'), 'utf8')
  ]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = [...script.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(referenced)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
  assert.equal(new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])).size, [...html.matchAll(/\bid="([^"]+)"/g)].length, 'HTML id 不应重复');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'CSP 下不应使用内联脚本');
  assert.match(script, /setInterval\(updateCooldownCountdowns, 1000\)/);
  assert.match(script, /x-opencode-upstream-request-id|upstreamRequestId/);
  assert.match(script, /function filteredLogs\(\)/);
  assert.match(script, /navigator\.clipboard\.writeText\(button\.dataset\.copyValue\)/);
  assert.match(script, /requestLogsToCsv\(items\)/);
  assert.match(html, /<svg class="cache-meter-graphic" viewBox="0 0 100 12"/);
  assert.match(script, /querySelector\('\.cache-read'\)\.setAttribute\('width'/);
  assert.match(script, /querySelector\('\.cache-uncached'\)\.setAttribute\('x'/);
  assert.doesNotMatch(script, /querySelector\('\.cache-(?:read|uncached)'\)\.className/);
  assert.match(script, /指标与分组：\$\{range\} · 趋势：\$\{trendRange\}/);
  assert.match(settings, /@media \(max-width: 1200px\)[\s\S]*?\.log-toolbar/);
  assert.match(settings, /@media \(max-width: 1000px\)[\s\S]*?\.log-toolbar/);
  assert.match(settings, /@media \(max-width: 720px\)[\s\S]*?\.log-toolbar/);
});

test('Render Blueprint 暴露批量 Key 与逐项代理变量', async () => {
  const blueprint = await readFile(resolve(projectDir, 'render.yaml'), 'utf8');
  for (const name of ['OPENCODE_ZEN_KEYS', 'OPENCODE_GO_KEYS', 'OPENCODE_ZEN_PROXY_URLS', 'OPENCODE_GO_PROXY_URLS']) {
    assert.equal((blueprint.match(new RegExp(`key: ${name}\\b`, 'g')) || []).length, 1, `${name} 应出现一次`);
  }
});

test('OpenAPI 文件是有效的 3.1 描述并覆盖所有公开端点', async () => {
  const spec = JSON.parse(await readFile(resolve(publicDir, 'openapi.json'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/chat/completions', '/messages', '/models', '/models/{model}', '/responses']);
  assert.equal(spec.components.schemas.ModelId.maxLength, 256);
  assert.ok(spec.paths['/responses'].post.responses['413']);
  assert.ok(spec.paths['/messages'].post.responses['429']);
  assert.equal(spec.paths['/messages'].post.responses['200'].headers['x-opencode-key-attempts'].$ref, '#/components/headers/KeyAttempts');
  assert.equal(spec.paths['/models'].get.responses['200'].headers['x-opencode-key-attempts'].$ref, '#/components/headers/KeyAttempts');
  assert.equal(spec.paths['/models'].get.responses['400'].$ref, '#/components/responses/InvalidRequest');
  assert.deepEqual(spec.paths['/models/{model}'].get.parameters.find((parameter) => parameter.name === 'provider').schema.enum, ['zen', 'go']);
  assert.equal(spec.components.headers.KeyAttempts.schema.minimum, 2);
  assert.equal(spec.components.headers.UpstreamRequestId.schema.maxLength, 256);
  assert.equal(spec.components.responses.RateLimited.headers['Retry-After'].$ref, '#/components/headers/RetryAfter');
  assert.equal(spec.components.responses.MethodNotAllowed.headers.Allow.$ref, '#/components/headers/Allow');
  for (const [path, method] of [['/models', 'get'], ['/models/{model}', 'get'], ['/messages', 'post'], ['/responses', 'post'], ['/chat/completions', 'post']]) {
    assert.equal(spec.paths[path][method].responses['405'].$ref, '#/components/responses/MethodNotAllowed');
  }
  assert.deepEqual(spec.servers.map((server) => server.url), ['/zen/v1', '/go/v1', '/v1']);
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.ok(spec.components.securitySchemes.apiKeyAuth);
});
