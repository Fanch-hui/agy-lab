'use strict';

// Local pass-through in front of the Cloud Code endpoint used by the main language server.
// Requests are forwarded to the official endpoint unchanged. The inventory sees request and
// response bodies only to record their structure; header values are never passed to it.
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { Inventory, MAX_SAMPLE, decodeBody } = require('./cloud-inventory.cjs');

const GENERATE_PATH = '/v1internal:streamGenerateContent';
const CATALOGUE_PATH = '/v1internal:fetchAvailableModels';

const MAX_BODY = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function forwardedHeaders(rawHeaders, dropped = []) {
  const headers = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (!HOP_BY_HOP.has(name) && !dropped.includes(name)) headers.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return headers;
}

function jsonBody(body, contentType) {
  if (!body.length || !/json/i.test(contentType || '')) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function modelOf(value) {
  const model = value?.model ?? value?.request?.model;
  return typeof model === 'string' ? model : undefined;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body exceeds the proxy limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function collectResponse(incoming, inventory, request) {
  const chunks = [];
  let size = 0;
  incoming.on('data', chunk => {
    size += chunk.length;
    if (size <= MAX_SAMPLE) chunks.push(chunk);
  });
  incoming.on('end', () => {
    if (size > MAX_SAMPLE) return;
    inventory.sampleResponse(request.method, request.url, Buffer.concat(chunks), incoming.headers);
  });
}

// Sends a rewritten copy of a successful JSON response; the original bytes are still sampled.
function rewriteResponse(incoming, response, inventory, request, rewrite) {
  const chunks = [];
  incoming.on('data', chunk => chunks.push(chunk));
  incoming.on('end', () => {
    const original = Buffer.concat(chunks);
    inventory.sampleResponse(request.method, request.url, original, incoming.headers);
    const headers = forwardedHeaders(incoming.rawHeaders, ['content-encoding', 'content-length']);
    let body;
    try {
      body = Buffer.from(JSON.stringify(rewrite(JSON.parse(decodeBody(original, incoming.headers['content-encoding']).toString('utf8')))));
    } catch (error) {
      console.error('无法向模型目录加入外部模型：', error.message);
      response.writeHead(incoming.statusCode, incoming.statusMessage, forwardedHeaders(incoming.rawHeaders));
      response.end(original);
      return;
    }
    response.writeHead(incoming.statusCode, incoming.statusMessage, [...headers, 'Content-Length', String(body.length)]);
    response.end(body);
  });
}

function forward({ upstream, agent, inventory }, request, response, body, model, rewrite) {
  // Only origin-form paths are accepted, so a request can never redirect the proxy to another host.
  const target = new URL(upstream.origin + request.url);
  const client = target.protocol === 'https:' ? https : http;
  let recorded = false;
  const record = status => {
    if (recorded) return;
    recorded = true;
    inventory.record({ method: request.method, url: request.url, model, status });
  };
  // Raw header arrays bypass Node's defaults, so Host and the body length are set explicitly.
  const headers = ['Host', target.host, ...forwardedHeaders(request.rawHeaders)];
  if (request.headers['content-length'] === undefined && body.length) headers.push('Content-Length', String(body.length));
  const outgoing = client.request(target, { method: request.method, agent, headers }, incoming => {
    record(incoming.statusCode);
    incoming.on('error', () => response.destroy());
    if (rewrite && incoming.statusCode === 200) {
      rewriteResponse(incoming, response, inventory, request, rewrite);
      return;
    }
    response.writeHead(incoming.statusCode, incoming.statusMessage, forwardedHeaders(incoming.rawHeaders));
    if (inventory.wantsResponse(request.url)) collectResponse(incoming, inventory, request);
    incoming.pipe(response);
  });
  response.on('close', () => {
    if (!response.writableFinished) outgoing.destroy();
  });
  outgoing.on('error', error => {
    record('upstream-error');
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { code: 502, message: `Cloud endpoint unreachable: ${error.code || error.message}` } }));
  });
  outgoing.end(body);
}

const probes = new Map();

function expectProbe() {
  const probePath = '/agy-lab-wsl-probe/' + randomUUID();
  const state = { arrived: false };
  probes.set(probePath, state);
  return {
    path: probePath,
    seen() {
      return state.arrived;
    },
    cancel() {
      probes.delete(probePath);
    },
  };
}

// `external` optionally serves generations for external models and extends the catalogue:
// { matches(model), handle(envelope, response), rewriteCatalogue(catalogue) }.
async function startCloudProxy({ upstream, inventoryFile, external }) {
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.pathname !== '/' || upstreamUrl.search) throw new Error('Cloud endpoint must be an origin');
  const inventory = new Inventory(inventoryFile);
  const agent = new (upstreamUrl.protocol === 'https:' ? https : http).Agent({ keepAlive: true });
  const context = { upstream: upstreamUrl, agent, inventory };
  const server = http.createServer(async (request, response) => {
    if (probes.has(request.url)) {
      probes.get(request.url).arrived = true;
      probes.delete(request.url);
      response.writeHead(204);
      response.end();
      return;
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      inventory.record({ method: request.method, url: request.url, status: 'rejected' });
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 413, message: error.message } }));
      return;
    }
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      inventory.record({ method: request.method, url: '/', status: 'rejected' });
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 400, message: 'Only Cloud Code paths are forwarded' } }));
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const value = jsonBody(body, request.headers['content-type']);
    const model = modelOf(value);
    if (external && pathname === GENERATE_PATH && external.matches(model)) {
      // External generations never reach Google and are listed apart from Google traffic.
      inventory.outline('/agy-lab-external' + pathname, value.request?.contents);
      const result = await external.handle(value, response);
      if (result) inventory.externalCall('/agy-lab-external' + pathname, { ...result, model });
      inventory.record({ method: request.method, url: '/agy-lab-external' + pathname, model, status: response.statusCode });
      return;
    }
    inventory.sampleRequest(request.method, request.url, body, request.headers['content-type']);
    const rewrite = external && pathname === CATALOGUE_PATH ? external.rewriteCatalogue : undefined;
    forward(context, request, response, body, model, rewrite);
  });
  // Generation responses are long-lived streams.
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    inventory,
    async close() {
      inventory.flush();
      server.closeAllConnections();
      agent.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

let shared;

function inventoryPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'cloud-request-inventory.json');
}

// Returns the endpoint the main language server should use; starts the proxy once per process.
function nativeRoute() {
  const { app } = require('electron');
  const connections = require('./connections.cjs');
  const { generate } = require('./provider.cjs');
  const { SlotTable } = require('./native-models.cjs');
  const { SignatureStore } = require('./native-signatures.cjs');
  const { createNativeRoute } = require('./native-route.cjs');
  const { PromptStability } = require('./prompt-stability.cjs');
  const data = app.getPath('userData');
  return createNativeRoute({
    listConnections: connections.listConnections,
    getConnection: connections.resolveConnection,
    generate,
    slotTable: new SlotTable(path.join(data, 'native-model-slots.json')),
    signatures: new SignatureStore(path.join(data, 'native-signatures.json')),
    stability: new PromptStability(path.join(data, 'native-tool-catalog.json')),
  });
}

async function cloudEndpoint(officialEndpoint) {
  shared ??= startCloudProxy({
    upstream: officialEndpoint, inventoryFile: inventoryPath(), external: nativeRoute(),
  }).catch(error => {
    shared = undefined;
    throw error;
  });
  return (await shared).url;
}

module.exports = { startCloudProxy, cloudEndpoint, expectProbe, inventoryPath };
