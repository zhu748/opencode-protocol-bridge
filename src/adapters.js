import { randomUUID } from 'node:crypto';

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

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

export function detectProtocol(path) {
  if (path.endsWith('/messages')) return 'claude';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat';
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

  if (protocol === 'claude') {
    normalized.systemMessages = asArray(body.system).map((item) => ({
      text: stripLeadingBillingHeader(typeof item === 'string' ? item : item?.text || ''),
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
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : asArray(body.input);
    for (const item of input) {
      if (['custom_tool_call', 'custom_tool_call_output'].includes(item.type)) {
        throw unsupportedFeature('跨协议转换暂不支持 Responses custom tool；请使用 /responses 同协议路由或改用 function tool');
      }
      if (item.type === 'function_call') {
        normalized.messages.push({ role: 'assistant', parts: [{ type: 'tool_call', id: item.call_id || item.id, name: item.name, arguments: parseArguments(item.arguments) }] });
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
    const unsupportedTools = asArray(body.tools).filter((tool) => tool.type !== 'function');
    if (unsupportedTools.length) {
      const types = [...new Set(unsupportedTools.map((tool) => tool.type || 'unknown'))].join(', ');
      throw unsupportedFeature(`跨协议转换暂不支持 Responses 工具类型：${types}；请使用 /responses 同协议路由或改用 function tool`);
    }
    normalized.tools = asArray(body.tools).filter((tool) => tool.type === 'function').map((tool) => ({ name: tool.name, description: tool.description, schema: tool.parameters || {}, strict: tool.strict }));
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
  const extension = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/json': 'json'
  }[source?.media_type] || 'bin';
  return `document.${extension}`;
}

function responsesFilePart(part) {
  if (part.source?.type === 'url') return { type: 'input_file', file_url: part.source.url, ...(part.detail ? { detail: part.detail } : {}) };
  if (part.source?.type === 'file') return { type: 'input_file', file_id: part.source.file_id, ...(part.detail ? { detail: part.detail } : {}) };
  const file_data = fileDataUrl(part.source);
  if (file_data) return { type: 'input_file', filename: part.filename || fallbackFilename(part.source), file_data, ...(part.detail ? { detail: part.detail } : {}) };
  throw unsupportedFeature('文件内容块缺少可转换的 URL、file_id 或 base64 数据');
}

function chatImagePart(part) {
  const url = imageDataUrl(part.source);
  if (!url) throw unsupportedFeature('Chat Completions 无法表达 image file_id；请改用图片 URL/base64，或将模型路由设为 responses/claude');
  return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
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

export function formatRequest(request, protocol) {
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
    if (files.length) throw unsupportedFeature('Chat Completions 跨协议转换无法无损表达文件内容块；请将该模型路由设为 responses 或 claude');
    const text = textParts.map((x) => x.text).join('');
    const hasCacheControl = textParts.some((part) => part.cacheControl);
    const calls = message.parts.filter((x) => x.type === 'tool_call');
    const results = message.parts.filter((x) => x.type === 'tool_result');
    const reasoning = message.parts.filter((x) => x.type === 'reasoning').map((x) => x.text).filter(Boolean).join('\n');
    for (const result of results) messages.push({ role: 'tool', tool_call_id: result.id, content: typeof result.content === 'string' ? result.content : canonicalJsonString(result.content) });
    if (text || images.length || calls.length) appendChatAssistantMessage(messages, {
      role: message.role,
      content: images.length || hasCacheControl ? [...textParts.map((x) => ({ type: 'text', text: x.text, ...(x.cacheControl ? { cache_control: x.cacheControl } : {}) })), ...images.map(chatImagePart)] : (text || null),
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
  if (incomingProtocol === targetProtocol) return applyCompatibilityOptions(withStreamUsage({ ...body, model: upstreamModel }, targetProtocol), targetProtocol, options);
  const normalized = normalizeRequest(body, incomingProtocol);
  normalized.model = upstreamModel;
  return applyCompatibilityOptions(formatRequest(normalized, targetProtocol), targetProtocol, options);
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
    .some((field) => Object.hasOwn(usage, field))) return true;
  return [usage.input_tokens_details, usage.prompt_tokens_details, usage.output_tokens_details, usage.completion_tokens_details]
    .some((details) => details && typeof details === 'object' && !Array.isArray(details)
      && ['cached_tokens', 'cache_creation_tokens', 'reasoning_tokens'].some((field) => Object.hasOwn(details, field)));
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
  if (protocol === 'claude') return {
    id: body.id, model: body.model || fallbackModel,
    parts: normalizeParts(body.content, { includeReasoning: true, rejectUnknown }),
    inputTokens: body.usage?.input_tokens || 0, outputTokens: body.usage?.output_tokens || 0,
    cachedInputTokens: body.usage?.cache_read_input_tokens || 0,
    cacheCreationInputTokens: body.usage?.cache_creation_input_tokens || 0,
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
      inputTokens: body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
      cachedInputTokens: body.usage?.cache_read_input_tokens || body.usage?.prompt_cache_hit_tokens || body.usage?.input_tokens_details?.cached_tokens || body.usage?.prompt_tokens_details?.cached_tokens || 0,
      cacheCreationInputTokens: body.usage?.cache_creation_input_tokens || body.usage?.input_tokens_details?.cache_creation_tokens || body.usage?.prompt_tokens_details?.cache_creation_tokens || 0,
      reasoningTokens: body.usage?.output_tokens_details?.reasoning_tokens || body.usage?.completion_tokens_details?.reasoning_tokens || 0,
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
    inputTokens: body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? body.usage?.output_tokens ?? 0,
    cachedInputTokens: body.usage?.cache_read_input_tokens || body.usage?.prompt_cache_hit_tokens || body.usage?.prompt_tokens_details?.cached_tokens || 0,
    cacheCreationInputTokens: body.usage?.cache_creation_input_tokens || body.usage?.prompt_tokens_details?.cache_creation_tokens || 0,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens || 0,
    stopReason: choice.finish_reason
  };
}

export function formatResponse(response, protocol) {
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
    output: response.parts.flatMap((part, index) => {
      if (part.type === 'tool_call') return { id: `fc_${index}`, type: 'function_call', status: 'completed', call_id: part.id, name: part.name, arguments: canonicalJsonString(part.arguments) };
      if (part.type === 'reasoning') return { id: `rs_${index}`, type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: part.text || '' }] };
      if (part.type === 'text') return { id: `msg_${index}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: part.text || '', annotations: [] }] };
      return [];
    }),
    usage: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens, total_tokens: response.inputTokens + response.outputTokens,
      ...((response.cachedInputTokens || response.cacheCreationInputTokens) ? { input_tokens_details: {
        ...(response.cachedInputTokens ? { cached_tokens: response.cachedInputTokens } : {}),
        ...(response.cacheCreationInputTokens ? { cache_creation_tokens: response.cacheCreationInputTokens } : {})
      } } : {}),
      ...(response.reasoningTokens ? { output_tokens_details: { reasoning_tokens: response.reasoningTokens } } : {})
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
      prompt_tokens: response.inputTokens, completion_tokens: response.outputTokens, total_tokens: response.inputTokens + response.outputTokens,
      ...((response.cachedInputTokens || response.cacheCreationInputTokens) ? { prompt_tokens_details: {
        ...(response.cachedInputTokens ? { cached_tokens: response.cachedInputTokens } : {}),
        ...(response.cacheCreationInputTokens ? { cache_creation_tokens: response.cacheCreationInputTokens } : {})
      } } : {}),
      ...(response.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: response.reasoningTokens } } : {})
    }
  };
}

function assertOutputPartsSupported(parts, protocol, supported) {
  const unsupported = [...new Set(parts.filter((part) => !supported.has(part.type)).map((part) => part.type || 'unknown'))];
  if (unsupported.length) throw unsupportedFeature(`跨协议转换到 ${protocol} 时无法表达上游响应内容块：${unsupported.join(', ')}`);
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
