'use strict';
const { execFile } = require('node:child_process');

function defaultTerminate(proc) {
  const kill = () => {
    if (!proc.kill('SIGTERM')) throw new Error('无法停止语言服务。');
  };
  if (process.platform !== 'win32' || !proc.pid) return kill();
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, error => {
      if (!error) return resolve();
      try { kill(); resolve(); } catch (failure) { reject(failure); }
    });
  });
}
function createRestarter(getProcess, terminate = defaultTerminate) {
  let pending;
  async function restartWith(action) {
    if (pending) throw new Error('语言服务正在重启。');
    const proc = getProcess();
    if (!proc || proc.exitCode != null || proc.signalCode != null) return action();
    return new Promise((resolve, reject) => {
      const request = { action, resolve, reject };
      pending = request;
      const clearTimer = () => clearTimeout(request.timer);
      proc.once('exit', clearTimer);
      const failed = error => {
        if (pending !== request) return;
        clearTimer();
        proc.removeListener('exit', clearTimer);
        pending = undefined;
        reject(error);
      };
      try {
        request.timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
        Promise.resolve(terminate(proc)).catch(failed);
      } catch (error) {
        failed(error);
      }
    });
  }
  async function beforeRestart() {
    if (!pending) return false;
    const request = pending;
    pending = undefined;
    clearTimeout(request.timer);
    try {
      request.resolve(await request.action());
    } catch (error) {
      request.reject(error);
    }
    return true;
  }
  return { restartWith, beforeRestart };
}

const restarter = createRestarter(() => require('../languageServer.js').getLsProcess());
module.exports = { createRestarter, restartWith: (...args) => restarter.restartWith(...args),
  beforeRestart: (...args) => restarter.beforeRestart(...args) };
