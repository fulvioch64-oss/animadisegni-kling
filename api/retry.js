const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const localEnvFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', name))
  .filter((envPath) => fs.existsSync(envPath));
if (localEnvFiles.length) require('dotenv').config({ path: localEnvFiles });

const { generateVideoFromImage } = require('./_lib/fal-video.js');
const { renderAndSaveVideo } = require('./_lib/kling.js');
const { saveVideo } = require('./_lib/store.js');
const { isValidOrderId, getOrder, markRetryUsed, lockRetry, unlockRetry } = require('./_lib/orders.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Metodo non consentito.' });
  }
  const orderId = req.body && typeof req.body === 'object' ? req.body.order_id : undefined;
  if (!isValidOrderId(orderId)) return sendJson(res, 400, { error: 'order_id mancante o non valido.' });

  let locked = false;
  try {
    const order = await getOrder(orderId);
    if (!order) return sendJson(res, 404, { error: 'Ordine non trovato.' });
    if (order.status !== 'paid') return sendJson(res, 403, { error: 'Ordine non pagato.' });
    if (!order.retry_available) return sendJson(res, 403, { error: 'Retry già utilizzato per questo acquisto' });
    if (!order.video_url) return sendJson(res, 409, { error: 'La generazione originale non è ancora completata: riprova più tardi.' });

    locked = await lockRetry(orderId);
    if (!locked) return sendJson(res, 409, { error: 'Un retry per questo ordine è già in corso.' });
    // Re-read after acquiring the lock: a concurrent retry may have just consumed it.
    const fresh = await getOrder(orderId);
    if (!fresh?.retry_available) return sendJson(res, 403, { error: 'Retry già utilizzato per questo acquisto' });

    const params = fresh.original_prompt_params;
    console.info(`[retry:${orderId}] Replaying the original Fal.ai request.`);
    const retryToken = crypto.randomUUID();
    await saveVideo(retryToken, {
      motionPreset: params.motionPreset,
      aspectRatio: params.aspectRatio,
      card: params.card,
      audioFile: params.audio,
      orderId,
      generationStatus: 'SUBMITTING',
      paid: true
    });
    // Exactly the same inputs as the original generation.
    const falVideoUrl = await generateVideoFromImage(params.image, params.motionPreset, {
      aspectRatio: params.aspectRatio,
      renderStyle: params.style ?? undefined
    });
    await saveVideo(retryToken, { sourceVideoUrl: falVideoUrl, generationStatus: 'RENDERING' });
    const videoUrl = await renderAndSaveVideo(retryToken, falVideoUrl);

    // The retry is consumed only once the new video is fully produced.
    await markRetryUsed(orderId, videoUrl);
    return sendJson(res, 200, { success: true, order_id: orderId, generation_token: retryToken, video_url: videoUrl, retry_available: false });
  } catch (error) {
    // Technical failures (Fal.ai timeout/5xx, FFmpeg...) never consume the retry.
    console.error(`[retry:${orderId}] Failed (retry_available unchanged):`, error?.message, error?.cause ?? '');
    return sendJson(res, 500, { error: error instanceof Error ? error.message : 'Errore tecnico durante il retry.', retry_available: true });
  } finally {
    if (locked) await unlockRetry(orderId).catch((error) => console.error('[retry] Unable to release lock:', error.message));
  }
};
