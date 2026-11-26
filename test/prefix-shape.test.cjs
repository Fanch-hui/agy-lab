'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prefixShape } = require('../lab/prefix-shape.cjs');

function request(task, tools) {
  return {
    systemInstruction: { parts: [{ text: `<identity>\nYou are AGY.\n</identity>\n\n# Task Context\n${task}\n\nKeep edits small.` }] },
    tools: [{ functionDeclarations: tools.map(name => ({ name, description: `${name} secret-description` })) }],
  };
}

test('describes the prefix by paragraph and tool hashes without its text', () => {
  const first = prefixShape(request('Fix /Users/me/private/date.js', ['read_file', 'run_command']));
  const second = prefixShape(request('Update the README', ['read_file', 'edit_file']));
  const text = JSON.stringify(first);
  assert.doesNotMatch(text, /You are AGY|private|secret-description|Keep edits/);
  assert.deepEqual(first.systemSections.map(section => section.label), ['<identity>', '# Task Context', undefined]);
  assert.equal(first.systemSections[0].hash, second.systemSections[0].hash);
  assert.notEqual(first.systemSections[1].hash, second.systemSections[1].hash);
  assert.equal(first.systemSections[2].hash, second.systemSections[2].hash);
  assert.deepEqual(first.toolList.map(tool => tool.name), ['read_file', 'run_command']);
  assert.equal(first.toolList[0].hash, second.toolList[0].hash);
  assert.notEqual(first.system, second.system);
});
