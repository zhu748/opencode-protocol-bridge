import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { prepareUpstreamRequest } from '../src/adapters.js';
import { claudeWebSearchForChat, executeBridgeWebSearch, executeBridgeWebSearchDetailed, responsesWebSearchForChat, withBridgeWebSearchTool, withResponsesBridgeWebSearchMetadata } from '../src/bridge-web-search.js';
import { streamClaudeMessage, streamResponsesResponse, translateSse } from '../src/stream.js';

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function collect(iterable) {
  let result = '';
  for await (const chunk of iterable) result += chunk;
  return result;
}

test('Claude typed Web Search 会作为桥接专用函数注入 Chat 请求', () => {
  const source = {
    model: 'search-chat',
    stream: true,
    tool_choice: { type: 'auto' },
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', city: '北京', country: 'CN' } },
      { name: 'Read', description: '读取文件', input_schema: { type: 'object' } }
    ]
  };
  const adapted = claudeWebSearchForChat(source);

  assert.equal(adapted.enabled, true);
  assert.equal(adapted.spec.maxUses, 6);
  assert.equal(adapted.spec.location, '北京, CN');
  assert.equal(adapted.spec.country, 'CN');
  assert.deepEqual(adapted.body.tools, [source.tools[1]]);
  const upstream = withBridgeWebSearchTool({ model: 'search-chat', stream: true, stream_options: { include_usage: true }, tools: [] }, adapted.spec);
  assert.equal(upstream.stream, false);
  assert.equal(upstream.parallel_tool_calls, false);
  assert.equal('stream_options' in upstream, false);
  assert.equal(upstream.tools[0].function.name, 'web_search');
  assert.equal(upstream.tools[0].function.parameters.properties.query.type, 'string');

  const filtered = claudeWebSearchForChat({
    tools: [{ type: 'web_search_20250305', allowed_domains: ['Example.com'] }]
  });
  assert.deepEqual(filtered.spec.allowedDomains, ['example.com']);
  assert.throws(() => claudeWebSearchForChat({
    tools: [{ type: 'web_search_20250305', allowed_domains: ['example.com/docs'] }]
  }), /裸域名/);
  assert.throws(() => claudeWebSearchForChat({
    tools: [{ type: 'web_search_20260318' }]
  }), /allowed_callers/);
  assert.equal(claudeWebSearchForChat({
    tools: [{ type: 'web_search_20260318', allowed_callers: ['direct'], response_inclusion: 'excluded' }]
  }).spec.sourceType, 'web_search_20260318');
  assert.throws(() => claudeWebSearchForChat({
    tools: [{ type: 'web_search_20250305', future_option: true }]
  }), /暂不支持.*future_option/);
  const forced = claudeWebSearchForChat({
    tool_choice: { type: 'tool', name: 'web_search' },
    tools: [{ type: 'web_search_20250305' }]
  });
  assert.equal(forced.enabled, true);
  assert.equal(forced.spec.force, true);
  assert.deepEqual(forced.body.tool_choice, { type: 'auto' });
});

test('Claude Code 客户端 WebSearch 会映射为内部小写搜索函数', () => {
  const clientTool = {
    name: 'WebSearch',
    description: 'Allows Claude to search the web. Results require a Sources: section.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2 },
        allowed_domains: { type: 'array', items: { type: 'string' } },
        blocked_domains: { type: 'array', items: { type: 'string' } }
      },
      required: ['query'],
      additionalProperties: false
    }
  };
  const source = {
    model: 'search-chat',
    tool_choice: { type: 'tool', name: 'WebSearch' },
    tools: [clientTool, { name: 'Read', input_schema: { type: 'object' } }]
  };
  const adapted = claudeWebSearchForChat(source);
  assert.equal(adapted.enabled, true);
  assert.equal(adapted.spec.dynamicDomains, true);
  assert.equal(adapted.spec.clientToolName, 'WebSearch');
  assert.deepEqual(adapted.body.tools, [source.tools[1]]);
  assert.deepEqual(adapted.body.tool_choice, { type: 'auto' });
  const upstream = withBridgeWebSearchTool({
    model: 'search-chat', messages: [{ role: 'system', content: 'system' }], tools: []
  }, adapted.spec);
  assert.match(upstream.messages[0].content, /WebSearch.*映射.*web_search/);
  assert.match(upstream.messages[0].content, /不要输出 DSML/);
  assert.match(upstream.messages[0].content, /完整 HTTP\(S\) URL/);
  assert.match(upstream.messages[0].content, /不要把不兼容的数据拼成单一精确结论/);
  assert.ok(upstream.tools[0].function.parameters.properties.allowed_domains);
  assert.deepEqual(upstream.tool_choice, { type: 'function', function: { name: 'web_search' } });

  const replayed = claudeWebSearchForChat({
    messages: [{ role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srvtoolu_bridge', name: 'web_search', input: { query: '北京天气' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_bridge', content: [{
        type: 'web_search_result', title: '北京天气', url: 'https://weather.example/', encrypted_content: 'bridge_mcp_state'
      }] },
      { type: 'text', text: '天气回答' }
    ] }],
    tools: [clientTool]
  });
  assert.equal(replayed.body.messages[0].content.some((block) => block.type === 'server_tool_use'), false);
  assert.match(replayed.body.messages[0].content[0].text, /北京天气.*https:\/\/weather\.example\//);
});

test('Codex Responses Web Search 会保留可执行语义并标记图片结果降级', () => {
  const source = {
    model: 'search-chat', stream: true, input: '搜索北京天气', tool_choice: 'auto',
    tools: [{
      type: 'web_search', return_token_budget: 'default', search_content_types: ['text', 'image'],
      search_context_size: 'medium',
      user_location: { type: 'approximate', city: null, country: 'US', region: null, timezone: null }
    }]
  };
  const adapted = responsesWebSearchForChat(source);
  assert.equal(adapted.enabled, true);
  assert.equal(adapted.spec.outputProtocol, 'responses');
  assert.equal(adapted.spec.country, 'US');
  assert.equal(adapted.spec.defaultNumResults, 8);
  assert.equal(adapted.spec.defaultContextMaxCharacters, 20_000);
  assert.deepEqual(adapted.spec.adaptations, ['responses_web_search_image_results_dropped']);
  assert.deepEqual(adapted.body.tools, []);
  assert.equal(adapted.body.input, source.input);

  const replayed = responsesWebSearchForChat({
    input: [
      { type: 'web_search_call', id: 'ws_previous', status: 'completed', action: { type: 'search', query: '旧查询' } },
      { role: 'assistant', content: [{ type: 'output_text', text: '旧答案', annotations: [] }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ],
    tools: [{ type: 'web_search' }]
  });
  assert.equal(replayed.body.input.some((item) => item.type === 'web_search_call'), false);
  assert.ok(replayed.spec.adaptations.includes('responses_web_search_history_compacted'));
  assert.throws(() => responsesWebSearchForChat({
    input: [{ type: 'web_search_call', id: 'ws_unknown', status: 'completed', action: { type: 'search', query: '查询' }, vendor_state: true }],
    tools: [{ type: 'web_search' }]
  }), /暂不支持字段.*vendor_state/);
  const allowed = responsesWebSearchForChat({
    input: '搜索并检查',
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [
      { type: 'web_search' }, { type: 'function', name: 'inspect' }
    ] },
    tools: [
      { type: 'web_search' },
      { type: 'function', name: 'inspect', parameters: { type: 'object' } },
      { type: 'function', name: 'write', parameters: { type: 'object' } }
    ]
  });
  assert.equal(allowed.enabled, true);
  assert.deepEqual(allowed.body.tool_choice, {
    type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'inspect' }]
  });
  const allowedUpstream = withBridgeWebSearchTool(
    prepareUpstreamRequest(allowed.body, 'responses', 'chat', 'search-chat'),
    allowed.spec
  );
  assert.deepEqual(allowedUpstream.tools.map((tool) => tool.function.name), ['inspect', 'web_search']);
  assert.equal(allowedUpstream.tool_choice, 'required');
  const allowedOnlySearch = responsesWebSearchForChat({
    input: '只搜索',
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] },
    tools: [
      { type: 'web_search' },
      { type: 'function', name: 'write', parameters: { type: 'object' } }
    ]
  });
  assert.equal(allowedOnlySearch.spec.force, true);
  assert.deepEqual(allowedOnlySearch.body.tools, []);
  assert.equal(allowedOnlySearch.body.tool_choice, 'auto');
  assert.throws(() => responsesWebSearchForChat({
    tools: [{ type: 'web_search', external_web_access: false }]
  }), /仅缓存语义/);
  assert.throws(() => responsesWebSearchForChat({
    tools: [{ type: 'web_search', search_content_types: ['image'] }]
  }), /仅图片/);
});

test('本地搜索结果会编码为 Responses 调用轨迹、引用与流式事件', async () => {
  const enriched = withResponsesBridgeWebSearchMetadata({
    id: 'resp_search', object: 'response', created_at: 1, completed_at: 2, status: 'completed', model: 'search-chat',
    output: [{ id: 'msg_answer', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '北京天气回答。', annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
  }, [{ id: 'ws_bridge', query: '北京天气', results: [{ type: 'web_search_result', title: '权威天气', url: 'https://weather.example/current' }] }]);
  assert.equal(enriched.output[0].type, 'web_search_call');
  assert.equal(enriched.tool_usage.web_search.num_requests, 1);
  const answer = enriched.output[1].content[0];
  assert.match(answer.text, /https:\/\/weather\.example\/current/);
  assert.deepEqual(answer.annotations[0], {
    type: 'url_citation', url: 'https://weather.example/current', title: '权威天气',
    start_index: answer.annotations[0].start_index, end_index: answer.annotations[0].end_index
  });
  assert.equal(answer.text.slice(answer.annotations[0].start_index, answer.annotations[0].end_index), 'https://weather.example/current');

  const stream = await collect(streamResponsesResponse(enriched));
  const events = stream.split(/\n\n/).filter(Boolean)
    .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
  assert.deepEqual(events.map((item) => item.sequence_number), events.map((_, index) => index));
  assert.equal(events[0].type, 'response.created');
  assert.ok(events.some((item) => item.type === 'response.output_item.added' && item.item.type === 'web_search_call'));
  assert.ok(events.some((item) => item.type === 'response.output_text.annotation.added'));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.tool_usage.web_search.num_requests, 1);
  const validated = await collect(translateSse(new Response(stream), 'responses', 'chat', 'search-chat', { allowResponsesWebSearch: true }));
  assert.match(validated, /北京天气回答/);
  assert.match(validated, /data: \[DONE\]/);
});

test('桥接 Web Search 通过 Exa MCP 的 tools/call 执行', async (t) => {
  const captured = [];
  const mcp = createServer(async (req, res) => {
    const current = { method: req.method, path: req.url, body: await requestBody(req) };
    captured.push(current);
    if (current.body.params.arguments.query === 'service-error') {
      return sendJson(res, {
        jsonrpc: '2.0', id: 1,
        result: { isError: true, content: [{ type: 'text', text: '上游搜索不可用' }] }
      });
    }
    sendJson(res, {
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: '第一条结果' }, { type: 'text', text: '第二条结果' }] }
    });
  });
  mcp.listen(0, '127.0.0.1');
  await once(mcp, 'listening');
  t.after(async () => {
    mcp.close();
    await once(mcp, 'close').catch(() => {});
  });

  const result = await executeBridgeWebSearch({
    id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '北京天气', type: 'fast' }) }
  }, { endpoint: `http://127.0.0.1:${mcp.address().port}/mcp` });

  assert.match(result, /不可信参考资料/);
  assert.match(result, /第一条结果\n\n第二条结果/);
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].path, '/mcp');
  assert.deepEqual(captured[0].body, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: { query: '北京天气', numResults: 8, type: 'fast', livecrawl: 'fallback' }
    }
  });
  await assert.rejects(executeBridgeWebSearch({
    id: 'call_error', type: 'function', function: { name: 'web_search', arguments: '{"query":"service-error"}' }
  }, { endpoint: `http://127.0.0.1:${mcp.address().port}/mcp` }), /Web Search 服务错误：上游搜索不可用/);
});

test('自动 Web Search 在 Exa 失败后回退 Parallel 并规范化结构化结果', async (t) => {
  const exa = createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary failure' } }));
  });
  const parallel = createServer(async (req, res) => {
    const body = await requestBody(req);
    assert.equal(body.params.name, 'web_search');
    assert.equal(body.params.arguments.objective, '北京天气');
    assert.equal(body.params.arguments.model_name, 'deepseek-v4-flash');
    sendJson(res, {
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({
        results: [
          { title: '验证码页面', url: 'https://noise.example', excerpts: ['WEB 应用防火墙 人机识别 验证码'] },
          { title: '权威预报', url: 'https://weather.example', publish_date: '2026-08-11', excerpts: ['未来三天有雨。'] }
        ]
      }) }] }
    });
  });
  exa.listen(0, '127.0.0.1');
  parallel.listen(0, '127.0.0.1');
  await Promise.all([once(exa, 'listening'), once(parallel, 'listening')]);
  t.after(async () => {
    exa.close(); parallel.close();
    await Promise.all([once(exa, 'close').catch(() => {}), once(parallel, 'close').catch(() => {})]);
  });
  let selected;
  const result = await executeBridgeWebSearchDetailed({
    id: 'fallback', type: 'function', function: { name: 'web_search', arguments: '{"query":"北京天气"}' }
  }, {
    provider: 'auto',
    endpoint: `http://127.0.0.1:${exa.address().port}/mcp`,
    parallelEndpoint: `http://127.0.0.1:${parallel.address().port}/mcp`,
    sessionId: 'session-search',
    model: 'deepseek-v4-flash',
    onProvider: (value) => { selected = value; }
  });
  assert.equal(selected, 'parallel');
  assert.doesNotMatch(result.content, /验证码页面|WEB 应用防火墙/);
  assert.match(result.content, /Title: 权威预报/);
  assert.match(result.content, /URL: https:\/\/weather\.example/);
  assert.deepEqual(result.results, [{
    type: 'web_search_result', title: '权威预报', url: 'https://weather.example/', page_age: '2026-08-11'
  }]);
});

test('Claude 域名过滤通过 Exa Advanced 原样执行', async (t) => {
  let captured;
  const exa = createServer(async (req, res) => {
    captured = { path: req.url, body: await requestBody(req) };
    sendJson(res, {
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ context: '仅来自 example.com 的结果' }) }] }
    });
  });
  exa.listen(0, '127.0.0.1');
  await once(exa, 'listening');
  t.after(async () => { exa.close(); await once(exa, 'close').catch(() => {}); });
  const spec = claudeWebSearchForChat({
    tools: [{ type: 'web_search_20250305', allowed_domains: ['example.com'], user_location: { type: 'approximate', country: 'CN' } }]
  }).spec;
  const result = await executeBridgeWebSearch({
    id: 'advanced', type: 'function', function: { name: 'web_search', arguments: '{"query":"新闻","livecrawl":"preferred"}' }
  }, { endpoint: `http://127.0.0.1:${exa.address().port}/mcp`, spec });
  assert.match(captured.path, /tools=.*web_search_advanced_exa/);
  assert.equal(captured.body.params.name, 'web_search_advanced_exa');
  assert.deepEqual(captured.body.params.arguments.includeDomains, ['example.com']);
  assert.equal(captured.body.params.arguments.userLocation, 'CN');
  assert.equal(captured.body.params.arguments.maxAgeHours, 0);
  assert.match(result, /仅来自 example\.com/);
});

test('Claude Web Search 的最终消息可重新编码为 Claude SSE', async () => {
  const stream = await collect(streamClaudeMessage({
    id: 'msg_search', type: 'message', role: 'assistant', model: 'search-chat',
    content: [{ type: 'thinking', thinking: '整理搜索结果', signature: 'bridge' }, { type: 'text', text: '北京未来几天晴朗。' }],
    stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 }
  }));

  assert.match(stream, /event: message_start/);
  assert.match(stream, /"thinking_delta"/);
  assert.match(stream, /北京未来几天晴朗/);
  assert.match(stream, /event: message_stop/);
});

test('Claude Code 与 Codex 的 Web Search 可经 Chat 上游完成完整及混合工具循环', { timeout: 20_000 }, async () => {
  const chatRequests = [];
  const searchRequests = [];
  let activeSearches = 0;
  let maximumActiveSearches = 0;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://upstream.local').pathname;
    if (path === '/mcp') {
      const request = await requestBody(req);
      searchRequests.push(request);
      activeSearches++;
      maximumActiveSearches = Math.max(maximumActiveSearches, activeSearches);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      activeSearches--;
      const sourcePath = request.params.arguments.query.includes('未来三天') ? 'three-day' : 'current';
      return sendJson(res, {
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: `Title: 权威天气 ${sourcePath}\nURL: https://weather.example/${sourcePath}\nHighlights:\n北京天气：${request.params.arguments.query}，18–27°C。` }] }
      });
    }
    if (path !== '/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const body = await requestBody(req);
    chatRequests.push(body);
    const returnedSearches = new Set(body.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
    const hasSearchResult = returnedSearches.has('call_search') && returnedSearches.has('call_search_second');
    if (!hasSearchResult) {
      const mixedClientTools = Array.isArray(body.tools) && body.tools.some((tool) => tool?.function?.name === 'read_file');
      return sendJson(res, {
        id: 'chatcmpl_search_call', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"北京天气"}' } },
            { id: 'call_search_second', type: 'function', function: { name: 'web_search', arguments: '{"query":"北京未来三天天气"}' } },
            ...(mixedClientTools ? [{ id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] : [])
          ]
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      });
    }
    return sendJson(res, {
      id: 'chatcmpl_search_final', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '北京未来几天以晴到多云为主。' } }],
      usage: { prompt_tokens: 14, completion_tokens: 4, total_tokens: 18 }
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const bridgePort = 30_000 + Math.floor(Math.random() * 10_000);
  const configFile = resolve(import.meta.dirname, `../data/bridge-search-${randomUUID()}.json`);
  const logFile = resolve(import.meta.dirname, `../data/bridge-search-log-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(bridgePort), CONFIG_FILE: configFile, LOG_FILE: logFile,
      OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENCODE_BRIDGE_WEB_SEARCH_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await Promise.race([
      new Promise((resolveStarted) => child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('OpenCode Bridge 已启动')) resolveStarted();
      })),
      once(child, 'exit').then(([code]) => { throw new Error(`桥接服务提前退出：${code}`); })
    ]);
    const setup = await fetch(`http://127.0.0.1:${bridgePort}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bridgewebsearchtest' })
    });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const configured = await fetch(`http://127.0.0.1:${bridgePort}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        defaultProvider: 'zen', zenKey: 'upstream-secret', goKey: 'upstream-go-secret', clientToken: '', modelRoutes: {
          'search-chat': { provider: 'zen', protocol: 'chat', upstreamModel: 'search-chat' }
        },
        bridgeWebSearchEnabled: true
      })
    });
    assert.equal(configured.status, 200);

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setupBody.clientToken },
      body: JSON.stringify({
        model: 'search-chat', max_tokens: 128, stream: false,
        messages: [{ role: 'user', content: '搜索一下北京天气近几天' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-opencode-tool-adaptations'), 'claude_web_search_to_mcp');
    const responseBody = await response.json();
    const responseText = responseBody.content.find((block) => block.type === 'text').text;
    assert.match(responseText, /^北京未来几天以晴到多云为主。/);
    assert.match(responseText, /### 搜索来源链接 \/ Web search sources/);
    assert.match(responseText, /\[权威天气 current\]\(https:\/\/weather\.example\/current\)/);
    assert.match(responseText, /\[权威天气 three-day\]\(https:\/\/weather\.example\/three-day\)/);
    assert.equal(responseBody.content.filter((block) => block.type === 'server_tool_use').length, 2);
    assert.equal(responseBody.content.filter((block) => block.type === 'web_search_tool_result').length, 2);
    assert.deepEqual(responseBody.usage, {
      input_tokens: 24, output_tokens: 6, server_tool_use: { web_search_requests: 2 }
    });
    assert.equal(chatRequests.length, 2);
    assert.equal(chatRequests[0].stream, false);
    assert.equal(chatRequests[0].parallel_tool_calls, false);
    assert.deepEqual(chatRequests[0].tools.map((tool) => tool.function.name), ['web_search']);
    assert.ok(chatRequests[1].messages.some((message) => message.role === 'tool' && message.content.includes('北京天气：北京天气')));
    assert.match(chatRequests[1].messages.at(-1).content, /不要输出、模拟或编造任何未在当前 tools 列表中声明的工具调用语法/);
    assert.deepEqual(searchRequests.map((item) => item.params.arguments.query).sort(), ['北京天气', '北京未来三天天气'].sort());
    assert.equal(maximumActiveSearches, 2);
    const logs = await fetch(`http://127.0.0.1:${bridgePort}/api/logs`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(logs[0].bridgeWebSearchCalls, 2);

    const streamed = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': setupBody.clientToken },
      body: JSON.stringify({
        model: 'search-chat', max_tokens: 128, stream: true,
        messages: [{ role: 'user', content: '搜索一下北京天气近几天' }],
        tools: [{
          name: 'WebSearch',
          description: 'Allows Claude to search the web. Results require a Sources: section.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2 },
              allowed_domains: { type: 'array', items: { type: 'string' } },
              blocked_domains: { type: 'array', items: { type: 'string' } }
            },
            required: ['query'],
            additionalProperties: false
          }
        }]
      })
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type'), /^text\/event-stream/);
    const streamText = await streamed.text();
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /"type":"server_tool_use"/);
    assert.match(streamText, /"type":"web_search_tool_result"/);
    assert.match(streamText, /"web_search_requests":2/);
    assert.match(streamText, /北京未来几天以晴到多云为主/);
    assert.match(streamText, /搜索来源链接 \/ Web search sources/);
    assert.match(streamText, /https:\/\/weather\.example\/current/);
    assert.match(streamText, /event: message_stop/);
    assert.equal(chatRequests.length, 4);
    assert.ok(chatRequests.every((request) => request.stream === false));
    assert.equal(searchRequests.length, 4);

    const codexBody = {
      model: 'search-chat', input: '搜索一下北京天气近几天', tool_choice: { type: 'web_search' },
      tools: [{
        type: 'web_search', return_token_budget: 'default', search_content_types: ['text', 'image'],
        search_context_size: 'medium',
        user_location: { type: 'approximate', city: null, country: 'US', region: null, timezone: null }
      }]
    };
    const codexResponse = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
      body: JSON.stringify({ ...codexBody, stream: false })
    });
    assert.equal(codexResponse.status, 200);
    assert.equal(codexResponse.headers.get('x-opencode-tool-adaptations'), 'responses_web_search_to_mcp,responses_web_search_image_results_dropped');
    assert.equal(codexResponse.headers.get('x-opencode-tool-degradations'), null);
    const codexJson = await codexResponse.json();
    assert.equal(codexJson.output.filter((item) => item.type === 'web_search_call').length, 2);
    assert.equal(codexJson.tool_usage.web_search.num_requests, 2);
    const codexText = codexJson.output.find((item) => item.type === 'message').content.find((part) => part.type === 'output_text');
    assert.match(codexText.text, /搜索来源链接/);
    assert.equal(codexText.annotations.filter((item) => item.type === 'url_citation').length, 2);
    assert.equal(chatRequests.length, 6);
    assert.deepEqual(chatRequests[4].tool_choice, { type: 'function', function: { name: 'web_search' } });
    assert.equal(chatRequests[5].tool_choice, 'auto');
    assert.equal(searchRequests.length, 6);

    const codexStreamed = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
      body: JSON.stringify({ ...codexBody, stream: true })
    });
    assert.equal(codexStreamed.status, 200);
    assert.match(codexStreamed.headers.get('content-type'), /^text\/event-stream/);
    const codexStreamText = await codexStreamed.text();
    const codexEvents = codexStreamText.split(/\n\n/).filter(Boolean)
      .map((block) => JSON.parse(block.split(/\r?\n/).find((line) => line.startsWith('data: ')).slice(6)));
    assert.deepEqual(codexEvents.map((item) => item.sequence_number), codexEvents.map((_, index) => index));
    assert.equal(codexEvents.filter((item) => item.type === 'response.output_item.added' && item.item.type === 'web_search_call').length, 2);
    assert.ok(codexEvents.some((item) => item.type === 'response.output_text.annotation.added'));
    assert.equal(codexEvents.at(-1).type, 'response.completed');
    assert.equal(codexEvents.at(-1).response.tool_usage.web_search.num_requests, 2);
    assert.equal(chatRequests.length, 8);
    assert.equal(searchRequests.length, 8);

    const mixedTools = [
      codexBody.tools[0],
      {
        type: 'function', name: 'read_file', description: '读取工作区文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
      }
    ];
    const mixed = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
      body: JSON.stringify({ model: 'search-chat', input: '搜索天气并读取 README', tools: mixedTools, stream: false })
    });
    assert.equal(mixed.status, 200);
    const mixedJson = await mixed.json();
    assert.equal(mixedJson.output.filter((item) => item.type === 'web_search_call').length, 2);
    assert.equal(mixedJson.output.filter((item) => item.type === 'function_call' && item.name === 'read_file').length, 1);
    assert.equal(mixedJson.output.filter((item) => item.type === 'message').length, 0);
    assert.equal(mixedJson.tool_usage.web_search.num_requests, 2);
    assert.equal(chatRequests.length, 9);
    assert.equal(searchRequests.length, 10);

    const resumed = await fetch(`http://127.0.0.1:${bridgePort}/go/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${setupBody.clientToken}` },
      body: JSON.stringify({
        model: 'search-chat',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '搜索天气并读取 README' }] },
          ...mixedJson.output,
          { type: 'function_call_output', call_id: 'call_read', output: 'README 文件内容' }
        ],
        tools: mixedTools,
        stream: false
      })
    });
    assert.equal(resumed.status, 200);
    const resumedJson = await resumed.json();
    assert.match(resumedJson.output.find((item) => item.type === 'message').content[0].text, /北京未来几天/);
    assert.equal(chatRequests.length, 10);
    assert.ok(chatRequests[9].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_search'));
    assert.ok(chatRequests[9].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read'));
    assert.equal(searchRequests.length, 10);
    const stats = await fetch(`http://127.0.0.1:${bridgePort}/api/stats`, { headers: { cookie } }).then((result) => result.json());
    const goHealth = stats.credentialHealth.find((item) => item.provider === 'go');
    assert.equal(goHealth.state, 'healthy');
    assert.equal(goHealth.cooldownUntil, null);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    upstream.close();
    await once(upstream, 'close').catch(() => {});
    await unlink(configFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(logFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
});
