#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiKey = String(process.env.OPENCODE_GO_KEY || '').trim();
const model = String(process.env.OPENCODE_LIVE_MODEL || 'deepseek-v4-flash').trim();
const requestTimeoutMs = environmentTimeout(process.env.OPENCODE_LIVE_TIMEOUT_MS);
const profile = environmentProfile(process.env.OPENCODE_LIVE_PROFILE);
const skipModelDiscovery = /^(?:1|true)$/i.test(String(process.env.OPENCODE_LIVE_SKIP_MODEL_DISCOVERY || '').trim());
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
let failure;

try {
  await waitForStart(child);
  const base = `http://127.0.0.1:${port}/go/v1`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${clientToken}` };

  const discoverModels = profile === 'full' && !skipModelDiscovery;
  if (discoverModels) {
    const models = await jsonRequest(`${base}/models`, { headers }, '模型发现');
    const available = Array.isArray(models.data) && models.data.some((item) => item?.id === model);
    if (!available) throw new Error(`Go 模型列表中不存在 ${model}`);
  }

  const responses = await jsonRequest(`${base}/responses`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, max_output_tokens: 32, reasoning: { effort: 'none' }, input: 'Reply with the exact marker BRIDGE_RESPONSES_OK_7429.' })
  }, 'Responses 非流式');
  if (responses.object !== 'response' || !Array.isArray(responses.output)) throw new Error('Responses 转换结果结构无效');
  if (!responseOutputText(responses).includes('BRIDGE_RESPONSES_OK_7429')) throw new Error('Responses 转换结果缺少预期语义标记');

  let responsesStreamResponse;
  let parsedResponsesStream;
  let claude;
  let toolBlock;
  let claudeToolResult;
  let streamResponse;
  let parsedStream;
  if (profile === 'full') {
    responsesStreamResponse = await fetch(`${base}/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, stream: true, max_output_tokens: 32, reasoning: { effort: 'none' }, input: 'Reply with the exact marker BRIDGE_RESPONSES_STREAM_OK_7429.' }),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const responsesStreamText = await responsesStreamResponse.text();
    if (!responsesStreamResponse.ok) throw new Error(`Responses 流式请求返回 HTTP ${responsesStreamResponse.status}: ${responsesStreamText.slice(0, 500)}`);
    if (!responsesStreamResponse.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Responses 流式响应 Content-Type 无效');
    parsedResponsesStream = parseResponsesStream(responsesStreamText);
    if (!parsedResponsesStream.text.includes('BRIDGE_RESPONSES_STREAM_OK_7429')) throw new Error('Responses 流式响应缺少预期语义标记');
    if (!parsedResponsesStream.completed?.response?.usage) throw new Error('Responses 流式终态缺少 usage');

    claude = await jsonRequest(`${base}/messages`, {
      method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 48,
        messages: [{ role: 'user', content: 'Use the add tool to calculate 19 + 23. Do not answer directly.' }],
        tools: [{ name: 'add', description: 'Add two integers', input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
        tool_choice: { type: 'tool', name: 'add' }
      })
    }, 'Claude 工具调用');
    toolBlock = Array.isArray(claude.content) && claude.content.find((item) => item?.type === 'tool_use');
    if (!toolBlock || toolBlock.name !== 'add') throw new Error('Claude 工具调用未转换为 tool_use');
    if (Number(toolBlock.input?.a) !== 19 || Number(toolBlock.input?.b) !== 23) throw new Error('Claude 工具调用参数未完整保留');

    claudeToolResult = await jsonRequest(`${base}/messages`, {
      method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 48,
        messages: [
          { role: 'user', content: 'Use the add tool to calculate 19 + 23. Do not answer directly.' },
          { role: 'assistant', content: claude.content },
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: toolBlock.id, content: '42' },
            { type: 'text', text: 'The tool has completed. Reply with the exact marker BRIDGE_TOOL_RESULT_OK_7429.' }
          ] }
        ],
        tools: [{ name: 'add', description: 'Add two integers', input_schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
        tool_choice: { type: 'auto' }
      })
    }, 'Claude 工具结果回送');
    const toolResultText = claudeText(claudeToolResult);
    if (!toolResultText.includes('BRIDGE_TOOL_RESULT_OK_7429')) throw new Error('Claude 工具结果回送后缺少预期语义标记');
    if (claudeToolResult.stop_reason === 'tool_use') throw new Error('Claude 工具结果回送后意外再次调用工具');

    streamResponse = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, stream: true, reasoning_effort: 'none', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the exact marker BRIDGE_STREAM_OK_7429.' }] }),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const streamText = await streamResponse.text();
    if (!streamResponse.ok) throw new Error(`Chat 流式请求返回 HTTP ${streamResponse.status}: ${streamText.slice(0, 500)}`);
    if (!streamResponse.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Chat 流式响应 Content-Type 无效');
    parsedStream = parseChatStream(streamText);
    if (!parsedStream.done || !parsedStream.text.includes('BRIDGE_STREAM_OK_7429')) throw new Error('Chat 流式响应缺少正文语义标记或标准结束事件');
    if (!parsedStream.usage) throw new Error('Chat 流式响应缺少 usage，无法验证统计口径');
  }

  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: adminPassword }),
    signal: AbortSignal.timeout(10_000)
  });
  const loginText = await loginResponse.text();
  if (!loginResponse.ok) throw new Error(`管理登录返回 HTTP ${loginResponse.status}: ${loginText.slice(0, 500)}`);
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('管理登录未返回会话 Cookie');
  const stats = await jsonRequest(`http://127.0.0.1:${port}/api/stats?window=all`, { headers: { cookie } }, '管理统计读取');
  const goStats = stats.byProvider?.find((item) => item.name === 'go');
  const expectedRequests = profile === 'full' ? 5 : 1;
  if (stats.summary?.requests !== expectedRequests || stats.summary?.usageRequests !== expectedRequests || goStats?.requests !== expectedRequests) {
    throw new Error(`管理面板统计未覆盖 ${expectedRequests} 次在线协议请求`);
  }
  if (stats.summary.inputTokens !== stats.summary.uncachedInputTokens + stats.summary.cachedInputTokens) throw new Error('缓存统计的输入 Token 口径不守恒');

  console.log(JSON.stringify({
    ok: true,
    provider: 'go',
    model,
    profile,
    checks: {
      models: discoverModels ? true : profile === 'quick' ? 'skipped (quick)' : 'skipped',
      responses: { status: responses.status, semanticMarker: true, inputTokens: responses.usage?.input_tokens ?? null, outputTokens: responses.usage?.output_tokens ?? null },
      ...(profile === 'full' ? {
        responsesStream: { semanticMarker: true, events: parsedResponsesStream.events.length, sequenceNumbers: true, usage: parsedResponsesStream.completed.response.usage },
        claudeTool: { stopReason: claude.stop_reason, tool: toolBlock.name, input: toolBlock.input },
        claudeToolResult: { stopReason: claudeToolResult.stop_reason, semanticMarker: true },
        chatStream: { contentType: streamResponse.headers.get('content-type'), semanticMarker: true, done: parsedStream.done, usage: parsedStream.usage }
      } : {}),
      stats: { requests: stats.summary.requests, usageCoverageRate: stats.summary.usageCoverageRate, totalTokens: stats.summary.totalTokens, cachedInputTokens: stats.summary.cachedInputTokens, cacheReadRate: stats.summary.cacheReadRate }
    }
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  const exit = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  const exited = await Promise.race([
    exit.then(() => true).catch(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 2000))
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exit, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]).catch(() => {});
  }
  await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await unlink(logFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

if (failure) {
  console.error(failure.stack || failure.message);
  process.exitCode = 1;
}

function responseOutputText(body) {
  return (body.output || []).flatMap((item) => item?.type === 'message' ? item.content || [] : [])
    .filter((part) => ['output_text', 'text', 'refusal'].includes(part?.type))
    .map((part) => part.text || part.refusal || '').join('');
}

function claudeText(body) {
  return (Array.isArray(body.content) ? body.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '').join('');
}

function parseResponsesStream(text) {
  const events = text.split(/(?:\r\n|\r|\n){2}/).filter(Boolean).map((block) => {
    const line = block.split(/\r\n|\r|\n/).find((candidate) => candidate.startsWith('data:'));
    if (!line) throw new Error(`Responses SSE 事件缺少 data：${block.slice(0, 200)}`);
    try { return JSON.parse(line.slice(5).trimStart()); }
    catch { throw new Error(`Responses SSE 包含无效 JSON：${line.slice(5, 205)}`); }
  });
  if (!events.length || events[0].type !== 'response.created') throw new Error('Responses SSE 缺少 response.created 首事件');
  if (!events.every((event, index) => event.sequence_number === index)) throw new Error('Responses SSE sequence_number 不连续');
  const deltas = events.filter((event) => event.type === 'response.output_text.delta');
  if (!deltas.length || deltas.some((event) => !Array.isArray(event.logprobs))) throw new Error('Responses 文本 delta 缺少标准 logprobs 数组');
  const completed = events.findLast((event) => ['response.completed', 'response.incomplete'].includes(event.type));
  if (!completed) throw new Error('Responses SSE 缺少终态事件');
  if (completed.response?.parallel_tool_calls !== true || completed.response?.tool_choice !== 'auto' || !Array.isArray(completed.response?.tools)) throw new Error('Responses 流式终态缺少标准响应字段');
  return { events, completed, text: deltas.map((event) => event.delta || '').join('') };
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

async function jsonRequest(url, options, label = 'JSON 请求') {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) }); }
  catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`${label} 在 ${requestTimeoutMs}ms 内未收到响应`, { cause: error });
    throw new Error(`${label} 请求失败：${error.message}`, { cause: error });
  }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`${label} 返回 HTTP ${response.status} 的无效 JSON: ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`${label} 返回 HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

function environmentTimeout(value) {
  if (value === undefined || value === '') return 60_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 10_000 || timeout > 600_000) throw new Error('OPENCODE_LIVE_TIMEOUT_MS 必须是 10000–600000 之间的整数');
  return timeout;
}

function environmentProfile(value) {
  const profile = String(value || 'full').trim().toLowerCase();
  if (profile === 'full' || profile === 'quick') return profile;
  throw new Error('OPENCODE_LIVE_PROFILE 只能是 full 或 quick');
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
