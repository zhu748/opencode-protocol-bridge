import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

import { openCodeMaximumReasoningEffort, OPENCODE_ZEN_MODEL_CAPABILITIES } from '../src/model-capabilities.js';
import { fetchChecked } from './check-go-catalog.mjs';
import { reasoningProfileAuditError } from './reasoning-profile-audit.mjs';

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_DOC_SOURCE_URL = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx';
const MODELS_DEV_URL = 'https://models.dev/api.json';

setDefaultResultOrder('ipv4first');

export function parseZenEndpointTable(markdown) {
  const protocols = new Map();
  for (const line of String(markdown).split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''));
    const id = cells[1]?.toLowerCase();
    const endpoint = cells[2] || '';
    if (cells.length < 4 || !/^[a-z0-9][a-z0-9.-]*$/i.test(id || '')) continue;
    const standard = endpoint.match(/\/(responses|messages|chat\/completions)$/);
    if (standard) {
      protocols.set(id, standard[1] === 'messages' ? 'claude' : standard[1] === 'responses' ? 'responses' : 'chat');
      continue;
    }
    if (endpoint.includes(`/models/${id}`)) protocols.set(id, 'gemini');
  }
  return protocols;
}

const SDK_PROTOCOLS = Object.freeze({
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/anthropic': 'claude',
  '@ai-sdk/openai-compatible': 'chat',
  '@ai-sdk/google': 'gemini'
});

export function auditZenCatalog({
  liveModelIds, documentedProtocols, modelsDevModels,
  capabilities = OPENCODE_ZEN_MODEL_CAPABILITIES,
  reasoningResolver = (model, protocol) => openCodeMaximumReasoningEffort(model, protocol, 'zen')
}) {
  const errors = [];
  const warnings = [];
  const live = new Set(liveModelIds.map((id) => id.toLowerCase()));
  for (const id of [...live].sort()) {
    const capability = capabilities[id];
    if (!capability) {
      errors.push(`Zen /models 新增了尚未适配的模型：${id}`);
      continue;
    }
    const documentedProtocol = documentedProtocols.get(id);
    if (documentedProtocol && capability.protocol !== documentedProtocol) {
      errors.push(`${id} 原生协议不一致：本地=${capability.protocol}，官方=${documentedProtocol}`);
    } else if (!documentedProtocol && documentedProtocols.size) {
      warnings.push(`${id} 当前未出现在 OpenCode Zen 官方端点表，协议仅由已校验的本地能力表提供`);
    }
    const metadata = modelsDevModels[id];
    if (!metadata?.modalities?.input) {
      warnings.push(`${id} 暂无 models.dev 输入模态，保留本地保守配置`);
      continue;
    }
    const comparisons = [
      ['输入模态', JSON.stringify(capability.inputModalities), JSON.stringify(metadata.modalities.input)],
      ['图片能力', capability.imageInput, metadata.modalities.input.includes('image')],
      ['推理能力', capability.reasoning, metadata.reasoning],
      ['工具调用能力', capability.toolCall, metadata.tool_call],
      ['temperature 能力', capability.temperature, metadata.temperature],
      ['上下文上限', capability.contextLimit, metadata.limit?.context],
      ['输入上限', capability.inputLimit, metadata.limit?.input],
      ['输出上限', capability.outputLimit, metadata.limit?.output]
    ];
    for (const [label, local, remote] of comparisons) {
      if (local !== remote) errors.push(`${id} ${label}不一致：本地=${String(local)}，models.dev=${String(remote)}`);
    }
    const reasoningError = reasoningProfileAuditError({
      model: id, metadata, protocol: capability.protocol,
      actual: reasoningResolver(id, capability.protocol)
    });
    if (reasoningError) errors.push(reasoningError);
    const sdkProtocol = SDK_PROTOCOLS[metadata.provider?.npm];
    if (sdkProtocol && sdkProtocol !== capability.protocol) {
      errors.push(`${id} SDK 协议不一致：本地=${capability.protocol}，models.dev=${sdkProtocol}`);
    }
  }
  for (const id of Object.keys(capabilities).sort()) {
    if (!live.has(id)) warnings.push(`本地能力表中的 ${id} 当前未由 Zen /models 返回`);
  }
  return { errors, warnings };
}

async function main() {
  const [modelsResponse, docsResponse, modelsDevResponse] = await Promise.all([
    fetchChecked(ZEN_MODELS_URL, 'OpenCode Zen 模型端点'),
    fetchChecked(ZEN_DOC_SOURCE_URL, 'OpenCode Zen 文档源文件'),
    fetchChecked(MODELS_DEV_URL, 'models.dev 目录')
  ]);
  const [modelsBody, docsBody, modelsDevBody] = await Promise.all([
    modelsResponse.json(), docsResponse.text(), modelsDevResponse.json()
  ]);
  const liveModelIds = Array.isArray(modelsBody?.data)
    ? modelsBody.data.map((model) => typeof model?.id === 'string' ? model.id.trim() : '').filter(Boolean)
    : [];
  if (!liveModelIds.length) throw new Error('OpenCode Zen 模型端点没有返回有效 data 列表');
  const documentedProtocols = parseZenEndpointTable(docsBody);
  if (!documentedProtocols.size) throw new Error('未能从 OpenCode Zen 官方文档解析端点表');
  const modelsDevModels = modelsDevBody?.opencode?.models;
  if (!modelsDevModels || typeof modelsDevModels !== 'object') throw new Error('models.dev 缺少 opencode 模型数据');

  const audit = auditZenCatalog({ liveModelIds, documentedProtocols, modelsDevModels });
  for (const warning of audit.warnings) console.warn(`警告：${warning}`);
  if (audit.errors.length) throw new Error(`OpenCode Zen 能力目录校验失败：\n- ${audit.errors.join('\n- ')}`);
  console.log(`OpenCode Zen 能力目录校验通过：${liveModelIds.length} 个在线模型，${documentedProtocols.size} 个官方端点，${Object.keys(modelsDevModels).length} 个 models.dev 模型`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
