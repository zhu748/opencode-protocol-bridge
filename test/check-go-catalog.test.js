import test from 'node:test';
import assert from 'node:assert/strict';

import { auditGoCatalog, fetchChecked, parseGoEndpointTable } from '../scripts/check-go-catalog.mjs';

test('Go 官方 Markdown 端点表可解析为三种原生协议', () => {
  const parsed = parseGoEndpointTable(`
| Model | Model ID | Endpoint | AI SDK Package |
| --- | --- | --- | --- |
| GPT | gpt-x | \`https://opencode.ai/zen/go/v1/responses\` | openai |
| MiniMax | minimax-x | \`https://opencode.ai/zen/go/v1/messages\` | anthropic |
| Kimi | kimi-x | \`https://opencode.ai/zen/go/v1/chat/completions\` | compatible |
`);
  assert.deepEqual(Object.fromEntries(parsed), { 'gpt-x': 'responses', 'minimax-x': 'claude', 'kimi-x': 'chat' });
});

test('Go 能力审计检测新增模型、协议漂移、图片模态和模型元数据变化', () => {
  const result = auditGoCatalog({
    liveModelIds: ['known', 'new-model'],
    documentedProtocols: new Map([['known', 'responses']]),
    modelsDevModels: {
      known: {
        modalities: { input: ['text', 'image'] }, reasoning: true, tool_call: true, temperature: false,
        limit: { context: 200_000, output: 32_000 }
      }
    },
    capabilities: {
      known: {
        protocol: 'chat', imageInput: false, reasoning: false, toolCall: true, temperature: false,
        contextLimit: 100_000, outputLimit: 32_000
      },
      stale: { protocol: 'chat', imageInput: false }
    }
  });
  assert.match(result.errors.join('\n'), /new-model/);
  assert.match(result.errors.join('\n'), /原生协议不一致/);
  assert.match(result.errors.join('\n'), /图片能力不一致/);
  assert.match(result.errors.join('\n'), /推理能力不一致/);
  assert.match(result.errors.join('\n'), /上下文上限不一致/);
  assert.match(result.warnings.join('\n'), /stale/);
});

test('Go 能力审计使用明确的 models.dev SDK 交叉校验 Claude 与 Responses 路由', () => {
  const metadata = (npm) => ({
    modalities: { input: ['text'] }, reasoning: true, tool_call: true, temperature: true,
    limit: { context: 100_000, output: 10_000 }, provider: { npm }
  });
  const capability = (protocol) => ({
    protocol, imageInput: false, inputModalities: ['text'], reasoning: true, toolCall: true, temperature: true,
    contextLimit: 100_000, outputLimit: 10_000
  });
  const result = auditGoCatalog({
    liveModelIds: ['wrong-claude', 'responses-ok', 'openai-chat-ok'],
    documentedProtocols: new Map(),
    modelsDevModels: {
      'wrong-claude': metadata('@ai-sdk/anthropic'),
      'responses-ok': metadata('@ai-sdk/openai'),
      'openai-chat-ok': metadata('@ai-sdk/openai')
    },
    capabilities: {
      'wrong-claude': capability('chat'),
      'responses-ok': capability('responses'),
      'openai-chat-ok': capability('chat')
    }
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /wrong-claude.*SDK 指向 Claude Messages/);
});

test('Go 能力审计公开在线模型缺少官方端点表记录的漂移', () => {
  const result = auditGoCatalog({
    liveModelIds: ['documented', 'catalog-only'],
    documentedProtocols: new Map([['documented', 'chat']]),
    modelsDevModels: {},
    capabilities: {
      documented: { protocol: 'chat', imageInput: false },
      'catalog-only': { protocol: 'responses', imageInput: true }
    }
  });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /catalog-only.*未出现在 OpenCode Go 官方端点表/);
});

test('Go 能力审计检测 models.dev 最高思考档位漂移', () => {
  const result = auditGoCatalog({
    liveModelIds: ['reasoning-model'], documentedProtocols: new Map(),
    modelsDevModels: {
      'reasoning-model': {
        modalities: { input: ['text'] }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'max'] }],
        tool_call: true, temperature: true, limit: { context: 100_000, output: 10_000 }
      }
    },
    capabilities: {
      'reasoning-model': {
        protocol: 'chat', imageInput: false, inputModalities: ['text'], reasoning: true,
        toolCall: true, temperature: true, contextLimit: 100_000, outputLimit: 10_000
      }
    },
    reasoningResolver: () => 'high'
  });
  assert.match(result.errors.join('\n'), /最高思考策略不一致.*本地=high.*models\.dev=max/);
});

test('Go 在线目录请求仅重试瞬时网络和可恢复 HTTP 错误', async () => {
  let networkAttempts = 0;
  const recovered = await fetchChecked('https://example.invalid/models', '测试目录', {
    attempts: 3, timeoutMs: 100,
    fetchImpl: async () => {
      networkAttempts++;
      if (networkAttempts === 1) throw Object.assign(new Error('连接超时'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      if (networkAttempts === 2) return new Response('', { status: 503 });
      return new Response('{}', { status: 200 });
    }
  });
  assert.equal(recovered.status, 200);
  assert.equal(networkAttempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(fetchChecked('https://example.invalid/models', '测试目录', {
    attempts: 3, timeoutMs: 100,
    fetchImpl: async () => {
      permanentAttempts++;
      return new Response('', { status: 404 });
    }
  }), /返回 HTTP 404/);
  assert.equal(permanentAttempts, 1);
});
