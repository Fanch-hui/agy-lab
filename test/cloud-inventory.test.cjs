'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Inventory } = require('../lab/cloud-inventory.cjs');

const json = { 'content-type': 'application/json' };

test('keeps generation structure, enums and tool names but not text', () => {
  const inventory = new Inventory();
  const body = Buffer.from(JSON.stringify({
    model: 'gemini-4-neon-medium', project: 'secret-project',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'secret prompt' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { Path: '/secret/path' } } }] }],
      tools: [{ functionDeclarations: [{ name: 'run_command', description: 'secret description' }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    },
  }));
  inventory.sampleRequest('POST', '/v1internal:streamGenerateContent?alt=sse', body, 'application/json');
  const [row] = inventory.snapshot();
  const saved = JSON.stringify(row);
  assert.doesNotMatch(saved, /secret/);
  const request = row.requestShape.fields.request.fields;
  assert.deepEqual(request.contents.items.fields.role.values.string, ['user', 'model']);
  assert.deepEqual(request.tools.items.fields.functionDeclarations.items.fields.name.values.string, ['run_command']);
  const call = request.contents.items.fields.parts.items.fields.functionCall.fields;
  assert.deepEqual(call.name.values.string, ['read_file']);
  assert.equal(call.args.fields.Path, 'string');
  assert.deepEqual(request.toolConfig.fields.functionCallingConfig.fields.mode.values.string, ['AUTO']);
  assert.equal(row.requestShape.fields.model, 'string');
  assert.deepEqual(row.modelNamesInBody, { 'gemini-4-neon-medium': 1 });
});

test('keeps catalogue values except account fields', () => {
  const inventory = new Inventory();
  const catalogue = {
    models: { 'gemini-4-neon-medium': { displayName: 'Neon', maxTokens: 1000, supportsImages: true } },
    project: { id: 'secret-project' }, userTier: 'secret-tier', accessToken: 'secret-token', apiKey: 'secret-key',
  };
  inventory.sampleResponse('POST', '/v1internal:fetchAvailableModels',
    zlib.gzipSync(JSON.stringify(catalogue)), { ...json, 'content-encoding': 'gzip' });
  const [row] = inventory.snapshot();
  assert.doesNotMatch(JSON.stringify(row), /secret/);
  const model = row.responseShape.fields.models.fields['gemini-4-neon-medium'].fields;
  assert.deepEqual(model.displayName.values.string, ['Neon']);
  assert.deepEqual(model.maxTokens.values.number, [1000]);
  assert.equal(row.responseShape.fields.project.fields.id, 'string');
});

test('merges every event of a streamed response', () => {
  const inventory = new Inventory();
  const events = [
    { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'secret' }] } }] } },
    { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } } },
  ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  inventory.sampleResponse('POST', '/v1internal:streamGenerateContent?alt=sse', Buffer.from(events),
    { 'content-type': 'text/event-stream' });
  const [row] = inventory.snapshot();
  const fields = row.responseShape.fields.response.fields;
  assert.deepEqual(fields.candidates.items.fields.finishReason.values.string, ['STOP']);
  assert.equal(fields.usageMetadata.fields.totalTokenCount, 'number');
  assert.doesNotMatch(JSON.stringify(row), /secret/);
});

test('counts model names in unsampled requests and reports unreadable bodies', () => {
  const inventory = new Inventory();
  inventory.sampleRequest('POST', '/v1internal:loadCodeAssist', Buffer.from('{"note":"uses gemini-3.5-flash-lite"}'), 'application/json');
  inventory.sampleRequest('POST', '/v1internal:writeTrajectoryAcls', Buffer.from('not json'), 'application/json');
  const rows = Object.fromEntries(inventory.snapshot().map(row => [row.path, row]));
  assert.deepEqual(rows['/v1internal:loadCodeAssist'].modelNamesInBody, { 'gemini-3.5-flash-lite': 1 });
  assert.equal(rows['/v1internal:loadCodeAssist'].requestShape, undefined);
  assert.equal(rows['/v1internal:writeTrajectoryAcls'].sampleErrors, 1);
});

test('outlines a history without its text or arguments', () => {
  const inventory = new Inventory();
  inventory.outline('/agy-lab-external/x', [
    { role: 'user', parts: [{ text: 'secret' }] },
    { role: 'model', parts: [{ text: 'secret', thought: true }, { functionCall: { id: 'call_secret', name: 'run_command', args: { CommandLine: 'secret' } }, thoughtSignature: 's' }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call_secret', name: 'run_command', response: { output: 'secret' } } }] },
  ]);
  const [row] = inventory.snapshot();
  assert.deepEqual(row.recentOutlines, [['user: text', 'model: thought, call(run_command#c1,sig)', 'user: result(run_command#c1)']]);
  assert.doesNotMatch(JSON.stringify(row), /secret/);
});

test('logs every external call and describes each prefix variant once', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'external-calls.jsonl');
  fs.writeFileSync(calls, 'stale run\n');
  const inventory = new Inventory(path.join(dir, 'cloud-request-inventory.json'));
  for (let index = 0; index < 250; index += 1) {
    const plan = index % 2 === 1;
    inventory.externalCall('/agy-lab-external/generate', {
      model: 'agy-ext-test', session: 's1', requestType: 'agent', userTurns: 1,
      usage: { promptTokenCount: 100, cachedContentTokenCount: 80 },
      shape: { system: plan ? 'sys-plan' : 'sys', systemSections: [plan ? 'p' : 'a'], tools: 'tools', toolList: ['read_file'] },
    });
  }
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.filter(line => line.at).length, 250);
  assert.deepEqual(lines.filter(line => line.variant).map(line => line.variant + ':' + line.hash),
    ['system:sys', 'tools:tools', 'system:sys-plan']);
  assert.equal(lines.at(-1).model, 'agy-ext-test');
  assert.equal(inventory.snapshot()[0].recentCalls.length, 200);
  clearTimeout(inventory.timer);
});

test('blocks decompression bombs and ignores malformed outline histories', () => {
  const { decodeBody } = require('../lab/cloud-inventory.cjs');
  const compressed = zlib.gzipSync(Buffer.alloc(4096, 0x41));
  assert.throws(() => decodeBody(compressed, 'gzip', 512));

  const inventory = new Inventory();
  inventory.outline('/agy-lab-external/x', 'not-an-array');
  inventory.outline('/agy-lab-external/x', [{ role: 'user', parts: 'not-parts' }]);
  assert.equal(inventory.snapshot().length, 1);
});
