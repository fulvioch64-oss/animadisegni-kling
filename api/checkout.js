const { stripePriceIdFor } = require('./_lib/packages.js');
const { parseWalletId, requirePackage } = require('./_lib/wallet.js');
const { currentUser } = require('./_lib/auth.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  try {
    const user = await currentUser(req);
    if (!user) {
      return sendJson(res, 401, { error: 'Sign in with Google to buy credits.', code: 'AUTH_REQUIRED' });
    }
    // The Stripe price is chosen by the server from the package ID: the client can never pick its own price.
    const pkg = requirePackage(req.body?.packageId);
    const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    const priceId = stripePriceIdFor(pkg.id);
    if (!secretKey || !priceId) {
      const missing = [!secretKey && 'STRIPE_SECRET_KEY', !priceId && `NEXT_PUBLIC_STRIPE_PRICE_${pkg.id.toUpperCase()}`].filter(Boolean);
      console.error(`Stripe checkout not configured. Missing: ${missing.join(', ')}`);
      return sendJson(res, 503, { error: `Checkout not configured. Missing: ${missing.join(', ')}.`, code: 'CHECKOUT_UNAVAILABLE' });
    }

    const appUrl = (process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || (process.env.NODE_ENV !== 'production' ? `http://${req.headers.host || 'localhost:3000'}` : '')).replace(/\/$/, '');
    if (!appUrl) {
      console.error('Stripe checkout not configured. Missing: PUBLIC_BASE_URL');
      return sendJson(res, 503, { error: 'Checkout not configured. Missing: PUBLIC_BASE_URL.', code: 'CHECKOUT_UNAVAILABLE' });
    }

    const walletId = parseWalletId(user.walletId);
    const metadata = { wallet_id: walletId, user_id: user.userId, package_id: pkg.id };
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appUrl}/?purchase=success&package=${encodeURIComponent(pkg.id)}`,
      cancel_url: `${appUrl}/`,
      client_reference_id: walletId
    });
    for (const [key, value] of Object.entries(metadata)) {
      form.set(`metadata[${key}]`, value);
      form.set(`payment_intent_data[metadata][${key}]`, value);
    }
    if (user.email) form.set('customer_email', user.email);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000)
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.url) {
      console.error('Stripe checkout creation failed:', response.status, session?.error?.type, session?.error?.code, session?.error?.message);
      return sendJson(res, 502, { error: 'Unable to create the checkout right now.', code: 'CHECKOUT_UNAVAILABLE' });
    }
    return sendJson(res, 200, { url: session.url });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 503;
    if (status >= 500) console.error('Unable to prepare the Stripe checkout:', error);
    return sendJson(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
