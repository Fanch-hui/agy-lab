'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGoogleAccounts } = require('../lab/google-accounts.cjs');
const { createKeychainSlot } = require('../lab/google-credential-slot.cjs');

function value(email, token = 'refresh-fixture') {
  return 'go-keyring-base64:' + Buffer.from(JSON.stringify({ token: { refresh_token: token }, id_token_email: email })).toString('base64');
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-google-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storageFile = path.join(directory, 'google-accounts.json');
  const key = crypto.randomBytes(32);
  let writes = 0;
  const encryption = {
    isAvailable: () => true,
    encrypt(text) {
      writes++;
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(data) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
  };
  const slot = {
    value: undefined, writes: 0, removals: 0,
    payloadOf: createKeychainSlot({ service: 'test', account: 'test' }).payloadOf,
    async read() { return this.value; },
    async write(next) { this.writes++; this.value = next; },
    async remove() { this.removals++; this.value = undefined; },
  };
  const restart = { count: 0, gate: undefined };
  const restartWith = async action => { restart.count++; await restart.gate; return action(); };
  const accounts = createGoogleAccounts({ storageFile, encryption, slot, restartWith });
  const stored = () => JSON.parse(encryption.decrypt(Buffer.from(JSON.parse(fs.readFileSync(storageFile)).encrypted, 'base64')));
  return { accounts, slot, restart, storageFile, stored, writes: () => writes };
}

test('lists an empty slot without writing a store', async t => {
  const { accounts, storageFile } = fixture(t);
  assert.deepEqual(await accounts.list(), { supported: true, accounts: [] });
  assert.equal(fs.existsSync(storageFile), false);
});

test('captures current login encrypted and updates refreshed credentials', async t => {
  const { accounts, slot, storageFile, stored, writes } = fixture(t);
  slot.value = value('a@example.test', 'original-secret');
  assert.deepEqual(await accounts.list(), { supported: true, accounts: [{ email: 'a@example.test', current: true }] });
  const contents = fs.readFileSync(storageFile, 'utf8');
  assert.doesNotMatch(contents, /a@example\.test|original-secret/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(storageFile).mode & 0o777, 0o600);
  assert.equal(writes(), 1);
  await accounts.list();
  assert.equal(writes(), 1);
  slot.value = value('a@example.test', 'refreshed-secret');
  await accounts.list();
  assert.deepEqual(stored(), { accounts: [{ email: 'a@example.test', value: slot.value }] });
  assert.equal(writes(), 2);
});

test('prepares another login and switches to the saved account through restart', async t => {
  const { accounts, slot, restart } = fixture(t);
  const first = value('a@example.test', 'first');
  slot.value = first;
  await accounts.list();
  assert.deepEqual(await accounts.prepareAdd(), { supported: true, accounts: [{ email: 'a@example.test', current: false }] });
  assert.equal(slot.value, undefined);
  assert.equal(restart.count, 1);
  slot.value = value('b@example.test', 'second');
  assert.deepEqual((await accounts.list()).accounts, [
    { email: 'a@example.test', current: false }, { email: 'b@example.test', current: true },
  ]);
  await accounts.switchTo('a@example.test');
  assert.equal(slot.value, first);
  assert.equal(restart.count, 2);
  assert.deepEqual((await accounts.list()).accounts, [
    { email: 'a@example.test', current: true }, { email: 'b@example.test', current: false },
  ]);
  await accounts.switchTo('a@example.test');
  assert.equal(restart.count, 2);
});

test('removes non-current and current accounts without revocation', async t => {
  const { accounts, slot, restart } = fixture(t);
  slot.value = value('a@example.test');
  await accounts.prepareAdd();
  slot.value = value('b@example.test');
  await accounts.list();
  const current = slot.value;
  await accounts.remove('a@example.test');
  assert.equal(slot.value, current);
  assert.equal(restart.count, 1);
  assert.deepEqual(await accounts.remove('b@example.test'), { supported: true, accounts: [] });
  assert.equal(slot.value, undefined);
  assert.equal(slot.removals, 2);
  assert.equal(restart.count, 2);
});

test('rejects missing accounts and does not restart', async t => {
  const { accounts, restart } = fixture(t);
  await assert.rejects(accounts.switchTo('missing'), { message: '该 Google 账号已移除。' });
  await assert.rejects(accounts.remove('missing'), { message: '该 Google 账号已移除。' });
  assert.equal(restart.count, 0);
});

test('does not overwrite the store when the slot value is malformed', async t => {
  const { accounts, slot, storageFile } = fixture(t);
  slot.value = value('a@example.test');
  await accounts.list();
  const original = fs.readFileSync(storageFile, 'utf8');
  for (const invalid of ['bad', 'go-keyring-base64:abc', value('', 'token'), value('b@example.test', '')]) {
    slot.value = invalid;
    await assert.rejects(accounts.list(), { message: '无法识别 Lab 的 Google 登录格式。' });
    assert.equal(fs.readFileSync(storageFile, 'utf8'), original);
  }
});

test('rejects concurrent mutations and waits to list until the mutation finishes', async t => {
  const { accounts, slot, restart } = fixture(t);
  slot.value = value('a@example.test');
  await accounts.list();
  let release;
  restart.gate = new Promise(resolve => { release = resolve; });
  const removing = accounts.remove('a@example.test');
  await assert.rejects(accounts.prepareAdd(), { message: '正在切换 Google 账号。' });
  const listing = accounts.list();
  release();
  assert.deepEqual(await removing, { supported: true, accounts: [] });
  assert.deepEqual(await listing, { supported: true, accounts: [] });
});

test('reports a corrupt store without changing it', async t => {
  const { accounts, storageFile } = fixture(t);
  fs.writeFileSync(storageFile, '{broken');
  await assert.rejects(accounts.list(), { message: '无法读取已保存的 Google 账号，原文件未更改。' });
  assert.equal(fs.readFileSync(storageFile, 'utf8'), '{broken');
});

test('stores and switches raw JSON credentials with a Windows-style slot', async t => {
  const { accounts, slot, stored } = fixture(t);
  slot.payloadOf = text => {
    if (typeof text !== 'string' || !text) throw new Error('invalid');
    return text;
  };
  const first = JSON.stringify({ token: { refresh_token: 'one' }, id_token_email: '一@example.test' });
  const second = JSON.stringify({ token: { refresh_token: 'two' }, id_token_email: 'two@example.test' });
  slot.value = first;
  await accounts.prepareAdd();
  slot.value = second;
  await accounts.list();
  assert.deepEqual(stored().accounts, [
    { email: '一@example.test', value: first }, { email: 'two@example.test', value: second },
  ]);
  await accounts.switchTo('一@example.test');
  assert.equal(slot.value, first);
});

test('the default Windows manager checks WSL status on every call', async t => {
  const Module = require('node:module');
  const credential = require('../lab/google-credential-slot.cjs');
  const wsl = require('../lab/wsl.cjs');
  const modulePath = require.resolve('../lab/google-accounts.cjs');
  const originalCache = require.cache[modulePath];
  const originalLoad = Module._load;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-google-wsl-'));
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    Module._load = originalLoad;
    require.cache[modulePath] = originalCache;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let active = false;
  t.mock.method(wsl, 'isActive', () => active);
  t.mock.method(credential, 'labSlot', () => ({ async read() { return undefined; } }));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Module._load = function(request, ...args) {
    if (request === 'electron') return { app: { getPath: () => directory }, safeStorage: { isEncryptionAvailable: () => true } };
    return originalLoad.call(this, request, ...args);
  };
  delete require.cache[modulePath];
  const defaults = require(modulePath);
  assert.deepEqual(await defaults.list(), { supported: true, accounts: [] });
  active = true;
  assert.deepEqual(await defaults.list(), { supported: false, accounts: [] });
  for (const action of [() => defaults.switchTo('a'), () => defaults.prepareAdd(), () => defaults.remove('a')]) {
    await assert.rejects(action(), { message: 'WSL 工作区暂不支持切换 Google 账号。' });
  }
  active = false;
  assert.deepEqual(await defaults.list(), { supported: true, accounts: [] });
});
