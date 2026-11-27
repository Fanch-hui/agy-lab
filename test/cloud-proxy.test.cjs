'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { expectProbe, startCloudProxy } = require('../lab/cloud-proxy.cjs');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(context, handler) {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    handler(request, response);
  });
  const origin = await listen(upstream);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cloud-proxy-test-'));
  const inventoryFile = path.join(directory, 'inventory.json');
  const proxy = await startCloudProxy({ upstream: origin + '/', inventoryFile });
  context.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { proxy, received, inventoryFile };
}

test('forwards requests unchanged and streams responses back', async context => {
  const { proxy, received } = await fixture(context, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
    response.write('data: one\n\n');
    setTimeout(() => response.end('data: two\n\n'), 20);
  });
  const body = Buffer.from('{"model":"gemini-test","request":{"contents":[{"parts":[{"text":"é"}]}]}}  ');
  const response = await fetch(proxy.url + '/v1internal:streamGenerateContent?alt=sse', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-value', 'x-goog-custom': 'kept' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-upstream'), 'yes');
  assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/v1internal:streamGenerateContent?alt=sse');
  assert.deepEqual(received[0].body, body);
  assert.equal(received[0].headers.authorization, 'Bearer secret-value');
  assert.equal(received[0].headers['x-goog-custom'], 'kept');
});


test('answers a probe once without forwarding or recording it', async context => {
  const { proxy, received } = await fixture(context, (_request, response) => response.end('{}'));
  const probe = expectProbe();
  const first = await fetch(proxy.url + probe.path);
  assert.equal(first.status, 204);
  assert.equal(await first.text(), '');
  assert.equal(probe.seen(), true);
  assert.equal(received.length, 0);
  assert.deepEqual(proxy.inventory.snapshot(), []);

  const second = await fetch(proxy.url + probe.path);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), '{}');
  assert.equal(received.length, 1);
  assert.equal(received[0].url, probe.path);
});

test('records only path, query names, model and status', async context => {
  const { proxy, inventoryFile } = await fixture(context, (request, response) => {
    response.writeHead(request.url.startsWith('/missing') ? 404 : 200);
    response.end('{}');
  });
  const headers = { 'content-type': 'application/json', authorization: 'Bearer secret-value' };
  await (await fetch(proxy.url + '/v1internal:loadCodeAssist?key=secret-query', {
    method: 'POST', headers, body: '{"metadata":{"secretField":"secret-body"}}' })).text();
  await (await fetch(proxy.url + '/v1internal:streamGenerateContent', {
    method: 'POST', headers, body: '{"model":"gemini-a","request":{}}' })).text();
  await (await fetch(proxy.url + '/v1internal:streamGenerateContent', {
    method: 'POST', headers, body: '{"request":{"model":"gemini-b"}}' })).text();
  await (await fetch(proxy.url + '/missing')).text();
  await proxy.close();
  const saved = fs.readFileSync(inventoryFile, 'utf8');
  assert.doesNotMatch(saved, /secret/);
  const rows = Object.fromEntries(JSON.parse(saved).requests.map(row => [row.path, row]));
  assert.deepEqual(rows['/v1internal:streamGenerateContent'].models, { 'gemini-a': 1, 'gemini-b': 1 });
  assert.equal(rows['/v1internal:streamGenerateContent'].count, 2);
  assert.deepEqual(rows['/v1internal:loadCodeAssist'].queryKeys, ['key']);
  assert.deepEqual(rows['/missing'].statuses, { 404: 1 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(inventoryFile).mode & 0o777, 0o600);
});

test('reports an unreachable endpoint without retrying', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cloud-proxy-test-'));
  const closed = http.createServer();
  const origin = await listen(closed);
  await new Promise(resolve => closed.close(resolve));
  const proxy = await startCloudProxy({ upstream: origin, inventoryFile: path.join(directory, 'inventory.json') });
  context.after(async () => {
    await proxy.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const response = await fetch(proxy.url + '/v1internal:fetchAvailableModels', { method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  assert.deepEqual(proxy.inventory.snapshot()[0].statuses, { 'upstream-error': 1 });
});

test('stops the upstream request when the client disconnects', async context => {
  let upstreamClosed;
  const closedUpstream = new Promise(resolve => { upstreamClosed = resolve; });
  const { proxy } = await fixture(context, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    response.on('close', upstreamClosed);
  });
  const controller = new AbortController();
  const response = await fetch(proxy.url + '/v1internal:streamGenerateContent', {
    method: 'POST', body: '{}', signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await closedUpstream;
});

test('never forwards to a host named in the request line', async context => {
  const { proxy, received } = await fixture(context, (_request, response) => response.end('{}'));
  const port = new URL(proxy.url).port;
  for (const target of ['//example.invalid/path', 'http://example.invalid/path']) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method: 'GET', path: target }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 400);
  }
  assert.equal(received.length, 0);
});
