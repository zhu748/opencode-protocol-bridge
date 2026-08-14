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
  assert.match(script, /function credentialLabel\(item\)/);
  assert.match(html, /Key \/ 尝试/);
  assert.match(script, /log-key-attempts/);
  assert.match(script, /log-web-search/);
  assert.match(html, /id="bridgeWebSearchProvider"/);
  assert.match(html, /id="statsRetentionDays"[^>]*min="1"[^>]*max="365"/);
  assert.match(html, /id="forceMaximumReasoningEffort"[^>]*type="checkbox"[^>]*checked/);
  assert.match(script, /forceMaximumReasoningEffort/);
  assert.match(html, /Exa 优先，失败回退 Parallel/);
  assert.match(script, /navigator\.clipboard\.writeText\(button\.dataset\.copyValue\)/);
  assert.match(script, /requestLogsToCsv\(items\)/);
  assert.match(html, /id="stats-avg-phases"/);
  assert.match(html, /id="stats-p95-phases"/);
  assert.match(script, /upstreamWaitMs/);
  assert.match(script, /upstreamBodyMs/);
  assert.match(script, /function renderLatency\(item\)/);
  assert.match(script, /尚无请求数据/);
  assert.match(script, /平均上游等待/);
  assert.equal((html.match(/耗时（平均 \/ P95）/g) || []).length, 6);
  assert.match(html, /id="stats-reasoning-effort-rows"/);
  assert.match(html, /id="stats-reasoning-effort-detail"/);
  assert.match(script, /stats\.byReasoningEffort/);
  assert.match(script, /reasoningEffortPreservedRequests/);
  assert.match(script, /思考强度/);
  assert.match(script, /Codex 上下文压缩/);
  assert.match(settings, /\.log-workflow-kind/);
  assert.match(html, /id="data-source-warning"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(script, /loadDataSource\('请求日志'/);
  assert.match(script, /loadDataSource\('运行状态'/);
  assert.match(script, /loadDataSource\('用量统计', refreshStats/);
  assert.match(script, /new Date\(\)\.getTimezoneOffset\(\)/);
  assert.match(script, /createLatestRequestGate/);
  assert.match(script, /if \(!result\.superseded\) toast/);
  assert.match(script, /configSaveInProgress/);
  assert.match(script, /dirtyConfigSections/);
  assert.match(script, /beforeunload/);
  assert.match(script, /'if-match': `"\$\{config\.revision\}"`/);
  assert.match(script, /error\.status !== 412/);
  assert.match(script, /最新修订已载入，当前草稿仍保留/);
  assert.match(script, /function withPendingControl/);
  assert.match(script, /function configPreconditionHeaders/);
  assert.match(script, /function acceptConfigRevision/);
  assert.match(script, /provider-credentials[\s\S]*?headers: configPreconditionHeaders\(\)/);
  assert.match(script, /acceptConfigRevision\(await api\(`\/api\/clients/);
  assert.match(script, /activeAdminMutations/);
  assert.match(script, /activeAdminModelDiscoveries/);
  assert.match(script, /activeHttpConnections/);
  assert.match(script, /activeInferenceRequests/);
  assert.match(script, /oldestActiveInferenceMs/);
  assert.match(script, /longestActiveStreamSilenceMs/);
  assert.match(script, /activeStreamHeartbeats/);
  assert.match(script, /confirmDiscardConfigDrafts\('退出登录'\)/);
  assert.match(html, /id="config-draft-status"[^>]*aria-live="polite"/);
  assert.match(html, /id="upstreamStreamIdleTimeoutMs"[^>]*min="0"[^>]*max="3600000"/);
  assert.match(html, /value="canceled">499 客户端取消/);
  assert.match(html, /只有空心跳、没有有效 SSE 事件/);
  assert.match(html, /连续无原始数据或只有空心跳/);
  assert.match(settings, /\.config-draft-status\.conflict/);
  assert.match(script, /renderRecentPrompt\(\{\}\)/);
  assert.doesNotMatch(script, /api\('\/api\/config'\), api\('\/api\/logs'\), api\('\/api\/status'\), api\('\/api\/clients'\)/);
  assert.match(html, /TUIC\/VLESS\/VMess/);
  assert.match(html, /id="default-proxy-state"/);
  assert.match(html, /id="test-default-proxy"[^>]*>检测代理<\/button>/);
  assert.match(html, /id="keepAliveUrl"/);
  assert.match(html, /成功流式仅限制连接与响应头/);
  assert.match(html, /id="set-current-keep-alive"[^>]*>一键设置当前站点<\/button>/);
  assert.match(script, /location\.origin}\/healthz/);
  assert.match(html, /data-proxy-value="mixed:\/\/127\.0\.0\.1:7890"/);
  assert.match(script, /function fillProxyPreset\(button\)/);
  assert.match(script, /function renderDefaultProxyStatus\(\)/);
  assert.match(script, /test-default-proxy[\s\S]*?proxyScope: 'default'/);
  assert.match(script, /successText: '代理可用'/);
  assert.match(settings, /\.proxy-config-card/);
  assert.match(script, /providerCredentialClearProxy'\)\.checked = false/);
  assert.match(settings, /flex-wrap: wrap/);
  assert.match(html, /id="imageHandoffCredential"/);
  assert.match(html, /id="image-handoff-model-list"/);
  assert.match(html, /id="select-recommended-image-models"/);
  assert.match(script, /\/api\/models\?provider=/);
  assert.match(script, /credentialId/);
  assert.match(script, /imageHandoffModels/);
  assert.match(script, /goModelCapabilities/);
  assert.doesNotMatch(script, /provider !== 'go' \|\| !discovered/);
  assert.match(script, /modelCapabilityBadges/);
  assert.match(html, /<svg class="cache-meter-graphic" viewBox="0 0 100 12"/);
  assert.match(script, /querySelector\('\.cache-read'\)\.setAttribute\('width'/);
  assert.match(script, /querySelector\('\.cache-uncached'\)\.setAttribute\('x'/);
  assert.doesNotMatch(script, /querySelector\('\.cache-(?:read|uncached)'\)\.className/);
  assert.match(script, /指标与分组：\$\{range\} · 趋势：\$\{trendRange\}/);
  assert.match(settings, /@media \(max-width: 1200px\)[\s\S]*?\.log-toolbar/);
  assert.match(settings, /@media \(max-width: 1000px\)[\s\S]*?\.log-toolbar/);
  assert.match(settings, /@media \(max-width: 720px\)[\s\S]*?\.log-toolbar/);
  assert.match(settings, /\.trend-column/);
  assert.match(settings, /\.portion-20/);
  assert.match(settings, /\.stats-dimension/);
  assert.match(settings, /\.protocol-breakdown/);
});

test('Render Blueprint 暴露批量 Key、逐项代理、远程图片交接、保活和 sing-box 变量', async () => {
  const blueprint = await readFile(resolve(projectDir, 'render.yaml'), 'utf8');
  assert.match(blueprint, /buildCommand: npm ci --omit=dev --ignore-scripts && npm run install:sing-box/);
  assert.match(blueprint, /healthCheckPath: \/healthz/);
  for (const name of ['OPENCODE_ZEN_KEYS', 'OPENCODE_GO_KEYS', 'OPENCODE_ZEN_PROXY_URLS', 'OPENCODE_GO_PROXY_URLS', 'OPENCODE_BRIDGE_MAX_ADMIN_MUTATIONS', 'OPENCODE_BRIDGE_MAX_ADMIN_MODEL_DISCOVERIES', 'OPENCODE_BRIDGE_MAX_HTTP_CONNECTIONS', 'OPENCODE_BRIDGE_STREAM_WRITE_TIMEOUT_MS', 'OPENCODE_BRIDGE_SSE_HEARTBEAT_MS', 'OPENCODE_BRIDGE_KEEP_ALIVE_URL', 'OPENCODE_BRIDGE_KEEP_ALIVE_INTERVAL_SECONDS', 'OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL', 'OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES', 'OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS', 'OPENCODE_BRIDGE_SING_BOX_PATH', 'OPENCODE_BRIDGE_SING_BOX_VERSION']) {
    assert.equal((blueprint.match(new RegExp(`key: ${name}\\b`, 'g')) || []).length, 1, `${name} 应出现一次`);
  }
  assert.match(blueprint, /key: OPENCODE_BRIDGE_KEEP_ALIVE_URL\s+sync: false/);
});

test('部署构建固定受支持的 Node 版本并排除本地密钥与运行数据', async () => {
  const [dockerignore, dockerfile, nodeVersion, workflow, dependabot, manifestText, lockText, syntaxChecker, localLauncher] = await Promise.all([
    readFile(resolve(projectDir, '.dockerignore'), 'utf8'),
    readFile(resolve(projectDir, 'Dockerfile'), 'utf8'),
    readFile(resolve(projectDir, '.node-version'), 'utf8'),
    readFile(resolve(projectDir, '.github/workflows/ci.yml'), 'utf8'),
    readFile(resolve(projectDir, '.github/dependabot.yml'), 'utf8'),
    readFile(resolve(projectDir, 'package.json'), 'utf8'),
    readFile(resolve(projectDir, 'package-lock.json'), 'utf8'),
    readFile(resolve(projectDir, 'scripts/check-syntax.mjs'), 'utf8'),
    readFile(resolve(projectDir, 'start-local.ps1'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);

  assert.equal(nodeVersion.trim(), '24.18.1');
  assert.equal(manifest.engines.node, '^22.20.0 || ^24.11.0');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  assert.equal(manifest.scripts.check, 'node scripts/check-syntax.mjs && node --test');
  for (const directory of ['src', 'public', 'scripts', 'test-fixtures']) assert.match(syntaxChecker, new RegExp(`['"]${directory}['"]`));
  assert.match(syntaxChecker, /readFile\(file, 'utf8'\)/);
  assert.match(syntaxChecker, /error\.code === 'ENOENT'/);
  assert.match(syntaxChecker, /extname\(file\).*'\.cjs'.*'commonjs'.*'module'/);
  assert.match(syntaxChecker, /spawnSync\(process\.execPath, \['--check', `--input-type=\$\{inputType\}`, '-'\]/);
  assert.match(syntaxChecker, /input: source/);
  assert.doesNotMatch(localLauncher, /Node\.js 20/);
  assert.match(localLauncher, /Node\.js 22\.20\+ or 24\.11\+/);
  assert.match(dockerfile, /^FROM node:24\.18\.1-alpine3\.24$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /HEALTHCHECK .*http:\/\/127\.0\.0\.1:8787\/healthz/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /node-version: \[22\.23\.2, 24\.18\.1\]/);
  const actionReferences = [...workflow.matchAll(/\buses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/, `Action 必须固定完整提交 SHA：${reference}`);
  }
  for (const action of ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']) {
    assert.match(workflow, new RegExp(`uses: ${action}@[a-f0-9]{40} # v`));
  }
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run audit:prod/);
  assert.match(workflow, /npm run audit:signatures/);
  assert.match(workflow, /npm run --silent sbom:prod > sbom\.cdx\.json/);
  assert.match(workflow, /name: production-sbom/);
  assert.match(workflow, /retention-days: 14/);
  assert.equal(manifest.scripts['sbom:prod'], 'npm sbom --omit=dev --sbom-format=cyclonedx');
  for (const ecosystem of ['npm', 'docker', 'github-actions']) {
    assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}\\b`));
  }

  for (const pattern of ['.env', '.env.*', '*.key', '*.pem', '*.p12', '*.pfx', 'data/', 'node_modules/', 'vendor/']) {
    assert.ok(dockerignore.split(/\r?\n/).includes(pattern), `.dockerignore 应包含 ${pattern}`);
  }
  assert.match(dockerfile, /COPY package\*\.json \.npmrc \.\//);
});

test('OpenAPI 文件是有效的 3.1 描述并覆盖所有公开端点', async () => {
  const spec = JSON.parse(await readFile(resolve(publicDir, 'openapi.json'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/chat/completions', '/messages', '/messages/count_tokens', '/models', '/models/{model}', '/models/{model}:generateContent', '/models/{model}:streamGenerateContent', '/responses', '/responses/compact']);
  assert.equal(spec.components.schemas.ModelId.maxLength, 256);
  assert.equal(spec.components.schemas.OpenAIMetadata.maxProperties, 16);
  assert.equal(spec.paths['/messages'].post.requestBody.content['application/json'].schema.properties.stop_sequences.items.type, 'string');
  assert.deepEqual(spec.paths['/messages'].post.requestBody.content['application/json'].schema.properties.speed.enum, ['standard', 'fast', null]);
  assert.equal(spec.paths['/responses'].post.requestBody.content['application/json'].schema.properties.input.oneOf[1].type, 'array');
  assert.equal(spec.paths['/responses/compact'].post.requestBody.content['application/json'].schema.properties.input.oneOf[1].type, 'array');
  assert.match(spec.paths['/responses/compact'].post.description, /协议配置为 responses 且实际实现该扩展/);
  assert.match(spec.paths['/responses'].post.requestBody.description, /历史工具调用.*关联 ID/);
  assert.equal(spec.paths['/chat/completions'].post.requestBody.content['application/json'].schema.properties.stop.oneOf[1].maxItems, 4);
  assert.ok(spec.paths['/responses'].post.responses['413']);
  assert.equal(spec.paths['/responses'].post.responses['504'].$ref, '#/components/responses/UpstreamTimeout');
  assert.equal(spec.paths['/models'].get.responses['504'].$ref, '#/components/responses/UpstreamTimeout');
  assert.ok(spec.paths['/messages'].post.responses['429']);
  assert.equal(spec.paths['/models'].get.responses['429'].$ref, '#/components/responses/RateLimited');
  assert.equal(spec.paths['/models/{model}'].get.responses['429'].$ref, '#/components/responses/RateLimited');
  assert.equal(spec.components.headers.LocalRequestId.schema.pattern, '^[a-f0-9]{32}$');
  assert.equal(spec.paths['/messages'].post.responses['200'].headers['x-request-id'].$ref, '#/components/headers/LocalRequestId');
  assert.deepEqual(spec.components.headers.SseBuffering.schema.enum, ['no']);
  for (const path of ['/messages', '/responses', '/chat/completions', '/models/{model}:streamGenerateContent']) {
    assert.equal(spec.paths[path].post.responses['200'].headers['x-accel-buffering'].$ref, '#/components/headers/SseBuffering');
  }
  assert.equal(spec.paths['/messages'].post.responses['415'].$ref, '#/components/responses/UnsupportedMediaType');
  assert.equal(spec.paths['/messages'].post.responses['200'].headers['x-opencode-key-attempts'].$ref, '#/components/headers/KeyAttempts');
  assert.equal(spec.paths['/messages/count_tokens'].post.responses['200'].headers['x-opencode-token-count'].$ref, '#/components/headers/TokenCountMode');
  assert.deepEqual(spec.paths['/messages'].post.parameters[0].schema.enum, ['true']);
  assert.deepEqual(spec.paths['/messages/count_tokens'].post.parameters[0].schema.enum, ['true']);
  assert.equal(spec.paths['/responses'].post.responses['200'].headers['x-opencode-tool-degradations'].$ref, '#/components/headers/ToolDegradations');
  assert.deepEqual(spec.components.headers.ToolDegradations.schema.enum, ['web_search']);
  assert.equal(spec.paths['/responses'].post.responses['200'].headers['x-opencode-input-degradations'].$ref, '#/components/headers/InputDegradations');
  assert.equal(spec.paths['/messages'].post.responses['200'].headers['x-opencode-input-degradations'].$ref, '#/components/headers/InputDegradations');
  assert.equal(spec.paths['/chat/completions'].post.responses['200'].headers['x-opencode-input-degradations'].$ref, '#/components/headers/InputDegradations');
  assert.equal(spec.paths['/chat/completions'].post.responses['200'].headers['x-opencode-reasoning-adaptations'].$ref, '#/components/headers/ReasoningAdaptations');
  assert.equal(spec.paths['/models/{model}:generateContent'].post.responses['200'].headers['x-opencode-input-degradations'].$ref, '#/components/headers/InputDegradations');
  assert.equal(spec.paths['/models/{model}:streamGenerateContent'].post.responses['200'].headers['x-opencode-input-degradations'].$ref, '#/components/headers/InputDegradations');
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_client_metadata/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_item_metadata/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_item_phase/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_empty_assistant_placeholder/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_agent_message_to_user/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /responses_compaction_state/);
  assert.match(spec.components.headers.InputDegradations.description, /context_compaction/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /gemini_thought_signature/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /claude_thinking_signature/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /claude_redacted_thinking/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /claude_compaction_encrypted_content/);
  assert.match(spec.components.headers.InputDegradations.schema.pattern, /chat_reasoning_state/);
  assert.match(spec.components.headers.ResponseDegradations.schema.pattern, /responses_reasoning_context/);
  assert.equal(spec.paths['/responses'].post.responses['200'].headers['x-opencode-tool-adaptations'].$ref, '#/components/headers/ToolAdaptations');
  assert.equal(spec.paths['/models/{model}:generateContent'].post.responses['200'].headers['x-opencode-tool-adaptations'].$ref, '#/components/headers/ToolAdaptations');
  assert.equal(spec.paths['/models/{model}:streamGenerateContent'].post.responses['200'].headers['x-opencode-tool-adaptations'].$ref, '#/components/headers/ToolAdaptations');
  assert.deepEqual(spec.components.schemas.GeminiToolConfig.properties.functionCallingConfig.properties.mode.enum, ['AUTO', 'ANY', 'NONE', 'VALIDATED']);
  assert.equal(spec.components.schemas.GeminiToolConfig.properties.functionCallingConfig.properties.streamFunctionCallArguments.type, 'boolean');
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /gemini_stream_function_args_reencoded/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /gemini_google_search_to_web_search/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /gemini_function_names_aliased/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /gemini_response_schema_to_description/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /claude_tool_error_to_content/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /claude_web_search_to_mcp/);
  assert.match(spec.components.headers.ReasoningAdaptations.schema.pattern, /reasoning_history_to_assistant_text/);
  for (const path of ['/messages', '/responses', '/chat/completions']) {
    assert.equal(spec.paths[path].post.responses['200'].headers['x-opencode-service-adaptations'].$ref, '#/components/headers/ServiceAdaptations');
  }
  assert.match(spec.components.headers.ServiceAdaptations.schema.pattern, /claude_fast_speed_to_openai_fast_tier/);
  assert.match(spec.components.headers.ServiceAdaptations.schema.pattern, /openai_default_tier_to_claude_standard_speed/);
  assert.match(spec.components.headers.ReasoningAdaptations.schema.pattern, /reasoning_history_to_chat_reasoning_content/);
  assert.match(spec.components.headers.ReasoningAdaptations.schema.pattern, /reasoning_context_all_turns_history_replay/);
  assert.match(spec.components.headers.ReasoningAdaptations.schema.pattern, /reasoning_summary_sequential_cutoff_best_effort/);
  assert.match(spec.components.headers.ToolAdaptations.schema.pattern, /additional_tools_to_top_level/);
  assert.equal(spec.components.schemas.GenerateContentRequest.properties.toolConfig.$ref, '#/components/schemas/GeminiToolConfig');
  assert.equal(spec.paths['/models'].get.responses['200'].headers['x-opencode-key-attempts'].$ref, '#/components/headers/KeyAttempts');
  assert.equal(spec.paths['/models'].get.responses['400'].$ref, '#/components/responses/InvalidRequest');
  assert.deepEqual(spec.paths['/models/{model}'].get.parameters.find((parameter) => parameter.name === 'provider').schema.enum, ['zen', 'go']);
  assert.equal(spec.components.headers.KeyAttempts.schema.minimum, 2);
  assert.equal(spec.components.headers.UpstreamRequestId.schema.maxLength, 256);
  assert.equal(spec.components.responses.RateLimited.headers['Retry-After'].$ref, '#/components/headers/RetryAfter');
  assert.equal(spec.components.responses.MethodNotAllowed.headers.Allow.$ref, '#/components/headers/Allow');
  assert.equal(spec.components.securitySchemes.googleApiKeyAuth.name, 'x-goog-api-key');
  assert.ok(spec.paths['/models/{model}:generateContent'].post.responses['200']);
  assert.match(spec.paths['/models/{model}:generateContent'].post.responses['200'].description, /groundingMetadata/);
  assert.match(spec.paths['/models/{model}:streamGenerateContent'].post.responses['200'].description, /groundingMetadata/);
  for (const [path, method] of [['/models', 'get'], ['/models/{model}', 'get'], ['/messages', 'post'], ['/messages/count_tokens', 'post'], ['/responses', 'post'], ['/responses/compact', 'post'], ['/chat/completions', 'post'], ['/models/{model}:generateContent', 'post'], ['/models/{model}:streamGenerateContent', 'post']]) {
    assert.equal(spec.paths[path][method].responses['405'].$ref, '#/components/responses/MethodNotAllowed');
  }
  assert.deepEqual(spec.servers.map((server) => server.url), ['/zen/v1', '/go/v1', '/v1']);
  assert.deepEqual(spec.paths['/models/{model}:generateContent'].post.servers.map((server) => server.url), ['/v1beta', '/v1', '/zen/v1beta', '/zen/v1', '/go/v1beta', '/go/v1']);
  assert.ok(spec.components.securitySchemes.bearerAuth);
  assert.ok(spec.components.securitySchemes.apiKeyAuth);
});
