'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startCloudProxy } = require('../lab/cloud-proxy.cjs');
const { generate } = require('../lab/provider.cjs');
const { SlotTable, injectCatalogue } = require('../lab/native-models.cjs');
const { PLACEHOLDER_SIGNATURE, SignatureStore } = require('../lab/native-signatures.cjs');
const { createNativeRoute } = require('../lab/native-route.cjs');

const CONNECTION_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const GROUP = 'agy-ext-0f1e2d3c4b5a';

function officialCatalogue() {
  return {
    models: { 'gemini-4-neon-low': { displayName: 'Gemini 4 Neon (Low)', model: 'MODEL_PLACEHOLDER_M1200' } },
    groupedModels: { 'gemini-4-neon': { displayName: 'Gemini 4 Neon' } },
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-neon-low'] }] }],
    defaultAgentModelId: 'gemini-4-neon-low',
  };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-route-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('adds each reasoning effort as a grouped model on an unused placeholder', context => {
  const file = path.join(temporaryDirectory(context), 'slots.json');
  const connection = { id: CONNECTION_ID, model: 'o3', baseUrl: 'https://api.example.test/v1' };
  const { catalogue } = injectCatalogue(officialCatalogue(), [connection], new SlotTable(file));
  const ids = ['low', 'medium', 'high'].map(effort => `${GROUP}-${effort}`);
  assert.deepEqual(ids.map(id => catalogue.models[id].model),
    ['MODEL_PLACEHOLDER_M1201', 'MODEL_PLACEHOLDER_M1202', 'MODEL_PLACEHOLDER_M1203']);
  assert.equal(catalogue.models[ids[1]].displayName, 'o3 · api.example.test (Medium)');
  assert.deepEqual(catalogue.groupedModels[GROUP].supportedThinkingLevels.map(level => level.thinkingSuffix),
    ['low', 'medium', 'high']);
  assert.deepEqual(catalogue.agentModelSorts[0].groups, [{ modelIds: ['gemini-4-neon-low', ...ids] }]);
  assert.equal(catalogue.models['gemini-4-neon-low'].model, 'MODEL_PLACEHOLDER_M1200');
  assert.equal(catalogue.defaultAgentModelId, 'gemini-4-neon-low');

  // Bindings survive a restart, and only a number the official catalogue now uses moves.
  const later = officialCatalogue();
  later.models['gemini-new'] = { model: 'MODEL_PLACEHOLDER_M1202' };
  const again = injectCatalogue(later, [connection], new SlotTable(file)).catalogue;
  assert.equal(again.models[ids[0]].model, 'MODEL_PLACEHOLDER_M1201');
  assert.equal(again.models[ids[1]].model, 'MODEL_PLACEHOLDER_M1204');
  assert.equal(again.models[ids[2]].model, 'MODEL_PLACEHOLDER_M1203');
});

test('conceals provider signatures and restores them for the provider', () => {
  const store = new SignatureStore();
  const parts = [{ text: 'reading' }, { functionCall: { id: 'call_1', name: 'read_file', args: { Path: 'a' } }, thoughtSignature: 'provider-state' },
    { functionCall: { id: 'call_2', name: 'run_command', args: {} } }];
  store.conceal(parts);
  assert.equal(parts[1].thoughtSignature, PLACEHOLDER_SIGNATURE);
  assert.equal(parts[2].thoughtSignature, PLACEHOLDER_SIGNATURE);
  assert.equal(parts[0].thoughtSignature, undefined);
  // The language server may drop call ids; the call itself still identifies the state.
  const history = [{ role: 'model', parts: [
    { functionCall: { name: 'read_file', args: { Path: 'a' } }, thoughtSignature: PLACEHOLDER_SIGNATURE },
    { functionCall: { id: 'call_2', name: 'run_command', args: {} }, thoughtSignature: PLACEHOLDER_SIGNATURE },
    { functionCall: { id: 'gemini', name: 'read_file', args: {} }, thoughtSignature: 'gemini-signature' },
  ] }];
  store.reveal(history);
  assert.equal(history[0].parts[0].thoughtSignature, 'provider-state');
  assert.equal(history[0].parts[1].thoughtSignature, undefined);
  assert.equal(history[0].parts[2].thoughtSignature, 'gemini-signature');
});

async function nativeFixture(context, providerReplies, siwc = false) {
  const google = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    google.push({ url: request.url, body: Buffer.concat(chunks) });
    if (request.url.startsWith('/v1internal:fetchAvailableModels')) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(zlib.gzipSync(JSON.stringify(officialCatalogue())));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\r\n\r\n');
  });
  const provider = [];
  const providerServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    provider.push({ headers: request.headers, payload: JSON.parse(Buffer.concat(chunks)) });
    const reply = providerReplies[provider.length - 1];
    if (reply.status) {
      response.writeHead(reply.status);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(reply.events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  const origin = await listen(upstream);
  const providerUrl = await listen(providerServer);
  const directory = temporaryDirectory(context);
  const connection = siwc ? { id: CONNECTION_ID, model: 'gpt-5.4', baseUrl: 'https://api.openai.com/v1', authType: 'siwc' }
    : { id: CONNECTION_ID, model: 'local-coder', baseUrl: providerUrl + '/v1' };
  const external = createNativeRoute({
    listConnections: () => [connection],
    getConnection: siwc ? async (_, signal) => {
      assert.ok(signal instanceof AbortSignal);
      await new Promise(resolve => setImmediate(resolve));
      return { ...connection, apiKey: 'test-oauth-token' };
    } : () => ({ ...connection, apiKey: 'provider-key' }),
    generate,
    slotTable: new SlotTable(path.join(directory, 'slots.json')),
    signatures: new SignatureStore(path.join(directory, 'signatures.json')),
  });
  const proxy = await startCloudProxy({ upstream: origin, inventoryFile: path.join(directory, 'inventory.json'), external });
  context.after(async () => {
    await proxy.close();
    for (const server of [upstream, providerServer]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  return { proxy, google, provider, providerUrl };
}

function generation(proxy, envelope) {
  return fetch(proxy.url + '/v1internal:streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-token', 'x-goog-api-client': 'agy' },
    body: JSON.stringify(envelope),
  });
}

function events(text) {
  return text.split('\r\n\r\n').filter(Boolean).map(event => JSON.parse(event.slice(6)));
}

test('serves external models natively and keeps Google traffic unchanged', async context => {
  const { proxy, google, provider, providerUrl } = await nativeFixture(context, [
    { events: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"Path":"/w/a.txt"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }] },
    { events: [{ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 80 } } }] },
    { status: 503 },
  ]);
  const catalogue = await (await fetch(proxy.url + '/v1internal:fetchAvailableModels', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"project":"p"}' })).json();
  assert.equal(catalogue.models[GROUP].displayName, `local-coder · ${new URL(providerUrl).host}`);

  const tools = [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'OBJECT', properties: { Path: { type: 'STRING' } } } }] }];
  const first = await generation(proxy, {
    project: 'p', model: GROUP, userAgent: 'antigravity', requestType: 'agent',
    request: { contents: [{ role: 'user', parts: [{ text: 'read a.txt' }] }], tools,
      sessionId: 'session-1', labels: { cascade_id: 'c' }, systemInstruction: { role: 'user', parts: [{ text: 'You are AGY.' }] } },
  });
  assert.equal(first.status, 200);
  const firstEvents = events(await first.text());
  const call = firstEvents.at(-1).response.candidates[0].content.parts[0];
  assert.deepEqual(call.functionCall, { id: 'call_a', name: 'read_file', args: { Path: '/w/a.txt' } });
  assert.equal(call.thoughtSignature, PLACEHOLDER_SIGNATURE);
  assert.equal(provider[0].headers.authorization, 'Bearer provider-key');
  assert.equal(provider[0].headers['x-goog-api-client'], undefined);
  assert.doesNotMatch(JSON.stringify(provider[0].payload), /google-token|cascade_id|"project"|session-1|prompt_cache_key/);
  assert.equal(provider[0].payload.messages[0].content, 'You are AGY.');
  assert.equal(provider[0].payload.tools[0].function.parameters.properties.Path.type, 'string');

  const second = await generation(proxy, {
    model: GROUP, request: { tools, contents: [
      { role: 'user', parts: [{ text: 'read a.txt' }] },
      { role: 'model', parts: [call] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_a', name: 'read_file', response: { output: 'A' } } }] },
    ] },
  });
  const text = events(await second.text()).flatMap(event => event.response.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '').join('');
  assert.equal(text, 'done');
  assert.deepEqual(provider[1].payload.messages.at(-1), { role: 'tool', tool_call_id: 'call_a', content: '{"output":"A"}' });

  const failed = await generation(proxy, { model: GROUP, request: { contents: [{ role: 'user', parts: [{ text: 'x' }] }] } });
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error.message, /local-coder.*HTTP 503/);

  const official = JSON.stringify({ model: 'gemini-4-neon-low', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
  await (await generation(proxy, JSON.parse(official))).text();
  assert.equal(provider.length, 3);
  const generations = google.filter(row => row.url.startsWith('/v1internal:streamGenerateContent'));
  assert.equal(generations.length, 1);
  assert.equal(generations[0].body.toString(), official);
  await proxy.close();
  const rows = Object.fromEntries(proxy.inventory.snapshot().map(row => [row.path, row]));
  assert.deepEqual(rows['/agy-lab-external/v1internal:streamGenerateContent'].statuses, { 200: 2, 400: 1 });
  assert.equal(rows['/v1internal:streamGenerateContent'].modelNamesInBody[GROUP], undefined);
  const externalRow = rows['/agy-lab-external/v1internal:streamGenerateContent'];
  assert.deepEqual(externalRow.cache, { promptTokens: 100, cachedTokens: 80, hitRate: 0.8 });
  assert.equal(externalRow.recentCalls.length, 3);
  assert.equal(externalRow.recentCalls[0].tools, externalRow.recentCalls[1].tools);
  assert.match(externalRow.recentCalls[0].session, /^[0-9a-f]{8}$/);
  assert.equal(externalRow.recentCalls[1].session, null);
  assert.equal(externalRow.recentCalls[0].requestType, 'agent');
  assert.deepEqual(externalRow.recentCalls.map(call => call.userTurns), [1, 1, 1]);
  assert.equal(Object.keys(externalRow.systemVariants).length, 2);
  assert.deepEqual(externalRow.toolVariants[externalRow.recentCalls[0].tools].map(tool => tool.name), ['read_file']);
  assert.doesNotMatch(JSON.stringify(externalRow), /You are AGY/);
  assert.notEqual(externalRow.recentCalls[0].system, externalRow.recentCalls[1].system);
});


test('routes SIWC Responses with local reasoning replay and unchanged Google traffic', async context => {
  const { proxy, google } = await nativeFixture(context, [], true);
  const upstreamFetch = globalThis.fetch;
  const sent = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) !== 'https://api.openai.com/v1/responses') {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      return upstreamFetch(url, options);
    }
    sent.push({ payload: JSON.parse(options.body), headers: options.headers });
    const output = sent.length === 1 ? [
      { type: 'reasoning', id: 'rs_a', encrypted_content: 'opaque-reasoning', summary: [] },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read_file', arguments: '{}' },
    ] : [];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`);
  });
  const catalog = await (await fetch(proxy.url + '/v1internal:fetchAvailableModels', { method: 'POST', body: '{}' })).json();
  const model = `${GROUP}-medium`;
  assert.equal(catalog.models[model].displayName, 'gpt-5.4 · ChatGPT 订阅 (Medium)');
  assert.equal(catalog.groupedModels[GROUP].displayName, 'gpt-5.4 · ChatGPT 订阅');
  const tools = [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'OBJECT', properties: {} } }] }];
  const user = { role: 'user', parts: [{ text: 'Read the sample' }] };
  const systemInstruction = { parts: [{ text: 'You are AGY.' }] };
  const first = await generation(proxy, { model, project: 'google-project', request: { tools, systemInstruction, contents: [user] } });
  assert.equal(first.status, 200);
  const call = events(await first.text()).flatMap(event => event.response.candidates?.[0]?.content?.parts || []).find(part => part.functionCall);
  assert.equal(call.functionCall.id, 'call_a');
  assert.equal(call.thoughtSignature, PLACEHOLDER_SIGNATURE);
  const second = await generation(proxy, { model, request: { tools, systemInstruction, contents: [user,
    { role: 'model', parts: [call] },
    { role: 'model', parts: [{ functionResponse: { id: 'call_a', name: 'read_file', response: { output: 'sample' } } }] },
  ] } });
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(sent.length, 2);
  for (const { headers, payload } of sent) {
    assert.equal(headers.authorization, 'Bearer test-oauth-token');
    assert.equal(headers['x-goog-api-client'], undefined);
    assert.equal(payload.instructions, 'You are AGY.');
    assert.doesNotMatch(JSON.stringify(payload), /google-token|google-project|prompt_cache_key/);
  }
  assert.ok(sent[1].payload.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-reasoning'));
  assert.ok(sent[1].payload.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_a'));
  const official = { model: 'gemini-4-neon-low', request: { contents: [user] } };
  await (await generation(proxy, official)).text();
  assert.equal(google.find(row => row.url.startsWith('/v1internal:streamGenerateContent')).body.toString(), JSON.stringify(official));
  await proxy.close();
});
