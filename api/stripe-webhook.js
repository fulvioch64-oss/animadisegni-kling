const crypto = require('node:crypto');
const { CURRENCY, getPackage } = require('./_lib/packages.js');
const { parseWalletId, grantPackage } = require('./_lib/wallet.js');
const { resolveCreditWallet } = require('./_lib/store.js');
const { recordPaidOrder } = require('./_lib/orders.js');

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const TOLERANCE_SECONDS = 5 * 60;
const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) {
      const error = new Error('Webhook payload too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Stripe-Signature: t=<unix>,v1=<hmac-sha256 hex of "<t>.<raw body>">[,v1=...]
function validSignature(rawBody, header, secret) {
  if (typeof header !== 'string') return false;
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!/^\d+$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some((signature) => /^[\da-f]{64}$/i.test(signature) && crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[stripe-webhook] Missing secret env: set STRIPE_WEBHOOK_SECRET.');
    return sendJson(res, 503, { error: 'Set STRIPE_WEBHOOK_SECRET.' });
  }

  let stage = 'read-body';
  try {
    const rawBody = await readRawBody(req);
    stage = 'verify-signature';
    if (!validSignature(rawBody, req.headers['stripe-signature'], secret)) {
      console.error('[stripe-webhook] Invalid or expired Stripe-Signature.');
      return sendJson(res, 401, { error: 'Invalid webhook signature.' });
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Invalid webhook JSON payload.' });
    }
    if (!PAID_EVENTS.has(event?.type)) return sendJson(res, 200, { received: true });

    const session = event?.data?.object;
    const pkg = getPackage(session?.metadata?.package_id);
    if (!pkg || !session?.id) return sendJson(res, 400, { error: 'The session has no valid package or ID.' });
    // Async payment methods fire "completed" before the money arrives: credit only once paid.
    if (session.payment_status !== 'paid') return sendJson(res, 200, { received: true, pending: true });
    if (String(session.currency || '').toUpperCase() !== CURRENCY || Number(session.amount_total) !== pkg.priceCents) {
      console.error(`[stripe-webhook] Session ${session.id} rejected: currency/amount mismatch for package ${pkg.id}.`);
      return sendJson(res, 400, { error: 'The payment does not match the package currency or price.' });
    }
    let walletId;
    try {
      walletId = await resolveCreditWallet(parseWalletId(session.metadata?.wallet_id));
    } catch {
      return sendJson(res, 400, { error: 'The session has no valid wallet ID.' });
    }

    stage = 'grant-credits';
    // Idempotent per session: a retried delivery never grants the package twice.
    const result = await grantPackage(walletId, pkg.id, `stripe:${session.id}`);
    await recordPaidOrder({ orderId: `stripe:${session.id}`, walletId, packageId: pkg.id, amountCents: pkg.priceCents, currency: CURRENCY });
    console.info(`[stripe-webhook] Session ${session.id}: package ${pkg.id} ${result.applied ? 'granted' : 'already applied'}.`);
    return sendJson(res, 200, { received: true });
  } catch (error) {
    if (error.statusCode === 413) return sendJson(res, 413, { error: error.message });
    console.error(`[stripe-webhook] Failed at stage "${stage}": ${error.code || ''} ${error.message}`);
    return sendJson(res, 503, { error: 'Unable to process the webhook right now.' });
  }
};
