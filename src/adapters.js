import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { claudeSystemBlockText } from './prompt-rewrite.js';

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const CHAT_TOOL_NAME_MAX_LENGTH = 64;
const RESPONSES_WEB_SEARCH_TOOL_TYPES = new Set(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11']);
const WEB_SEARCH_COMPATIBILITY_NOTICE = 'Protocol bridge compatibility: this non-Responses upstream cannot execute the hosted web_search tool. Do not claim to have searched the web; use another available function tool or explain that web search is unavailable.';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function stripLeadingBillingHeader(text) {
  if (typeof text !== 'string' || !text.startsWith(BILLING_HEADER_PREFIX)) return text || '';
  const lineEnd = text.search(/[\r\n]/);
  if (lineEnd === -1) return '';
  return text.slice(lineEnd).replace(/^(?:\r\n|\r|\n){1,2}/, '');
}

function cleanSchema(value) {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'format' && child === 'uri') continue;
    result[key] = cleanSchema(child);
  }
  return result;
}

function usesReasoningContent(model) {
  return /(?:deepseek|kimi|moonshot)/i.test(model || '');
}

function isOpenAiOSeries(model) {
  return /^o\d/i.test(model || '');
}

function supportsReasoningEffort(model) {
  return isOpenAiOSeries(model) || /^gpt-[5-9]/i.test(model || '');
}

function needsNonThinkingToolMode(model) {
  return /^deepseek-v4-flash(?:-free)?$/i.test(model || '');
}

function resolveReasoningEffort(body, protocol) {
  if (protocol === 'responses') return body.reasoning?.effort;
  if (protocol === 'chat') return body.reasoning_effort;
  const effort = body.output_config?.effort;
  if (['low', 'medium', 'high'].includes(effort)) return effort;
  if (effort === 'max') return 'xhigh';
  if (body.thinking?.type === 'adaptive') return 'xhigh';
  if (body.thinking?.type !== 'enabled') return undefined;
  const budget = body.thinking.budget_tokens;
  if (budget == null) return 'high';
  if (budget < 4000) return 'low';
  if (budget < 16000) return 'medium';
  return 'high';
}

function canonicalJsonString(value) {
  const canonicalize = (item) => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonicalize(item[key])]));
  };
  return JSON.stringify(canonicalize(value));
}

function sanitizeToolArguments(name, argumentsValue) {
  if (name !== 'Read' || !argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== 'object' || argumentsValue.pages !== '') return argumentsValue;
  const sanitized = { ...argumentsValue };
  delete sanitized.pages;
  return sanitized;
}

function normalizeParts(content, { includeReasoning = false, rejectUnknown = false } = {}) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return asArray(content).flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (['text', 'input_text', 'output_text'].includes(part?.type)) return [{ type: 'text', text: part.text || '', ...(part.cache_control ? { cacheControl: part.cache_control } : {}) }];
    if (part?.type === 'refusal') return [{ type: 'text', text: part.refusal || '' }];
    if (includeReasoning && part?.type === 'thinking') return [{ type: 'reasoning', text: part.thinking || '', signature: part.signature }];
    if (part?.type === 'image') return [{ type: 'image', source: part.source, ...(part.detail ? { detail: part.detail } : {}) }];
    if (part?.type === 'image_url') return [{ type: 'image', source: { type: 'url', url: part.image_url?.url || part.image_url }, ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}) }];
    if (part?.type === 'input_image') return [{ type: 'image', source: part.image_url ? { type: 'url', url: part.image_url } : { type: 'file', file_id: part.file_id }, ...(part.detail ? { detail: part.detail } : {}) }];
    if (part?.type === 'document') return [{
      type: 'file', source: part.source, filename: part.filename,
      title: part.title, context: part.context, citations: part.citations,
      ...(part.cache_control ? { cacheControl: part.cache_control } : {})
    }];
    if (part?.type === 'input_file') return [{
      type: 'file', source: openAiFileSource(part), filename: part.filename,
      ...(part.detail ? { detail: part.detail } : {})
    }];
    if (part?.type === 'tool_use') return [{ type: 'tool_call', id: part.id, name: part.name, arguments: part.input || {} }];
    if (part?.type === 'tool_result') return [{ type: 'tool_result', id: part.tool_use_id, content: part.content }];
    if (rejectUnknown && part && typeof part === 'object') throw unsupportedFeature(`跨协议转换暂不支持内容块类型：${part.type || 'unknown'}`);
    return [];
  });
}

function openAiFileSource(part) {
  if (part.file_url) return { type: 'url', url: part.file_url };
  if (part.file_id) return { type: 'file', file_id: part.file_id };
  if (typeof part.file_data === 'string') {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.file_data);
    if (match) return { type: 'base64', media_type: match[1], data: match[2] };
    return { type: 'base64', media_type: 'application/pdf', data: part.file_data };
  }
  return undefined;
}

function unsupportedFeature(message) {
  return Object.assign(new Error(message), { status: 400, type: 'invalid_request_error' });
}

function validResponsesFunction(tool, label) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name) {
    throw unsupportedFeature(`${label} 必须是具有有效 name 的 function tool`);
  }
}

function sanitizedChatToolName(value, fallback = 'tool') {
  const name = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return name || fallback;
}

function allocateChatToolAlias(namespace, name, usedNames, namespaceIndex, toolIndex) {
  const base = `${sanitizedChatToolName(namespace, 'namespace')}__${sanitizedChatToolName(name)}`;
  let alias = base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
  if (!usedNames.has(alias)) {
    usedNames.add(alias);
    return alias;
  }
  const suffix = `__n${namespaceIndex}t${toolIndex}`;
  alias = `${base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
  let collision = 1;
  while (usedNames.has(alias)) {
    const collisionSuffix = `${suffix}_${collision++}`;
    alias = `${base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - collisionSuffix.length)}${collisionSuffix}`;
  }
  usedNames.add(alias);
  return alias;
}

function responsesToolCompatibility(tools, { rejectUnsupported = true } = {}) {
  const source = asArray(tools);
  const usedNames = new Set(source.filter((tool) => tool?.type === 'function' && typeof tool.name === 'string').map((tool) => tool.name));
  const directNames = new Set();
  const namespaceNames = new Set();
  const namespaceChildren = new Set();
  const flattened = [];
  const aliases = [];
  const unsupportedTypes = [];
  let droppedWebSearch = false;

  for (let namespaceIndex = 0; namespaceIndex < source.length; namespaceIndex++) {
    const tool = source[namespaceIndex];
    if (tool?.type === 'function') {
      validResponsesFunction(tool, `Responses tools[${namespaceIndex}]`);
      if (directNames.has(tool.name)) throw unsupportedFeature(`Responses function tool 名称重复：${tool.name}`);
      directNames.add(tool.name);
      flattened.push({ name: tool.name, description: tool.description, schema: tool.parameters || {}, strict: tool.strict });
      continue;
    }
    if (RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type)) {
      droppedWebSearch = true;
      continue;
    }
    if (tool?.type !== 'namespace') {
      unsupportedTypes.push(tool?.type || 'unknown');
      continue;
    }
    if (typeof tool.name !== 'string' || !tool.name || !Array.isArray(tool.tools)) {
      throw unsupportedFeature(`Responses namespace tools[${namespaceIndex}] 缺少有效 name 或 tools 数组`);
    }
    if (namespaceNames.has(tool.name)) throw unsupportedFeature(`Responses namespace 名称重复：${tool.name}`);
    namespaceNames.add(tool.name);
    for (let toolIndex = 0; toolIndex < tool.tools.length; toolIndex++) {
      const child = tool.tools[toolIndex];
      validResponsesFunction(child, `Responses namespace ${tool.name}.tools[${toolIndex}]`);
      const childIdentity = `${tool.name}\n${child.name}`;
      if (namespaceChildren.has(childIdentity)) throw unsupportedFeature(`Responses namespace ${tool.name} 的 function tool 名称重复：${child.name}`);
      namespaceChildren.add(childIdentity);
      const alias = allocateChatToolAlias(tool.name, child.name, usedNames, namespaceIndex, toolIndex);
      aliases.push({ alias, namespace: tool.name, name: child.name });
      const namespaceDescription = [
        `[Responses namespace: ${tool.name}]`,
        tool.description,
        child.description
      ].filter(Boolean).join('\n');
      flattened.push({ name: alias, description: namespaceDescription, schema: child.parameters || {}, strict: child.strict });
    }
  }

  if (rejectUnsupported && unsupportedTypes.length) {
    throw unsupportedFeature(`跨协议转换暂不支持 Responses 工具类型：${[...new Set(unsupportedTypes)].join(', ')}`);
  }
  return { tools: flattened, aliases, droppedWebSearch };
}

export function hasHostedResponsesWebSearch(tools) {
  return asArray(tools).some((tool) => RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type));
}

function responsesToolAlias(namespace, name, aliases) {
  if (!namespace) return name;
  return aliases.find((entry) => entry.namespace === namespace && entry.name === name)?.alias
    || `${sanitizedChatToolName(namespace, 'namespace')}__${sanitizedChatToolName(name)}`.slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
}

export function resolveResponsesToolIdentity(chatName, tools) {
  const compatibility = responsesToolCompatibility(tools, { rejectUnsupported: false });
  const exact = compatibility.aliases.find((entry) => entry.alias === chatName);
  if (exact) return { namespace: exact.namespace, name: exact.name };
  const directNames = new Set(asArray(tools).filter((tool) => tool?.type === 'function').map((tool) => tool.name));
  const childMatches = compatibility.aliases.filter((entry) => entry.name === chatName);
  if (!directNames.has(chatName) && childMatches.length === 1) return { namespace: childMatches[0].namespace, name: childMatches[0].name };
  return { name: chatName };
}

export function detectProtocol(path) {
  if (path.endsWith('/messages')) return 'claude';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (/\/models\/.+:(?:generateContent|streamGenerateContent)$/.test(path)) return 'gemini';
  return null;
}

export function upstreamProtocol(model, route = {}, provider = 'zen') {
  if (route.protocol && route.protocol !== 'auto') return route.protocol;
  const id = model.toLowerCase();
  if (id.startsWith('gpt-oss')) return 'chat';
  if (/^(gpt-|o(?:1|3|4)(?:-|$))/.test(id)) return 'responses';
  if (/^(claude-|qwen3\.[567])/.test(id)) return 'claude';
  if (provider === 'go' && id.startsWith('minimax-m')) return 'claude';
  return 'chat';
}

export function normalizeRequest(body, protocol) {
  const normalized = {
    model: body.model,
    stream: Boolean(body.stream),
    system: '',
    systemMessages: [],
    messages: [],
    tools: [],
    maxTokens: body.max_tokens || body.max_output_tokens || body.max_completion_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stop: body.stop_sequences || body.stop,
    toolChoice: normalizeToolChoice(body.tool_choice, protocol),
    parallelToolCalls: protocol === 'claude' && body.tool_choice?.disable_parallel_tool_use !== undefined
      ? !body.tool_choice.disable_parallel_tool_use
      : body.parallel_tool_calls,
    reasoningEffort: resolveReasoningEffort(body, protocol),
    metadata: body.metadata
  };

  if (protocol === 'gemini') {
    if (!Array.isArray(body.contents) || body.contents.length === 0) throw unsupportedFeature('Gemini contents 必须是非空数组');
    const generation = body.generationConfig || {};
    if (generation.candidateCount != null && generation.candidateCount !== 1) throw unsupportedFeature('跨协议转换仅支持 Gemini candidateCount=1');
    if (generation.responseMimeType && generation.responseMimeType !== 'text/plain') throw unsupportedFeature(`跨协议转换暂不支持 Gemini responseMimeType=${generation.responseMimeType}`);
    if (Array.isArray(generation.responseModalities) && (generation.responseModalities.length !== 1 || generation.responseModalities[0] !== 'TEXT')) {
      throw unsupportedFeature('跨协议转换仅支持 Gemini TEXT 响应模态');
    }
    if (body.safetySettings?.length) throw unsupportedFeature('跨协议转换暂不支持 Gemini safetySettings');
    normalized.maxTokens = generation.maxOutputTokens;
    normalized.temperature = generation.temperature;
    normalized.topP = generation.topP;
    normalized.stop = generation.stopSequences;
    const systemParts = normalizeGeminiParts(body.systemInstruction?.parts, { rejectUnknown: true });
    if (systemParts.some((part) => part.type !== 'text')) throw unsupportedFeature('Gemini systemInstruction 仅支持文本 Part');
    normalized.systemMessages = systemParts.map((part) => ({ text: part.text }));
    normalized.system = normalized.systemMessages.map((item) => item.text).join('\n');
    normalized.messages = asArray(body.contents).map((content, index) => {
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw unsupportedFeature(`Gemini contents[${index}] 必须是对象`);
      if (content?.role && !['user', 'model'].includes(content.role)) throw unsupportedFeature(`不支持 Gemini Content role：${content.role}`);
      const parts = normalizeGeminiParts(content.parts, { rejectUnknown: true });
      if (!parts.length) throw unsupportedFeature(`Gemini contents[${index}].parts 必须是非空数组`);
      return { role: content.role === 'model' ? 'assistant' : 'user', parts };
    });
    normalized.tools = asArray(body.tools).flatMap((tool) => asArray(tool?.functionDeclarations)).map((tool, index) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !tool.name) {
        throw unsupportedFeature(`Gemini functionDeclarations[${index}] 缺少有效 name`);
      }
      return { name: tool.name, description: tool.description, schema: tool.parametersJsonSchema || tool.parameters || {} };
    });
    const unsupportedTools = asArray(body.tools).filter((tool) => Object.keys(tool || {}).some((key) => key !== 'functionDeclarations'));
    if (unsupportedTools.length) throw unsupportedFeature('跨协议转换暂不支持 Gemini 内置工具；请只使用 functionDeclarations');
    normalized.toolChoice = normalizeGeminiToolChoice(body.toolConfig?.functionCallingConfig);
    if (body.cachedContent) throw unsupportedFeature('跨协议转换暂不支持 Gemini cachedContent');
    return normalized;
  }

  if (protocol === 'claude') {
    normalized.systemMessages = asArray(body.system).map((item) => ({
      text: stripLeadingBillingHeader(claudeSystemBlockText(item)),
      ...(item?.cache_control ? { cacheControl: item.cache_control } : {})
    })).filter((item) => item.text);
    normalized.system = normalized.systemMessages.map((item) => item.text).join('\n');
    normalized.messages = asArray(body.messages).map((message) => ({ role: message.role, parts: normalizeParts(message.content, { includeReasoning: true, rejectUnknown: true }) }));
    const unsupportedTools = asArray(body.tools).filter((tool) => tool.type);
    if (unsupportedTools.length) {
      const types = [...new Set(unsupportedTools.map((tool) => tool.type))].join(', ');
      throw unsupportedFeature(`跨协议转换暂不支持 Claude server tool 类型：${types}`);
    }
    normalized.tools = asArray(body.tools).map((tool) => ({ name: tool.name, description: tool.description, schema: tool.input_schema || {}, ...(tool.cache_control ? { cacheControl: tool.cache_control } : {}) }));
  } else if (protocol === 'responses') {
    normalized.system = body.instructions || '';
    const compatibility = responsesToolCompatibility(body.tools);
    normalized.tools = compatibility.tools;
    if (compatibility.droppedWebSearch) normalized.system += `${normalized.system ? '\n\n' : ''}${WEB_SEARCH_COMPATIBILITY_NOTICE}`;
    if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.type === 'function') {
      normalized.toolChoice = { type: 'tool', name: responsesToolAlias(body.tool_choice.namespace, body.tool_choice.name, compatibility.aliases) };
    } else if (compatibility.droppedWebSearch && (body.tool_choice === 'required' || RESPONSES_WEB_SEARCH_TOOL_TYPES.has(body.tool_choice?.type))) {
      normalized.toolChoice = { type: 'auto' };
    }
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : asArray(body.input);
    for (const item of input) {
      if (['custom_tool_call', 'custom_tool_call_output'].includes(item.type)) {
        throw unsupportedFeature('跨协议转换暂不支持 Responses custom tool；请使用 /responses 同协议路由或改用 function tool');
      }
      if (item.type === 'function_call') {
        normalized.messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: item.call_id || item.id, name: responsesToolAlias(item.namespace, item.name, compatibility.aliases), arguments: parseArguments(item.arguments) }] });
      } else if (item.type === 'function_call_output') {
        normalized.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: item.call_id, content: item.output }] });
      } else if (['system', 'developer'].includes(item.role)) {
        const text = normalizeParts(item.content, { rejectUnknown: true }).filter((part) => part.type === 'text').map((part) => part.text).join('');
        if (text) normalized.system += `${normalized.system ? '\n' : ''}${text}`;
      } else if (item.type && item.type !== 'message') {
        throw unsupportedFeature(`跨协议转换暂不支持 Responses 输入项类型：${item.type}`);
      } else {
        normalized.messages.push({ role: item.role || 'user', parts: normalizeParts(item.content, { rejectUnknown: true }) });
      }
    }
  } else {
    for (const message of asArray(body.messages)) {
      if (message.role === 'system' || message.role === 'developer') {
        normalized.system += `${normalized.system ? '\n' : ''}${typeof message.content === 'string' ? message.content : normalizeParts(message.content, { rejectUnknown: true }).map((x) => x.text || '').join('')}`;
        continue;
      }
      if (message.role === 'tool') {
        normalized.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: message.tool_call_id, content: message.content }] });
        continue;
      }
      const parts = normalizeParts(message.content, { rejectUnknown: true });
      const reasoning = message.reasoning_content || message.reasoning;
      if (reasoning) parts.unshift({ type: 'reasoning', text: reasoning });
      for (const call of asArray(message.tool_calls)) {
        parts.push({ type: 'tool_call', id: call.id, name: call.function?.name, arguments: parseArguments(call.function?.arguments) });
      }
      if (message.function_call) {
        parts.push({ type: 'tool_call', id: message.function_call.id || `call_${randomUUID().replaceAll('-', '')}`, name: message.function_call.name, arguments: parseArguments(message.function_call.arguments) });
      }
      if (message.refusal) parts.push({ type: 'text', text: message.refusal });
      normalized.messages.push({ role: message.role, parts });
    }
    const unsupportedTools = asArray(body.tools).filter((tool) => tool.type !== 'function');
    if (unsupportedTools.length) {
      const types = [...new Set(unsupportedTools.map((tool) => tool.type || 'unknown'))].join(', ');
      throw unsupportedFeature(`跨协议转换暂不支持 Chat 工具类型：${types}`);
    }
    normalized.tools = asArray(body.tools).map((tool) => ({ name: tool.function?.name, description: tool.function?.description, schema: tool.function?.parameters || {}, strict: tool.function?.strict }));
  }
  return normalized;
}

function normalizeGeminiParts(parts, { rejectUnknown = false } = {}) {
  return asArray(parts).flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      if (rejectUnknown) throw unsupportedFeature('Gemini parts 必须是对象');
      return [];
    }
    const inline = part.inlineData || part.inline_data;
    const file = part.fileData || part.file_data;
    const call = part.functionCall || part.function_call;
    const result = part.functionResponse || part.function_response;
    const variants = [typeof part.text === 'string', Boolean(inline), Boolean(file), Boolean(call), Boolean(result)].filter(Boolean).length;
    if (variants !== 1) {
      if (rejectUnknown) throw unsupportedFeature(variants > 1 ? 'Gemini Part 只能包含一种内容类型' : `跨协议转换暂不支持 Gemini Part：${Object.keys(part)[0] || 'unknown'}`);
      return [];
    }
    if (typeof part.text === 'string') return [{ type: part.thought ? 'reasoning' : 'text', text: part.text, ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) }];
    if (inline) {
      const mediaType = inline.mimeType || inline.mime_type || 'application/octet-stream';
      if (typeof inline.data !== 'string' || !inline.data) throw unsupportedFeature('Gemini inlineData 缺少 base64 data');
      const source = { type: 'base64', media_type: mediaType, data: inline.data || '' };
      return [mediaType.startsWith('image/') ? { type: 'image', source } : { type: 'file', source }];
    }
    if (file) {
      const mediaType = file.mimeType || file.mime_type || 'application/octet-stream';
      const url = file.fileUri || file.file_uri;
      if (typeof url !== 'string' || !url) throw unsupportedFeature('Gemini fileData 缺少 fileUri');
      const source = { type: 'url', url, media_type: mediaType };
      return [mediaType.startsWith('image/') ? { type: 'image', source } : { type: 'file', source }];
    }
    if (call) {
      if (typeof call.name !== 'string' || !call.name) throw unsupportedFeature('Gemini functionCall 缺少有效 name');
      if (call.args != null && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw unsupportedFeature('Gemini functionCall.args 必须是对象');
      return [{ type: 'tool_call', id: call.id || call.name || `call_${randomUUID().replaceAll('-', '')}`, name: call.name, arguments: call.args || {} }];
    }
    if (typeof result.name !== 'string' || !result.name) throw unsupportedFeature('Gemini functionResponse 缺少有效 name');
    if (result.response != null && (!result.response || typeof result.response !== 'object' || Array.isArray(result.response))) throw unsupportedFeature('Gemini functionResponse.response 必须是对象');
    return [{ type: 'tool_result', id: result.id || result.name, content: result.response ?? {} }];
  });
}

function normalizeGeminiToolChoice(config) {
  if (!config) return undefined;
  const mode = String(config.mode || 'AUTO').toUpperCase();
  const names = asArray(config.allowedFunctionNames).filter((name) => typeof name === 'string' && name);
  if (!['AUTO', 'ANY', 'NONE', 'VALIDATED'].includes(mode)) throw unsupportedFeature(`不支持 Gemini functionCallingConfig.mode：${mode}`);
  if (names.length > 1) throw unsupportedFeature('跨协议转换无法保留多个 allowedFunctionNames；请只指定一个函数名或移除该限制');
  if (mode === 'NONE') return { type: 'none' };
  if (mode === 'ANY') return names.length === 1 ? { type: 'tool', name: names[0] } : { type: 'any' };
  if (names.length) throw unsupportedFeature('allowedFunctionNames 仅能与 Gemini ANY 模式一起跨协议转换');
  return { type: 'auto' };
}

function parseArguments(value) {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeToolChoice(choice, protocol) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return { type: choice === 'required' ? 'any' : choice };
  if (protocol === 'claude') return { type: choice.type, name: choice.name };
  if (protocol === 'responses') return choice.type === 'function' ? { type: 'tool', name: choice.name } : { type: choice.type };
  return choice.type === 'function' ? { type: 'tool', name: choice.function?.name } : { type: choice.type };
}

function formatToolChoice(choice, protocol) {
  if (!choice) return undefined;
  if (protocol === 'claude') {
    if (choice.type === 'required') return { type: 'any' };
    if (choice.type === 'tool') return { type: 'tool', name: choice.name };
    return { type: choice.type };
  }
  if (protocol === 'responses') {
    if (choice.type === 'any') return 'required';
    if (choice.type === 'tool') return { type: 'function', name: choice.name };
    return choice.type;
  }
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return choice.type;
}

function claudeToolChoice(request) {
  if (!request.tools.length || (!request.toolChoice && request.parallelToolCalls === undefined)) return undefined;
  return {
    ...(request.toolChoice ? formatToolChoice(request.toolChoice, 'claude') : { type: 'auto' }),
    ...(request.parallelToolCalls !== undefined ? { disable_parallel_tool_use: !request.parallelToolCalls } : {})
  };
}

function imageDataUrl(source) {
  if (source?.type === 'url') return source.url;
  if (source?.type === 'base64') return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  return undefined;
}

function fileDataUrl(source) {
  if (source?.type !== 'base64') return undefined;
  return `data:${source.media_type || 'application/pdf'};base64,${source.data}`;
}

function fallbackFilename(source) {
  if (['text', 'content'].includes(source?.type)) return 'document.txt';
  const mediaType = String(source?.media_type || '').split(';', 1)[0].trim().toLowerCase();
  const extension = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/markdown': 'md',
    'application/json': 'json'
  }[mediaType] || 'bin';
  return `document.${extension}`;
}

function textualMediaType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType.startsWith('text/')
    || ['application/json', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/yaml', 'application/x-yaml', 'application/toml', 'application/sql'].includes(mediaType)
    || mediaType.endsWith('+json')
    || mediaType.endsWith('+xml');
}

function decodeBase64Utf8(data) {
  const compact = String(data || '').replace(/\s/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw unsupportedFeature('Claude 文本附件包含无效的 base64 数据');
  }
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw unsupportedFeature('Claude 文本附件包含无效的 base64 数据');
  }
  try { return UTF8_DECODER.decode(buffer); }
  catch { throw unsupportedFeature('Claude 文本附件不是有效的 UTF-8 文本'); }
}

function textDocumentData(part) {
  const source = part?.source;
  if (source?.type === 'text') {
    if (typeof source.data !== 'string') throw unsupportedFeature('Claude 文本附件缺少字符串 data');
    return source.data;
  }
  if (source?.type === 'content') {
    if (!Array.isArray(source.content)) throw unsupportedFeature('Claude 自定义文本附件缺少 content 数组');
    if (source.content.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
      throw unsupportedFeature('Chat Completions 只能内联全部由文本块组成的 Claude 附件');
    }
    return source.content.map((block) => block.text).join('\n');
  }
  if (source?.type === 'base64' && textualMediaType(source.media_type)) {
    if (typeof source.data !== 'string') throw unsupportedFeature('Claude 文本附件缺少 base64 data');
    return decodeBase64Utf8(source.data);
  }
  return undefined;
}

function chatTextDocumentPart(part) {
  const text = textDocumentData(part);
  if (text === undefined) return undefined;
  const metadata = {
    name: part.title || part.filename || fallbackFilename(part.source),
    ...(typeof part.context === 'string' && part.context ? { context: part.context } : {})
  };
  return {
    type: 'text',
    text: `[Attached text document ${canonicalJsonString(metadata)}]\n${text}\n[End attached text document]`,
    ...(part.cacheControl ? { cache_control: part.cacheControl } : {})
  };
}

function responsesFilePart(part) {
  if (part.source?.type === 'url') return { type: 'input_file', file_url: part.source.url, ...(part.detail ? { detail: part.detail } : {}) };
  if (part.source?.type === 'file') return { type: 'input_file', file_id: part.source.file_id, ...(part.detail ? { detail: part.detail } : {}) };
  const file_data = fileDataUrl(part.source);
  if (file_data) return { type: 'input_file', filename: part.filename || fallbackFilename(part.source), file_data, ...(part.detail ? { detail: part.detail } : {}) };
  throw unsupportedFeature('文件内容块缺少可转换的 URL、file_id 或 base64 数据');
}

function chatImagePart(part, imageHandoffEnabled) {
  if (imageHandoffEnabled) {
    return { type: 'text', text: '[图片未发送：当前模型不支持图片输入。]' };
  }
  const url = imageDataUrl(part.source);
  if (!url) throw unsupportedFeature('Chat Completions 无法表达 image file_id；请改用图片 URL/base64，或将模型路由设为 responses/claude');
  return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
}

function replaceUnsupportedChatImages(body, imageHandoffEnabled) {
  if (!imageHandoffEnabled || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (!['image', 'image_url', 'input_image'].includes(part?.type)) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: '[图片未发送：当前模型不支持图片输入。]' };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...body, messages } : body;
}

function appendChatAssistantMessage(messages, next) {
  const previous = messages.at(-1);
  if (next.role !== 'assistant' || previous?.role !== 'assistant') {
    messages.push(next);
    return;
  }
  if (next.content) {
    if (!previous.content) previous.content = next.content;
    else if (typeof previous.content === 'string' && typeof next.content === 'string') previous.content += next.content;
    else {
      const contentParts = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content);
      previous.content = [...contentParts(previous.content), ...contentParts(next.content)];
    }
  }
  if (next.tool_calls?.length) previous.tool_calls = [...asArray(previous.tool_calls), ...next.tool_calls];
  if (next.reasoning_content && next.reasoning_content !== previous.reasoning_content && next.reasoning_content !== 'tool call') {
    previous.reasoning_content = [previous.reasoning_content, next.reasoning_content].filter((text) => text && text !== 'tool call').join('\n') || 'tool call';
  }
}

function claudeContent(parts, { includeReasoning = false } = {}) {
  return parts.flatMap((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', source: part.source };
    if (part.type === 'file') {
      if (!part.source) throw unsupportedFeature('文件内容块缺少可转换的 URL、file_id 或 base64 数据');
      return {
        type: 'document', source: part.source,
        ...(part.title || part.filename ? { title: part.title || part.filename } : {}),
        ...(part.context ? { context: part.context } : {}),
        ...(part.citations !== undefined ? { citations: part.citations } : {}),
        ...(part.cacheControl ? { cache_control: part.cacheControl } : {})
      };
    }
    if (part.type === 'tool_call') return { type: 'tool_use', id: part.id, name: part.name, input: sanitizeToolArguments(part.name, part.arguments) };
    if (part.type === 'tool_result') return { type: 'tool_result', tool_use_id: part.id, content: part.content };
    if (includeReasoning && part.type === 'reasoning') return { type: 'thinking', thinking: part.text || '', signature: part.signature || 'bridge' };
    return [];
  });
}

export function formatRequest(request, protocol, options = {}) {
  const common = Object.fromEntries(Object.entries({
    model: request.model,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.topP
  }).filter(([, value]) => value !== undefined));

  if (protocol === 'claude') {
    const toolChoice = claudeToolChoice(request);
    return {
      ...common,
      max_tokens: request.maxTokens || 8192,
      ...(typeof request.metadata?.user_id === 'string' ? { metadata: { user_id: request.metadata.user_id } } : {}),
      ...(request.system ? { system: request.system } : {}),
      ...(request.stop ? { stop_sequences: asArray(request.stop) } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages: mergeClaudeMessages(request.messages),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema })) } : {})
    };
  }

  if (protocol === 'responses') {
    if (asArray(request.stop).length) throw unsupportedFeature('Responses API 不支持 stop/stop_sequences；请移除停止词或将模型路由设为 chat/claude');
    const input = [];
    for (const message of request.messages) {
      const content = [];
      const actions = [];
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
        else if (part.type === 'image') {
          const image_url = imageDataUrl(part.source);
          if (!image_url && !(part.source?.type === 'file' && part.source.file_id)) throw unsupportedFeature('图片内容块缺少可转换的 URL、file_id 或 base64 数据');
          content.push({ type: 'input_image', ...(image_url ? { image_url } : { file_id: part.source.file_id }), ...(part.detail ? { detail: part.detail } : {}) });
        }
        else if (part.type === 'file') content.push(responsesFilePart(part));
        else if (part.type === 'tool_call') actions.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: canonicalJsonString(part.arguments) });
        else if (part.type === 'tool_result') actions.push({ type: 'function_call_output', call_id: part.id, output: typeof part.content === 'string' ? part.content : canonicalJsonString(part.content) });
      }
      if (message.role !== 'assistant') input.push(...actions);
      if (content.length) input.push({ role: message.role, content });
      if (message.role === 'assistant') input.push(...actions);
    }
    return {
      ...common,
      ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
      ...(request.reasoningEffort && supportsReasoningEffort(request.model) ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata) ? { metadata: request.metadata } : {}),
      ...(request.system ? { instructions: request.system } : {}),
      ...(request.tools.length && request.toolChoice ? { tool_choice: formatToolChoice(request.toolChoice, 'responses') } : {}),
      ...(request.tools.length && request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      input,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: cleanSchema(tool.schema), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) })) } : {})
    };
  }

  const messages = request.systemMessages?.length
    ? request.systemMessages.map((item) => ({ role: 'system', content: item.text, ...(item.cacheControl ? { cache_control: item.cacheControl } : {}) }))
    : request.system ? [{ role: 'system', content: request.system }] : [];
  for (const message of request.messages) {
    const textParts = message.parts.filter((x) => x.type === 'text');
    const images = message.parts.filter((x) => x.type === 'image');
    const files = message.parts.filter((x) => x.type === 'file');
    const chatFiles = new Map(files.map((file) => [file, chatTextDocumentPart(file)]));
    if ([...chatFiles.values()].some((part) => !part)) {
      throw unsupportedFeature('Chat Completions 跨协议转换无法无损表达非文本文件内容块；请将该模型路由设为 responses 或 claude');
    }
    const text = textParts.map((x) => x.text).join('');
    const hasCacheControl = textParts.some((part) => part.cacheControl);
    const richContent = message.parts.flatMap((part) => {
      if (part.type === 'text') return [{ type: 'text', text: part.text, ...(part.cacheControl ? { cache_control: part.cacheControl } : {}) }];
      if (part.type === 'image') return [chatImagePart(part, options.imageHandoffEnabled)];
      if (part.type === 'file') return [chatFiles.get(part)];
      return [];
    });
    const calls = message.parts.filter((x) => x.type === 'tool_call');
    const results = message.parts.filter((x) => x.type === 'tool_result');
    const reasoning = message.parts.filter((x) => x.type === 'reasoning').map((x) => x.text).filter(Boolean).join('\n');
    for (const result of results) messages.push({ role: 'tool', tool_call_id: result.id, content: typeof result.content === 'string' ? result.content : canonicalJsonString(result.content) });
    if (text || images.length || files.length || calls.length) appendChatAssistantMessage(messages, {
      role: message.role,
      content: images.length || files.length || hasCacheControl ? richContent : (text || null),
      ...(message.role === 'assistant' && usesReasoningContent(request.model) && (reasoning || calls.length) ? { reasoning_content: reasoning || 'tool call' } : {}),
      ...(calls.length ? { tool_calls: calls.map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: canonicalJsonString(x.arguments) } })) } : {})
    });
  }
  const reasoningEffort = request.reasoningEffort && (supportsReasoningEffort(request.model) || (request.reasoningEffort === 'none' && needsNonThinkingToolMode(request.model)))
    ? request.reasoningEffort
    : !request.reasoningEffort && request.tools.length && needsNonThinkingToolMode(request.model) ? 'none' : undefined;
  return {
    ...common,
    ...(request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata) ? { metadata: request.metadata } : {}),
    ...(request.maxTokens ? { [isOpenAiOSeries(request.model) ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(request.tools.length && request.toolChoice ? { tool_choice: formatToolChoice(request.toolChoice, 'chat') } : {}),
    ...(request.tools.length && request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    messages,
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: cleanSchema(tool.schema), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }, ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}) })) } : {})
  };
}

function mergeClaudeMessages(messages) {
  const result = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = claudeContent(message.parts);
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

export function prepareUpstreamRequest(body, incomingProtocol, targetProtocol, upstreamModel, options = {}) {
  if (incomingProtocol === targetProtocol) {
    const upstreamBody = withStreamUsage({ ...body, model: upstreamModel }, targetProtocol);
    return applyCompatibilityOptions(replaceUnsupportedChatImages(upstreamBody, options.imageHandoffEnabled), targetProtocol, options);
  }
  const normalized = normalizeRequest(body, incomingProtocol);
  normalized.model = upstreamModel;
  return applyCompatibilityOptions(formatRequest(normalized, targetProtocol, options), targetProtocol, options);
}

function withStreamUsage(body, protocol) {
  if (protocol !== 'chat' || body.stream !== true) return body;
  const streamOptions = body.stream_options;
  if (streamOptions !== undefined && streamOptions !== null && (typeof streamOptions !== 'object' || Array.isArray(streamOptions))) return body;
  return { ...body, stream_options: { ...(streamOptions || {}), include_usage: true } };
}

export function hasUsageData(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  if (['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']
    .some((field) => Object.hasOwn(usage, field) && parsedUsageCount(usage[field]) !== null)) return true;
  return [usage.input_tokens_details, usage.prompt_tokens_details, usage.output_tokens_details, usage.completion_tokens_details]
    .some((details) => details && typeof details === 'object' && !Array.isArray(details)
      && ['cached_tokens', 'cache_write_tokens', 'cache_creation_tokens', 'reasoning_tokens']
        .some((field) => Object.hasOwn(details, field) && parsedUsageCount(details[field]) !== null));
}

export function normalizeUsageCount(...candidates) {
  for (const value of candidates) {
    const parsed = parsedUsageCount(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function applyCompatibilityOptions(body, protocol, options) {
  if (protocol !== 'chat' || options.toolChoiceFallback !== 'auto' || !asArray(body.tools).length || !body.tool_choice || body.tool_choice === 'none' || body.tool_choice === 'auto') return body;
  return { ...body, tool_choice: 'auto' };
}

export function normalizeResponse(body, protocol, fallbackModel = '', { rejectUnknown = false } = {}) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('上游响应必须是 JSON 对象');
  if (protocol === 'claude' && !Array.isArray(body.content)) throw new Error('上游 Claude 响应缺少 content 数组');
  if (protocol === 'responses' && !Array.isArray(body.output)) throw new Error('上游 Responses 响应缺少 output 数组');
  if (protocol === 'chat' && (!Array.isArray(body.choices) || !body.choices[0]?.message || typeof body.choices[0].message !== 'object')) {
    throw new Error('上游 Chat 响应缺少 choices[0].message');
  }
  if (protocol === 'gemini') {
    if (!Array.isArray(body.candidates) || !body.candidates[0]?.content || !Array.isArray(body.candidates[0].content.parts)) {
      throw new Error('上游 Gemini 响应缺少 candidates[0].content.parts');
    }
    const candidate = body.candidates[0];
    return {
      id: body.responseId, model: body.modelVersion || fallbackModel,
      parts: normalizeGeminiParts(candidate.content.parts, { rejectUnknown }),
      inputTokens: normalizeUsageCount(body.usageMetadata?.promptTokenCount),
      outputTokens: normalizeUsageCount(body.usageMetadata?.candidatesTokenCount),
      cachedInputTokens: normalizeUsageCount(body.usageMetadata?.cachedContentTokenCount),
      cacheCreationInputTokens: 0,
      reasoningTokens: normalizeUsageCount(body.usageMetadata?.thoughtsTokenCount),
      stopReason: candidate.finishReason
    };
  }
  if (protocol === 'claude') return {
    id: body.id, model: body.model || fallbackModel,
    parts: normalizeParts(body.content, { includeReasoning: true, rejectUnknown }),
    inputTokens: normalizeUsageCount(body.usage?.input_tokens), outputTokens: normalizeUsageCount(body.usage?.output_tokens),
    cachedInputTokens: normalizeUsageCount(body.usage?.cache_read_input_tokens),
    cacheCreationInputTokens: normalizeUsageCount(body.usage?.cache_creation_input_tokens),
    reasoningTokens: 0,
    stopReason: body.stop_reason
  };
  if (protocol === 'responses') {
    const parts = [];
    for (const item of asArray(body.output)) {
      if (item.type === 'message') parts.push(...normalizeParts(item.content));
      if (item.type === 'function_call') parts.push({ type: 'tool_call', id: item.call_id || item.id, name: item.name, arguments: sanitizeToolArguments(item.name, parseArguments(item.arguments)) });
      if (item.type === 'reasoning') {
        const text = asArray(item.summary).filter((part) => part.type === 'summary_text').map((part) => part.text || '').join('');
        if (text) parts.push({ type: 'reasoning', text });
      }
      if (rejectUnknown && !['message', 'function_call', 'reasoning'].includes(item.type)) throw new Error(`上游 Responses 输出项类型无法跨协议转换：${item.type || 'unknown'}`);
    }
    return {
      id: body.id, model: body.model || fallbackModel, parts,
      inputTokens: normalizeUsageCount(body.usage?.input_tokens, body.usage?.prompt_tokens), outputTokens: normalizeUsageCount(body.usage?.output_tokens, body.usage?.completion_tokens),
      cachedInputTokens: normalizeUsageCount(body.usage?.cache_read_input_tokens, body.usage?.prompt_cache_hit_tokens, body.usage?.input_tokens_details?.cached_tokens, body.usage?.prompt_tokens_details?.cached_tokens),
      cacheCreationInputTokens: normalizeUsageCount(body.usage?.cache_creation_input_tokens, body.usage?.input_tokens_details?.cache_write_tokens, body.usage?.input_tokens_details?.cache_creation_tokens, body.usage?.prompt_tokens_details?.cache_write_tokens, body.usage?.prompt_tokens_details?.cache_creation_tokens),
      reasoningTokens: normalizeUsageCount(body.usage?.output_tokens_details?.reasoning_tokens, body.usage?.completion_tokens_details?.reasoning_tokens),
      stopReason: responsesStopReason(body)
    };
  }
  const choice = body.choices?.[0] || {};
  const message = choice.message || {};
  const parts = normalizeParts(message.content, { rejectUnknown });
  if (message.refusal) parts.push({ type: 'text', text: message.refusal });
  const messageReasoning = message.reasoning_content || message.reasoning;
  if (messageReasoning) parts.unshift({ type: 'reasoning', text: messageReasoning });
  for (const call of asArray(message.tool_calls)) parts.push({ type: 'tool_call', id: call.id, name: call.function?.name, arguments: sanitizeToolArguments(call.function?.name, parseArguments(call.function?.arguments)) });
  if (message.function_call) parts.push({ type: 'tool_call', id: message.function_call.id || `call_${randomUUID().replaceAll('-', '')}`, name: message.function_call.name, arguments: sanitizeToolArguments(message.function_call.name, parseArguments(message.function_call.arguments)) });
  return {
    id: body.id, model: body.model || fallbackModel, parts,
    inputTokens: normalizeUsageCount(body.usage?.prompt_tokens, body.usage?.input_tokens), outputTokens: normalizeUsageCount(body.usage?.completion_tokens, body.usage?.output_tokens),
    cachedInputTokens: normalizeUsageCount(body.usage?.cache_read_input_tokens, body.usage?.prompt_cache_hit_tokens, body.usage?.prompt_tokens_details?.cached_tokens),
    cacheCreationInputTokens: normalizeUsageCount(body.usage?.cache_creation_input_tokens, body.usage?.prompt_tokens_details?.cache_write_tokens, body.usage?.prompt_tokens_details?.cache_creation_tokens),
    reasoningTokens: normalizeUsageCount(body.usage?.completion_tokens_details?.reasoning_tokens),
    stopReason: choice.finish_reason
  };
}

export function formatResponse(response, protocol, responsesOptions = {}) {
  response = {
    ...response,
    inputTokens: normalizeUsageCount(response.inputTokens),
    outputTokens: normalizeUsageCount(response.outputTokens),
    cachedInputTokens: normalizeUsageCount(response.cachedInputTokens),
    cacheCreationInputTokens: normalizeUsageCount(response.cacheCreationInputTokens),
    reasoningTokens: normalizeUsageCount(response.reasoningTokens)
  };
  if (protocol === 'gemini') {
    assertOutputPartsSupported(response.parts, protocol, new Set(['text', 'reasoning', 'tool_call', 'image', 'file']));
    const parts = response.parts.map(geminiResponsePart);
    return {
      candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinishReason(response.stopReason), index: 0 }],
      usageMetadata: {
        promptTokenCount: response.inputTokens,
        candidatesTokenCount: response.outputTokens,
        totalTokenCount: normalizeUsageCount(response.inputTokens + response.outputTokens),
        ...(response.cachedInputTokens ? { cachedContentTokenCount: response.cachedInputTokens } : {}),
        ...(response.reasoningTokens ? { thoughtsTokenCount: response.reasoningTokens } : {})
      },
      ...(response.model ? { modelVersion: response.model } : {}),
      ...(response.id ? { responseId: response.id } : {})
    };
  }
  if (protocol === 'claude') return {
    id: response.id || `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: response.model,
    content: claudeContent(response.parts, { includeReasoning: true }), stop_reason: response.parts.some((x) => x.type === 'tool_call') ? 'tool_use' : claudeStopReason(response.stopReason), stop_sequence: null,
    usage: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens,
      ...(response.cachedInputTokens ? { cache_read_input_tokens: response.cachedInputTokens } : {}),
      ...(response.cacheCreationInputTokens ? { cache_creation_input_tokens: response.cacheCreationInputTokens } : {})
    }
  };
  if (protocol === 'responses') {
    assertOutputPartsSupported(response.parts, protocol, new Set(['text', 'reasoning', 'tool_call']));
    const incomplete = ['length', 'max_tokens', 'max_output_tokens'].includes(response.stopReason);
    return {
    id: response.id || `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: response.model,
    ...(incomplete ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } : {}),
    parallel_tool_calls: typeof responsesOptions.parallelToolCalls === 'boolean' ? responsesOptions.parallelToolCalls : true,
    tool_choice: responsesOptions.toolChoice ?? 'auto', tools: Array.isArray(responsesOptions.tools) ? responsesOptions.tools : [],
    output: response.parts.flatMap((part, index) => {
      if (part.type === 'tool_call') {
        const identity = resolveResponsesToolIdentity(part.name, responsesOptions.tools);
        return { id: `fc_${index}`, type: 'function_call', status: 'completed', call_id: part.id, ...identity, arguments: canonicalJsonString(part.arguments) };
      }
      if (part.type === 'reasoning') return { id: `rs_${index}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: part.text || '' }] };
      if (part.type === 'text') return { id: `msg_${index}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: part.text || '', annotations: [] }] };
      return [];
    }),
    usage: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens, total_tokens: normalizeUsageCount(response.inputTokens + response.outputTokens),
      input_tokens_details: { cached_tokens: response.cachedInputTokens || 0, cache_write_tokens: response.cacheCreationInputTokens || 0 },
      output_tokens_details: { reasoning_tokens: response.reasoningTokens || 0 }
    }
    };
  }
  assertOutputPartsSupported(response.parts, protocol, new Set(['text', 'reasoning', 'tool_call']));
  return {
    id: response.id || `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: response.model,
    choices: [{ index: 0, message: { role: 'assistant', content: response.parts.filter((x) => x.type === 'text').map((x) => x.text).join('') || null,
      ...(response.parts.some((x) => x.type === 'reasoning') ? { reasoning_content: response.parts.filter((x) => x.type === 'reasoning').map((x) => x.text).join('') } : {}),
      ...(response.parts.some((x) => x.type === 'tool_call') ? { tool_calls: response.parts.filter((x) => x.type === 'tool_call').map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: canonicalJsonString(x.arguments) } })) } : {}) }, finish_reason: chatStopReason(response.stopReason, response.parts) }],
    usage: {
      prompt_tokens: response.inputTokens, completion_tokens: response.outputTokens, total_tokens: normalizeUsageCount(response.inputTokens + response.outputTokens),
      ...((response.cachedInputTokens || response.cacheCreationInputTokens) ? { prompt_tokens_details: {
        ...(response.cachedInputTokens ? { cached_tokens: response.cachedInputTokens } : {}),
        ...(response.cacheCreationInputTokens ? { cache_creation_tokens: response.cacheCreationInputTokens } : {})
      } } : {}),
      ...(response.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: response.reasoningTokens } } : {})
    }
  };
}

function geminiResponsePart(part) {
  if (part.type === 'text') return { text: part.text || '' };
  if (part.type === 'reasoning') return { text: part.text || '', thought: true, ...(part.signature ? { thoughtSignature: part.signature } : {}) };
  if (part.type === 'tool_call') return { functionCall: { name: part.name, args: sanitizeToolArguments(part.name, part.arguments), ...(part.id ? { id: part.id } : {}) } };
  const source = part.source;
  if (source?.type === 'base64') return { inlineData: { mimeType: source.media_type || (part.type === 'image' ? 'image/png' : 'application/octet-stream'), data: source.data || '' } };
  if (source?.type === 'url') return { fileData: { mimeType: source.media_type || (part.type === 'image' ? 'image/*' : 'application/octet-stream'), fileUri: source.url } };
  throw unsupportedFeature(`Gemini 无法表达 ${part.type} file_id；请改用 URL 或 base64 数据`);
}

function geminiFinishReason(reason) {
  if (['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS'].includes(reason)) return 'MAX_TOKENS';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) return reason;
  return 'STOP';
}

function assertOutputPartsSupported(parts, protocol, supported) {
  const unsupported = [...new Set(parts.filter((part) => !supported.has(part.type)).map((part) => part.type || 'unknown'))];
  if (unsupported.length) throw unsupportedFeature(`跨协议转换到 ${protocol} 时无法表达上游响应内容块：${unsupported.join(', ')}`);
}

function parsedUsageCount(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, number);
}

function responsesStopReason(body) {
  if (body.status !== 'incomplete') return 'end_turn';
  const reason = body.incomplete_details?.reason;
  return !reason || ['max_output_tokens', 'max_tokens'].includes(reason) ? 'max_tokens' : 'end_turn';
}

function claudeStopReason(reason) {
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

function chatStopReason(reason, parts) {
  if (parts.some((part) => part.type === 'tool_call')) return 'tool_calls';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  return 'stop';
}
