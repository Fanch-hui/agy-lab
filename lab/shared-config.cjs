'use strict';

// Global rules and Skills carry no account state, so the Lab links them to the original app's
// copies: edits on either side show up in both. Everything else in the gemini directory
// (conversations, plugins, config.json, MCP config) stays Lab-only.
const fs = require('node:fs');
const path = require('node:path');

const SHARED = [
  { rel: 'GEMINI.md', dir: false },
  { rel: 'skills', dir: true },
  { rel: path.join('config', 'skills'), dir: true },
];

function sameLink(target, source) {
  try {
    return path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source);
  } catch {
    return false;
  }
}

function freeName(base) {
  let name = base;
  for (let i = 2; fs.existsSync(name); i++) name = `${base}-${i}`;
  return name;
}

function linkOne(labDir, originalDir, { rel, dir }, platform) {
  const source = path.join(originalDir, rel);
  const target = path.join(labDir, rel);
  if (!fs.existsSync(source)) return 'missing';
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && sameLink(target, source)) return 'linked';

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Create the link beside the target first, so a failed link never leaves the Lab without its copy.
  const pending = freeName(`${target}.agy-lab-link`);
  const type = dir ? (platform === 'win32' ? 'junction' : 'dir') : 'file';
  fs.symlinkSync(source, pending, type);
  let kept = null;
  if (current?.isSymbolicLink()) {
    fs.unlinkSync(target);
  } else if (current) {
    kept = freeName(`${target}.lab-local`);
    fs.renameSync(target, kept);
  }
  fs.renameSync(pending, target);
  return kept ? `linked; previous Lab copy kept at ${kept}` : 'linked';
}

function linkSharedConfig(labDir, originalDir, { platform = process.platform, log = console } = {}) {
  for (const entry of SHARED) {
    try {
      const result = linkOne(labDir, originalDir, entry, platform);
      if (result.startsWith('linked;')) log.info(`[agy-lab] shared ${entry.rel}: ${result}`);
    } catch (error) {
      log.error(`[agy-lab] could not share ${entry.rel} with the original app: ${error.message}`);
    }
  }
}

module.exports = { linkSharedConfig, SHARED };
