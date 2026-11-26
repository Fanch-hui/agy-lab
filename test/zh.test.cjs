'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchContents } = require('../lab/zh.cjs');

function contents(session) {
  const emitter = new EventEmitter();
  emitter.session = session;
  emitter.ran = [];
  emitter.executeJavaScript = async source => { emitter.ran.push(source); };
  return emitter;
}

test('runs the Chinese UI on every app document but never in browser-tab sessions', () => {
  const defaultSession = {};
  const app = contents(defaultSession);
  const browserTab = contents({});
  watchContents(app, 'zh', defaultSession);
  watchContents(browserTab, 'zh', defaultSession);
  app.emit('dom-ready');
  app.emit('dom-ready');
  browserTab.emit('dom-ready');
  assert.deepEqual(app.ran, ['zh', 'zh']);
  assert.deepEqual(browserTab.ran, []);
});
