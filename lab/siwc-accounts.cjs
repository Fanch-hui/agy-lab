'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./atomic-file.cjs');
const { createSiwcAuth } = require('./siwc.cjs');

function createSiwcAccounts({ directory, encryption, createAuth = createSiwcAuth }) {
  const indexFile = path.join(directory, 'chatgpt-accounts.json');
  const instances = new Map();
  const accountFile = id => path.join(directory, id === 'default' ? 'chatgpt-siwc.json' : `chatgpt-siwc-${id}.json`);
  function auth(id) {
    if (!instances.has(id)) instances.set(id, createAuth({ storageFile: accountFile(id), encryption }));
    return instances.get(id);
  }
  function readIndex() {
    let contents;
    try {
      contents = fs.readFileSync(indexFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (fs.existsSync(accountFile('default')) && auth('default').getStatus().status !== 'disconnected') {
        return { version: 1, active: 'default', ids: ['default'] };
      }
      return { version: 1, active: null, ids: [] };
    }
    try {
      const index = JSON.parse(contents);
      const validId = id => typeof id === 'string' && (id === 'default' ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
      if (index?.version !== 1 || !Array.isArray(index.ids) || !index.ids.every(validId) ||
          new Set(index.ids).size !== index.ids.length ||
          (index.ids.length ? !index.ids.includes(index.active) : index.active !== null)) throw new Error();
      return index;
    } catch {
      throw new Error('无法读取已保存的 ChatGPT 账号列表，原文件未更改。');
    }
  }
  function writeIndex(index) {
    writeFileAtomic(indexFile, JSON.stringify(index));
  }
  function requireAccount(index, id) {
    if (!index.ids.includes(id)) throw new Error('该 ChatGPT 账号已移除。');
    return auth(id);
  }
  function list() {
    const index = readIndex();
    return index.ids.map(id => ({ id, active: index.active === id, ...auth(id).getStatus() }));
  }
  function discard(id) {
    fs.rmSync(accountFile(id), { force: true });
    instances.delete(id);
  }
  async function add(options) {
    readIndex();
    const id = crypto.randomUUID();
    const current = auth(id);
    try {
      await current.signIn(options);
      const index = readIndex();
      const subject = current.getSubject();
      if (index.ids.some(existing => auth(existing).getSubject() === subject)) {
        await current.signOut();
        throw new Error('该 ChatGPT 账号已添加。请先在浏览器里切换到另一个 ChatGPT 账号，再添加。');
      }
      index.ids.push(id);
      if (index.active === null) index.active = id;
      writeIndex(index);
    } catch (error) {
      discard(id);
      throw error;
    }
    return list();
  }
  async function signIn(id, options) {
    await requireAccount(readIndex(), id).signIn(options);
    return list();
  }
  function setActive(id) {
    const index = readIndex();
    requireAccount(index, id);
    index.active = id;
    writeIndex(index);
    return list();
  }
  async function remove(id) {
    const index = readIndex();
    const current = requireAccount(index, id);
    index.ids = index.ids.filter(existing => existing !== id);
    if (index.active === id) index.active = index.ids[0] ?? null;
    writeIndex(index);
    let result;
    try {
      result = await current.signOut();
    } finally {
      discard(id);
    }
    return { accounts: list(), remoteRevoked: result.remoteRevoked, warning: result.warning };
  }
  async function getAccessToken(signal) {
    const { active } = readIndex();
    if (active === null) throw new Error('请登录 ChatGPT。');
    return auth(active).getAccessToken(signal);
  }
  return { list, add, signIn, setActive, remove, getAccessToken };
}

let singleton;
function defaults() {
  if (!singleton) {
    const { app, safeStorage } = require('electron');
    singleton = createSiwcAccounts({ directory: app.getPath('userData'), encryption: {
      isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: s => safeStorage.encryptString(s), decrypt: b => safeStorage.decryptString(b),
    } });
  }
  return singleton;
}
module.exports = { createSiwcAccounts,
  ...Object.fromEntries(['list', 'add', 'signIn', 'setActive', 'remove', 'getAccessToken'].map(key => [key, (...args) => defaults()[key](...args)])) };
