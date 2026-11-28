'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateResponses } = require('../lab/responses.cjs');

async function serverFor(handler, context) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function sendEvents(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  for (let index = 0; index < bytes.length; index += 11) response.write(bytes.subarray(index, index + 11));
  response.end();
}

test('streams tool calls and replays encrypted reasoning with tool results', async context => {
  const received = [];
  const reasoning = { id: 'rs_test', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const priorMessage = { id: 'msg_test', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: '先读文件。', annotations: [] }] };
  const baseUrl = await serverFor(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    received.push({
      path: request.url,
      authorization: request.headers.authorization,
      googleKey: request.headers['x-goog-api-key'],
      payload: JSON.parse(Buffer.concat(body).toString()),
    });
    if (received.length === 1) {
      sendEvents(response, [{ type: 'response.output_text.delta', delta: '先读文件。' }, {
        type: 'response.completed',
        response: { status: 'completed', output: [reasoning, priorMessage, {
          id: 'fc_test', type: 'function_call', call_id: 'call_test', name: 'read_file',
          arguments: '{"path":"sample.txt"}',
        }] },
      }]);
      return;
    }
    sendEvents(response, [
      { type: 'response.output_text.delta', delta: '完成' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] },
      ], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13,
        input_tokens_details: { cached_tokens: 8 } } } },
    ]);
  }, context);
  const connection = { baseUrl, model: 'gpt-6-luna', apiKey: 'provider-key' };
  const request = {
    systemInstruction: { parts: [{ text: 'Follow the plan.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Read the sample.' }] }],
    tools: [{ functionDeclarations: [{ name: 'read_file', parameters: {
      type: 'OBJECT', properties: { path: { type: 'STRING' } },
    } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  };
  const chunks = [];
  await generateResponses({ connection, request, reasoningEffort: 'high', onChunk: chunk => chunks.push(chunk) });
  const call = chunks[1].candidates[0].content.parts[0];
  assert.deepEqual(call.functionCall, { id: 'call_test', name: 'read_file', args: { path: 'sample.txt' } });
  assert.equal(typeof call.thoughtSignature, 'string');

  // AGY preserves thoughtSignature, but strips IDs from calls and results.
  delete call.functionCall.id;
  const followUp = {
    ...request,
    contents: [...request.contents, { role: 'model', parts: [{ text: '先读文件。' }] },
      { role: 'model', parts: [call] }, { role: 'user', parts: [{
      functionResponse: { name: 'read_file', response: { content: 'sample text' } },
    }] }],
    toolConfig: { functionCallingConfig: { mode: 'NONE' } },
  };
  const followUpChunks = [];
  await generateResponses({
    connection, request: followUp, reasoningEffort: 'high', cache: { key: 'agy-lab-test' },
    onChunk: chunk => followUpChunks.push(chunk),
  });
  assert.equal(received[0].path, '/v1/responses');
  assert.equal(received[0].authorization, 'Bearer provider-key');
  assert.equal(received[0].googleKey, undefined);
  assert.deepEqual(received[0].payload.reasoning, { effort: 'high' });
  assert.equal(received[0].payload.store, false);
  assert.equal(received[0].payload.parallel_tool_calls, false);
  assert.equal(received[0].payload.tools[0].parameters.properties.path.type, 'string');
  assert.equal(received[0].payload.tool_choice, 'required');
  assert.deepEqual(received[1].payload.input.slice(-4), [
    reasoning,
    priorMessage,
    { id: 'fc_test', type: 'function_call', call_id: 'call_test', name: 'read_file', arguments: '{"path":"sample.txt"}' },
    { type: 'function_call_output', call_id: 'call_test', output: '{"content":"sample text"}' },
  ]);
  assert.equal(received[1].payload.tool_choice, 'none');
  assert.equal(followUpChunks[0].candidates[0].content.parts[0].text, '完成');
  assert.equal(followUpChunks[1].candidates[0].finishReason, 'STOP');
  assert.equal(followUpChunks[2].usageMetadata.totalTokenCount, 13);
  assert.equal(followUpChunks[2].usageMetadata.cachedContentTokenCount, 8);
  assert.equal(received[0].payload.prompt_cache_key, undefined);
  assert.equal(received[1].payload.prompt_cache_key, 'agy-lab-test');
});

test('reports an unfinished response stream', async context => {
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    sendEvents(response, [{ type: 'response.output_text.delta', delta: 'partial' }]);
  }, context);
  await assert.rejects(generateResponses({
    connection: { baseUrl, model: 'gpt-6-luna' },
    request: { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] },
    onChunk() {},
  }), /before a finish event/);
});

test('does not execute a tool call from a token-limited incomplete response', async context => {
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    sendEvents(response, [{ type: 'response.incomplete', response: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{
        type: 'function_call', call_id: 'call_test', name: 'read_file', arguments: '{}',
      }],
    } }]);
  }, context);
  const chunks = [];
  await generateResponses({
    connection: { baseUrl, model: 'gpt-6-luna' }, request: { contents: [] },
    onChunk: chunk => chunks.push(chunk),
  });
  assert.deepEqual(chunks[0].candidates[0].content.parts, []);
  assert.equal(chunks[0].candidates[0].finishReason, 'MAX_TOKENS');
});

test('rejects malformed SSE JSON, invalid tool arguments and corrupt reasoning signatures cleanly', async context => {
  const { requestFor } = require('../lab/responses.cjs');
  assert.throws(() => requestFor({ model: 'gpt-6-luna' }, {
    contents: [{ role: 'model', parts: [{
      functionCall: { id: 'call_1', name: 'read_file', args: {} },
      thoughtSignature: Buffer.from('agy-openai-reasoning-v1:{bad-json').toString('base64'),
    }] }],
  }), /invalid encrypted reasoning/);

  let mode = 0;
  const baseUrl = await serverFor((request, response) => {
    request.resume();
    mode += 1;
    if (mode === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {not-json\r\n\r\n');
    } else {
      sendEvents(response, [{
        type: 'response.completed',
        response: { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{bad' }] },
      }]);
    }
  }, context);

  await assert.rejects(generateResponses({
    connection: { baseUrl, model: 'gpt-6-luna' }, request: { contents: [] }, onChunk() {},
  }), /invalid stream data/);
  await assert.rejects(generateResponses({
    connection: { baseUrl, model: 'gpt-6-luna' }, request: { contents: [] }, onChunk() {},
  }), /invalid arguments for tool read_file/);
});
