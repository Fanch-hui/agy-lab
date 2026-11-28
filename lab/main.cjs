'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { app, session, BrowserWindow, MenuItem, ipcMain, shell } = require('electron');
require('./zh.cjs').enableChinese(app, session);
// Runs before the language server starts, which reads these from the Lab's gemini directory.
require('./shared-config.cjs').linkSharedConfig(
  path.join(app.getPath('userData'), 'gemini'), path.join(require('node:os').homedir(), '.gemini'));
const connections = require('./connections.cjs');
const { generate } = require('./provider.cjs');
const { probeTools } = require('./tool-probe.cjs');
const { inventoryPath } = require('./cloud-proxy.cjs');
const { exportModelDiagnostics } = require('./model-diagnostics.cjs');

const settingsFile = path.join(__dirname, 'connections.html');
let settingsWindow;
let pendingTest;
let pendingSignIn;
const siwc = require('./siwc.cjs');
const accounts = require('./siwc-accounts.cjs');
const google = require('./google-accounts.cjs');
let discovery;

function register(command, fn) {
  ipcMain.handle('agy-lab:' + command, async (event, ...args) => {
    if (!settingsWindow || event.sender !== settingsWindow.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== pathToFileURL(settingsFile).href) {
      throw new Error('此操作仅限本地模型连接设置窗口。');
    }
    return fn(...args);
  });
}

async function runSiwcSignIn(operation) {
  if (pendingSignIn) throw new Error('正在登录 ChatGPT。');
  const controller = new AbortController();
  pendingSignIn = controller;
  try {
    return await operation({ signal: controller.signal, openBrowser: url => {
      const target = new URL(url);
      if (target.origin !== siwc.SIWC_ISSUER) throw new Error('无效的 ChatGPT 授权地址。');
      return shell.openExternal(target.href);
    } });
  } finally { pendingSignIn = undefined; }
}
function accountId(id) {
  if (typeof id !== 'string') throw new Error('该 ChatGPT 账号已移除。');
  return id;
}
register('siwc-accounts', accounts.list);
register('siwc-add', () => runSiwcSignIn(options => accounts.add(options)));
register('siwc-signin', (id, reconsent) => {
  accountId(id);
  return runSiwcSignIn(options => accounts.signIn(id, { ...options, reconsent: reconsent === true }));
});
register('siwc-activate', id => accounts.setActive(accountId(id)));
register('siwc-remove', id => accounts.remove(accountId(id)));
register('siwc-cancel-signin', () => pendingSignIn?.abort());
function googleEmail(email) {
  if (typeof email !== 'string') throw new Error('该 Google 账号已移除。');
  return email;
}
register('google-accounts', google.list);
register('google-switch', email => google.switchTo(googleEmail(email)));
register('google-add', google.prepareAdd);
register('google-remove', email => google.remove(googleEmail(email)));
register('list', connections.listConnections);
register('discover', async input => {
  discovery?.abort();
  const controller = new AbortController();
  discovery = controller;
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    return await connections.discoverModels(input, signal);
  } finally {
    if (discovery === controller) discovery = undefined;
  }
});
// The language server reads the model catalogue at startup, so changes apply after a restart.
register('save-discovered', connections.saveDiscoveredModels);
register('remove', connections.removeConnection);
register('set-context', connections.setContextTokens);
register('test', async (id, mode) => {
  if (pendingTest) throw new Error('正在测试连接。');
  const controller = new AbortController();
  pendingTest = controller;
  let text = '';
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
    const connection = await connections.resolveConnection(id, signal);
    if (mode === 'tools') {
      const result = await probeTools(connection, signal);
      return (result.ok ? '工具测试通过。' : '工具测试未通过。') + result.message;
    }
    await generate({
      connection,
      request: { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }] },
      signal,
      onChunk: chunk => {
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
          if (part.text && !part.thought) text += part.text;
        }
      },
    });
    if (!text.trim()) throw new Error('服务没有返回文本。');
    return text.trim().slice(0, 200);
  } finally {
    pendingTest = undefined;
  }
});

function openConnections() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    title: '账号与模型连接',
    width: 580, height: 680, minWidth: 430, minHeight: 460,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true,
    },
  });
  if (process.platform === 'win32') settingsWindow.setMenu(null);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.on('closed', () => {
    pendingTest?.abort();
    pendingSignIn?.abort();
    discovery?.abort();
    settingsWindow = undefined;
  });
  void settingsWindow.loadFile(settingsFile);
}

function showCloudInventory() {
  const file = inventoryPath();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else void shell.openPath(path.dirname(file));
}

function showModelDiagnostics() {
  exportModelDiagnostics().then(file => shell.showItemInFolder(file), error => {
    require('electron').dialog.showErrorBox('无法导出模型诊断', error.message);
  });
}

function labMenuItems() {
  return [
    { id: 'agy-lab-connections', label: '账号与模型连接…', click: openConnections },
    { id: 'agy-lab-cloud-inventory', label: '显示云端请求清单', click: showCloudInventory },
    { id: 'agy-lab-model-diagnostics', label: '导出模型诊断', click: showModelDiagnostics },
  ];
}

function addModelMenu(menu) {
  if (menu.getMenuItemById('agy-lab-connections')) return;
  const submenu = menu.items[0]?.submenu;
  if (!submenu) return;
  labMenuItems().forEach((item, index) => {
    submenu.insert(Math.min(index + 1, submenu.items.length), new MenuItem(item));
  });
}

function addTrayMenu(insertTrayMenuItem) {
  insertTrayMenuItem(3, { type: 'separator' });
  labMenuItems().forEach((item, index) => insertTrayMenuItem(4 + index, item));
}

module.exports = { addModelMenu, addTrayMenu };
