import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';

test('Go quick 冒烟先验证模型，再完成 Responses 与统计闭环', { timeout: 15_000 }, async () => {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString('utf8');
    requests.push({ path: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/models') {
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }));
    }
    if (req.url === '/chat/completions') {
      return res.end(JSON.stringify({
        id: 'chatcmpl_smoke', object: 'chat.completion', model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'BRIDGE_RESPONSES_OK_7429' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }
      }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^OPENCODE_(?:ZEN|GO)_(?:KEY|KEYS|KEY_\d+|PROXY_URL|PROXY_URLS|PROXY_URL_\d+)$/.test(name)) delete env[name];
  Object.assign(env, {
    OPENCODE_GO_KEY: 'unit-test-go-key',
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_LIVE_PROFILE: 'quick',
    OPENCODE_LIVE_TIMEOUT_MS: '10000'
  });
  const child = spawn(process.execPath, ['scripts/live-go-smoke.mjs'], {
    cwd: resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.profile, 'quick');
    assert.equal(result.checks.models, true);
    assert.equal(result.checks.responses.semanticMarker, true);
    assert.equal(result.checks.stats.requests, 1);
    assert.equal(result.checks.stats.timingBuckets, 1);
    assert.ok(result.checks.stats.averageUpstreamWaitMs >= 0);
    assert.ok(result.checks.stats.averageUpstreamBodyMs >= 0);
    assert.deepEqual(requests.map((item) => item.path), ['/models', '/chat/completions']);
    assert.ok(requests.every((item) => item.authorization === 'Bearer unit-test-go-key'));
    assert.equal(requests[1].body.model, 'deepseek-v4-flash');
    assert.doesNotMatch(`${stdout}${stderr}`, /unit-test-go-key/);
  } finally {
    if (child.exitCode === null) child.kill();
    upstream.close();
    await once(upstream, 'close').catch(() => {});
  }
});
