const { variantIdFor } = require('./_lib/packages.js');
const { requirePackage } = require('./_lib/wallet.js');
const { resolveWallet } = require('./_lib/auth.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const { walletId, user } = await resolveWallet(req, req.body?.walletId);
    const pkg = requirePackage(req.body?.packageId);
    const appUrl = process.env.PUBLIC_BASE_URL || (process.env.NODE_ENV !== 'production' ? `http://${req.headers.host || 'localhost:3000'}` : '');
    const customData = { wallet_id: walletId, user_uuid: walletId, package_id: pkg.id, ...(user ? { user_id: user.userId } : {}) };
    const redirectUrl = appUrl ? `${appUrl.replace(/\/$/, '')}/?purchase=success&package=${encodeURIComponent(pkg.id)}` : '';
    // Preferred: create the checkout from the package Variant ID through the LemonSqueezy API.
    const apiKey = (process.env.LEMONSQUEEZY_API_KEY || '').trim();
    const storeId = (process.env.LEMONSQUEEZY_STORE_ID || '').trim();
    const variantId = variantIdFor(pkg.id);
    if (apiKey && storeId && variantId) {
      const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
        method: 'POST',
        headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          data: {
            type: 'checkouts',
            attributes: {
              checkout_data: { custom: customData },
              ...(redirectUrl ? { product_options: { redirect_url: redirectUrl } } : {})
            },
            relationships: {
              store: { data: { type: 'stores', id: storeId } },
              variant: { data: { type: 'variants', id: variantId } }
            }
          }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const payload = await response.json().catch(() => ({}));
      const url = payload?.data?.attributes?.url;
      if (!response.ok || !url) {
        console.error('LemonSqueezy checkout creation failed:', response.status, JSON.stringify(payload).slice(0, 500));
        return sendJson(res, 502, { error: 'Unable to create the LemonSqueezy checkout right now.', code: 'CHECKOUT_UNAVAILABLE' });
      }
      return sendJson(res, 200, { url });
    }
    // No fallback to static checkout links: a missing setting must never open a different product.
    const missing = [
      !apiKey && 'LEMONSQUEEZY_API_KEY',
      !storeId && 'LEMONSQUEEZY_STORE_ID',
      !variantId && `LEMONSQUEEZY_VARIANT_ID_${pkg.id.toUpperCase()}`
    ].filter(Boolean);
    console.error(`LemonSqueezy checkout not configured. Missing: ${missing.join(', ')}`);
    return sendJson(res, 503, {
      error: `Checkout not configured. Missing: ${missing.join(', ')}.`,
      code: 'CHECKOUT_UNAVAILABLE'
    });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    if (status >= 500) console.error('Unable to prepare the LemonSqueezy checkout:', error);
    return sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
