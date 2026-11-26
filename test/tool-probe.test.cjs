'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeTools } = require('../lab/tool-probe.cjs');

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

async function readPayload(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function reply(response, delta, finishReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = { choices: [{ index: 0, delta, finish_reason: finishReason }] };
  response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
}

test('checks that a model calls the read-only tool and receives its result', async (context) => {
  const requests = [];
  const baseUrl = await serverFor(async (request, response) => {
    const payload = await readPayload(request);
    requests.push(payload);
    if (requests.length === 1) {
      reply(response, { tool_calls: [{
        index: 0, id: 'test-call', function: { name: 'read_sample', arguments: '{}' },
      }] }, 'tool_calls');
    } else {
      const toolResult = payload.messages.find((message) => message.role === 'tool');
      const sample = JSON.parse(toolResult.content).content;
      reply(response, { content: `The result is ${sample}` }, 'stop');
    }
  }, context);

  const result = await probeTools({ baseUrl, model: 'gpt-6-luna' });
  assert.deepEqual(result, { ok: true, message: '工具调用和结果回传成功。' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.equal(requests[1].reasoning_effort, 'none');
  assert.equal(requests[0].tool_choice, 'required');
  assert.equal(requests[0].tools.length, 1);
  assert.equal(requests[0].tools[0].function.name, 'read_sample');
  assert.equal(requests[1].tool_choice, 'none');
  const toolResult = requests[1].messages.find((message) => message.role === 'tool');
  assert.equal(toolResult.tool_call_id, 'test-call');
  const sample = JSON.parse(toolResult.content).content;
  assert.match(sample, /^agy-probe-[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(requests[0]).includes(sample), false);
});

test('reports unsupported or unexpected tool calls without executing them', async (context) => {
  let count = 0;
  const baseUrl = await serverFor(async (request, response) => {
    await readPayload(request);
    count++;
    if (count === 1) {
      reply(response, { content: 'I cannot use tools.' }, 'stop');
    } else {
      reply(response, { tool_calls: [{
        index: 0, id: 'unexpected', function: { name: 'write_file', arguments: '{}' },
      }] }, 'tool_calls');
    }
  }, context);

  const connection = { baseUrl, model: 'model' };
  assert.deepEqual(await probeTools(connection), { ok: false, message: '模型未正确调用测试工具。' });
  assert.deepEqual(await probeTools(connection), { ok: false, message: '模型未正确调用测试工具。' });
  assert.equal(count, 2);
});

test('reports a model that does not use the returned tool result', async (context) => {
  let count = 0;
  const baseUrl = await serverFor(async (request, response) => {
    await readPayload(request);
    count++;
    if (count === 1) {
      reply(response, { tool_calls: [{
        index: 0, id: 'test-call', function: { name: 'read_sample', arguments: '{}' },
      }] }, 'tool_calls');
    } else {
      reply(response, { content: 'Done.' }, 'stop');
    }
  }, context);
  assert.deepEqual(await probeTools({ baseUrl, model: 'model' }), {
    ok: false,
    message: '模型未正确接收测试工具的结果。',
  });
});
