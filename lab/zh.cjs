'use strict';

// Chinese UI built in from antigravity-zh (see scripts/zh_bundle.mjs). The script runs at each
// document's dom-ready, the same point the project's own injection waits for, without opening a
// debugging port. Built-in browser tabs live in their own session partitions, so only default-session
// contents qualify; the script itself further limits itself to the app's own top-level pages.
const fs = require('node:fs');
const path = require('node:path');

const scriptFile = path.join(__dirname, 'zh-runtime.js');

function watchContents(contents, source, defaultSession) {
  if (contents.session !== defaultSession) return;
  contents.on('dom-ready', () => {
    contents.executeJavaScript(source).catch(error => {
      console.error('[agy-lab] Chinese UI failed to load:', error.message);
    });
  });
}

function enableChinese(app, session) {
  if (!fs.existsSync(scriptFile)) return false;
  const source = fs.readFileSync(scriptFile, 'utf8');
  app.on('web-contents-created', (_event, contents) => watchContents(contents, source, session.defaultSession));
  return true;
}

module.exports = { enableChinese, watchContents };
