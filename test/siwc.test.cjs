'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSiwcAuth, SIWC_RESOURCE_URL } = require('../lab/siwc.cjs');
const { generate } = require('../lab/provider.cjs');
const { discoverModels } = require('../lab/model-discovery.cjs');
const { variantsFor } = require('../lab/native-models.cjs');

const issuer = 'https://auth.example.test';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-siwc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storageFile = path.join(dir, 'state');
  const key = crypto.randomBytes(32);
  const state = { time: Date.now(), available: true, refreshes: 0 };
  const encryption = {
    isAvailable: () => state.available,
    encrypt(s) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(s), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(b) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      cipher.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString();
    },
  };
  function jwt(nonce, kid) {
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const data = `${encode({ alg: 'RS256', kid })}.${encode({ iss: issuer, sub: 'account', aud: options.aud || 'assigned', nonce: options.nonce || nonce, iat: Math.floor(state.time / 1000), exp: Math.floor(state.time / 1000) + 600 })}`;
    return `${data}.${options.badSignature ? 'AAAA' : crypto.sign('RSA-SHA256', Buffer.from(data), pair.privateKey).toString('base64url')}`;
  }
  const auth = createSiwcAuth({ issuer, storageFile, encryption, now: () => state.time,
    async fetch(url, init) {
      assert.equal(init.redirect, 'error');
      const endpoint = new URL(url).pathname;
      if (endpoint.startsWith('/.well-known')) return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke' });
      if (endpoint === '/keys') return state.keyOutage ? new Response(null, { status: 503 }) : Response.json({ keys: ['initial', 'new'].map(kid => ({ ...pair.publicKey.export({ format: 'jwk' }), kid })).filter(k => state.refreshes || k.kid === 'initial') });
      if (endpoint === '/revoke') { state.revoked = init.body.get('token'); return new Response(); }
      assert.equal(endpoint, '/token');
      assert.equal(init.body.get('resource'), SIWC_RESOURCE_URL);
      assert.equal(init.body.get('client_id'), 'assigned');
      if (init.body.get('grant_type') === 'refresh_token') {
        ++state.refreshes;
        await state.refreshGate;
        if (state.invalidGrant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'rotated', refresh_token: 'next-refresh', token_type: 'Bearer', expires_in: 120, id_token: jwt(undefined, 'new') });
      }
      assert.equal(init.body.get('redirect_uri'), state.callback);
      assert.equal(crypto.createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), state.challenge);
      return Response.json({ access_token: 'first-token', refresh_token: 'first-refresh', token_type: 'Bearer', expires_in: 120, scope, id_token: jwt(state.nonce, 'initial') });
    },
    async openBrowser(url) {
      const q = new URL(url).searchParams;
      assert.equal(q.get('client_id'), 'dynamic_agent_client');
      assert.equal(q.get('agent_name_hint'), 'AGY Lab');
      assert.equal(q.get('scope'), scope);
      assert.equal(q.get('resource'), SIWC_RESOURCE_URL);
      assert.equal(q.get('code_challenge_method'), 'S256');
      Object.assign(state, { callback: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge') });
      if (options.cancel) return options.cancel.abort();
      const bad = await fetch(`${state.callback}?state=wrong&error=access_denied`);
      assert.equal(bad.status, 400);
      await bad.text();
      const reply = await fetch(`${state.callback}?state=${q.get('state')}&${options.denied ? 'error=access_denied' : 'code=private-code&client_id=assigned'}`);
      assert.equal(reply.status, 200);
      assert.doesNotMatch(await reply.text(), /private-code|assigned|access_denied/);
    },
  });
  return { auth, state, storageFile };
}

test('verifies OAuth, encrypts credentials, checkpoints rotation and revokes', async t => {
  const { auth, state, storageFile } = fixture(t);
  assert.deepEqual(await auth.signIn(), { status: 'connected', sharing: true, account: {} });
  if (process.platform !== 'win32') assert.equal(fs.statSync(storageFile).mode & 0o777, 0o600);
  const before = fs.readFileSync(storageFile, 'utf8');
  assert.doesNotMatch(before, /first-token|first-refresh|assigned/);
  state.available = false;
  await assert.rejects(auth.signIn(), /密钥存储/);
  assert.equal(fs.readFileSync(storageFile, 'utf8'), before);
  state.available = true;
  state.time += 61000;
  state.keyOutage = true;
  const results = await Promise.allSettled([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(state.refreshes, 1);
  assert.ok(results.every(x => x.reason?.code === 'identity_verification_unavailable'));
  state.keyOutage = false;
  assert.equal(await auth.getAccessToken(), 'rotated');
  assert.equal(state.refreshes, 1);
  assert.equal((await auth.signOut()).remoteRevoked, true);
  assert.equal(state.revoked, 'next-refresh');
  await assert.rejects(auth.getAccessToken(), /请登录/);
});
for (const options of [{ aud: 'wrong' }, { nonce: 'wrong' }, { badSignature: true }, { denied: true }]) {
  test(`rejects invalid OAuth result: ${Object.keys(options)[0]}`, async t => {
    const { auth } = fixture(t, options);
    await assert.rejects(auth.signIn(), error => ['invalid_id_token', 'access_denied'].includes(error.code));
    assert.equal(auth.getStatus().sharing, false);
  });
}
test('aborting sign-in closes the callback', async t => {
  const cancel = new AbortController();
  const { auth, state } = fixture(t, { cancel });
  await assert.rejects(auth.signIn({ signal: cancel.signal }), { name: 'AbortError' });
  await assert.rejects(fetch(state.callback));
});
test('invalid refresh grant requires reauthentication', async t => {
  const { auth, state } = fixture(t);
  await auth.signIn();
  state.time += 61000;
  state.invalidGrant = true;
  await assert.rejects(auth.getAccessToken(), { code: 'invalid_grant' });
  assert.equal(auth.getStatus().status, 'reauth_required');
});
test('logout wins against an outstanding token rotation', async t => {
  const { auth, state } = fixture(t);
  await auth.signIn();
  state.time += 61000;
  let release;
  state.refreshGate = new Promise(resolve => { release = resolve; });
  const rejected = assert.rejects(auth.getAccessToken(), /状态已更改/);
  await auth.signOut();
  release();
  await rejected;
  assert.equal(auth.getStatus().status, 'disconnected');
});

test('uses the fixed subscription endpoint for catalog and Responses without API fallback', async t => {
  const connection = { id: 'a', model: 'example', authType: 'siwc', apiKey: 'fixture', baseUrl: 'https://wrong.test' };
  const replies = [Response.json({ models: [{ slug: 'example', display_name: 'Example', visibility: 'list' }, { slug: 'private', visibility: 'hidden' }] }),
    new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'),
    Response.json({ error: { message: 'secret' } }, { status: 401 }),
    Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 })];
  const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, SIWC_RESOURCE_URL + (init.method ? '/responses' : '/models'));
    assert.equal(init.headers.authorization, 'Bearer fixture');
    assert.equal(init.redirect, 'error');
    if (init.method) assert.deepEqual(JSON.parse(init.body), { model: 'example', input: [{ role: 'developer', content: 'Guide' }, { role: 'user', content: 'Hi' }], store: false, stream: true });
    return replies.shift();
  });
  assert.deepEqual(await discoverModels(connection), [{ id: 'example', displayName: 'Example' }]);
  assert.match(variantsFor(connection).label, /ChatGPT 订阅/);
  const run = () => generate({ connection, cacheKey: 'unused', request: { systemInstruction: { parts: [{ text: 'Guide' }] }, contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 40 } }, onChunk() {} });
  await run();
  await assert.rejects(run(), /重新登录/);
  await assert.rejects(run(), /额度已达上限/);
  assert.equal(mock.mock.callCount(), 4);
});
