'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LINK_SCRIPT, forwardEnv, installDir, proxyReachable } = require('../lab/wsl.cjs');

const forwarded = 'ANTIGRAVITY_AUTH_SUCCESS_APP/u';

test('forwardEnv appends without clobbering or duplicating entries', () => {
  const empty = {};
  forwardEnv(empty);
  assert.equal(empty.WSLENV, forwarded);

  const existing = { WSLENV: 'ONE/u:TWO' };
  forwardEnv(existing);
  assert.equal(existing.WSLENV, `ONE/u:TWO:${forwarded}`);

  const present = { WSLENV: `ONE/u:${forwarded}` };
  forwardEnv(present);
  assert.equal(present.WSLENV, `ONE/u:${forwarded}`);

  const lowercase = { WslEnv: 'ONE/u' };
  forwardEnv(lowercase);
  assert.equal(lowercase.WslEnv, `ONE/u:${forwarded}`);
  assert.equal(lowercase.WSLENV, undefined);
});

test('proxyReachable is true when the command reaches the probe', async () => {
  let arrived = false;
  let cancelled = false;
  const probe = {
    path: '/agy-lab-wsl-probe/test',
    seen: () => arrived,
    cancel: () => { cancelled = true; },
  };
  const calls = [];
  const result = await proxyReachable({
    distro: 'Ubuntu',
    proxyUrl: 'http://127.0.0.1:4321',
    expectProbe: () => probe,
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      arrived = true;
    },
    wslExe: 'wsl.exe',
  });
  assert.equal(result, true);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'wsl.exe');
  assert.deepEqual(calls[0].args.slice(0, 5), ['-d', 'Ubuntu', '--exec', 'bash', '-c']);
  assert.deepEqual(calls[0].args.slice(-3), ['bash', '4321', probe.path]);
  assert.equal(calls[0].options.timeout, 5000);
});

test('proxyReachable is false when exec fails before the probe', async () => {
  let cancelled = false;
  const probe = {
    path: '/agy-lab-wsl-probe/test',
    seen: () => false,
    cancel: () => { cancelled = true; },
  };
  const result = await proxyReachable({
    distro: 'Ubuntu',
    proxyUrl: 'http://127.0.0.1:4321',
    expectProbe: () => probe,
    execFile: async () => { throw new Error('connection refused'); },
    wslExe: 'wsl.exe',
  });
  assert.equal(result, false);
  assert.equal(cancelled, true);
});

test('installDir explains when the build has no WSL server', () => {
  assert.throws(
    () => installDir('2.36.0'),
    new Error('此 Lab 构建未包含 WSL 语言服务，请在构建时加上 --wsl-server。'),
  );
});


const posixOnly = { skip: process.platform === 'win32' };

function linkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wsl-link-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}

function runLinkScript(home) {
  execFileSync('sh', ['-c', LINK_SCRIPT, 'sh'], { env: { ...process.env, HOME: home } });
}

function createOriginals(home) {
  fs.mkdirSync(path.join(home, '.gemini/skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini/config/skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini/GEMINI.md'), 'rules');
}

test('LINK_SCRIPT links all shared entries when only originals exist', posixOnly, context => {
  const { root, home } = linkFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createOriginals(home);
  runLinkScript(home);
  for (const rel of ['GEMINI.md', 'skills', 'config/skills']) {
    const target = path.join(home, '.agy-lab/gemini', rel);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(target), path.join(home, '.gemini', rel));
  }
});

test('LINK_SCRIPT keeps an existing Lab skills copy as lab-local', posixOnly, context => {
  const { root, home } = linkFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createOriginals(home);
  const existing = path.join(home, '.agy-lab/gemini/skills');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'local.txt'), 'lab copy');
  runLinkScript(home);
  const parent = path.join(home, '.agy-lab/gemini');
  const backups = fs.readdirSync(parent).filter(name => name.startsWith('skills.lab-local.'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(parent, backups[0], 'local.txt'), 'utf8'), 'lab copy');
  assert.equal(fs.lstatSync(existing).isSymbolicLink(), true);
});

test('LINK_SCRIPT second run is a no-op', posixOnly, context => {
  const { root, home } = linkFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createOriginals(home);
  runLinkScript(home);
  runLinkScript(home);
  const lab = path.join(home, '.agy-lab/gemini');
  const entries = [];
  for (const dir of [lab, path.join(lab, 'config')]) {
    if (fs.existsSync(dir)) entries.push(...fs.readdirSync(dir));
  }
  assert.equal(entries.some(name => name.includes('.lab-local.')), false);
});

test('LINK_SCRIPT creates nothing when originals are absent', posixOnly, context => {
  const { root, home } = linkFixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  runLinkScript(home);
  assert.equal(fs.existsSync(path.join(home, '.agy-lab')), false);
});
