import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

import { OPENCODE_GO_MODEL_CAPABILITIES } from '../src/model-capabilities.js';

const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const GO_DOC_SOURCE_URL = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx';
const MODELS_DEV_URL = 'https://models.dev/api.json';

// Some dual-stack CI and Windows hosts advertise an unreachable IPv6 route.
// This audit is read-only, so prefer the reachable IPv4 endpoint consistently.
setDefaultResultOrder('ipv4first');

export function parseGoEndpointTable(markdown) {
  const protocols = new Map();
  for (const line of String(markdown).split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''));
    if (cells.length < 4 || !/^[a-z0-9][a-z0-9.-]*$/i.test(cells[1] || '')) continue;
    const endpoint = cells[2] || '';
    const match = endpoint.match(/\/(responses|messages|chat\/completions)$/);
    if (!match) continue;
    protocols.set(cells[1].toLowerCase(), match[1] === 'messages' ? 'claude' : match[1] === 'responses' ? 'responses' : 'chat');
  }
  return protocols;
}

export function auditGoCatalog({ liveModelIds, documentedProtocols, modelsDevModels, capabilities = OPENCODE_GO_MODEL_CAPABILITIES }) {
  const errors = [];
  const warnings = [];
  const live = new Set(liveModelIds.map((id) => id.toLowerCase()));
  for (const id of [...live].sort()) {
    const capability = capabilities[id];
    if (!capability) {
      errors.push(`Go /models 新增了尚未适配的模型：${id}`);
      continue;
    }
    const documentedProtocol = documentedProtocols.get(id);
    if (documentedProtocol && capability.protocol !== documentedProtocol) {
      errors.push(`${id} 原生协议不一致：本地=${capability.protocol}，官方=${documentedProtocol}`);
    } else if (!documentedProtocol && documentedProtocols.size) {
      warnings.push(`${id} 当前未出现在 OpenCode Go 官方端点表，协议仅由已校验的本地能力表提供`);
    }
    const modelMetadata = modelsDevModels[id];
    if (modelMetadata?.modalities?.input) {
      const imageInput = modelMetadata.modalities.input.includes('image');
      if (capability.imageInput !== imageInput) {
        errors.push(`${id} 图片能力不一致：本地=${capability.imageInput}，models.dev=${imageInput}`);
      }
      if (JSON.stringify(capability.inputModalities) !== JSON.stringify(modelMetadata.modalities.input)) {
        errors.push(`${id} 输入模态不一致：本地=${JSON.stringify(capability.inputModalities)}，models.dev=${JSON.stringify(modelMetadata.modalities.input)}`);
      }
      const comparisons = [
        ['推理能力', capability.reasoning, modelMetadata.reasoning],
        ['工具调用能力', capability.toolCall, modelMetadata.tool_call],
        ['temperature 能力', capability.temperature, modelMetadata.temperature],
        ['上下文上限', capability.contextLimit, modelMetadata.limit?.context],
        ['输入上限', capability.inputLimit, modelMetadata.limit?.input],
        ['输出上限', capability.outputLimit, modelMetadata.limit?.output]
      ];
      for (const [label, local, remote] of comparisons) {
        if (local !== remote) errors.push(`${id} ${label}不一致：本地=${String(local)}，models.dev=${String(remote)}`);
      }
      const sdk = modelMetadata.provider?.npm;
      if (sdk === '@ai-sdk/anthropic' && capability.protocol !== 'claude') {
        errors.push(`${id} SDK 指向 Claude Messages，但本地协议为 ${capability.protocol}`);
      } else if (sdk && capability.protocol === 'claude' && sdk !== '@ai-sdk/anthropic') {
        errors.push(`${id} 本地协议为 Claude Messages，但 models.dev SDK 为 ${sdk}`);
      } else if (sdk && capability.protocol === 'responses' && sdk !== '@ai-sdk/openai') {
        errors.push(`${id} 本地协议为 Responses，但 models.dev SDK 为 ${sdk}`);
      }
    } else {
      warnings.push(`${id} 暂无 models.dev 输入模态，保留本地保守配置`);
    }
  }
  for (const id of Object.keys(capabilities).sort()) {
    if (!live.has(id)) warnings.push(`本地能力表中的 ${id} 当前未由 Go /models 返回`);
  }
  return { errors, warnings };
}

export async function fetchChecked(url, label, { fetchImpl = fetch, attempts = 3, timeoutMs = 20_000 } = {}) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason = error?.cause?.code || error?.cause?.name || error?.name || 'network_error';
      lastFailure = reason;
      if (attempt === attempts) break;
    }
    if (response?.ok) return response;
    if (response) {
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable || attempt === attempts) throw new Error(`${label} 返回 HTTP ${response.status}`);
      lastFailure = `HTTP ${response.status}`;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200 * attempt));
  }
  throw new Error(`${label} 请求失败（${lastFailure || 'network_error'}，已尝试 ${attempts} 次）`);
}

async function main() {
  const [modelsResponse, docsResponse, modelsDevResponse] = await Promise.all([
    fetchChecked(GO_MODELS_URL, 'OpenCode Go 模型端点'),
    fetchChecked(GO_DOC_SOURCE_URL, 'OpenCode Go 文档源文件'),
    fetchChecked(MODELS_DEV_URL, 'models.dev 目录')
  ]);
  const [modelsBody, docsBody, modelsDevBody] = await Promise.all([
    modelsResponse.json(), docsResponse.text(), modelsDevResponse.json()
  ]);
  const liveModelIds = Array.isArray(modelsBody?.data)
    ? modelsBody.data.map((model) => typeof model?.id === 'string' ? model.id.trim() : '').filter(Boolean)
    : [];
  if (!liveModelIds.length) throw new Error('OpenCode Go 模型端点没有返回有效 data 列表');
  const documentedProtocols = parseGoEndpointTable(docsBody);
  if (!documentedProtocols.size) throw new Error('未能从 OpenCode Go 官方文档解析端点表');
  const modelsDevModels = modelsDevBody?.['opencode-go']?.models;
  if (!modelsDevModels || typeof modelsDevModels !== 'object') throw new Error('models.dev 缺少 opencode-go 模型数据');

  const audit = auditGoCatalog({ liveModelIds, documentedProtocols, modelsDevModels });
  for (const warning of audit.warnings) console.warn(`警告：${warning}`);
  if (audit.errors.length) throw new Error(`OpenCode Go 能力目录校验失败：\n- ${audit.errors.join('\n- ')}`);
  console.log(`OpenCode Go 能力目录校验通过：${liveModelIds.length} 个在线模型，${documentedProtocols.size} 个官方端点，${Object.keys(modelsDevModels).length} 个 models.dev 模型`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
