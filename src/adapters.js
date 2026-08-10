import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { claudeSystemBlockText, isClaudeMidTurnUserMessage } from './prompt-rewrite.js';
import { openCodeModelCapability } from './model-capabilities.js';
import { remoteImageHandoffNotice, UNSUPPORTED_IMAGE_NOTICE } from './image-handoff.js';
import { addClaudeToolReferenceNames, claudeToolReferenceNames, validateClaudeCacheControl, validateClaudeCompactionBlock, validateClaudeFallbackBlock, validateClaudeThinkingBlock, validateClaudeToolOptionalFields } from './claude-tools.js';
import { decodeReasoningState, encodeReasoningState, encodeReasoningStateBundle, GEMINI_BRIDGE_STATE_TEXT } from './reasoning-state.js';
import { assertJsonComplexity } from './json-complexity.js';

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';
const CHAT_TOOL_NAME_MAX_LENGTH = 64;
const RESPONSES_WEB_SEARCH_TOOL_TYPES = new Set(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11']);
const RESPONSES_TOOL_CALLERS = new Set(['direct', 'programmatic']);
const RESPONSES_PROMPT_CACHE_BLOCK_TYPES = new Set(['input_text', 'input_image', 'input_file']);
const CHAT_PROMPT_CACHE_BLOCK_TYPES = new Set(['text', 'image_url', 'input_audio', 'file', 'refusal']);
const WEB_SEARCH_COMPATIBILITY_NOTICE = 'Protocol bridge compatibility: this non-Responses upstream cannot execute the hosted web_search tool. Do not claim to have searched the web; use another available function tool or explain that web search is unavailable.';
const CLAUDE_TOOL_ERROR_PREFIX = '[Claude tool_result is_error=true]';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const NORMALIZED_CLAUDE_TOOL_REFERENCES = new WeakMap();
const GEMINI_GENERATION_KEYS = new Set([
  'stopSequences', 'responseMimeType', 'responseSchema', '_responseJsonSchema', 'responseJsonSchema',
  'responseModalities', 'candidateCount', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'seed',
  'presencePenalty', 'frequencyPenalty', 'responseLogprobs', 'logprobs', 'responseFormat', 'thinkingConfig'
]);
const GEMINI_THINKING_KEYS = new Set(['thinkingBudget', 'thinkingLevel', 'includeThoughts']);
const GEMINI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const GEMINI_FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PORTABLE_FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);
const OPENAI_SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'scale', 'priority', 'fast']);
const CLAUDE_SPEEDS = new Set(['standard', 'fast']);
const OPENAI_VERBOSITY_LEVELS = new Set(['low', 'medium', 'high']);
const SUPPORTED_UPSTREAM_PROTOCOLS = new Set(['claude', 'responses', 'chat', 'gemini']);
const CROSS_PROTOCOL_REQUEST_KEYS = Object.freeze({
  claude: new Set([
    'model', 'messages', 'max_tokens', 'system', 'metadata', 'stop_sequences', 'stream',
    'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'thinking', 'output_config',
    'context_management', 'cache_control', 'speed'
  ]),
  responses: new Set([
    'model', 'input', 'instructions', 'max_output_tokens', 'stream', 'stream_options',
    'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning',
    'text', 'top_logprobs', 'metadata', 'service_tier', 'safety_identifier', 'user',
    'moderation', 'prompt_cache_options', 'prompt_cache_key', 'prompt_cache_retention',
    'background', 'store', 'previous_response_id', 'conversation', 'truncation', 'prompt',
    'max_tool_calls', 'context_management', 'include', 'client_metadata'
  ]),
  chat: new Set([
    'model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options',
    'temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls',
    'reasoning_effort', 'metadata', 'service_tier', 'safety_identifier', 'user',
    'moderation', 'verbosity', 'prompt_cache_options', 'prompt_cache_key',
    'prompt_cache_retention', 'seed', 'presence_penalty', 'frequency_penalty', 'logprobs',
    'top_logprobs', 'response_format', 'functions', 'function_call', 'store', 'n',
    'modalities', 'audio', 'prediction', 'logit_bias', 'web_search_options'
  ])
});
const CLAUDE_MESSAGE_BLOCKS = Object.freeze({
  user: new Set(['text', 'image', 'document', 'tool_result']),
  assistant: new Set(['text', 'thinking', 'redacted_thinking', 'fallback', 'compaction', 'tool_use']),
  system: new Set(['text']),
  developer: new Set(['text'])
});
const RESPONSES_MESSAGE_BLOCKS = Object.freeze({
  user: new Set(['text', 'input_text', 'input_image', 'input_file']),
  assistant: new Set(['text', 'input_text', 'output_text', 'refusal']),
  system: new Set(['text', 'input_text']),
  developer: new Set(['text', 'input_text'])
});
const CHAT_MESSAGE_BLOCKS = Object.freeze({
  user: new Set(['text', 'image_url', 'file']),
  assistant: new Set(['text', 'refusal']),
  system: new Set(['text']),
  developer: new Set(['text']),
  tool: new Set(['text'])
});
const PORTABLE_RESPONSES_INCLUDES = new Set(['reasoning.encrypted_content']);
const TRUNCATION_STOP_REASONS = new Set([
  'length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS', 'model_context_window_exceeded',
  'pause_turn', 'compaction'
]);
const FILTER_STOP_REASONS = new Set([
  'content_filter', 'refusal', 'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST',
  'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION', 'ESCALATION'
]);
const CLAUDE_STOP_REASONS = new Set([
  'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal',
  'model_context_window_exceeded', 'compaction'
]);
const CHAT_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
const GEMINI_BLOCK_REASONS = new Set(['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY']);
const GEMINI_PORTABLE_FINISH_REASONS = new Set([
  'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST',
  'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION', 'ESCALATION'
]);
const CLAUDE_TOOL_KEYS = new Set([
  'name', 'description', 'input_schema', 'cache_control', 'defer_loading', 'strict',
  'allowed_callers', 'input_examples', 'eager_input_streaming'
]);

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
  return isOpenAiOSeries(model)
    || /^gpt-[5-9]/i.test(model || '')
    || /^deepseek-v4-(?:flash|pro)$/i.test(model || '');
}

function supportsModernOpenAiPromptCache(model) {
  return /(?:^|\/)gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/i.test(model || '');
}

function validatedClaudeCacheControl(value, label) {
  return validateClaudeCacheControl(value, label, (message) => { throw unsupportedFeature(message); });
}

function hasClaudeCacheControl(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.cache_control !== undefined;
}

function claudeCacheControlSummary(body) {
  const summary = {
    automatic: body?.cache_control !== undefined, anyBlock: false,
    responsesMappable: false, responsesUnmappable: false,
    chatMappable: false, chatUnmappable: false
  };
  for (const item of asArray(body?.system)) {
    if (hasClaudeCacheControl(item)) {
      summary.anyBlock = true;
      summary.responsesMappable = true;
      summary.chatMappable = true;
    }
  }
  for (const tool of asArray(body?.tools)) {
    if (hasClaudeCacheControl(tool)) {
      summary.anyBlock = true;
      summary.responsesUnmappable = true;
      summary.chatUnmappable = true;
    }
  }
  for (const message of asArray(body?.messages)) {
    for (const part of asArray(message?.content)) {
      if (!hasClaudeCacheControl(part)) continue;
      summary.anyBlock = true;
      if (message?.role === 'user' && ['text', 'image', 'document'].includes(part.type)) summary.responsesMappable = true;
      else summary.responsesUnmappable = true;
      if (['text', 'image', 'document', 'tool_result'].includes(part.type)) summary.chatMappable = true;
      else summary.chatUnmappable = true;
    }
  }
  return summary;
}

export function claudeCacheAdaptations(body, targetProtocol, targetModel) {
  const summary = claudeCacheControlSummary(body);
  if (!summary.automatic && !summary.anyBlock) return [];
  if (targetProtocol === 'chat' && supportsModernOpenAiPromptCache(targetModel)) {
    return [
      ...(summary.automatic || summary.chatMappable ? ['claude_cache_to_chat', 'claude_cache_ttl_to_30m'] : []),
      ...(summary.chatUnmappable ? ['claude_cache_control_dropped'] : [])
    ];
  }
  if (targetProtocol === 'chat') return summary.automatic ? ['claude_cache_control_dropped'] : [];
  if (targetProtocol !== 'responses' || !supportsModernOpenAiPromptCache(targetModel)) {
    return ['claude_cache_control_dropped'];
  }
  const adaptations = [];
  if (summary.automatic || summary.responsesMappable) {
    adaptations.push('claude_cache_to_responses', 'claude_cache_ttl_to_30m');
  }
  if (summary.responsesUnmappable) adaptations.push('claude_cache_control_dropped');
  return adaptations;
}

function validatedResponsesPromptCacheOptions(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupportedFeature('Responses prompt_cache_options 必须是对象');
  const unsupported = Object.keys(value).filter((key) => !['mode', 'ttl'].includes(key));
  if (unsupported.length) throw unsupportedFeature(`Responses prompt_cache_options 包含不支持的字段：${unsupported.join(', ')}`);
  if (!['implicit', 'explicit'].includes(value.mode)) throw unsupportedFeature('Responses prompt_cache_options.mode 必须是 implicit 或 explicit');
  if (value.ttl !== undefined && value.ttl !== '30m') throw unsupportedFeature('Responses prompt_cache_options.ttl 当前只支持 30m');
  return value;
}

function validatedResponsesPromptCacheKey(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw unsupportedFeature('Responses prompt_cache_key 必须是非空字符串');
  return value;
}

function validatedResponsesPromptCacheRetention(value) {
  if (value === undefined) return undefined;
  if (!['in_memory', '24h'].includes(value)) throw unsupportedFeature('Responses prompt_cache_retention 必须是 in_memory 或 24h');
  return value;
}

function validatedResponsesPromptCacheBreakpoint(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupportedFeature(`${label} 必须是对象`);
  const unsupported = Object.keys(value).filter((key) => key !== 'mode');
  if (unsupported.length) throw unsupportedFeature(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
  if (value.mode !== 'explicit') throw unsupportedFeature(`${label}.mode 必须是 explicit`);
  return value;
}

function validateOpenAiContentPromptCache(content, label, allowedTypes = RESPONSES_PROMPT_CACHE_BLOCK_TYPES) {
  for (const [index, part] of asArray(content).entries()) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || part.prompt_cache_breakpoint === undefined) continue;
    if (!allowedTypes.has(part.type)) {
      throw unsupportedFeature(`${label}[${index}].prompt_cache_breakpoint 位于不受支持的 ${part.type || 'unknown'} 内容块`);
    }
    validatedResponsesPromptCacheBreakpoint(part.prompt_cache_breakpoint, `${label}[${index}].prompt_cache_breakpoint`);
  }
}

function hasResponsesPromptCacheBreakpoint(value) {
  return asArray(value).some((item) => item && typeof item === 'object' && !Array.isArray(item)
    && item.prompt_cache_breakpoint !== undefined);
}

function applyMessageCacheControl(parts, cacheControl, label) {
  if (!cacheControl) return parts;
  const index = parts.findLastIndex((part) => ['text', 'refusal', 'image', 'file', 'tool_call', 'tool_result'].includes(part.type));
  if (index < 0) throw unsupportedFeature(`${label} 无可承载 cache_control 的内容块`);
  if (parts[index].cacheControl
    && (parts[index].cacheControl.type !== cacheControl.type || parts[index].cacheControl.ttl !== cacheControl.ttl)) {
    throw unsupportedFeature(`${label} 与最后一个内容块的 cache_control 不能冲突`);
  }
  parts[index] = { ...parts[index], cacheControl };
  return parts;
}

function responsesRequestHasPromptCacheBreakpoint(body) {
  for (const instruction of asArray(body?.instructions)) {
    const content = instruction && typeof instruction === 'object' && !Array.isArray(instruction) && Object.hasOwn(instruction, 'content')
      ? instruction.content
      : instruction;
    if (hasResponsesPromptCacheBreakpoint(content)) return true;
  }
  return asArray(body?.input).some((item) => hasResponsesPromptCacheBreakpoint(item?.content));
}

function chatPromptCacheSummary(body) {
  const summary = {
    hasBreakpoint: false, mappableToResponses: false, unmappableToResponses: false,
    hasToolCacheControl: asArray(body?.tools).some((tool) => tool?.cache_control !== undefined),
    hasToolCallCacheControl: asArray(body?.messages).some((message) =>
      asArray(message?.tool_calls).some((call) => call?.cache_control !== undefined)),
    hasMessageCacheControl: false,
    messageCacheMappableToResponses: false,
    messageCacheUnmappableToResponses: false
  };
  for (const message of asArray(body?.messages)) {
    if (message?.cache_control !== undefined) {
      summary.hasMessageCacheControl = true;
      const parts = typeof message.content === 'string' ? [{ type: 'text' }] : asArray(message.content);
      if (['system', 'developer', 'user'].includes(message?.role)
        && parts.some((part) => ['text', 'image_url', 'file'].includes(part?.type))) {
        summary.messageCacheMappableToResponses = true;
      } else {
        summary.messageCacheUnmappableToResponses = true;
      }
    }
    for (const part of asArray(message?.content)) {
      if (!part || typeof part !== 'object' || Array.isArray(part) || part.prompt_cache_breakpoint === undefined) continue;
      summary.hasBreakpoint = true;
      if (['system', 'developer', 'user'].includes(message?.role) && ['text', 'image_url', 'file', 'refusal'].includes(part.type)) {
        summary.mappableToResponses = true;
      } else {
        summary.unmappableToResponses = true;
      }
    }
  }
  return summary;
}

export function responsesCacheAdaptations(body, targetProtocol, targetModel) {
  const hasOptions = body?.prompt_cache_options !== undefined;
  const hasBreakpoint = responsesRequestHasPromptCacheBreakpoint(body);
  const hasKey = body?.prompt_cache_key !== undefined;
  const hasRetention = body?.prompt_cache_retention !== undefined;
  if (!hasOptions && !hasBreakpoint && !hasKey && !hasRetention) return [];
  if (targetProtocol === 'chat' && supportsModernOpenAiPromptCache(targetModel)) {
    return [
      ...(hasOptions || hasBreakpoint || hasKey ? ['responses_cache_to_chat'] : []),
      ...(hasRetention ? ['responses_cache_retention_dropped'] : [])
    ];
  }
  if (targetProtocol !== 'claude') return ['responses_cache_control_dropped'];
  const adaptations = [];
  if (hasOptions || hasBreakpoint) adaptations.push('responses_cache_to_claude', 'responses_cache_ttl_to_5m');
  if (hasKey) adaptations.push('responses_cache_key_dropped');
  if (hasRetention) adaptations.push('responses_cache_retention_dropped');
  return adaptations;
}

export function chatCacheAdaptations(body, targetProtocol, targetModel) {
  const summary = chatPromptCacheSummary(body);
  const hasOptions = body?.prompt_cache_options !== undefined;
  const hasBreakpoint = summary.hasBreakpoint;
  const hasKey = body?.prompt_cache_key !== undefined;
  const hasRetention = body?.prompt_cache_retention !== undefined;
  const hasToolCacheControl = summary.hasToolCacheControl;
  const hasToolCallCacheControl = summary.hasToolCallCacheControl;
  const hasMessageCacheControl = summary.hasMessageCacheControl;
  if (!hasOptions && !hasBreakpoint && !hasKey && !hasRetention && !hasToolCacheControl && !hasToolCallCacheControl && !hasMessageCacheControl) return [];
  if (targetProtocol === 'responses' && supportsModernOpenAiPromptCache(targetModel)) {
    return [
      ...(hasOptions || summary.mappableToResponses || summary.messageCacheMappableToResponses || hasKey ? ['chat_cache_to_responses'] : []),
      ...(summary.messageCacheMappableToResponses ? ['claude_cache_ttl_to_30m'] : []),
      ...(hasRetention ? ['responses_cache_retention_dropped'] : []),
      ...(summary.unmappableToResponses || summary.messageCacheUnmappableToResponses || hasToolCacheControl || hasToolCallCacheControl ? ['responses_cache_control_dropped'] : [])
    ];
  }
  if (targetProtocol === 'claude') {
    return [
      ...(hasOptions || hasBreakpoint || hasToolCacheControl || hasToolCallCacheControl || hasMessageCacheControl ? ['chat_cache_to_claude'] : []),
      ...(hasOptions || hasBreakpoint ? ['responses_cache_ttl_to_5m'] : []),
      ...(hasKey ? ['responses_cache_key_dropped'] : []),
      ...(hasRetention ? ['responses_cache_retention_dropped'] : [])
    ];
  }
  return ['responses_cache_control_dropped'];
}

function needsNonThinkingToolMode(model) {
  return /^deepseek-v4-flash(?:-free)?$/i.test(model || '');
}

function resolveReasoningEffort(body, protocol) {
  if (protocol === 'chat') return body.reasoning_effort;
  const effort = body.output_config?.effort;
  if (REASONING_EFFORTS.has(effort)) return effort;
  if (body.thinking?.type === 'disabled') return 'none';
  if (body.thinking?.type === 'adaptive') return 'high';
  if (body.thinking?.type !== 'enabled') return undefined;
  const budget = body.thinking.budget_tokens;
  if (budget == null) return 'high';
  if (budget < 4000) return 'low';
  if (budget < 16000) return 'medium';
  return 'high';
}

function normalizeResponsesReasoning(value) {
  if (value === undefined || value === null) return undefined;
  const config = objectValue(value, 'Responses reasoning');
  const unsupported = Object.keys(config).filter((key) => !['effort', 'summary', 'generate_summary', 'mode', 'context'].includes(key));
  if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Responses reasoning 字段：${unsupported.join(', ')}`);
  if (config.effort !== undefined && !REASONING_EFFORTS.has(config.effort)) {
    throw unsupportedFeature(`Responses reasoning.effort 必须是 ${[...REASONING_EFFORTS].join('、')} 之一`);
  }
  if (config.summary !== undefined && config.generate_summary !== undefined) {
    throw unsupportedFeature('Responses reasoning 不能同时设置 summary 和已弃用的 generate_summary');
  }
  const summary = config.summary ?? config.generate_summary;
  if (summary !== undefined && !REASONING_SUMMARIES.has(summary)) {
    throw unsupportedFeature(`Responses reasoning.summary 必须是 ${[...REASONING_SUMMARIES].join('、')} 之一`);
  }
  if (config.mode !== undefined && !['standard', 'pro'].includes(config.mode)) {
    throw unsupportedFeature('Responses reasoning.mode 必须是 standard 或 pro');
  }
  if (config.context !== undefined && !['auto', 'current_turn', 'all_turns'].includes(config.context)) {
    throw unsupportedFeature('Responses reasoning.context 必须是 auto、current_turn 或 all_turns');
  }
  return {
    source: 'responses',
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.context !== undefined ? { context: config.context } : {})
  };
}

function normalizeClaudeReasoning(body) {
  let outputConfig = {};
  if (body.output_config !== undefined && body.output_config !== null) {
    outputConfig = objectValue(body.output_config, 'Claude output_config');
    const unsupportedOutput = Object.keys(outputConfig).filter((key) => !['effort', 'format'].includes(key));
    if (unsupportedOutput.length) throw unsupportedFeature(`跨协议转换暂不支持 Claude output_config 字段：${unsupportedOutput.join(', ')}`);
  }
  if (outputConfig.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(outputConfig.effort)) {
    throw unsupportedFeature('Claude output_config.effort 必须是 low、medium、high、xhigh 或 max');
  }
  if (body.thinking === undefined || body.thinking === null) {
    return outputConfig.effort === undefined ? undefined : { source: 'claude', effort: outputConfig.effort };
  }

  const thinking = objectValue(body.thinking, 'Claude thinking');
  const unsupportedThinking = Object.keys(thinking).filter((key) => !['type', 'budget_tokens', 'display'].includes(key));
  if (unsupportedThinking.length) throw unsupportedFeature(`跨协议转换暂不支持 Claude thinking 字段：${unsupportedThinking.join(', ')}`);
  if (!['adaptive', 'enabled', 'disabled'].includes(thinking.type)) {
    throw unsupportedFeature('Claude thinking.type 必须是 adaptive、enabled 或 disabled');
  }
  if (thinking.display !== undefined && !['summarized', 'omitted'].includes(thinking.display)) {
    throw unsupportedFeature('Claude thinking.display 必须是 summarized 或 omitted');
  }
  let budget;
  if (thinking.type === 'enabled') {
    budget = integer(thinking.budget_tokens, 'Claude thinking.budget_tokens', { minimum: 1024 });
    if (budget === undefined) throw unsupportedFeature('Claude thinking.type=enabled 必须提供 budget_tokens');
  } else if (thinking.budget_tokens !== undefined) {
    throw unsupportedFeature(`Claude thinking.type=${thinking.type} 不能设置 budget_tokens`);
  }
  if (thinking.type === 'disabled' && thinking.display !== undefined) {
    throw unsupportedFeature('Claude thinking.type=disabled 不能设置 display');
  }
  const effort = thinking.type === 'disabled' ? 'none' : outputConfig.effort ?? (thinking.type === 'adaptive' ? 'high'
    : budget < 4000 ? 'low' : budget < 16000 ? 'medium' : 'high');
  return {
    source: 'claude', mode: thinking.type, effort,
    ...(outputConfig.effort !== undefined ? { outputEffort: outputConfig.effort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(thinking.display !== undefined ? { display: thinking.display } : {}),
    ...(thinking.display === 'summarized' ? { summary: 'auto' } : {})
  };
}

function normalizeClaudeContextManagement(value) {
  if (value === undefined || value === null) return undefined;
  const config = objectValue(value, 'Claude context_management');
  const unsupported = Object.keys(config).filter((key) => key !== 'edits');
  if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Claude context_management 字段：${unsupported.join(', ')}`);
  if (!Array.isArray(config.edits) || config.edits.length === 0) {
    throw unsupportedFeature('Claude context_management.edits 必须是非空数组');
  }
  const edits = config.edits.map((value, index) => {
    const edit = objectValue(value, `Claude context_management.edits[${index}]`);
    const editUnsupported = Object.keys(edit).filter((key) => !['type', 'keep'].includes(key));
    if (editUnsupported.length) {
      throw unsupportedFeature(`跨协议转换暂不支持 Claude context_management.edits[${index}] 字段：${editUnsupported.join(', ')}`);
    }
    if (edit.type !== 'clear_thinking_20251015') {
      throw unsupportedFeature(`跨协议转换无法执行 Claude context_management 策略：${edit.type || 'unknown'}；请将模型路由设为 claude`);
    }
    const keepsAll = edit.keep === 'all'
      || (edit.keep && !Array.isArray(edit.keep) && typeof edit.keep === 'object' && edit.keep.type === 'all' && Object.keys(edit.keep).length === 1);
    if (!keepsAll) {
      throw unsupportedFeature('跨协议转换目前仅能精确执行 Claude clear_thinking_20251015 的 keep="all"；请将模型路由设为 claude');
    }
    return { type: edit.type, keep: 'all' };
  });
  if (edits.length > 1) throw unsupportedFeature('Claude context_management 不能重复声明 clear_thinking_20251015');
  return { source: 'claude', edits };
}

function normalizeGeminiThinkingConfig(value) {
  if (value === undefined) return undefined;
  const config = objectValue(value, 'Gemini thinkingConfig');
  const unsupported = Object.keys(config).filter((key) => !GEMINI_THINKING_KEYS.has(key));
  if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini thinkingConfig 字段：${unsupported.join(', ')}`);
  if (config.thinkingBudget !== undefined && config.thinkingLevel !== undefined) {
    throw unsupportedFeature('Gemini thinkingConfig 不能同时设置 thinkingBudget 和 thinkingLevel');
  }
  if (config.includeThoughts !== undefined && typeof config.includeThoughts !== 'boolean') {
    throw unsupportedFeature('Gemini includeThoughts 必须是布尔值');
  }

  const budget = integer(config.thinkingBudget, 'Gemini thinkingBudget', { minimum: -1, maximum: 32768 });
  const level = config.thinkingLevel;
  if (level !== undefined && (typeof level !== 'string' || !GEMINI_THINKING_LEVELS.has(level))) {
    throw unsupportedFeature(`Gemini thinkingLevel 必须是 ${[...GEMINI_THINKING_LEVELS].join('、')} 之一`);
  }
  if (budget === undefined && level === undefined && config.includeThoughts === undefined) return undefined;

  const effort = level === 'minimal' ? 'low'
    : level !== undefined ? level
      : budget === 0 ? 'none'
        : budget === -1 ? 'high'
          : budget !== undefined ? (budget < 4000 ? 'low' : budget < 16000 ? 'medium' : 'high')
            : config.includeThoughts === true ? 'high' : undefined;
  return {
    source: 'gemini',
    mode: level !== undefined ? 'level' : budget !== undefined ? 'budget' : 'default',
    ...(level !== undefined ? { level } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(config.includeThoughts !== undefined ? { includeThoughts: config.includeThoughts } : {}),
    ...(effort ? { effort } : {})
  };
}

function claudeAdaptiveOnly(model) {
  return /(?:claude-(?:fable|mythos)-5|claude-(?:opus-(?:4[-.]?[78]|5)|sonnet-5))(?:-|$)/i.test(model || '');
}

function claudeThinkingCannotDisable(model) {
  return /claude-(?:(?:fable|mythos)-5|mythos-preview)(?:-|$)/i.test(model || '');
}

function claudeReasoningOptions(request) {
  const control = request.reasoningControl;
  if (control?.source === 'gemini') {
    let thinking;
    let effort;
    if (control.mode === 'level') {
      thinking = { type: 'adaptive' };
      effort = control.effort;
    } else if (control.mode === 'budget') {
      if (control.budget === 0) {
        if (claudeThinkingCannotDisable(request.model)) {
          throw unsupportedFeature(`Claude Messages 目标模型 ${request.model} 不允许关闭 thinking`);
        }
        thinking = { type: 'disabled' };
      } else if (control.budget === -1) {
        thinking = { type: 'adaptive' };
      } else if (claudeAdaptiveOnly(request.model)) {
        thinking = { type: 'adaptive' };
        effort = control.effort;
      } else {
        thinking = { type: 'enabled', budget_tokens: control.budget };
      }
    } else if (control.includeThoughts === true) {
      thinking = { type: 'adaptive' };
      effort = 'high';
    }
    if (thinking && thinking.type !== 'disabled' && control.includeThoughts !== undefined) {
      thinking.display = control.includeThoughts ? 'summarized' : 'omitted';
    }
    return { thinking, effort };
  }

  if (!request.reasoningEffort && !request.reasoningSummary) return {};
  if (request.reasoningEffort === 'none') {
    if (claudeThinkingCannotDisable(request.model)) {
      throw unsupportedFeature(`Claude Messages 目标模型 ${request.model} 不允许关闭 thinking`);
    }
    return { thinking: { type: 'disabled' } };
  }
  return {
    thinking: {
      type: 'adaptive',
      ...(request.reasoningSummary ? { display: 'summarized' } : {})
    },
    effort: request.reasoningEffort === 'minimal' ? 'low' : (request.reasoningEffort || 'high')
  };
}

function responsesReasoning(request) {
  const control = request.reasoningControl;
  const summary = request.reasoningSummary
    ?? (control?.includeThoughts === true && request.reasoningEffort !== 'none' ? 'auto' : undefined);
  if (!request.reasoningEffort && !summary) return undefined;
  return {
    ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
    ...(summary ? { summary } : {})
  };
}

function assertPortableResponsesReasoning(request, targetProtocol) {
  const control = request.reasoningControl;
  if (control?.source !== 'responses') return;
  if (control.mode === 'pro') {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 无法表达 Responses reasoning.mode=pro；请将模型路由设为 responses`);
  }
  if (control.context && control.context !== 'auto') {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 无法表达 Responses reasoning.context=${control.context}；请将模型路由设为 responses`);
  }
}

export function reasoningRequestAdaptations(body, incomingProtocol, targetProtocol, upstreamModel) {
  if (incomingProtocol === targetProtocol) return [];
  const control = incomingProtocol === 'gemini' ? normalizeGeminiThinkingConfig(body.generationConfig?.thinkingConfig)
    : incomingProtocol === 'responses' ? normalizeResponsesReasoning(body.reasoning)
      : incomingProtocol === 'claude' ? normalizeClaudeReasoning(body)
        : undefined;
  const adaptations = [];
  if (control && incomingProtocol === 'gemini') {
    if (control.level === 'minimal') adaptations.push('thinking_level_minimal_to_low');
    if (control.mode === 'budget' && control.budget !== 0 && targetProtocol === 'responses') {
      adaptations.push('thinking_budget_to_effort');
    }
    if (control.mode === 'budget' && control.budget > 0 && targetProtocol === 'claude' && claudeAdaptiveOnly(upstreamModel)) {
      adaptations.push('thinking_budget_to_adaptive');
    }
    if (control.includeThoughts === true && targetProtocol === 'chat') {
      adaptations.push('reasoning_summary_best_effort_chat');
    }
    if (control.effort && targetProtocol === 'chat' && !supportsReasoningEffort(upstreamModel)
      && !(control.effort === 'none' && needsNonThinkingToolMode(upstreamModel))) {
      adaptations.push('reasoning_effort_unavailable_chat');
    }
  }
  if (control && incomingProtocol === 'responses') {
    if (control.summary && targetProtocol === 'claude') adaptations.push('reasoning_summary_to_claude_display');
    if (control.summary && targetProtocol === 'chat') adaptations.push('reasoning_summary_best_effort_chat');
    if (control.summary && targetProtocol === 'gemini') adaptations.push('reasoning_summary_to_gemini_thoughts');
    if (control.effort === 'minimal' && targetProtocol === 'claude') adaptations.push('reasoning_effort_minimal_to_low');
    if (['xhigh', 'max'].includes(control.effort) && targetProtocol === 'gemini') adaptations.push('reasoning_effort_to_gemini_high');
    if (control.effort && targetProtocol === 'chat' && !supportsReasoningEffort(upstreamModel)
      && !(control.effort === 'none' && needsNonThinkingToolMode(upstreamModel))) {
      adaptations.push('reasoning_effort_unavailable_chat');
    }
  }
  if (control && incomingProtocol === 'claude') {
    if (control.summary && targetProtocol === 'responses') adaptations.push('thinking_display_to_reasoning_summary');
    if (control.summary && targetProtocol === 'chat') adaptations.push('reasoning_summary_best_effort_chat');
    if (control.summary && targetProtocol === 'gemini') adaptations.push('reasoning_summary_to_gemini_thoughts');
    if (control.mode === 'enabled' && targetProtocol === 'responses') adaptations.push('thinking_budget_to_effort');
    if (body.output_config?.effort && control.mode === 'disabled') adaptations.push('claude_effort_unavailable_with_disabled_thinking');
    else if (body.output_config?.effort && targetProtocol === 'responses') adaptations.push('claude_effort_to_reasoning_effort');
    if (['xhigh', 'max'].includes(control.effort) && targetProtocol === 'gemini') adaptations.push('reasoning_effort_to_gemini_high');
    if (control.effort && targetProtocol === 'chat' && !supportsReasoningEffort(upstreamModel)
      && !(control.effort === 'none' && needsNonThinkingToolMode(upstreamModel))) {
      adaptations.push('reasoning_effort_unavailable_chat');
    }
  }
  if (hasReasoningHistory(body, incomingProtocol, targetProtocol)) {
    adaptations.push(targetProtocol === 'chat' && usesReasoningContent(upstreamModel)
      ? 'reasoning_history_to_chat_reasoning_content'
      : targetProtocol === 'gemini' ? 'reasoning_history_to_gemini_thought'
      : 'reasoning_history_to_assistant_text');
  }
  return adaptations;
}

export function openAiServiceTierForClaudeSpeed(speed) {
  if (speed === 'standard') return 'default';
  if (speed === 'fast') return 'fast';
  return undefined;
}

export function claudeSpeedForOpenAiServiceTier(serviceTier) {
  if (serviceTier === 'default') return 'standard';
  if (serviceTier === 'fast') return 'fast';
  return undefined;
}

export function serviceRequestAdaptations(body, incomingProtocol, targetProtocol) {
  if (incomingProtocol === targetProtocol) return [];
  if (incomingProtocol === 'claude' && body?.speed != null) {
    const speed = optionalOpenAiEnum(body.speed, 'Claude speed', CLAUDE_SPEEDS);
    return [`claude_${speed}_speed_to_openai_${openAiServiceTierForClaudeSpeed(speed)}_tier`];
  }
  if (targetProtocol === 'claude' && ['responses', 'chat'].includes(incomingProtocol) && body?.service_tier != null) {
    const serviceTier = optionalOpenAiEnum(body.service_tier, `${incomingProtocol === 'responses' ? 'Responses' : 'Chat'} service_tier`, OPENAI_SERVICE_TIERS);
    const speed = claudeSpeedForOpenAiServiceTier(serviceTier);
    return speed ? [`openai_${serviceTier}_tier_to_claude_${speed}_speed`] : [];
  }
  return [];
}

export function generationRequestAdaptations(body, incomingProtocol, targetProtocol) {
  if (incomingProtocol === targetProtocol) return [];
  const generation = incomingProtocol === 'gemini' && body?.generationConfig && typeof body.generationConfig === 'object'
    ? body.generationConfig
    : {};
  return [
    ...(['responses', 'chat'].includes(targetProtocol) && generation.topK != null ? ['gemini_top_k_dropped'] : [])
  ];
}

function hasReasoningHistory(body, protocol, targetProtocol) {
  if (protocol === 'gemini') {
    return asArray(body?.contents).some((content) => asArray(content?.parts)
      .some((part) => part?.thought === true && typeof part.text === 'string' && part.text
        && decodeReasoningState(geminiThoughtSignature(part))?.protocol !== targetProtocol));
  }
  if (protocol === 'claude') {
    return asArray(body?.messages).some((message) => asArray(message?.content)
      .some((part) => part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking
        && decodeReasoningState(part.signature)?.protocol !== targetProtocol));
  }
  if (protocol === 'responses') {
    return asArray(body?.input).some((item) => item?.type === 'reasoning'
      && decodeReasoningState(item.encrypted_content)?.protocol !== targetProtocol
      && [...asArray(item.summary), ...asArray(item.content)].some((part) =>
        ['summary_text', 'reasoning_text'].includes(part?.type) && typeof part.text === 'string' && part.text));
  }
  if (protocol === 'chat') {
    return asArray(body?.messages).some((message) => {
      const directReasoning = message?.reasoning_content ?? message?.reasoning;
      const detailReasoning = asArray(message?.reasoning_details).some((detail) =>
        (detail?.type === 'reasoning.text' && typeof detail.text === 'string' && detail.text)
        || (detail?.type === 'reasoning.summary' && typeof detail.summary === 'string' && detail.summary));
      return ((typeof directReasoning === 'string' && directReasoning) || detailReasoning)
        && !asArray(message?.reasoning_details).some((detail) =>
          (decodeReasoningState(detail?.data) || decodeReasoningState(detail?.signature))?.protocol === targetProtocol);
    });
  }
  return false;
}

export function contextRequestAdaptations(body, incomingProtocol, targetProtocol) {
  if (incomingProtocol === targetProtocol || incomingProtocol !== 'claude' || body.context_management == null) return [];
  normalizeClaudeContextManagement(body.context_management);
  return ['claude_keep_all_thinking_local'];
}

export function claudeToolAdaptations(tools, messages, stream = false, targetProtocol) {
  const deferred = [];
  let hasInputExamples = false;
  let hasMixedDirectCallers = false;
  let hasEagerInputStreaming = false;
  for (const tool of asArray(tools)) {
    if (tool?.defer_loading === true) deferred.push(tool);
    if (Array.isArray(tool?.input_examples) && tool.input_examples.length) hasInputExamples = true;
    if (Array.isArray(tool?.allowed_callers) && tool.allowed_callers.includes('direct')
      && tool.allowed_callers.some((caller) => caller !== 'direct')) hasMixedDirectCallers = true;
    if (stream && tool?.eager_input_streaming === true) hasEagerInputStreaming = true;
  }
  const references = new Set();
  let hasToolError = false;
  for (const message of asArray(messages)) {
    for (const part of asArray(message?.content)) {
      if (part?.type !== 'tool_result') continue;
      if (deferred.length) addClaudeToolReferenceNames(references, part.content);
      if (targetProtocol !== 'gemini' && part.is_error === true) hasToolError = true;
    }
  }
  let hasLoadedDeferred = false;
  let hasHiddenDeferred = false;
  for (const tool of deferred) {
    if (references.has(tool.name)) hasLoadedDeferred = true;
    else hasHiddenDeferred = true;
  }
  return [
    ...(hasLoadedDeferred ? ['deferred_tools_loaded'] : []),
    ...(hasHiddenDeferred ? ['deferred_tools_hidden'] : []),
    ...(hasInputExamples ? ['input_examples_to_description'] : []),
    ...(hasMixedDirectCallers ? ['allowed_callers_direct_only'] : []),
    ...(hasEagerInputStreaming ? ['eager_input_streaming_best_effort'] : []),
    ...(hasToolError ? ['claude_tool_error_to_content'] : [])
  ];
}

export function geminiToolAdaptations(body, targetProtocol) {
  const rawConfig = body?.toolConfig?.functionCallingConfig;
  const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  const allowedNames = new Set();
  let hasAliasedFunctionName = false;
  for (const name of asArray(config.allowedFunctionNames)) {
    if (typeof name !== 'string' || !name) continue;
    if (!PORTABLE_FUNCTION_NAME_PATTERN.test(name)) hasAliasedFunctionName = true;
    if (Array.isArray(config.allowedFunctionNames)) allowedNames.add(name);
  }
  const hasAllowedFunctions = allowedNames.size > 0;
  const mode = String(config.mode || 'AUTO').toUpperCase();
  let hasGoogleSearch = false;
  let hasActiveResponseSchema = false;
  for (const group of asArray(body?.tools)) {
    if (group && !Array.isArray(group) && typeof group === 'object' && Object.hasOwn(group, 'googleSearch')) {
      hasGoogleSearch = true;
    }
    for (const declaration of asArray(group?.functionDeclarations)) {
      const name = declaration?.name;
      if (typeof name === 'string' && name && !PORTABLE_FUNCTION_NAME_PATTERN.test(name)) {
        hasAliasedFunctionName = true;
      }
      if ((!hasAllowedFunctions || allowedNames.has(name))
        && (declaration?.response !== undefined || declaration?.responseJsonSchema !== undefined)) {
        hasActiveResponseSchema = true;
      }
    }
  }
  for (const content of asArray(body?.contents)) {
    for (const part of asArray(content?.parts)) {
      const callName = (part?.functionCall || part?.function_call)?.name;
      const responseName = (part?.functionResponse || part?.function_response)?.name;
      if ((typeof callName === 'string' && callName && !PORTABLE_FUNCTION_NAME_PATTERN.test(callName))
        || (typeof responseName === 'string' && responseName && !PORTABLE_FUNCTION_NAME_PATTERN.test(responseName))) {
        hasAliasedFunctionName = true;
      }
    }
  }
  return [
    ...(hasAliasedFunctionName ? ['gemini_function_names_aliased'] : []),
    ...(hasGoogleSearch && (!targetProtocol || targetProtocol === 'responses') ? ['gemini_google_search_to_web_search'] : []),
    ...(hasAllowedFunctions ? ['gemini_allowed_functions_filtered'] : []),
    ...(mode === 'VALIDATED' ? ['gemini_validated_best_effort'] : []),
    ...(hasActiveResponseSchema ? ['gemini_response_schema_to_description'] : []),
    ...(config.streamFunctionCallArguments === true ? ['gemini_stream_function_args_reencoded'] : [])
  ];
}

export function geminiToolNameAliases(body) {
  const names = [];
  const seen = new Set();
  const usedNames = new Set();
  const append = (name) => {
    if (typeof name !== 'string' || !name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
    if (PORTABLE_FUNCTION_NAME_PATTERN.test(name)) usedNames.add(name);
  };
  for (const group of asArray(body?.tools)) {
    for (const declaration of asArray(group?.functionDeclarations)) append(declaration?.name);
  }
  for (const content of asArray(body?.contents)) {
    for (const part of asArray(content?.parts)) {
      append((part?.functionCall || part?.function_call)?.name);
      append((part?.functionResponse || part?.function_response)?.name);
    }
  }
  for (const name of asArray(body?.toolConfig?.functionCallingConfig?.allowedFunctionNames)) append(name);
  const aliases = [];
  for (const [index, name] of names.entries()) {
    if (!PORTABLE_FUNCTION_NAME_PATTERN.test(name)) {
      aliases.push({ name, alias: allocateAdaptedToolAlias(name, 'gemini', usedNames, index) });
    }
  }
  return aliases;
}

export function hasGeminiGoogleSearch(body) {
  return asArray(body?.tools).some((group) => group && !Array.isArray(group) && typeof group === 'object'
    && Object.hasOwn(group, 'googleSearch'));
}

function normalizeGeminiGoogleSearch(tools) {
  let googleSearch;
  for (const [index, group] of asArray(tools).entries()) {
    if (!group || Array.isArray(group) || typeof group !== 'object' || !Object.hasOwn(group, 'googleSearch')) continue;
    if (googleSearch !== undefined) throw unsupportedFeature('Gemini googleSearch 只能声明一次');
    googleSearch = objectValue(group.googleSearch, `Gemini tools[${index}].googleSearch`);
  }
  if (googleSearch === undefined) return undefined;
  const unsupported = Object.keys(googleSearch).filter((key) => !['searchTypes', 'timeRangeFilter'].includes(key));
  if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini googleSearch 字段：${unsupported.join(', ')}`);
  if (googleSearch.timeRangeFilter !== undefined) {
    throw unsupportedFeature('Gemini googleSearch.timeRangeFilter 在 Responses web_search 中没有等价字段；请移除时间范围或使用原生 Gemini 上游');
  }
  if (googleSearch.searchTypes !== undefined) {
    const searchTypes = objectValue(googleSearch.searchTypes, 'Gemini googleSearch.searchTypes');
    const unsupportedTypes = Object.keys(searchTypes).filter((key) => !['webSearch', 'imageSearch'].includes(key));
    if (unsupportedTypes.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini googleSearch.searchTypes 字段：${unsupportedTypes.join(', ')}`);
    if (searchTypes.imageSearch !== undefined) {
      throw unsupportedFeature('Responses 图片搜索只返回 URL 与结果元数据，无法等价生成 Gemini imageSearch 要求的图片内容；请仅启用 webSearch 或使用原生 Gemini 上游');
    }
    if (searchTypes.webSearch === undefined) {
      throw unsupportedFeature('Gemini googleSearch.searchTypes 必须启用 webSearch 才能转换到 Responses');
    }
    const webSearch = objectValue(searchTypes.webSearch, 'Gemini googleSearch.searchTypes.webSearch');
    if (Object.keys(webSearch).length) throw unsupportedFeature('Gemini googleSearch.searchTypes.webSearch 必须是空对象');
  }
  return { type: 'web_search' };
}

export function createGeminiToolNameRestorer(aliases = []) {
  const originalByAlias = new Map();
  for (const entry of asArray(aliases)) {
    const alias = entry?.alias;
    if (!originalByAlias.has(alias)) originalByAlias.set(alias, entry?.name);
  }
  return (name) => originalByAlias.get(name) || name;
}

export function restoreGeminiToolName(name, aliases = []) {
  return createGeminiToolNameRestorer(aliases)(name);
}

function applyGeminiToolNameAliases(request, aliases) {
  if (!aliases.length) return request;
  const aliasByName = new Map(aliases.map((entry) => [entry.name, entry.alias]));
  const mappedName = (name) => aliasByName.get(name) || name;
  request.tools = request.tools.map((tool) => ({ ...tool, name: mappedName(tool.name) }));
  request.messages = request.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => part.type === 'tool_call' ? { ...part, name: mappedName(part.name) } : part)
  }));
  if (request.toolChoice?.type === 'tool') request.toolChoice = { ...request.toolChoice, name: mappedName(request.toolChoice.name) };
  return request;
}

function canonicalJsonString(value) {
  assertJsonComplexity(value);
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

export function normalizeOutputAnnotations(value, label = 'Responses output_text.annotations') {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw unsupportedFeature(`${label} 必须是数组`);
  return value.map((annotation, index) => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw unsupportedFeature(`${label}[${index}] 必须是对象`);
    const itemLabel = `${label}[${index}]`;
    if (annotation.type === 'url_citation') {
      if (typeof annotation.url !== 'string' || !annotation.url || typeof annotation.title !== 'string') throw unsupportedFeature(`${itemLabel} 缺少有效 url/title`);
      if (![annotation.start_index, annotation.end_index].every((number) => Number.isSafeInteger(number) && number >= 0) || annotation.end_index < annotation.start_index) throw unsupportedFeature(`${itemLabel} 包含无效文本索引`);
    } else if (annotation.type === 'file_citation') {
      if (typeof annotation.file_id !== 'string' || !annotation.file_id || typeof annotation.filename !== 'string' || !Number.isSafeInteger(annotation.index) || annotation.index < 0) throw unsupportedFeature(`${itemLabel} 包含无效文件引用`);
    } else if (annotation.type === 'container_file_citation') {
      if (typeof annotation.container_id !== 'string' || !annotation.container_id || typeof annotation.file_id !== 'string' || !annotation.file_id
        || typeof annotation.filename !== 'string' || ![annotation.start_index, annotation.end_index].every((number) => Number.isSafeInteger(number) && number >= 0) || annotation.end_index < annotation.start_index) {
        throw unsupportedFeature(`${itemLabel} 包含无效容器文件引用`);
      }
    } else if (annotation.type === 'file_path') {
      if (typeof annotation.file_id !== 'string' || !annotation.file_id || !Number.isSafeInteger(annotation.index) || annotation.index < 0) throw unsupportedFeature(`${itemLabel} 包含无效文件路径引用`);
    } else {
      throw unsupportedFeature(`${itemLabel} 包含不支持的类型：${annotation.type || 'unknown'}`);
    }
    return { ...annotation };
  });
}

function annotationLabel(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
}

export function portableAnnotationText(annotations, { excludeUrlCitations = false } = {}) {
  const lines = [];
  const seen = new Set();
  for (const annotation of asArray(annotations)) {
    let line = '';
    if (annotation?.type === 'url_citation' && !excludeUrlCitations) line = `${annotationLabel(annotation.title) || 'Source'} — ${annotationLabel(annotation.url)}`;
    else if (annotation?.type === 'file_citation') line = `${annotationLabel(annotation.filename) || 'File'} (file_id: ${annotationLabel(annotation.file_id)})`;
    else if (annotation?.type === 'container_file_citation') line = `${annotationLabel(annotation.filename) || 'Container file'} (file_id: ${annotationLabel(annotation.file_id)}, container_id: ${annotationLabel(annotation.container_id)})`;
    else if (annotation?.type === 'file_path') line = `Generated file (file_id: ${annotationLabel(annotation.file_id)})`;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(`- ${line}`);
  }
  return lines.length ? `\n\nSources:\n${lines.join('\n')}` : '';
}

export function geminiGroundingMetadata(parts, { flatten = false, webSearchQueries = [] } = {}) {
  const groundingChunks = [];
  const chunkIndexes = new Map();
  const supportEntries = new Map();
  const supportChunkIndexes = new Map();
  let flattenedOffset = 0;
  for (const [partIndex, part] of asArray(parts).entries()) {
    if (part?.type !== 'text') continue;
    const characters = Array.from(part.text || '');
    for (const annotation of asArray(part.annotations)) {
      if (annotation?.type !== 'url_citation') continue;
      if (annotation.start_index > characters.length || annotation.end_index > characters.length) {
        throw unsupportedFeature(`Responses url_citation 文本索引超出 output_text 长度：${annotation.start_index}–${annotation.end_index}/${characters.length}`);
      }
      const chunkKey = `${annotation.url}\n${annotation.title}`;
      let chunkIndex = chunkIndexes.get(chunkKey);
      if (chunkIndex === undefined) {
        chunkIndex = groundingChunks.length;
        chunkIndexes.set(chunkKey, chunkIndex);
        groundingChunks.push({ web: { uri: annotation.url, title: annotation.title } });
      }
      const startIndex = annotation.start_index + (flatten ? flattenedOffset : 0);
      const endIndex = annotation.end_index + (flatten ? flattenedOffset : 0);
      const supportKey = `${flatten ? '' : partIndex}\n${startIndex}\n${endIndex}`;
      let existing = supportEntries.get(supportKey);
      if (!existing) {
        existing = {
          segment: {
            ...(!flatten ? { partIndex } : {}),
            startIndex,
            endIndex,
            text: characters.slice(annotation.start_index, annotation.end_index).join('')
          },
          groundingChunkIndices: []
        };
        supportEntries.set(supportKey, existing);
        supportChunkIndexes.set(supportKey, new Set());
      }
      const seenChunkIndexes = supportChunkIndexes.get(supportKey);
      if (!seenChunkIndexes.has(chunkIndex)) {
        seenChunkIndexes.add(chunkIndex);
        existing.groundingChunkIndices.push(chunkIndex);
      }
    }
    if (flatten) flattenedOffset += characters.length;
  }
  const queries = [...new Set(asArray(webSearchQueries).filter((query) => typeof query === 'string' && query))];
  if (!groundingChunks.length && !queries.length) return undefined;
  return {
    ...(queries.length ? { webSearchQueries: queries } : {}),
    ...(groundingChunks.length ? { groundingChunks, groundingSupports: [...supportEntries.values()] } : {})
  };
}

export function normalizeGeminiGroundingMetadata(candidate, { textLength } = {}) {
  const metadata = candidate?.groundingMetadata;
  if (metadata == null) return { annotations: [], webSearchQueries: [] };
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') throw new Error('Gemini groundingMetadata 必须是对象');
  const chunks = metadata.groundingChunks ?? [];
  const supports = metadata.groundingSupports ?? [];
  if (!Array.isArray(chunks) || !Array.isArray(supports)) throw new Error('Gemini groundingMetadata 的 groundingChunks/groundingSupports 必须是数组');
  const annotations = [];
  const seen = new Set();
  for (const [supportIndex, support] of supports.entries()) {
    if (!support || Array.isArray(support) || typeof support !== 'object') throw new Error(`Gemini groundingSupports[${supportIndex}] 必须是对象`);
    const segment = support.segment;
    if (!segment || Array.isArray(segment) || typeof segment !== 'object') throw new Error(`Gemini groundingSupports[${supportIndex}].segment 必须是对象`);
    const startIndex = segment.startIndex ?? 0;
    const endIndex = segment.endIndex;
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(endIndex) || endIndex < startIndex) {
      throw new Error(`Gemini groundingSupports[${supportIndex}].segment 包含无效文本索引`);
    }
    if (Number.isSafeInteger(textLength) && endIndex > textLength) {
      throw new Error(`Gemini groundingSupports[${supportIndex}].segment 超出文本长度：${startIndex}–${endIndex}/${textLength}`);
    }
    if (!Array.isArray(support.groundingChunkIndices)) throw new Error(`Gemini groundingSupports[${supportIndex}].groundingChunkIndices 必须是数组`);
    for (const chunkIndex of support.groundingChunkIndices) {
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunks.length) {
        throw new Error(`Gemini groundingSupports[${supportIndex}] 引用了无效 groundingChunk：${String(chunkIndex)}`);
      }
      const web = chunks[chunkIndex]?.web;
      if (!web || typeof web.uri !== 'string' || !web.uri || typeof web.title !== 'string') continue;
      const annotation = { type: 'url_citation', url: web.uri, title: web.title, start_index: startIndex, end_index: endIndex };
      const key = JSON.stringify(annotation);
      if (seen.has(key)) continue;
      seen.add(key);
      annotations.push(annotation);
    }
  }
  const webSearchQueries = [...new Set(asArray(metadata.webSearchQueries).filter((query) => typeof query === 'string' && query))];
  return { annotations, webSearchQueries };
}

function portablePartText(part) {
  return `${part?.text || ''}${portableAnnotationText(part?.annotations)}`;
}

function normalizeParts(content, {
  includeReasoning = false, dropOpaqueReasoning = false, rejectUnknown = false,
  claudeCompactionResponse = false, claudeToolReferences
} = {}) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return asArray(content).flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (['text', 'input_text', 'output_text'].includes(part?.type)) {
      if (rejectUnknown) {
        assertKnownObjectKeys(part, new Set(['type', 'text', 'cache_control', 'prompt_cache_breakpoint', 'annotations', 'logprobs']), `${part.type} 内容块`);
        if (typeof part.text !== 'string') throw unsupportedFeature(`${part.type}.text 必须是字符串`);
      }
      return [{
        type: 'text', text: part.text || '',
        ...(part.cache_control ? { cacheControl: part.cache_control } : {}),
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {}),
        ...(part.annotations !== undefined ? { annotations: normalizeOutputAnnotations(part.annotations, `${part.type}.annotations`) } : {}),
        ...(part.logprobs !== undefined ? { logprobs: normalizeTokenLogprobs(part.logprobs, `${part.type} logprobs`) } : {})
      }];
    }
    if (part?.type === 'refusal') {
      if (rejectUnknown) {
        assertKnownObjectKeys(part, new Set(['type', 'refusal', 'prompt_cache_breakpoint']), 'refusal 内容块');
        if (typeof part.refusal !== 'string') throw unsupportedFeature('refusal.refusal 必须是字符串');
      }
      return [{
        type: 'refusal', text: part.refusal || '',
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (includeReasoning && part?.type === 'thinking') {
      validateClaudeThinkingBlock(part, 'Claude thinking 块', (message) => { throw unsupportedFeature(message); });
      const text = part.thinking;
      const bridged = decodeSingleReasoningState(part.signature, 'Claude thinking.signature');
      const providerState = bridged || { protocol: 'claude', kind: 'thinking', value: { type: 'thinking', thinking: text, signature: part.signature } };
      return text ? [{ type: 'reasoning', text, signature: part.signature, providerState }] : [{ type: 'provider_state', providerState }];
    }
    if (part?.type === 'redacted_thinking') {
      validateClaudeThinkingBlock(part, 'Claude redacted_thinking 块', (message) => { throw unsupportedFeature(message); });
      const bridged = decodeSingleReasoningState(part.data, 'Claude redacted_thinking.data');
      if (bridged) return [{ type: 'provider_state', providerState: bridged }];
      if (dropOpaqueReasoning) return [];
      return [{ type: 'provider_state', providerState: { protocol: 'claude', kind: 'redacted_thinking', value: { type: 'redacted_thinking', data: part.data } } }];
    }
    if (includeReasoning && part?.type === 'fallback') {
      validateClaudeFallbackBlock(part, 'Claude fallback 块', (message) => { throw unsupportedFeature(message); });
      return [{ type: 'provider_state', providerState: { protocol: 'claude', kind: 'fallback', value: part } }];
    }
    if (includeReasoning && part?.type === 'compaction') {
      validateClaudeCompactionBlock(part, 'Claude compaction 块', (message) => { throw unsupportedFeature(message); }, {
        response: claudeCompactionResponse
      });
      const providerState = { protocol: 'claude', kind: 'compaction', value: part };
      return part.content
        ? [{ type: 'reasoning', reasoningKind: 'summary', text: part.content, providerState }]
        : [{ type: 'provider_state', providerState }];
    }
    if (part?.type === 'image') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'source', 'detail', 'cache_control', 'prompt_cache_breakpoint']), 'image 内容块');
      return [{
        type: 'image', source: part.source,
        ...(part.detail ? { detail: part.detail } : {}),
        ...(part.cache_control ? { cacheControl: part.cache_control } : {}),
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (part?.type === 'image_url') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'image_url', 'prompt_cache_breakpoint']), 'image_url 内容块');
      return [{
        type: 'image', source: { type: 'url', url: part.image_url?.url || part.image_url },
        ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}),
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (part?.type === 'input_image') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'image_url', 'file_id', 'detail', 'prompt_cache_breakpoint']), 'input_image 内容块');
      return [{
        type: 'image', source: part.image_url ? { type: 'url', url: part.image_url } : { type: 'file', file_id: part.file_id },
        ...(part.detail ? { detail: part.detail } : {}),
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (part?.type === 'document') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'source', 'filename', 'title', 'context', 'citations', 'cache_control']), 'document 内容块');
      return [{
        type: 'file', source: part.source, filename: part.filename,
        title: part.title, context: part.context, citations: part.citations,
        ...(part.cache_control ? { cacheControl: part.cache_control } : {})
      }];
    }
    if (part?.type === 'input_file') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'file_url', 'file_id', 'file_data', 'filename', 'detail', 'prompt_cache_breakpoint']), 'input_file 内容块');
      return [{
        type: 'file', source: openAiFileSource(part), filename: part.filename,
        ...(part.detail ? { detail: part.detail } : {}),
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (part?.type === 'file') {
      if (rejectUnknown) assertKnownObjectKeys(part, new Set(['type', 'file', 'prompt_cache_breakpoint']), 'file 内容块');
      return [{
        type: 'file', source: openAiFileSource(part.file || {}), filename: part.file?.filename,
        ...(part.prompt_cache_breakpoint ? { promptCacheBreakpoint: part.prompt_cache_breakpoint } : {})
      }];
    }
    if (part?.type === 'tool_use') {
      if (rejectUnknown) {
        assertKnownObjectKeys(part, new Set(['type', 'id', 'name', 'input', 'cache_control']), 'Claude tool_use 内容块');
        if (typeof part.id !== 'string' || !part.id) throw unsupportedFeature('Claude tool_use.id 必须是非空字符串');
        if (typeof part.name !== 'string' || !part.name) throw unsupportedFeature('Claude tool_use.name 必须是非空字符串');
        if (!part.input || Array.isArray(part.input) || typeof part.input !== 'object') throw unsupportedFeature('Claude tool_use.input 必须是对象');
      }
      return [{
        type: 'tool_call', id: part.id, name: part.name, arguments: part.input || {},
        ...(part.cache_control ? { cacheControl: part.cache_control } : {})
      }];
    }
    if (part?.type === 'tool_result') {
      if (rejectUnknown) {
        assertKnownObjectKeys(part, new Set(['type', 'tool_use_id', 'content', 'is_error', 'cache_control']), 'Claude tool_result 内容块');
        if (typeof part.tool_use_id !== 'string' || !part.tool_use_id) throw unsupportedFeature('Claude tool_result.tool_use_id 必须是非空字符串');
      }
      if (claudeToolReferences) addClaudeToolReferenceNames(claudeToolReferences, part.content);
      const isError = rejectUnknown ? optionalBoolean(part.is_error, 'Claude tool_result.is_error') : part.is_error;
      return [{
        type: 'tool_result', id: part.tool_use_id, content: part.content,
        ...(isError !== undefined ? { isError } : {}),
        ...(part.cache_control ? { cacheControl: part.cache_control } : {})
      }];
    }
    if (rejectUnknown) {
      const type = part && typeof part === 'object' && !Array.isArray(part) ? part.type || 'unknown' : part === null ? 'null' : typeof part;
      throw unsupportedFeature(`跨协议转换暂不支持内容块类型：${type}`);
    }
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

function assertSupportedUpstreamProtocol(protocol) {
  if (SUPPORTED_UPSTREAM_PROTOCOLS.has(protocol)) return;
  throw unsupportedFeature(`不支持的上游协议：${String(protocol)}`);
}

function validateMessageContent(content, label, { allowAbsentOrEmpty = false } = {}) {
  if (content === undefined || content === null) {
    if (allowAbsentOrEmpty) return;
    throw unsupportedFeature(`${label} 必须是非空字符串或非空内容块数组`);
  }
  if (typeof content === 'string') {
    if (!content && !allowAbsentOrEmpty) throw unsupportedFeature(`${label} 必须是非空字符串或非空内容块数组`);
    return;
  }
  if (!Array.isArray(content) || (!content.length && !allowAbsentOrEmpty)) {
    throw unsupportedFeature(`${label} 必须是非空字符串或非空内容块数组`);
  }
}

function isPortableMessagePart(part) {
  return !['text', 'refusal', 'reasoning'].includes(part.type)
    || (typeof part.text === 'string' && part.text.length > 0);
}

function hasPortableMessagePayload(parts) {
  return parts.some(isPortableMessagePart);
}

function validateMessageContentRole(content, label, role, allowedByRole) {
  if (!Array.isArray(content)) return false;
  const allowed = allowedByRole[role];
  let hasRedactedThinking = false;
  for (const [index, part] of content.entries()) {
    const type = typeof part === 'string'
      ? 'text'
      : part && !Array.isArray(part) && typeof part === 'object'
        ? part.type || (typeof part.text === 'string' ? 'text' : 'unknown')
        : part === null ? 'null' : typeof part;
    if (type === 'redacted_thinking') hasRedactedThinking = true;
    if (!allowed?.has(type)) {
      throw unsupportedFeature(`${label}[${index}] 的 ${type} 内容块不能用于 ${role} role`);
    }
  }
  return hasRedactedThinking;
}

function portableToolResultContent(part) {
  const content = part.content === undefined
    ? ''
    : typeof part.content === 'string' ? part.content : canonicalJsonString(part.content);
  return part.isError ? `${CLAUDE_TOOL_ERROR_PREFIX}${content ? `\n${content}` : ''}` : content;
}

function optionalOpenAiString(value, label, { maximum } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value || (maximum && value.length > maximum)) {
    throw unsupportedFeature(`${label} 必须是${maximum ? `长度 1–${maximum} 的` : '非空'}字符串`);
  }
  return value;
}

function optionalOpenAiEnum(value, label, supported) {
  if (value === undefined || value === null) return undefined;
  if (!supported.has(value)) throw unsupportedFeature(`${label} 必须是 ${[...supported].join('、')} 之一`);
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw unsupportedFeature(`${label} 必须是布尔值`);
  return value;
}

function assertPortableResponsesExecution(body, targetProtocol) {
  const target = targetProtocol === 'claude' ? 'Claude Messages'
    : targetProtocol === 'gemini' ? 'Gemini GenerateContent' : 'Chat Completions';
  if (body.stream_options !== undefined && body.stream_options !== null) {
    if (!body.stream_options || Array.isArray(body.stream_options) || typeof body.stream_options !== 'object') {
      throw unsupportedFeature('Responses stream_options 必须是对象');
    }
    if (body.stream !== true) throw unsupportedFeature('Responses stream_options 仅可在 stream=true 时使用');
    const unknown = Object.keys(body.stream_options).filter((field) => field !== 'include_obfuscation');
    if (unknown.length) throw unsupportedFeature(`跨协议转换无法保留 Responses stream_options 字段：${unknown.join(', ')}`);
    if (body.stream_options.include_obfuscation !== undefined && typeof body.stream_options.include_obfuscation !== 'boolean') {
      throw unsupportedFeature('Responses stream_options.include_obfuscation 必须是布尔值');
    }
  }
  for (const field of ['background', 'store']) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      throw unsupportedFeature(`Responses ${field} 必须是布尔值`);
    }
  }
  if (body.background === true) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法保留 Responses background 异步执行；请将模型路由设为 responses`);
  }
  if (body.store === true) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法保留 Responses store 持久化与后续检索语义；请将模型路由设为 responses`);
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法解析 Responses previous_response_id 中的服务端历史；请重发完整 input 历史或将模型路由设为 responses`);
  }
  if (body.conversation !== undefined && body.conversation !== null) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法读取 Responses conversation 中的服务端会话；请重发完整 input 历史或将模型路由设为 responses`);
  }
  if (body.truncation !== undefined && body.truncation !== null && body.truncation !== 'disabled') {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法保留 Responses truncation=${String(body.truncation)}；请使用 truncation=disabled 或将模型路由设为 responses`);
  }
  if (body.prompt !== undefined && body.prompt !== null) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法解析 Responses prompt 服务端模板；请展开为 instructions/input 或将模型路由设为 responses`);
  }
  if (body.max_tool_calls !== undefined && body.max_tool_calls !== null) {
    throw unsupportedFeature(`跨协议转换到 ${target} 无法保证 Responses max_tool_calls 限制；请将模型路由设为 responses`);
  }
  if (body.context_management !== undefined && body.context_management !== null) {
    if (!Array.isArray(body.context_management)) throw unsupportedFeature('Responses context_management 必须是数组');
    if (body.context_management.length) {
      throw unsupportedFeature(`跨协议转换到 ${target} 无法执行 Responses context_management 服务端压缩；请将模型路由设为 responses`);
    }
  }
  if (body.include !== undefined && body.include !== null) {
    if (!Array.isArray(body.include) || body.include.some((value) => typeof value !== 'string')) {
      throw unsupportedFeature('Responses include 必须是字符串数组');
    }
    const portableIncludes = new Set(PORTABLE_RESPONSES_INCLUDES);
    if (['chat', 'gemini'].includes(targetProtocol)) portableIncludes.add('message.output_text.logprobs');
    const unsupported = [...new Set(body.include.filter((value) => !portableIncludes.has(value)))];
    if (unsupported.length) {
      throw unsupportedFeature(`跨协议转换到 ${target} 无法生成 Responses include 字段：${unsupported.join(', ')}；请将模型路由设为 responses`);
    }
  }
  for (const [index, item] of asArray(body.input).entries()) {
    if (item?.phase !== undefined && item.phase !== null) {
      optionalOpenAiEnum(item.phase, `Responses input[${index}].phase`, RESPONSES_ITEM_PHASES);
      throw unsupportedFeature(`跨协议转换到 ${target} 无法保留 Responses input[${index}].phase=${String(item.phase)}；请将模型路由设为 responses`);
    }
  }
}

function assertPortableChatExecution(body, targetProtocol) {
  if (body.stream_options !== undefined && body.stream_options !== null) {
    if (!body.stream_options || Array.isArray(body.stream_options) || typeof body.stream_options !== 'object') {
      throw unsupportedFeature('Chat stream_options 必须是对象');
    }
    if (body.stream !== true) throw unsupportedFeature('Chat stream_options 仅可在 stream=true 时使用');
    const unknown = Object.keys(body.stream_options).filter((field) => !['include_usage', 'include_obfuscation'].includes(field));
    if (unknown.length) throw unsupportedFeature(`跨协议转换无法保留 Chat stream_options 字段：${unknown.join(', ')}`);
    for (const field of ['include_usage', 'include_obfuscation']) {
      if (body.stream_options[field] !== undefined && typeof body.stream_options[field] !== 'boolean') {
        throw unsupportedFeature(`Chat stream_options.${field} 必须是布尔值`);
      }
    }
  }
  if (body.store !== undefined && body.store !== null && typeof body.store !== 'boolean') {
    throw unsupportedFeature('Chat store 必须是布尔值');
  }
  if (body.store === true) {
    const target = targetProtocol === 'responses' ? 'Responses'
      : targetProtocol === 'gemini' ? 'Gemini GenerateContent' : 'Claude Messages';
    throw unsupportedFeature(`跨协议转换到 ${target} 无法保留 Chat store 的 distillation/evals 存储语义；请将模型路由设为 chat`);
  }
  if (body.n !== undefined && body.n !== null) {
    if (!Number.isSafeInteger(body.n) || body.n < 1) throw unsupportedFeature('Chat n 必须是正安全整数');
    if (body.n !== 1) throw unsupportedFeature(`跨协议转换只支持 Chat n=1；收到 n=${body.n}，否则会丢失候选响应`);
  }
  if (body.modalities !== undefined && body.modalities !== null) {
    if (!Array.isArray(body.modalities) || body.modalities.some((value) => typeof value !== 'string')) {
      throw unsupportedFeature('Chat modalities 必须是字符串数组');
    }
    if (body.modalities.length !== 1 || body.modalities[0] !== 'text') {
      throw unsupportedFeature('跨协议转换只支持 Chat modalities=["text"]；音频输出请使用 chat 原生路由');
    }
  }
  const unsupported = ['audio', 'prediction', 'logit_bias', 'web_search_options']
    .filter((field) => body[field] !== undefined && body[field] !== null);
  if (unsupported.length) {
    throw unsupportedFeature(`跨协议转换无法保留 Chat 请求字段：${unsupported.join(', ')}；请将模型路由设为 chat`);
  }
}

function normalizedLogprobCandidate(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} 必须是对象`);
  if (typeof value.token !== 'string') throw new Error(`${label}.token 必须是字符串`);
  const logprob = value.logprob ?? value.logProbability;
  if (typeof logprob !== 'number' || !Number.isFinite(logprob)) throw new Error(`${label}.logprob 必须是有限数字`);
  const bytes = value.bytes;
  if (bytes !== undefined && (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
    throw new Error(`${label}.bytes 必须是字节数组`);
  }
  const tokenId = value.tokenId;
  if (tokenId !== undefined && !Number.isSafeInteger(tokenId)) throw new Error(`${label}.tokenId 必须是安全整数`);
  return {
    token: value.token, logprob,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(tokenId !== undefined ? { tokenId } : {})
  };
}

export function normalizeTokenLogprobs(value, label = '上游 logprobs') {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.map((entry, index) => {
    const candidate = normalizedLogprobCandidate(entry, `${label}[${index}]`);
    const top = entry.top_logprobs ?? entry.topLogprobs;
    if (top !== undefined) {
      if (!Array.isArray(top)) throw new Error(`${label}[${index}].top_logprobs 必须是数组`);
      candidate.topLogprobs = top.map((item, topIndex) => normalizedLogprobCandidate(item, `${label}[${index}].top_logprobs[${topIndex}]`));
    }
    return candidate;
  });
}

export function normalizeGeminiLogprobs(candidate) {
  const result = candidate?.logprobsResult;
  if (result == null) return undefined;
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Gemini logprobsResult 必须是对象');
  if (!Array.isArray(result.chosenCandidates) || !Array.isArray(result.topCandidates)) {
    throw new Error('Gemini logprobsResult 缺少 chosenCandidates/topCandidates 数组');
  }
  if (result.chosenCandidates.length !== result.topCandidates.length) {
    throw new Error('Gemini logprobsResult 的 chosenCandidates 与 topCandidates 长度不一致');
  }
  return result.chosenCandidates.map((entry, index) => {
    const chosen = normalizedLogprobCandidate(entry, `Gemini chosenCandidates[${index}]`);
    const top = result.topCandidates[index];
    if (!top || !Array.isArray(top.candidates)) throw new Error(`Gemini topCandidates[${index}].candidates 必须是数组`);
    chosen.topLogprobs = top.candidates.map((item, topIndex) => normalizedLogprobCandidate(item, `Gemini topCandidates[${index}].candidates[${topIndex}]`));
    return chosen;
  });
}

export function geminiLogprobFields(logprobs) {
  if (!logprobs?.length) return {};
  const normalized = normalizeTokenLogprobs(logprobs);
  const sum = normalized.reduce((total, entry) => total + entry.logprob, 0);
  return {
    avgLogprobs: sum / normalized.length,
    logprobsResult: {
      topCandidates: normalized.map((entry) => ({ candidates: (entry.topLogprobs?.length ? entry.topLogprobs : [entry]).map(geminiLogprobCandidate) })),
      chosenCandidates: normalized.map(geminiLogprobCandidate),
      logProbabilitySum: sum
    }
  };
}

function geminiLogprobCandidate(entry) {
  return {
    token: entry.token, logProbability: entry.logprob,
    ...(entry.tokenId !== undefined ? { tokenId: entry.tokenId } : {})
  };
}

function objectValue(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw unsupportedFeature(`${label} 必须是对象`);
  return value;
}

function assertKnownObjectKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw unsupportedFeature(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
}

function validateResponsesClientMetadata(value) {
  if (value === undefined) return;
  const metadata = objectValue(value, 'Responses client_metadata');
  const entries = Object.entries(metadata);
  if (entries.length > 64) throw unsupportedFeature('Responses client_metadata 最多包含 64 项');
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw unsupportedFeature('Responses client_metadata 键名必须是长度 1–128 且不含控制字符的字符串');
    }
    if (typeof item !== 'string' || item.length > 1024 * 1024) {
      throw unsupportedFeature(`Responses client_metadata.${key} 必须是最长 1 MiB 的字符串`);
    }
  }
}

function validateCrossProtocolRequestFields(body, protocol) {
  const allowed = CROSS_PROTOCOL_REQUEST_KEYS[protocol];
  if (!allowed) return;
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat' }[protocol];
    throw unsupportedFeature(`跨协议转换暂不支持 ${label} 请求字段：${unsupported.join(', ')}`);
  }
}

function finiteNumber(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unsupportedFeature(`${label} 必须是有限数字`);
  return value;
}

function rangedNumber(value, label, { minimum, maximum }) {
  if (value === undefined || value === null) return undefined;
  const normalized = finiteNumber(value, label);
  if (normalized < minimum || normalized > maximum) {
    throw unsupportedFeature(`${label} 必须是 ${minimum}–${maximum} 之间的有限数字`);
  }
  return normalized;
}

function integer(value, label, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw unsupportedFeature(`${label} 必须是 ${minimum}–${maximum} 之间的安全整数`);
  }
  return value;
}

function optionalInteger(value, label, range = {}) {
  return value === null ? undefined : integer(value, label, range);
}

function normalizeOpenAiOutputFormat(format, protocol) {
  if (format == null) return undefined;
  format = objectValue(format, `${protocol} 结构化输出配置`);
  if (format.type === 'text') {
    assertKnownObjectKeys(format, new Set(['type']), `${protocol} text 输出格式`);
    return undefined;
  }
  if (format.type === 'json_object') {
    assertKnownObjectKeys(format, new Set(['type']), `${protocol} json_object 输出格式`);
    return { type: 'json_object' };
  }
  if (format.type !== 'json_schema') throw unsupportedFeature(`跨协议转换暂不支持 ${protocol} 输出格式：${format.type || 'unknown'}`);
  if (protocol === 'Chat') assertKnownObjectKeys(format, new Set(['type', 'json_schema']), 'Chat response_format');
  const definition = protocol === 'Chat' ? objectValue(format.json_schema, 'Chat response_format.json_schema') : format;
  assertKnownObjectKeys(definition, new Set(protocol === 'Chat'
    ? ['name', 'description', 'schema', 'strict']
    : ['type', 'name', 'description', 'schema', 'strict']), `${protocol} json_schema 输出格式`);
  const schema = objectValue(definition.schema, `${protocol} JSON Schema`);
  const name = typeof definition.name === 'string' && definition.name ? definition.name : 'bridge_response';
  const strict = optionalBoolean(definition.strict, `${protocol} JSON Schema strict`);
  return {
    type: 'json_schema', name, schema,
    ...(typeof definition.description === 'string' ? { description: definition.description } : {}),
    ...(strict !== undefined ? { strict } : {})
  };
}

function normalizeGeminiOutputFormat(generation) {
  const legacySchemas = ['responseSchema', '_responseJsonSchema', 'responseJsonSchema']
    .filter((key) => generation[key] !== undefined);
  if (legacySchemas.length > 1) throw unsupportedFeature(`Gemini generationConfig 不能同时设置 ${legacySchemas.join('、')}`);

  let mimeType = generation.responseMimeType;
  let schema = legacySchemas.length ? objectValue(generation[legacySchemas[0]], `Gemini ${legacySchemas[0]}`) : undefined;
  if (generation.responseFormat !== undefined) {
    if (mimeType !== undefined || schema !== undefined) {
      throw unsupportedFeature('Gemini responseFormat 不能与 responseMimeType/responseSchema 同时设置');
    }
    const responseFormat = objectValue(generation.responseFormat, 'Gemini responseFormat');
    const unsupported = Object.keys(responseFormat).filter((key) => key !== 'text');
    if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini responseFormat 字段：${unsupported.join(', ')}`);
    const text = objectValue(responseFormat.text, 'Gemini responseFormat.text');
    const textUnsupported = Object.keys(text).filter((key) => !['mimeType', 'schema'].includes(key));
    if (textUnsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini responseFormat.text 字段：${textUnsupported.join(', ')}`);
    mimeType = text.mimeType;
    schema = text.schema === undefined ? undefined : objectValue(text.schema, 'Gemini responseFormat.text.schema');
  }

  if (mimeType == null && schema === undefined) return undefined;
  if (mimeType == null && schema !== undefined) mimeType = 'application/json';
  if (mimeType === 'text/plain') {
    if (schema !== undefined) throw unsupportedFeature('Gemini text/plain 响应不能同时指定 JSON Schema');
    return undefined;
  }
  if (mimeType !== 'application/json') throw unsupportedFeature(`跨协议转换暂不支持 Gemini responseMimeType=${mimeType}`);
  if (!schema) return { type: 'json_object' };
  return { type: 'json_schema', name: 'gemini_response', schema, strict: true };
}

function unsupportedGenerationOptions(request, protocol, keys) {
  const present = keys.filter((key) => request[key] !== undefined);
  if (present.length) throw unsupportedFeature(`跨协议转换到 ${protocol} 无法表达生成参数：${present.join(', ')}`);
}

function claudeTargetMetadata(metadata) {
  if (metadata?.user_id === undefined || metadata.user_id === null) return undefined;
  return { user_id: optionalOpenAiString(metadata.user_id, 'Claude metadata.user_id', { maximum: 512 }) };
}

function openAiTargetMetadata(metadata, protocol) {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length > 16) throw unsupportedFeature(`${protocol} metadata 最多支持 16 个键值对`);
  for (const [key, value] of entries) {
    if (key.length > 64) throw unsupportedFeature(`${protocol} metadata 键名最长为 64 个字符`);
    if (typeof value !== 'string' || value.length > 512) {
      throw unsupportedFeature(`${protocol} metadata.${key || '<empty>'} 必须是最长 512 个字符的字符串`);
    }
  }
  return metadata;
}

function responsesOutputFormat(format) {
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema', name: format.name, schema: format.schema,
    ...(format.description ? { description: format.description } : {}),
    ...(format.strict !== undefined ? { strict: format.strict } : {})
  };
}

function chatOutputFormat(format) {
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name, schema: format.schema,
      ...(format.description ? { description: format.description } : {}),
      ...(format.strict !== undefined ? { strict: format.strict } : {})
    }
  };
}

function validResponsesFunction(tool, label) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name) {
    throw unsupportedFeature(`${label} 必须是具有有效 name 的 function tool`);
  }
  assertKnownObjectKeys(tool, new Set([
    'type', 'name', 'description', 'parameters', 'strict', 'allowed_callers', 'output_schema', 'defer_loading'
  ]), label);
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw unsupportedFeature(`${label}.description 必须是字符串`);
  }
  if (tool.parameters !== undefined && (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))) {
    throw unsupportedFeature(`${label}.parameters 必须是 JSON Schema 对象`);
  }
  optionalBoolean(tool.strict, `${label}.strict`);
  optionalBoolean(tool.defer_loading, `${label}.defer_loading`);
  validateResponsesToolExecutionFields(tool, label);
}

function validateResponsesToolExecutionFields(tool, label) {
  if (tool.allowed_callers !== undefined && (!Array.isArray(tool.allowed_callers) || tool.allowed_callers.length === 0
    || tool.allowed_callers.some((caller) => typeof caller !== 'string' || !RESPONSES_TOOL_CALLERS.has(caller))
    || new Set(tool.allowed_callers).size !== tool.allowed_callers.length)) {
    throw unsupportedFeature(`${label}.allowed_callers 必须是由 direct/programmatic 组成的无重复非空数组`);
  }
  if (tool.output_schema !== undefined && (!tool.output_schema || typeof tool.output_schema !== 'object' || Array.isArray(tool.output_schema))) {
    throw unsupportedFeature(`${label}.output_schema 必须是 JSON Schema 对象`);
  }
}

function responsesPortableToolDescription(tool, description = tool.description) {
  if (tool.output_schema === undefined) return description;
  return [description, `Responses output_schema:\n${canonicalJsonString(tool.output_schema)}`].filter(Boolean).join('\n\n');
}

function geminiPortableToolDescription(tool) {
  const responseSchema = tool.responseJsonSchema ?? tool.response;
  if (responseSchema === undefined) return tool.description;
  return [tool.description, `Gemini function response JSON Schema:\n${canonicalJsonString(responseSchema)}`].filter(Boolean).join('\n\n');
}

function assertResponsesToolDirectCallable(tool, label, targetProtocol = '非 Responses 协议') {
  if (tool.allowed_callers && !tool.allowed_callers.includes('direct')) {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 时无法保留仅允许 programmatic 调用的 Responses 工具：${tool.name || label}；请将模型路由设为 responses`);
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

function allocateAdaptedToolAlias(name, kind, usedNames, index) {
  const base = sanitizedChatToolName(name, kind).slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const suffix = `__${kind}_${index}`;
  let alias = `${base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
  let collision = 1;
  while (usedNames.has(alias)) {
    const collisionSuffix = `${suffix}_${collision++}`;
    alias = `${base.slice(0, CHAT_TOOL_NAME_MAX_LENGTH - collisionSuffix.length)}${collisionSuffix}`;
  }
  usedNames.add(alias);
  return alias;
}

function customToolDescription(tool) {
  const grammar = tool?.format?.type === 'grammar' && typeof tool.format.definition === 'string'
    ? `Original ${tool.format.syntax || 'custom'} grammar:\n${tool.format.definition}`
    : '';
  return [
    tool?.description,
    `Responses custom tool compatibility: put the complete free-form tool input in the JSON string field "${CUSTOM_TOOL_INPUT_FIELD}".`,
    grammar
  ].filter(Boolean).join('\n\n');
}

function mergeResponsesTools(tools, input) {
  const result = [...asArray(tools)];
  const keys = new Set(result.map(responsesToolKey).filter(Boolean));
  for (const item of asArray(input)) {
    if (item?.type !== 'tool_search_output' || !Array.isArray(item.tools)) continue;
    for (const tool of item.tools) {
      const key = responsesToolKey(tool);
      if (key && keys.has(key)) continue;
      if (key) keys.add(key);
      result.push(tool);
    }
  }
  return result;
}

function responsesToolKey(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return '';
  return `${tool.type || 'function'}\n${tool.name || tool.execution || ''}`;
}

function responsesAllowedToolSelectorKey(selector, label) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || typeof selector.type !== 'string' || !selector.type) {
    throw unsupportedFeature(`${label} 必须是具有有效 type 的工具选择对象`);
  }
  if (selector.type === 'function') {
    if (typeof selector.name !== 'string' || !selector.name) throw unsupportedFeature(`${label} 的 function 缺少有效 name`);
    if (selector.namespace !== undefined && (typeof selector.namespace !== 'string' || !selector.namespace)) {
      throw unsupportedFeature(`${label}.namespace 必须是非空字符串`);
    }
    return `function\n${selector.namespace || ''}\n${selector.name}`;
  }
  if (selector.type === 'custom') {
    if (typeof selector.name !== 'string' || !selector.name) throw unsupportedFeature(`${label} 的 custom tool 缺少有效 name`);
    return `custom\n${selector.name}`;
  }
  if (selector.type === 'mcp') {
    if (typeof selector.server_label !== 'string' || !selector.server_label) throw unsupportedFeature(`${label} 的 MCP tool 缺少有效 server_label`);
    return `mcp\n${selector.server_label}`;
  }
  if (RESPONSES_WEB_SEARCH_TOOL_TYPES.has(selector.type)) return 'hosted\nweb_search';
  return `hosted\n${selector.type}`;
}

function responsesToolSelectorEntries(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
  if (tool.type === 'namespace') {
    return asArray(tool.tools).map((child) => ({ key: `function\n${tool.name || ''}\n${child?.name || ''}`, child }));
  }
  if (tool.type === 'function') return [{ key: `function\n\n${tool.name || ''}`, tool }];
  if (tool.type === 'custom') return [{ key: `custom\n${tool.name || ''}`, tool }];
  if (tool.type === 'mcp') return [{ key: `mcp\n${tool.server_label || ''}`, tool }];
  if (RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool.type)) return [{ key: 'hosted\nweb_search', tool }];
  return [{ key: `hosted\n${tool.type || ''}`, tool }];
}

function selectResponsesAllowedTools(choice, tools) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || choice.type !== 'allowed_tools') return null;
  const unsupported = Object.keys(choice).filter((key) => !['type', 'mode', 'tools'].includes(key));
  if (unsupported.length) throw unsupportedFeature(`Responses allowed_tools 包含不支持的字段：${unsupported.join(', ')}`);
  if (!['auto', 'required'].includes(choice.mode)) throw unsupportedFeature('Responses allowed_tools.mode 必须是 auto 或 required');
  if (!Array.isArray(choice.tools) || choice.tools.length === 0) throw unsupportedFeature('Responses allowed_tools.tools 必须是非空数组');

  const source = asArray(tools);
  const availableKeys = new Set();
  for (const tool of source) {
    for (const entry of responsesToolSelectorEntries(tool)) availableKeys.add(entry.key);
  }
  const selectedKeys = new Set();
  for (const [index, selector] of choice.tools.entries()) {
    const key = responsesAllowedToolSelectorKey(selector, `Responses allowed_tools.tools[${index}]`);
    if (selectedKeys.has(key)) throw unsupportedFeature(`Responses allowed_tools.tools[${index}] 重复选择同一工具`);
    if (!availableKeys.has(key)) throw unsupportedFeature(`Responses allowed_tools.tools[${index}] 引用了未定义工具`);
    selectedKeys.add(key);
  }

  const selected = [];
  for (const tool of source) {
    if (tool?.type === 'namespace') {
      const children = asArray(tool.tools).filter((child) => selectedKeys.has(`function\n${tool.name || ''}\n${child?.name || ''}`));
      if (children.length) selected.push({ ...tool, tools: children });
      continue;
    }
    if (responsesToolSelectorEntries(tool).some((entry) => selectedKeys.has(entry.key))) selected.push(tool);
  }
  return { mode: choice.mode, tools: selected };
}

function selectedResponsesPortableToolNames(tools, aliasIndex) {
  const names = new Set();
  for (const tool of asArray(tools)) {
    if (tool?.type === 'function') names.add(tool.name);
    else if (tool?.type === 'custom') names.add(adaptedResponsesToolAlias('custom', tool.name, aliasIndex));
    else if (tool?.type === 'tool_search' && tool.execution === 'client') names.add(adaptedResponsesToolAlias('tool_search', '', aliasIndex));
    else if (tool?.type === 'namespace') {
      for (const child of asArray(tool.tools)) names.add(responsesToolAlias(tool.name, child?.name, aliasIndex));
    }
  }
  return names;
}

function responsesToolCompatibility(tools, { rejectUnsupported = true } = {}) {
  const source = asArray(tools);
  const usedNames = new Set(source.filter((tool) => tool?.type === 'function' && typeof tool.name === 'string').map((tool) => tool.name));
  const directNames = new Set();
  const customNames = new Set();
  const namespaceNames = new Set();
  const namespaceChildren = new Set();
  const flattened = [];
  const aliases = [];
  const unsupportedTypes = [];
  let droppedWebSearch = false;

  for (let namespaceIndex = 0; namespaceIndex < source.length; namespaceIndex++) {
    const tool = source[namespaceIndex];
    if (tool?.type === 'function') {
      const label = `Responses tools[${namespaceIndex}]`;
      validResponsesFunction(tool, label);
      if (rejectUnsupported) assertResponsesToolDirectCallable(tool, label);
      if (directNames.has(tool.name)) throw unsupportedFeature(`Responses function tool 名称重复：${tool.name}`);
      directNames.add(tool.name);
      flattened.push({
        name: tool.name, description: responsesPortableToolDescription(tool), schema: tool.parameters || {}, strict: tool.strict,
        ...(tool.allowed_callers !== undefined ? { allowedCallers: tool.allowed_callers } : {})
      });
      continue;
    }
    if (RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type)) {
      droppedWebSearch = true;
      continue;
    }
    if (tool?.type === 'custom') {
      assertKnownObjectKeys(tool, new Set([
        'type', 'name', 'description', 'format', 'allowed_callers', 'output_schema', 'defer_loading'
      ]), `Responses custom tools[${namespaceIndex}]`);
      if (typeof tool.name !== 'string' || !tool.name) throw unsupportedFeature(`Responses custom tools[${namespaceIndex}] 缺少有效 name`);
      optionalBoolean(tool.defer_loading, `Responses custom tools[${namespaceIndex}].defer_loading`);
      validateResponsesToolExecutionFields(tool, `Responses custom tools[${namespaceIndex}]`);
      if (rejectUnsupported) assertResponsesToolDirectCallable(tool, `Responses custom tools[${namespaceIndex}]`);
      if (tool.format !== undefined && (!tool.format || typeof tool.format !== 'object' || Array.isArray(tool.format))) {
        throw unsupportedFeature(`Responses custom tools[${namespaceIndex}] 的 format 必须是对象`);
      }
      if (tool.format?.type === 'grammar' && typeof tool.format.definition !== 'string') {
        throw unsupportedFeature(`Responses custom tools[${namespaceIndex}] 的 grammar 缺少 definition`);
      }
      if (customNames.has(tool.name)) throw unsupportedFeature(`Responses custom tool 名称重复：${tool.name}`);
      customNames.add(tool.name);
      const alias = allocateAdaptedToolAlias(tool.name, 'custom', usedNames, namespaceIndex);
      aliases.push({ alias, kind: 'custom', name: tool.name });
      flattened.push({
        name: alias,
        description: responsesPortableToolDescription(tool, customToolDescription(tool)),
        schema: {
          type: 'object',
          properties: { [CUSTOM_TOOL_INPUT_FIELD]: { type: 'string', description: 'Complete free-form input for the custom tool.' } },
          required: [CUSTOM_TOOL_INPUT_FIELD],
          additionalProperties: false
        }
      });
      continue;
    }
    if (tool?.type === 'programmatic_tool_calling') {
      assertKnownObjectKeys(tool, new Set(['type']), `Responses tools[${namespaceIndex}] programmatic_tool_calling`);
      continue;
    }
    if (tool?.type === 'tool_search' && tool.execution === 'client') {
      assertKnownObjectKeys(tool, new Set(['type', 'execution', 'description', 'parameters']), `Responses client tool_search tools[${namespaceIndex}]`);
      if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
        throw unsupportedFeature(`Responses client tool_search tools[${namespaceIndex}] 缺少 parameters 对象`);
      }
      const alias = allocateAdaptedToolAlias('tool_search', 'tool_search', usedNames, namespaceIndex);
      if (aliases.some((entry) => entry.kind === 'tool_search')) throw unsupportedFeature('Responses client tool_search 只能声明一次');
      aliases.push({ alias, kind: 'tool_search' });
      flattened.push({ name: alias, description: tool.description, schema: tool.parameters });
      continue;
    }
    if (tool?.type === 'tool_search') {
      assertKnownObjectKeys(tool, new Set(['type', 'execution']), `Responses tool_search tools[${namespaceIndex}]`);
      if (tool.execution !== undefined && tool.execution !== 'server') {
        throw unsupportedFeature(`Responses tool_search tools[${namespaceIndex}] 包含不支持的 execution：${tool.execution}`);
      }
      // 已声明的 deferred function/namespace 会在跨协议时直接展开，因此无需让非 Responses 上游执行托管搜索。
      continue;
    }
    if (tool?.type !== 'namespace') {
      unsupportedTypes.push(tool?.type || 'unknown');
      continue;
    }
    if (typeof tool.name !== 'string' || !tool.name || !Array.isArray(tool.tools)) {
      throw unsupportedFeature(`Responses namespace tools[${namespaceIndex}] 缺少有效 name 或 tools 数组`);
    }
    assertKnownObjectKeys(tool, new Set(['type', 'name', 'description', 'tools', 'defer_loading']), `Responses namespace tools[${namespaceIndex}]`);
    optionalBoolean(tool.defer_loading, `Responses namespace tools[${namespaceIndex}].defer_loading`);
    if (namespaceNames.has(tool.name)) throw unsupportedFeature(`Responses namespace 名称重复：${tool.name}`);
    namespaceNames.add(tool.name);
    for (let toolIndex = 0; toolIndex < tool.tools.length; toolIndex++) {
      const child = tool.tools[toolIndex];
      const label = `Responses namespace ${tool.name}.tools[${toolIndex}]`;
      validResponsesFunction(child, label);
      if (rejectUnsupported) assertResponsesToolDirectCallable(child, label);
      const childIdentity = `${tool.name}\n${child.name}`;
      if (namespaceChildren.has(childIdentity)) throw unsupportedFeature(`Responses namespace ${tool.name} 的 function tool 名称重复：${child.name}`);
      namespaceChildren.add(childIdentity);
      const alias = allocateChatToolAlias(tool.name, child.name, usedNames, namespaceIndex, toolIndex);
      aliases.push({ alias, namespace: tool.name, name: child.name });
      const namespaceDescription = [
        `[Responses namespace: ${tool.name}]`,
        tool.description,
        responsesPortableToolDescription(child)
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

function responsesRequestForGeminiSearch(body) {
  const merged = mergeResponsesTools(body.tools, body.input);
  const searches = merged.filter((tool) => RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type));
  if (!searches.length) return { body, googleSearch: false };
  if (searches.length > 1) throw unsupportedFeature('跨协议转换到 Gemini 时 Responses web_search 工具只能声明一次');
  const search = searches[0];
  const unsupported = Object.keys(search).filter((key) => key !== 'type');
  if (unsupported.length) {
    throw unsupportedFeature(`Gemini googleSearch 无法表达 Responses web_search 配置：${unsupported.join(', ')}`);
  }
  const choice = body.tool_choice;
  if (choice === 'required' || choice?.type === 'allowed_tools' || RESPONSES_WEB_SEARCH_TOOL_TYPES.has(choice?.type)) {
    throw unsupportedFeature('Gemini googleSearch 无法保证 Responses 的强制/限定 web_search 工具选择；请改用 tool_choice=auto');
  }
  const enabled = choice === undefined || choice === null || choice === 'auto';
  const filterTools = (tools) => Array.isArray(tools)
    ? tools.filter((tool) => !RESPONSES_WEB_SEARCH_TOOL_TYPES.has(tool?.type))
    : tools;
  const input = Array.isArray(body.input) ? body.input.map((item) => item?.type === 'tool_search_output' && Array.isArray(item.tools)
    ? { ...item, tools: filterTools(item.tools) }
    : item) : body.input;
  return {
    body: { ...body, tools: filterTools(body.tools), ...(Array.isArray(body.input) ? { input } : {}) },
    googleSearch: enabled
  };
}

export function responsesToolAdaptations(tools, input, toolChoice) {
  const source = mergeResponsesTools(tools, input);
  let activeSource = source;
  if (toolChoice?.type === 'allowed_tools') {
    try { activeSource = selectResponsesAllowedTools(toolChoice, source)?.tools || source; }
    catch { /* 具体结构错误由请求转换路径返回，标记函数保持无副作用。 */ }
  }
  const definitions = activeSource.flatMap((tool) => tool?.type === 'namespace' ? asArray(tool.tools) : [tool]);
  return [
    ...(activeSource.some((tool) => tool?.type === 'custom') ? ['custom'] : []),
    ...(activeSource.some((tool) => tool?.type === 'tool_search' && tool.execution === 'client') ? ['client_tool_search'] : []),
    ...(activeSource.some((tool) => tool?.type === 'tool_search' && tool.execution !== 'client') ? ['hosted_tool_search'] : []),
    ...(toolChoice?.type === 'allowed_tools' ? ['allowed_tools_filtered'] : []),
    ...(activeSource.some((tool) => tool?.type === 'programmatic_tool_calling') ? ['programmatic_tool_calling_disabled'] : []),
    ...(definitions.some((tool) => tool?.output_schema !== undefined) ? ['output_schema_to_description'] : []),
    ...(definitions.some((tool) => Array.isArray(tool?.allowed_callers) && tool.allowed_callers.includes('direct')
      && tool.allowed_callers.includes('programmatic')) ? ['allowed_callers_direct_only'] : [])
  ];
}

export function hasOpaqueResponsesReasoningInput(input) {
  return asArray(input).some((item) => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content);
}

function geminiThoughtSignature(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const camel = part.thoughtSignature;
  const snake = part.thought_signature;
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw unsupportedFeature('Gemini Part 的 thoughtSignature 与 thought_signature 不能冲突');
  }
  const signature = camel ?? snake;
  if (signature !== undefined && (typeof signature !== 'string' || !signature)) {
    throw unsupportedFeature('Gemini Part 的 thoughtSignature 必须是非空字符串');
  }
  return signature;
}

export function inputRequestDegradations(body, incomingProtocol, targetProtocol) {
  if (incomingProtocol === targetProtocol) return [];
  const degradations = [];
  if (incomingProtocol === 'responses' && body?.client_metadata !== undefined) {
    degradations.push('responses_client_metadata');
  }
  if (incomingProtocol === 'responses') {
    const instructionItems = Array.isArray(body?.instructions) ? body.instructions : [];
    const inputItems = Array.isArray(body?.input) ? body.input : [];
    if ([...instructionItems, ...inputItems].some((item) => item && typeof item === 'object' && !Array.isArray(item)
      && ((item.id !== undefined && item.id !== null) || (item.status !== undefined && item.status !== null)))) {
      degradations.push('responses_item_metadata');
    }
  }
  if (incomingProtocol === 'responses' && asArray(body?.input).some((item) => item?.type === 'reasoning'
    && typeof item.encrypted_content === 'string' && item.encrypted_content
    && decodeReasoningState(item.encrypted_content)?.protocol !== targetProtocol)) {
    degradations.push('encrypted_reasoning');
  }
  if (incomingProtocol === 'responses' && targetProtocol !== 'responses' && asArray(body?.input).some((item) =>
    item?.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content)) {
    degradations.push('responses_compaction_state');
  }
  const geminiContents = [...asArray(body?.contents), ...(body?.systemInstruction ? [body.systemInstruction] : [])];
  if (incomingProtocol === 'gemini' && geminiContents.some((content) =>
    asArray(content?.parts).some((part) => {
      const signature = geminiThoughtSignature(part);
      return typeof signature === 'string' && decodeReasoningState(signature)?.protocol !== targetProtocol;
    }))) {
    degradations.push('gemini_thought_signature');
  }
  const claudeBlocks = asArray(body?.messages).flatMap((message) => asArray(message?.content));
  if (incomingProtocol === 'claude' && claudeBlocks.some((part) =>
    part?.type === 'thinking' && typeof part.signature === 'string' && part.signature
    && decodeReasoningState(part.signature)?.protocol !== targetProtocol)) {
    degradations.push('claude_thinking_signature');
  }
  if (incomingProtocol === 'claude' && claudeBlocks.some((part) =>
    part?.type === 'redacted_thinking' && typeof part.data === 'string' && part.data
    && decodeReasoningState(part.data)?.protocol !== targetProtocol)) {
    degradations.push('claude_redacted_thinking');
  }
  if (incomingProtocol === 'claude' && targetProtocol !== 'claude' && claudeBlocks.some((part) =>
    part?.type === 'compaction' && typeof part.encrypted_content === 'string' && part.encrypted_content)) {
    degradations.push('claude_compaction_encrypted_content');
  }
  if (incomingProtocol === 'chat' && asArray(body?.messages).some((message) =>
    asArray(message?.reasoning_details).some((detail) => {
      const encoded = detail?.data ?? detail?.signature;
      return typeof encoded === 'string' && encoded
        && decodeReasoningState(encoded)?.protocol !== targetProtocol;
    }))) {
    degradations.push('chat_reasoning_state');
  }
  return degradations;
}

function createResponsesAliasIndex(aliases) {
  const byAlias = new Map();
  const byNamespace = new Map();
  const byKind = new Map();
  const uniqueChildByName = new Map();
  for (const entry of aliases) {
    byAlias.set(entry.alias, entry);
    if (entry.kind) {
      let names = byKind.get(entry.kind);
      if (!names) {
        names = new Map();
        byKind.set(entry.kind, names);
      }
      names.set(entry.kind === 'tool_search' ? '' : entry.name, entry.alias);
      continue;
    }
    let names = byNamespace.get(entry.namespace);
    if (!names) {
      names = new Map();
      byNamespace.set(entry.namespace, names);
    }
    names.set(entry.name, entry.alias);
    uniqueChildByName.set(entry.name, uniqueChildByName.has(entry.name) ? null : entry);
  }
  return { byAlias, byNamespace, byKind, uniqueChildByName };
}

function responsesToolAlias(namespace, name, aliasIndex) {
  if (!namespace) return name;
  return aliasIndex.byNamespace.get(namespace)?.get(name)
    || `${sanitizedChatToolName(namespace, 'namespace')}__${sanitizedChatToolName(name)}`.slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
}

function adaptedResponsesToolAlias(kind, name, aliasIndex) {
  return aliasIndex.byKind.get(kind)?.get(kind === 'tool_search' ? '' : name)
    || sanitizedChatToolName(name, kind).slice(0, CHAT_TOOL_NAME_MAX_LENGTH);
}

export function createResponsesToolIdentityResolver(tools) {
  const compatibility = responsesToolCompatibility(tools, { rejectUnsupported: false });
  const aliasIndex = createResponsesAliasIndex(compatibility.aliases);
  const directNames = new Set(asArray(tools).filter((tool) => tool?.type === 'function').map((tool) => tool.name));
  return (chatName) => {
    const exact = aliasIndex.byAlias.get(chatName);
    if (exact?.kind === 'custom') return { kind: 'custom', name: exact.name };
    if (exact?.kind === 'tool_search') return { kind: 'tool_search' };
    if (exact) return { namespace: exact.namespace, name: exact.name };
    const child = aliasIndex.uniqueChildByName.get(chatName);
    if (!directNames.has(chatName) && child) return { namespace: child.namespace, name: child.name };
    return { name: chatName };
  };
}

export function resolveResponsesToolIdentity(chatName, tools) {
  return createResponsesToolIdentityResolver(tools)(chatName);
}

export function detectProtocol(path) {
  if (path.endsWith('/messages/count_tokens')) return 'claude';
  if (path.endsWith('/messages')) return 'claude';
  if (path.endsWith('/responses/compact')) return 'responses';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (/\/models\/.+:(?:generateContent|streamGenerateContent)$/.test(path)) return 'gemini';
  return null;
}

export function upstreamProtocol(model, route = {}, provider = 'zen') {
  if (route.protocol && route.protocol !== 'auto') return route.protocol;
  const id = model.trim().toLowerCase();
  const capability = openCodeModelCapability(provider, id);
  if (capability) return capability.protocol;
  if (provider === 'zen' && id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('gpt-oss')) return 'chat';
  if (/^(gpt-|o(?:1|3|4)(?:-|$))/.test(id)) return 'responses';
  if (/^(claude-|qwen3\.[567])/.test(id)) return 'claude';
  if (provider === 'go' && id.startsWith('minimax-m')) return 'claude';
  return 'chat';
}

function normalizedParallelToolCalls(body, protocol) {
  if (protocol === 'claude') {
    const disabled = body.tool_choice?.disable_parallel_tool_use;
    const validated = optionalBoolean(disabled, 'Claude tool_choice.disable_parallel_tool_use');
    return validated === undefined ? undefined : !validated;
  }
  if (protocol === 'responses') return optionalBoolean(body.parallel_tool_calls, 'Responses parallel_tool_calls');
  if (protocol === 'chat') return optionalBoolean(body.parallel_tool_calls, 'Chat parallel_tool_calls');
  return undefined;
}

function normalizedMaxTokens(body, protocol) {
  if (protocol === 'claude') return optionalInteger(body.max_tokens, 'Claude max_tokens', { minimum: 1 });
  if (protocol === 'responses') return optionalInteger(body.max_output_tokens, 'Responses max_output_tokens', { minimum: 1 });
  if (protocol !== 'chat') return undefined;
  const hasMaxTokens = body.max_tokens !== undefined && body.max_tokens !== null;
  const hasMaxCompletionTokens = body.max_completion_tokens !== undefined && body.max_completion_tokens !== null;
  if (hasMaxTokens && hasMaxCompletionTokens) {
    throw unsupportedFeature('Chat max_tokens 与 max_completion_tokens 不能同时用于跨协议转换');
  }
  return optionalInteger(hasMaxCompletionTokens ? body.max_completion_tokens : body.max_tokens, 'Chat 输出 token 上限', { minimum: 1 });
}

function normalizedTemperature(body, protocol) {
  if (!['claude', 'responses', 'chat'].includes(protocol)) return undefined;
  const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat' }[protocol];
  return rangedNumber(body.temperature, `${label} temperature`, { minimum: 0, maximum: protocol === 'claude' ? 1 : 2 });
}

function normalizedTopP(body, protocol) {
  if (!['claude', 'responses', 'chat'].includes(protocol)) return undefined;
  const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat' }[protocol];
  return rangedNumber(body.top_p, `${label} top_p`, { minimum: 0, maximum: 1 });
}

function validateRequestContainerShapes(body, protocol) {
  if (protocol === 'claude') {
    if (!Array.isArray(body.messages)) throw unsupportedFeature('Claude messages 必须是数组');
    if (body.tools !== undefined && !Array.isArray(body.tools)) throw unsupportedFeature('Claude tools 必须是数组');
    if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) {
      throw unsupportedFeature('Claude system 必须是字符串或文本块数组');
    }
    return;
  }
  if (protocol === 'responses') {
    if (body.input !== undefined && body.input !== null && typeof body.input !== 'string' && !Array.isArray(body.input)) {
      throw unsupportedFeature('Responses input 必须是字符串或输入项数组');
    }
    if (body.tools !== undefined && !Array.isArray(body.tools)) throw unsupportedFeature('Responses tools 必须是数组');
    return;
  }
  if (protocol === 'chat') {
    if (!Array.isArray(body.messages)) throw unsupportedFeature('Chat messages 必须是数组');
    if (body.tools !== undefined && !Array.isArray(body.tools)) throw unsupportedFeature('Chat tools 必须是数组');
  }
}

function normalizedStopSequences(body, protocol) {
  const value = protocol === 'claude' ? body.stop_sequences : ['chat', 'responses'].includes(protocol) ? body.stop : undefined;
  if (value === undefined || value === null) return undefined;
  const label = protocol === 'claude' ? 'Claude stop_sequences' : `${protocol === 'chat' ? 'Chat' : 'Responses 扩展'} stop`;
  if (protocol === 'claude' && !Array.isArray(value)) throw unsupportedFeature(`${label} 必须是字符串数组`);
  if (protocol !== 'claude' && typeof value !== 'string' && !Array.isArray(value)) {
    throw unsupportedFeature(`${label} 必须是字符串或字符串数组`);
  }
  const sequences = typeof value === 'string' ? [value] : value;
  if (sequences.some((sequence) => typeof sequence !== 'string')) throw unsupportedFeature(`${label} 只能包含字符串`);
  if (protocol !== 'claude' && sequences.length > 4) throw unsupportedFeature(`${label} 最多支持 4 个停止序列`);
  return sequences;
}

function normalizedMetadata(body, protocol) {
  if (body.metadata === undefined || body.metadata === null) return undefined;
  const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat' }[protocol] || '请求';
  return objectValue(body.metadata, `${label} metadata`);
}

export function normalizeRequest(body, protocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat', gemini: 'Gemini' }[protocol] || '请求';
    throw unsupportedFeature(`${label} 请求体必须是 JSON 对象`);
  }
  validateCrossProtocolRequestFields(body, protocol);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat', gemini: 'Gemini' }[protocol] || '请求';
    throw unsupportedFeature(`${label} stream 必须是布尔值`);
  }
  validateRequestContainerShapes(body, protocol);
  const normalized = {
    model: body.model,
    stream: body.stream === true,
    includeObfuscation: ['responses', 'chat'].includes(protocol)
      ? body.stream_options?.include_obfuscation
      : undefined,
    system: '',
    systemMessages: [],
    messages: [],
    tools: [],
    maxTokens: normalizedMaxTokens(body, protocol),
    temperature: normalizedTemperature(body, protocol),
    topP: normalizedTopP(body, protocol),
    stop: normalizedStopSequences(body, protocol),
    toolChoice: normalizeToolChoice(body.tool_choice, protocol),
    parallelToolCalls: normalizedParallelToolCalls(body, protocol),
    reasoningEffort: ['gemini', 'responses', 'claude'].includes(protocol) ? undefined : resolveReasoningEffort(body, protocol),
    reasoningSummary: undefined,
    reasoningControl: undefined,
    contextControl: undefined,
    metadata: normalizedMetadata(body, protocol),
    serviceTier: ['responses', 'chat'].includes(protocol)
      ? optionalOpenAiEnum(body.service_tier, `${protocol === 'responses' ? 'Responses' : 'Chat'} service_tier`, OPENAI_SERVICE_TIERS)
      : undefined,
    speed: protocol === 'claude'
      ? optionalOpenAiEnum(body.speed, 'Claude speed', CLAUDE_SPEEDS)
      : undefined,
    safetyIdentifier: ['responses', 'chat'].includes(protocol)
      ? optionalOpenAiString(body.safety_identifier, `${protocol === 'responses' ? 'Responses' : 'Chat'} safety_identifier`, { maximum: 64 })
      : undefined,
    user: ['responses', 'chat'].includes(protocol)
      ? optionalOpenAiString(body.user, `${protocol === 'responses' ? 'Responses' : 'Chat'} user`)
      : undefined,
    moderation: ['responses', 'chat'].includes(protocol) && body.moderation !== undefined && body.moderation !== null
      ? objectValue(body.moderation, `${protocol === 'responses' ? 'Responses' : 'Chat'} moderation`)
      : undefined,
    verbosity: protocol === 'responses'
      ? optionalOpenAiEnum(body.text?.verbosity, 'Responses text.verbosity', OPENAI_VERBOSITY_LEVELS)
      : protocol === 'chat'
        ? optionalOpenAiEnum(body.verbosity, 'Chat verbosity', OPENAI_VERBOSITY_LEVELS)
        : undefined,
    responsesWebSearch: undefined
  };
  const claudeToolReferences = new Set();
  NORMALIZED_CLAUDE_TOOL_REFERENCES.set(normalized, claudeToolReferences);

  if (protocol === 'gemini') {
    const topLevelKeys = new Set(['model', 'stream', 'contents', 'systemInstruction', 'tools', 'toolConfig', 'safetySettings', 'generationConfig', 'cachedContent']);
    const unsupportedTopLevel = Object.keys(body).filter((key) => !topLevelKeys.has(key));
    if (unsupportedTopLevel.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini 请求字段：${unsupportedTopLevel.join(', ')}`);
    if (!Array.isArray(body.contents) || body.contents.length === 0) throw unsupportedFeature('Gemini contents 必须是非空数组');
    if (body.systemInstruction !== undefined) objectValue(body.systemInstruction, 'Gemini systemInstruction');
    if (body.tools !== undefined && !Array.isArray(body.tools)) throw unsupportedFeature('Gemini tools 必须是数组');
    if (body.safetySettings !== undefined && !Array.isArray(body.safetySettings)) throw unsupportedFeature('Gemini safetySettings 必须是数组');
    if (body.toolConfig !== undefined) {
      const toolConfig = objectValue(body.toolConfig, 'Gemini toolConfig');
      const unsupportedToolConfig = Object.keys(toolConfig).filter((key) => key !== 'functionCallingConfig');
      if (unsupportedToolConfig.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini toolConfig 字段：${unsupportedToolConfig.join(', ')}`);
      if (toolConfig.functionCallingConfig !== undefined) {
        const functionCallingConfig = objectValue(toolConfig.functionCallingConfig, 'Gemini functionCallingConfig');
        const unsupportedFunctionConfig = Object.keys(functionCallingConfig).filter((key) => !['mode', 'allowedFunctionNames', 'streamFunctionCallArguments'].includes(key));
        if (unsupportedFunctionConfig.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini functionCallingConfig 字段：${unsupportedFunctionConfig.join(', ')}`);
        if (functionCallingConfig.allowedFunctionNames !== undefined && !Array.isArray(functionCallingConfig.allowedFunctionNames)) {
          throw unsupportedFeature('Gemini allowedFunctionNames 必须是数组');
        }
        if (functionCallingConfig.streamFunctionCallArguments !== undefined && typeof functionCallingConfig.streamFunctionCallArguments !== 'boolean') {
          throw unsupportedFeature('Gemini streamFunctionCallArguments 必须是布尔值');
        }
        if (functionCallingConfig.streamFunctionCallArguments === true && body.stream !== true) {
          throw unsupportedFeature('Gemini streamFunctionCallArguments=true 只能用于 streamGenerateContent');
        }
      }
    }
    const generation = body.generationConfig == null ? {} : objectValue(body.generationConfig, 'Gemini generationConfig');
    const unsupportedGeneration = Object.keys(generation).filter((key) => !GEMINI_GENERATION_KEYS.has(key));
    if (unsupportedGeneration.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini generationConfig 字段：${unsupportedGeneration.join(', ')}`);
    if (generation.candidateCount != null && generation.candidateCount !== 1) throw unsupportedFeature('跨协议转换仅支持 Gemini candidateCount=1');
    if (Array.isArray(generation.responseModalities) && (generation.responseModalities.length !== 1 || generation.responseModalities[0] !== 'TEXT')) {
      throw unsupportedFeature('跨协议转换仅支持 Gemini TEXT 响应模态');
    }
    if (generation.responseModalities !== undefined && !Array.isArray(generation.responseModalities)) throw unsupportedFeature('Gemini responseModalities 必须是数组');
    if (body.safetySettings?.length) throw unsupportedFeature('跨协议转换暂不支持 Gemini safetySettings');
    if (generation.stopSequences !== undefined && !Array.isArray(generation.stopSequences)) throw unsupportedFeature('Gemini stopSequences 必须是数组');
    if (generation.stopSequences?.some((value) => typeof value !== 'string')) throw unsupportedFeature('Gemini stopSequences 只能包含字符串');
    normalized.maxTokens = integer(generation.maxOutputTokens, 'Gemini maxOutputTokens', { minimum: 1 });
    normalized.temperature = rangedNumber(generation.temperature, 'Gemini temperature', { minimum: 0, maximum: 2 });
    normalized.topP = rangedNumber(generation.topP, 'Gemini topP', { minimum: 0, maximum: 1 });
    normalized.topK = integer(generation.topK, 'Gemini topK', { minimum: 1 });
    normalized.seed = integer(generation.seed, 'Gemini seed');
    normalized.presencePenalty = rangedNumber(generation.presencePenalty, 'Gemini presencePenalty', { minimum: -2, maximum: 2 });
    normalized.frequencyPenalty = rangedNumber(generation.frequencyPenalty, 'Gemini frequencyPenalty', { minimum: -2, maximum: 2 });
    normalized.reasoningControl = normalizeGeminiThinkingConfig(generation.thinkingConfig);
    normalized.reasoningEffort = normalized.reasoningControl?.effort;
    normalized.reasoningSummary = normalized.reasoningControl?.includeThoughts === true && normalized.reasoningEffort !== 'none' ? 'auto' : undefined;
    if (generation.responseLogprobs !== undefined && typeof generation.responseLogprobs !== 'boolean') throw unsupportedFeature('Gemini responseLogprobs 必须是布尔值');
    if (generation.logprobs !== undefined && generation.responseLogprobs !== true) throw unsupportedFeature('Gemini logprobs 需要同时设置 responseLogprobs=true');
    normalized.topLogprobs = generation.responseLogprobs === true
      ? integer(generation.logprobs ?? 0, 'Gemini logprobs', { minimum: 0, maximum: 20 })
      : undefined;
    normalized.outputFormat = normalizeGeminiOutputFormat(generation);
    normalized.stop = generation.stopSequences;
    const systemParts = normalizeGeminiParts(body.systemInstruction?.parts, { rejectUnknown: true });
    if (systemParts.some((part) => part.type !== 'text')) throw unsupportedFeature('Gemini systemInstruction 仅支持文本 Part');
    let hasGeminiSystemText = false;
    normalized.systemMessages = systemParts.flatMap((part) => {
      if (!part.text) return [];
      const text = `${hasGeminiSystemText ? '\n' : ''}${part.text}`;
      hasGeminiSystemText = true;
      return [{ text, role: 'system' }];
    });
    normalized.system = normalized.systemMessages.map((item) => item.text).join('');
    const explicitGeminiCallIds = new Set(asArray(body.contents).flatMap((content) => asArray(content?.parts))
      .map((part) => (part?.functionCall || part?.function_call)?.id)
      .filter((id) => typeof id === 'string' && id));
    const geminiToolCallTracker = createGeminiToolCallTracker(explicitGeminiCallIds);
    normalized.messages = asArray(body.contents).map((content, index) => {
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw unsupportedFeature(`Gemini contents[${index}] 必须是对象`);
      if (content?.role && !['user', 'model'].includes(content.role)) throw unsupportedFeature(`不支持 Gemini Content role：${content.role}`);
      const rawParts = asArray(content.parts);
      if (content.role === 'model' && rawParts.some((part) => part?.functionResponse || part?.function_response)) {
        throw unsupportedFeature(`Gemini contents[${index}] 的 model role 不能包含 functionResponse Part`);
      }
      const parts = normalizeGeminiParts(content.parts, { rejectUnknown: true, toolCallTracker: geminiToolCallTracker });
      if (!parts.length) throw unsupportedFeature(`Gemini contents[${index}].parts 必须是非空数组`);
      if (content.role !== 'model' && parts.some((part) => part.type === 'reasoning')) {
        throw unsupportedFeature(`Gemini contents[${index}] 只有 model role 可以包含 thought Part`);
      }
      if (content.role !== 'model' && parts.some((part) => part.type === 'tool_call')) {
        throw unsupportedFeature(`Gemini contents[${index}] 只有 model role 可以包含 functionCall Part`);
      }
      return { role: content.role === 'model' ? 'assistant' : 'user', parts };
    });
    const geminiToolNames = new Set();
    normalized.tools = asArray(body.tools).flatMap((tool, groupIndex) => {
      if (!tool || Array.isArray(tool) || typeof tool !== 'object') throw unsupportedFeature(`Gemini tools[${groupIndex}] 必须是对象`);
      const unsupportedToolFields = Object.keys(tool).filter((key) => !['functionDeclarations', 'googleSearch'].includes(key));
      if (unsupportedToolFields.length) {
        throw unsupportedFeature(`跨协议转换暂不支持 Gemini 内置工具或工具字段：${unsupportedToolFields.join(', ')}`);
      }
      if (tool.functionDeclarations !== undefined && !Array.isArray(tool.functionDeclarations)) {
        throw unsupportedFeature(`Gemini tools[${groupIndex}].functionDeclarations 必须是数组`);
      }
      return asArray(tool.functionDeclarations);
    }).map((tool, index) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !tool.name) {
        throw unsupportedFeature(`Gemini functionDeclarations[${index}] 缺少有效 name`);
      }
      validGeminiFunctionName(tool.name, `Gemini functionDeclarations[${index}].name`);
      if (geminiToolNames.has(tool.name)) throw unsupportedFeature(`Gemini functionDeclarations 工具名称重复：${tool.name}`);
      geminiToolNames.add(tool.name);
      const unsupported = Object.keys(tool).filter((key) => ![
        'name', 'description', 'parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema'
      ].includes(key));
      if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini functionDeclarations[${index}] 字段：${unsupported.join(', ')}`);
      if (tool.description !== undefined && typeof tool.description !== 'string') {
        throw unsupportedFeature(`Gemini functionDeclarations[${index}].description 必须是字符串`);
      }
      if (tool.parameters !== undefined && tool.parametersJsonSchema !== undefined) {
        throw unsupportedFeature(`Gemini functionDeclarations[${index}] 不能同时设置 parameters 和 parametersJsonSchema`);
      }
      if (tool.response !== undefined && tool.responseJsonSchema !== undefined) {
        throw unsupportedFeature(`Gemini functionDeclarations[${index}] 不能同时设置 response 和 responseJsonSchema`);
      }
      for (const field of ['parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema']) {
        if (tool[field] !== undefined && (!tool[field] || typeof tool[field] !== 'object' || Array.isArray(tool[field]))) {
          throw unsupportedFeature(`Gemini functionDeclarations[${index}].${field} 必须是 JSON Schema 对象`);
        }
      }
      return {
        name: tool.name,
        description: geminiPortableToolDescription(tool),
        schema: tool.parametersJsonSchema || tool.parameters || {}
      };
    });
    normalized.responsesWebSearch = normalizeGeminiGoogleSearch(body.tools);
    const geminiToolChoice = normalizeGeminiToolChoice(body.toolConfig?.functionCallingConfig, normalized.tools);
    normalized.toolChoice = geminiToolChoice.choice;
    normalized.tools = geminiToolChoice.tools;
    if (body.cachedContent) throw unsupportedFeature('跨协议转换暂不支持 Gemini cachedContent');
    return normalized;
  }

  if (protocol === 'claude') {
    normalized.promptCacheSource = 'claude';
    normalized.cacheControl = validatedClaudeCacheControl(body.cache_control, 'Claude cache_control');
    normalized.reasoningControl = normalizeClaudeReasoning(body);
    normalized.contextControl = normalizeClaudeContextManagement(body.context_management);
    normalized.reasoningEffort = normalized.reasoningControl?.effort;
    normalized.reasoningSummary = normalized.reasoningControl?.summary;
    normalized.topK = optionalInteger(body.top_k, 'Claude top_k', { minimum: 1 });
    normalized.outputFormat = body.output_config?.format
      ? normalizeOpenAiOutputFormat(body.output_config.format, 'Claude')
      : undefined;
    if (Array.isArray(body.system)) {
      validateMessageContentRole(body.system, 'Claude system', 'system', CLAUDE_MESSAGE_BLOCKS);
      for (const [index, item] of body.system.entries()) {
        if (typeof item !== 'string' && typeof item?.text !== 'string') {
          throw unsupportedFeature(`Claude system[${index}].text 必须是字符串`);
        }
      }
    }
    let hasClaudeSystemText = false;
    normalized.systemMessages = asArray(body.system).flatMap((item, index) => {
      const rawText = stripLeadingBillingHeader(claudeSystemBlockText(item));
      if (!rawText) return [];
      const text = `${hasClaudeSystemText ? '\n' : ''}${rawText}`;
      hasClaudeSystemText = true;
      return [{
        text, role: 'system',
        ...(item?.cache_control ? { cacheControl: validatedClaudeCacheControl(item.cache_control, `Claude system[${index}].cache_control`) } : {})
      }];
    });
    normalized.system = normalized.systemMessages.map((item) => item.text).join('');
    normalized.messages = asArray(body.messages).map((message, index) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw unsupportedFeature(`Claude messages[${index}] 必须是对象`);
      assertKnownObjectKeys(message, new Set(['role', 'content']), `Claude messages[${index}]`);
      if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) {
        throw unsupportedFeature(`Claude messages[${index}] 包含不支持的 role：${message.role || 'unknown'}`);
      }
      const contentLabel = `Claude messages[${index}].content`;
      validateMessageContent(message.content, contentLabel);
      const hasDroppedOpaqueReasoning = validateMessageContentRole(
        message.content, contentLabel, message.role, CLAUDE_MESSAGE_BLOCKS
      );
      const parts = normalizeParts(message.content, {
        includeReasoning: true, dropOpaqueReasoning: true, rejectUnknown: true, claudeToolReferences
      });
      let hasPortablePayload = false;
      for (const [partIndex, part] of parts.entries()) {
        if (part.cacheControl) {
          part.cacheControl = validatedClaudeCacheControl(part.cacheControl, `${contentLabel}[${partIndex}].cache_control`);
        }
        if (isPortableMessagePart(part)) hasPortablePayload = true;
      }
      if (!hasPortablePayload && !hasDroppedOpaqueReasoning) {
        throw unsupportedFeature(`${contentLabel} 不能只包含空内容块`);
      }
      return {
        role: isClaudeMidTurnUserMessage(message) ? 'user' : message.role,
        parts
      };
    });
    const unsupportedTools = asArray(body.tools).filter((tool) => tool?.type);
    if (unsupportedTools.length) {
      const types = [...new Set(unsupportedTools.map((tool) => tool.type))].join(', ');
      throw unsupportedFeature(`跨协议转换不能将 Claude typed/server tool 伪装成普通 function：${types}；请将模型路由设为 claude`);
    }
    const toolNames = new Set();
    normalized.tools = asArray(body.tools).map((tool, index) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !tool.name) {
        throw unsupportedFeature(`Claude tools[${index}] 缺少有效 name`);
      }
      if (toolNames.has(tool.name)) throw unsupportedFeature(`Claude 工具名称重复：${tool.name}`);
      toolNames.add(tool.name);
      const unsupported = Object.keys(tool).filter((key) => !CLAUDE_TOOL_KEYS.has(key));
      if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Claude tools[${index}] 字段：${unsupported.join(', ')}`);
      validateClaudeToolOptionalFields(tool, index, (message) => { throw unsupportedFeature(message); });
      return {
        name: tool.name, description: tool.description, schema: tool.input_schema || {},
        ...(tool.cache_control ? { cacheControl: tool.cache_control } : {}),
        ...(tool.defer_loading === true ? { deferLoading: true } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        ...(tool.allowed_callers !== undefined ? { allowedCallers: tool.allowed_callers } : {}),
        ...(tool.input_examples !== undefined ? { inputExamples: tool.input_examples } : {}),
        ...(tool.eager_input_streaming !== undefined ? { eagerInputStreaming: tool.eager_input_streaming } : {})
      };
    });
  } else if (protocol === 'responses') {
    const text = body.text == null ? {} : objectValue(body.text, 'Responses text');
    assertKnownObjectKeys(text, new Set(['format', 'verbosity']), 'Responses text');
    validateResponsesClientMetadata(body.client_metadata);
    normalized.promptCacheSource = 'responses';
    normalized.responsesPromptCache = validatedResponsesPromptCacheOptions(body.prompt_cache_options);
    normalized.responsesPromptCacheKey = validatedResponsesPromptCacheKey(body.prompt_cache_key);
    normalized.responsesPromptCacheRetention = validatedResponsesPromptCacheRetention(body.prompt_cache_retention);
    normalized.reasoningControl = normalizeResponsesReasoning(body.reasoning);
    normalized.reasoningEffort = normalized.reasoningControl?.effort;
    normalized.reasoningSummary = normalized.reasoningControl?.summary;
    normalized.topLogprobs = body.top_logprobs == null
      ? undefined
      : integer(body.top_logprobs, 'Responses top_logprobs', { minimum: 0, maximum: 20 });
    normalized.outputFormat = normalizeOpenAiOutputFormat(text.format, 'Responses');
    normalized.systemMessages = responsesInstructionMessages(body.instructions);
    normalized.system = normalized.systemMessages.map((item) => item.text).join('');
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : asArray(body.input);
    if (body.tool_choice === 'programmatic_tool_calling' || body.tool_choice?.type === 'programmatic_tool_calling') {
      throw unsupportedFeature('跨协议转换无法强制选择 Responses programmatic_tool_calling；请将模型路由设为 responses');
    }
    const mergedTools = mergeResponsesTools(body.tools, input);
    const allowedTools = selectResponsesAllowedTools(body.tool_choice, mergedTools);
    let compatibility;
    let historyCompatibility;
    let historyAliasIndex;
    if (allowedTools) {
      historyCompatibility = responsesToolCompatibility(mergedTools, { rejectUnsupported: false });
      historyAliasIndex = createResponsesAliasIndex(historyCompatibility.aliases);
      const selectedCompatibility = responsesToolCompatibility(allowedTools.tools);
      const selectedNames = selectedResponsesPortableToolNames(allowedTools.tools, historyAliasIndex);
      compatibility = {
        tools: historyCompatibility.tools.filter((tool) => selectedNames.has(tool.name)),
        aliases: historyCompatibility.aliases,
        droppedWebSearch: selectedCompatibility.droppedWebSearch
      };
    } else {
      compatibility = responsesToolCompatibility(mergedTools);
      historyCompatibility = compatibility;
      historyAliasIndex = createResponsesAliasIndex(historyCompatibility.aliases);
    }
    normalized.tools = compatibility.tools;
    if (compatibility.droppedWebSearch) appendNormalizedSystemText(normalized, WEB_SEARCH_COMPATIBILITY_NOTICE, '\n\n');
    if (allowedTools) {
      if (allowedTools.mode === 'required' && normalized.tools.length === 0) {
        throw unsupportedFeature('Responses allowed_tools 要求调用工具，但所选工具无法由非 Responses 上游执行；请将模型路由设为 responses');
      }
      normalized.toolChoice = normalized.tools.length
        ? { type: allowedTools.mode === 'required' ? 'any' : 'auto' }
        : { type: 'none' };
    } else if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.type === 'function') {
      normalized.toolChoice = { type: 'tool', name: responsesToolAlias(body.tool_choice.namespace, body.tool_choice.name, historyAliasIndex) };
    } else if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.type === 'custom') {
      normalized.toolChoice = { type: 'tool', name: adaptedResponsesToolAlias('custom', body.tool_choice.name, historyAliasIndex) };
    } else if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.type === 'tool_search') {
      normalized.toolChoice = { type: 'tool', name: adaptedResponsesToolAlias('tool_search', '', historyAliasIndex) };
    } else if (compatibility.droppedWebSearch && (body.tool_choice === 'required' || RESPONSES_WEB_SEARCH_TOOL_TYPES.has(body.tool_choice?.type))) {
      normalized.toolChoice = { type: 'auto' };
    }
    let conversationStarted = false;
    for (const [index, item] of input.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw unsupportedFeature(`Responses input[${index}] 必须是消息或输入项对象`);
      }
      validateResponsesInputItemKeys(item, index);
      if (item.prompt_cache_breakpoint !== undefined) {
        throw unsupportedFeature(`Responses input[${index}].prompt_cache_breakpoint 必须位于受支持的内容块上`);
      }
      if (['system', 'developer'].includes(item.role)) {
        validateMessageContent(item.content, `Responses input[${index}].content`);
        validateMessageContentRole(item.content, `Responses input[${index}].content`, item.role, RESPONSES_MESSAGE_BLOCKS);
        validateOpenAiContentPromptCache(item.content, `Responses input[${index}].content`);
        const parts = normalizeParts(item.content, { rejectUnknown: true });
        if (!hasPortableMessagePayload(parts)) throw unsupportedFeature(`Responses input[${index}].content 不能只包含空内容块`);
        const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
        if (text) {
          if (conversationStarted) normalized.messages.push({ role: item.role, parts });
          else appendNormalizedSystemParts(normalized, parts.filter((part) => part.type === 'text'), '\n', item.role);
        }
        continue;
      }
      conversationStarted = true;
      if (item.type === 'custom_tool_call') {
        if (typeof item.name !== 'string' || !item.name) throw unsupportedFeature(`Responses input[${index}] 的 custom_tool_call 缺少 name`);
        if (typeof item.input !== 'string') throw unsupportedFeature(`Responses input[${index}] 的 custom_tool_call.input 必须是字符串`);
        normalized.messages.push({ role: 'assistant', parts: [{
          type: 'tool_call', id: responsesInputCallId(item, `Responses input[${index}] custom_tool_call`),
          name: adaptedResponsesToolAlias('custom', item.name, historyAliasIndex), arguments: { [CUSTOM_TOOL_INPUT_FIELD]: item.input }
        }] });
      } else if (item.type === 'custom_tool_call_output') {
        const callId = requiredInputString(item.call_id, `Responses input[${index}] custom_tool_call_output.call_id`);
        if (item.output === undefined) throw unsupportedFeature(`Responses input[${index}] custom_tool_call_output 缺少 output`);
        normalized.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: callId, content: item.output }] });
      } else if (item.type === 'tool_search_call') {
        if (item.execution && item.execution !== 'client') throw unsupportedFeature(`跨协议转换仅支持 client tool_search_call，收到 execution=${item.execution}`);
        const argumentsValue = normalizedInputToolArguments(item.arguments, `Responses input[${index}] client tool_search_call.arguments`);
        normalized.messages.push({ role: 'assistant', parts: [{
          type: 'tool_call', id: responsesInputCallId(item, `Responses input[${index}] tool_search_call`),
          name: adaptedResponsesToolAlias('tool_search', '', historyAliasIndex), arguments: argumentsValue
        }] });
      } else if (item.type === 'tool_search_output') {
        if (item.execution && item.execution !== 'client') throw unsupportedFeature(`跨协议转换仅支持 client tool_search_output，收到 execution=${item.execution}`);
        if (!Array.isArray(item.tools)) throw unsupportedFeature(`Responses input[${index}] 的 client tool_search_output.tools 必须是数组`);
        normalized.messages.push({ role: 'user', parts: [{
          type: 'tool_result', id: requiredInputString(item.call_id, `Responses input[${index}] tool_search_output.call_id`),
          content: canonicalJsonString({ tools: asArray(item.tools) })
        }] });
      } else if (item.type === 'function_call') {
        if (item.caller !== undefined) {
          throw unsupportedFeature(`跨协议转换无法保留 Responses input[${index}] 的程序调用 caller 关联；请将模型路由设为 responses`);
        }
        if (item.namespace !== undefined && item.namespace !== null && (typeof item.namespace !== 'string' || !item.namespace)) {
          throw unsupportedFeature(`Responses input[${index}] function_call.namespace 必须是非空字符串`);
        }
        const name = requiredInputString(item.name, `Responses input[${index}] function_call.name`);
        normalized.messages.push({ role: 'assistant', parts: [{
          type: 'tool_call', id: responsesInputCallId(item, `Responses input[${index}] function_call`),
          name: responsesToolAlias(item.namespace, name, historyAliasIndex),
          arguments: normalizedInputToolArguments(item.arguments, `Responses input[${index}] function_call.arguments`)
        }] });
      } else if (item.type === 'function_call_output') {
        if (item.caller !== undefined) {
          throw unsupportedFeature(`跨协议转换无法保留 Responses input[${index}] 的程序结果 caller 关联；请将模型路由设为 responses`);
        }
        const callId = requiredInputString(item.call_id, `Responses input[${index}] function_call_output.call_id`);
        if (item.output === undefined) throw unsupportedFeature(`Responses input[${index}] function_call_output 缺少 output`);
        normalized.messages.push({ role: 'user', parts: [{ type: 'tool_result', id: callId, content: item.output }] });
      } else if (item.type === 'program' || item.type === 'program_output') {
        throw unsupportedFeature(`跨协议转换无法表达 Responses ${item.type} 程序运行项；请将模型路由设为 responses`);
      } else if (item.type === 'reasoning') {
        const parts = normalizedResponsesInputReasoning(item, index);
        if (parts.length) normalized.messages.push({ role: 'assistant', parts });
      } else if (item.type === 'compaction') {
        normalized.messages.push({ role: 'assistant', parts: [{
          type: 'provider_state',
          providerState: { protocol: 'responses', kind: 'compaction', value: item }
        }] });
      } else if (item.type && item.type !== 'message') {
        throw unsupportedFeature(`跨协议转换暂不支持 Responses 输入项类型：${item.type}`);
      } else {
        if (!['user', 'assistant'].includes(item.role)) throw unsupportedFeature(`Responses input[${index}] 包含不支持的 role：${item.role || 'unknown'}`);
        validateMessageContent(item.content, `Responses input[${index}].content`);
        validateMessageContentRole(item.content, `Responses input[${index}].content`, item.role, RESPONSES_MESSAGE_BLOCKS);
        validateOpenAiContentPromptCache(item.content, `Responses input[${index}].content`);
        const parts = normalizeParts(item.content, { rejectUnknown: true });
        if (!hasPortableMessagePayload(parts)) throw unsupportedFeature(`Responses input[${index}].content 不能只包含空内容块`);
        normalized.messages.push({ role: item.role || 'user', parts });
      }
    }
  } else {
    normalized.promptCacheSource = 'chat';
    normalized.responsesPromptCache = validatedResponsesPromptCacheOptions(body.prompt_cache_options);
    normalized.responsesPromptCacheKey = validatedResponsesPromptCacheKey(body.prompt_cache_key);
    normalized.responsesPromptCacheRetention = validatedResponsesPromptCacheRetention(body.prompt_cache_retention);
    normalized.seed = optionalInteger(body.seed, 'Chat seed');
    normalized.presencePenalty = rangedNumber(body.presence_penalty, 'Chat presence_penalty', { minimum: -2, maximum: 2 });
    normalized.frequencyPenalty = rangedNumber(body.frequency_penalty, 'Chat frequency_penalty', { minimum: -2, maximum: 2 });
    const logprobs = optionalBoolean(body.logprobs, 'Chat logprobs');
    if (body.top_logprobs != null && logprobs !== true) {
      throw unsupportedFeature('Chat top_logprobs 需要同时设置 logprobs=true');
    }
    normalized.topLogprobs = logprobs === true
      ? integer(body.top_logprobs ?? 0, 'Chat top_logprobs', { minimum: 0, maximum: 20 })
      : undefined;
    normalized.outputFormat = normalizeOpenAiOutputFormat(body.response_format, 'Chat');
    if (body.function_call !== undefined && body.tool_choice !== undefined) {
      throw unsupportedFeature('Chat function_call 不能与 tool_choice 同时用于跨协议转换');
    }
    if (body.function_call !== undefined) {
      if (typeof body.function_call === 'string') {
        if (!['none', 'auto'].includes(body.function_call)) throw unsupportedFeature(`不支持 Chat function_call：${body.function_call}`);
        normalized.toolChoice = { type: body.function_call };
      } else {
        const choice = objectValue(body.function_call, 'Chat function_call');
        const name = optionalOpenAiString(choice.name, 'Chat function_call.name');
        normalized.toolChoice = { type: 'tool', name };
      }
    }
    let conversationStarted = false;
    for (const [index, message] of asArray(body.messages).entries()) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw unsupportedFeature(`Chat messages[${index}] 必须是对象`);
      assertKnownObjectKeys(message, new Set([
        'role', 'content', 'name', 'audio', 'tool_calls', 'function_call', 'refusal',
        'reasoning_content', 'reasoning', 'reasoning_details', 'tool_call_id', 'prompt_cache_breakpoint',
        'cache_control'
      ]), `Chat messages[${index}]`);
      if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
        throw unsupportedFeature(`Chat messages[${index}] 包含不支持的 role：${message.role || 'unknown'}`);
      }
      if (message.prompt_cache_breakpoint !== undefined) {
        throw unsupportedFeature(`Chat messages[${index}].prompt_cache_breakpoint 必须位于受支持的内容块上`);
      }
      const messageCacheControl = message.cache_control === undefined
        ? undefined
        : validatedClaudeCacheControl(message.cache_control, `Chat messages[${index}].cache_control`);
      if (message.name !== undefined && message.name !== null) {
        throw unsupportedFeature(`跨协议转换无法保留 Chat messages[${index}].name 参与者身份；请移除 name 或将模型路由设为 chat`);
      }
      if (message.audio !== undefined && message.audio !== null) {
        throw unsupportedFeature(`跨协议转换无法保留 Chat messages[${index}].audio 历史音频；请重发可转换的文本内容或将模型路由设为 chat`);
      }
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
        throw unsupportedFeature(`Chat messages[${index}].tool_calls 必须是数组`);
      }
      for (const field of ['refusal', 'reasoning_content', 'reasoning']) {
        if (message[field] !== undefined && message[field] !== null && typeof message[field] !== 'string') {
          throw unsupportedFeature(`Chat messages[${index}].${field} 必须是字符串或 null`);
        }
      }
      if (message.reasoning_content != null && message.reasoning != null && message.reasoning_content !== message.reasoning) {
        throw unsupportedFeature(`Chat messages[${index}].reasoning_content 与 reasoning 不能冲突`);
      }
      const assistantOnlyFields = ['tool_calls', 'function_call', 'refusal', 'reasoning_content', 'reasoning', 'reasoning_details', 'audio'];
      const invalidAssistantField = assistantOnlyFields.find((field) => message[field] !== undefined && message[field] !== null && message.role !== 'assistant');
      if (invalidAssistantField) {
        throw unsupportedFeature(`Chat messages[${index}].${invalidAssistantField} 仅可用于 assistant 消息`);
      }
      if (message.tool_call_id !== undefined && message.tool_call_id !== null && message.role !== 'tool') {
        throw unsupportedFeature(`Chat messages[${index}].tool_call_id 仅可用于 tool 消息`);
      }
      const reasoningDetails = message.role === 'assistant'
        ? normalizedChatReasoningDetails(message.reasoning_details, { bridgeOnly: true })
        : [];
      const reasoning = message.reasoning_content ?? message.reasoning;
      const hasAssistantAlternative = message.role === 'assistant' && (
        asArray(message.tool_calls).length > 0
        || (message.function_call !== undefined && message.function_call !== null)
        || (typeof message.refusal === 'string' && message.refusal.length > 0)
        || (typeof reasoning === 'string' && reasoning.length > 0)
        || reasoningDetails.length > 0
        || asArray(message.reasoning_details).length > 0
      );
      validateMessageContent(message.content, `Chat messages[${index}].content`, { allowAbsentOrEmpty: hasAssistantAlternative });
      validateMessageContentRole(message.content, `Chat messages[${index}].content`, message.role, CHAT_MESSAGE_BLOCKS);
      validateOpenAiContentPromptCache(message.content, `Chat messages[${index}].content`, CHAT_PROMPT_CACHE_BLOCK_TYPES);
      if (message.role === 'system' || message.role === 'developer') {
        const parts = applyMessageCacheControl(
          normalizeParts(message.content, { rejectUnknown: true }),
          messageCacheControl,
          `Chat messages[${index}].cache_control`
        );
        if (!hasPortableMessagePayload(parts)) throw unsupportedFeature(`Chat messages[${index}].content 不能只包含空内容块`);
        const text = parts.map((part) => part.text || '').join('');
        if (text) {
          if (conversationStarted) normalized.messages.push({ role: message.role, parts });
          else appendNormalizedSystemParts(normalized, parts.filter((part) => part.type === 'text'), '\n', message.role);
        }
        continue;
      }
      conversationStarted = true;
      if (message.role === 'tool') {
        if (hasResponsesPromptCacheBreakpoint(message.content)) {
          throw unsupportedFeature('跨协议转换暂不支持 Chat tool 消息内容块上的 prompt_cache_breakpoint');
        }
        normalized.messages.push({ role: 'user', parts: [{
          type: 'tool_result', id: requiredInputString(message.tool_call_id, `Chat messages[${index}].tool_call_id`),
          content: normalizedChatToolResultContent(message.content, `Chat messages[${index}].content`),
          ...(messageCacheControl ? { cacheControl: messageCacheControl } : {})
        }] });
        continue;
      }
      const parts = normalizeParts(message.content, { rejectUnknown: true });
      if (reasoningDetails.length) parts.unshift(...reasoningDetails);
      else if (reasoning) parts.unshift({ type: 'reasoning', text: reasoning });
      if (message.function_call !== undefined && message.function_call !== null && asArray(message.tool_calls).length) {
        throw unsupportedFeature(`Chat messages[${index}] 不能同时包含 tool_calls 与旧式 function_call`);
      }
      for (const [callIndex, call] of asArray(message.tool_calls).entries()) {
        const label = `Chat messages[${index}].tool_calls[${callIndex}]`;
        if (!call || Array.isArray(call) || typeof call !== 'object') throw unsupportedFeature(`${label} 必须是对象`);
        assertKnownObjectKeys(call, new Set(['id', 'type', 'function', 'cache_control']), label);
        if (call.type !== undefined && call.type !== 'function') throw unsupportedFeature(`${label}.type 必须是 function`);
        if (!call.function || Array.isArray(call.function) || typeof call.function !== 'object') {
          throw unsupportedFeature(`${label}.function 必须是对象`);
        }
        assertKnownObjectKeys(call.function, new Set(['name', 'arguments']), `${label}.function`);
        const name = requiredInputString(call.function.name, `${label}.function.name`);
        parts.push({
          type: 'tool_call', id: requiredInputString(call.id, `${label}.id`), name,
          arguments: normalizedInputToolArguments(call.function.arguments, `${label}.function.arguments`),
          ...(call.cache_control !== undefined
            ? { cacheControl: validatedClaudeCacheControl(call.cache_control, `${label}.cache_control`) }
            : {})
        });
      }
      if (message.function_call !== undefined && message.function_call !== null) {
        const legacyCall = objectValue(message.function_call, `Chat messages[${index}].function_call`);
        assertKnownObjectKeys(legacyCall, new Set(['id', 'name', 'arguments']), `Chat messages[${index}].function_call`);
        const name = requiredInputString(legacyCall.name, `Chat messages[${index}].function_call.name`);
        parts.push({
          type: 'tool_call', id: legacyCall.id === undefined
            ? `call_${randomUUID().replaceAll('-', '')}`
            : requiredInputString(legacyCall.id, `Chat messages[${index}].function_call.id`),
          name, arguments: normalizedInputToolArguments(legacyCall.arguments, `Chat messages[${index}].function_call.arguments`)
        });
      }
      if (message.refusal) parts.push({ type: 'refusal', text: message.refusal });
      applyMessageCacheControl(parts, messageCacheControl, `Chat messages[${index}].cache_control`);
      if (!hasPortableMessagePayload(parts) && !asArray(message.reasoning_details).length) {
        throw unsupportedFeature(`Chat messages[${index}] 不能只包含空内容`);
      }
      normalized.messages.push({ role: message.role, parts });
    }
    if (body.functions !== undefined && !Array.isArray(body.functions)) throw unsupportedFeature('Chat functions 必须是数组');
    if (asArray(body.tools).length && asArray(body.functions).length) {
      throw unsupportedFeature('Chat tools 与旧式 functions 不能同时用于跨协议转换');
    }
    const unsupportedTools = asArray(body.tools).filter((tool) => tool?.type !== 'function');
    if (unsupportedTools.length) {
      const types = [...new Set(unsupportedTools.map((tool) => tool.type || 'unknown'))].join(', ');
      throw unsupportedFeature(`跨协议转换暂不支持 Chat 工具类型：${types}`);
    }
    const chatTools = asArray(body.tools).map((wrapper, index) => {
      assertKnownObjectKeys(wrapper, new Set(['type', 'function', 'cache_control']), `Chat tools[${index}]`);
      return {
        definition: wrapper.function,
        cacheControl: wrapper.cache_control === undefined
          ? undefined
          : validatedClaudeCacheControl(wrapper.cache_control, `Chat tools[${index}].cache_control`),
        label: `Chat tools[${index}].function`
      };
    });
    const legacyFunctions = asArray(body.functions).map((definition, index) => ({
      definition, label: `Chat functions[${index}]`
    }));
    normalized.tools = [...chatTools, ...legacyFunctions].map(({ definition: tool, cacheControl, label }) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool) || typeof tool.name !== 'string' || !tool.name) {
        throw unsupportedFeature(`${label} 缺少有效 name`);
      }
      assertKnownObjectKeys(tool, new Set(['name', 'description', 'parameters', 'strict']), label);
      if (tool.description !== undefined && typeof tool.description !== 'string') throw unsupportedFeature(`${label}.description 必须是字符串`);
      if (tool.parameters !== undefined && (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))) {
        throw unsupportedFeature(`${label}.parameters 必须是 JSON Schema 对象`);
      }
      const strict = optionalBoolean(tool.strict, `${label}.strict`);
      return {
        name: tool.name, description: tool.description, schema: tool.parameters || {}, strict,
        ...(cacheControl ? { cacheControl } : {})
      };
    });
  }
  if (normalized.toolChoice?.type === 'tool' && !normalized.tools.some((tool) => tool.name === normalized.toolChoice.name)) {
    const label = { claude: 'Claude', responses: 'Responses', chat: 'Chat' }[protocol] || '请求';
    throw unsupportedFeature(`${label} 工具选择引用了未定义工具：${normalized.toolChoice.name}`);
  }
  return normalized;
}

function responsesInstructionMessages(instructions) {
  if (instructions == null) return [];
  if (typeof instructions === 'string') return instructions ? [{ text: instructions, role: 'developer' }] : [];
  const messages = [];
  for (const [index, item] of asArray(instructions).entries()) {
    if (typeof item === 'string') {
      if (item) messages.push({ text: `${messages.length ? '\n' : ''}${item}`, role: 'developer' });
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw unsupportedFeature(`Responses instructions[${index}] 必须是文本或消息对象`);
    const isMessage = Object.hasOwn(item, 'content');
    if (isMessage) {
      const label = `Responses instructions[${index}]`;
      assertKnownObjectKeys(item, new Set(['type', 'role', 'content', 'id', 'status']), label);
      validateResponsesInputItemMetadata(item, label);
      if (item.type !== undefined && item.type !== 'message') {
        throw unsupportedFeature(`Responses instructions[${index}].type 必须是 message`);
      }
      if (item.role !== undefined && !['system', 'developer'].includes(item.role)) {
        throw unsupportedFeature(`Responses instructions[${index}].role 只能是 system 或 developer`);
      }
    } else {
      assertKnownObjectKeys(item, new Set(['type', 'text', 'prompt_cache_breakpoint']), `Responses instructions[${index}] 文本块`);
    }
    const role = isMessage ? item.role || 'developer' : 'developer';
    const content = isMessage ? item.content : item;
    validateOpenAiContentPromptCache(content, `Responses instructions[${index}].content`);
    const parts = normalizeParts(content, { rejectUnknown: true });
    if (parts.some((part) => part.type !== 'text')) throw unsupportedFeature(`Responses instructions[${index}] 仅支持文本内容`);
    for (const [partIndex, part] of parts.entries()) {
      if (!part.text) continue;
      messages.push({
        text: `${messages.length && partIndex === 0 ? '\n' : ''}${part.text}`,
        role,
        ...(part.promptCacheBreakpoint ? { promptCacheBreakpoint: part.promptCacheBreakpoint } : {})
      });
    }
  }
  return messages;
}

function appendNormalizedSystemParts(normalized, parts, separator = '\n', role = 'system') {
  let appended = false;
  for (const part of parts) {
    if (!part.text) continue;
    const text = `${!appended && normalized.system ? separator : ''}${part.text}`;
    normalized.systemMessages.push({
      text,
      role,
      ...(part.cacheControl ? { cacheControl: part.cacheControl } : {}),
      ...(part.promptCacheBreakpoint ? { promptCacheBreakpoint: part.promptCacheBreakpoint } : {})
    });
    normalized.system += text;
    appended = true;
  }
}

function appendNormalizedSystemText(normalized, text, separator = '\n', role = 'developer') {
  appendNormalizedSystemParts(normalized, [{ type: 'text', text }], separator, role);
}

function validGeminiFunctionName(value, label) {
  if (typeof value !== 'string' || !GEMINI_FUNCTION_NAME_PATTERN.test(value)) {
    throw unsupportedFeature(`${label} 必须匹配 ${GEMINI_FUNCTION_NAME_PATTERN}`);
  }
  return value;
}

function createGeminiToolCallTracker(reservedIds = new Set()) {
  let syntheticIndex = 0;
  const pendingById = new Map();
  const pendingByName = new Map();
  const usedIds = new Set();
  const validatedId = (value, label) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value) throw unsupportedFeature(`${label} 必须是非空字符串`);
    return value;
  };
  const nextSyntheticId = () => {
    let id;
    do { id = `gemini_call_${syntheticIndex++}`; } while (usedIds.has(id) || reservedIds.has(id));
    return id;
  };
  return {
    register(call) {
      const explicitId = validatedId(call.id, 'Gemini functionCall.id');
      const id = explicitId || nextSyntheticId();
      if (usedIds.has(id)) throw unsupportedFeature(`Gemini functionCall.id 重复：${id}`);
      usedIds.add(id);
      let queue = pendingByName.get(call.name);
      if (!queue) {
        queue = { entries: [], head: 0, pending: 0 };
        pendingByName.set(call.name, queue);
      }
      const entry = { id, name: call.name, queueIndex: queue.entries.length };
      pendingById.set(id, entry);
      queue.entries.push(entry);
      queue.pending++;
      return id;
    },
    resolve(result) {
      const explicitId = validatedId(result.id, 'Gemini functionResponse.id');
      let entry;
      if (explicitId) {
        entry = pendingById.get(explicitId);
        if (!entry) throw unsupportedFeature(`Gemini functionResponse.id 没有匹配的前置 functionCall：${explicitId}`);
        if (entry.name !== result.name) {
          throw unsupportedFeature(`Gemini functionResponse ${explicitId} 的 name=${result.name} 与前置 functionCall.name=${entry.name} 不一致`);
        }
      } else {
        const queue = pendingByName.get(result.name);
        while (queue && queue.head < queue.entries.length) {
          const candidate = queue.entries[queue.head];
          queue.entries[queue.head++] = undefined;
          if (candidate && pendingById.has(candidate.id)) {
            entry = candidate;
            break;
          }
        }
        if (!entry) throw unsupportedFeature(`Gemini functionResponse.name 没有匹配的前置 functionCall：${result.name}`);
      }
      pendingById.delete(entry.id);
      const queue = pendingByName.get(entry.name);
      if (queue) {
        queue.entries[entry.queueIndex] = undefined;
        if (--queue.pending === 0) pendingByName.delete(entry.name);
      }
      return entry.id;
    }
  };
}

function normalizeGeminiParts(parts, { rejectUnknown = false, toolCallTracker } = {}) {
  const normalized = asArray(parts).flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      if (rejectUnknown) throw unsupportedFeature('Gemini parts 必须是对象');
      return [];
    }
    if (part.thought !== undefined && typeof part.thought !== 'boolean') {
      throw unsupportedFeature('Gemini Part 的 thought 必须是布尔值');
    }
    const signature = geminiThoughtSignature(part);
    const inline = part.inlineData || part.inline_data;
    const file = part.fileData || part.file_data;
    const call = part.functionCall || part.function_call;
    const result = part.functionResponse || part.function_response;
    const variants = [typeof part.text === 'string', Boolean(inline), Boolean(file), Boolean(call), Boolean(result)].filter(Boolean).length;
    if (variants !== 1) {
      if (rejectUnknown) throw unsupportedFeature(variants > 1 ? 'Gemini Part 只能包含一种内容类型' : `跨协议转换暂不支持 Gemini Part：${Object.keys(part)[0] || 'unknown'}`);
      return [];
    }
    if (part.thought === true && typeof part.text !== 'string') {
      throw unsupportedFeature('Gemini thought=true 只能用于文本 Part');
    }
    if (typeof part.text === 'string') {
      const providerState = signature
        ? decodeReasoningState(signature) || { protocol: 'gemini', kind: 'part', value: part }
        : undefined;
      if (part.thought === true && part.text === GEMINI_BRIDGE_STATE_TEXT && signature && providerState?.protocol !== 'gemini') {
        const states = providerState.protocol === 'bridge' ? providerState.value.states : [providerState];
        return states.map((state) => ({ type: 'provider_state', signature, providerState: state, bridgeReplayState: true }));
      }
      return [{
        type: part.thought ? (part.text ? 'reasoning' : 'provider_state') : 'text',
        ...(part.text || !part.thought ? { text: part.text } : {}),
        ...(signature ? { signature } : {}),
        ...(providerState ? { providerState } : {})
      }];
    }
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
      validGeminiFunctionName(call.name, 'Gemini functionCall.name');
      if (call.args != null && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw unsupportedFeature('Gemini functionCall.args 必须是对象');
      const unsupported = Object.keys(call).filter((key) => !['id', 'name', 'args'].includes(key));
      if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini functionCall 字段：${unsupported.join(', ')}`);
      const providerState = signature ? decodeReasoningState(signature) : null;
      const toolCall = {
        type: 'tool_call', id: toolCallTracker?.register(call)
          || (call.id === undefined ? `call_${randomUUID().replaceAll('-', '')}` : optionalOpenAiString(call.id, 'Gemini functionCall.id')),
        name: call.name, arguments: call.args || {},
        ...(signature && !providerState ? { signature, providerState: { protocol: 'gemini', kind: 'part', value: part } } : {})
      };
      if (!providerState) return [toolCall];
      const states = providerState.protocol === 'bridge' ? providerState.value.states : [providerState];
      return [...states.map((state) => ({ type: 'provider_state', signature, providerState: state, bridgeReplayState: true })), toolCall];
    }
    validGeminiFunctionName(result.name, 'Gemini functionResponse.name');
    if (!result.response || typeof result.response !== 'object' || Array.isArray(result.response)) throw unsupportedFeature('Gemini functionResponse.response 必须是对象');
    const unsupported = Object.keys(result).filter((key) => !['id', 'name', 'response'].includes(key));
    if (unsupported.length) throw unsupportedFeature(`跨协议转换暂不支持 Gemini functionResponse 字段：${unsupported.join(', ')}`);
    return [{
      type: 'tool_result',
      id: toolCallTracker?.resolve(result)
        || (result.id === undefined ? result.name : optionalOpenAiString(result.id, 'Gemini functionResponse.id')),
      content: result.response
    }];
  });
  const replayTextCounts = new Map();
  for (const text of normalized.filter((part) => part.bridgeReplayState)
    .flatMap((part) => providerStateReplayTexts(part.providerState))) {
    replayTextCounts.set(text, (replayTextCounts.get(text) || 0) + 1);
  }
  return normalized
    .filter((part) => {
      if (part.type !== 'reasoning' || part.providerState || !replayTextCounts.has(part.text)) return true;
      const remaining = replayTextCounts.get(part.text);
      if (remaining <= 1) replayTextCounts.delete(part.text);
      else replayTextCounts.set(part.text, remaining - 1);
      return false;
    })
    .map(({ bridgeReplayState: _bridgeReplayState, ...part }) => part);
}

function providerStateReplayTexts(state) {
  if (state?.protocol === 'claude') {
    if (state.kind === 'thinking') return [state.value.thinking];
    if (state.kind === 'compaction' && state.value.content) return [state.value.content];
  }
  if (state?.protocol === 'responses' && state.kind === 'reasoning') {
    return [...asArray(state.value.summary), ...asArray(state.value.content)]
      .map((part) => part?.text).filter((text) => typeof text === 'string' && text);
  }
  if (state?.protocol === 'chat') {
    const details = state.kind === 'reasoning_details' ? state.value.details : [state.value];
    return details.map((detail) => detail?.text || detail?.summary).filter((text) => typeof text === 'string' && text);
  }
  return [];
}

function decodeSingleReasoningState(value, label) {
  const state = decodeReasoningState(value);
  if (state?.protocol === 'bridge' && state.kind === 'bundle') {
    throw unsupportedFeature(`${label} 不能携带 Gemini 专用的复合推理状态封装`);
  }
  return state;
}

function normalizeGeminiToolChoice(config, tools) {
  const sourceTools = asArray(tools);
  if (!config) return { choice: undefined, tools: sourceTools };
  const mode = String(config.mode || 'AUTO').toUpperCase();
  if (!['AUTO', 'ANY', 'NONE', 'VALIDATED'].includes(mode)) throw unsupportedFeature(`不支持 Gemini functionCallingConfig.mode：${mode}`);
  const names = config.allowedFunctionNames === undefined ? [] : config.allowedFunctionNames;
  if (!Array.isArray(names)) throw unsupportedFeature('Gemini allowedFunctionNames 必须是数组');
  if (names.some((name) => typeof name !== 'string' || !name)) {
    throw unsupportedFeature('Gemini allowedFunctionNames 只能包含非空字符串');
  }
  if (new Set(names).size !== names.length) throw unsupportedFeature('Gemini allowedFunctionNames 不能包含重复名称');
  if (names.length && !['ANY', 'VALIDATED'].includes(mode)) {
    throw unsupportedFeature('Gemini allowedFunctionNames 只能与 ANY 或 VALIDATED 模式一起使用');
  }
  const available = new Set(sourceTools.map((tool) => tool.name));
  const missing = names.find((name) => !available.has(name));
  if (missing) throw unsupportedFeature(`Gemini allowedFunctionNames 引用了未定义工具：${missing}`);
  const selectedNames = names.length ? new Set(names) : null;
  const selectedTools = selectedNames ? sourceTools.filter((tool) => selectedNames.has(tool.name)) : sourceTools;
  if (mode === 'ANY' && selectedTools.length === 0) throw unsupportedFeature('Gemini functionCallingConfig.mode=ANY 至少需要一个可调用函数');
  if (mode === 'NONE') return { choice: { type: 'none' }, tools: sourceTools };
  if (mode === 'ANY') return { choice: names.length === 1 ? { type: 'tool', name: names[0] } : { type: 'any' }, tools: selectedTools };
  return { choice: { type: 'auto' }, tools: selectedTools };
}

function requiredInputString(value, label) {
  if (typeof value !== 'string' || !value) throw unsupportedFeature(`${label} 必须是非空字符串`);
  return value;
}

const RESPONSES_ITEM_STATUSES = new Set(['in_progress', 'completed', 'incomplete']);
const RESPONSES_ITEM_PHASES = new Set(['commentary', 'final_answer']);

function validateResponsesInputItemMetadata(item, label) {
  if (item.id !== undefined && item.id !== null) requiredInputString(item.id, `${label}.id`);
  optionalOpenAiEnum(item.status, `${label}.status`, RESPONSES_ITEM_STATUSES);
  optionalOpenAiEnum(item.phase, `${label}.phase`, RESPONSES_ITEM_PHASES);
}

function responsesInputCallId(item, label) {
  return requiredInputString(item.call_id ?? item.id, `${label}.call_id/id`);
}

function validateResponsesInputItemKeys(item, index) {
  const type = item.type || (item.role ? 'message' : '');
  const allowed = {
    message: ['type', 'id', 'status', 'role', 'content', 'phase', 'prompt_cache_breakpoint'],
    reasoning: ['type', 'id', 'status', 'summary', 'content', 'encrypted_content', 'phase'],
    function_call: ['type', 'id', 'status', 'call_id', 'name', 'namespace', 'arguments', 'caller', 'phase'],
    function_call_output: ['type', 'id', 'status', 'call_id', 'output', 'caller', 'phase'],
    custom_tool_call: ['type', 'id', 'status', 'call_id', 'name', 'input', 'phase'],
    custom_tool_call_output: ['type', 'id', 'status', 'call_id', 'output', 'phase'],
    tool_search_call: ['type', 'id', 'status', 'call_id', 'execution', 'arguments', 'phase'],
    tool_search_output: ['type', 'id', 'status', 'call_id', 'execution', 'tools', 'phase'],
    compaction: ['type', 'id', 'encrypted_content', 'created_by']
  }[type];
  if (allowed) {
    const label = `Responses input[${index}] ${type}`;
    assertKnownObjectKeys(item, new Set(allowed), label);
    if (type === 'compaction') validateResponsesCompactionItem(item, label, (message) => { throw unsupportedFeature(message); });
    else validateResponsesInputItemMetadata(item, label);
  }
}

function validateResponsesCompactionItem(item, label, fail, { allowPendingEncrypted = false } = {}) {
  if (!item || Array.isArray(item) || typeof item !== 'object' || item.type !== 'compaction') {
    fail(`${label} 必须是 compaction 对象`);
  }
  const unsupported = Object.keys(item).filter((key) => !['type', 'id', 'encrypted_content', 'created_by'].includes(key));
  if (unsupported.length) fail(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
  if (typeof item.id !== 'string' || !item.id) fail(`${label}.id 必须是非空字符串`);
  if (!allowPendingEncrypted || (item.encrypted_content !== undefined && item.encrypted_content !== null)) {
    if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) {
      fail(`${label}.encrypted_content 必须是非空字符串`);
    }
  }
  if (item.created_by !== undefined && (typeof item.created_by !== 'string' || !item.created_by)) {
    fail(`${label}.created_by 必须是非空字符串`);
  }
}

function normalizedInputToolArguments(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw unsupportedFeature(`${label} 必须是对象（且字符串形式必须是有效 JSON）`); }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw unsupportedFeature(`${label} 必须是 JSON 对象`);
  }
  try { assertJsonComplexity(parsed, { label: `${label} JSON` }); }
  catch (error) { throw unsupportedFeature(error.message); }
  return parsed;
}

function parseArguments(value) {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch { return value; }
}

function normalizedOutputToolArguments(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${label} 必须是有效 JSON 对象`); }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} 必须是 JSON 对象`);
  assertJsonComplexity(parsed, { label: `${label} JSON`, code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  return parsed;
}

function normalizedResponsesInputReasoning(item, index) {
  const label = `Responses input[${index}] reasoning`;
  if (item.encrypted_content !== undefined && item.encrypted_content !== null
    && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
    throw unsupportedFeature(`${label}.encrypted_content 必须是非空字符串或 null`);
  }
  const reasoningParts = [];
  for (const [field, expectedType, reasoningKind] of [
    ['summary', 'summary_text', 'summary'],
    ['content', 'reasoning_text', 'content']
  ]) {
    if (item[field] === undefined || item[field] === null) continue;
    if (!Array.isArray(item[field])) throw unsupportedFeature(`${label}.${field} 必须是数组`);
    for (const [partIndex, part] of item[field].entries()) {
      if (!part || Array.isArray(part) || typeof part !== 'object' || part.type !== expectedType || typeof part.text !== 'string') {
        throw unsupportedFeature(`${label}.${field}[${partIndex}] 必须是 ${expectedType} 文本块`);
      }
      if (part.text) reasoningParts.push({ type: 'reasoning', reasoningKind, text: part.text });
    }
  }
  const providerState = decodeSingleReasoningState(item.encrypted_content, `${label}.encrypted_content`);
  if (reasoningParts.length) {
    if (providerState) reasoningParts[0].providerState = providerState;
    return reasoningParts;
  }
  return providerState ? [{ type: 'provider_state', providerState }] : [];
}

function normalizedChatToolResultContent(content, label) {
  if (typeof content === 'string') return content;
  return content.map((part, index) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text !== 'string') throw unsupportedFeature(`${label}[${index}].text 必须是字符串`);
    return part.text;
  }).join('');
}

function normalizedChatReasoningDetails(details, { bridgeOnly = false } = {}) {
  if (details === undefined) return [];
  if (!Array.isArray(details)) throw unsupportedFeature('Chat reasoning_details 必须是数组');
  return details.flatMap((detail, index) => {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      throw unsupportedFeature(`Chat reasoning_details[${index}] 必须是对象`);
    }
    if (detail.type === 'reasoning.text') {
      if (typeof detail.text !== 'string') throw unsupportedFeature(`Chat reasoning_details[${index}].text 必须是字符串`);
      const providerState = decodeSingleReasoningState(detail.signature, `Chat reasoning_details[${index}].signature`);
      if (bridgeOnly && !providerState) return detail.text ? [{ type: 'reasoning', text: detail.text }] : [];
      return [{
        type: detail.text ? 'reasoning' : 'provider_state',
        ...(detail.text ? { text: detail.text } : {}),
        providerState: providerState || { protocol: 'chat', kind: 'reasoning_detail', value: detail }
      }];
    }
    if (detail.type === 'reasoning.summary') {
      if (typeof detail.summary !== 'string') throw unsupportedFeature(`Chat reasoning_details[${index}].summary 必须是字符串`);
      if (bridgeOnly) return detail.summary ? [{ type: 'reasoning', text: detail.summary }] : [];
      return [{
        type: detail.summary ? 'reasoning' : 'provider_state',
        ...(detail.summary ? { text: detail.summary } : {}),
        providerState: { protocol: 'chat', kind: 'reasoning_detail', value: detail }
      }];
    }
    if (detail.type === 'reasoning.encrypted') {
      if (typeof detail.data !== 'string' || !detail.data) throw unsupportedFeature(`Chat reasoning_details[${index}].data 必须是非空字符串`);
      const providerState = decodeSingleReasoningState(detail.data, `Chat reasoning_details[${index}].data`);
      if (bridgeOnly && !providerState) return [];
      return [{ type: 'provider_state', providerState: providerState || { protocol: 'chat', kind: 'reasoning_detail', value: detail } }];
    }
    throw unsupportedFeature(`跨协议转换暂不支持 Chat reasoning_details 类型：${detail.type || 'unknown'}`);
  });
}

function customToolInput(value) {
  const parsed = parseArguments(value);
  assertJsonComplexity(parsed, { label: '上游 custom tool JSON 参数', code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && typeof parsed[CUSTOM_TOOL_INPUT_FIELD] === 'string') return parsed[CUSTOM_TOOL_INPUT_FIELD];
  if (typeof parsed === 'string') return parsed;
  return canonicalJsonString(parsed);
}

function toolSearchArguments(value) {
  const parsed = parseArguments(value);
  assertJsonComplexity(parsed, { label: '上游 client tool_search JSON 参数', code: 'UPSTREAM_JSON_TOO_COMPLEX' });
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') return parsed;
  throw new Error('上游 client tool_search 返回了非对象参数');
}

function normalizeToolChoice(choice, protocol) {
  if (choice === undefined || choice === null) return undefined;
  if (protocol === 'claude') {
    const value = objectValue(choice, 'Claude tool_choice');
    if (!['auto', 'any', 'tool', 'none'].includes(value.type)) {
      throw unsupportedFeature('Claude tool_choice.type 必须是 auto、any、tool 或 none');
    }
    if (value.type === 'tool') {
      const name = optionalOpenAiString(value.name, 'Claude tool_choice.name');
      return { type: 'tool', name };
    }
    if (value.name !== undefined) throw unsupportedFeature(`Claude tool_choice.type=${value.type} 不能设置 name`);
    return { type: value.type };
  }

  if (typeof choice === 'string') {
    if (!['none', 'auto', 'required'].includes(choice)) {
      throw unsupportedFeature(`${protocol === 'responses' ? 'Responses' : 'Chat'} tool_choice 必须是 none、auto 或 required`);
    }
    return { type: choice === 'required' ? 'any' : choice };
  }
  const label = protocol === 'responses' ? 'Responses' : 'Chat';
  const value = objectValue(choice, `${label} tool_choice`);
  if (protocol === 'chat') {
    if (value.type !== 'function') throw unsupportedFeature('跨协议转换仅支持 Chat function tool_choice 对象');
    const definition = objectValue(value.function, 'Chat tool_choice.function');
    return { type: 'tool', name: optionalOpenAiString(definition.name, 'Chat tool_choice.function.name') };
  }

  const supportedTypes = new Set([
    'function', 'custom', 'tool_search', 'allowed_tools', 'programmatic_tool_calling',
    ...RESPONSES_WEB_SEARCH_TOOL_TYPES
  ]);
  if (!supportedTypes.has(value.type)) {
    throw unsupportedFeature(`跨协议转换暂不支持 Responses tool_choice 类型：${value.type || 'unknown'}`);
  }
  if (value.type === 'function') return { type: 'tool', name: optionalOpenAiString(value.name, 'Responses tool_choice.name') };
  if (value.type === 'custom') optionalOpenAiString(value.name, 'Responses custom tool_choice.name');
  return { type: value.type };
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

function chatTextDocumentPart(part, promptCacheEnabled = false) {
  const text = textDocumentData(part);
  if (text === undefined) return undefined;
  const metadata = {
    name: part.title || part.filename || fallbackFilename(part.source),
    ...(typeof part.context === 'string' && part.context ? { context: part.context } : {})
  };
  return {
    type: 'text',
    text: `[Attached text document ${canonicalJsonString(metadata)}]\n${text}\n[End attached text document]`,
    ...(part.cacheControl && !promptCacheEnabled ? { cache_control: part.cacheControl } : {}),
    ...(promptCacheEnabled && (part.promptCacheBreakpoint || part.cacheControl)
      ? { prompt_cache_breakpoint: part.promptCacheBreakpoint || { mode: 'explicit' } }
      : {})
  };
}

function chatNativeFilePart(part, promptCacheEnabled = false) {
  let file;
  if (part.source?.type === 'file' && part.source.file_id) file = { file_id: part.source.file_id };
  else {
    const file_data = fileDataUrl(part.source);
    if (file_data) file = { filename: part.filename || fallbackFilename(part.source), file_data };
  }
  if (!file) return undefined;
  const breakpoint = part.promptCacheBreakpoint || (part.cacheControl ? { mode: 'explicit' } : undefined);
  return {
    type: 'file', file,
    ...(promptCacheEnabled && breakpoint ? { prompt_cache_breakpoint: breakpoint } : {})
  };
}

function responsesFilePart(part, promptCacheBreakpoint) {
  const cache = promptCacheBreakpoint ? { prompt_cache_breakpoint: promptCacheBreakpoint } : {};
  if (part.source?.type === 'url') return { type: 'input_file', file_url: part.source.url, ...(part.detail ? { detail: part.detail } : {}), ...cache };
  if (part.source?.type === 'file') return { type: 'input_file', file_id: part.source.file_id, ...(part.detail ? { detail: part.detail } : {}), ...cache };
  const file_data = fileDataUrl(part.source);
  if (file_data) return { type: 'input_file', filename: part.filename || fallbackFilename(part.source), file_data, ...(part.detail ? { detail: part.detail } : {}), ...cache };
  throw unsupportedFeature('文件内容块缺少可转换的 URL、file_id 或 base64 数据');
}

function chatImagePart(part, imageHandoffEnabled, promptCacheEnabled = false) {
  const breakpoint = part.promptCacheBreakpoint || (part.cacheControl ? { mode: 'explicit' } : undefined);
  if (imageHandoffEnabled) {
    return {
      type: 'text', text: imageHandoffNotice(part),
      ...(part.cacheControl && !promptCacheEnabled ? { cache_control: part.cacheControl } : {}),
      ...(promptCacheEnabled && breakpoint ? { prompt_cache_breakpoint: breakpoint } : {})
    };
  }
  const url = imageDataUrl(part.source);
  if (!url) throw unsupportedFeature('Chat Completions 无法表达 image file_id；请改用图片 URL/base64，或将模型路由设为 responses/claude');
  return {
    type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) },
    ...(part.cacheControl && !promptCacheEnabled ? { cache_control: part.cacheControl } : {}),
    ...(promptCacheEnabled && breakpoint ? { prompt_cache_breakpoint: breakpoint } : {})
  };
}

function imageHandoffNotice(part) {
  let value;
  if (part?.source?.type === 'url') value = part.source.url;
  else if (part?.type === 'image_url') value = part.image_url?.url || part.image_url;
  else if (part?.type === 'input_image') value = part.image_url;
  return remoteImageHandoffNotice(value) || UNSUPPORTED_IMAGE_NOTICE;
}

function replaceUnsupportedProtocolImages(body, protocol, imageHandoffEnabled) {
  const field = protocol === 'responses' ? 'input' : 'messages';
  if (!imageHandoffEnabled || !Array.isArray(body[field])) return body;
  let changed = false;
  const messages = body[field].map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (!['image', 'image_url', 'input_image'].includes(part?.type)) return part;
      changed = true;
      messageChanged = true;
      const text = imageHandoffNotice(part);
      if (protocol === 'responses') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text };
      return { type: 'text', text };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...body, [field]: messages } : body;
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
  if (next.refusal) previous.refusal = `${previous.refusal || ''}${next.refusal}`;
  if (next.reasoning_details?.length) previous.reasoning_details = [...asArray(previous.reasoning_details), ...next.reasoning_details];
  if (next.reasoning_content && next.reasoning_content !== previous.reasoning_content && next.reasoning_content !== 'tool call') {
    previous.reasoning_content = [previous.reasoning_content, next.reasoning_content].filter((text) => text && text !== 'tool call').join('\n') || 'tool call';
  }
}

function claudeContent(parts, { includeReasoning = false, reasoningAsText = false, imageHandoffEnabled = false } = {}) {
  return parts.flatMap((part) => {
    const cacheControl = part.cacheControl || (part.promptCacheBreakpoint ? { type: 'ephemeral' } : undefined);
    if (part.providerState?.protocol === 'claude') return [part.providerState.value];
    if (part.type === 'text' || part.type === 'refusal') return { type: 'text', text: portablePartText(part), ...(cacheControl ? { cache_control: cacheControl } : {}) };
    if (part.type === 'image') return imageHandoffEnabled
      ? { type: 'text', text: imageHandoffNotice(part), ...(cacheControl ? { cache_control: cacheControl } : {}) }
      : { type: 'image', source: part.source, ...(cacheControl ? { cache_control: cacheControl } : {}) };
    if (part.type === 'file') {
      if (!part.source) throw unsupportedFeature('文件内容块缺少可转换的 URL、file_id 或 base64 数据');
      return {
        type: 'document', source: part.source,
        ...(part.title || part.filename ? { title: part.title || part.filename } : {}),
        ...(part.context ? { context: part.context } : {}),
        ...(part.citations !== undefined ? { citations: part.citations } : {}),
        ...(cacheControl ? { cache_control: cacheControl } : {})
      };
    }
    if (part.type === 'tool_call') return {
      type: 'tool_use', id: part.id, name: part.name, input: sanitizeToolArguments(part.name, part.arguments),
      ...(cacheControl ? { cache_control: cacheControl } : {})
    };
    if (part.type === 'tool_result') return {
      type: 'tool_result', tool_use_id: part.id, content: part.content,
      ...(part.isError !== undefined ? { is_error: part.isError } : {}),
      ...(cacheControl ? { cache_control: cacheControl } : {})
    };
    if (reasoningAsText && part.type === 'reasoning' && part.text) return { type: 'text', text: part.text };
    if (includeReasoning && part.type === 'reasoning') return { type: 'thinking', thinking: part.text || '', signature: part.signature || 'bridge' };
    return [];
  });
}

function encodedProviderState(part) {
  const state = part?.providerState;
  return state ? encodeReasoningState(state.protocol, state.kind, state.value) : undefined;
}

function claudeResponseContent(parts) {
  return parts.flatMap((part) => {
    if (part.providerState?.protocol === 'claude' && part.providerState.kind === 'compaction') {
      return part.providerState.value;
    }
    if (part.type === 'reasoning') return {
      type: 'thinking', thinking: part.text || '',
      signature: encodedProviderState(part) || part.signature || 'bridge'
    };
    if (part.type === 'provider_state') return {
      type: 'redacted_thinking', data: encodedProviderState(part)
    };
    return claudeContent([part]);
  });
}

function portableCrossProtocolTools(request, targetProtocol) {
  const references = NORMALIZED_CLAUDE_TOOL_REFERENCES.get(request) || claudeToolReferenceNames(request.messages);
  const toolsByName = new Map();
  const visible = [];
  let unsupportedCallerTool;
  for (const tool of request.tools) {
    toolsByName.set(tool.name, tool);
    if (!tool.deferLoading || references.has(tool.name)) visible.push(tool);
    if (!unsupportedCallerTool && tool.allowedCallers && !tool.allowedCallers.includes('direct')) {
      unsupportedCallerTool = tool;
    }
  }
  const forcedToolName = request.toolChoice?.type === 'tool' ? request.toolChoice.name : undefined;
  const forcedTool = forcedToolName ? toolsByName.get(forcedToolName) : undefined;
  if (forcedToolName && !forcedTool) {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 时工具选择引用了未定义工具：${forcedToolName}`);
  }
  for (const name of references) {
    const tool = toolsByName.get(name);
    if (!tool) throw unsupportedFeature(`Claude tool_reference 引用了未定义工具：${name}`);
    if (!tool.deferLoading) throw unsupportedFeature(`Claude tool_reference 只能引用 defer_loading=true 的工具：${name}`);
  }
  if (unsupportedCallerTool) {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 时无法保留仅允许程序化调用的 Claude 工具：${unsupportedCallerTool.name}`);
  }
  if (!request.tools.length) return [];
  if (forcedTool?.deferLoading && !references.has(forcedToolName)) {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 时不能强制选择尚未加载的 Claude deferred tool：${forcedToolName}`);
  }
  if (!visible.length) {
    throw unsupportedFeature(`跨协议转换到 ${targetProtocol} 时无法加载全部标记为 defer_loading 的 Claude 工具；请保留 ToolSearch 等非延迟工具或将模型路由设为 claude`);
  }
  return visible.map((tool) => {
    if (!tool.inputExamples?.length) return tool;
    const examples = canonicalJsonString(tool.inputExamples);
    return {
      ...tool,
      description: [tool.description, `Claude input_examples:\n${examples}`].filter(Boolean).join('\n\n')
    };
  });
}

function geminiThinkingConfig(request) {
  const control = request.reasoningControl;
  if (control?.source === 'responses') assertPortableResponsesReasoning(request, 'Gemini GenerateContent');
  if (!control && !request.reasoningEffort && !request.reasoningSummary) return undefined;

  let thinkingBudget;
  let thinkingLevel;
  let includeThoughts;
  if (control?.source === 'claude') {
    if (control.mode === 'enabled') {
      if (control.budget > 32_768) {
        throw unsupportedFeature('Claude thinking.budget_tokens 超过 Gemini thinkingBudget 的 32768 上限；请降低预算或将模型路由设为 claude');
      }
      thinkingBudget = control.budget;
    } else if (control.mode === 'disabled') thinkingBudget = 0;
    else if (control.effort) thinkingLevel = geminiThinkingLevel(control.effort);
    if (control.display !== undefined) includeThoughts = control.display === 'summarized';
  } else {
    const effort = control?.effort || request.reasoningEffort;
    if (effort === 'none') thinkingBudget = 0;
    else if (effort) thinkingLevel = geminiThinkingLevel(effort);
    if (control?.summary || request.reasoningSummary) includeThoughts = true;
  }
  const result = {
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(includeThoughts !== undefined ? { includeThoughts } : {})
  };
  return Object.keys(result).length ? result : undefined;
}

function geminiThinkingLevel(effort) {
  if (effort === 'minimal') return 'minimal';
  if (['low', 'medium'].includes(effort)) return effort;
  return 'high';
}

function geminiToolResultResponse(part) {
  const content = part.content;
  if (part.isError) return { error: typeof content === 'string' ? content : canonicalJsonString(content) };
  if (content && !Array.isArray(content) && typeof content === 'object') return content;
  return { result: content === undefined ? '' : content };
}

function geminiDataUrlPart(source) {
  if (source?.type !== 'url' || typeof source.url !== 'string') return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source.url.replaceAll(/\s/g, ''));
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
}

function geminiRequestPart(part, role, toolNames, options) {
  if (part.providerState?.protocol === 'gemini') return part.providerState.value;
  if (part.type === 'text' || part.type === 'refusal') return { text: portablePartText(part) };
  if (part.type === 'reasoning') return {
    text: part.text || '', thought: true
  };
  // Signatures are model/provider-bound. Foreign opaque state is reported as
  // a degradation and omitted instead of fabricating a Google signature that
  // the native Gemini endpoint may reject.
  if (part.type === 'provider_state') return null;
  if (part.type === 'tool_call') {
    if (role !== 'assistant') throw unsupportedFeature('Gemini functionCall 只能位于 model Content');
    toolNames.set(part.id, part.name);
    return { functionCall: { name: part.name, args: sanitizeToolArguments(part.name, part.arguments), ...(part.id ? { id: part.id } : {}) } };
  }
  if (part.type === 'tool_result') {
    if (role === 'assistant') throw unsupportedFeature('Gemini functionResponse 不能位于 model Content');
    const name = toolNames.get(part.id);
    if (!name) throw unsupportedFeature(`Gemini functionResponse 无法找到 call id=${part.id} 对应的函数名`);
    return { functionResponse: { name, response: geminiToolResultResponse(part), ...(part.id ? { id: part.id } : {}) } };
  }
  if (part.type === 'image' && options.imageHandoffEnabled) return { text: imageHandoffNotice(part) };
  if (part.type === 'file' && ['text', 'content'].includes(part.source?.type)) {
    const text = chatTextDocumentPart(part)?.text;
    if (text !== undefined) return { text };
  }
  const source = part.source;
  if (source?.type === 'base64') return {
    inlineData: { mimeType: source.media_type || (part.type === 'image' ? 'image/png' : 'application/octet-stream'), data: source.data || '' }
  };
  if (source?.type === 'url') return geminiDataUrlPart(source) || {
    fileData: { mimeType: source.media_type || (part.type === 'image' ? 'image/*' : 'application/octet-stream'), fileUri: source.url }
  };
  if (source?.type === 'file') {
    throw unsupportedFeature(`Gemini GenerateContent 无法表达 ${part.type} file_id；请改用 URL/base64，或将模型路由设为 responses`);
  }
  throw unsupportedFeature(`Gemini GenerateContent 无法表达内容块：${part.type || 'unknown'}`);
}

function geminiToolConfig(request, tools) {
  if (request.parallelToolCalls === false) {
    throw unsupportedFeature('Gemini GenerateContent 无法禁止并行函数调用；请移除 parallel_tool_calls/disable_parallel_tool_use 或改用原协议模型');
  }
  if (!request.toolChoice) return undefined;
  const choice = request.toolChoice;
  if (choice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (!tools.length) return undefined;
  if (choice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice.type === 'tool') return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
  if (choice.type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  throw unsupportedFeature(`跨协议转换到 Gemini GenerateContent 无法表达工具选择：${choice.type || 'unknown'}`);
}

function geminiOutputGenerationConfig(request) {
  const output = request.outputFormat;
  if (!output) return {};
  if (output.type === 'json_object') return { responseMimeType: 'application/json' };
  return { responseMimeType: 'application/json', responseJsonSchema: cleanSchema(output.schema) };
}

function formatGeminiRequest(request, options) {
  assertPortableResponsesReasoning(request, 'Gemini GenerateContent');
  unsupportedGenerationOptions(request, 'Gemini GenerateContent', [
    'metadata', 'serviceTier', 'speed', 'safetyIdentifier', 'user', 'moderation', 'verbosity',
  ]);
  const tools = portableCrossProtocolTools(request, 'Gemini GenerateContent');
  const unsupportedTool = tools.find((tool) => tool.strict !== undefined);
  if (unsupportedTool) {
    throw unsupportedFeature(`Gemini GenerateContent 无法无损表达工具 ${unsupportedTool.name} 的 strict 配置`);
  }

  // Resolve functionResponse names only from calls that have already appeared.
  // Pre-populating this map would silently accept an invalid result-before-call
  // transcript and could associate reused IDs with the wrong function.
  const toolNames = new Map();
  const contents = request.messages.map((message) => {
    const originalRole = message.role;
    const role = originalRole === 'assistant' ? 'model' : 'user';
    let parts = message.parts.map((part) => geminiRequestPart(part, originalRole, toolNames, options)).filter(Boolean);
    if (['system', 'developer'].includes(originalRole)) {
      parts = [{ text: `[${originalRole === 'developer' ? 'Developer' : 'System'} instruction at this point]\n${parts.map((part) => part.text || '').join('')}` }];
    }
    return { role, parts };
  }).filter((message) => message.parts.length);
  if (!contents.length) {
    throw unsupportedFeature('Gemini GenerateContent 至少需要一条 contents 消息；不能只发送 system/developer 提示词');
  }
  const thinkingConfig = geminiThinkingConfig(request);
  const generationConfig = {
    ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.topK !== undefined ? { topK: request.topK } : {}),
    ...(request.stop?.length ? { stopSequences: request.stop } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
    ...(request.topLogprobs !== undefined ? { responseLogprobs: true, logprobs: request.topLogprobs } : {}),
    ...geminiOutputGenerationConfig(request),
    ...(thinkingConfig ? { thinkingConfig } : {})
  };
  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parametersJsonSchema: cleanSchema(tool.schema || {})
  }));
  const toolConfig = geminiToolConfig(request, tools);
  const geminiTools = [
    ...(functionDeclarations.length ? [{ functionDeclarations }] : []),
    ...(request.geminiGoogleSearch ? [{ googleSearch: {} }] : [])
  ];
  return {
    model: request.model,
    stream: request.stream,
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    contents,
    ...(geminiTools.length ? { tools: geminiTools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {})
  };
}

export function formatRequest(request, protocol, options = {}) {
  assertSupportedUpstreamProtocol(protocol);
  if (protocol === 'gemini') return formatGeminiRequest(request, options);
  const common = Object.fromEntries(Object.entries({
    model: request.model,
    stream: request.stream,
    temperature: request.temperature,
    top_p: request.topP
  }).filter(([, value]) => value !== undefined));

  if (protocol === 'claude') {
    if (request.responsesWebSearch) {
      throw unsupportedFeature('Gemini googleSearch 需要原生 Responses 上游执行；Claude Messages 没有等价的托管搜索工具');
    }
    assertPortableResponsesReasoning(request, 'Claude Messages');
    unsupportedGenerationOptions(request, 'Claude Messages', [
      'seed', 'presencePenalty', 'frequencyPenalty', 'topLogprobs',
      'safetyIdentifier', 'user', 'verbosity', 'moderation'
    ]);
    const targetSpeed = request.speed || claudeSpeedForOpenAiServiceTier(request.serviceTier);
    if (request.serviceTier && !targetSpeed) {
      throw unsupportedFeature(`跨协议转换到 Claude Messages 无法将 OpenAI service_tier=${request.serviceTier} 当作推理速度；仅 default/fast 可映射`);
    }
    if (request.outputFormat?.type === 'json_object') throw unsupportedFeature('跨协议转换到 Claude Messages 无法表达无 Schema 的 JSON object 输出模式');
    const toolChoice = claudeToolChoice(request);
    const reasoning = claudeReasoningOptions(request);
    const metadata = claudeTargetMetadata(request.metadata);
    if (request.temperature !== undefined && request.temperature > 1) {
      throw unsupportedFeature('Claude Messages temperature 只支持 0–1；请降低来源请求的 temperature');
    }
    if (reasoning.thinking?.type === 'enabled' && reasoning.thinking.budget_tokens < 1024) {
      throw unsupportedFeature('Claude thinking.budget_tokens 最低为 1024；请提高 Gemini thinkingBudget 或改用 thinkingLevel');
    }
    if (reasoning.thinking && reasoning.thinking.type !== 'disabled' && request.temperature !== undefined && request.temperature !== 1) {
      throw unsupportedFeature('Claude 启用 thinking 时 temperature 必须为 1 或省略；无法同时保留当前 Gemini temperature');
    }
    const maxTokens = request.maxTokens || (reasoning.thinking?.type === 'enabled'
      ? Math.max(8192, reasoning.thinking.budget_tokens + 1)
      : 8192);
    if (reasoning.thinking?.type === 'enabled' && reasoning.thinking.budget_tokens >= maxTokens) {
      throw unsupportedFeature('Claude thinking.budget_tokens 必须小于 max_tokens；请提高 Gemini maxOutputTokens 或降低 thinkingBudget');
    }
    const outputConfig = {
      ...(request.outputFormat ? { format: { type: 'json_schema', schema: request.outputFormat.schema } } : {}),
      ...(reasoning.effort ? { effort: reasoning.effort } : {})
    };
    const system = request.systemMessages?.some((item) => item.cacheControl || item.promptCacheBreakpoint)
      ? request.systemMessages.map((item) => {
        const cacheControl = item.cacheControl || (item.promptCacheBreakpoint ? { type: 'ephemeral' } : undefined);
        return { type: 'text', text: item.text, ...(cacheControl ? { cache_control: cacheControl } : {}) };
      })
      : request.system;
    const automaticCacheControl = request.cacheControl
      || (request.responsesPromptCache?.mode === 'implicit' ? { type: 'ephemeral' } : undefined);
    return {
      ...common,
      ...(request.topK !== undefined ? { top_k: request.topK } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
      ...(targetSpeed ? { speed: targetSpeed } : {}),
      max_tokens: maxTokens,
      ...(automaticCacheControl ? { cache_control: automaticCacheControl } : {}),
      ...(metadata ? { metadata } : {}),
      ...(system ? { system } : {}),
      ...(request.stop ? { stop_sequences: asArray(request.stop) } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages: mergeClaudeMessages(request.messages, options),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({
        name: tool.name, description: tool.description, input_schema: tool.schema,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {})
      })) } : {})
    };
  }

  if (protocol === 'responses') {
    const portableTools = portableCrossProtocolTools(request, 'Responses');
    const metadata = openAiTargetMetadata(request.metadata, 'Responses');
    const tools = request.responsesWebSearch && request.toolChoice?.type === 'none' ? [] : portableTools;
    const responseTools = [
      ...tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: cleanSchema(tool.schema), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) })),
      ...(request.responsesWebSearch ? [request.responsesWebSearch] : [])
    ];
    const promptCacheEnabled = supportsModernOpenAiPromptCache(request.model);
    let hasExplicitPromptCacheBreakpoint = false;
    const withPromptCacheBreakpoint = (value, breakpoint) => {
      if (!promptCacheEnabled || !breakpoint) return value;
      hasExplicitPromptCacheBreakpoint = true;
      return { ...value, prompt_cache_breakpoint: breakpoint };
    };
    unsupportedGenerationOptions(request, 'Responses', ['seed', 'presencePenalty', 'frequencyPenalty']);
    if (asArray(request.stop).length) throw unsupportedFeature('Responses API 不支持 stop/stop_sequences；请移除停止词或将模型路由设为 chat/claude');
    const input = [];
    const cachedSystemInput = promptCacheEnabled && request.systemMessages?.some((item) => item.cacheControl || item.promptCacheBreakpoint);
    const preserveSystemRoles = request.systemMessages?.some((item) => item.role === 'system');
    const systemMessagesAsInput = cachedSystemInput || preserveSystemRoles;
    if (systemMessagesAsInput) {
      for (const item of request.systemMessages) {
        const role = item.role === 'system' ? 'system' : 'developer';
        const breakpoint = item.promptCacheBreakpoint || (item.cacheControl ? { mode: 'explicit' } : undefined);
        if (breakpoint) hasExplicitPromptCacheBreakpoint = true;
        const part = {
          type: 'input_text', text: item.text,
          ...(breakpoint ? { prompt_cache_breakpoint: breakpoint } : {})
        };
        const previous = input.at(-1);
        if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(part);
        else input.push({ role, content: [part] });
      }
    }
    for (const message of request.messages) {
      const content = [];
      const actions = [];
      for (const part of message.parts) {
        if (part.providerState?.protocol === 'responses') {
          actions.push(part.providerState.value);
          continue;
        }
        const cacheBreakpoint = message.role === 'user'
          ? part.promptCacheBreakpoint || (part.cacheControl ? { mode: 'explicit' } : undefined)
          : undefined;
        if (part.type === 'text') content.push(withPromptCacheBreakpoint(message.role === 'assistant'
          ? { type: 'output_text', text: part.text, annotations: part.annotations || [] }
          : { type: 'input_text', text: portablePartText(part) }, cacheBreakpoint));
        else if (part.type === 'refusal') content.push(message.role === 'assistant'
          ? { type: 'refusal', refusal: part.text || '' }
          : withPromptCacheBreakpoint({ type: 'input_text', text: part.text || '' }, cacheBreakpoint));
        else if (part.type === 'image') {
          if (options.imageHandoffEnabled) {
            content.push(withPromptCacheBreakpoint({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: imageHandoffNotice(part) }, cacheBreakpoint));
            continue;
          }
          const image_url = imageDataUrl(part.source);
          if (!image_url && !(part.source?.type === 'file' && part.source.file_id)) throw unsupportedFeature('图片内容块缺少可转换的 URL、file_id 或 base64 数据');
          content.push(withPromptCacheBreakpoint({ type: 'input_image', ...(image_url ? { image_url } : { file_id: part.source.file_id }), ...(part.detail ? { detail: part.detail } : {}) }, cacheBreakpoint));
        }
        else if (part.type === 'file') {
          content.push(responsesFilePart(part, promptCacheEnabled ? cacheBreakpoint : undefined));
          if (promptCacheEnabled && cacheBreakpoint) hasExplicitPromptCacheBreakpoint = true;
        }
        else if (part.type === 'reasoning' && part.text) {
          content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
        }
        else if (part.type === 'tool_call') actions.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: canonicalJsonString(part.arguments) });
        else if (part.type === 'tool_result') actions.push({ type: 'function_call_output', call_id: part.id, output: portableToolResultContent(part) });
      }
      if (message.role !== 'assistant') input.push(...actions);
      if (content.length) input.push({ role: message.role, content });
      if (message.role === 'assistant') input.push(...actions);
    }
    const reasoning = responsesReasoning(request);
    const promptCacheOptions = request.responsesPromptCache
      || (request.cacheControl ? { mode: 'implicit' } : undefined)
      || (request.promptCacheSource === 'claude' && hasExplicitPromptCacheBreakpoint ? { mode: 'explicit' } : undefined);
    const textOptions = {
      ...(request.outputFormat ? { format: responsesOutputFormat(request.outputFormat) } : {}),
      ...(request.verbosity ? { verbosity: request.verbosity } : {})
    };
    return {
      ...common,
      ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
      ...(request.topLogprobs !== undefined ? { top_logprobs: request.topLogprobs } : {}),
      ...(Object.keys(textOptions).length ? { text: textOptions } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(promptCacheEnabled && promptCacheOptions ? { prompt_cache_options: promptCacheOptions } : {}),
      ...(promptCacheEnabled && request.responsesPromptCacheKey !== undefined ? { prompt_cache_key: request.responsesPromptCacheKey } : {}),
      ...(metadata ? { metadata } : {}),
      ...((request.serviceTier || openAiServiceTierForClaudeSpeed(request.speed))
        ? { service_tier: request.serviceTier || openAiServiceTierForClaudeSpeed(request.speed) }
        : {}),
      ...(request.stream && request.includeObfuscation !== undefined
        ? { stream_options: { include_obfuscation: request.includeObfuscation } }
        : {}),
      ...(request.safetyIdentifier ? { safety_identifier: request.safetyIdentifier } : {}),
      ...(request.user ? { user: request.user } : {}),
      ...(request.moderation ? { moderation: request.moderation } : {}),
      ...(request.system && !systemMessagesAsInput ? { instructions: request.system } : {}),
      ...(tools.length && request.toolChoice ? { tool_choice: formatToolChoice(request.toolChoice, 'responses') } : {}),
      ...(tools.length && request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      input,
      ...(responseTools.length ? { tools: responseTools } : {})
    };
  }

  if (request.responsesWebSearch) {
    throw unsupportedFeature('Gemini googleSearch 需要原生 Responses 上游执行；Chat Completions 没有等价的托管搜索工具');
  }
  const tools = portableCrossProtocolTools(request, 'Chat Completions');
  assertPortableResponsesReasoning(request, 'Chat Completions');
  const promptCacheEnabled = supportsModernOpenAiPromptCache(request.model);
  const initialMessages = request.systemMessages?.length
    ? request.systemMessages.map((item) => {
      const role = item.role === 'developer' ? 'developer' : 'system';
      if (promptCacheEnabled && (item.promptCacheBreakpoint || item.cacheControl)) {
        return { role, content: [{ type: 'text', text: item.text, prompt_cache_breakpoint: item.promptCacheBreakpoint || { mode: 'explicit' } }] };
      }
      if (item.cacheControl) return { role, content: item.text, cache_control: item.cacheControl };
      return { role, content: item.text };
    })
    : request.system ? [{ role: 'system', content: request.system }] : [];
  const messages = [];
  for (const message of initialMessages) {
    const previous = messages.at(-1);
    if (previous?.role === message.role && typeof previous.content === 'string' && typeof message.content === 'string'
      && previous.cache_control === undefined && message.cache_control === undefined) {
      previous.content += message.content;
    } else {
      messages.push(message);
    }
  }
  const reasoningContentSupported = usesReasoningContent(request.model);
  let hasClaudeMessagePromptCache = false;
  for (const message of request.messages) {
    const reasoningTexts = [];
    const reasoningDetails = [];
    const refusalTexts = [];
    const images = [];
    const files = [];
    const calls = [];
    const results = [];
    let callCacheControl;
    for (const part of message.parts) {
      if (!hasClaudeMessagePromptCache && part.cacheControl && part.type !== 'tool_call') {
        hasClaudeMessagePromptCache = true;
      }
      if (part.type === 'reasoning' && part.text) reasoningTexts.push(part.text);
      if (part.providerState?.protocol === 'chat') {
        if (part.providerState.kind === 'reasoning_details') {
          for (const detail of asArray(part.providerState.value?.details)) reasoningDetails.push(detail);
        } else reasoningDetails.push(part.providerState.value);
      }
      if (message.role === 'assistant' && part.type === 'refusal') refusalTexts.push(part.text || '');
      if (part.type === 'image') images.push(part);
      else if (part.type === 'file') files.push(part);
      else if (part.type === 'tool_call') {
        calls.push(part);
        if (!promptCacheEnabled && callCacheControl === undefined && part.cacheControl) callCacheControl = part.cacheControl;
      } else if (part.type === 'tool_result') results.push(part);
    }
    const reasoning = reasoningTexts.join('\n');
    const preserveReasoningField = message.role === 'assistant' && reasoning && reasoningContentSupported;
    const refusal = refusalTexts.join('');
    const chatFiles = new Map();
    for (const file of files) {
      const chatFile = promptCacheEnabled
        ? chatNativeFilePart(file, true) || chatTextDocumentPart(file, true)
        : chatTextDocumentPart(file);
      if (!chatFile) {
        throw unsupportedFeature('Chat Completions 跨协议转换无法无损表达非文本文件内容块；请将该模型路由设为 responses 或 claude');
      }
      chatFiles.set(file, chatFile);
    }
    const textFragments = [];
    const richContent = [];
    let hasCacheControl = false;
    for (const part of message.parts) {
      if (part.type === 'text') {
        const text = portablePartText(part);
        textFragments.push(text);
        if (part.cacheControl || (promptCacheEnabled && part.promptCacheBreakpoint)) hasCacheControl = true;
        richContent.push({
          type: 'text', text,
          ...(part.cacheControl && !promptCacheEnabled ? { cache_control: part.cacheControl } : {}),
          ...(promptCacheEnabled && (part.promptCacheBreakpoint || part.cacheControl)
            ? { prompt_cache_breakpoint: part.promptCacheBreakpoint || { mode: 'explicit' } }
            : {})
        });
      } else if (part.type === 'image') {
        richContent.push(chatImagePart(part, options.imageHandoffEnabled, promptCacheEnabled));
      } else if (part.type === 'file') {
        richContent.push(chatFiles.get(part));
      } else if (part.type === 'reasoning' && !preserveReasoningField && part.providerState?.protocol !== 'chat') {
        textFragments.push(portablePartText(part));
        if (part.cacheControl || (promptCacheEnabled && part.promptCacheBreakpoint)) hasCacheControl = true;
        if (part.text) richContent.push({ type: 'text', text: part.text });
      }
    }
    const text = textFragments.join('');
    for (const result of results) {
      const content = portableToolResultContent(result);
      messages.push({
        role: 'tool', tool_call_id: result.id,
        content: promptCacheEnabled && result.cacheControl
          ? [{ type: 'text', text: content, prompt_cache_breakpoint: { mode: 'explicit' } }]
          : content,
        ...(result.cacheControl && !promptCacheEnabled ? { cache_control: result.cacheControl } : {})
      });
    }
    if (text || refusal || images.length || files.length || calls.length || preserveReasoningField || reasoningDetails.length) appendChatAssistantMessage(messages, {
      role: message.role,
      content: images.length || files.length || hasCacheControl ? richContent : (text || null),
      ...(refusal ? { refusal } : {}),
      ...(message.role === 'assistant' && reasoningContentSupported && (reasoning || calls.length) ? { reasoning_content: reasoning || 'tool call' } : {}),
      ...(message.role === 'assistant' && reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      ...(calls.length ? { tool_calls: calls.map((x) => ({ id: x.id, type: 'function', function: { name: x.name, arguments: canonicalJsonString(x.arguments) } })) } : {}),
      ...(callCacheControl ? { cache_control: callCacheControl } : {})
    });
  }
  const reasoningEffort = request.reasoningEffort && (supportsReasoningEffort(request.model) || (request.reasoningEffort === 'none' && needsNonThinkingToolMode(request.model)))
    ? request.reasoningEffort
    : !request.reasoningEffort && tools.length && needsNonThinkingToolMode(request.model) ? 'none' : undefined;
  const hasClaudeExplicitPromptCache = request.promptCacheSource === 'claude'
    && (request.systemMessages?.some((item) => item.cacheControl)
      || hasClaudeMessagePromptCache);
  const promptCacheOptions = request.responsesPromptCache
    || (request.cacheControl ? { mode: 'implicit' } : undefined)
    || (hasClaudeExplicitPromptCache ? { mode: 'explicit' } : undefined);
  const metadata = openAiTargetMetadata(request.metadata, 'Chat');
  if (request.stop?.length > 4) {
    throw unsupportedFeature('Chat stop 最多支持 4 个停止序列；请减少来源请求的停止词');
  }
  return {
    ...common,
    ...(promptCacheEnabled && promptCacheOptions ? { prompt_cache_options: promptCacheOptions } : {}),
    ...(promptCacheEnabled && request.responsesPromptCacheKey !== undefined ? { prompt_cache_key: request.responsesPromptCacheKey } : {}),
    ...(metadata ? { metadata } : {}),
    ...((request.serviceTier || openAiServiceTierForClaudeSpeed(request.speed))
      ? { service_tier: request.serviceTier || openAiServiceTierForClaudeSpeed(request.speed) }
      : {}),
    ...(request.safetyIdentifier ? { safety_identifier: request.safetyIdentifier } : {}),
    ...(request.user ? { user: request.user } : {}),
    ...(request.verbosity ? { verbosity: request.verbosity } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    ...(request.maxTokens ? { [isOpenAiOSeries(request.model) ? 'max_completion_tokens' : 'max_tokens']: request.maxTokens } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    ...(request.topLogprobs !== undefined ? { logprobs: true, top_logprobs: request.topLogprobs } : {}),
    ...(request.outputFormat ? { response_format: chatOutputFormat(request.outputFormat) } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(tools.length && request.toolChoice ? { tool_choice: formatToolChoice(request.toolChoice, 'chat') } : {}),
    ...(tools.length && request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    messages,
    ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: cleanSchema(tool.schema), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }, ...(tool.cacheControl ? { cache_control: tool.cacheControl } : {}) })) } : {})
  };
}

function mergeClaudeMessages(messages, options = {}) {
  const result = [];
  for (const message of messages) {
    const role = message.role === 'developer' ? 'system' : message.role;
    const content = claudeContent(message.parts, { reasoningAsText: role === 'assistant', imageHandoffEnabled: options.imageHandoffEnabled });
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

export function prepareUpstreamRequest(body, incomingProtocol, targetProtocol, upstreamModel, options = {}) {
  assertSupportedUpstreamProtocol(targetProtocol);
  if (incomingProtocol === targetProtocol) {
    const upstreamBody = withStreamUsage({ ...body, model: upstreamModel }, targetProtocol);
    return applyCompatibilityOptions(replaceUnsupportedProtocolImages(upstreamBody, targetProtocol, options.imageHandoffEnabled), targetProtocol, options);
  }
  if (incomingProtocol === 'responses') assertPortableResponsesExecution(body, targetProtocol);
  if (incomingProtocol === 'chat') assertPortableChatExecution(body, targetProtocol);
  const responsesGeminiSearch = incomingProtocol === 'responses' && targetProtocol === 'gemini'
    ? responsesRequestForGeminiSearch(body)
    : null;
  const normalized = normalizeRequest(responsesGeminiSearch?.body || body, incomingProtocol);
  if (responsesGeminiSearch?.googleSearch) normalized.geminiGoogleSearch = true;
  if (incomingProtocol === 'gemini') applyGeminiToolNameAliases(normalized, geminiToolNameAliases(body));
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
  const geminiUsage = body?.usageMetadata;
  if (geminiUsage && !Array.isArray(geminiUsage) && typeof geminiUsage === 'object'
    && ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'totalTokenCount']
      .some((field) => Object.hasOwn(geminiUsage, field) && parsedUsageCount(geminiUsage[field]) !== null)) return true;
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  if (['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']
    .some((field) => Object.hasOwn(usage, field) && parsedUsageCount(usage[field]) !== null)) return true;
  return [usage.input_tokens_details, usage.prompt_tokens_details, usage.output_tokens_details, usage.completion_tokens_details]
    .some((details) => details && typeof details === 'object' && !Array.isArray(details)
      && ['cached_tokens', 'cache_write_tokens', 'cache_creation_tokens', 'reasoning_tokens', 'thinking_tokens']
        .some((field) => Object.hasOwn(details, field) && parsedUsageCount(details[field]) !== null))
    || Boolean(usage.cache_creation && typeof usage.cache_creation === 'object' && !Array.isArray(usage.cache_creation)
      && ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']
        .some((field) => Object.hasOwn(usage.cache_creation, field) && parsedUsageCount(usage.cache_creation[field]) !== null));
}

export function responseMetadataDegradations(body, sourceProtocol, targetProtocol) {
  if (sourceProtocol === targetProtocol || !body || Array.isArray(body) || typeof body !== 'object') return [];
  if (sourceProtocol === 'responses') {
    const response = body.response && !Array.isArray(body.response) && typeof body.response === 'object'
      ? body.response
      : body;
    return response.reasoning && !Array.isArray(response.reasoning) && typeof response.reasoning === 'object'
      && response.reasoning.context !== undefined && response.reasoning.context !== null
      ? ['responses_reasoning_context']
      : [];
  }
  if (sourceProtocol !== 'claude') return [];
  const message = body.type === 'message_start' ? body.message : body;
  const delta = body.type === 'message_delta' && body.delta && !Array.isArray(body.delta) && typeof body.delta === 'object'
    ? body.delta
    : message;
  const usage = body.type === 'message_delta' ? body.usage : message?.usage;
  const degradations = [];
  const present = (value, label) => { if (value !== undefined && value !== null) degradations.push(label); };

  present(message?.container ?? delta?.container, 'claude_container');
  present(body.type === 'message_delta' ? body.context_management : message?.context_management, 'claude_context_management');
  present(message?.diagnostics, 'claude_diagnostics');
  present(message?.stop_details ?? delta?.stop_details, 'claude_stop_details');
  present(usage?.cache_creation, 'claude_cache_creation_ttl');
  present(usage?.fallback_credit, 'claude_fallback_credit');
  present(usage?.inference_geo, 'claude_inference_geo');
  present(usage?.iterations, 'claude_iterations');
  present(usage?.server_tool_use, 'claude_server_tool_use');
  present(usage?.service_tier, 'claude_usage_service_tier');
  return degradations;
}

export function normalizeUsageCount(...candidates) {
  for (const value of candidates) {
    const parsed = parsedUsageCount(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

export function geminiUsageMetadata(inputTokens, outputTokens, cachedInputTokens = 0, reasoningTokens = 0) {
  const promptTokenCount = normalizeUsageCount(inputTokens);
  const totalOutputTokens = normalizeUsageCount(outputTokens);
  const thoughtsTokenCount = Math.min(totalOutputTokens, normalizeUsageCount(reasoningTokens));
  const candidatesTokenCount = totalOutputTokens - thoughtsTokenCount;
  const cachedContentTokenCount = normalizeUsageCount(cachedInputTokens);
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: normalizeUsageCount(promptTokenCount + totalOutputTokens),
    ...(cachedContentTokenCount ? { cachedContentTokenCount } : {}),
    ...(thoughtsTokenCount ? { thoughtsTokenCount } : {})
  };
}

export function responsesResponseConfig(options = {}) {
  const metadata = options.metadata && !Array.isArray(options.metadata) && typeof options.metadata === 'object'
    ? options.metadata
    : {};
  return {
    error: null,
    incomplete_details: null,
    instructions: options.instructions ?? null,
    metadata,
    parallel_tool_calls: typeof options.parallelToolCalls === 'boolean' ? options.parallelToolCalls : true,
    temperature: typeof options.temperature === 'number' && Number.isFinite(options.temperature) ? options.temperature : 1,
    tool_choice: options.toolChoice ?? 'auto',
    tools: Array.isArray(options.tools) ? options.tools : [],
    top_p: typeof options.topP === 'number' && Number.isFinite(options.topP) ? options.topP : 1,
    background: options.background ?? false,
    conversation: null,
    max_output_tokens: Number.isSafeInteger(options.maxOutputTokens) ? options.maxOutputTokens : null,
    previous_response_id: null,
    prompt: null,
    reasoning: options.reasoning ?? null,
    store: options.store ?? false,
    text: options.text ?? { format: { type: 'text' } },
    truncation: options.truncation ?? 'disabled',
    user: options.user ?? null,
    ...(options.safetyIdentifier ? { safety_identifier: options.safetyIdentifier } : {}),
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    ...(options.promptCacheRetention ? { prompt_cache_retention: options.promptCacheRetention } : {})
  };
}

function applyCompatibilityOptions(body, protocol, options) {
  if (protocol !== 'chat' || options.toolChoiceFallback !== 'auto' || !asArray(body.tools).length || !body.tool_choice || body.tool_choice === 'none' || body.tool_choice === 'auto') return body;
  return { ...body, tool_choice: 'auto' };
}

function validateResponsesWebSearchCall(item, label) {
  if (!item || Array.isArray(item) || typeof item !== 'object') throw new Error(`${label} 必须是对象`);
  if (typeof item.id !== 'string' || !item.id) throw new Error(`${label}.id 必须是非空字符串`);
  if (item.status !== undefined && !['in_progress', 'searching', 'completed', 'failed'].includes(item.status)) {
    throw new Error(`${label}.status 无效：${item.status}`);
  }
  if (item.action !== undefined && (!item.action || Array.isArray(item.action) || typeof item.action !== 'object')) {
    throw new Error(`${label}.action 必须是对象`);
  }
  if (item.action?.type !== undefined && !['search', 'open_page', 'find_in_page'].includes(item.action.type)) {
    throw new Error(`${label}.action.type 无效：${item.action.type}`);
  }
  if (item.action?.query !== undefined && typeof item.action.query !== 'string') throw new Error(`${label}.action.query 必须是字符串`);
  if (item.action?.queries !== undefined && (!Array.isArray(item.action.queries) || item.action.queries.some((query) => typeof query !== 'string'))) {
    throw new Error(`${label}.action.queries 必须是字符串数组`);
  }
}

function responsesWebSearchQueries(item) {
  if (item?.action?.type !== 'search') return [];
  return [...asArray(item.action.queries), item.action.query].filter((query) => typeof query === 'string' && query);
}

export function isPortableClaudeStopReason(value) {
  return typeof value === 'string' && CLAUDE_STOP_REASONS.has(value);
}

export function isPortableChatFinishReason(value) {
  return typeof value === 'string' && CHAT_FINISH_REASONS.has(value);
}

export function isPortableGeminiFinishReason(value) {
  return typeof value === 'string' && GEMINI_PORTABLE_FINISH_REASONS.has(value);
}

function assertPortableToolStopConsistency(parts, reason, protocol) {
  const hasTools = parts.some((part) => part.type === 'tool_call');
  const toolReason = protocol === 'claude' ? reason === 'tool_use' : ['tool_calls', 'function_call'].includes(reason);
  const normalReason = protocol === 'claude' ? ['end_turn', 'stop_sequence'].includes(reason) : reason === 'stop';
  if (toolReason && !hasTools) throw new Error(`上游 ${protocol} 停止原因为 ${reason}，但响应不包含工具调用`);
  if (hasTools && normalReason) throw new Error(`上游 ${protocol} 响应包含工具调用，但停止原因为 ${reason}`);
}

function assertPortableClaudeEnvelope(body) {
  if (body.type !== undefined && body.type !== 'message') {
    throw new Error(`上游 Claude 响应 type 无效：${String(body.type)}`);
  }
  if (body.role !== undefined && body.role !== 'assistant') {
    throw new Error(`上游 Claude 响应 role 无效：${String(body.role)}`);
  }
  if (body.stop_reason === 'stop_sequence') {
    if (typeof body.stop_sequence !== 'string' || !body.stop_sequence) {
      throw new Error('上游 Claude stop_reason=stop_sequence，但 stop_sequence 不是非空字符串');
    }
  } else if (body.stop_sequence !== undefined && body.stop_sequence !== null) {
    throw new Error(`上游 Claude stop_reason=${String(body.stop_reason || 'missing')}，但 stop_sequence 非空`);
  }
}

function assertPortableResponsesOutputItemState(item, responseStatus, label) {
  if (!['message', 'function_call', 'reasoning'].includes(item.type) || item.status === undefined) return;
  if (!['in_progress', 'completed', 'incomplete'].includes(item.status)) {
    throw new Error(`${label}.status 无效：${String(item.status)}`);
  }
  if (responseStatus === 'completed' && item.status !== 'completed') {
    throw new Error(`${label}.status=${item.status} 与 response.status=completed 不一致`);
  }
  if ((responseStatus === 'incomplete' || responseStatus === undefined) && item.status === 'in_progress') {
    throw new Error(`${label}.status=in_progress 不能出现在终态响应中`);
  }
}

function assertPortableResponsesTerminalState(body) {
  if (body.error !== undefined && body.error !== null) {
    throw new Error('上游 Responses 响应包含 error，不能跨协议伪装为成功响应');
  }
  if (body.status === undefined) return;
  if (body.status === 'completed') return;
  if (body.status === 'incomplete') {
    const reason = body.incomplete_details?.reason;
    if (FILTER_STOP_REASONS.has(reason) || TRUNCATION_STOP_REASONS.has(reason)) return;
    throw new Error(`上游 Responses incomplete_details.reason 无法跨协议转换：${String(reason || 'missing')}`);
  }
  throw new Error(`上游 Responses status=${String(body.status)} 无法跨协议转换为终态响应`);
}

function assertPortableResponseIdentity(body, protocol) {
  const idField = protocol === 'gemini' ? 'responseId' : 'id';
  const modelField = protocol === 'gemini' ? 'modelVersion' : 'model';
  for (const field of [idField, modelField]) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field])) {
      throw new Error(`上游 ${protocol} 响应 ${field} 必须是非空字符串`);
    }
  }
  if (protocol === 'responses' && body.object !== undefined && body.object !== 'response') {
    throw new Error(`上游 Responses 响应 object 无效：${String(body.object)}`);
  }
  if (protocol === 'chat' && body.object !== undefined && body.object !== 'chat.completion') {
    throw new Error(`上游 Chat 响应 object 无效：${String(body.object)}`);
  }
}

function appendResponsesReasoningParts(target, value, {
  field, expectedType, reasoningKind, label, rejectUnknown
}) {
  if (value === undefined) return;
  if (rejectUnknown && !Array.isArray(value)) throw new Error(`${label}.${field} 必须是数组`);
  for (const [index, part] of asArray(value).entries()) {
    const objectPart = part && !Array.isArray(part) && typeof part === 'object';
    const text = objectPart ? part.text : undefined;
    const valid = objectPart && part.type === expectedType && typeof text === 'string';
    if (!valid) {
      if (rejectUnknown) throw new Error(`${label}.${field}[${index}] 必须是 ${expectedType} 文本块`);
      continue;
    }
    if (text) target.push({ type: 'reasoning', reasoningKind, text });
  }
}

export function normalizeResponse(body, protocol, fallbackModel = '', { rejectUnknown = false, allowWebSearchCall = false } = {}) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('上游响应必须是 JSON 对象');
  if (protocol === 'claude' && !Array.isArray(body.content)) throw new Error('上游 Claude 响应缺少 content 数组');
  if (protocol === 'responses' && !Array.isArray(body.output)) throw new Error('上游 Responses 响应缺少 output 数组');
  if (protocol === 'chat' && (!Array.isArray(body.choices) || !body.choices[0]?.message || typeof body.choices[0].message !== 'object')) {
    throw new Error('上游 Chat 响应缺少 choices[0].message');
  }
  if (rejectUnknown) assertPortableResponseIdentity(body, protocol);
  if (protocol === 'gemini') {
    if (!Array.isArray(body.candidates)) throw new Error('上游 Gemini 响应缺少 candidates 数组');
    const inputTokens = normalizeUsageCount(body.usageMetadata?.promptTokenCount);
    const candidateTokens = normalizeUsageCount(body.usageMetadata?.candidatesTokenCount);
    const reasoningTokens = normalizeUsageCount(body.usageMetadata?.thoughtsTokenCount);
    const outputTokens = normalizeUsageCount(candidateTokens + reasoningTokens);
    if (!body.candidates.length) {
      const blockReason = body.promptFeedback?.blockReason;
      if (typeof blockReason !== 'string' || !blockReason || blockReason === 'BLOCK_REASON_UNSPECIFIED') {
        throw new Error('上游 Gemini 响应没有候选内容且缺少 promptFeedback.blockReason');
      }
      if (rejectUnknown && !GEMINI_BLOCK_REASONS.has(blockReason)) {
        throw new Error(`上游 Gemini promptFeedback.blockReason 无法跨协议转换：${blockReason}`);
      }
      return {
        id: body.responseId, model: body.modelVersion || fallbackModel, parts: [],
        inputTokens, outputTokens,
        cachedInputTokens: normalizeUsageCount(body.usageMetadata?.cachedContentTokenCount),
        cacheCreationInputTokens: 0, reasoningTokens,
        stopReason: FILTER_STOP_REASONS.has(blockReason) ? blockReason : 'SAFETY'
      };
    }
    const candidate = body.candidates[0];
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') throw new Error('上游 Gemini candidates[0] 必须是对象');
    if (rejectUnknown && body.candidates.length > 1) throw new Error(`上游 Gemini 返回了 ${body.candidates.length} 个候选，跨协议只能保留一个候选`);
    if (rejectUnknown && candidate.index !== undefined && candidate.index !== 0) {
      throw new Error(`上游 Gemini 候选 index=${String(candidate.index)}，跨协议只能保留 index=0`);
    }
    if (rejectUnknown && !isPortableGeminiFinishReason(candidate.finishReason)) {
      throw new Error(`上游 Gemini finishReason 无法跨协议转换：${String(candidate.finishReason || 'missing')}`);
    }
    if (rejectUnknown && candidate.content?.role !== undefined && candidate.content.role !== 'model') {
      throw new Error(`上游 Gemini candidates[0].content.role 无效：${String(candidate.content.role)}`);
    }
    const filtered = FILTER_STOP_REASONS.has(candidate.finishReason);
    if ((!candidate.content || !Array.isArray(candidate.content.parts)) && !filtered) {
      throw new Error('上游 Gemini 响应缺少 candidates[0].content.parts');
    }
    const parts = candidate.content?.parts
      ? normalizeGeminiParts(candidate.content.parts, { rejectUnknown })
      : [];
    const logprobs = normalizeGeminiLogprobs(candidate);
    const firstText = parts.find((part) => part.type === 'text');
    if (logprobs?.length) {
      if (!firstText) throw new Error('Gemini logprobsResult 缺少对应文本内容');
      firstText.logprobs = logprobs;
    }
    const grounding = normalizeGeminiGroundingMetadata(candidate, {
      ...(firstText ? { textLength: Array.from(firstText.text || '').length } : {})
    });
    if (grounding.annotations.length) {
      if (!firstText) throw new Error('Gemini groundingMetadata 缺少对应文本内容');
      firstText.annotations = grounding.annotations;
    }
    return {
      id: body.responseId, model: body.modelVersion || fallbackModel,
      parts,
      inputTokens,
      outputTokens,
      cachedInputTokens: normalizeUsageCount(body.usageMetadata?.cachedContentTokenCount),
      cacheCreationInputTokens: 0,
      reasoningTokens,
      stopReason: candidate.finishReason,
      ...(grounding.webSearchQueries.length ? { webSearchQueries: grounding.webSearchQueries } : {})
    };
  }
  if (protocol === 'claude') {
    const parts = normalizeParts(body.content, { includeReasoning: true, rejectUnknown, claudeCompactionResponse: rejectUnknown });
    if (body.stop_reason === 'refusal') {
      for (const part of parts) if (part.type === 'text') part.type = 'refusal';
    }
    if (rejectUnknown) {
      if (!isPortableClaudeStopReason(body.stop_reason)) {
        throw new Error(`上游 Claude stop_reason 无法跨协议转换：${String(body.stop_reason || 'missing')}`);
      }
      assertPortableClaudeEnvelope(body);
      assertPortableToolStopConsistency(parts, body.stop_reason, 'claude');
    }
    const speed = body.usage?.speed;
    if (rejectUnknown && speed != null && !CLAUDE_SPEEDS.has(speed)) {
      throw new Error(`上游 Claude usage.speed 无效：${String(speed)}`);
    }
    return {
    id: body.id, model: body.model || fallbackModel,
    parts,
    ...(CLAUDE_SPEEDS.has(speed) ? { speed } : {}),
    inputTokens: normalizeUsageCount(body.usage?.input_tokens), outputTokens: normalizeUsageCount(body.usage?.output_tokens),
    cachedInputTokens: normalizeUsageCount(body.usage?.cache_read_input_tokens),
    cacheCreationInputTokens: normalizeUsageCount(body.usage?.cache_creation_input_tokens),
    cacheCreation5mInputTokens: normalizeUsageCount(body.usage?.cache_creation?.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens: normalizeUsageCount(body.usage?.cache_creation?.ephemeral_1h_input_tokens),
    reasoningTokens: normalizeUsageCount(body.usage?.output_tokens_details?.thinking_tokens),
    stopReason: body.stop_reason
    };
  }
  if (protocol === 'responses') {
    if (rejectUnknown) assertPortableResponsesTerminalState(body);
    const parts = [];
    const webSearchQueries = [];
    const webSearchQuerySet = new Set();
    for (const [index, item] of asArray(body.output).entries()) {
      if (!item || Array.isArray(item) || typeof item !== 'object') throw new Error(`上游 Responses output[${index}] 必须是对象`);
      if (rejectUnknown) {
        if (typeof item.type !== 'string' || !item.type) throw new Error(`上游 Responses output[${index}].type 必须是非空字符串`);
        if (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) {
          throw new Error(`上游 Responses output[${index}].id 必须是非空字符串`);
        }
        assertPortableResponsesOutputItemState(item, body.status, `上游 Responses output[${index}]`);
      }
      if (item?.type === 'web_search_call' && allowWebSearchCall) {
        validateResponsesWebSearchCall(item, `上游 Responses output[${index}] web_search_call`);
        for (const query of responsesWebSearchQueries(item)) {
          if (webSearchQuerySet.has(query)) continue;
          webSearchQuerySet.add(query);
          webSearchQueries.push(query);
        }
        continue;
      }
      if (item.type === 'message') {
        if (!Array.isArray(item.content)) throw new Error(`上游 Responses output[${index}].content 必须是数组`);
        if (rejectUnknown && item.role !== undefined && item.role !== 'assistant') {
          throw new Error(`上游 Responses output[${index}].role 无效：${item.role}`);
        }
        parts.push(...normalizeParts(item.content, { rejectUnknown }));
      }
      if (item.type === 'function_call') {
        if (rejectUnknown && item.caller !== undefined) throw new Error('上游 Responses 程序调用包含无法跨协议保留的 caller 关联');
        const callId = item.call_id || item.id;
        if (typeof callId !== 'string' || !callId) throw new Error(`上游 Responses output[${index}] function_call 缺少 call_id/id`);
        if (typeof item.name !== 'string' || !item.name) throw new Error(`上游 Responses output[${index}] function_call 缺少 name`);
        parts.push({
          type: 'tool_call', id: callId, name: item.name,
          arguments: sanitizeToolArguments(item.name, normalizedOutputToolArguments(item.arguments, `上游 Responses output[${index}].arguments`))
        });
      }
      if (item.type === 'reasoning') {
        const itemLabel = `上游 Responses output[${index}]`;
        if (rejectUnknown) {
          if (item.encrypted_content !== undefined && item.encrypted_content !== null
            && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
            throw new Error(`${itemLabel}.encrypted_content 必须是非空字符串或 null`);
          }
        }
        const providerState = typeof item.encrypted_content === 'string' && item.encrypted_content
          ? { protocol: 'responses', kind: 'reasoning', value: item }
          : undefined;
        const reasoningParts = [];
        appendResponsesReasoningParts(reasoningParts, item.summary, {
          field: 'summary', expectedType: 'summary_text', reasoningKind: 'summary', label: itemLabel, rejectUnknown
        });
        appendResponsesReasoningParts(reasoningParts, item.content, {
          field: 'content', expectedType: 'reasoning_text', reasoningKind: 'content', label: itemLabel, rejectUnknown
        });
        if (reasoningParts.length) {
          if (providerState) reasoningParts[0].providerState = providerState;
          parts.push(...reasoningParts);
        } else if (providerState) parts.push({ type: 'provider_state', providerState });
      }
      if (item.type === 'compaction') {
        validateResponsesCompactionItem(item, `上游 Responses output[${index}] compaction`, (message) => { throw new Error(message); });
        parts.push({
          type: 'provider_state',
          providerState: { protocol: 'responses', kind: 'compaction', value: item }
        });
      }
      if (rejectUnknown && ['program', 'program_output'].includes(item.type)) throw new Error(`上游 Responses ${item.type} 程序运行项无法跨协议转换`);
      if (rejectUnknown && !['message', 'function_call', 'reasoning', 'compaction'].includes(item.type)) throw new Error(`上游 Responses 输出项类型无法跨协议转换：${item.type || 'unknown'}`);
    }
    return {
      id: body.id, model: body.model || fallbackModel, parts,
      ...(webSearchQueries.length ? { webSearchQueries } : {}),
      ...(Number.isSafeInteger(body.created_at) ? { createdAt: body.created_at } : {}),
      ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}),
      inputTokens: normalizeUsageCount(body.usage?.input_tokens, body.usage?.prompt_tokens), outputTokens: normalizeUsageCount(body.usage?.output_tokens, body.usage?.completion_tokens),
      cachedInputTokens: normalizeUsageCount(body.usage?.cache_read_input_tokens, body.usage?.prompt_cache_hit_tokens, body.usage?.input_tokens_details?.cached_tokens, body.usage?.prompt_tokens_details?.cached_tokens),
      cacheCreationInputTokens: normalizeUsageCount(body.usage?.cache_creation_input_tokens, body.usage?.input_tokens_details?.cache_write_tokens, body.usage?.input_tokens_details?.cache_creation_tokens, body.usage?.prompt_tokens_details?.cache_write_tokens, body.usage?.prompt_tokens_details?.cache_creation_tokens),
      reasoningTokens: normalizeUsageCount(body.usage?.output_tokens_details?.reasoning_tokens, body.usage?.completion_tokens_details?.reasoning_tokens),
      stopReason: responsesStopReason(body)
    };
  }
  const choice = body.choices?.[0] || {};
  if (rejectUnknown && body.choices.length > 1) throw new Error(`上游 Chat 返回了 ${body.choices.length} 个候选，跨协议只能保留一个候选`);
  if (rejectUnknown && choice.index !== undefined && choice.index !== 0) {
    throw new Error(`上游 Chat 候选 index=${String(choice.index)}，跨协议只能保留 index=0`);
  }
  const message = choice.message || {};
  if (rejectUnknown && message.role !== undefined && message.role !== 'assistant') {
    throw new Error(`上游 Chat choices[0].message.role 无效：${String(message.role)}`);
  }
  if (rejectUnknown) {
    for (const field of ['refusal', 'reasoning_content', 'reasoning']) {
      if (message[field] !== undefined && message[field] !== null && typeof message[field] !== 'string') {
        throw new Error(`上游 Chat choices[0].message.${field} 必须是字符串或 null`);
      }
    }
  }
  const parts = normalizeParts(message.content, { rejectUnknown });
  const chatLogprobs = normalizeTokenLogprobs(choice.logprobs?.content, 'Chat choices[0].logprobs.content');
  if (chatLogprobs?.length) {
    const firstText = parts.find((part) => part.type === 'text');
    if (!firstText) throw new Error('Chat logprobs 缺少对应文本内容');
    firstText.logprobs = chatLogprobs;
  }
  if (message.refusal) parts.push({ type: 'refusal', text: message.refusal });
  const messageReasoning = message.reasoning_content || message.reasoning;
  const reasoningDetails = normalizedChatReasoningDetails(message.reasoning_details);
  if (reasoningDetails.length) parts.unshift(...reasoningDetails);
  else if (messageReasoning) parts.unshift({ type: 'reasoning', text: messageReasoning });
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('上游 Chat message.tool_calls 必须是数组');
  for (const [index, call] of asArray(message.tool_calls).entries()) {
    if (!call || Array.isArray(call) || typeof call !== 'object') throw new Error(`上游 Chat message.tool_calls[${index}] 必须是对象`);
    if (call.type !== undefined && call.type !== 'function') throw new Error(`上游 Chat message.tool_calls[${index}].type 无法跨协议转换：${call.type}`);
    if (typeof call.id !== 'string' || !call.id) throw new Error(`上游 Chat message.tool_calls[${index}] 缺少 id`);
    if (typeof call.function?.name !== 'string' || !call.function.name) throw new Error(`上游 Chat message.tool_calls[${index}] 缺少 function.name`);
    parts.push({
      type: 'tool_call', id: call.id, name: call.function.name,
      arguments: sanitizeToolArguments(call.function.name, normalizedOutputToolArguments(call.function.arguments, `上游 Chat message.tool_calls[${index}].function.arguments`))
    });
  }
  if (message.function_call) {
    if (Array.isArray(message.function_call) || typeof message.function_call !== 'object') throw new Error('上游 Chat message.function_call 必须是对象');
    if (typeof message.function_call.name !== 'string' || !message.function_call.name) throw new Error('上游 Chat message.function_call 缺少 name');
    parts.push({
      type: 'tool_call', id: message.function_call.id || `call_${randomUUID().replaceAll('-', '')}`, name: message.function_call.name,
      arguments: sanitizeToolArguments(message.function_call.name, normalizedOutputToolArguments(message.function_call.arguments, '上游 Chat message.function_call.arguments'))
    });
  }
  if (rejectUnknown) {
    if (!isPortableChatFinishReason(choice.finish_reason)) {
      throw new Error(`上游 Chat finish_reason 无法跨协议转换：${String(choice.finish_reason || 'missing')}`);
    }
    assertPortableToolStopConsistency(parts, choice.finish_reason, 'chat');
  }
  return {
    id: body.id, model: body.model || fallbackModel, parts,
    ...(Number.isSafeInteger(body.created) ? { createdAt: body.created } : {}),
    ...(typeof body.service_tier === 'string' ? { serviceTier: body.service_tier } : {}),
    ...(typeof body.system_fingerprint === 'string' ? { systemFingerprint: body.system_fingerprint } : {}),
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
    const partSummary = assertOutputPartsSupported(
      response.parts, protocol,
      new Set(['text', 'refusal', 'reasoning', 'provider_state', 'tool_call', 'image', 'file']),
      { collectProviderStates: true, classifyAnnotations: true }
    );
    const formatted = geminiResponseParts(
      response.parts, responsesOptions.geminiToolAliases, partSummary.providerStates,
      !partSummary.hasNonUrlAnnotations
    );
    const webSearchQueries = asArray(response.webSearchQueries);
    const hasWebSearchQueries = webSearchQueries.some((query) => typeof query === 'string' && query);
    const groundingMetadata = partSummary.hasUrlCitations
      ? geminiGroundingMetadata(response.parts, { webSearchQueries })
      : hasWebSearchQueries ? geminiGroundingMetadata([], { webSearchQueries }) : undefined;
    return {
      candidates: [{
        content: { role: 'model', parts: formatted.parts }, finishReason: geminiFinishReason(partSummary.hasRefusal ? 'refusal' : response.stopReason), index: 0,
        ...(groundingMetadata ? { groundingMetadata } : {}),
        ...geminiLogprobFields(formatted.logprobs)
      }],
      usageMetadata: geminiUsageMetadata(response.inputTokens, response.outputTokens, response.cachedInputTokens, response.reasoningTokens),
      ...(response.model ? { modelVersion: response.model } : {}),
      ...(response.id ? { responseId: response.id } : {})
    };
  }
  if (protocol === 'claude') {
    const { hasRefusal, hasTools } = inspectOutputParts(response.parts);
    const speed = response.speed || claudeSpeedForOpenAiServiceTier(response.serviceTier);
    return {
    id: response.id || `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: response.model,
    content: claudeResponseContent(response.parts), stop_reason: claudeStopReason(hasRefusal ? 'refusal' : response.stopReason, hasTools), stop_sequence: null,
    usage: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens,
      ...(response.cachedInputTokens ? { cache_read_input_tokens: response.cachedInputTokens } : {}),
      ...(response.cacheCreationInputTokens ? { cache_creation_input_tokens: response.cacheCreationInputTokens } : {}),
      ...(response.reasoningTokens ? { output_tokens_details: { thinking_tokens: response.reasoningTokens } } : {}),
      ...(speed ? { speed } : {})
    }
    };
  }
  if (protocol === 'responses') {
    const { hasRefusal, hasTools } = assertOutputPartsSupported(
      response.parts, protocol, new Set(['text', 'refusal', 'reasoning', 'provider_state', 'tool_call'])
    );
    const portableStopReason = hasRefusal && response.stopReason === 'refusal' ? 'end_turn' : response.stopReason;
    const resolveToolIdentity = hasTools
      ? createResponsesToolIdentityResolver(responsesOptions.tools)
      : null;
    const incompleteReason = responsesIncompleteReason(portableStopReason);
    const incomplete = Boolean(incompleteReason);
    const itemStatus = incomplete ? 'incomplete' : 'completed';
    const createdAt = Number.isSafeInteger(response.createdAt) ? response.createdAt : Math.floor(Date.now() / 1000);
    return {
    id: response.id || `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: createdAt, status: 'completed', model: response.model,
    ...((response.serviceTier || openAiServiceTierForClaudeSpeed(response.speed))
      ? { service_tier: response.serviceTier || openAiServiceTierForClaudeSpeed(response.speed) }
      : {}),
    ...responsesResponseConfig(responsesOptions),
    ...(!incomplete ? { completed_at: Math.max(createdAt, Math.floor(Date.now() / 1000)) } : { completed_at: null }),
    ...(incomplete ? { status: 'incomplete', incomplete_details: { reason: incompleteReason } } : {}),
    output: response.parts.flatMap((part, index) => {
      if (part.providerState?.protocol === 'responses' && part.providerState.kind === 'compaction') {
        return part.providerState.value;
      }
      if (part.type === 'tool_call') {
        const identity = resolveToolIdentity(part.name);
        if (identity.kind === 'custom') return { id: `ctc_${index}`, type: 'custom_tool_call', status: itemStatus, call_id: part.id, name: identity.name, input: customToolInput(part.arguments) };
        if (identity.kind === 'tool_search') return { id: `tsc_${index}`, type: 'tool_search_call', status: itemStatus, execution: 'client', call_id: part.id, arguments: toolSearchArguments(part.arguments) };
        return { id: `fc_${index}`, type: 'function_call', status: itemStatus, call_id: part.id, ...identity, arguments: canonicalJsonString(part.arguments) };
      }
      if (part.type === 'reasoning' || part.type === 'provider_state') return {
        id: `rs_${index}`, type: 'reasoning', status: itemStatus,
        summary: part.type === 'reasoning' && part.reasoningKind !== 'content' && part.text ? [{ type: 'summary_text', text: part.text }] : [],
        ...(part.type === 'reasoning' && part.reasoningKind === 'content' && part.text
          ? { content: [{ type: 'reasoning_text', text: part.text }] }
          : {}),
        ...(part.providerState ? { encrypted_content: encodedProviderState(part) } : {})
      };
      if (part.type === 'text') return { id: `msg_${index}`, type: 'message', status: itemStatus, role: 'assistant', content: [{ type: 'output_text', text: part.text || '', annotations: part.annotations || [], ...(part.logprobs ? { logprobs: openAiTokenLogprobs(part.logprobs) } : {}) }] };
      if (part.type === 'refusal') return { id: `msg_${index}`, type: 'message', status: itemStatus, role: 'assistant', content: [{ type: 'refusal', refusal: part.text || '' }] };
      return [];
    }),
    usage: {
      input_tokens: response.inputTokens, output_tokens: response.outputTokens, total_tokens: normalizeUsageCount(response.inputTokens + response.outputTokens),
      input_tokens_details: { cached_tokens: response.cachedInputTokens || 0, cache_write_tokens: response.cacheCreationInputTokens || 0 },
      output_tokens_details: { reasoning_tokens: response.reasoningTokens || 0 }
    }
    };
  }
  const partSummary = assertOutputPartsSupported(
    response.parts, protocol, new Set(['text', 'refusal', 'reasoning', 'provider_state', 'tool_call'])
  );
  const portableStopReason = partSummary.hasRefusal && response.stopReason === 'refusal' ? 'end_turn' : response.stopReason;
  const chatParts = formatChatResponseParts(response.parts, !partSummary.hasPortableAnnotations);
  return {
    id: response.id || `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Number.isSafeInteger(response.createdAt) ? response.createdAt : Math.floor(Date.now() / 1000), model: response.model,
    ...((response.serviceTier || openAiServiceTierForClaudeSpeed(response.speed))
      ? { service_tier: response.serviceTier || openAiServiceTierForClaudeSpeed(response.speed) }
      : {}),
    ...(response.systemFingerprint ? { system_fingerprint: response.systemFingerprint } : {}),
    choices: [{ index: 0, message: { role: 'assistant', content: chatParts.text || null,
      ...(partSummary.hasRefusal ? { refusal: chatParts.refusal } : {}),
      ...(partSummary.hasReasoning ? { reasoning_content: chatParts.reasoning } : {}),
      ...(chatParts.reasoningDetails.length ? { reasoning_details: chatParts.reasoningDetails } : {}),
      ...(partSummary.hasTools ? { tool_calls: chatParts.toolCalls } : {}) },
      finish_reason: chatStopReason(portableStopReason, partSummary.hasTools),
      ...(!partSummary.hasPortableAnnotations && partSummary.hasLogprobs
        ? { logprobs: { content: openAiTokenLogprobs(chatParts.logprobs) } }
        : {})
    }],
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

function formatChatResponseParts(parts, collectLogprobs) {
  const text = [];
  const refusal = [];
  const reasoning = [];
  const reasoningDetails = [];
  const toolParts = [];
  const logprobs = [];
  for (const [index, part] of parts.entries()) {
    const data = encodedProviderState(part);
    if (data) {
      reasoningDetails.push(part.type === 'reasoning'
        ? {
            type: 'reasoning.text', text: part.text || '', signature: data,
            id: `reasoning-text-${index}`, format: 'anthropic-claude-v1', index
          }
        : {
            type: 'reasoning.encrypted', data,
            id: `reasoning-encrypted-${index}`, format: 'anthropic-claude-v1', index
          });
    }
    if (part.type === 'text') text.push(portablePartText(part));
    else if (part.type === 'refusal') refusal.push(part.text);
    else if (part.type === 'reasoning') reasoning.push(part.text);
    else if (part.type === 'tool_call') toolParts.push(part);
    if (collectLogprobs && part.logprobs) logprobs.push(...asArray(part.logprobs));
  }
  return {
    text: text.join(''),
    refusal: refusal.join(''),
    reasoning: reasoning.join(''),
    reasoningDetails,
    toolCalls: toolParts.map((part) => ({
      id: part.id, type: 'function',
      function: { name: part.name, arguments: canonicalJsonString(part.arguments) }
    })),
    logprobs
  };
}

export function openAiTokenLogprobs(logprobs) {
  return normalizeTokenLogprobs(logprobs).map((entry) => ({
    token: entry.token, logprob: entry.logprob, ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    top_logprobs: (entry.topLogprobs || []).map((top) => ({ token: top.token, logprob: top.logprob, ...(top.bytes !== undefined ? { bytes: top.bytes } : {}) }))
  }));
}

function geminiResponsePart(part, restoreToolName) {
  if (part.type === 'text' || part.type === 'refusal') return {
    text: `${part.text || ''}${portableAnnotationText(part.annotations, { excludeUrlCitations: true })}`
  };
  if (part.type === 'reasoning') return {
    text: part.text || '', thought: true,
    ...(part.providerState ? { thoughtSignature: encodedProviderState(part) } : part.signature ? { thoughtSignature: part.signature } : {})
  };
  if (part.type === 'provider_state') return { text: '', thought: true, thoughtSignature: encodedProviderState(part) };
  if (part.type === 'tool_call') return { functionCall: {
    name: restoreToolName(part.name),
    args: sanitizeToolArguments(part.name, part.arguments),
    ...(part.id ? { id: part.id } : {})
  } };
  const source = part.source;
  if (source?.type === 'base64') return { inlineData: { mimeType: source.media_type || (part.type === 'image' ? 'image/png' : 'application/octet-stream'), data: source.data || '' } };
  if (source?.type === 'url') return geminiDataUrlPart(source)
    || { fileData: { mimeType: source.media_type || (part.type === 'image' ? 'image/*' : 'application/octet-stream'), fileUri: source.url } };
  throw unsupportedFeature(`Gemini 无法表达 ${part.type} file_id；请改用 URL 或 base64 数据`);
}

function encodedGeminiProviderStates(states) {
  if (!states.length) return undefined;
  return states.length === 1
    ? encodeReasoningState(states[0].protocol, states[0].kind, states[0].value)
    : encodeReasoningStateBundle(states);
}

function geminiResponseParts(parts, toolAliases, providerStates, collectLogprobs) {
  const signature = encodedGeminiProviderStates(providerStates);
  const restoreToolName = createGeminiToolNameRestorer(toolAliases);
  const output = [];
  const logprobs = [];
  let attached = false;
  let lastThought;
  for (const part of parts) {
    if (collectLogprobs && part.logprobs) logprobs.push(...asArray(part.logprobs));
    if (part.type === 'provider_state') continue;
    const formatted = geminiResponsePart({
      ...part,
      providerState: undefined,
      ...(part.providerState ? { signature: undefined } : {})
    }, restoreToolName);
    if (!attached && signature && part.type === 'tool_call') {
      attached = true;
      output.push({ ...formatted, thoughtSignature: signature });
      continue;
    }
    output.push(formatted);
    if (formatted.thought === true && typeof formatted.text === 'string' && formatted.text) lastThought = formatted;
  }
  if (signature && !attached) {
    if (lastThought) lastThought.thoughtSignature = signature;
    else output.push({ text: GEMINI_BRIDGE_STATE_TEXT, thought: true, thoughtSignature: signature });
  }
  return { parts: output, logprobs };
}

export function geminiFinishReason(reason) {
  if (TRUNCATION_STOP_REASONS.has(reason)) return 'MAX_TOKENS';
  if (FILTER_STOP_REASONS.has(reason)) return /^[A-Z_]+$/.test(reason || '') ? reason : 'SAFETY';
  return 'STOP';
}

function inspectOutputParts(parts, protocol, supported, {
  collectProviderStates = false, classifyAnnotations = false
} = {}) {
  const unsupported = [];
  const seenUnsupported = new Set();
  const providerStates = collectProviderStates ? [] : undefined;
  let hasRefusal = false;
  let hasReasoning = false;
  let hasTools = false;
  let hasPortableAnnotations = false;
  let hasUrlCitations = false;
  let hasNonUrlAnnotations = false;
  let hasLogprobs = false;
  for (const part of parts) {
    if (part.type === 'refusal') hasRefusal = true;
    else if (part.type === 'reasoning') hasReasoning = true;
    else if (part.type === 'tool_call') hasTools = true;
    if (part.annotations?.length) hasPortableAnnotations = true;
    if (classifyAnnotations) {
      for (const annotation of asArray(part.annotations)) {
        if (annotation?.type === 'url_citation') hasUrlCitations = true;
        else hasNonUrlAnnotations = true;
      }
    }
    if (part.logprobs?.length) hasLogprobs = true;
    if (providerStates && part.providerState) providerStates.push(part.providerState);
    const unsupportedType = supported && !supported.has(part.type) ? part.type || 'unknown' : undefined;
    if (unsupportedType !== undefined && !seenUnsupported.has(unsupportedType)) {
      seenUnsupported.add(unsupportedType);
      unsupported.push(unsupportedType);
    }
  }
  if (unsupported.length) throw unsupportedFeature(`跨协议转换到 ${protocol} 时无法表达上游响应内容块：${unsupported.join(', ')}`);
  return {
    hasRefusal, hasReasoning, hasTools, hasPortableAnnotations, hasUrlCitations, hasNonUrlAnnotations, hasLogprobs,
    ...(providerStates ? { providerStates } : {})
  };
}

function assertOutputPartsSupported(parts, protocol, supported, options) {
  return inspectOutputParts(parts, protocol, supported, options);
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
  return reason === 'content_filter' ? 'content_filter' : 'max_tokens';
}

export function responsesIncompleteReason(reason) {
  if (FILTER_STOP_REASONS.has(reason)) return 'content_filter';
  if (TRUNCATION_STOP_REASONS.has(reason)) return 'max_output_tokens';
  return null;
}

export function claudeStopReason(reason, hasTools = false) {
  if (FILTER_STOP_REASONS.has(reason)) return 'refusal';
  if (reason === 'model_context_window_exceeded') return reason;
  if (['pause_turn', 'compaction'].includes(reason)) return reason;
  if (TRUNCATION_STOP_REASONS.has(reason)) return 'max_tokens';
  if (hasTools) return 'tool_use';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

export function chatStopReason(reason, partsOrHasTools = false) {
  if (FILTER_STOP_REASONS.has(reason)) return 'content_filter';
  if (TRUNCATION_STOP_REASONS.has(reason)) return 'length';
  const hasTools = Array.isArray(partsOrHasTools)
    ? partsOrHasTools.some((part) => part.type === 'tool_call')
    : Boolean(partsOrHasTools);
  if (hasTools) return 'tool_calls';
  return 'stop';
}
