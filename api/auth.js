const { walletGet, upsertGoogleUser, claimAnonymousWallet } = require('./_lib/store.js');
const { parseWalletId, apiError } = require('./_lib/wallet.js');
const auth = require('./_lib/auth.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

const publicUser = (user) => (user ? { email: user.email, name: user.name, picture: user.picture || '' } : null);

// GET: auth configuration and current user. POST {action: 'google' | 'claim' | 'logout'}.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const user = auth.authConfigured() ? await auth.currentUser(req) : null;
      return sendJson(res, 200, {
        googleClientId: auth.authConfigured() ? auth.googleClientId() : null,
        user: publicUser(user),
        ...(user ? { credits: await walletGet(user.walletId) } : {})
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    auth.assertSameOrigin(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', auth.clearedCookie());
      return sendJson(res, 200, { user: null });
    }
    if (!auth.authConfigured()) {
      return sendJson(res, 503, { error: 'Google sign-in is not configured.', code: 'AUTH_NOT_CONFIGURED' });
    }

    let user;
    if (body.action === 'google') {
      const profile = await auth.verifyGoogleIdToken(body.credential);
      user = await upsertGoogleUser(profile);
      user.picture = profile.picture;
      res.setHeader('Set-Cookie', auth.sessionCookie(user.userId, profile.picture));
    } else if (body.action === 'claim') {
      user = await auth.currentUser(req);
      if (!user) throw apiError('Sign in required.', 401, 'AUTH_REQUIRED');
    } else {
      return sendJson(res, 400, { error: 'Unknown action.' });
    }

    // Anonymous credits are merged once; a wallet already linked elsewhere is reported but never blocks the login.
    let claim = { claimed: false };
    let claimError;
    if (body.walletId) {
      try {
        claim = await claimAnonymousWallet(user.userId, parseWalletId(body.walletId));
      } catch (error) {
        // The session is already established: a failed merge must never turn the login into an error.
        console.error('[auth] Wallet claim failed:', error.code || error.message);
        claimError = Number.isInteger(error.statusCode) && error.statusCode < 500 ? error.code : 'CLAIM_FAILED';
      }
    }
    return sendJson(res, 200, {
      user: publicUser(user),
      credits: await walletGet(user.walletId).catch(() => undefined),
      claimed: Boolean(claim.claimed),
      ...(claimError ? { claimError } : {})
    });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    if (status >= 500) console.error('[auth] Request failed:', error.message);
    return sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
