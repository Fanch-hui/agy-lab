'use strict';

// Exports the model list the running language server shows to the UI, to check whether
// injected catalogue entries survive the server's own filtering. Only model names, enums and
// sort groups are written; the CSRF token stays in the main process.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { app } = require('electron');

const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

function userStatus() {
  const { getActiveLsPort, getActiveLsCsrfToken } = require('../authBootstrap');
  const port = getActiveLsPort();
  if (!port) return Promise.reject(new Error('语言服务未运行。'));
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path: STATUS_PATH, method: 'POST',
      // The language server presents a self-signed loopback certificate, as in the app's own calls.
      rejectUnauthorized: false, agent: false, timeout: 10000,
      headers: {
        'content-type': 'application/json', 'connect-protocol-version': '1',
        'x-codeium-csrf-token': getActiveLsCsrfToken(), 'content-length': '2',
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GetUserStatus 返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('GetUserStatus 超时。')));
    request.on('error', reject);
    request.end('{}');
  });
}

async function exportModelDiagnostics() {
  const status = await userStatus();
  const data = status.userStatus?.cascadeModelConfigData || {};
  const configs = (data.clientModelConfigs || []).map(config => ({
    label: config.label, modelId: config.modelId, model: config.modelOrAlias?.model ?? config.modelOrAlias,
    disabled: config.disabled, tagTitle: config.tagTitle,
  }));
  const report = {
    exportedAt: new Date().toISOString(),
    errorMessage: data.errorMessage,
    configCount: configs.length,
    externalConfigs: configs.filter(config => config.modelId?.startsWith('agy-ext-')),
    configs,
    sorts: data.clientModelSorts,
    otherKeys: Object.keys(data),
  };
  const file = path.join(app.getPath('userData'), 'model-diagnostics.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return file;
}

module.exports = { exportModelDiagnostics };
