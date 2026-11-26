'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { messagesFor, toolsFor } = require('../lab/provider-wire.cjs');

test('converts Gemini integer keywords encoded as strings', () => {
  const [tool] = toolsFor({ tools: [{ functionDeclarations: [{
    name: 'update_steps',
    parameters: { type: 'OBJECT', properties: {
      steps: { type: 'ARRAY', maxItems: '12', items: { type: 'STRING', minLength: '1' } },
      maxItems: { type: 'INTEGER', description: '12' },
    } },
  }] }] });
  const { properties } = tool.function.parameters;
  assert.equal(properties.steps.maxItems, 12);
  assert.equal(properties.steps.items.minLength, 1);
  assert.equal(properties.steps.items.type, 'string');
  assert.deepEqual(properties.maxItems, { type: 'integer', description: '12' });
});

test('pairs tool results sent in model-role contents', () => {
  const messages = messagesFor({ contents: [
    { role: 'user', parts: [{ text: 'run tests' }] },
    { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'run_command', args: { CommandLine: 'node --test' } } }] },
    { role: 'model', parts: [{ functionResponse: { id: 'call_1', name: 'run_command', response: { output: '2 failed' } } }] },
    { role: 'model', parts: [{ text: 'Two tests fail.' }] },
  ] });
  assert.deepEqual(messages.slice(1), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
      function: { name: 'run_command', arguments: '{"CommandLine":"node --test"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"output":"2 failed"}' },
    { role: 'assistant', content: 'Two tests fail.' },
  ]);
});

test('retries a request that failed before any response, up to three times', async () => {
  const { postStream } = require('../lab/provider-wire.cjs');
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'ECONNRESET' }) });
  let calls = 0;
  const ok = { ok: true };
  const recovered = await postStream('https://example.test', {}, {
    delay: 0, fetch: async () => { calls += 1; if (calls < 3) throw reset(); return ok; },
  });
  assert.equal(recovered, ok);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(postStream('https://example.test', {}, {
    delay: 0, fetch: async () => { calls += 1; throw reset(); },
  }), /fetch failed \(ECONNRESET: other side closed\)，已自动重试 3 次/);
  assert.equal(calls, 4);
});

test('does not retry a request the caller cancelled', async () => {
  const { postStream } = require('../lab/provider-wire.cjs');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(postStream('https://example.test', { signal: controller.signal }, {
    delay: 0, fetch: async () => { calls += 1; throw new DOMException('aborted', 'AbortError'); },
  }));
  assert.equal(calls, 1);
});
