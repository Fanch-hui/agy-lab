'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { createKeychainSlot } = require('../lab/google-credential-slot.cjs');

test('rejects unsafe credential values without starting security', async t => {
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected spawn'); });
  const slot = createKeychainSlot({ service: 'agy-lab-test', account: 'invalid-test' });
  for (const value of ['go-keyring-base64:abc def', 'go-keyring-base64:abc"def', 'go-keyring-base64:abc\ndef']) {
    await assert.rejects(slot.write(value), { message: '无法识别 Lab 的 Google 登录格式。' });
  }
  assert.equal(spawn.mock.callCount(), 0);
});

test('round-trips a throwaway keychain item', { skip: process.platform !== 'darwin' }, async t => {
  const slot = createKeychainSlot({ service: 'agy-lab-test', account: `slot-test-${crypto.randomUUID()}` });
  t.after(() => slot.remove());
  const first = 'go-keyring-base64:' + Buffer.from('first fixture').toString('base64');
  const second = 'go-keyring-base64:' + Buffer.from('second fixture').toString('base64');
  assert.equal(await slot.read(), undefined);
  await slot.write(first);
  assert.equal(await slot.read(), first);
  await slot.write(second);
  assert.equal(await slot.read(), second);
  await slot.remove();
  assert.equal(await slot.read(), undefined);
  await slot.remove();
});
