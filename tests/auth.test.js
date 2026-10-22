process.env.POSTGRES_URL = '';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.AUTH_SESSION_SECRET = 'x'.repeat(48);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const store = require('../api/_lib/store.js');
const auth = require('../api/_lib/auth.js');
const handler = require('../api/auth.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
global.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

function idToken(overrides = {}, key = privateKey) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub: 'sub-1',
    email: 'a@example.com', email_verified: true, picture: 'https://lh3.googleusercontent.com/a/x', exp: Math.floor(Date.now() / 1000) + 600, ...overrides
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function call(method, body, cookie, origin) {
  const res = { headers: {}, statusCode: 0 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
  res.end = (text) => { res.body = JSON.parse(text); return res; };
  const headers = { host: 'localhost:3000', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) };
  await handler({ method, body, headers, query: {} }, res);
  return res;
}

const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];

test('Google token verification rejects bad audience, issuer, expiry, signature, unverified email', async () => {
  assert.equal((await auth.verifyGoogleIdToken(idToken())).sub, 'sub-1');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const bad of [idToken({ aud: 'other' }), idToken({ iss: 'https://evil.com' }), idToken({ exp: 1 }), idToken({ email_verified: false }), idToken({}, other), 'a.b.c']) {
    await assert.rejects(auth.verifyGoogleIdToken(bad), { code: 'INVALID_GOOGLE_TOKEN' });
  }
});

test('login merges the anonymous wallet once, is idempotent and creates no duplicate account', async () => {
  const anon = crypto.randomUUID();
  await store.walletAdjust(anon, 'order:t1', 4, 2);

  const login = await call('POST', { action: 'google', credential: idToken(), walletId: anon });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.body.credits, { mainCredits: 4, retryCredits: 2 });
  assert.equal(login.body.claimed, true);
  const cookie = cookieOf(login);
  assert.match(login.headers['set-cookie'], /HttpOnly/);

  const again = await call('POST', { action: 'google', credential: idToken(), walletId: anon });
  assert.deepEqual(again.body.credits, { mainCredits: 4, retryCredits: 2 });
  assert.equal(again.body.claimed, false);

  assert.deepEqual(await store.walletGet(anon), { mainCredits: 0, retryCredits: 0 });
  const me = await call('GET', undefined, cookie);
  assert.equal(me.body.user.email, 'a@example.com');
  assert.equal(me.body.user.picture, 'https://lh3.googleusercontent.com/a/x');
  assert.deepEqual(me.body.credits, { mainCredits: 4, retryCredits: 2 });

  // A payment started before the login still credits the account.
  const user = await auth.currentUser({ headers: { cookie } });
  assert.equal(await store.resolveCreditWallet(anon), user.walletId);
});

test('a second account cannot claim an already claimed wallet', async () => {
  const anon = crypto.randomUUID();
  await store.walletAdjust(anon, 'order:t2', 1, 1);
  await call('POST', { action: 'google', credential: idToken({ sub: 'sub-2', email: 'b@example.com' }), walletId: anon });
  const second = await call('POST', { action: 'google', credential: idToken({ sub: 'sub-3', email: 'c@example.com' }), walletId: anon });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.claimError, 'WALLET_ALREADY_CLAIMED');
  assert.deepEqual(second.body.credits, { mainCredits: 0, retryCredits: 0 });
});

test('authenticated requests ignore the client walletId; tampered or missing cookies are anonymous', async () => {
  const login = await call('POST', { action: 'google', credential: idToken({ sub: 'sub-4' }) });
  const cookie = cookieOf(login);
  const victim = crypto.randomUUID();
  const resolved = await auth.resolveWallet({ headers: { cookie } }, victim);
  assert.notEqual(resolved.walletId, victim);
  assert.equal((await auth.resolveWallet({ headers: { cookie: `${cookie}x` } }, victim)).walletId, victim);
  assert.equal((await auth.resolveWallet({ headers: {} }, victim)).walletId, victim);
  await assert.rejects(auth.resolveWallet({ headers: {} }, 'not-a-uuid'), { code: 'INVALID_WALLET' });
});

test('cross-origin POST is rejected and logout clears the cookie', async () => {
  assert.equal((await call('POST', { action: 'logout' }, null, 'https://evil.com')).statusCode, 403);
  const out = await call('POST', { action: 'logout' });
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
});

test('concurrent claims of the same wallet credit the account exactly once', async () => {
  const anon = crypto.randomUUID();
  await store.walletAdjust(anon, 'order:t5', 3, 0);
  const user = await store.upsertGoogleUser({ sub: 'sub-5', email: 'e@example.com', name: '' });
  await Promise.all([store.claimAnonymousWallet(user.userId, anon), store.claimAnonymousWallet(user.userId, anon)]);
  assert.deepEqual(await store.walletGet(user.walletId), { mainCredits: 3, retryCredits: 0 });
});
const checkout = require('../api/checkout.js');
test('checkout rejects anonymous users with 401 and creates no payment session', async () => {
  let fetched = false;
  const realFetch = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('must not be called'); };
  const res = { headers: {}, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, end(t) { this.body = JSON.parse(t); return this; } };
  await checkout({ method: 'POST', body: { walletId: crypto.randomUUID(), packageId: 'starter' }, headers: { host: 'localhost:3000' } }, res);
  global.fetch = realFetch;
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
  assert.equal(fetched, false);
});
