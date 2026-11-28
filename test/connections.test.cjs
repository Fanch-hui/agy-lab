'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('adds discovered models with an existing connection credential', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-connection-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const electron = {
    app: { getPath: () => directory },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from('encrypted:' + value),
      decryptString: value => value.toString().slice('encrypted:'.length),
    },
  };
  const originalLoad = Module._load;
  let connections;
  try {
    Module._load = function(request, ...args) {
      return request === 'electron' ? electron : originalLoad.call(this, request, ...args);
    };
    connections = require('../lab/connections.cjs');
  } finally {
    Module._load = originalLoad;
  }

  const source = { id: 'existing-connection', baseUrl: 'https://example.test/v1', model: 'existing' };
  const key = electron.safeStorage.encryptString('test-provider-key').toString('base64');
  fs.writeFileSync(path.join(directory, 'model-connections.json'), JSON.stringify([{ ...source, key }]));
  const [added] = connections.saveDiscoveredModels({
    connectionId: source.id,
    models: [{ id: 'new-model', reasoningEfforts: ['high', 'unknown', 'high'] }],
  });
  assert.deepEqual(added.reasoningEfforts, ['high']);
  assert.equal(connections.getConnection(added.id).apiKey, 'test-provider-key');
  assert.equal(connections.getConnection(source.id).model, 'existing');
  assert.equal('apiKey' in added, false);

  const [same] = connections.saveDiscoveredModels({
    connectionId: source.id,
    models: [{ id: 'new-model' }],
  });
  assert.equal(same.id, added.id);
  assert.equal(same.reasoningEfforts, undefined);
  assert.equal(connections.listConnections().length, 2);
  assert.equal(connections.getConnection(same.id).apiKey, 'test-provider-key');

  // A reported context size fills an unset one; the user's own size survives a refetch.
  assert.equal(same.contextTokens, 512000);
  assert.equal(connections.saveDiscoveredModels({ connectionId: source.id, models: [{ id: 'new-model', contextTokens: 400000 }] })[0].contextTokens, 400000);
  assert.equal(connections.setContextTokens(same.id, 128000).contextTokens, 128000);
  assert.equal(connections.saveDiscoveredModels({ connectionId: source.id, models: [{ id: 'new-model', contextTokens: 400000 }] })[0].contextTokens, 128000);
  assert.throws(() => connections.setContextTokens(same.id, 100), /8K/);
  assert.equal(connections.listConnections().find(row => row.id === same.id).contextTokens, 128000);
});

test('keeps SIWC and API key connections separate for the same model', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-siwc-connections-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modulePath = require.resolve('../lab/connections.cjs');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  let connections;
  try {
    Module._load = function(request, ...args) {
      if (request !== 'electron') return originalLoad.call(this, request, ...args);
      return { app: { getPath: () => directory }, safeStorage: {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
      } };
    };
    connections = require(modulePath);
  } finally { Module._load = originalLoad; delete require.cache[modulePath]; }
  const accounts = require('../lab/siwc-accounts.cjs');
  const baseUrl = 'https://api.openai.com/v1';
  const models = [{ id: 'gpt-5.4' }];
  const [key] = connections.saveDiscoveredModels({ baseUrl, apiKey: 'test-key', models });
  const [subscription] = connections.saveDiscoveredModels({ authType: 'siwc', baseUrl: 'https://example.test', apiKey: 'ignored-key', models });
  assert.notEqual(subscription.id, key.id);
  assert.equal(connections.listConnections().length, 2);
  assert.equal(connections.getConnection(key.id).apiKey, 'test-key');
  assert.throws(() => connections.getConnection(subscription.id), /异步/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'model-connections.json'))).find(row => row.id === subscription.id).key, undefined);
  const signal = new AbortController().signal;
  context.mock.method(accounts, 'getAccessToken', async current => {
    assert.equal(current, signal);
    return 'test-oauth-token';
  });
  assert.deepEqual(await connections.resolveConnection(subscription.id, signal), {
    id: subscription.id, model: 'gpt-5.4', authType: 'siwc', baseUrl, contextTokens: 512000, apiKey: 'test-oauth-token',
  });
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, baseUrl + '/models');
    assert.equal(init.headers.authorization, 'Bearer test-oauth-token');
    return Response.json({ models: [{ slug: 'gpt-5.4', visibility: 'list' }] });
  });
  assert.deepEqual(await connections.discoverModels({ authType: 'siwc' }, signal), [{ id: 'gpt-5.4' }]);
});

test('reports corrupt connections store without altering it and rejects invalid baseUrl', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-corrupt-connections-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modulePath = require.resolve('../lab/connections.cjs');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  let connections;
  try {
    Module._load = function(request, ...args) {
      if (request !== 'electron') return originalLoad.call(this, request, ...args);
      return { app: { getPath: () => directory }, safeStorage: {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
      } };
    };
    connections = require(modulePath);
  } finally { Module._load = originalLoad; delete require.cache[modulePath]; }

  assert.throws(() => connections.saveDiscoveredModels({ baseUrl: null, models: [{ id: 'm' }] }), /接口根地址/);
  const storeFile = path.join(directory, 'model-connections.json');
  fs.writeFileSync(storeFile, '{corrupt');
  assert.throws(() => connections.listConnections(), /原文件未更改/);
  assert.equal(fs.readFileSync(storeFile, 'utf8'), '{corrupt');
});
