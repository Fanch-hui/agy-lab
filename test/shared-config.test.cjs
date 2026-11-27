'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { linkSharedConfig } = require('../lab/shared-config.cjs');

const quiet = { info() {}, error(message) { throw new Error(message); } };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shared-'));
  const original = path.join(root, 'original');
  const lab = path.join(root, 'lab');
  fs.mkdirSync(path.join(original, 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(original, 'config', 'skills', 'b'), { recursive: true });
  fs.writeFileSync(path.join(original, 'GEMINI.md'), 'original rules');
  return { root, original, lab };
}

test('links rules and skills, keeps the previous Lab copies, and is idempotent', () => {
  const { root, original, lab } = fixture();
  fs.mkdirSync(path.join(lab, 'skills', 'lab-only'), { recursive: true });
  fs.writeFileSync(path.join(lab, 'GEMINI.md'), 'lab rules');

  linkSharedConfig(lab, original, { log: quiet });
  linkSharedConfig(lab, original, { log: quiet });

  assert.equal(fs.readFileSync(path.join(lab, 'GEMINI.md'), 'utf8'), 'original rules');
  assert.ok(fs.existsSync(path.join(lab, 'skills', 'a')));
  assert.ok(fs.existsSync(path.join(lab, 'config', 'skills', 'b')));
  assert.equal(fs.readFileSync(path.join(lab, 'GEMINI.md.lab-local'), 'utf8'), 'lab rules');
  assert.ok(fs.existsSync(path.join(lab, 'skills.lab-local', 'lab-only')));
  assert.deepEqual(fs.readdirSync(lab).sort(), ['GEMINI.md', 'GEMINI.md.lab-local', 'config', 'skills', 'skills.lab-local']);

  fs.writeFileSync(path.join(lab, 'GEMINI.md'), 'edited in Lab');
  assert.equal(fs.readFileSync(path.join(original, 'GEMINI.md'), 'utf8'), 'edited in Lab');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaves the Lab copy alone when the original has none', () => {
  const { root, original, lab } = fixture();
  fs.rmSync(path.join(original, 'GEMINI.md'));
  fs.mkdirSync(lab, { recursive: true });
  fs.writeFileSync(path.join(lab, 'GEMINI.md'), 'lab rules');

  linkSharedConfig(lab, original, { log: quiet });

  assert.equal(fs.lstatSync(path.join(lab, 'GEMINI.md')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(lab, 'GEMINI.md'), 'utf8'), 'lab rules');
  fs.rmSync(root, { recursive: true, force: true });
});
