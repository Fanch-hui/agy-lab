'use strict';

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The model endpoint must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The model endpoint must not contain credentials, a query, or a fragment');
  }
  return url.href.replace(/\/+$/, '');
}

// Gemini schemas encode 64-bit integer keywords as strings, which JSON Schema rejects.
const INTEGER_KEYWORDS = new Set([
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties',
]);

function schemaForOpenAI(schema) {
  if (Array.isArray(schema)) return schema.map(schemaForOpenAI);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === 'type' && typeof value === 'string') return [key, value.toLowerCase()];
    if (INTEGER_KEYWORDS.has(key) && typeof value === 'string' && /^\d+$/.test(value)) return [key, Number(value)];
    return [key, schemaForOpenAI(value)];
  }));
}

function contentParts(parts) {
  return parts.map((part) => {
    if (typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.inlineData?.mimeType?.startsWith('image/') && typeof part.inlineData.data === 'string') {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
      };
    }
    throw new Error('The selected provider does not support this message attachment');
  });
}

function compactContent(parts) {
  if (parts.some((part) => part.type === 'image_url')) return parts;
  return parts.map((part) => part.text).join('');
}

function messagesFor(request) {
  const messages = [];
  const pendingCalls = [];
  const pendingUserParts = [];
  let callNumber = 0;
  if (request.systemInstruction?.parts?.length) {
    const parts = contentParts(request.systemInstruction.parts);
    if (parts.some((part) => part.type !== 'text')) {
      throw new Error('System instructions must contain text');
    }
    messages.push({ role: 'system', content: compactContent(parts) });
  }

  function addToolResult(result) {
    const position = pendingCalls.findIndex((call) =>
      result.id ? call.id === result.id : call.name === result.name);
    if (position < 0) throw new Error('A tool result has no matching call in the conversation');
    const [call] = pendingCalls.splice(position, 1);
    const value = result.response;
    const content = typeof value === 'string' ? value : JSON.stringify(value ?? {});
    messages.push({ role: 'tool', tool_call_id: call.id, content });
    if (result.parts?.length) pendingUserParts.push(...contentParts(result.parts));
  }

  for (const item of request.contents || []) {
    if (item.role && item.role !== 'user' && item.role !== 'model') {
      throw new Error(`Unsupported message role: ${item.role}`);
    }
    // The AGY language server sends tool results in model-role contents; Gemini pairs them by
    // call, not by role, so results are matched wherever they appear.
    const parts = [];
    for (const part of item.parts || []) {
      if (part.functionResponse) addToolResult(part.functionResponse);
      else parts.push(part);
    }
    if (item.role === 'model') {
      if (!parts.length) continue;
      if (pendingCalls.length) throw new Error('The conversation has unfinished tool results');
      const calls = [];
      const text = [];
      const thought = [];
      for (const part of parts) {
        if (part.functionCall) {
          const { name, args, id } = part.functionCall;
          if (!name) throw new Error('A tool call in the conversation has no name');
          const callId = id || `call_history_${++callNumber}`;
          calls.push({ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } });
          pendingCalls.push({ id: callId, name });
        } else if (part.thought && typeof part.text === 'string') {
          thought.push(part.text);
        } else {
          text.push(...contentParts([part]));
        }
      }
      const content = compactContent(text);
      const message = { role: 'assistant', content: content || null };
      if (thought.length) message.reasoning_content = thought.join('');
      if (calls.length) message.tool_calls = calls;
      messages.push(message);
      continue;
    }
    for (const part of parts) pendingUserParts.push(...contentParts([part]));
    if (!pendingCalls.length && pendingUserParts.length) {
      messages.push({ role: 'user', content: compactContent(pendingUserParts) });
      pendingUserParts.length = 0;
    }
  }
  if (pendingCalls.length) throw new Error('The conversation has unfinished tool results');
  return messages;
}

function toolsFor(request) {
  const declarations = [];
  for (const group of request.tools || []) {
    if (!Array.isArray(group.functionDeclarations)) {
      throw new Error('The selected provider does not support a requested tool');
    }
    for (const declaration of group.functionDeclarations) {
      if (!declaration.name) throw new Error('A requested tool has no name');
      declarations.push({
        type: 'function',
        function: {
          name: declaration.name,
          ...(declaration.description ? { description: declaration.description } : {}),
          parameters: schemaForOpenAI(
            declaration.parametersJsonSchema ?? declaration.parameters ?? { type: 'object', properties: {} },
          ),
        },
      });
    }
  }
  return declarations;
}

async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = event.split(/\r\n|\r|\n/).filter((line) => line.startsWith('data:'));
        if (lines.length) yield lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      }
      if (done) {
        ended = true;
        if (buffer.trim()) throw new Error('The model stream ended with an incomplete event');
        return;
      }
    }
  } finally {
    if (!ended) await reader.cancel();
    reader.releaseLock();
  }
}

const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 1000;

// The network error under undici's generic "fetch failed", e.g. "ECONNRESET: other side closed".
function networkCause(error) {
  const cause = error?.cause;
  if (!cause) return '';
  const code = cause.code || cause.name;
  return [code, cause.message].filter(Boolean).filter((part, index, parts) => parts.indexOf(part) === index).join(': ');
}

// Sends a streaming request. A failure before any response arrives means the provider produced
// nothing, so it is retried up to three times with doubling delays; once a response exists,
// failures are never repeated here.
async function postStream(url, init, { fetch: send = fetch, delay = CONNECT_RETRY_DELAY_MS } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send(url, init);
    } catch (error) {
      // Network failures carry a system or undici error code (ECONNRESET, ENOTFOUND,
      // UND_ERR_SOCKET…); a refused redirect or bad URL has none and is never transient.
      if (init.signal?.aborted || !(error instanceof TypeError) || typeof error.cause?.code !== 'string') throw error;
      const cause = networkCause(error);
      if (attempt > CONNECT_RETRIES) {
        throw new Error(`${error.message}${cause ? ` (${cause})` : ''}，已自动重试 ${CONNECT_RETRIES} 次`, { cause: error });
      }
      console.error(`[agy-lab] Model request failed before a response${cause ? ` (${cause})` : ''}; retry ${attempt}/${CONNECT_RETRIES}.`);
      await new Promise(resolve => setTimeout(resolve, delay * 2 ** (attempt - 1)));
      if (init.signal?.aborted) throw error;
    }
  }
}

// Builds an error that keeps the provider's own explanation, which is needed to act on it.
async function httpError(response) {
  let detail = '';
  try {
    const body = await response.text();
    const parsed = JSON.parse(body);
    detail = parsed.error?.message || parsed.message || '';
  } catch {
    // A body that is not JSON carries no usable explanation.
  }
  return new Error(`Model provider returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

function responseChunk(parts, finishReason) {
  const candidate = { index: 0, content: { role: 'model', parts } };
  if (finishReason) candidate.finishReason = finishReason;
  return { candidates: [candidate] };
}

module.exports = { normalizeBaseUrl, messagesFor, toolsFor, sseData, responseChunk, httpError, postStream };
