const { publicPackages } = require('./_lib/packages.js');
const { walletGet, redeemPromoCode } = require('./_lib/store.js');
const { resolveWallet, currentUser, assertSameOrigin } = require('./_lib/auth.js');
const { apiError } = require('./_lib/wallet.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    // POST: redeem a promo code (signed-in users only; the wallet is always the one owned by the account).
    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      assertSameOrigin(req);
      const user = await currentUser(req);
      if (!user) throw apiError('Sign in with Google to redeem a code.', 401, 'PROMO_LOGIN_REQUIRED');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await redeemPromoCode(user.userId, user.walletId, body.code);
      return sendJson(res, 200, result);
    }
    const { walletId } = await resolveWallet(req, req.query?.walletId);
    const balance = await walletGet(walletId);
    return sendJson(res, 200, { ...balance, packages: publicPackages() });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    if (status >= 500) console.error('Unable to read credit balance:', error);
    return sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
