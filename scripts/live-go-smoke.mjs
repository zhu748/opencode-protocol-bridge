#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiKey = String(process.env.OPENCODE_GO_KEY || '').trim();
const model = String(process.env.OPENCODE_LIVE_MODEL || 'deepseek-v4-flash').trim();
if (!apiKey) throw new Error('请通过 OPENCODE_GO_KEY 环境变量提供临时 Go Key');

const root = resolve(import.meta.dirname, '..');
const port = await freePort();
const configFile = resolve(root, 'data', `live-go-${randomUUID()}.json`);
const logFile = resolve(root, 'data', `live-go-log-${randomUUID()}.json`);
const clientToken = `Live${randomBytes(16).toString('hex')}`;
const adminPassword = `Admin${randomBytes(12).toString('hex')}`;
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^OPENCODE_(?:ZEN|GO)_(?:KEY|KEYS|KEY_\d+|PROXY_URL|PROXY_URLS|PROXY_URL_\d+)$/.test(name)) delete env[name];
}
Object.assign(env, {
  HOST: '127.0.0.1', PORT: String(port), CONFIG_FILE: configFile, LOG_FILE: logFile,
  CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  OPENCODE_BRIDGE_ADMIN_PASSWORD: adminPassword,
  OPENCODE_BRIDGE_CLIENT_TOKEN: clientToken,
  OPENCODE_BRIDGE_DEFAULT_PROVIDER: 'go',
  OPENCODE_GO_KEY: apiKey
});

const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });

try {
  await waitForStart(child);
  const base = `http://127.0.0.1:${port}/go/v1`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${clientToken}` };

  const models = await jsonRequest(`${base}/models`, { headers });
  const available = Array.isArray(models.data) && models.data.some((item) => item?.id === model);
  if (!available) throw new Error(`Go 模型列表中不存在 ${model}`);

  const responses = await jsonRequest(`${base}/responses`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, max_output_tokens: 32, reasoning: { effort: 'none' }, input: 'Reply with the exact marker BRIDGE_RESPONSES_OK_7429.' })
  });
  if (responses.object !== 'response' || !Array.isArray(responses.output)) throw new Error('Responses 转换结果结构无效');
  if (!responseOutputText(responses).includes('BRIDGE_RESPONSES_OK_7429')) throw new Error('Responses 转换结果缺少预期语义标记');

  const claude = await jsonRequest(`${base}/messages`, {
    method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 48,
      messages: [{ role: 'user', content: 'Use the add tool to calculate 19 + 23. Do not answer directly.' }],
      tools: [{ name: 'add', description: 'Add two integers', input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
      tool_choice: { type: 'tool', name: 'add' }
    })
  });
  const toolBlock = Array.isArray(claude.content) && claude.content.find((item) => item?.type === 'tool_use');
  if (!toolBlock || toolBlock.name !== 'add') throw new Error('Claude 工具调用未转换为 tool_use');
  if (Number(toolBlock.input?.a) !== 19 || Number(toolBlock.input?.b) !== 23) throw new Error('Claude 工具调用参数未完整保留');

  const streamResponse = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, stream: true, reasoning_effort: 'none', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the exact marker BRIDGE_STREAM_OK_7429.' }] }),
    signal: AbortSignal.timeout(60_000)
  });
  const streamText = await streamResponse.text();
  if (!streamResponse.ok) throw new Error(`Chat 流式请求返回 HTTP ${streamResponse.status}: ${streamText.slice(0, 500)}`);
  if (!streamResponse.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Chat 流式响应 Content-Type 无效');
  const parsedStream = parseChatStream(streamText);
  if (!parsedStream.done || !parsedStream.text.includes('BRIDGE_STREAM_OK_7429')) throw new Error('Chat 流式响应缺少正文语义标记或标准结束事件');
  if (!parsedStream.usage) throw new Error('Chat 流式响应缺少 usage，无法验证统计口径');

  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: adminPassword }),
    signal: AbortSignal.timeout(10_000)
  });
  const loginText = await loginResponse.text();
  if (!loginResponse.ok) throw new Error(`管理登录返回 HTTP ${loginResponse.status}: ${loginText.slice(0, 500)}`);
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('管理登录未返回会话 Cookie');
  const stats = await jsonRequest(`http://127.0.0.1:${port}/api/stats?window=all`, { headers: { cookie } });
  const goStats = stats.byProvider?.find((item) => item.name === 'go');
  if (stats.summary?.requests !== 3 || stats.summary?.usageRequests !== 3 || goStats?.requests !== 3) throw new Error('管理面板统计未覆盖三种在线协议请求');
  if (stats.summary.inputTokens !== stats.summary.uncachedInputTokens + stats.summary.cachedInputTokens + stats.summary.cacheCreationInputTokens) throw new Error('缓存统计的输入 Token 口径不守恒');

  console.log(JSON.stringify({
    ok: true,
    provider: 'go',
    model,
    checks: {
      models: true,
      responses: { status: responses.status, semanticMarker: true, inputTokens: responses.usage?.input_tokens ?? null, outputTokens: responses.usage?.output_tokens ?? null },
      claudeTool: { stopReason: claude.stop_reason, tool: toolBlock.name, input: toolBlock.input },
      chatStream: { contentType: streamResponse.headers.get('content-type'), semanticMarker: true, done: parsedStream.done, usage: parsedStream.usage },
      stats: { requests: stats.summary.requests, usageCoverageRate: stats.summary.usageCoverageRate, totalTokens: stats.summary.totalTokens, cachedInputTokens: stats.summary.cachedInputTokens, cacheReadRate: stats.summary.cacheReadRate }
    }
  }, null, 2));
} finally {
  const exit = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  if (child.exitCode === null) child.kill();
  await Promise.race([exit, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]).catch(() => {});
  await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await unlink(logFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function responseOutputText(body) {
  return (body.output || []).flatMap((item) => item?.type === 'message' ? item.content || [] : [])
    .filter((part) => ['output_text', 'text', 'refusal'].includes(part?.type))
    .map((part) => part.text || part.refusal || '').join('');
}

function parseChatStream(text) {
  let output = '';
  let usage;
  let done = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trimStart();
    if (data === '[DONE]') { done = true; continue; }
    if (!data) continue;
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error(`Chat SSE 包含无效 JSON：${data.slice(0, 200)}`); }
    if (event.error) throw new Error(`Chat SSE 返回错误：${event.error.message || JSON.stringify(event.error)}`);
    const content = event.choices?.[0]?.delta?.content;
    if (typeof content === 'string') output += content;
    else if (Array.isArray(content)) output += content.map((part) => part?.text || '').join('');
    if (event.usage && typeof event.usage === 'object') usage = event.usage;
  }
  return { text: output, usage, done };
}

async function jsonRequest(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`HTTP ${response.status} 返回了无效 JSON: ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function waitForStart(process) {
  let timeout;
  try {
    await Promise.race([
      new Promise((resolveStarted) => process.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(process, 'exit').then(([code]) => { throw new Error(`桥接服务提前退出（${code}）：${stderr}`); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`桥接服务启动超时：${stderr}`)), 10_000); })
    ]);
  } finally { clearTimeout(timeout); }
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const selected = probe.address().port;
  probe.close();
  await once(probe, 'close');
  return selected;
}
