'use strict';
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { writeFileAtomic } = require('./atomic-file.cjs');
const SIWC_ISSUER = 'https://auth.openai.com';
const SIWC_RESOURCE_URL = 'https://api.openai.com/v1';
const sharing = 'chatgpt.tokens.use.direct';
const grantErrors = new Set('invalid_grant invalid_refresh_token token_expired refresh_token_expired refresh_token_invalidated refresh_token_reused'.split(' '));
const messages = {
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 订阅共享额度已达上限，不会自动切换为 API 计费。',
  subscription_sharing_user_not_eligible: '当前 ChatGPT 账号或工作区不支持订阅额度共享。',
  subscription_sharing_unsupported_capability: '当前请求包含订阅共享不支持的能力。',
  subscription_sharing_route_not_supported: '当前接口不支持订阅共享。',
  subscription_sharing_invalid_user: '无法验证 ChatGPT 订阅，请检查账号与授权。',
  subscription_sharing_usage_unavailable: 'ChatGPT 订阅服务暂不可用，请稍后重试。',
  subscription_sharing_user_unavailable: 'ChatGPT 账号暂不可用，请稍后重试。',
  chatpass_v2_scope_not_authorized: '请重新授权并允许订阅共享。',
  chatpass_v2_invalid_authorization_context: '请重新授权并允许订阅共享。',
  access_denied: '未完成 ChatGPT 授权。',
  model_not_found: '此模型不可用，请重新获取订阅模型。',
};
const fail = (code, message) => Object.assign(new Error(message), { code });
function formatSiwcError(body, status) {
  let value = body;
  for (let i = 0; i < 4; i++) {
    const next = value?.error ?? value?.detail;
    if (!next) break;
    value = next;
  }
  const raw = typeof value === 'string' ? value : value?.code;
  const code = typeof raw === 'string' ? raw.replace(/^subscription_sharing_v2_/, 'subscription_sharing_') : '';
  if (grantErrors.has(code)) return fail(code, 'ChatGPT 登录已失效，请重新登录。');
  if (Object.hasOwn(messages, code)) return fail(code, `${messages[code]} (${code})`);
  const fallback = { 401: 'ChatGPT 未接受授权，请重新登录。', 403: 'ChatGPT 拒绝了请求，请检查授权及账号资格。', 429: 'ChatGPT 请求过多，请稍后重试。', 400: 'ChatGPT 拒绝了请求格式。', 422: 'ChatGPT 不支持此请求格式。' };
  const identifiers = [value?.code, value?.param, Array.isArray(value?.[0]?.loc) ? value[0].loc.join('.') : undefined]
    .filter(item => typeof item === 'string' && /^[a-zA-Z0-9_.:[\]-]{1,100}$/.test(item));
  const diagnostics = [Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : '', ...identifiers].filter(Boolean);
  const message = fallback[status] || (status >= 500 ? 'ChatGPT 服务暂不可用。' : 'ChatGPT 请求失败。');
  return fail('siwc_request_failed', diagnostics.length ? `${message} (${diagnostics.join(', ')})` : message);
}
function wait(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function createSiwcAuth({ storageFile, encryption, issuer = SIWC_ISSUER, resourceUrl = SIWC_RESOURCE_URL,
  redirectPort = 0, openBrowser, fetch: remote = (...args) => fetch(...args), now = Date.now, sendHostId = false }) {
  let epoch = 0, login, rotation, metadata, keys;
  const empty = { status: 'disconnected', scopes: [] };
  function storageReady() {
    if (!encryption.isAvailable()) throw new Error('系统密钥存储不可用。');
  }
  function read() {
    storageReady();
    try {
      const value = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      if (value.version !== 1 || typeof value.encrypted !== 'string') throw new Error();
      const data = JSON.parse(encryption.decrypt(Buffer.from(value.encrypted, 'base64')));
      if (!['connected', 'disconnected', 'reauth_required'].includes(data.status) || !Array.isArray(data.scopes)) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { ...empty };
      throw new Error('无法读取已保存的 ChatGPT 登录，原文件未更改。');
    }
  }
  function write(value) {
    storageReady();
    const encrypted = Buffer.from(encryption.encrypt(JSON.stringify(value))).toString('base64');
    writeFileAtomic(storageFile, JSON.stringify({ version: 1, encrypted }));
  }
  function getStatus() {
    const value = read();
    return { status: value.status, sharing: value.status === 'connected' && Boolean(value.credentials) && value.scopes.includes(sharing),
      ...(value.identity ? { account: value.identity } : {}) };
  }
  async function json(url, init = {}, timeout = 15000) {
    const deadline = AbortSignal.timeout(timeout);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await remote(url, { ...init, signal, redirect: 'error' });
    const result = await response.json().catch(() => null);
    signal.throwIfAborted();
    if (!response.ok) throw formatSiwcError(result, response.status);
    return result;
  }
  function discover() {
    metadata ??= json(`${issuer}/.well-known/openid-configuration`).then(data => {
      if (data?.issuer !== issuer) throw new Error('无法验证 ChatGPT 登录配置。');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
        if (key === 'revocation_endpoint' && data[key] === undefined) continue;
        const url = new URL(data[key]);
        if (url.origin !== issuer || url.username || url.password || url.hash) throw new Error('无法验证 ChatGPT 登录配置。');
      }
      return data;
    }).catch(error => { metadata = undefined; throw error; });
    return metadata;
  }
  async function verify(token, clientId, nonce, at = now()) {
    const invalid = () => fail('invalid_id_token', '无法验证 ChatGPT 身份，请重新登录。');
    if (typeof token !== 'string' || token.length > 65536) throw invalid();
    const pieces = token.split('.');
    if (pieces.length !== 3 || pieces.some(p => !/^[\w-]+$/.test(p))) throw invalid();
    let header, claims;
    try {
      [header, claims] = pieces.slice(0, 2).map(p => JSON.parse(Buffer.from(p, 'base64url')));
    } catch { throw invalid(); }
    if (header?.alg !== 'RS256' || (header.kid !== undefined && typeof header.kid !== 'string') || header.crit !== undefined || !claims) throw invalid();
    const find = set => {
      const eligible = set?.keys?.filter(k => k?.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig') && (!k.key_ops || k.key_ops.includes('verify'))) || [];
      return header.kid === undefined ? (eligible.length === 1 ? eligible[0] : undefined) : eligible.find(k => k.kid === header.kid);
    };
    let jwk = find(keys);
    if (!jwk) {
      try {
        const { jwks_uri } = await discover();
        keys = await json(jwks_uri);
      } catch { throw fail('identity_verification_unavailable', '暂时无法获取 ChatGPT 签名密钥，请稍后重试。'); }
      jwk = find(keys);
    }
    if (!jwk) throw invalid();
    let key;
    try {
      key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch { throw invalid(); }
    if (!(key.asymmetricKeyDetails?.modulusLength >= 2048)) throw invalid();
    if (!crypto.verify('RSA-SHA256', Buffer.from(pieces.slice(0, 2).join('.')), key, Buffer.from(pieces[2], 'base64url'))) throw invalid();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !aud.includes(clientId) || aud.some(a => typeof a !== 'string') ||
        ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
        typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) ||
        claims.exp <= at / 1000 - 5 || claims.iat > at / 1000 + 5 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > at / 1000 + 5)) ||
        (nonce !== undefined && claims.nonce !== nonce)) throw invalid();
    return { subject: claims.sub, identity: Object.fromEntries(['name', 'email'].filter(k => typeof claims[k] === 'string').map(k => [k, claims[k]])) };
  }
  function fields(data, priorScopes, refresh = false) {
    const bad = () => fail('invalid_token_response', 'ChatGPT 返回的授权不完整，请重新登录。');
    const scope = data?.scope ?? priorScopes?.join(' ');
    if (typeof scope !== 'string') throw bad();
    const scopes = scope.split(/\s+/).filter(Boolean);
    if (!data.access_token && !refresh && !scopes.includes(sharing) && !scopes.includes('offline_access')) return { scopes };
    if (typeof data.access_token !== 'string' || !data.access_token || !/^bearer$/i.test(data.token_type) ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0 || !Number.isFinite(now() + data.expires_in * 1000) ||
        ((refresh || scopes.includes('offline_access')) && (typeof data.refresh_token !== 'string' || !data.refresh_token))) throw bad();
    return { scopes, credentials: { accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: now() + data.expires_in * 1000, earliestRefreshAt: data.earliest_refresh_at } };
  }
  async function tokens(params, signal) {
    const config = await wait(discover(), signal);
    return json(config.token_endpoint, { method: 'POST', body: new URLSearchParams({ ...params, resource: resourceUrl }), signal }, 30000);
  }
  const random = () => crypto.randomBytes(32).toString('base64url');
  const hash = (value, encoding) => crypto.createHash('sha256').update(value).digest(encoding);
  const mismatch = () => fail('account_mismatch', 'ChatGPT 返回的账号与已保存账号不一致。');
  function current(id, signal) {
    signal?.throwIfAborted();
    if (epoch !== id) throw new Error('ChatGPT 登录状态已更改，请重试。');
  }
  async function signIn(options = {}) {
    if (login || rotation) throw new Error('ChatGPT 正在更新授权，请稍后重试。');
    const saved = read();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000), ...(options.signal ? [options.signal] : [])]);
    const id = ++epoch;
    login = controller;
    let server;
    try {
      const state = random(), nonce = random(), verifier = random();
      const previous = saved.clientId;
      const config = await wait(discover(), signal);
      current(id, signal);
      let resolve, reject, settled = false;
      const callback = new Promise((ok, bad) => { resolve = ok; reject = bad; });
      callback.catch(() => {});
      const script = 'history.replaceState(null,"","/auth/complete")';
      server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash(script, 'base64')}'; frame-ancestors 'none'; base-uri 'none'`);
        const host = `127.0.0.1:${server.address()?.port}`;
        let url;
        try { url = new URL(req.url, `http://${host}`); } catch { return res.writeHead(400).end(); }
        if (settled || req.method !== 'GET' || req.headers.host !== host || url.origin !== `http://${host}` || url.pathname !== '/auth/callback') return res.writeHead(404).end();
        const query = url.searchParams;
        const states = query.getAll('state');
        const received = Buffer.from(states[0] || '');
        if (states.length !== 1 || received.length !== state.length || !crypto.timingSafeEqual(received, Buffer.from(state))) return res.writeHead(400).end('Invalid state');
        settled = true;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>AGY Lab</title><p>请返回 AGY Lab 查看授权结果。</p><script>${script}</script>`);
        if (query.has('error')) return reject(formatSiwcError({ error: query.get('error') }));
        const code = query.get('code'), clientId = query.get('client_id') ?? previous;
        if (!code || query.getAll('code').length !== 1 || query.getAll('client_id').length > 1 ||
            !/^[\w-]{1,200}$/.test(clientId || '') || clientId === 'dynamic_agent_client' || (previous && previous !== clientId)) {
          return reject(new Error('ChatGPT 未完成应用注册，请重试。'));
        }
        resolve({ code, clientId });
      });
      server.listen(redirectPort, '127.0.0.1');
      await once(server, 'listening');
      server.on('error', () => reject(new Error('本机授权回调不可用。')));
      current(id, signal);
      const redirect_uri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(config.authorization_endpoint);
      const hostId = saved.hostId ?? `urn:uuid:${crypto.randomUUID()}`;
      if (sendHostId && !saved.hostId) write({ ...saved, hostId });
      url.search = new URLSearchParams({ client_id: previous || 'dynamic_agent_client', response_type: 'code', redirect_uri,
        scope: `openid profile email offline_access resource.invoke ${sharing}`, resource: resourceUrl, state, nonce,
        code_challenge_method: 'S256', code_challenge: hash(verifier, 'base64url'),
        ...(!previous ? { agent_name_hint: 'AGY Lab' } : {}),
        ...(saved.identity?.email ? { login_hint: saved.identity.email } : {}),
        ...(options.reconsent ? { prompt: 'consent' } : {}), ...(sendHostId ? { ext_agent_host_id: hostId } : {}) });
      await wait(Promise.resolve((options.openBrowser || openBrowser)(url.href)), signal);
      const { code, clientId } = await wait(callback, signal);
      current(id, signal);
      write({ ...saved, clientId, hostId });
      const data = await tokens({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri }, signal);
      const identity = await wait(verify(data?.id_token, clientId, nonce), signal);
      if (saved.subject && saved.subject !== identity.subject) throw mismatch();
      current(id, signal);
      write({ status: 'connected', clientId, hostId, ...identity, ...fields(data) });
      return getStatus();
    } finally {
      server?.close();
      server?.closeAllConnections();
      if (login === controller) login = undefined;
    }
  }
  async function refresh(saved, id) {
    try {
      let pending = saved.pendingRefresh;
      let next;
      if (pending) next = pending.fields;
      else {
        if (!saved.credentials.refreshToken) throw formatSiwcError({ error: 'invalid_grant' });
        const data = await tokens({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.credentials.refreshToken }, AbortSignal.timeout(60000));
        current(id);
        next = fields(data, saved.scopes, true);
        if (data.id_token !== undefined) {
          pending = { fields: next, token: data.id_token, receivedAt: now() };
          write({ ...saved, pendingRefresh: pending });
        }
      }
      let identity;
      if (pending) {
        identity = await verify(pending.token, saved.clientId, undefined, pending.receivedAt);
        if (saved.subject !== identity.subject) throw mismatch();
      }
      current(id);
      const result = { ...saved, ...next, ...identity };
      delete result.pendingRefresh;
      write(result);
      return result;
    } catch (error) {
      current(id);
      if (grantErrors.has(error.code) || ['invalid_id_token', 'invalid_token_response', 'account_mismatch'].includes(error.code)) {
        const { credentials, pendingRefresh, ...rest } = saved;
        write({ ...rest, status: 'reauth_required', scopes: [] });
      }
      throw error;
    }
  }
  async function getAccessToken(signal) {
    if (login) throw new Error('请先完成 ChatGPT 登录。');
    const id = epoch;
    current(id, signal);
    let saved = read();
    if (saved.status !== 'connected') throw new Error('请登录 ChatGPT。');
    if (!saved.scopes.includes(sharing) || !saved.credentials) throw new Error('请重新授权并允许 ChatGPT 订阅共享。');
    const earliest = saved.credentials.earliestRefreshAt;
    const after = typeof earliest === 'number' ? earliest * 1000 : Date.parse(earliest);
    if (saved.pendingRefresh || (saved.credentials.expiresAt <= now() + 60000 && !(after > now()))) {
      if (rotation?.id !== id) {
        const task = { id };
        rotation = task;
        task.promise = refresh(saved, id).finally(() => { if (rotation === task) rotation = undefined; });
      }
      saved = await wait(rotation.promise, signal);
    }
    current(id, signal);
    if (!saved.scopes.includes(sharing)) throw new Error('请重新授权并允许 ChatGPT 订阅共享。');
    if (saved.credentials.expiresAt <= now()) throw new Error('ChatGPT 授权暂无法刷新，请稍后重试。');
    return saved.credentials.accessToken;
  }
  async function signOut() {
    ++epoch;
    login?.abort();
    const saved = read();
    const token = saved.pendingRefresh?.fields.credentials.refreshToken ?? saved.credentials?.refreshToken;
    write({ ...empty, hostId: saved.hostId });
    let remoteRevoked = false;
    if (token) {
      const config = await discover().catch(() => ({}));
      if (config.revocation_endpoint) for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await remote(config.revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: saved.clientId }) });
          await response.body?.cancel();
          if (response.status === 200) remoteRevoked = true;
          if (response.status < 500) break;
        } catch { /* Retry once without exposing the credential. */ }
      }
    }
    const warning = !remoteRevoked && (token || saved.credentials) ? '本机已退出；无法确认远端撤销，请在 ChatGPT 设置中断开连接。' : undefined;
    return { ...getStatus(), remoteRevoked, warning };
  }
  return { signIn, signOut, getStatus, getSubject: () => read().subject, getAccessToken };
}
module.exports = { createSiwcAuth, SIWC_RESOURCE_URL, SIWC_ISSUER, formatSiwcError };
