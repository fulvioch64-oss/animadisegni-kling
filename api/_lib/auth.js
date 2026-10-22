const crypto = require('node:crypto');
const { apiError, parseWalletId } = require('./wallet.js');
const { getUserById } = require('./store.js');

const COOKIE_NAME = 'am_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let certsCache = { keys: [], expiresAt: 0 };

const googleClientId = () => (process.env.GOOGLE_CLIENT_ID || '').trim();
const sessionSecret = () => (process.env.AUTH_SESSION_SECRET || '').trim();
const authConfigured = () => Boolean(googleClientId() && sessionSecret().length >= 32);

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

async function googleKeys(force = false) {
  if (!force && certsCache.keys.length && certsCache.expiresAt > Date.now()) return certsCache.keys;
  const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw apiError('Unable to verify the Google sign-in right now.', 503, 'AUTH_UNAVAILABLE');
  const body = await response.json();
  certsCache = { keys: body.keys || [], expiresAt: Date.now() + 60 * 60 * 1000 };
  return certsCache.keys;
}

// Verifies a Google ID token (RS256) against Google's public keys and our client ID.
async function verifyGoogleIdToken(idToken) {
  const invalid = () => apiError('Invalid Google sign-in.', 401, 'INVALID_GOOGLE_TOKEN');
  if (typeof idToken !== 'string' || idToken.length > 4096) throw invalid();
  const parts = idToken.split('.');
  if (parts.length !== 3) throw invalid();
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (header.alg !== 'RS256' || !header.kid) throw invalid();

  let jwk = (await googleKeys()).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((key) => key.kid === header.kid);
  if (!jwk) throw invalid();

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url')
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    !valid
    || claims.aud !== googleClientId()
    || !GOOGLE_ISSUERS.has(claims.iss)
    || !(Number(claims.exp) > now)
    || !claims.sub
    || !(claims.email_verified === true || claims.email_verified === 'true')
  ) throw invalid();

  return { sub: String(claims.sub), email: String(claims.email || '').slice(0, 320), name: String(claims.name || '').slice(0, 200), picture: String(claims.picture || '').slice(0, 500) };
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readSession(token) {
  if (!authConfigured() || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.uid && payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function cookieValue(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function sessionCookie(userId, picture = '') {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const pic = picture.startsWith('https://') ? picture : undefined;
  const value = sign({ uid: userId, pic, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

function clearedCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

// Returns the signed-in user (with their server-owned wallet) or null for anonymous visitors.
async function currentUser(req) {
  const session = readSession(cookieValue(req, COOKIE_NAME));
  const user = session ? await getUserById(session.uid) : null;
  return user ? { ...user, picture: session.pic || '' } : null;
}

// Authenticated users always use their own wallet; the client-sent ID is only trusted for anonymous use.
async function resolveWallet(req, clientWalletId) {
  const user = await currentUser(req);
  if (user) return { walletId: user.walletId, user };
  return { walletId: parseWalletId(clientWalletId), user: null };
}

// Blocks cross-site state-changing requests.
function assertSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin || !req.headers.host) return;
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { /* rejected below */ }
  if (originHost !== req.headers.host) throw apiError('Cross-origin request rejected.', 403, 'BAD_ORIGIN');
}

module.exports = {
  authConfigured,
  googleClientId,
  verifyGoogleIdToken,
  sessionCookie,
  clearedCookie,
  currentUser,
  resolveWallet,
  assertSameOrigin
};
