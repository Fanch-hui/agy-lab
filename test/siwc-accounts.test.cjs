'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSiwcAccounts } = require('../lab/siwc-accounts.cjs');

function fixture(t, legacy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-siwc-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const indexFile = path.join(directory, 'chatgpt-accounts.json');
  const legacyFile = path.join(directory, 'chatgpt-siwc.json');
  const instances = new Map();
  if (legacy) fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  function createAuth({ storageFile }) {
    assert.equal(instances.has(storageFile), false);
    let state = fs.existsSync(storageFile) ? JSON.parse(fs.readFileSync(storageFile)) : {};
    const instance = {
      storageFile,
      signOutCalls: 0,
      async signIn(options = {}) {
        fs.writeFileSync(storageFile, 'pending');
        if (options.error) throw options.error;
        await options.gate;
        state = { status: 'connected', subject: options.subject, email: options.email || `${options.subject}@example.test` };
        fs.writeFileSync(storageFile, JSON.stringify(state));
      },
      async signOut() {
        instance.signOutCalls++;
        state = {};
        fs.writeFileSync(storageFile, JSON.stringify(state));
        return { remoteRevoked: false, warning: '撤销警告' };
      },
      getStatus: () => ({ status: state.status || 'disconnected', sharing: state.status === 'connected',
        ...(state.email ? { account: { email: state.email } } : {}) }),
      getSubject: () => state.subject,
      getAccessToken: async signal => { signal?.throwIfAborted(); return `token-${state.subject}`; },
    };
    instances.set(storageFile, instance);
    return instance;
  }
  const accounts = createSiwcAccounts({ directory, encryption: {}, createAuth });
  return { accounts, directory, indexFile, legacyFile, instances };
}

test('starts empty without an index or legacy account', async t => {
  const { accounts, indexFile } = fixture(t);
  assert.deepEqual(accounts.list(), []);
  await assert.rejects(accounts.getAccessToken(), { message: '请登录 ChatGPT。' });
  assert.equal(fs.existsSync(indexFile), false);
});

test('uses a connected legacy account in place without writing an index', async t => {
  const { accounts, indexFile, legacyFile } = fixture(t, { status: 'connected', subject: 'legacy', email: 'legacy@example.test' });
  assert.deepEqual(accounts.list(), [{ id: 'default', active: true, status: 'connected', sharing: true, account: { email: 'legacy@example.test' } }]);
  assert.equal(await accounts.getAccessToken(), 'token-legacy');
  assert.equal(fs.existsSync(legacyFile), true);
  assert.equal(fs.existsSync(indexFile), false);
});

test('removes a legacy account before its index has been created', async t => {
  const { accounts, indexFile, legacyFile } = fixture(t, { status: 'connected', subject: 'legacy' });
  assert.deepEqual(await accounts.remove('default'), { accounts: [], remoteRevoked: false, warning: '撤销警告' });
  assert.equal(fs.existsSync(legacyFile), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile)), { version: 1, active: null, ids: [] });
});

test('adds accounts without switching and activates explicitly', async t => {
  const { accounts, indexFile } = fixture(t);
  const [first] = await accounts.add({ subject: 'one' });
  const [same, second] = await accounts.add({ subject: 'two' });
  assert.equal(first.active, true);
  assert.equal(same.active, true);
  assert.equal(second.active, false);
  assert.equal(await accounts.getAccessToken(), 'token-one');
  assert.deepEqual(accounts.setActive(second.id).map(row => row.active), [false, true]);
  assert.equal(await accounts.getAccessToken(), 'token-two');
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile)), { version: 1, active: second.id, ids: [first.id, second.id] });
  if (process.platform !== 'win32') assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600);
  assert.deepEqual((await accounts.signIn(first.id, { subject: 'one' })).map(row => row.active), [false, true]);
});

test('rejects duplicate subjects and revokes and deletes the temporary account', async t => {
  const { accounts, directory, indexFile, instances } = fixture(t);
  const before = await accounts.add({ subject: 'one' });
  const index = fs.readFileSync(indexFile, 'utf8');
  await assert.rejects(accounts.add({ subject: 'one', email: 'different@example.test' }),
    { message: '该 ChatGPT 账号已添加。请先在浏览器里切换到另一个 ChatGPT 账号，再添加。' });
  const added = [...instances.values()].find(instance => instance.signOutCalls);
  assert.equal(added.signOutCalls, 1);
  assert.equal(fs.existsSync(added.storageFile), false);
  assert.deepEqual(accounts.list(), before);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), index);
  assert.equal(fs.readdirSync(directory).length, 2);
});

test('failed sign-in cleans up its file without changing the index', async t => {
  const { accounts, indexFile, instances } = fixture(t);
  const before = await accounts.add({ subject: 'one' });
  const index = fs.readFileSync(indexFile, 'utf8');
  await assert.rejects(accounts.add({ error: new Error('cancelled') }), { message: 'cancelled' });
  const failed = [...instances.values()].at(-1);
  assert.equal(fs.existsSync(failed.storageFile), false);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), index);
  assert.deepEqual(accounts.list(), before);
});

test('removing the active account selects the next and propagates revocation result', async t => {
  const { accounts, indexFile, instances } = fixture(t);
  const [first] = await accounts.add({ subject: 'one' });
  const [, second] = await accounts.add({ subject: 'two' });
  const result = await accounts.remove(first.id);
  assert.deepEqual(result, { accounts: [{ ...second, active: true }], remoteRevoked: false, warning: '撤销警告' });
  assert.equal(await accounts.getAccessToken(), 'token-two');
  assert.equal(fs.existsSync([...instances.values()][0].storageFile), false);
  assert.deepEqual(await accounts.remove(second.id), { accounts: [], remoteRevoked: false, warning: '撤销警告' });
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile)), { version: 1, active: null, ids: [] });
});

test('rejects unknown account ids and preserves invalid indexes', async t => {
  const { accounts, indexFile } = fixture(t);
  assert.throws(() => accounts.setActive('missing'), { message: '该 ChatGPT 账号已移除。' });
  await assert.rejects(accounts.remove('missing'), { message: '该 ChatGPT 账号已移除。' });
  await assert.rejects(accounts.signIn('missing'), { message: '该 ChatGPT 账号已移除。' });
  for (const value of ['{bad', JSON.stringify({ version: 1, active: null, ids: ['../unsafe'] }),
    JSON.stringify({ version: 1, active: 'missing', ids: [] })]) {
    fs.writeFileSync(indexFile, value);
    assert.throws(() => accounts.list(), { message: '无法读取已保存的 ChatGPT 账号列表，原文件未更改。' });
    assert.equal(fs.readFileSync(indexFile, 'utf8'), value);
  }
});

test('preserves other changes made while an add is waiting for sign-in', async t => {
  const { accounts } = fixture(t);
  const [first] = await accounts.add({ subject: 'one' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = accounts.add({ subject: 'two', gate });
  await accounts.remove(first.id);
  release();
  const result = await pending;
  assert.equal(result.length, 1);
  assert.equal(result[0].active, true);
  assert.equal(await accounts.getAccessToken(), 'token-two');
});
