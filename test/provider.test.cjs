'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generate } = require('../lab/provider.cjs');

async function serverFor(handler, context) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function sendEvents(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const data = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = Buffer.from(data);
  for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
  response.end();
}

function streamEvent(delta, finishReason = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

test('streams text and multiple tool calls, then sends tool results back to the provider', async (context) => {
  const received = [];
  const baseUrl = await serverFor(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      url: request.url,
      authorization: request.headers.authorization,
      headers: request.headers,
      payload: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (received.length === 1) {
      sendEvents(response, [
        streamEvent({ content: '处理中', tool_calls: [
          { index: 0, id: 'call_a', function: { name: 'read_', arguments: '{"path":"' } },
          { index: 1, id: 'call_b', function: { name: 'search', arguments: '{"query":' } },
        ] }),
        streamEvent({ tool_calls: [
          { index: 0, function: { name: 'file', arguments: '/tmp/a"}' } },
          { index: 1, function: { arguments: '"hello"}' } },
        ] }),
        streamEvent({}, 'tool_calls'),
        '[DONE]',
      ]);
    } else {
      sendEvents(response, [streamEvent({ content: '完成' }), streamEvent({}, 'stop'), '[DONE]']);
    }
  }, context);

  const connection = { baseUrl, model: 'local-model', apiKey: 'test-provider-key' };
  const request = {
    systemInstruction: { parts: [{ text: 'Follow the plan.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Read and search.' }] }],
    tools: [{ functionDeclarations: [
      { name: 'read_file', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } },
      { name: 'search', parametersJsonSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    ] }],
    generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
  };
  const chunks = [];
  await generate({ connection, request, onChunk: (chunk) => chunks.push(chunk) });

  assert.equal(received[0].url, '/v1/chat/completions');
  assert.equal(received[0].authorization, 'Bearer test-provider-key');
  assert.equal(received[0].headers['x-goog-api-key'], undefined);
  assert.equal(received[0].payload.model, 'local-model');
  assert.equal(received[0].payload.stream, true);
  assert.equal(received[0].payload.tools[0].function.parameters.properties.path.type, 'string');
  assert.equal(received[0].payload.max_tokens, 500);
  assert.equal(chunks[0].candidates[0].content.parts[0].text, '处理中');
  const callParts = chunks[1].candidates[0].content.parts;
  assert.deepEqual(callParts, [
    { functionCall: { id: 'call_a', name: 'read_file', args: { path: '/tmp/a' } } },
    { functionCall: { id: 'call_b', name: 'search', args: { query: 'hello' } } },
  ]);
  assert.equal(chunks[1].candidates[0].finishReason, 'STOP');

  const followUp = {
    ...request,
    contents: [
      ...request.contents,
      { role: 'model', parts: [{ text: '处理中' }, ...callParts] },
      { role: 'user', parts: [
        { functionResponse: { id: 'call_b', name: 'search', response: { matches: 2 } } },
        { text: 'Use both results.' },
      ] },
      { role: 'user', parts: [
        { functionResponse: { name: 'read_file', response: { content: 'file text' } } },
      ] },
    ],
  };
  const followUpChunks = [];
  await generate({ connection, request: followUp, onChunk: (chunk) => followUpChunks.push(chunk) });
  assert.deepEqual(received[1].payload.messages.slice(-4), [
    { role: 'assistant', content: '处理中', tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } },
      { id: 'call_b', type: 'function', function: { name: 'search', arguments: '{"query":"hello"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_b', content: '{"matches":2}' },
    { role: 'tool', tool_call_id: 'call_a', content: '{"content":"file text"}' },
    { role: 'user', content: 'Use both results.' },
  ]);
  assert.equal(followUpChunks[0].candidates[0].content.parts[0].text, '完成');
  assert.equal(followUpChunks[1].candidates[0].finishReason, 'STOP');
});

test('propagates cancellation during streaming', async (context) => {
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(streamEvent({ content: 'partial' }))}\n\n`);
  }, context);
  const controller = new AbortController();
  const chunks = [];
  await assert.rejects(generate({
    connection: { baseUrl, model: 'test' },
    request: { contents: [] },
    signal: controller.signal,
    onChunk(chunk) {
      chunks.push(chunk);
      controller.abort();
    },
  }), { name: 'AbortError' });
  assert.equal(chunks.length, 1);
});

test('rejects invalid tool arguments and an unfinished stream', async (context) => {
  let count = 0;
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    count++;
    if (count === 1) {
      sendEvents(response, [
        streamEvent({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{bad' } }] }),
        streamEvent({}, 'tool_calls'),
        '[DONE]',
      ]);
    } else {
      sendEvents(response, [streamEvent({ content: 'partial' }), '[DONE]']);
    }
  }, context);
  const options = { connection: { baseUrl, model: 'test' }, request: { contents: [] }, onChunk() {} };
  await assert.rejects(generate(options), /invalid arguments/);
  await assert.rejects(generate(options), /before a finish event/);
});

test('does not follow redirects and rejects unencrypted remote endpoints', async (context) => {
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    response.writeHead(302, { location: 'http://127.0.0.1:1/stolen' });
    response.end();
  }, context);
  const request = { contents: [] };
  await assert.rejects(generate({ connection: { baseUrl, model: 'test', apiKey: 'test-key' }, request, onChunk() {} }));
  await assert.rejects(
    generate({ connection: { baseUrl: 'http://example.com/v1', model: 'test' }, request, onChunk() {} }),
    /HTTPS or loopback HTTP/,
  );
});

test('sends a prompt cache key only to OpenAI chat completions', async () => {
  const { requestFor } = require('../lab/provider.cjs');
  const request = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  const official = requestFor({ model: 'm', baseUrl: 'https://api.openai.com/v1' }, request, undefined, 'k');
  const compatible = requestFor({ model: 'm', baseUrl: 'https://example.test/v1' }, request, undefined, 'k');
  assert.equal(official.prompt_cache_key, 'k');
  assert.equal(compatible.prompt_cache_key, undefined);
});
