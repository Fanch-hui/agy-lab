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

test('uses the supplied termination function', async () => {
  const proc = processFixture();
  const calls = [];
  const restarter = createRestarter(() => proc, current => { calls.push(current); });
  const pending = restarter.restartWith(() => 'done');
  assert.deepEqual(calls, [proc]);
  assert.deepEqual(proc.signals, []);
  proc.emit('exit');
  await restarter.beforeRestart();
  assert.equal(await pending, 'done');
});

test('Windows termination uses taskkill and falls back to SIGTERM on failure', async t => {
  const childProcess = require('node:child_process');
  const modulePath = require.resolve('../lab/ls-restart.cjs');
  const originalCache = require.cache[modulePath];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    require.cache[modulePath] = originalCache;
  });
  let failure = false;
  const calls = [];
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    calls.push({ command, args, options });
    queueMicrotask(() => callback(failure ? new Error('taskkill failed') : null));
  });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  delete require.cache[modulePath];
  const { createRestarter: createWindowsRestarter } = require(modulePath);
  const proc = processFixture();
  proc.pid = 123;
  const restarter = createWindowsRestarter(() => proc);
  const first = restarter.restartWith(() => 'first');
  assert.deepEqual(calls[0], { command: 'taskkill', args: ['/pid', '123', '/T', '/F'],
    options: { timeout: 5000, windowsHide: true } });
  proc.emit('exit');
  await restarter.beforeRestart();
  assert.equal(await first, 'first');
  failure = true;
  const second = restarter.restartWith(() => 'second');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(proc.signals, ['SIGTERM']);
  proc.emit('exit');
  await restarter.beforeRestart();
  assert.equal(await second, 'second');
});

test('ignores SIGKILL errors if process already exited before timer fired', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = processFixture();
  proc.kill = signal => {
    proc.signals.push(signal);
    if (signal === 'SIGKILL') throw new Error('ESRCH');
    return true;
  };
  const restarter = createRestarter(() => proc);
  const pending = restarter.restartWith(() => 'ok');
  t.mock.timers.tick(5000);
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  proc.emit('exit');
  await restarter.beforeRestart();
  assert.equal(await pending, 'ok');
});
