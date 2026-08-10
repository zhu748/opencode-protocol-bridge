import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { createOpenCodeConfig, SDK_BY_PROTOCOL } from '../public/opencode-config.js';
import { OPENCODE_GO_MODEL_CAPABILITIES, OPENCODE_ZEN_MODEL_CAPABILITIES } from '../src/model-capabilities.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROBE_PREFIX = 'opencode-bridge-cli-probe-';
const PROBE_MODEL = 'cli-probe';
const PROBE_TEXT = 'CLI_PROTOCOL_PROBE';
const PROBE_REASONING = 'CLI_REASONING_PROBE';
const PROBE_ENCRYPTED_REASONING = 'CLI_ENCRYPTED_REASONING_PROBE';
const PROBE_CLAUDE_SIGNATURE = 'CLI_CLAUDE_SIGNATURE_PROBE';
const PROBE_CLAUDE_REDACTED = 'CLI_CLAUDE_REDACTED_PROBE';
const PROBE_GEMINI_SIGNATURE = 'CLI_GEMINI_SIGNATURE_PROBE';
const OPENCODE_TOOL_PROMPT = `Use the read tool to inspect package.json, then reply with ${PROBE_TEXT}.`;
const OPENCODE_NATIVE_MODELS = Object.freeze({
  responses: 'gpt-5.6-luna',
  claude: 'minimax-m3',
  chat: 'deepseek-v4-flash'
});
const OPENCODE_NATIVE_GEMINI_MODEL = 'gemini-3.6-flash';
const BRIDGE_CHAT_MODEL = OPENCODE_NATIVE_MODELS.chat;
const OPENCODE_CROSS_MODELS = Object.freeze({
  responsesToClaude: Object.freeze({ model: 'probe-responses-to-claude', incoming: 'responses', target: 'claude' }),
  responsesToChat: Object.freeze({ model: 'probe-responses-to-chat', incoming: 'responses', target: 'chat' }),
  responsesToGemini: Object.freeze({ model: 'probe-responses-to-gemini', incoming: 'responses', target: 'gemini' }),
  claudeToResponses: Object.freeze({ model: 'probe-claude-to-responses', incoming: 'claude', target: 'responses' }),
  claudeToChat: Object.freeze({ model: 'probe-claude-to-chat', incoming: 'claude', target: 'chat' }),
  claudeToGemini: Object.freeze({ model: 'probe-claude-to-gemini', incoming: 'claude', target: 'gemini' }),
  chatToResponses: Object.freeze({ model: 'probe-chat-to-responses', incoming: 'chat', target: 'responses' }),
  chatToClaude: Object.freeze({ model: 'probe-chat-to-claude', incoming: 'chat', target: 'claude' }),
  chatToGemini: Object.freeze({ model: 'probe-chat-to-gemini', incoming: 'chat', target: 'gemini' }),
  geminiToResponses: Object.freeze({ model: 'probe-gemini-to-responses', incoming: 'gemini', target: 'responses' }),
  geminiToClaude: Object.freeze({ model: 'probe-gemini-to-claude', incoming: 'gemini', target: 'claude' }),
  geminiToChat: Object.freeze({ model: 'probe-gemini-to-chat', incoming: 'gemini', target: 'chat' })
});
const CROSS_PROTOCOLS = Object.freeze(['responses', 'claude', 'chat', 'gemini']);
assertCompleteCrossProtocolMatrix(OPENCODE_CROSS_MODELS);
const BRIDGE_TOKEN = 'bridgeprobe123';
const ADMIN_PASSWORD = 'bridgeprobe123';
const UPSTREAM_KEY = 'upstreamprobe123';
const COMMAND_TIMEOUT_MS = 45_000;

function assertCompleteCrossProtocolMatrix(models) {
  const expected = new Set(CROSS_PROTOCOLS.flatMap((incoming) => (
    CROSS_PROTOCOLS.filter((target) => target !== incoming).map((target) => `${incoming}->${target}`)
  )));
  const actual = new Set(Object.values(models).map(({ incoming, target }) => `${incoming}->${target}`));
  const missing = [...expected].filter((pair) => !actual.has(pair));
  const unexpected = [...actual].filter((pair) => !expected.has(pair));
  if (actual.size !== expected.size || Object.keys(models).length !== expected.size || missing.length || unexpected.length) {
    throw new Error(`跨协议真实 CLI 矩阵不完整：缺少 ${missing.join(', ') || '无'}；多余/重复 ${unexpected.join(', ') || '无'}`);
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), PROBE_PREFIX));
const children = new Set();
let directServer;
let upstreamServer;
let bridge;

try {
  const directCaptures = [];
  let directCodexTurns = 0;
  let directClaudeTurns = 0;
  const openCodeToolTurns = new Map();
  directServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    if (req.method === 'GET' && ['/models', '/v1/models'].includes(pathname)) return modelList(res);
    if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') return json(res, 200, { input_tokens: 1 });
    const geminiMatch = pathname.match(/^\/zen\/v1\/models\/([^:]+):(streamGenerateContent|generateContent)$/);
    const protocol = pathname.endsWith('/responses') ? 'responses'
      : pathname.endsWith('/messages') ? 'claude'
        : pathname.endsWith('/chat/completions') ? 'chat'
          : geminiMatch ? 'gemini'
          : null;
    if (req.method !== 'POST' || !protocol) return json(res, 404, { error: { message: 'probe route not found' } });
    const body = await requestJson(req);
    const capturedBody = protocol === 'gemini'
      ? { ...body, model: decodeURIComponent(geminiMatch[1]), stream: geminiMatch[2] === 'streamGenerateContent' }
      : body;
    directCaptures.push({ path: pathname, search: requestUrl.search, body: capturedBody });
    if (pathname === '/v1/responses') return directCodexTurns++ === 0
      ? responsesToolSse(res, body.model, 'shell_command', { command: 'Write-Output CLI_TOOL_PROBE' })
      : responsesSse(res, body.model);
    if (pathname === '/v1/messages') return directClaudeTurns++ === 0
      ? claudeToolSse(res, body.model, 'Read', { file_path: join(ROOT, 'package.json') })
      : claudeSse(res, body.model);
    if (Object.values(OPENCODE_NATIVE_MODELS).includes(body.model) && Array.isArray(body.tools) && body.tools.length > 0) {
      const turn = openCodeToolTurns.get(body.model) || 0;
      openCodeToolTurns.set(body.model, turn + 1);
      if (turn === 0) {
        const input = { filePath: join(tempRoot, 'opencode-workspace', 'probe.txt') };
        if (protocol === 'responses') return responsesToolSse(res, body.model, 'read', input, { opaqueReasoning: true });
        if (protocol === 'claude') return claudeToolSse(res, body.model, 'read', input, { opaqueReasoning: true });
        return chatToolSse(res, body.model, 'read', input);
      }
    }
    if (protocol === 'gemini' && Array.isArray(body.tools) && body.tools.length > 0) {
      const turn = openCodeToolTurns.get(OPENCODE_NATIVE_GEMINI_MODEL) || 0;
      openCodeToolTurns.set(OPENCODE_NATIVE_GEMINI_MODEL, turn + 1);
      if (turn === 0) {
        return geminiToolSse(res, OPENCODE_NATIVE_GEMINI_MODEL, 'read', {
          filePath: join(tempRoot, 'opencode-workspace', 'probe.txt')
        });
      }
    }
    if (protocol === 'responses') return responsesSse(res, body.model);
    if (protocol === 'claude') return claudeSse(res, body.model);
    if (protocol === 'gemini') return geminiSse(res, OPENCODE_NATIVE_GEMINI_MODEL);
    return chatSse(res, body.model);
  });
  const directPort = await listen(directServer);
  const directBase = `http://127.0.0.1:${directPort}`;

  const codexDirect = await runCodex(directBase, tempRoot);
  const claudeDirect = await runClaude(directBase, tempRoot);
  assertCliSuccess('Codex CLI 原生 Responses 探针', codexDirect);
  assertCliSuccess('Claude Code 原生 Messages 探针', claudeDirect);

  const codexCaptures = directCaptures.filter((entry) => entry.path === '/v1/responses');
  const claudeCaptures = directCaptures.filter((entry) => entry.path === '/v1/messages');
  const codexRequests = codexCaptures.map((entry) => entry.body);
  const claudeRequests = claudeCaptures.map((entry) => entry.body);
  const codexRequest = codexRequests[0];
  const claudeRequest = claudeRequests[0];
  if (!codexRequest) throw new Error('Codex CLI 未发送 /v1/responses 请求');
  if (!claudeRequest) throw new Error('Claude Code 未发送 /v1/messages 请求');
  if (codexRequests.length < 2) throw new Error('Codex CLI 未在工具调用后发送第二轮 Responses 请求');
  if (claudeRequests.length < 2) throw new Error('Claude Code 未在工具调用后发送第二轮 Messages 请求');
  if (claudeCaptures.some((entry) => entry.search !== '?beta=true')) {
    throw new Error(`Claude Code Messages 请求未使用 Beta SDK 路由：${JSON.stringify(claudeCaptures.map((entry) => entry.search))}`);
  }
  const replayedCodexCall = (Array.isArray(codexRequests[1].input) ? codexRequests[1].input : [])
    .find((item) => item?.type === 'function_call');
  const replayedCodexOutput = (Array.isArray(codexRequests[1].input) ? codexRequests[1].input : [])
    .find((item) => item?.type === 'function_call_output');
  if (replayedCodexCall?.id !== 'fc_probe' || replayedCodexCall?.call_id !== 'call_probe'
    || (replayedCodexCall.status !== undefined && replayedCodexCall.status !== 'completed')) {
    throw new Error(`Codex CLI 第二轮未保留 Responses function_call 的 id/call_id，或改写了可选 status：${JSON.stringify(replayedCodexCall)}`);
  }
  if (replayedCodexOutput?.call_id !== 'call_probe') {
    throw new Error(`Codex CLI 第二轮 function_call_output 未关联原调用：${JSON.stringify(replayedCodexOutput)}`);
  }

  for (const [protocol, model] of Object.entries(OPENCODE_NATIVE_MODELS)) {
    const result = await runOpenCode(directBase, tempRoot, model);
    assertCliSuccess(`OpenCode ${protocol} 原生路由探针`, result);
  }
  const openCodeNativeRoutes = Object.fromEntries(Object.entries(OPENCODE_NATIVE_MODELS).map(([protocol, model]) => {
    const captures = directCaptures.filter((entry) => entry.body?.model === model);
    const agentCaptures = captures.filter((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0);
    const capture = agentCaptures[0] || captures.at(-1);
    if (!capture) throw new Error(`OpenCode 未发送 ${model} 请求`);
    const expected = `/go/v1/${protocol === 'claude' ? 'messages' : protocol === 'chat' ? 'chat/completions' : 'responses'}`;
    if (capture.path !== expected) throw new Error(`OpenCode ${model} 路由错误：预期 ${expected}，实际 ${capture.path}`);
    if (agentCaptures.length < 2) throw new Error(`OpenCode ${model} 未在 read 工具执行后发送第二轮请求`);
    if (!hasToolResult(agentCaptures[1].body, protocol)) throw new Error(`OpenCode ${model} 第二轮请求缺少 ${protocol} 工具结果`);
    const reasoningRoundTripDetails = inspectReasoningRoundTrip(agentCaptures[1].body, protocol);
    const reasoningRoundTrip = reasoningRoundTripDetails.present;
    if (!reasoningRoundTrip) throw new Error(`OpenCode ${model} 第二轮 ${protocol} 请求未回传推理状态`);
    if (protocol === 'responses' && reasoningRoundTripDetails.encryptedContent !== PROBE_ENCRYPTED_REASONING) {
      throw new Error(`OpenCode ${model} 第二轮 Responses 请求未原样回传 encrypted_content`);
    }
    if (protocol === 'claude' && (
      reasoningRoundTripDetails.signature !== PROBE_CLAUDE_SIGNATURE
      || reasoningRoundTripDetails.redactedData !== PROBE_CLAUDE_REDACTED
    )) {
      throw new Error(`OpenCode ${model} 第二轮 Claude 请求未原样回传 signature/redacted_thinking`);
    }
    return [protocol, {
      model,
      path: capture.path,
      stream: capture.body.stream === true,
      requestCount: captures.length,
      toolFreeRequestCount: captures.filter((entry) => !Array.isArray(entry.body?.tools) || entry.body.tools.length === 0).length,
      agentRequestCount: agentCaptures.length,
      toolResultRoundTrip: true,
      reasoningRoundTrip,
      reasoningRoundTripDetails,
      tools: summarizeRequestTools(capture.body, protocol)
    }];
  }));

  const nativeGeminiConfig = createOpenCodeConfig(directBase, OPENCODE_GO_MODEL_CAPABILITIES, [], {
    zenCapabilities: OPENCODE_ZEN_MODEL_CAPABILITIES
  });
  const openCodeGemini = await runOpenCode(directBase, tempRoot, OPENCODE_NATIVE_GEMINI_MODEL, {
    config: nativeGeminiConfig, providerID: 'bridge-zen'
  });
  assertCliSuccess('OpenCode Gemini 原生路由探针', openCodeGemini);
  const geminiCaptures = directCaptures.filter((entry) => entry.body?.model === OPENCODE_NATIVE_GEMINI_MODEL);
  const geminiAgentCaptures = geminiCaptures.filter((entry) => geminiToolNames(entry.body).includes('read'));
  const expectedGeminiPath = `/zen/v1/models/${OPENCODE_NATIVE_GEMINI_MODEL}:streamGenerateContent`;
  if (!geminiCaptures.length || geminiCaptures.some((entry) => entry.path !== expectedGeminiPath || entry.search !== '?alt=sse')) {
    throw new Error(`OpenCode Gemini 路由错误：预期 ${expectedGeminiPath}?alt=sse，实际 ${JSON.stringify(geminiCaptures.map((entry) => `${entry.path}${entry.search}`))}`);
  }
  if (geminiAgentCaptures.length < 2) throw new Error('OpenCode Gemini 未在 read 工具执行后发送第二轮请求');
  if (!hasGeminiToolResult(geminiAgentCaptures[1].body)) throw new Error('OpenCode Gemini 第二轮请求缺少 functionResponse');
  if (!hasGeminiThoughtSignature(geminiAgentCaptures[1].body, PROBE_GEMINI_SIGNATURE)) {
    throw new Error('OpenCode Gemini 第二轮请求未原样回传 thoughtSignature');
  }
  openCodeNativeRoutes.gemini = {
    model: OPENCODE_NATIVE_GEMINI_MODEL,
    path: expectedGeminiPath,
    stream: true,
    requestCount: geminiCaptures.length,
    agentRequestCount: geminiAgentCaptures.length,
    toolResultRoundTrip: true,
    reasoningRoundTrip: true,
    tools: { count: geminiToolNames(geminiAgentCaptures[0].body).length, names: geminiToolNames(geminiAgentCaptures[0].body) }
  };

  const upstreamCaptures = [];
  let bridgeCodexTurns = 0;
  let bridgeClaudeTurns = 0;
  const crossToolTurns = new Map();
  upstreamServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/models') return modelList(res);
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const geminiMatch = requestUrl.pathname.match(/^\/models\/([^:]+):(streamGenerateContent|generateContent)$/);
    const protocol = requestUrl.pathname === '/responses' ? 'responses'
      : requestUrl.pathname === '/messages' ? 'claude'
        : requestUrl.pathname === '/chat/completions' ? 'chat'
          : geminiMatch ? 'gemini'
            : null;
    if (req.method !== 'POST' || !protocol) return json(res, 404, { error: { message: 'probe upstream route not found' } });
    const body = await requestJson(req);
    const capturedBody = protocol === 'gemini'
      ? { ...body, model: decodeURIComponent(geminiMatch[1]), stream: geminiMatch[2] === 'streamGenerateContent' }
      : body;
    upstreamCaptures.push({ path: `${requestUrl.pathname}${requestUrl.search}`, body: capturedBody });
    const cross = Object.values(OPENCODE_CROSS_MODELS).find((item) => item.model === capturedBody.model);
    const toolNames = summarizeRequestTools(body, protocol).names;
    if (cross && toolNames.includes('read')) {
      const turn = crossToolTurns.get(capturedBody.model) || 0;
      crossToolTurns.set(capturedBody.model, turn + 1);
      if (turn === 0) {
        const input = { filePath: join(tempRoot, 'opencode-workspace', 'probe.txt') };
        if (protocol === 'responses') return responsesToolSse(res, capturedBody.model, 'read', input, { opaqueReasoning: true });
        if (protocol === 'claude') return claudeToolSse(res, capturedBody.model, 'read', input, { opaqueReasoning: true });
        if (protocol === 'gemini') return geminiToolSse(res, capturedBody.model, 'read', input);
        return chatToolSse(res, capturedBody.model, 'read', input);
      }
    }
    if (protocol === 'chat' && toolNames.includes('shell_command') && bridgeCodexTurns++ === 0) {
      return chatToolSse(res, body.model, 'shell_command', { command: 'Write-Output CLI_TOOL_PROBE' });
    }
    if (protocol === 'chat' && toolNames.includes('Read') && bridgeClaudeTurns++ === 0) {
      return chatToolSse(res, body.model, 'Read', { file_path: join(ROOT, 'package.json') });
    }
    if (protocol === 'responses') return responsesSse(res, capturedBody.model);
    if (protocol === 'claude') return claudeSse(res, capturedBody.model);
    if (protocol === 'gemini') return geminiSse(res, capturedBody.model);
    return chatSse(res, capturedBody.model);
  });
  const upstreamPort = await listen(upstreamServer);
  const bridgePort = await freePort();
  const configFile = join(tempRoot, 'bridge-config.json');
  const logFile = join(tempRoot, 'bridge-logs.json');
  bridge = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: bridgeEnvironment(process.env, { bridgePort, upstreamPort, configFile, logFile }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(bridge);
  await waitForBridge(bridge, bridgePort);
  await configureBridge(bridgePort);

  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  const codexBridge = await runCodex(bridgeBase, tempRoot);
  const claudeBridge = await runClaude(bridgeBase, tempRoot);
  assertCliSuccess('Codex CLI → Bridge → Chat 探针', codexBridge);
  assertCliSuccess('Claude Code → Bridge → Chat 探针', claudeBridge);
  if (upstreamCaptures.length !== 4) throw new Error(`预期收到 4 个 Chat 上游请求，实际 ${upstreamCaptures.length} 个`);
  const bridgeChatRequests = upstreamCaptures.map((entry) => summarizeChatRequest(entry.body));
  const bridgeClaudeRequests = upstreamCaptures.filter((entry) => summarizeRequestTools(entry.body, 'chat').names.includes('Read'));
  if (bridgeClaudeRequests.length !== 2 || bridgeClaudeRequests.some((entry) => (
    entry.body.model !== BRIDGE_CHAT_MODEL || entry.body.reasoning_effort !== 'max'
  ))) {
    throw new Error(`Claude Code max 思考强度未完整传给 ${BRIDGE_CHAT_MODEL}：${JSON.stringify(bridgeClaudeRequests.map((entry) => summarizeChatRequest(entry.body)))}`);
  }

  const crossConfig = createOpenCodeCrossConfig(bridgeBase);
  const crossCliResults = new Map();
  for (const item of Object.values(OPENCODE_CROSS_MODELS)) {
    const result = await runOpenCode(bridgeBase, tempRoot, item.model, { config: crossConfig, providerID: 'bridge-cross' });
    crossCliResults.set(item.model, result);
    assertCliSuccess(`OpenCode ${item.incoming} → Bridge → ${item.target} 探针`, result);
  }
  const openCodeBridgeConversions = Object.fromEntries(Object.entries(OPENCODE_CROSS_MODELS).map(([name, item]) => {
    const captures = upstreamCaptures.filter((entry) => entry.body?.model === item.model);
    const agentCaptures = captures.filter((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0);
    const expectedPath = item.target === 'responses' ? '/responses'
      : item.target === 'claude' ? '/messages'
        : item.target === 'gemini' ? `/models/${item.model}:streamGenerateContent?alt=sse`
          : '/chat/completions';
    if (captures.some((entry) => entry.path !== expectedPath)) {
      throw new Error(`${item.model} 上游路由错误：预期全部为 ${expectedPath}`);
    }
    const firstAgentCapture = agentCaptures[0];
    const resultCapture = captures.find((entry, index) => index > captures.indexOf(firstAgentCapture) && hasToolResult(entry.body, item.target));
    if (!firstAgentCapture || !resultCapture) {
      const details = captures.map((entry) => ({ path: entry.path, tools: summarizeRequestTools(entry.body, item.target).names, hasToolResult: hasToolResult(entry.body, item.target) }));
      const cli = crossCliResults.get(item.model);
      throw new Error(`${item.model} 跨协议 read 工具未形成完整的调用/结果两轮：${JSON.stringify(details)}；CLI=${String(cli?.stdout || cli?.stderr || '').slice(-4000)}`);
    }
    if (!hasToolResult(resultCapture.body, item.target)) {
      throw new Error(`${item.model} 转为 ${item.target} 后的第二轮请求缺少工具结果`);
    }
    const reasoningRoundTripDetails = inspectReasoningRoundTrip(resultCapture.body, item.target);
    if (!reasoningRoundTripDetails.present) throw new Error(`${item.model} 转为 ${item.target} 后的第二轮请求缺少推理状态：${JSON.stringify(resultCapture.body.messages || resultCapture.body.input || resultCapture.body.contents)}`);
    if (item.target === 'responses' && reasoningRoundTripDetails.encryptedContent !== PROBE_ENCRYPTED_REASONING) {
      throw new Error(`${item.model} 转为 Responses 后未还原原始 encrypted_content`);
    }
    if (item.target === 'claude' && (
      reasoningRoundTripDetails.signature !== PROBE_CLAUDE_SIGNATURE
      || reasoningRoundTripDetails.redactedData !== PROBE_CLAUDE_REDACTED
    )) throw new Error(`${item.model} 转为 Claude 后未还原原始 thinking 状态：${JSON.stringify(reasoningRoundTripDetails)}；${JSON.stringify(resultCapture.body.messages)}`);
    if (item.target === 'gemini' && reasoningRoundTripDetails.thoughtSignature !== PROBE_GEMINI_SIGNATURE) {
      throw new Error(`${item.model} 转为 Gemini 后未原样回传 thoughtSignature`);
    }
    const representative = agentCaptures[0] || captures[0];
    return [name, {
      model: item.model,
      conversion: `${item.incoming}->${item.target}`,
      upstreamPath: expectedPath,
      requestCount: captures.length,
      agentRequestCount: agentCaptures.length,
      toolResultRoundTrip: true,
      reasoningRoundTripDetails,
      reasoning: summarizeTargetReasoning(representative.body, item.target),
      tools: summarizeRequestTools(agentCaptures[0].body, item.target)
    }];
  }));

  const report = {
    codex: summarizeResponsesRequest(codexRequest),
    codexContinuation: summarizeResponsesRequest(codexRequests[1]),
    claudeCode: { endpointQuery: claudeCaptures[0].search, ...summarizeClaudeRequest(claudeRequest) },
    claudeCodeContinuation: { endpointQuery: claudeCaptures[1].search, ...summarizeClaudeRequest(claudeRequests[1]) },
    openCodeNativeRoutes,
    openCodeBridgeConversions,
    bridgeChatRequests
  };
  process.stdout.write(`真实 CLI 隔离探针通过\n${JSON.stringify(report, null, 2)}\n`);
} finally {
  const exits = [];
  for (const child of children) {
    if (!child.killed && child.exitCode == null) {
      exits.push(new Promise((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 2000);
        child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
      }));
      child.kill();
    }
  }
  await Promise.all(exits);
  await Promise.all([closeServer(directServer), closeServer(upstreamServer)]);
  const resolvedTemp = resolve(tempRoot);
  if (dirname(resolvedTemp) !== resolve(tmpdir()) || !basename(resolvedTemp).startsWith(PROBE_PREFIX)) {
    throw new Error(`拒绝清理非探针临时目录：${resolvedTemp}`);
  }
  try {
    await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`CLI 探针临时目录清理失败，已保留 ${resolvedTemp}：${error.message}\n`);
  }
}

function bridgeEnvironment(source, { bridgePort, upstreamPort, configFile, logFile }) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^OPENCODE_(?:ZEN|GO)_(?:KEYS?|KEY_\d+|PROXY_URLS?|PROXY_URL_\d+)$/i.test(key)) delete env[key];
  }
  return {
    ...env,
    HOST: '127.0.0.1',
    PORT: String(bridgePort),
    CONFIG_FILE: configFile,
    LOG_FILE: logFile,
    OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    OPENCODE_BRIDGE_REQUIRE_ENV_BOOTSTRAP: 'false',
    OPENCODE_BRIDGE_IMAGE_HANDOFF: 'false',
    OPENCODE_BRIDGE_KEEP_ALIVE_URL: ''
  };
}

async function configureBridge(port) {
  const setup = await fetch(`http://127.0.0.1:${port}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  if (!setup.ok) throw new Error(`Bridge 初始化失败：HTTP ${setup.status}`);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  const saved = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      defaultProvider: 'zen', proxyUrl: '', zenKey: UPSTREAM_KEY, goKey: '', clientToken: BRIDGE_TOKEN,
      requestLogLimit: 10, persistLogs: false, upstreamTimeoutMs: 10_000, maxConcurrentRequests: 4,
      modelRoutes: {
        [PROBE_MODEL]: { provider: 'zen', protocol: 'chat', upstreamModel: BRIDGE_CHAT_MODEL },
        ...Object.fromEntries(Object.values(OPENCODE_CROSS_MODELS).map((item) => [item.model, {
          provider: 'zen', protocol: item.target, upstreamModel: item.model
        }]))
      },
      promptRewriteRules: []
    })
  });
  if (!saved.ok) throw new Error(`Bridge 配置失败：HTTP ${saved.status} ${(await saved.text()).slice(0, 200)}`);
}

async function runCodex(baseUrl, parentTemp) {
  const home = join(parentTemp, `codex-${Math.random().toString(16).slice(2)}`);
  const workspace = join(parentTemp, 'workspace');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return runCommand(codexCommand(), [
    'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
    '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'plugin_sharing', '--disable', 'apps',
    '--sandbox', 'read-only', '--cd', workspace, '--model', PROBE_MODEL,
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="bridge_probe"',
    '-c', 'model_providers.bridge_probe.name="Bridge Probe"',
    '-c', `model_providers.bridge_probe.base_url="${baseUrl}/v1"`,
    '-c', 'model_providers.bridge_probe.env_key="BRIDGE_PROBE_API_KEY"',
    '-c', 'model_providers.bridge_probe.wire_api="responses"',
    '-c', 'model_providers.bridge_probe.requires_openai_auth=false',
    PROBE_TEXT
  ], { ...process.env, CODEX_HOME: home, BRIDGE_PROBE_API_KEY: BRIDGE_TOKEN });
}

function codexCommand() {
  if (process.platform !== 'win32') return 'codex';
  const native = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  return existsSync(native) ? native : 'codex.cmd';
}

async function runClaude(baseUrl, parentTemp) {
  const home = join(parentTemp, `claude-${Math.random().toString(16).slice(2)}`);
  await mkdir(home, { recursive: true });
  return runCommand(process.platform === 'win32' ? 'claude.exe' : 'claude', [
    '--print', '--bare', '--no-session-persistence', '--output-format', 'json', '--model', PROBE_MODEL,
    '--system-prompt', 'You are a protocol compatibility probe.', PROBE_TEXT
  ], {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: BRIDGE_TOKEN,
    ANTHROPIC_AUTH_TOKEN: BRIDGE_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1'
  });
}

async function runOpenCode(baseUrl, parentTemp, model, { config: suppliedConfig, providerID = 'bridge-go' } = {}) {
  const home = join(parentTemp, `opencode-${model}-${Math.random().toString(16).slice(2)}`);
  const workspace = join(parentTemp, 'opencode-workspace');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(join(workspace, 'probe.txt'), PROBE_TEXT, 'utf8');
  const config = suppliedConfig || createOpenCodeConfig(baseUrl, OPENCODE_GO_MODEL_CAPABILITIES);
  config.snapshot = false;
  config.share = 'disabled';
  config.autoupdate = false;
  return runCommand(opencodeCommand(), [
    'run', '--pure', '--format', 'json', '--model', `${providerID}/${model}`, '--agent', 'build',
    '--dangerously-skip-permissions', '--dir', workspace, OPENCODE_TOOL_PROMPT
  ], {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_BRIDGE_TOKEN: BRIDGE_TOKEN
  });
}

function createOpenCodeCrossConfig(baseUrl) {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      'bridge-cross': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Bridge Cross Protocol Probe',
        options: { baseURL: `${baseUrl}/zen/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' },
        models: Object.fromEntries(Object.values(OPENCODE_CROSS_MODELS).map((item) => [item.model, {
          name: item.model,
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 100_000, output: 10_000 },
          modalities: { input: ['text'], output: ['text'] },
          provider: { npm: SDK_BY_PROTOCOL[item.incoming] }
        }]))
      }
    }
  };
}

function opencodeCommand() {
  if (process.platform !== 'win32') return 'opencode';
  const native = join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return existsSync(native) ? native : 'opencode.cmd';
}

function runCommand(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, windowsHide: true, shell: process.platform === 'win32' && command.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const stdout = [];
    const stderr = [];
    const append = (target, chunk) => {
      if (target.reduce((sum, item) => sum + item.length, 0) < 1024 * 1024) target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolvePromise({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function assertCliSuccess(label, result) {
  if (result.code === 0 && result.stdout.includes(PROBE_TEXT)) return;
  const detail = `${result.stderr}\n${result.stdout}`.replaceAll(BRIDGE_TOKEN, '[REDACTED]').slice(0, 2000);
  throw new Error(`${label}失败（exit=${result.code}, signal=${result.signal || 'none'}）：${detail}`);
}

async function waitForBridge(child, port) {
  const deadline = Date.now() + 15_000;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Bridge 提前退出：${child.exitCode} ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* 等待监听完成 */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`等待 Bridge 启动超时：${stderr}`);
}

async function requestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function responsesSse(res, model) {
  const item = { id: 'msg_probe', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: PROBE_TEXT, annotations: [] }] };
  const response = { id: 'resp_probe', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [item], parallel_tool_calls: true, tool_choice: 'auto', tools: [], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } };
  const events = [
    ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: PROBE_TEXT, logprobs: [] }],
    ['response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: PROBE_TEXT, logprobs: [] }],
    ['response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response }]
  ];
  eventStream(res, events);
}

function responsesToolSse(res, model, name, args, { opaqueReasoning = false } = {}) {
  const argumentsText = JSON.stringify(args);
  const item = { id: 'fc_probe', type: 'function_call', status: 'completed', call_id: 'call_probe', name, arguments: argumentsText };
  const reasoning = { id: 'rs_probe', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: PROBE_REASONING }], encrypted_content: PROBE_ENCRYPTED_REASONING };
  const output = opaqueReasoning ? [reasoning, item] : [item];
  const toolIndex = opaqueReasoning ? 1 : 0;
  const response = { id: 'resp_probe_tool', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output, parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: opaqueReasoning ? 1 : 0 }, total_tokens: 2 } };
  const events = [
    ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } }],
  ];
  if (opaqueReasoning) {
    events.push(
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress', summary: [] } }],
      ['response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }],
      ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, summary_index: 0, delta: PROBE_REASONING }],
      ['response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: reasoning.id, output_index: 0, summary_index: 0, text: PROBE_REASONING }],
      ['response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: reasoning.id, output_index: 0, summary_index: 0, part: reasoning.summary[0] }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: reasoning }]
    );
  }
  events.push(
    ['response.output_item.added', { type: 'response.output_item.added', output_index: toolIndex, item: { ...item, status: 'in_progress', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: toolIndex, delta: argumentsText }],
    ['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: toolIndex, arguments: argumentsText }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: toolIndex, item }],
    ['response.completed', { type: 'response.completed', response }]
  );
  eventStream(res, events);
}

function claudeSse(res, model) {
  eventStream(res, [
    ['message_start', { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PROBE_TEXT } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ]);
}

function claudeToolSse(res, model, name, input, { opaqueReasoning = false } = {}) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_probe_tool', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ];
  if (opaqueReasoning) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: PROBE_REASONING } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: PROBE_CLAUDE_SIGNATURE } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: PROBE_CLAUDE_REDACTED } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }]
    );
  }
  const toolIndex = opaqueReasoning ? 2 : 0;
  events.push(
    ['content_block_start', { type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: 'toolu_probe', name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: toolIndex }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  );
  eventStream(res, events);
}

function chatSse(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'chat_probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: PROBE_REASONING }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chat_probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: PROBE_TEXT }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chat_probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function chatToolSse(res, model, name, args) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'chat_probe_tool', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: PROBE_REASONING, reasoning_details: [
    { type: 'reasoning.text', text: PROBE_REASONING, signature: PROBE_CLAUDE_SIGNATURE, id: 'reasoning-text-probe', format: 'anthropic-claude-v1', index: 0 },
    { type: 'reasoning.encrypted', data: PROBE_ENCRYPTED_REASONING, id: 'reasoning-encrypted-probe', format: 'anthropic-claude-v1', index: 1 }
  ], tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chat_probe_tool', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'chat_probe_tool', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function geminiSse(res, model) {
  geminiEventStream(res, [
    {
      responseId: 'gemini_probe', modelVersion: model,
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: PROBE_TEXT }] } }]
    },
    {
      responseId: 'gemini_probe', modelVersion: model,
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    }
  ]);
}

function geminiToolSse(res, model, name, args) {
  geminiEventStream(res, [
    {
      responseId: 'gemini_probe_tool', modelVersion: model,
      candidates: [{ index: 0, content: { role: 'model', parts: [{
        functionCall: { id: 'call_probe', name, args }, thoughtSignature: PROBE_GEMINI_SIGNATURE
      }] } }]
    },
    {
      responseId: 'gemini_probe_tool', modelVersion: model,
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 1, totalTokenCount: 3 }
    }
  ]);
}

function geminiEventStream(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end();
}

function eventStream(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  events.forEach(([event, data], sequence_number) => res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number })}\n\n`));
  res.end();
}

function summarizeResponsesRequest(body) {
  return {
    stream: body.stream === true,
    store: body.store ?? null,
    background: body.background ?? null,
    previousResponseId: body.previous_response_id ?? null,
    conversation: body.conversation ?? null,
    truncation: body.truncation ?? null,
    include: body.include ?? null,
    maxToolCalls: body.max_tool_calls ?? null,
    contextManagement: body.context_management ?? null,
    streamOptions: body.stream_options ?? null,
    prompt: body.prompt ?? null,
    serviceTier: body.service_tier ?? null,
    safetyIdentifier: body.safety_identifier ?? null,
    moderation: body.moderation ?? null,
    textVerbosity: body.text?.verbosity ?? null,
    clientMetadataKeys: body.client_metadata && typeof body.client_metadata === 'object' && !Array.isArray(body.client_metadata)
      ? Object.keys(body.client_metadata).sort()
      : [],
    instructionType: Array.isArray(body.instructions) ? 'array' : typeof body.instructions,
    input: (Array.isArray(body.input) ? body.input : []).map((item) => ({
      type: item?.type || 'message', role: item?.role || null,
      id: item?.id ?? null, status: item?.status ?? null, callId: item?.call_id ?? null, phase: item?.phase ?? null
    })),
    toolTypes: (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.type || 'function'),
    toolNames: (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.name || null),
    hasReasoning: Boolean(body.reasoning),
    reasoning: body.reasoning && typeof body.reasoning === 'object' ? {
      effort: body.reasoning.effort ?? null,
      summary: body.reasoning.summary ?? body.reasoning.generate_summary ?? null,
      mode: body.reasoning.mode ?? null,
      context: body.reasoning.context ?? null
    } : null,
    parallelToolCalls: body.parallel_tool_calls
  };
}

function summarizeClaudeRequest(body) {
  return {
    stream: body.stream === true,
    systemType: Array.isArray(body.system) ? 'array' : typeof body.system,
    messageRoles: (Array.isArray(body.messages) ? body.messages : []).map((message) => message?.role || null),
    messageSystemCount: (Array.isArray(body.messages) ? body.messages : []).filter((message) => message?.role === 'system').length,
    toolTypes: (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.type || 'function'),
    toolNames: (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool?.name || null),
    thinkingType: body.thinking?.type || null,
    thinkingDisplay: body.thinking?.display || null,
    effort: body.output_config?.effort || null
  };
}

function summarizeChatRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    model: body.model,
    stream: body.stream === true,
    streamOptions: body.stream_options ?? null,
    roles: messages.map((message) => message?.role || null),
    replayedAssistantReasoning: messages.some((message) => message?.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0),
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    reasoningEffort: body.reasoning_effort || null
  };
}

function summarizeRequestTools(body, protocol) {
  if (protocol === 'gemini') {
    const names = geminiToolNames(body);
    return {
      count: names.length,
      names,
      firstShape: body?.tools?.[0] && typeof body.tools[0] === 'object'
        ? { keys: Object.keys(body.tools[0]).sort(), functionKeys: Object.keys(body.tools[0].functionDeclarations?.[0] || {}).sort() }
        : null
    };
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    count: tools.length,
    names: tools.map((tool) => protocol === 'chat' ? tool?.function?.name : tool?.name).filter(Boolean),
    firstShape: tools[0] && typeof tools[0] === 'object'
      ? { keys: Object.keys(tools[0]).sort(), functionKeys: Object.keys(tools[0].function || {}).sort() }
      : null
  };
}

function geminiToolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : [])
    .flatMap((group) => Array.isArray(group?.functionDeclarations) ? group.functionDeclarations : [])
    .map((tool) => tool?.name)
    .filter(Boolean);
}

function geminiParts(body) {
  return (Array.isArray(body?.contents) ? body.contents : [])
    .flatMap((content) => Array.isArray(content?.parts) ? content.parts : []);
}

function hasGeminiToolResult(body) {
  return geminiParts(body).some((part) => part?.functionResponse?.name === 'read');
}

function hasGeminiThoughtSignature(body, signature) {
  return geminiParts(body).some((part) => (part?.thoughtSignature || part?.thought_signature) === signature);
}

function summarizeTargetReasoning(body, protocol) {
  if (protocol === 'responses') return body?.reasoning || null;
  if (protocol === 'claude') return {
    thinking: body?.thinking || null,
    effort: body?.output_config?.effort || null
  };
  if (protocol === 'gemini') return body?.generationConfig?.thinkingConfig || null;
  return { effort: body?.reasoning_effort || null };
}

function hasToolResult(body, protocol) {
  if (protocol === 'responses') {
    return (Array.isArray(body?.input) ? body.input : []).some((item) => item?.type === 'function_call_output');
  }
  if (protocol === 'claude') {
    return (Array.isArray(body?.messages) ? body.messages : []).some((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((part) => part?.type === 'tool_result'));
  }
  if (protocol === 'gemini') return hasGeminiToolResult(body);
  return (Array.isArray(body?.messages) ? body.messages : []).some((message) => message?.role === 'tool');
}

function hasReasoningRoundTrip(body, protocol) {
  return inspectReasoningRoundTrip(body, protocol).present;
}

function inspectReasoningRoundTrip(body, protocol) {
  if (protocol === 'responses') {
    const item = (Array.isArray(body?.input) ? body.input : []).find((entry) => entry?.type === 'reasoning');
    return { present: Boolean(item), encryptedContent: item?.encrypted_content ?? null };
  }
  if (protocol === 'claude') {
    const parts = (Array.isArray(body?.messages) ? body.messages : []).flatMap((message) => Array.isArray(message?.content) ? message.content : []);
    const thinking = parts.find((part) => part?.type === 'thinking');
    const redacted = parts.find((part) => part?.type === 'redacted_thinking');
    return {
      present: Boolean(thinking || redacted),
      signature: thinking?.signature ?? null,
      redactedData: redacted?.data ?? null
    };
  }
  if (protocol === 'gemini') {
    const part = geminiParts(body).find((entry) => typeof (entry?.thoughtSignature || entry?.thought_signature) === 'string');
    return {
      present: Boolean(part),
      thoughtSignature: part?.thoughtSignature || part?.thought_signature || null
    };
  }
  const message = (Array.isArray(body?.messages) ? body.messages : []).find((entry) => entry?.role === 'assistant'
    && (typeof (entry.reasoning_content || entry.reasoning) === 'string' || Array.isArray(entry.reasoning_details)));
  const encrypted = (Array.isArray(message?.reasoning_details) ? message.reasoning_details : [])
    .find((detail) => detail?.type === 'reasoning.encrypted');
  return {
    present: Boolean(message),
    reasoningContent: message?.reasoning_content || message?.reasoning || null,
    reasoningDetails: message?.reasoning_details || null,
    encryptedData: encrypted?.data ?? null
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function modelList(res) {
  json(res, 200, { object: 'list', data: [{ id: PROBE_MODEL, object: 'model' }] });
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
