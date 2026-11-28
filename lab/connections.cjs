'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, safeStorage } = require('electron');
const { writeFileAtomic } = require('./atomic-file.cjs');
const { normalizeBaseUrl } = require('./provider.cjs');
const { discoverModels: fetchModels, normalizeReasoningEfforts } = require('./model-discovery.cjs');

const siwc = require('./siwc.cjs');
const accounts = require('./siwc-accounts.cjs');
const { DEFAULT_CONTEXT_TOKENS, contextTokensOf } = require('./native-models.cjs');

function filename() {
  return path.join(app.getPath('userData'), 'model-connections.json');
}

function records() {
  const file = filename();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('无法读取已保存的模型连接，原文件未更改。');
  }
}

function write(rows) {
  writeFileAtomic(filename(), JSON.stringify(rows));
}

function publicRow({ id, model, baseUrl, reasoningEfforts, authType, contextTokens }) {
  return {
    id, model, baseUrl: authType === 'siwc' ? siwc.SIWC_RESOURCE_URL : baseUrl,
    contextTokens: contextTokens || DEFAULT_CONTEXT_TOKENS,
    ...(authType === 'siwc' ? { authType } : {}),
    ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
  };
}

function listConnections() {
  return records().map(publicRow);
}

function getConnection(id) {
  const row = records().find(item => item.id === id);
  if (!row) throw new Error('该连接已移除。');
  if (row.authType === 'siwc') throw new Error('ChatGPT 订阅连接需要异步获取令牌。');
  let apiKey = '';
  if (row.key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用。');
    apiKey = safeStorage.decryptString(Buffer.from(row.key, 'base64'));
  }
  return { ...publicRow(row), apiKey };
}

// The language server reads the catalogue at startup, so a new size applies after a restart.
function setContextTokens(id, value) {
  const contextTokens = contextTokensOf(value);
  if (!contextTokens) throw new Error('上下文大小需在 8K 到 10M 之间。');
  const rows = records();
  const row = rows.find(item => item.id === id);
  if (!row) throw new Error('该连接已移除。');
  row.contextTokens = contextTokens;
  write(rows);
  return publicRow(row);
}

function removeConnection(id) {
  write(records().filter(item => item.id !== id));
}

async function resolveConnection(id, signal) {
  const row = records().find(item => item.id === id);
  if (!row) throw new Error('该连接已移除。');
  if (row.authType !== 'siwc') return getConnection(id);
  return { ...publicRow(row), apiKey: await accounts.getAccessToken(signal) };
}

async function discoverModels(input, signal) {
  if (!input || typeof input !== 'object') throw new Error('无效的模型发现请求。');
  const connection = input.connectionId ? await resolveConnection(input.connectionId, signal)
    : input.authType === 'siwc' ? { authType: 'siwc', baseUrl: siwc.SIWC_RESOURCE_URL, apiKey: await accounts.getAccessToken(signal) } : input;
  return fetchModels(connection, signal);
}

function saveDiscoveredModels(input) {
  if (!input || typeof input !== 'object') throw new Error('请选择要添加的模型。');
  let { connectionId, baseUrl, apiKey, models, authType } = input;
  if (!Array.isArray(models) || !models.length ||
      models.some(model => typeof model?.id !== 'string' || !model.id.trim())) {
    throw new Error('请选择要添加的模型。');
  }
  const rows = records();
  let key;
  let isSiwc = authType === 'siwc';
  if (connectionId) {
    const source = rows.find(row => row.id === connectionId);
    if (!source) throw new Error('该连接已移除，请重新选择。');
    baseUrl = source.baseUrl;
    isSiwc = source.authType === 'siwc';
    key = source.key;
  } else if (!isSiwc) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('请输入有效的接口根地址。');
    baseUrl = normalizeBaseUrl(baseUrl.trim());
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用。');
      key = safeStorage.encryptString(apiKey).toString('base64');
    }
  }

  if (isSiwc) { baseUrl = siwc.SIWC_RESOURCE_URL; key = undefined; }
  const saved = [];
  const uniqueModels = new Map(models.map(model => [model.id.trim(), model]));
  for (const [model, details] of uniqueModels) {
    let row = rows.find(item => item.baseUrl === baseUrl && item.model === model && (item.authType === 'siwc') === isSiwc);
    if (!row) {
      row = { id: randomUUID(), baseUrl, model };
      rows.push(row);
    }
    // A size the service reports fills only an unset one, so a user's choice survives a refetch.
    const reported = contextTokensOf(details.contextTokens);
    if (reported && !row.contextTokens) row.contextTokens = reported;
    if (isSiwc) row.authType = 'siwc';
    if (key) row.key = key;
    else delete row.key;
    const reasoningEfforts = normalizeReasoningEfforts(details.reasoningEfforts);
    if (reasoningEfforts.length) row.reasoningEfforts = reasoningEfforts;
    else delete row.reasoningEfforts;
    saved.push(publicRow(row));
  }
  write(rows);
  return saved;
}

module.exports = {
  listConnections, getConnection, resolveConnection, removeConnection, setContextTokens,
  discoverModels, saveDiscoveredModels,
};
