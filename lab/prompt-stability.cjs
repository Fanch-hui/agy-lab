'use strict';

// Keeps the cacheable prefix of OpenAI requests stable while AGY changes it between steps.
// OpenAI (GPT-5.6 and later) looks cached prefixes up only at the end of the opening
// developer block and at later message endings, and any tool-list change invalidates them.
// AGY swaps one tool and a few system-prompt paragraphs when the agent enters or leaves plan
// mode, which re-bills the whole history. Following OpenAI's guidance, this module:
// - sends one stable tool list per connection (every tool AGY has offered, in first-seen
//   order) and names the tools AGY offers this time, for `allowed_tools`;
// - keeps the first system prompt of a session as the system message and states later
//   changes in a developer message appended after the history.
const fs = require('node:fs');

const TOOL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
// A change larger than this share of the paragraphs is treated as a new prompt, not an update.
const MAX_CHANGED_SHARE = 0.5;

function paragraphs(systemInstruction) {
  const text = (systemInstruction?.parts || []).map(part => part.text || '').join('\n\n');
  return text.split(/\n\s*\n/).filter(paragraph => paragraph.trim());
}

function sameDeclaration(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateText(removed, added) {
  const sections = ['System instructions update from the host application. It takes precedence over ' +
    'the system instructions at the start of this conversation.'];
  if (removed.length) sections.push('These paragraphs of the system instructions no longer apply:', ...removed);
  if (added.length) sections.push(removed.length ? 'They are replaced by:' : 'Additional system instructions:', ...added);
  return sections.join('\n\n');
}

// Describes how `current` differs from `base` as one contiguous replaced block, or returns
// undefined when the prompts are too different to describe as an update.
function systemDifference(base, current) {
  let start = 0;
  while (start < base.length && start < current.length && base[start] === current[start]) start++;
  let end = 0;
  while (end < base.length - start && end < current.length - start &&
         base[base.length - 1 - end] === current[current.length - 1 - end]) end++;
  const removed = base.slice(start, base.length - end);
  const added = current.slice(start, current.length - end);
  if (removed.length + added.length > MAX_CHANGED_SHARE * base.length) return undefined;
  return { removed, added };
}

class PromptStability {
  constructor(file) {
    this.file = file;
    this.catalogs = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    this.sessions = new Map();
  }

  // Returns the stable tool list for a connection after merging the tools of this request.
  stableTools(connectionId, declarations, now = Date.now()) {
    const catalog = (this.catalogs[connectionId] ||= []);
    let changed = false;
    for (const declaration of declarations) {
      const entry = catalog.find(item => item.declaration.name === declaration.name);
      if (!entry) {
        catalog.push({ declaration, seenAt: now });
        changed = true;
      } else {
        if (!sameDeclaration(entry.declaration, declaration)) {
          entry.declaration = declaration;
          changed = true;
        }
        entry.seenAt = now;
      }
    }
    const kept = catalog.filter(item => now - item.seenAt <= TOOL_TTL_MS);
    if (kept.length !== catalog.length) changed = true;
    this.catalogs[connectionId] = kept;
    if (changed) this.save();
    return kept.map(item => item.declaration);
  }

  // Returns the system instruction to send and, when the prompt changed within the session,
  // the developer message that states the change.
  stableSystem(sessionId, systemInstruction) {
    if (!sessionId || !systemInstruction) return { systemInstruction };
    const current = paragraphs(systemInstruction);
    const base = this.sessions.get(sessionId);
    if (base) {
      const difference = systemDifference(base.paragraphs, current);
      if (difference) {
        this.touch(sessionId, base);
        if (!difference.removed.length && !difference.added.length) return { systemInstruction: base.systemInstruction };
        return { systemInstruction: base.systemInstruction, update: updateText(difference.removed, difference.added) };
      }
    }
    this.touch(sessionId, { systemInstruction, paragraphs: current });
    return { systemInstruction };
  }

  // Rewrites a Gemini-format request for OpenAI's cache and returns what the provider
  // request needs: the tool names AGY offered and the optional system update.
  apply(connectionId, request) {
    const offered = (request.tools || []).flatMap(group => group.functionDeclarations || []);
    if ((request.tools || []).some(group => !Array.isArray(group.functionDeclarations))) return { request };
    const tools = this.stableTools(connectionId, offered);
    const { systemInstruction, update } = this.stableSystem(request.sessionId, request.systemInstruction);
    return {
      request: { ...request, systemInstruction, tools: tools.length ? [{ functionDeclarations: tools }] : undefined },
      allowedTools: offered.map(declaration => declaration.name),
      systemUpdate: update,
    };
  }

  touch(sessionId, value) {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, value);
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
  }

  save() {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.catalogs) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      // The catalogue only improves caching; a failed write must not interrupt the request.
      console.error('无法保存外部模型工具目录：', error.message);
    }
  }
}

module.exports = { PromptStability, systemDifference };
