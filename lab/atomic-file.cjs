'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Write `content` to `file` atomically via a unique temporary file in the same directory. */
function writeFileAtomic(file, content, options = {}) {
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? 'utf8';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding, flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

module.exports = { writeFileAtomic };
