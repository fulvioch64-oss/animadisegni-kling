const crypto = require('node:crypto');
const { CURRENCY, getPackage, variantIdFor } = require('./_lib/packages.js');
const { parseWalletId, grantPackage, revokePackage } = require('./_lib/wallet.js');
const { recordPaidOrder, markPaymentOrderRefunded } = require('./_lib/orders.js');

const MAX_WEBHOOK_BYTES = 1024 * 1024;

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

function validSignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !/^[\da-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  const secret = (process.env.LEMON_WEBHOOK_SECRET || process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[webhook] Missing secret env: set LEMON_WEBHOOK_SECRET (or LEMONSQUEEZY_WEBHOOK_SECRET).');
    return sendJson(res, 503, { error: 'Set LEMON_WEBHOOK_SECRET.' });
  }

  let stage = 'read-body';
  try {
    const rawBody = await readRawBody(req);
    stage = 'verify-signature';
    if (!validSignature(rawBody, req.headers['x-signature'], secret)) {
      console.error(`[webhook] Secret mismatch or malformed x-signature (header present: ${typeof req.headers['x-signature'] === 'string'}, body bytes: ${rawBody.length}).`);
      return sendJson(res, 401, { error: 'Invalid webhook signature.' });
    }
    stage = 'parse-event';
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Invalid webhook JSON payload.' });
    }

    const eventName = event?.meta?.event_name;
    if (!['order_created', 'order_refunded'].includes(eventName)) return sendJson(res, 200, { received: true });

    const pkg = getPackage(event?.meta?.custom_data?.package_id);
    const orderId = event?.data?.id;
    if (!pkg || !orderId) return sendJson(res, 400, { error: 'The order has no valid package or order ID.' });
    const customData = event?.meta?.custom_data;
    let walletId;
    try {
      // `user_uuid` is accepted as an alias of `wallet_id` (the anonymous wallet token created by the browser).
      walletId = parseWalletId(customData?.wallet_id ?? customData?.user_uuid);
    } catch {
      return sendJson(res, 400, { error: 'The order has no valid wallet ID.' });
    }

    stage = `process-${eventName}`;
    if (eventName === 'order_created') {
      const attributes = event?.data?.attributes;
      const expectedVariant = variantIdFor(pkg.id);
      if (
        !expectedVariant
        || String(attributes?.first_order_item?.variant_id) !== expectedVariant
        || attributes?.status !== 'paid'
        || String(attributes?.currency || '').toUpperCase() !== CURRENCY
        || Number(attributes?.total) !== pkg.priceCents
      ) {
        console.error(`[webhook] Order ${orderId} rejected: variant/status/currency/price mismatch for package ${pkg.id} (expected variant configured: ${Boolean(expectedVariant)}).`);
      return sendJson(res, 400, { error: 'Order not paid, or it does not match the package variant, currency or price.' });
      }
      const result = await grantPackage(walletId, pkg.id, orderId);
      await recordPaidOrder({ orderId, walletId, packageId: pkg.id, amountCents: pkg.priceCents, currency: CURRENCY });
      console.info(`[webhook] Order ${orderId}: package ${pkg.id} ${result.applied ? 'granted' : 'already applied'}.`);
    } else {
      const result = await revokePackage(walletId, pkg.id, orderId);
      await markPaymentOrderRefunded(orderId);
      console.info(`[webhook] Order ${orderId}: refund ${result.applied ? 'applied' : 'already applied'}.`);
    }
    return sendJson(res, 200, { received: true });
  } catch (error) {
    if (error.statusCode === 413) return sendJson(res, 413, { error: error.message });
    const redisRelated = /redis|upstash|wrongpass/i.test(`${error?.message} ${error?.code}`);
    console.error(`[webhook] Failure at stage "${stage}"${redisRelated ? ' (Redis error)' : ''}:`, error?.message || error);
    return sendJson(res, 503, { error: 'Unable to process the webhook right now.' });
  }
};

module.exports.config = { api: { bodyParser: false } };
