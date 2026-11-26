'use strict';

const { normalizeBaseUrl, messagesFor, toolsFor, sseData, responseChunk, httpError, postStream } = require('./provider-wire.cjs');

const { SIWC_RESOURCE_URL, formatSiwcError } = require('./siwc.cjs');

const SIGNATURE_PREFIX = 'agy-openai-reasoning-v1:';

function signatureFor(call, prefix) {
  if (prefix.some(item => item.type === 'reasoning' && !item.encrypted_content)) {
    throw new Error('OpenAI did not return encrypted reasoning for the tool call');
  }
  return Buffer.from(SIGNATURE_PREFIX + JSON.stringify({ call, prefix })).toString('base64');
}

function signatureFrom(signature) {
  if (!signature) return undefined;
  const decoded = Buffer.from(signature, 'base64').toString();
  if (!decoded.startsWith(SIGNATURE_PREFIX)) return undefined;
  const metadata = JSON.parse(decoded.slice(SIGNATURE_PREFIX.length));
  if (metadata.call?.type !== 'function_call' || !metadata.call.call_id ||
      !Array.isArray(metadata.prefix) || metadata.prefix.some(item =>
        item.type !== 'message' && (item.type !== 'reasoning' || !item.encrypted_content))) {
    throw new Error('The conversation contains invalid encrypted reasoning');
  }
  return metadata;
}

function callSignatures(request) {
  const signatures = new Map();
  let generatedId = 0;
  for (const content of request.contents || []) {
    if (content.role !== 'model') continue;
    for (const part of content.parts || []) {
      if (!part.functionCall) continue;
      const id = part.functionCall.id || `call_history_${++generatedId}`;
      const metadata = signatureFrom(part.thoughtSignature);
      if (metadata) signatures.set(id, metadata);
    }
  }
  return signatures;
}

function inputContent(content) {
  if (typeof content === 'string') return content;
  return content.map(part => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' };
  });
}

function replayPrefix(input, content, prefix) {
  const messages = prefix.filter(item => item.type === 'message');
  if (!messages.length) {
    if (content) input.push({ role: 'assistant', content: inputContent(content) });
    input.push(...prefix);
    return;
  }
  const expected = messages.flatMap(item => item.content).map(part => {
    if (part.type === 'output_text') return part.text;
    if (part.type === 'refusal') return part.refusal;
    throw new Error(`Unsupported OpenAI message content: ${part.type}`);
  }).join('');
  if (content && typeof content !== 'string') throw new Error('Cannot replay this assistant message');
  let actual = content || '';
  while (actual.length < expected.length && input.at(-1)?.role === 'assistant' &&
         typeof input.at(-1).content === 'string') {
    actual = input.pop().content + actual;
  }
  if (actual !== expected) throw new Error('Cannot replay the assistant message preceding this tool call');
  input.push(...prefix);
}

function inputFor(request) {
  const signatures = callSignatures(request);
  const originalCallIds = new Map();
  const input = [];
  for (const message of messagesFor(request)) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: originalCallIds.get(message.tool_call_id) || message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.role !== 'assistant') {
      input.push({ role: message.role, content: inputContent(message.content) });
      continue;
    }
    let content = message.content;
    for (const call of message.tool_calls || []) {
      const metadata = signatures.get(call.id);
      if (metadata) {
        replayPrefix(input, content, metadata.prefix);
        input.push(metadata.call);
        originalCallIds.set(call.id, metadata.call.call_id);
      } else {
        if (content) input.push({ role: 'assistant', content: inputContent(content) });
        input.push({
          type: 'function_call', call_id: call.id,
          name: call.function.name, arguments: call.function.arguments,
        });
      }
      content = null;
    }
    if (content) input.push({ role: 'assistant', content: inputContent(content) });
  }
  return input;
}

// Builds the tool fields. With `allowedTools`, `request.tools` is the stable list for the
// prompt cache and only the named tools may be called, as OpenAI recommends for caching.
function toolFields(request, allowedTools) {
  const calling = request.toolConfig?.functionCallingConfig;
  if (calling?.mode && !['AUTO', 'ANY', 'NONE'].includes(calling.mode)) {
    throw new Error(`Unsupported tool calling mode: ${calling.mode}`);
  }
  const tools = toolsFor(request).map(({ function: fn }) => ({ type: 'function', ...fn, strict: false }));
  let callable = allowedTools ?? tools.map(tool => tool.name);
  if (calling?.allowedFunctionNames?.length) {
    callable = callable.filter(name => calling.allowedFunctionNames.includes(name));
    if (!callable.length) throw new Error('No requested tool is available for this model');
  }
  if (!tools.length) return {};
  if (calling?.mode === 'NONE' || !callable.length) {
    if (calling?.mode === 'ANY') throw new Error('No requested tool is available for this model');
    return { tools, tool_choice: 'none' };
  }
  const mode = calling?.mode === 'ANY' ? 'required' : 'auto';
  if (callable.length === tools.length) return mode === 'required' ? { tools, tool_choice: mode } : { tools };
  return {
    tools,
    tool_choice: {
      type: 'allowed_tools', mode, tools: callable.map(name => ({ type: 'function', name })),
    },
  };
}

// `cache` carries the prompt-cache key, the callable tools when `request.tools` is a stable
// superset, and a system-instruction update to append after the history.
function requestFor(connection, request, effort, cache = {}) {
  if (!connection?.model) throw new Error('A model name is required');
  if (request.generationConfig?.responseMimeType &&
      request.generationConfig.responseMimeType !== 'text/plain') {
    throw new Error('The selected provider does not support this response format');
  }
  const input = inputFor(request);
  if (cache.systemUpdate) input.push({ role: 'developer', content: cache.systemUpdate });
  const tools = toolFields(request, cache.allowedTools);
  if (connection.authType === 'siwc') return subscriptionRequest(connection, input, effort, tools, cache.key);
  const payload = {
    model: connection.model,
    input,
    store: false,
    stream: true,
    // The AGY language server discards call IDs from tool results.
    parallel_tool_calls: false,
    include: ['reasoning.encrypted_content'],
  };
  if (effort) payload.reasoning = { effort };
  if (cache.key) payload.prompt_cache_key = cache.key;
  if (request.generationConfig?.maxOutputTokens != null) {
    payload.max_output_tokens = request.generationConfig.maxOutputTokens;
  }
  return { ...payload, ...tools };
}

// The ChatGPT subscription endpoint rejects system-role items, an output-token limit and
// `prompt_cache_options` (tested 2026-11-26); reasoning replay and the single-call rule apply only
// when tools are sent. The system prompt goes in a leading developer message: from GPT-6.2 on,
// top-level `instructions` follow the input and are never cached.
function subscriptionRequest(connection, input, effort, tools, cacheKey) {
  if (input[0]?.role === 'system') input[0] = { ...input[0], role: 'developer' };
  const payload = { model: connection.model, input, store: false, stream: true };
  if (effort) payload.reasoning = { effort };
  if (cacheKey) payload.prompt_cache_key = cacheKey;
  if (tools.tools) {
    payload.parallel_tool_calls = false;
    payload.include = ['reasoning.encrypted_content'];
  }
  return { ...payload, ...tools };
}

function toolParts(output) {
  const parts = [];
  let prefix = [];
  for (const item of output) {
    if (item.type === 'reasoning' || item.type === 'message') {
      prefix.push(item);
      continue;
    }
    if (item.type !== 'function_call') throw new Error(`Unsupported OpenAI output item: ${item.type}`);
    if (!item.call_id || !item.name) throw new Error('OpenAI returned an incomplete function call');
    const args = JSON.parse(item.arguments || '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      throw new Error(`OpenAI returned non-object arguments for tool ${item.name}`);
    }
    const part = { functionCall: { id: item.call_id, name: item.name, args } };
    part.thoughtSignature = signatureFor(item, prefix);
    prefix = [];
    parts.push(part);
  }
  return parts;
}

async function emitCompleted(response, onChunk) {
  let parts = [];
  let reason;
  if (response.status === 'completed') {
    parts = toolParts(response.output || []);
    reason = 'STOP';
  } else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
    reason = 'MAX_TOKENS';
  } else if (response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') {
    reason = 'SAFETY';
  } else {
    throw new Error(`OpenAI response did not complete: ${response.incomplete_details?.reason || response.status}`);
  }
  await onChunk(responseChunk(parts, reason));
  const usage = response.usage;
  if (usage) {
    await onChunk({ usageMetadata: {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens,
      cachedContentTokenCount: usage.input_tokens_details?.cached_tokens ?? 0,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens ?? 0,
    } });
  }
}

// Resolves with the provider's cache-write count, which has no Gemini usage field.
async function generateResponses({ connection, request, signal, onChunk, reasoningEffort, cache }) {
  const isSiwc = connection?.authType === 'siwc';
  const url = (isSiwc ? SIWC_RESOURCE_URL : normalizeBaseUrl(connection?.baseUrl)) + '/responses';
  const payload = requestFor(connection, request, reasoningEffort, cache);
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  if (isSiwc && cache?.session) headers['session-id'] = cache.session;
  const response = await postStream(url, {
    method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
  });
  if (!response.ok) {
    if (isSiwc) throw formatSiwcError(await response.json().catch(() => null), response.status);
    throw await httpError(response);
  }
  if (!response.body) throw new Error('The model provider returned an empty response');

  let finished = false;
  let completed;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') break;
    const event = JSON.parse(data);
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      await onChunk(responseChunk([{ text: event.delta }]));
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      await onChunk(responseChunk([{ text: event.delta, thought: true }]));
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (finished) throw new Error('OpenAI returned multiple finish events');
      await emitCompleted(event.response, onChunk);
      completed = event.response;
      finished = true;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      if (isSiwc) throw formatSiwcError(event.response || event, response.status);
      // OpenAI has used several shapes for stream errors; fall back to the raw event.
      const error = event.error || event.response?.error || event;
      const detail = [error.code, error.message].filter(Boolean).join(': ') || JSON.stringify(event);
      throw new Error(`OpenAI reported a response error${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
  }
  if (!finished) throw new Error('The model stream ended before a finish event');
  return { cacheWriteTokens: completed.usage?.input_tokens_details?.cache_write_tokens };
}

module.exports = { generateResponses, requestFor };
