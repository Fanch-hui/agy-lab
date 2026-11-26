'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PromptStability } = require('../lab/prompt-stability.cjs');
const { requestFor } = require('../lab/responses.cjs');

const BASE = ['<identity>\nYou are AGY.', 'Follow the plan.', 'Mode: execute the steps.', 'Keep edits small.'];

function tool(name) {
  return { name, parameters: { type: 'OBJECT', properties: {} } };
}

function agyRequest(paragraphs, tools, extra = {}) {
  return {
    sessionId: 's1',
    systemInstruction: { parts: [{ text: paragraphs.join('\n\n') }] },
    tools: [{ functionDeclarations: tools.map(tool) }],
    contents: [{ role: 'user', parts: [{ text: 'Fix the bug.' }] }],
    ...extra,
  };
}

function temporaryFile(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stability-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'tools.json');
}

test('keeps the tool list and system prompt stable across a plan-mode switch', context => {
  const file = temporaryFile(context);
  const stability = new PromptStability(file);
  const execute = stability.apply('c1', agyRequest(BASE, ['read_file', 'enter_plan_mode']));
  const planParagraphs = [...BASE.slice(0, 2), 'Mode: write a plan first.', BASE[3]];
  const plan = stability.apply('c1', agyRequest(planParagraphs, ['read_file', 'exit_plan_mode']));
  const back = stability.apply('c1', agyRequest(BASE, ['read_file', 'enter_plan_mode']));

  const names = result => result.request.tools[0].functionDeclarations.map(declaration => declaration.name);
  assert.deepEqual(names(plan), ['read_file', 'enter_plan_mode', 'exit_plan_mode']);
  assert.deepEqual(names(back), names(plan));
  assert.deepEqual(plan.allowedTools, ['read_file', 'exit_plan_mode']);
  assert.deepEqual(plan.request.systemInstruction, execute.request.systemInstruction);
  assert.match(plan.systemUpdate, /no longer apply:\n\nMode: execute the steps\.\n\nThey are replaced by:\n\nMode: write a plan first\./);
  assert.equal(back.systemUpdate, undefined);
  assert.deepEqual(new PromptStability(file).stableTools('c1', []).map(declaration => declaration.name),
    ['read_file', 'enter_plan_mode', 'exit_plan_mode']);
});

test('starts a new base when the system prompt changes too much', () => {
  const stability = new PromptStability();
  stability.apply('c1', agyRequest(BASE, ['read_file']));
  const other = ['A different agent.', 'Other rules.', 'More rules.', 'Keep edits small.'];
  const result = stability.apply('c1', agyRequest(other, ['read_file']));
  assert.equal(result.systemUpdate, undefined);
  assert.match(result.request.systemInstruction.parts[0].text, /^A different agent\./);
});

test('limits callable tools with allowed_tools and appends the update last', () => {
  const stability = new PromptStability();
  stability.apply('c1', agyRequest(BASE, ['read_file', 'enter_plan_mode']));
  const stable = stability.apply('c1', agyRequest([...BASE.slice(0, 2), 'Mode: plan.', BASE[3]], ['read_file', 'exit_plan_mode'],
    { toolConfig: { functionCallingConfig: { mode: 'ANY' } } }));
  const payload = requestFor({ model: 'gpt-test' }, stable.request, 'low',
    { key: 'k', allowedTools: stable.allowedTools, systemUpdate: stable.systemUpdate });
  assert.deepEqual(payload.tools.map(item => item.name), ['read_file', 'enter_plan_mode', 'exit_plan_mode']);
  assert.deepEqual(payload.tool_choice, {
    type: 'allowed_tools', mode: 'required',
    tools: [{ type: 'function', name: 'read_file' }, { type: 'function', name: 'exit_plan_mode' }],
  });
  assert.equal(payload.input[0].role, 'system');
  assert.deepEqual(payload.input.at(-1).role, 'developer');
  assert.match(payload.input.at(-1).content, /Mode: plan\./);
  assert.equal(payload.prompt_cache_key, 'k');

  const none = requestFor({ model: 'gpt-test' }, { ...stable.request, toolConfig: undefined }, 'low', { allowedTools: [] });
  assert.equal(none.tool_choice, 'none');
  assert.equal(none.tools.length, 3);
});
