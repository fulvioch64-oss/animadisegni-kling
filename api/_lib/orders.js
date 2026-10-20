const { getRecord, setRecord, acquireLock, releaseLock } = require('./store.js');

const ORDER_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RETRY_LOCK_TTL_SECONDS = 15 * 60;

const orderKey = (orderId) => `animadisegni:order:${orderId}`;

function isValidOrderId(value) {
  return typeof value === 'string' && ORDER_ID_PATTERN.test(value);
}

/*
 * Order record:
 * {
 *   order_id, status: 'paid', retry_available: true,
 *   original_prompt_params: { prompt, style, image, background, audio, motionPreset, aspectRatio, card },
 *   video_url, created_at, updated_at
 * }
 * `image` is the final image URL sent to Fal.ai (already cropped and composed with the background),
 * so a retry reproduces the original request exactly.
 */
async function createOrder({ orderId, params, videoUrl = null }) {
  if (!isValidOrderId(orderId)) throw new Error('order_id non valido.');
  const now = Date.now();
  const order = {
    order_id: orderId,
    status: 'paid',
    retry_available: true,
    original_prompt_params: params,
    video_url: videoUrl,
    created_at: now,
    updated_at: now
  };
  await setRecord(orderKey(orderId), order);
  return order;
}

async function getOrder(orderId) {
  if (!isValidOrderId(orderId)) return null;
  return getRecord(orderKey(orderId));
}

async function updateOrder(orderId, updates) {
  const order = await getOrder(orderId);
  if (!order) return null;
  const updated = { ...order, ...updates, order_id: order.order_id, updated_at: Date.now() };
  await setRecord(orderKey(orderId), updated);
  return updated;
}

function setOrderVideoUrl(orderId, videoUrl) {
  return updateOrder(orderId, { video_url: videoUrl });
}

function markRetryUsed(orderId, videoUrl) {
  return updateOrder(orderId, { retry_available: false, ...(videoUrl ? { video_url: videoUrl } : {}) });
}

// Prevents two simultaneous retries of the same order (double click, two tabs) from both reaching Fal.ai.
function lockRetry(orderId) {
  return acquireLock(`animadisegni:order-retry-lock:${orderId}`, RETRY_LOCK_TTL_SECONDS);
}

function unlockRetry(orderId) {
  return releaseLock(`animadisegni:order-retry-lock:${orderId}`);
}

// ---- Payment orders (credit packages bought on LemonSqueezy) ----
// Kept apart from video orders above: their ids are provider ids (numeric), not UUIDs.
const paymentOrderKey = (orderId) => `animadisegni:payment-order:${orderId}`;

// Idempotent: a webhook retry never overwrites the original record.
async function recordPaidOrder({ orderId, walletId, packageId, amountCents, currency }) {
  const key = paymentOrderKey(orderId);
  const existing = await getRecord(key);
  if (existing) return existing;
  const now = Date.now();
  const order = {
    order_id: String(orderId),
    status: 'paid',
    wallet_id: walletId,
    package_id: packageId,
    amount_cents: amountCents,
    currency,
    created_at: now,
    updated_at: now
  };
  await setRecord(key, order);
  return order;
}

async function markPaymentOrderRefunded(orderId) {
  const order = await getRecord(paymentOrderKey(orderId));
  if (!order) return null;
  const updated = { ...order, status: 'refunded', updated_at: Date.now() };
  await setRecord(paymentOrderKey(orderId), updated);
  return updated;
}

function getPaymentOrder(orderId) {
  return getRecord(paymentOrderKey(orderId));
}

module.exports = { isValidOrderId, createOrder, getOrder, updateOrder, setOrderVideoUrl, markRetryUsed, lockRetry, unlockRetry, recordPaidOrder, markPaymentOrderRefunded, getPaymentOrder };
