const crypto = require('node:crypto');
const { getVideo, saveVideo } = require('./_lib/store.js');

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
      const error = new Error('Payload webhook troppo grande.');
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
    return sendJson(res, 405, { error: 'Metodo non consentito.' });
  }
  const secret = process.env.LEMON_WEBHOOK_SECRET;
  const variantId = process.env.LEMONSQUEEZY_VARIANT_ID;
  if (!secret || !variantId) return sendJson(res, 503, { error: 'Configura LEMON_WEBHOOK_SECRET e LEMONSQUEEZY_VARIANT_ID.' });

  try {
    const rawBody = await readRawBody(req);
    if (!validSignature(rawBody, req.headers['x-signature'], secret)) return sendJson(res, 401, { error: 'Firma webhook non valida.' });
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Payload webhook JSON non valido.' });
    }

    const eventName = event?.meta?.event_name;
    const token = event?.meta?.custom_data?.generation_id;
    if (!['order_created', 'order_refunded'].includes(eventName)) return sendJson(res, 200, { received: true });
    if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) return sendJson(res, 400, { error: 'Il checkout non contiene un identificativo video valido.' });
    if (eventName === 'order_created') {
      const attributes = event?.data?.attributes;
      const purchasedVariantId = attributes?.first_order_item?.variant_id;
      if (
        String(purchasedVariantId) !== String(variantId)
        || attributes?.status !== 'paid'
        || String(attributes?.currency || '').toUpperCase() !== 'EUR'
        || Number(attributes?.total) !== 279
      ) {
        return sendJson(res, 400, { error: 'Ordine non pagato o variante LemonSqueezy non corrispondente.' });
      }
    }

    const video = await getVideo(token);
    if (!video?.videoUrl) return sendJson(res, 404, { error: 'Video associato all’ordine non trovato o scaduto.' });
    await saveVideo(token, { paid: eventName === 'order_created' });
    return sendJson(res, 200, { received: true });
  } catch (error) {
    if (error.statusCode === 413) return sendJson(res, 413, { error: error.message });
    console.error('Errore durante la verifica del webhook LemonSqueezy:', error);
    return sendJson(res, 503, { error: 'Impossibile elaborare il webhook in questo momento.' });
  }
};

module.exports.config = { api: { bodyParser: false } };
