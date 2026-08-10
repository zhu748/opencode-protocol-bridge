import { claudeToolReferenceNames, validateClaudeCacheControl, validateClaudeCompactionBlock, validateClaudeFallbackBlock, validateClaudeThinkingBlock, validateClaudeToolOptionalFields } from './claude-tools.js';

const PROMPT_FIELDS = ['system', 'messages', 'tools', 'tool_choice', 'thinking'];
const CONSERVATIVE_IMAGE_TOKENS = 4784;

function invalidRequest(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function validateCacheControl(value, label) {
  return validateClaudeCacheControl(value, label, invalidRequest);
}

function validateClaudeCacheControls(body) {
  validateCacheControl(body.cache_control, 'Claude cache_control');
  const system = Array.isArray(body.system) ? body.system : [body.system];
  for (const [index, block] of system.entries()) {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      validateCacheControl(block.cache_control, `Claude system[${index}].cache_control`);
    }
  }
  for (const [messageIndex, message] of body.messages.entries()) {
    const content = Array.isArray(message?.content) ? message.content : [message?.content];
    for (const [partIndex, part] of content.entries()) {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        validateCacheControl(part.cache_control, `Claude messages[${messageIndex}].content[${partIndex}].cache_control`);
      }
    }
  }
}

function validateClaudeThinkingBlocks(messages) {
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of (Array.isArray(message?.content) ? message.content : []).entries()) {
      if (part?.type === 'thinking' || part?.type === 'redacted_thinking') {
        validateClaudeThinkingBlock(part, `Claude messages[${messageIndex}].content[${partIndex}]`, invalidRequest);
      }
      if (part?.type === 'fallback') {
        validateClaudeFallbackBlock(part, `Claude messages[${messageIndex}].content[${partIndex}]`, invalidRequest);
      }
      if (part?.type === 'compaction') {
        validateClaudeCompactionBlock(part, `Claude messages[${messageIndex}].content[${partIndex}]`, invalidRequest);
      }
    }
  }
}

function textTokens(text) {
  const value = String(text);
  let tokens = 0;
  let asciiWordLength = 0;
  const flushAsciiWord = () => {
    if (!asciiWordLength) return;
    tokens += Math.ceil(asciiWordLength / 4);
    asciiWordLength = 0;
  };
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 48 && codePoint <= 57) || (codePoint >= 65 && codePoint <= 90) || codePoint === 95 || (codePoint >= 97 && codePoint <= 122)) {
      asciiWordLength++;
      continue;
    }
    flushAsciiWord();
    if (codePoint === 10) tokens += 0.25;
    else if (codePoint === 9 || codePoint === 13 || codePoint === 32 || codePoint === 0xa0) tokens += 0.1;
    else if (codePoint <= 0x7f) tokens += 0.5;
    else if ((codePoint >= 0x3040 && codePoint <= 0x30ff)
      || (codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0xac00 && codePoint <= 0xd7af)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)) tokens += 1;
    else tokens += 0.75;
  }
  flushAsciiWord();
  return Math.max(tokens, Buffer.byteLength(value) / 2);
}

function valueTokens(value) {
  let tokens = 0;
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') tokens += textTokens(item);
    else if (typeof item === 'number' || typeof item === 'boolean') tokens += 1;
    else if (Array.isArray(item)) {
      tokens += 1;
      for (const child of item) stack.push(child);
    } else if (item && typeof item === 'object') {
      if (item.type === 'compaction') {
        // encrypted_content is server-only round-trip metadata, not model-visible
        // prompt text. Count the summary and cache marker but not the ciphertext.
        tokens += 1;
        for (const [key, child] of Object.entries(item)) {
          if (key === 'encrypted_content') continue;
          tokens += textTokens(key) + 0.5;
          stack.push(child);
        }
        continue;
      }
      if (item.type === 'image' && item.source && typeof item.source === 'object') {
        // Claude resizes images to a model-specific visual token budget. Use
        // the current high-resolution ceiling instead of counting base64 text.
        tokens += CONSERVATIVE_IMAGE_TOKENS;
        for (const [key, child] of Object.entries(item)) {
          if (key === 'source') continue;
          tokens += textTokens(key) + 0.5;
          stack.push(child);
        }
        continue;
      }
      tokens += 1;
      for (const [key, child] of Object.entries(item)) {
        tokens += textTokens(key) + 0.5;
        stack.push(child);
      }
    }
  }
  return tokens;
}

function containsToolResult(message) {
  return message?.role === 'user' && Array.isArray(message.content)
    && message.content.some((part) => part?.type === 'tool_result');
}

function countableMessages(messages) {
  let currentTurnStart = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === 'user' && !containsToolResult(message)) currentTurnStart = index;
  }
  return messages.map((message, index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content) || index > currentTurnStart) return message;
    const content = message.content.filter((part) => !['thinking', 'redacted_thinking'].includes(part?.type));
    return content.length === message.content.length ? message : { ...message, content };
  });
}

function countableTools(tools, messages) {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) invalidRequest('tools 必须是数组');
  const references = claudeToolReferenceNames(messages);
  let hasLoadedTool = false;
  const toolsByName = new Map();
  const visible = tools.filter((tool, index) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      invalidRequest(`tools[${index}] 必须是对象`);
    }
    if (typeof tool.name !== 'string' || !tool.name) {
      invalidRequest(`tools[${index}].name 必须是非空字符串`);
    }
    if (toolsByName.has(tool.name)) {
      invalidRequest(`工具名称重复：${tool.name}`);
    }
    toolsByName.set(tool.name, tool);
    validateClaudeToolOptionalFields(tool, index, invalidRequest);
    if (tool.defer_loading !== true) hasLoadedTool = true;
    return tool.defer_loading !== true || references.has(tool.name);
  });
  for (const name of references) {
    const tool = toolsByName.get(name);
    if (!tool) invalidRequest(`tool_reference 引用了未定义工具：${name}`);
    if (tool.defer_loading !== true) invalidRequest(`tool_reference 只能引用 defer_loading=true 的工具：${name}`);
  }
  if (tools.length && !hasLoadedTool) {
    invalidRequest('至少一个工具必须设置 defer_loading=false');
  }
  return visible.length ? visible : undefined;
}

export function estimateClaudeInputTokens(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalidRequest('请求体必须是 JSON 对象');
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256) {
    invalidRequest('model 必须是长度 1–256 的非空字符串');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    invalidRequest('messages 必须是非空数组');
  }
  validateClaudeCacheControls(body);
  validateClaudeThinkingBlocks(body.messages);
  const prompt = {
    ...body,
    messages: countableMessages(body.messages),
    tools: countableTools(body.tools, body.messages)
  };
  const count = PROMPT_FIELDS.reduce((total, field) => total + valueTokens(prompt[field]), 0);
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(count)));
}
