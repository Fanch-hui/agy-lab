'use strict';

// Keeps provider-specific reasoning state out of the language server's history.
// The language server (and therefore Google) only ever sees Google's documented placeholder
// signature on external tool calls; the provider's own signature is kept here and restored
// when the history is sent back to the same provider.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { writeFileAtomic } = require('./atomic-file.cjs');

const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
const MAX_ENTRIES = 5000;

function callKeys(call) {
  const digest = createHash('sha256').update(JSON.stringify([call.name, call.args ?? {}])).digest('hex');
  return [call.id && `id:${call.id}`, `call:${digest}`].filter(Boolean);
}

class SignatureStore {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    if (!file || !fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('invalid signature store');
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          this.entries.set(entry[0], entry[1]);
        }
      }
    } catch (error) {
      console.error('无法读取签名缓存，已重置：', error.message);
    }
  }

  // Replaces provider signatures on outgoing tool calls with the placeholder.
  conceal(parts) {
    let changed = false;
    for (const part of parts) {
      if (!part.functionCall) continue;
      if (part.thoughtSignature && part.thoughtSignature !== PLACEHOLDER_SIGNATURE) {
        for (const key of callKeys(part.functionCall)) this.entries.set(key, part.thoughtSignature);
        changed = true;
      }
      part.thoughtSignature = PLACEHOLDER_SIGNATURE;
    }
    if (changed) this.save();
  }

  // Restores provider signatures in a history before it is sent to the provider.
  reveal(contents) {
    for (const content of contents || []) {
      for (const part of content.parts || []) {
        if (!part.functionCall || part.thoughtSignature !== PLACEHOLDER_SIGNATURE) continue;
        const key = callKeys(part.functionCall).find(item => this.entries.has(item));
        if (key) part.thoughtSignature = this.entries.get(key);
        else delete part.thoughtSignature;
      }
    }
  }

  save() {
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
    if (!this.file) return;
    try {
      writeFileAtomic(this.file, JSON.stringify([...this.entries]));
    } catch (error) {
      console.error('无法保存签名缓存：', error.message);
    }
  }
}

module.exports = { PLACEHOLDER_SIGNATURE, SignatureStore };
