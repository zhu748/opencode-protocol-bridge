import { randomUUID } from 'node:crypto';

export const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024;

function assertSseEventSize(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_SSE_EVENT_BYTES) {
    throw Object.assign(new Error('上游 SSE 单个事件超过 8 MiB 上限'), { code: 'UPSTREAM_SSE_EVENT_TOO_LARGE' });
  }
}

function parseSseBlock(block) {
  const lines = block.split(/\r\n|\r|\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return { event, data: JSON.parse(data) }; }
  catch { return { event: 'error', data: { error: { message: '上游返回了无法解析的 SSE 数据' } } }; }
}

async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r\n\r\n|\r\r|\n\n/)) !== -1) {
      const block = buffer.slice(0, boundary);
      assertSseEventSize(block);
      const separator = buffer.slice(boundary).match(/^(?:\r\n\r\n|\r\r|\n\n)/)[0];
      buffer = buffer.slice(boundary + separator.length);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
    }
    assertSseEventSize(buffer);
  }
  buffer += decoder.decode();
  assertSseEventSize(buffer);
  const parsed = parseSseBlock(buffer.trim());
  if (parsed) yield parsed;
}

async function* canonicalEvents(response, protocol, fallbackModel, { rejectUnsupportedContent = false } = {}) {
  let started = false;
  let id;
  let model = fallbackModel;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let reasoningTokens = 0;
  const chatTools = new Map();
  const responseBlocks = new Map();
  let chatTextStarted = false;
  let chatReasoningStarted = false;
  let chatFinishReason;
  let chatBlocksClosed = false;
  let terminal = false;

  for await (const { data } of parseSse(response.body)) {
    if (data.error || data.type === 'error') {
      terminal = true;
      yield { type: 'error', error: data.error || data };
      return;
    }
    if (protocol === 'claude') {
      if (data.type === 'message_start') {
        started = true; id = data.message?.id; model = data.message?.model || model;
        inputTokens = data.message?.usage?.input_tokens || 0;
        cachedInputTokens = data.message?.usage?.cache_read_input_tokens || 0;
        cacheCreationInputTokens = data.message?.usage?.cache_creation_input_tokens || 0;
        yield { type: 'start', id, model, inputTokens, cachedInputTokens, cacheCreationInputTokens };
      } else if (data.type === 'content_block_start') {
        const block = data.content_block || {};
        if (block.type === 'tool_use') yield { type: 'block_start', sourceIndex: data.index, blockType: 'tool', id: block.id, name: block.name };
        else if (block.type === 'text') yield { type: 'block_start', sourceIndex: data.index, blockType: 'text' };
        else if (block.type === 'thinking') yield { type: 'block_start', sourceIndex: data.index, blockType: 'reasoning' };
      } else if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta') yield { type: 'text_delta', sourceIndex: data.index, delta: data.delta.text || '' };
        if (data.delta?.type === 'input_json_delta') yield { type: 'tool_delta', sourceIndex: data.index, delta: data.delta.partial_json || '' };
        if (data.delta?.type === 'thinking_delta') yield { type: 'reasoning_delta', sourceIndex: data.index, delta: data.delta.thinking || '' };
      } else if (data.type === 'content_block_stop') yield { type: 'block_stop', sourceIndex: data.index };
      else if (data.type === 'message_delta') {
        terminal = true;
        yield { type: 'done', stopReason: data.delta?.stop_reason, outputTokens: data.usage?.output_tokens || 0, inputTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens };
      }
      continue;
    }

    if (protocol === 'responses') {
      if (data.type === 'response.created') {
        started = true; id = data.response?.id; model = data.response?.model || model;
        inputTokens = data.response?.usage?.input_tokens ?? data.response?.usage?.prompt_tokens ?? 0;
        cachedInputTokens = data.response?.usage?.input_tokens_details?.cached_tokens || 0;
        cacheCreationInputTokens = data.response?.usage?.cache_creation_input_tokens || data.response?.usage?.input_tokens_details?.cache_creation_tokens || 0;
        yield { type: 'start', id, model, inputTokens, cachedInputTokens, cacheCreationInputTokens };
      } else if (data.type === 'response.output_item.added') {
        const item = data.item || {};
        const blockType = item.type === 'function_call' ? 'tool' : item.type === 'reasoning' ? 'reasoning' : item.type === 'message' ? 'text' : undefined;
        if (blockType) {
          const state = responseBlocks.get(data.output_index) || { pending: '', emitted: '', started: false };
          Object.assign(state, { blockType, started: true, id: item.call_id || item.id, name: item.name });
          responseBlocks.set(data.output_index, state);
          yield { type: 'block_start', sourceIndex: data.output_index, blockType, id: state.id, name: state.name };
          if (state.pending) {
            yield { type: blockType === 'tool' ? 'tool_delta' : blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta', sourceIndex: data.output_index, delta: state.pending };
            state.emitted += state.pending;
            state.pending = '';
          }
        }
      } else if (['response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(data.type)) {
        const blockType = data.type === 'response.function_call_arguments.delta' ? 'tool' : data.type.includes('reasoning') ? 'reasoning' : 'text';
        const state = responseBlocks.get(data.output_index) || { pending: '', emitted: '', started: false, blockType };
        const delta = data.delta || '';
        responseBlocks.set(data.output_index, state);
        if (state.started) {
          state.emitted += delta;
          yield { type: blockType === 'tool' ? 'tool_delta' : blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta', sourceIndex: data.output_index, delta };
        } else state.pending += delta;
      } else if (['response.output_text.done', 'response.refusal.done', 'response.function_call_arguments.done', 'response.reasoning_summary_text.done', 'response.reasoning_text.done'].includes(data.type)) {
        const state = responseBlocks.get(data.output_index);
        const complete = data.arguments ?? data.text ?? data.refusal ?? '';
        if (state?.started && complete.startsWith(state.emitted) && complete.length > state.emitted.length) {
          const delta = complete.slice(state.emitted.length);
          state.emitted = complete;
          yield { type: state.blockType === 'tool' ? 'tool_delta' : state.blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta', sourceIndex: data.output_index, delta };
        }
      } else if (data.type === 'response.output_item.done') {
        const state = responseBlocks.get(data.output_index);
        const item = data.item || {};
        const complete = state?.blockType === 'tool' ? item.arguments
          : state?.blockType === 'reasoning' ? asText(item.summary, 'summary_text')
            : asText(item.content, ['output_text', 'refusal']);
        if (state?.started && typeof complete === 'string' && complete.startsWith(state.emitted) && complete.length > state.emitted.length) {
          const delta = complete.slice(state.emitted.length);
          state.emitted = complete;
          yield { type: state.blockType === 'tool' ? 'tool_delta' : state.blockType === 'reasoning' ? 'reasoning_delta' : 'text_delta', sourceIndex: data.output_index, delta };
        }
        if (state?.started) yield { type: 'block_stop', sourceIndex: data.output_index };
      }
      else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
        terminal = true;
        yield {
          type: 'done', stopReason: data.type === 'response.completed' ? 'end_turn' : (data.response?.incomplete_details?.reason || 'incomplete'), inputTokens: data.response?.usage?.input_tokens ?? data.response?.usage?.prompt_tokens ?? 0,
          outputTokens: data.response?.usage?.output_tokens ?? data.response?.usage?.completion_tokens ?? 0,
          cachedInputTokens: data.response?.usage?.input_tokens_details?.cached_tokens || 0,
          cacheCreationInputTokens: data.response?.usage?.cache_creation_input_tokens || data.response?.usage?.input_tokens_details?.cache_creation_tokens || 0,
          reasoningTokens: data.response?.usage?.output_tokens_details?.reasoning_tokens || 0
        };
      }
      else if (data.type === 'response.failed') {
        terminal = true;
        yield { type: 'error', error: data.response?.error || { message: 'Responses 上游生成失败' } };
        return;
      }
      continue;
    }

    const choice = data.choices?.[0];
    if (data.usage) {
      inputTokens = data.usage.prompt_tokens ?? data.usage.input_tokens ?? inputTokens;
      cachedInputTokens = data.usage.prompt_tokens_details?.cached_tokens || cachedInputTokens;
      cacheCreationInputTokens = data.usage.cache_creation_input_tokens || data.usage.prompt_tokens_details?.cache_creation_tokens || cacheCreationInputTokens;
      reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
    }
    if (!started) {
      started = true; id = data.id; model = data.model || model;
      inputTokens = data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0;
      cachedInputTokens = data.usage?.prompt_tokens_details?.cached_tokens || 0;
      cacheCreationInputTokens = data.usage?.cache_creation_input_tokens || data.usage?.prompt_tokens_details?.cache_creation_tokens || 0;
      yield { type: 'start', id, model, inputTokens, cachedInputTokens, cacheCreationInputTokens };
    }
    const reasoningDelta = choice?.delta?.reasoning_content || choice?.delta?.reasoning;
    const contentDelta = chatContentText(choice?.delta?.content, rejectUnsupportedContent) || choice?.delta?.refusal || '';
    if (reasoningDelta && !chatReasoningStarted) {
      chatReasoningStarted = true;
      yield { type: 'block_start', sourceIndex: 'reasoning', blockType: 'reasoning' };
    }
    if (reasoningDelta) yield { type: 'reasoning_delta', sourceIndex: 'reasoning', delta: reasoningDelta };
    if (contentDelta && !chatTextStarted) {
      chatTextStarted = true;
      yield { type: 'block_start', sourceIndex: 'text', blockType: 'text' };
    }
    if (contentDelta) yield { type: 'text_delta', sourceIndex: 'text', delta: contentDelta };
    const toolDeltas = [...(choice?.delta?.tool_calls || [])];
    if (choice?.delta?.function_call) toolDeltas.push({ index: 0, id: choice.delta.function_call.id, function: choice.delta.function_call });
    for (const call of toolDeltas) {
      const sourceIndex = `tool-${call.index ?? 0}`;
      let state = chatTools.get(sourceIndex);
      if (!state) {
        state = { id: '', name: '', pending: '', started: false };
        chatTools.set(sourceIndex, state);
      }
      if (call.id) state.id = call.id;
      if (call.function?.name) state.name = call.function.name;
      const argumentsDelta = call.function?.arguments || '';
      if (!state.started && argumentsDelta) state.pending += argumentsDelta;
      if (!state.started && state.id && state.name) {
        state.started = true;
        yield { type: 'block_start', sourceIndex, blockType: 'tool', id: state.id, name: state.name };
        if (state.pending) {
          yield { type: 'tool_delta', sourceIndex, delta: state.pending };
          state.pending = '';
        }
      } else if (state.started && argumentsDelta) {
        yield { type: 'tool_delta', sourceIndex, delta: argumentsDelta };
      }
    }
    if (choice?.finish_reason && !chatBlocksClosed) {
      if (chatReasoningStarted) yield { type: 'block_stop', sourceIndex: 'reasoning' };
      if (chatTextStarted) yield { type: 'block_stop', sourceIndex: 'text' };
      for (const [sourceIndex, state] of chatTools) {
        if (!state.started && (state.id || state.name || state.pending)) {
          state.started = true;
          yield { type: 'block_start', sourceIndex, blockType: 'tool', id: state.id || `call_${randomUUID().replaceAll('-', '')}`, name: state.name || 'unknown_tool' };
          if (state.pending) yield { type: 'tool_delta', sourceIndex, delta: state.pending };
        }
        if (state.started) yield { type: 'block_stop', sourceIndex };
      }
      chatBlocksClosed = true;
      chatFinishReason = choice.finish_reason;
    }
    if (chatFinishReason && data.usage) {
      terminal = true;
      yield {
        type: 'done', stopReason: chatFinishReason, inputTokens, outputTokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0,
        cachedInputTokens, cacheCreationInputTokens, reasoningTokens
      };
      chatFinishReason = undefined;
    }
  }
  if (protocol === 'chat' && chatFinishReason) {
    terminal = true;
    yield { type: 'done', stopReason: chatFinishReason, inputTokens, outputTokens: 0, cachedInputTokens, cacheCreationInputTokens, reasoningTokens };
  }
  if (started && !terminal) yield { type: 'error', error: { type: 'upstream_error', message: '上游 SSE 在完成事件前结束' } };
}

function asText(parts, expectedType) {
  const expected = Array.isArray(expectedType) ? expectedType : [expectedType];
  return Array.isArray(parts) ? parts.filter((part) => expected.includes(part?.type)).map((part) => part.text || part.refusal || '').join('') : undefined;
}

function chatContentText(content, rejectUnsupportedContent = false) {
  if (typeof content === 'string') return content;
  const unsupported = Array.isArray(content)
    ? content.filter((part) => part && typeof part === 'object' && !['text', 'output_text', 'refusal'].includes(part.type))
    : [];
  if (rejectUnsupportedContent && unsupported.length) throw Object.assign(new Error(`跨协议转换无法表达 Chat 流式内容块：${unsupported.map((part) => part.type || 'unknown').join(', ')}`), { code: 'UPSTREAM_UNSUPPORTED_STREAM_CONTENT' });
  return asText(content, ['text', 'output_text', 'refusal']) || '';
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chatSse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function* translateSse(response, sourceProtocol, targetProtocol, fallbackModel, options = {}) {
  const id = targetProtocol === 'claude' ? `msg_${randomUUID().replaceAll('-', '')}`
    : targetProtocol === 'responses' ? `resp_${randomUUID().replaceAll('-', '')}`
      : `chatcmpl-${randomUUID()}`;
  let responseId = id;
  let model = fallbackModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let reasoningTokens = 0;
  let targetIndex = 0;
  let chatToolIndex = 0;
  const indices = new Map();
  const blocks = new Map();
  let responseStarted = false;

  for await (const event of canonicalEvents(response, sourceProtocol, fallbackModel, { rejectUnsupportedContent: sourceProtocol !== targetProtocol })) {
    if (event.type === 'error') {
      options.onError?.(event.error);
      if (targetProtocol === 'chat') {
        yield chatSse({ error: event.error });
        yield 'data: [DONE]\n\n';
      } else yield sse('error', { type: 'error', error: event.error });
      return;
    }
    if (event.type === 'start') {
      responseStarted = true;
      responseId = event.id || responseId; model = event.model || model; inputTokens = event.inputTokens || 0; cachedInputTokens = event.cachedInputTokens || 0; cacheCreationInputTokens = event.cacheCreationInputTokens || 0;
      if (targetProtocol === 'claude') yield sse('message_start', { type: 'message_start', message: { id: responseId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0, ...(cachedInputTokens ? { cache_read_input_tokens: cachedInputTokens } : {}), ...(cacheCreationInputTokens ? { cache_creation_input_tokens: cacheCreationInputTokens } : {}) } } });
      else if (targetProtocol === 'responses') yield sse('response.created', { type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [], usage: null } });
      else yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      continue;
    }
    if (!responseStarted) continue;
    if (event.type === 'block_start') {
      const index = targetIndex++;
      indices.set(event.sourceIndex, index);
      blocks.set(index, { type: event.blockType, id: event.id || `call_${randomUUID().replaceAll('-', '')}`, name: event.name || '', text: '', arguments: '', ...(event.blockType === 'tool' ? { chatToolIndex: chatToolIndex++ } : {}) });
      if (targetProtocol === 'claude') {
        const content_block = event.blockType === 'tool' ? { type: 'tool_use', id: blocks.get(index).id, name: blocks.get(index).name, input: {} }
          : event.blockType === 'reasoning' ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' };
        yield sse('content_block_start', { type: 'content_block_start', index, content_block });
      } else if (targetProtocol === 'responses') {
        const item = event.blockType === 'tool'
          ? { id: `fc_${randomUUID().replaceAll('-', '')}`, type: 'function_call', status: 'in_progress', call_id: blocks.get(index).id, name: blocks.get(index).name, arguments: '' }
          : event.blockType === 'reasoning'
            ? { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', status: 'in_progress', summary: [] }
            : { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
        blocks.get(index).item = item;
        yield sse('response.output_item.added', { type: 'response.output_item.added', output_index: index, item });
        if (event.blockType === 'text') yield sse('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        if (event.blockType === 'reasoning') yield sse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      } else if (targetProtocol === 'chat' && event.blockType === 'tool') {
        const block = blocks.get(index);
        yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: block.chatToolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'text_delta' || event.type === 'tool_delta' || event.type === 'reasoning_delta') {
      const index = indices.get(event.sourceIndex);
      if (index === undefined) continue;
      const block = blocks.get(index);
      if (event.type === 'text_delta' || event.type === 'reasoning_delta') block.text += event.delta;
      else block.arguments += event.delta;
      if (targetProtocol === 'claude' && event.type === 'tool_delta' && block.name === 'Read') continue;
      if (targetProtocol === 'claude') {
        const delta = event.type === 'text_delta' ? { type: 'text_delta', text: event.delta }
          : event.type === 'reasoning_delta' ? { type: 'thinking_delta', thinking: event.delta }
            : { type: 'input_json_delta', partial_json: event.delta };
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta });
      } else if (targetProtocol === 'responses') {
        const name = event.type === 'text_delta' ? 'response.output_text.delta'
          : event.type === 'reasoning_delta' ? 'response.reasoning_summary_text.delta'
            : 'response.function_call_arguments.delta';
        yield sse(name, { type: name, item_id: block.item.id, output_index: index, ...(event.type === 'text_delta' ? { content_index: 0 } : {}), ...(event.type === 'reasoning_delta' ? { summary_index: 0 } : {}), delta: event.delta });
      } else if (event.type === 'text_delta') {
        yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] });
      } else if (event.type === 'reasoning_delta') {
        yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] });
      } else {
        yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: block.chatToolIndex, function: { arguments: event.delta } }] }, finish_reason: null }] });
      }
      continue;
    }
    if (event.type === 'block_stop') {
      const index = indices.get(event.sourceIndex);
      if (index === undefined) continue;
      const block = blocks.get(index);
      if (targetProtocol === 'claude') {
        if (block.type === 'tool' && block.name === 'Read' && block.arguments) {
          let argumentsText = block.arguments;
          try {
            const parsed = JSON.parse(argumentsText);
            if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && parsed.pages === '') {
              delete parsed.pages;
              argumentsText = JSON.stringify(parsed);
            }
          } catch { /* 保留无法解析的原始工具参数 */ }
          yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argumentsText } });
        }
        if (block.type === 'reasoning') yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'bridge' } });
        yield sse('content_block_stop', { type: 'content_block_stop', index });
      }
      else if (targetProtocol === 'responses') {
        if (block.type === 'text') {
          const part = { type: 'output_text', text: block.text, annotations: [] };
          yield sse('response.output_text.done', { type: 'response.output_text.done', item_id: block.item.id, output_index: index, content_index: 0, text: block.text });
          yield sse('response.content_part.done', { type: 'response.content_part.done', item_id: block.item.id, output_index: index, content_index: 0, part });
          block.item.content = [part];
        } else if (block.type === 'reasoning') {
          const part = { type: 'summary_text', text: block.text };
          yield sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: block.item.id, output_index: index, summary_index: 0, text: block.text });
          yield sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: block.item.id, output_index: index, summary_index: 0, part });
          block.item.summary = [part];
        } else {
          yield sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: block.item.id, output_index: index, arguments: block.arguments });
          block.item.arguments = block.arguments;
        }
        block.item.status = 'completed';
        yield sse('response.output_item.done', { type: 'response.output_item.done', output_index: index, item: block.item });
      }
      continue;
    }
    if (event.type === 'done') {
      inputTokens = event.inputTokens || inputTokens; outputTokens = event.outputTokens || 0; cachedInputTokens = event.cachedInputTokens || cachedInputTokens; cacheCreationInputTokens = event.cacheCreationInputTokens || cacheCreationInputTokens; reasoningTokens = event.reasoningTokens || 0;
      options.onUsage?.({ inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens });
      const hasTools = [...blocks.values()].some((block) => block.type === 'tool');
      if (targetProtocol === 'claude') {
        const stopReason = hasTools ? 'tool_use' : (['length', 'max_tokens', 'max_output_tokens'].includes(event.stopReason) ? 'max_tokens' : 'end_turn');
        yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        yield sse('message_stop', { type: 'message_stop' });
      } else if (targetProtocol === 'responses') {
        const output = [...blocks.values()].map((block) => block.item).filter(Boolean);
        const incomplete = ['length', 'max_tokens', 'max_output_tokens'].includes(event.stopReason);
        const inputDetails = (cachedInputTokens || cacheCreationInputTokens) ? { ...(cachedInputTokens ? { cached_tokens: cachedInputTokens } : {}), ...(cacheCreationInputTokens ? { cache_creation_tokens: cacheCreationInputTokens } : {}) } : undefined;
        const final = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed', ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), model, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, ...(inputDetails ? { input_tokens_details: inputDetails } : {}), ...(reasoningTokens ? { output_tokens_details: { reasoning_tokens: reasoningTokens } } : {}) } };
        yield sse(incomplete ? 'response.incomplete' : 'response.completed', { type: incomplete ? 'response.incomplete' : 'response.completed', response: final });
      } else {
        const promptDetails = (cachedInputTokens || cacheCreationInputTokens) ? { ...(cachedInputTokens ? { cached_tokens: cachedInputTokens } : {}), ...(cacheCreationInputTokens ? { cache_creation_tokens: cacheCreationInputTokens } : {}) } : undefined;
        yield chatSse({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? 'tool_calls' : (['length', 'max_tokens', 'max_output_tokens'].includes(event.stopReason) ? 'length' : 'stop') }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}), ...(reasoningTokens ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}) } });
        yield 'data: [DONE]\n\n';
      }
    }
  }
}

export async function observeSse(response, protocol, fallbackModel, options = {}) {
  let usage = {};
  let error;
  try {
    for await (const event of canonicalEvents(response, protocol, fallbackModel)) {
      if (event.type === 'done') {
        usage = {
          inputTokens: event.inputTokens || 0,
          outputTokens: event.outputTokens || 0,
          cachedInputTokens: event.cachedInputTokens || 0,
          cacheCreationInputTokens: event.cacheCreationInputTokens || 0,
          reasoningTokens: event.reasoningTokens || 0
        };
        options.onUsage?.(usage);
      } else if (event.type === 'error') {
        error = event.error;
        options.onError?.(error);
      }
    }
  } catch (caught) {
    if (caught.code === 'UPSTREAM_SSE_EVENT_TOO_LARGE') return { usage, error: undefined, observationSkipped: caught.message };
    error = { type: 'upstream_error', message: caught.message };
    options.onError?.(error);
  }
  return { usage, error };
}
