'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-file.cjs');
const { labSlot } = require('./google-credential-slot.cjs');
const restarter = require('./ls-restart.cjs');

function emailOf(slot, value) {
  try {
    const data = JSON.parse(slot.payloadOf(value));
    if (typeof data?.token?.refresh_token !== 'string' || !data.token.refresh_token ||
        typeof data.id_token_email !== 'string' || !data.id_token_email) throw new Error();
    return data.id_token_email;
  } catch {
    throw new Error('无法识别 Lab 的 Google 登录格式。');
  }
}

function createGoogleAccounts({ storageFile, encryption, slot, restartWith }) {
  let mutating = false;
  let queue = Promise.resolve();
  function serialize(action) {
    const task = queue.then(action);
    queue = task.then(() => undefined, () => undefined);
    return task;
  }
  function storageReady() {
    if (!encryption.isAvailable()) throw new Error('系统密钥存储不可用。');
  }
  function readStore() {
    storageReady();
    try {
      const envelope = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw new Error();
      const data = JSON.parse(encryption.decrypt(Buffer.from(envelope.encrypted, 'base64')));
      if (!Array.isArray(data.accounts) || data.accounts.some(row => !row || emailOf(slot, row.value) !== row.email) ||
          new Set(data.accounts.map(row => row.email)).size !== data.accounts.length) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { accounts: [] };
      throw new Error('无法读取已保存的 Google 账号，原文件未更改。');
    }
  }
  function writeStore(data) {
    storageReady();
    const encrypted = Buffer.from(encryption.encrypt(JSON.stringify(data))).toString('base64');
    writeFileAtomic(storageFile, JSON.stringify({ version: 1, encrypted }));
  }
  async function sync() {
    const data = readStore();
    const value = await slot.read();
    if (value === undefined) return { data, current: undefined };
    const current = emailOf(slot, value);
    const saved = data.accounts.find(row => row.email === current);
    if (!saved || saved.value !== value) {
      if (saved) saved.value = value;
      else data.accounts.push({ email: current, value });
      writeStore(data);
    }
    return { data, current };
  }
  async function listNow() {
    const { data, current } = await sync();
    return { supported: true, accounts: data.accounts.map(row => ({ email: row.email, current: row.email === current })) };
  }
  function list() {
    return serialize(listNow);
  }
  async function mutation(action) {
    if (mutating) throw new Error('正在切换 Google 账号。');
    mutating = true;
    try { return await serialize(action); } finally { mutating = false; }
  }
  async function switchTo(email) {
    return mutation(async () => {
      const { data, current } = await sync();
      const target = data.accounts.find(row => row.email === email);
      if (!target) throw new Error('该 Google 账号已移除。');
      if (current !== email) await restartWith(() => slot.write(target.value));
      return listNow();
    });
  }
  async function prepareAdd() {
    return mutation(async () => {
      const { current } = await sync();
      if (current !== undefined) await restartWith(() => slot.remove());
      return listNow();
    });
  }
  async function remove(email) {
    return mutation(async () => {
      const { data, current } = await sync();
      if (!data.accounts.some(row => row.email === email)) throw new Error('该 Google 账号已移除。');
      if (current === email) await restartWith(() => slot.remove());
      data.accounts = data.accounts.filter(row => row.email !== email);
      writeStore(data);
      return listNow();
    });
  }
  return { list, switchTo, prepareAdd, remove };
}

let singleton;
function defaults() {
  if (!singleton) {
    const slot = labSlot();
    if (!slot) {
      const unsupported = async () => { throw new Error('此平台暂不支持切换 Google 账号。'); };
      singleton = { list: async () => ({ supported: false, accounts: [] }),
        switchTo: unsupported, prepareAdd: unsupported, remove: unsupported };
    } else {
      const { app, safeStorage } = require('electron');
      singleton = createGoogleAccounts({ storageFile: path.join(app.getPath('userData'), 'google-accounts.json'), slot,
        encryption: { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: s => safeStorage.encryptString(s),
          decrypt: b => safeStorage.decryptString(b) }, restartWith: restarter.restartWith });
    }
  }
  return singleton;
}
module.exports = { createGoogleAccounts,
  ...Object.fromEntries(['list', 'switchTo', 'prepareAdd', 'remove'].map(key => [key, (...args) => {
    if (process.platform === 'win32' && require('./wsl.cjs').isActive()) {
      if (key === 'list') return Promise.resolve({ supported: false, accounts: [] });
      return Promise.reject(new Error('WSL 工作区暂不支持切换 Google 账号。'));
    }
    return defaults()[key](...args);
  }])) };
