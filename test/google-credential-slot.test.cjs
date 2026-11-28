'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { createKeychainSlot, createWindowsCredentialSlot } = require('../lab/google-credential-slot.cjs');

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

test('Windows slot reads, writes and deletes via a script without exposing credentials', async () => {
  const calls = [];
  const responses = [];
  const slot = createWindowsCredentialSlot({ target: 'gemini:test-account', user: 'test-account',
    run: async (script, stdin) => { calls.push({ script, stdin }); return responses.shift(); } });
  const secret = JSON.stringify({ id_token_email: '测试@example.test', token: { refresh_token: 'private-token' } });
  responses.push({ code: 44, stdout: '' });
  assert.equal(await slot.read(), undefined);
  responses.push({ code: 0, stdout: Buffer.from(secret).toString('base64') + '\n' });
  assert.equal(await slot.read(), secret);
  assert.equal(slot.payloadOf(secret), secret);
  responses.push({ code: 0, stdout: '' }, { code: 0, stdout: Buffer.from(secret).toString('base64') });
  await slot.write(secret);
  assert.equal(calls[2].stdin, Buffer.from(secret).toString('base64'));
  responses.push({ code: 44, stdout: '' });
  await slot.remove();
  for (const { script } of calls) {
    assert.match(script, /\n'@\n/);
    assert.match(script, /\$target = 'gemini:test-account'\n\$user = 'test-account'\n/);
    assert.doesNotMatch(script, /private-token|测试@example\.test/);
    assert.equal(script.includes(Buffer.from(secret).toString('base64')), false);
  }
});

test('Windows slot validates inputs and reports operation and verification failures', async () => {
  assert.throws(() => createWindowsCredentialSlot({ target: "bad'target", user: 'user' }), /凭据管理器/);
  assert.throws(() => createWindowsCredentialSlot({ target: 'target', user: 'bad\nuser' }), /凭据管理器/);
  const responses = [];
  const slot = createWindowsCredentialSlot({ target: 'test', user: 'user', run: async () => responses.shift() });
  await assert.rejects(slot.write(''), { message: '无法识别 Lab 的 Google 登录格式。' });
  assert.throws(() => slot.payloadOf(null), { message: '无法识别 Lab 的 Google 登录格式。' });
  responses.push({ code: 1, stdout: '' });
  await assert.rejects(slot.read(), { message: '无法读取凭据管理器中的 Google 登录。' });
  responses.push({ code: 1, stdout: '' });
  await assert.rejects(slot.write('secret'), { message: '无法写入凭据管理器中的 Google 登录。' });
  responses.push({ code: 0, stdout: '' }, { code: 0, stdout: Buffer.from('different').toString('base64') });
  await assert.rejects(slot.write('secret'), { message: '无法写入凭据管理器中的 Google 登录。' });
  responses.push({ code: 1, stdout: '' });
  await assert.rejects(slot.remove(), { message: '无法移除凭据管理器中的 Google 登录。' });
});
