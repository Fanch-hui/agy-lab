'use strict';

const { randomUUID } = require('node:crypto');
const { usesOpenAIResponses } = require('./reasoning.cjs');

const { normalizeBaseUrl, messagesFor, toolsFor, sseData, responseChunk, httpError, postStream } = require('./provider-wire.cjs');
const { generateResponses } = require('./responses.cjs');

const OPENAI_ORIGIN = 'https://api.openai.com';

function requestFor(connection, request, reasoningEffort, cacheKey) {
  if (!connection?.model || typeof connection.model !== 'string') throw new Error('A model name is required');
  const payload = { model: connection.model, messages: messagesFor(request), stream: true };
  // Compatible providers may reject parameters they do not know, so only OpenAI gets the key.
  if (cacheKey && new URL(connection.baseUrl).origin === OPENAI_ORIGIN) payload.prompt_cache_key = cacheKey;
  const config = request.generationConfig || {};
  if (config.temperature != null) payload.temperature = config.temperature;
  if (config.topP != null) payload.top_p = config.topP;
  if (config.maxOutputTokens != null) payload.max_tokens = config.maxOutputTokens;
  if (config.stopSequences?.length) payload.stop = config.stopSequences;
  if (config.responseMimeType && config.responseMimeType !== 'text/plain') {
    throw new Error('The selected provider does not support this response format');
  }

  let tools = toolsFor(request);
  const calling = request.toolConfig?.functionCallingConfig;
  if (calling?.allowedFunctionNames?.length) {
    tools = tools.filter((tool) => calling.allowedFunctionNames.includes(tool.function.name));
    if (!tools.length) throw new Error('No requested tool is available for this model');
  }
  if (reasoningEffort !== undefined) payload.reasoning_effort = reasoningEffort;
  if (tools.length) {
    payload.tools = tools;
    // Luna's Chat Completions API accepts function tools only with reasoning disabled.
    if (connection.model === 'gpt-6-luna' && reasoningEffort === undefined) {
      payload.reasoning_effort = 'none';
    }
  }
  if (calling?.mode === 'ANY') payload.tool_choice = 'required';
  else if (calling?.mode === 'NONE') payload.tool_choice = 'none';
  else if (calling?.mode && calling.mode !== 'AUTO') {
    throw new Error(`Unsupported tool calling mode: ${calling.mode}`);
  }
  return payload;
}

function finishReasonFor(reason) {
  if (reason === 'stop' || reason === 'tool_calls') return 'STOP';
  if (reason === 'length') return 'MAX_TOKENS';
  if (reason === 'content_filter') return 'SAFETY';
  throw new Error(`Unsupported model finish reason: ${reason}`);
}

function toolParts(calls) {
  return [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => {
    if (!call.name) throw new Error('The model returned a tool call without a name');
    let args;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      throw new Error(`The model returned invalid arguments for tool ${call.name}`);
    }
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      throw new Error(`The model returned non-object arguments for tool ${call.name}`);
    }
    return { functionCall: { id: call.id || `call_${randomUUID()}`, name: call.name, args } };
  });
}

// `cache` is used fully on the Responses path; Chat Completions take only its key.
async function generate({ connection, request, signal, onChunk, reasoningEffort, cache }) {
  if (usesOpenAIResponses(connection, request, reasoningEffort)) {
    return generateResponses({ connection, request, signal, onChunk, reasoningEffort, cache });
  }
  const url = normalizeBaseUrl(connection?.baseUrl) + '/chat/completions';
  const payload = requestFor(connection, request, reasoningEffort, cache?.key);
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  const response = await postStream(url, {
    method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error',
  });
  if (!response.ok) throw await httpError(response);
  if (!response.body) throw new Error('The model provider returned an empty response');

  const calls = new Map();
  let finished = false;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') break;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('The model provider returned invalid stream data');
    }
    if (event.error) throw new Error('The model provider reported a stream error');
    const choice = event.choices?.find((item) => item.index === 0 || item.index == null);
    if (choice) {
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        await onChunk(responseChunk([{ text: reasoning, thought: true }]));
      }
      if (typeof delta.content === 'string' && delta.content) {
        await onChunk(responseChunk([{ text: delta.content }]));
      }
      if (typeof delta.refusal === 'string' && delta.refusal) {
        await onChunk(responseChunk([{ text: delta.refusal }]));
      }
      for (const fragment of delta.tool_calls || []) {
        if (!Number.isInteger(fragment.index) || fragment.index < 0) {
          throw new Error('The model returned a tool call without an index');
        }
        const call = calls.get(fragment.index) || { id: '', name: '', arguments: '' };
        if (fragment.id) call.id += fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        calls.set(fragment.index, call);
      }
      if (choice.finish_reason) {
        if (finished) throw new Error('The model returned multiple finish events');
        if (choice.finish_reason === 'tool_calls' && !calls.size) {
          throw new Error('The model reported tool calls without returning any');
        }
        await onChunk(responseChunk(toolParts(calls), finishReasonFor(choice.finish_reason)));
        finished = true;
      }
    }
    if (event.usage) {
      await onChunk({
        usageMetadata: {
          promptTokenCount: event.usage.prompt_tokens,
          candidatesTokenCount: event.usage.completion_tokens,
          totalTokenCount: event.usage.total_tokens,
          cachedContentTokenCount: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
      });
    }
  }
  if (!finished) throw new Error('The model stream ended before a finish event');
  return {};
}

module.exports = { generate, normalizeBaseUrl, requestFor };
