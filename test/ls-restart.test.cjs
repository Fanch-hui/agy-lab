'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRestarter } = require('../lab/ls-restart.cjs');

function processFixture() {
  const proc = new EventEmitter();
  proc.signals = [];
  proc.kill = signal => { proc.signals.push(signal); return true; };
  return proc;
}

test('runs directly when no language server is live', async () => {
  const restarter = createRestarter(() => null);
  assert.equal(await restarter.restartWith(() => 'done'), 'done');
  assert.equal(await restarter.beforeRestart(), false);
});

test('stops the server and waits until beforeRestart to run the action', async () => {
  const proc = processFixture();
  const restarter = createRestarter(() => proc);
  let called = false;
  const result = restarter.restartWith(() => { called = true; return 'done'; });
  assert.deepEqual(proc.signals, ['SIGTERM']);
  assert.equal(called, false);
  await assert.rejects(restarter.restartWith(() => {}), { message: '语言服务正在重启。' });
  proc.emit('exit');
  assert.equal(await restarter.beforeRestart(), true);
  assert.equal(await result, 'done');
  assert.equal(called, true);
  assert.equal(await restarter.beforeRestart(), false);
});

test('restarts even if the requested action fails', async () => {
  const proc = processFixture();
  const restarter = createRestarter(() => proc);
  const rejected = assert.rejects(restarter.restartWith(() => { throw new Error('action failed'); }), /action failed/);
  proc.emit('exit');
  assert.equal(await restarter.beforeRestart(), true);
  await rejected;
});

test('kills a server that has not exited after five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = processFixture();
  const restarter = createRestarter(() => proc);
  const pending = restarter.restartWith(() => 'done');
  t.mock.timers.tick(4999);
  assert.deepEqual(proc.signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  proc.emit('exit');
  assert.equal(await restarter.beforeRestart(), true);
  assert.equal(await pending, 'done');
});

test('clears the escalation timer when the process exits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = processFixture();
  const restarter = createRestarter(() => proc);
  const pending = restarter.restartWith(() => {});
  proc.emit('exit');
  t.mock.timers.tick(5000);
  assert.deepEqual(proc.signals, ['SIGTERM']);
  await restarter.beforeRestart();
  await pending;
});
