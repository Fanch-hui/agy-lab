'use strict';
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { createWindowsCredentialSlot } = require('./google-credential-slot-windows.cjs');
const execFile = promisify(childProcess.execFile);
const format = /^go-keyring-base64:[A-Za-z0-9+/]+={0,2}$/;
const CREDENTIAL_TIMEOUT_MS = 15000;

function createKeychainSlot({ service, account }) {
  function payloadOf(value) {
    if (typeof value !== 'string' || !format.test(value)) throw new Error('无法识别 Lab 的 Google 登录格式。');
    return Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  }
  async function read() {
    try {
      const { stdout } = await execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: CREDENTIAL_TIMEOUT_MS });
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
      const proc = childProcess.spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      let timer;
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('无法写入钥匙串中的 Google 登录。'));
      };
      timer = setTimeout(() => {
        try { proc.kill?.('SIGKILL'); } catch {}
        fail();
      }, CREDENTIAL_TIMEOUT_MS);
      proc.on('error', fail);
      proc.stdin.on('error', fail);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else fail();
      });
      proc.stdin.end(`add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${value}\n`);
    });
    const written = await read().catch(() => { throw new Error('无法写入钥匙串中的 Google 登录。'); });
    if (written !== value) throw new Error('无法写入钥匙串中的 Google 登录。');
  }
  async function remove() {
    try {
      await execFile('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: CREDENTIAL_TIMEOUT_MS });
    } catch (error) {
      if (error.code !== 44) throw new Error('无法移除钥匙串中的 Google 登录。');
    }
  }
  return { read, write, remove, payloadOf };
}
function labSlot() {
  if (process.platform === 'darwin') return createKeychainSlot({ service: 'gemini', account: 'agy-lab-001' });
  if (process.platform === 'win32') return createWindowsCredentialSlot({ target: 'gemini:agy-lab-001', user: 'agy-lab-001' });
  return undefined;
}
module.exports = { createKeychainSlot, createWindowsCredentialSlot, labSlot };
