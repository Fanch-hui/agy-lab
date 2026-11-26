'use strict';

// Diagnostic record of Cloud Code traffic. It keeps paths, counts, statuses and the
// structure of selected payloads (field names and value types). Values are kept only for
// enum-like constants, tool names, model names and, for the model catalogue, fields that do
// not look like account data. Header values are never seen here.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SAMPLED = {
  '/v1internal:streamGenerateContent': { request: true, response: true },
  '/v1internal:fetchAvailableModels': { request: true, response: true, catalogue: true },
  '/v1internal:writeTrajectoryAcls': { request: true },
};
const MAX_SAMPLE = 8 * 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_VALUES = 64;
const SENSITIVE_KEY = /project|email|user|account|secret|password|credential|cookie|session|^auth|(?:access|refresh|id|auth|bearer|oauth)_?token|(?:api|private|access)_?key/i;
const ENUM_VALUE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ROLE_VALUE = new Set(['user', 'model', 'function', 'system', 'tool']);
const MODEL_NAME = /\b(?:gemini|claude|gpt|o\d|chat-bison|code-bison|imagen|gemma|agy-ext)-[a-z0-9][a-z0-9.-]{0,60}/gi;

function newShape() {
  return { types: new Set(), values: new Map(), fields: new Map(), items: undefined };
}

function keepValue(context, value) {
  if (context.sensitive) return false;
  if (typeof value === 'string') {
    if (ENUM_VALUE.test(value) || ROLE_VALUE.has(value)) return true;
    if (context.key === 'name' && /functionDeclarations|functionCall/.test(context.path)) return true;
    return context.catalogue && value.length <= 200;
  }
  return context.catalogue;
}

function addShape(shape, value, context) {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  shape.types.add(type);
  if (context.depth >= MAX_DEPTH) return;
  if (type === 'array') {
    shape.items ??= newShape();
    for (const item of value) addShape(shape.items, item, { ...context, path: context.path + '[]', depth: context.depth + 1 });
    return;
  }
  if (type === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (!shape.fields.has(key)) shape.fields.set(key, newShape());
      addShape(shape.fields.get(key), child, {
        ...context, key, path: `${context.path}.${key}`, depth: context.depth + 1,
        sensitive: context.sensitive || SENSITIVE_KEY.test(key),
      });
    }
    return;
  }
  if (type === 'null' || !keepValue(context, value)) return;
  if (!shape.values.has(type)) shape.values.set(type, new Set());
  const values = shape.values.get(type);
  if (values.size < MAX_VALUES) values.add(value);
}

function serializeShape(shape) {
  const type = [...shape.types].sort().join('|');
  if (!shape.values.size && !shape.fields.size && !shape.items) return type;
  const out = { type };
  if (shape.values.size) out.values = Object.fromEntries([...shape.values].map(([name, set]) => [name, [...set]]));
  if (shape.fields.size) out.fields = Object.fromEntries([...shape.fields].map(([key, child]) => [key, serializeShape(child)]));
  if (shape.items) out.items = serializeShape(shape.items);
  return out;
}

function decodeBody(buffer, encoding) {
  switch ((encoding || 'identity').toLowerCase()) {
    case 'identity': return buffer;
    case 'gzip': return zlib.gunzipSync(buffer);
    case 'deflate': return zlib.inflateSync(buffer);
    case 'br': return zlib.brotliDecompressSync(buffer);
    default: throw new Error(`Unsupported content encoding: ${encoding}`);
  }
}

// Returns the JSON documents in a body: one for plain JSON, one per `data:` event for SSE.
function payloads(text, contentType) {
  if (!/event-stream/i.test(contentType || '')) return [JSON.parse(text)];
  return text.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim()).filter(data => data && data !== '[DONE]')
    .map(data => JSON.parse(data));
}

const MAX_VARIANTS = 10;
const MAX_CALLS = 200;

// Keeps the most recently seen variants, so the ones that recent calls name stay described.
function withVariant(variants = {}, hash, description) {
  const { [hash]: _, ...others } = variants;
  return Object.fromEntries([...Object.entries(others), [hash, description]].slice(-MAX_VARIANTS));
}

class Inventory {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    this.timer = undefined;
    // Every external call of this run, one JSON line each, so long tasks are not cut to the
    // summary's recent window. Each prefix variant is described once, when first seen.
    this.callsFile = file ? path.join(path.dirname(file), 'external-calls.jsonl') : undefined;
    this.loggedVariants = new Set();
    this.appendCalls(() => fs.writeFileSync(this.callsFile, '', { mode: 0o600 }));
  }

  appendCalls(write) {
    if (!this.callsFile) return;
    try {
      write();
    } catch (error) {
      // Diagnostic only; a failed write must not interrupt model traffic.
      console.error('无法保存外部调用记录：', error.message);
    }
  }

  logCall(url, model, call, shape) {
    const lines = [];
    for (const [kind, hash, description] of [
      ['system', shape.system, shape.systemSections], ['tools', shape.tools, shape.toolList],
    ]) {
      if (this.loggedVariants.has(kind + hash)) continue;
      this.loggedVariants.add(kind + hash);
      lines.push({ variant: kind, hash, description });
    }
    lines.push({ at: new Date().toISOString(), path: url, model, ...call });
    this.appendCalls(() => fs.appendFileSync(this.callsFile, lines.map(line => JSON.stringify(line) + '\n').join('')));
  }

  entry(method, url) {
    const parsed = new URL(url, 'http://localhost');
    const key = `${method} ${parsed.pathname}`;
    if (!this.entries.has(key)) {
      this.entries.set(key, { method, path: parsed.pathname, count: 0, queryKeys: [], models: {}, statuses: {} });
    }
    return { entry: this.entries.get(key), parsed };
  }

  record({ method, url, model, status }) {
    const { entry, parsed } = this.entry(method, url);
    entry.count += 1;
    for (const name of parsed.searchParams.keys()) {
      if (!entry.queryKeys.includes(name)) entry.queryKeys.push(name);
    }
    if (model) entry.models[model] = (entry.models[model] || 0) + 1;
    entry.statuses[status] = (entry.statuses[status] || 0) + 1;
    this.scheduleWrite();
  }

  // Records the role and part kinds of an external history, with tool names and call-id
  // presence only, to diagnose how the language server orders tool calls and results.
  outline(url, contents) {
    const { entry } = this.entry('POST', url);
    const ids = new Map();
    const outline = (contents || []).map(content => `${content.role}: ` + (content.parts || []).map(part => {
      if (part.functionCall) {
        const { id, name } = part.functionCall;
        if (id) ids.set(id, `c${ids.size + 1}`);
        return `call(${name}${id ? `#${ids.get(id)}` : ''}${part.thoughtSignature ? ',sig' : ''})`;
      }
      if (part.functionResponse) {
        const { id, name } = part.functionResponse;
        return `result(${name}${id ? `#${ids.get(id) || 'unknown'}` : ''})`;
      }
      if (part.thought) return 'thought';
      if (typeof part.text === 'string') return 'text';
      return Object.keys(part).join('+');
    }).join(', '));
    entry.recentOutlines = [...(entry.recentOutlines || []), outline].slice(-3);
    this.scheduleWrite();
  }

  // Accumulates the provider's prompt-cache hits and keeps recent prefix hashes: a hash that
  // changes between turns of one conversation means the cacheable prefix is not stable. Each
  // distinct system prompt and tool set is described once, by paragraph and tool hashes.
  externalCall(url, { model, usage, session, requestType, userTurns, shape, systemUpdate, cacheWriteTokens }) {
    const { entry } = this.entry('POST', url);
    const totals = entry.cache ??= { promptTokens: 0, cachedTokens: 0, hitRate: 0 };
    totals.promptTokens += usage?.promptTokenCount || 0;
    totals.cachedTokens += usage?.cachedContentTokenCount || 0;
    totals.hitRate = totals.promptTokens ? Number((totals.cachedTokens / totals.promptTokens).toFixed(3)) : 0;
    entry.systemVariants = withVariant(entry.systemVariants, shape.system, shape.systemSections);
    entry.toolVariants = withVariant(entry.toolVariants, shape.tools, shape.toolList);
    const call = {
      session, requestType, userTurns, system: shape.system, tools: shape.tools, systemUpdate,
      promptTokens: usage?.promptTokenCount, cachedTokens: usage?.cachedContentTokenCount, cacheWriteTokens,
    };
    entry.recentCalls = [...(entry.recentCalls || []), call].slice(-MAX_CALLS);
    this.logCall(url, model, call, shape);
    this.scheduleWrite();
  }

  wantsResponse(url) {
    return Boolean(SAMPLED[new URL(url, 'http://localhost').pathname]?.response);
  }

  sampleRequest(method, url, body, contentType) {
    const { entry, parsed } = this.entry(method, url);
    if (!body.length) return;
    const text = body.toString('utf8');
    entry.modelNamesInBody ??= {};
    for (const name of new Set(text.match(MODEL_NAME) || [])) {
      entry.modelNamesInBody[name] = (entry.modelNamesInBody[name] || 0) + 1;
    }
    const target = SAMPLED[parsed.pathname];
    if (!target?.request) return;
    this.addSample(entry, 'requestShape', () => payloads(text, contentType), target);
  }

  sampleResponse(method, url, body, headers) {
    const { entry, parsed } = this.entry(method, url);
    const target = SAMPLED[parsed.pathname];
    if (!target?.response || !body.length || body.length > MAX_SAMPLE) return;
    this.addSample(entry, 'responseShape', () => payloads(
      decodeBody(body, headers['content-encoding']).toString('utf8'), headers['content-type']), target);
  }

  addSample(entry, field, read, target) {
    let documents;
    try {
      documents = read();
    } catch (error) {
      entry.sampleErrors = (entry.sampleErrors || 0) + 1;
      console.error('无法解析云端请求结构：', entry.path, error.message);
      return;
    }
    entry[field] ??= newShape();
    for (const document of documents) {
      addShape(entry[field], document, { key: '', path: '', depth: 0, sensitive: false, catalogue: Boolean(target.catalogue) });
    }
    this.scheduleWrite();
  }

  snapshot() {
    return [...this.entries.values()].sort((a, b) => b.count - a.count).map(entry => ({
      ...entry,
      ...(entry.requestShape ? { requestShape: serializeShape(entry.requestShape) } : {}),
      ...(entry.responseShape ? { responseShape: serializeShape(entry.responseShape) } : {}),
    }));
  }

  scheduleWrite() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, 500);
    this.timer.unref();
  }

  write() {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    const content = JSON.stringify({ updatedAt: new Date().toISOString(), requests: this.snapshot() }, null, 2);
    try {
      fs.writeFileSync(temporary, content + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      // The inventory is diagnostic; a failed write must not interrupt model traffic.
      console.error('无法保存云端请求清单：', error.message);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }
}

module.exports = { Inventory, MAX_SAMPLE, decodeBody };
