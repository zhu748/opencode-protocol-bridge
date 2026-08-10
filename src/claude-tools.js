export const CLAUDE_TOOL_CALLERS = new Set(['direct', 'code_execution_20260120', 'code_execution_20260521']);

export function validateClaudeCacheControl(value, label, fail = (message) => { throw new Error(message); }) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
  const unsupported = Object.keys(value).filter((key) => !['type', 'ttl'].includes(key));
  if (unsupported.length) fail(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
  if (value.type !== 'ephemeral') fail(`${label}.type 必须是 ephemeral`);
  if (value.ttl !== undefined && !['5m', '1h'].includes(value.ttl)) fail(`${label}.ttl 必须是 5m 或 1h`);
  return value;
}

export function validateClaudeToolOptionalFields(tool, index, fail = (message) => { throw new Error(message); }) {
  const label = `Claude tools[${index}]`;
  if (tool.description !== undefined && typeof tool.description !== 'string') fail(`${label}.description 必须是字符串`);
  if (tool.input_schema !== undefined && (!tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema))) {
    fail(`${label}.input_schema 必须是对象`);
  }
  validateClaudeCacheControl(tool.cache_control, `${label}.cache_control`, fail);
  if (tool.defer_loading !== undefined && typeof tool.defer_loading !== 'boolean') fail(`${label}.defer_loading 必须是布尔值`);
  if (tool.strict !== undefined && typeof tool.strict !== 'boolean') fail(`${label}.strict 必须是布尔值`);
  if (tool.allowed_callers !== undefined && (!Array.isArray(tool.allowed_callers) || tool.allowed_callers.length === 0
    || tool.allowed_callers.some((caller) => typeof caller !== 'string' || !CLAUDE_TOOL_CALLERS.has(caller))
    || new Set(tool.allowed_callers).size !== tool.allowed_callers.length)) {
    fail(`${label}.allowed_callers 必须是无重复的有效调用方数组`);
  }
  if (tool.input_examples !== undefined && (!Array.isArray(tool.input_examples)
    || tool.input_examples.some((example) => !example || typeof example !== 'object' || Array.isArray(example)))) {
    fail(`${label}.input_examples 必须是对象数组`);
  }
  if (tool.eager_input_streaming !== undefined && typeof tool.eager_input_streaming !== 'boolean') {
    fail(`${label}.eager_input_streaming 必须是布尔值`);
  }
}

export function validateClaudeThinkingBlock(block, label = 'Claude 内容块', fail = (message) => { throw new Error(message); }) {
  if (block?.type === 'thinking') {
    if (typeof block.thinking !== 'string') fail(`${label}.thinking 必须是字符串`);
    if (typeof block.signature !== 'string' || !block.signature) fail(`${label}.signature 必须是非空字符串`);
  } else if (block?.type === 'redacted_thinking') {
    if (typeof block.data !== 'string' || !block.data) fail(`${label}.data 必须是非空字符串`);
  }
  return block;
}

export function validateClaudeFallbackBlock(block, label = 'Claude fallback 块', fail = (message) => { throw new Error(message); }) {
  if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'fallback') fail(`${label} 必须是 fallback 对象`);
  if (!block.from || typeof block.from !== 'object' || Array.isArray(block.from)
    || typeof block.from.model !== 'string' || !block.from.model) fail(`${label}.from.model 必须是非空字符串`);
  if (!block.to || typeof block.to !== 'object' || Array.isArray(block.to)
    || typeof block.to.model !== 'string' || !block.to.model) fail(`${label}.to.model 必须是非空字符串`);
  return block;
}

export function validateClaudeCompactionBlock(block, label = 'Claude compaction 块', fail = (message) => { throw new Error(message); }, { response = false } = {}) {
  if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'compaction') fail(`${label} 必须是 compaction 对象`);
  const allowed = response
    ? new Set(['type', 'content', 'encrypted_content'])
    : new Set(['type', 'content', 'encrypted_content', 'cache_control']);
  const unsupported = Object.keys(block).filter((key) => !allowed.has(key));
  if (unsupported.length) fail(`${label} 包含不支持的字段：${unsupported.join(', ')}`);
  if (response && (!Object.hasOwn(block, 'content') || !Object.hasOwn(block, 'encrypted_content'))) {
    fail(`${label} 响应必须同时包含 content 与 encrypted_content`);
  }
  if (response && (block.content === undefined || block.encrypted_content === undefined)) {
    fail(`${label} 响应的 content 与 encrypted_content 不能省略`);
  }
  if (block.content !== undefined && block.content !== null
    && (typeof block.content !== 'string' || !block.content)) {
    fail(`${label}.content 必须是非空字符串或 null`);
  }
  if (block.encrypted_content !== undefined && block.encrypted_content !== null
    && (typeof block.encrypted_content !== 'string' || !block.encrypted_content)) {
    fail(`${label}.encrypted_content 必须是非空字符串或 null`);
  }
  if (!response) validateClaudeCacheControl(block.cache_control, `${label}.cache_control`, fail);
  return block;
}

export function addClaudeToolReferenceNames(names, content) {
  if (!Array.isArray(content)) return names;
  for (const block of content) {
    if (block?.type === 'tool_reference' && typeof block.tool_name === 'string' && block.tool_name) {
      names.add(block.tool_name);
    }
  }
  return names;
}

export function claudeToolReferenceNames(messages) {
  const names = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const parts = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message?.parts) ? message.parts : [];
    for (const part of parts) {
      if (part?.type === 'tool_result') addClaudeToolReferenceNames(names, part.content);
    }
  }
  return names;
}
