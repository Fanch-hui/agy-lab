'use strict';

// Serves language-server generation requests for external models. The request is rebuilt
// from the inner Gemini-format body only: the Cloud Code wrapper (project, labels, user agent)
// and every incoming header are dropped, and the provider is called with its own credential.
const { once } = require('node:events');
const { injectCatalogue, resolveVariant } = require('./native-models.cjs');
const { prefixShape, digest } = require('./prefix-shape.cjs');
const { usesOpenAIResponses } = require('./reasoning.cjs');

const OPENAI_ORIGIN = 'https://api.openai.com';

function writeError(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { code: status, message, status: 'FAILED_PRECONDITION' } }));
}

// The provider caches by prompt prefix and routes requests by this key. AGY's system prompt
// and tools are largely the same across conversations and subagents, so one key per
// connection and model lets a new conversation reuse the prefix an earlier one cached.
function cacheKeyFor(connection) {
  return `agy-lab-${digest(connection.id, connection.model)}`;
}

// Only the official OpenAI Responses API is known to accept `allowed_tools` and developer
// messages; other providers get the request as AGY built it.
function cacheFor(connection, request, effort, stability, comparisonId) {
  const key = cacheKeyFor(connection);
  // The subscription endpoint's acceptance of the other prefix measures is unverified.
  if (connection.authType === 'siwc') return { request, cache: { key, comparisonId } };
  if (!stability || new URL(connection.baseUrl).origin !== OPENAI_ORIGIN ||
      !usesOpenAIResponses(connection, request, effort)) {
    return { request, cache: { key } };
  }
  const stable = stability.apply(connection.id, request);
  return {
    request: stable.request,
    cache: { key, allowedTools: stable.allowedTools, systemUpdate: stable.systemUpdate },
  };
}

const MAX_CONVERSATIONS = 200;

function createNativeRoute({ listConnections, getConnection, generate, slotTable, signatures, stability }) {
  // The last response ID of each conversation, so the next call can ask why it missed the cache.
  const lastResponses = new Map();
  function remember(conversation, id) {
    if (!conversation || !id) return;
    lastResponses.delete(conversation);
    lastResponses.set(conversation, id);
    if (lastResponses.size > MAX_CONVERSATIONS) lastResponses.delete(lastResponses.keys().next().value);
  }

  function matches(model) {
    return Boolean(resolveVariant(model, listConnections()));
  }

  // Resolves with the provider's token usage and the shape of the cacheable prefix, for diagnosis.
  async function handle(envelope, response) {
    const variant = resolveVariant(envelope.model, listConnections());
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    let connection;
    try {
      connection = await getConnection(variant.connectionId, controller.signal);
    } catch (error) {
      writeError(response, 400, error.message);
      return;
    }
    const provider = `${connection.model}（${connection.authType === 'siwc' ? 'ChatGPT 订阅' : new URL(connection.baseUrl).host}）`;
    const original = structuredClone(envelope.request || {});
    signatures.reveal(original.contents);
    const conversation = original.sessionId ? `${connection.id}:${original.sessionId}` : null;
    const { request, cache } = cacheFor(connection, original, variant.effort, stability,
      lastResponses.get(conversation));
    const result = {
      // A hashed session marker shows whether Orchestrator sub-calls share one conversation key.
      session: request.sessionId ? digest(request.sessionId).slice(0, 8) : null,
      requestType: envelope.requestType,
      // User messages that carry text, which maps each call to the user turn it serves.
      userTurns: (request.contents || []).filter(content => content.role === 'user' &&
        (content.parts || []).some(part => typeof part.text === 'string')).length,
      shape: prefixShape(request),
      systemUpdate: Boolean(cache?.systemUpdate),
      usage: undefined,
    };
    try {
      const outcome = await generate({
        connection, request, reasoningEffort: variant.effort, signal: controller.signal, cache,
        onChunk: async chunk => {
          if (chunk.usageMetadata) result.usage = chunk.usageMetadata;
          for (const candidate of chunk.candidates || []) signatures.conceal(candidate.content?.parts || []);
          if (!response.headersSent) {
            response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          }
          if (!response.write(`data: ${JSON.stringify({ response: chunk })}\r\n\r\n`)) {
            await once(response, 'drain', { signal: controller.signal });
          }
        },
      });
      result.cacheWriteTokens = outcome?.cacheWriteTokens;
      remember(conversation, outcome?.responseId);
      const diagnosis = outcome?.cacheDiagnostics;
      if (diagnosis) result.cacheDiagnosis = [diagnosis.type, diagnosis.reason].filter(Boolean).join(': ');
      response.end();
    } catch (error) {
      if (controller.signal.aborted) return result;
      // A non-retryable status keeps the language server from repeating a billed request.
      if (response.headersSent) response.destroy(error);
      else writeError(response, 400, `外部模型 ${provider} 调用失败：${error.message}`);
    }
    return result;
  }

  function rewriteCatalogue(catalogue) {
    return injectCatalogue(catalogue, listConnections(), slotTable).catalogue;
  }

  return { matches, handle, rewriteCatalogue };
}

module.exports = { createNativeRoute };
