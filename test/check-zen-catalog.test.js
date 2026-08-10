import test from 'node:test';
import assert from 'node:assert/strict';

import { auditZenCatalog, parseZenEndpointTable } from '../scripts/check-zen-catalog.mjs';

test('Zen 官方 Markdown 端点表可解析四种原生协议', () => {
  const parsed = parseZenEndpointTable(`
| Model | Model ID | Endpoint | AI SDK Package |
| --- | --- | --- | --- |
| GPT | gpt-x | \`https://opencode.ai/zen/v1/responses\` | openai |
| Claude | claude-x | \`https://opencode.ai/zen/v1/messages\` | anthropic |
| DeepSeek | deepseek-x | \`https://opencode.ai/zen/v1/chat/completions\` | compatible |
| Gemini | gemini-x | \`https://opencode.ai/zen/v1/models/gemini-x\` | google |
`);
  assert.deepEqual(Object.fromEntries(parsed), {
    'gpt-x': 'responses', 'claude-x': 'claude', 'deepseek-x': 'chat', 'gemini-x': 'gemini'
  });
});

test('Zen 能力审计检测新增模型、协议、模态、限制和 SDK 漂移', () => {
  const result = auditZenCatalog({
    liveModelIds: ['known', 'new-model'],
    documentedProtocols: new Map([['known', 'gemini']]),
    modelsDevModels: {
      known: {
        modalities: { input: ['text', 'image'] }, reasoning: true, tool_call: true, temperature: true,
        limit: { context: 200_000, output: 32_000 }, provider: { npm: '@ai-sdk/google' }
      }
    },
    capabilities: {
      known: {
        protocol: 'chat', imageInput: false, inputModalities: ['text'], reasoning: false, toolCall: true, temperature: false,
        contextLimit: 100_000, outputLimit: 16_000
      },
      stale: { protocol: 'chat', imageInput: false }
    }
  });
  const errors = result.errors.join('\n');
  assert.match(errors, /new-model/);
  assert.match(errors, /原生协议不一致/);
  assert.match(errors, /输入模态不一致/);
  assert.match(errors, /图片能力不一致/);
  assert.match(errors, /上下文上限不一致/);
  assert.match(errors, /SDK 协议不一致/);
  assert.match(result.warnings.join('\n'), /stale/);
});

test('Zen 能力审计允许官方文档已列出但在线目录暂未返回的模型', () => {
  const result = auditZenCatalog({
    liveModelIds: ['live'],
    documentedProtocols: new Map([['live', 'chat'], ['staged', 'claude']]),
    modelsDevModels: {
      live: {
        modalities: { input: ['text'] }, reasoning: true, tool_call: true, temperature: true,
        limit: { context: 100_000, output: 10_000 }, provider: { npm: '@ai-sdk/openai-compatible' }
      }
    },
    capabilities: {
      live: {
        protocol: 'chat', imageInput: false, inputModalities: ['text'], reasoning: true, toolCall: true, temperature: true,
        contextLimit: 100_000, outputLimit: 10_000
      },
      staged: { protocol: 'claude', imageInput: false }
    }
  });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /staged.*未由 Zen \/models 返回/);
});
