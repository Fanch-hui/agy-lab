'use strict';
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const execFile = promisify(childProcess.execFile);
const format = /^go-keyring-base64:[A-Za-z0-9+/]+={0,2}$/;

function createKeychainSlot({ service, account }) {
  async function read() {
    try {
      const { stdout } = await execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.replace(/\r?\n$/, '');
    } catch (error) {
      if (error.code === 44) return undefined;
      throw new Error('无法读取钥匙串中的 Google 登录。');
    }
  }
  async function write(value) {
    if (typeof value !== 'string' || !format.test(value)) throw new Error('无法识别 Lab 的 Google 登录格式。');
    const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    if (/[\r\n]/.test(service) || /[\r\n]/.test(account)) throw new Error('无法写入钥匙串中的 Google 登录。');
    await new Promise((resolve, reject) => {
      const process = childProcess.spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      const fail = () => reject(new Error('无法写入钥匙串中的 Google 登录。'));
      process.on('error', fail);
      process.stdin.on('error', fail);
      process.on('close', code => code === 0 ? resolve() : fail());
      process.stdin.end(`add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${value}\n`);
    });
    const written = await read().catch(() => { throw new Error('无法写入钥匙串中的 Google 登录。'); });
    if (written !== value) throw new Error('无法写入钥匙串中的 Google 登录。');
  }
  async function remove() {
    try {
      await execFile('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch (error) {
      if (error.code !== 44) throw new Error('无法移除钥匙串中的 Google 登录。');
    }
  }
  return { read, write, remove };
}
function labSlot() {
  return process.platform === 'darwin' ? createKeychainSlot({ service: 'gemini', account: 'agy-lab-001' }) : undefined;
}
module.exports = { createKeychainSlot, labSlot };
