'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { discoverModels } = require('../lab/model-discovery.cjs');

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

test('discovers distinct model IDs with only the selected provider credential', async context => {
  let received;
  const baseUrl = await serverFor((request, response) => {
    received = { path: request.url, headers: request.headers };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [
      { id: 'model-10' },
      { id: 'model-2', supported_reasoning_efforts: ['none', 'high', 'unexpected', 'high'] },
      { id: 'model-10' }, { id: '' },
    ] }));
  }, context);
  const models = await discoverModels({ baseUrl, apiKey: 'provider-test-key' });
  assert.deepEqual(models, [
    { id: 'model-2', reasoningEfforts: ['none', 'high'] },
    { id: 'model-10' },
  ]);
  assert.equal(received.path, '/v1/models');
  assert.equal(received.headers.authorization, 'Bearer provider-test-key');
  assert.equal(received.headers['x-goog-api-key'], undefined);
});

test('reports provider errors and rejects unsupported model-list responses', async context => {
  let calls = 0;
  const baseUrl = await serverFor((request, response) => {
    if (++calls === 1) {
      response.writeHead(401);
      response.end();
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: ['unrecognised'] }));
    }
  }, context);
  await assert.rejects(discoverModels({ baseUrl }), /HTTP 401/);
  await assert.rejects(discoverModels({ baseUrl }), /模型列表格式不受支持/);
});
