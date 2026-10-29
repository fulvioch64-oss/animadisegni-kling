const crypto = require('node:crypto');
const { consumeGeneration, getVideo, saveVideo, walletGet, walletConsume, walletRefund, acquireLock, releaseLock } = require('./store.js');
const { apiError, parseWalletId } = require('./wallet.js');
const { renderLoopVideo, addAudioTrack } = require('./video-loop.js');
const { generateVideoFromImage, buildPrompt } = require('./fal-video.js');
const { saveImageAsPublicUrl } = require('./image-upload.js');
const { pickTrack, resolveTrackPath, trackUrl } = require('./music.js');
const { normalizeAspectRatio } = require('./aspect-ratio.js');
const { normalizeCard } = require('./card.js');
const { createOrder, setOrderVideoUrl } = require('./orders.js');

function previewUrl(generationToken) {
  return `/api/preview?id=${encodeURIComponent(generationToken)}`;
}

async function renderAndSaveVideo(generationToken, sourceVideoUrl) {
  console.info(`[generation:${generationToken}] Kling video ready; starting loop render.`);
  const saved = await getVideo(generationToken);
  const generatedVideoPath = await renderLoopVideo(generationToken, sourceVideoUrl, saved?.aspectRatio, saved?.card);
  const videoUrl = previewUrl(generationToken);
  const updates = { sourceVideoUrl, generatedVideoPath, videoUrl, generationStatus: 'COMPLETE' };
  const audioPath = saved?.audioFile ? resolveTrackPath(saved.audioFile) : null;
  if (audioPath) {
    try {
      updates.downloadVideoPath = await addAudioTrack(generationToken, generatedVideoPath, audioPath);
    } catch (error) {
      // The silent video is still delivered if the music merge fails.
      console.error(`[generation:${generationToken}] Unable to add the music track:`, error.message);
    }
  }
  await saveVideo(generationToken, updates);
  await setOrderVideoUrl(generationToken, videoUrl).catch((error) => console.error(`[orders] Unable to save the video URL for order ${generationToken}:`, error.message));
  console.info(`[generation:${generationToken}] Loop render complete; preview URL is ready.`);
  return videoUrl;
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(10 * 1024 * 1024 * 4 / 3) + 64;

function validateImageUrl(value) {
  if (typeof value !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    || value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    throw requestError('imageUrl deve essere un’immagine JPG, PNG o WEBP in formato data URI Base64 (max 10 MB).');
  }
  return value;
}

function validateMotionPreset(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw requestError('motionPreset deve contenere l’ID del movimento selezionato.');
  }
  return value.trim();
}

function isAllowedGatewayProtocol(url) {
  if (url.protocol === 'https:') return true;
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  return process.env.NODE_ENV !== 'production' && localHost && url.protocol === 'http:';
}

function getKlingConfig() {
  const endpoint = process.env.KLING_API_URL;
  const apiKey = process.env.KLING_API_KEY;
  if (!endpoint || !apiKey) {
    throw requestError('Configura KLING_API_URL e KLING_API_KEY per abilitare la generazione.', 503);
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw requestError('KLING_API_URL non è un URL valido.', 503);
  }
  if (!isAllowedGatewayProtocol(url)) {
    throw requestError('KLING_API_URL deve usare HTTPS (HTTP è consentito solo verso localhost in sviluppo).', 503);
  }
  return { endpoint: url.href, apiKey };
}

function getStatusConfig(taskId) {
  const template = process.env.KLING_API_STATUS_URL;
  if (!template) return null;
  const statusUrl = template.replaceAll('{taskId}', encodeURIComponent(taskId));
  let url;
  try {
    url = new URL(statusUrl);
  } catch {
    throw requestError('KLING_API_STATUS_URL non è un URL valido.', 503);
  }
  if (!isAllowedGatewayProtocol(url)) {
    throw requestError('KLING_API_STATUS_URL deve usare HTTPS (HTTP è consentito solo verso localhost in sviluppo).', 503);
  }
  return url.href;
}

async function parseProviderResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw requestError(`Il gateway Kling ha restituito JSON non valido (HTTP ${response.status}).`, 502);
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`;
    throw requestError(typeof detail === 'string' ? detail : JSON.stringify(detail), 502);
  }
  return data;
}

function findValue(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, predicate);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (predicate(key, child)) return child;
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, predicate);
    if (found !== null) return found;
  }
  return null;
}

function normalizeStatus(value) {
  if (typeof value !== 'string') return 'PENDING';
  const normalized = value.toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded', 'done', 'finished'].includes(normalized)) return 'COMPLETE';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(normalized)) return 'ERROR';
  return 'PENDING';
}

function normalizeProviderResult(data) {
  const taskId = findValue(data, (key, value) =>
    ['taskid', 'task_id', 'requestid', 'request_id', 'generationid', 'generation_id', 'id'].includes(key.toLowerCase())
      && (typeof value === 'string' || typeof value === 'number'));
  const statusValue = findValue(data, (key, value) =>
    ['status', 'task_status', 'taskstatus'].includes(key.toLowerCase()) && typeof value === 'string');
  const videoUrl = findValue(data, (key, value) => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes('video') || /\.mp4(?:$|[?#])/i.test(value);
  });
  const errorMessage = findValue(data, (key, value) =>
    ['error', 'errormessage', 'message'].includes(key.toLowerCase()) && typeof value === 'string');
  const status = videoUrl ? 'COMPLETE' : normalizeStatus(statusValue);
  return { taskId: taskId === null ? null : String(taskId), status, videoUrl, error: status === 'ERROR' ? errorMessage : null };
}

async function fetchKling(url, apiKey, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(120_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...options.headers
      }
    });
  } catch (error) {
    throw requestError(`Impossibile contattare il gateway Kling: ${error.message}`, 502);
  }
  return parseProviderResponse(response);
}

const GENERATION_LOCK_TTL_SECONDS = 20 * 60;

// The credit is charged only once the provider has returned the video, never before.
// Availability is checked up front and a per-wallet lock keeps concurrent requests from over-spending one credit.
async function createDance(payload, clientIp) {
  const walletId = parseWalletId(payload?.walletId);
  const kind = await creditKindFor(payload, walletId);
  const available = await walletGet(walletId);
  if ((kind === 'retry' ? available.retryCredits : available.mainCredits) <= 0) throw noCreditsError(kind);

  const lockKey = `animadisegni:generation-lock:${walletId}`;
  if (!(await acquireLock(lockKey, GENERATION_LOCK_TTL_SECONDS))) {
    throw apiError('A video is already being generated for this account. Wait for it to finish.', 409, 'GENERATION_IN_PROGRESS');
  }
  const wallet = { walletId, creditKind: kind, charged: false, deferRelease: false, release: () => releaseLock(lockKey).catch(() => {}) };
  try {
    const result = await createDanceInternal(payload, clientIp, wallet);
    const saved = await getVideo(result.generationToken);
    return { ...result, audioUrl: trackUrl(saved?.audioFile), creditKind: kind, credits: await walletGet(walletId) };
  } catch (error) {
    // Charged only after a successful provider answer; if anything fails afterwards the credit is returned.
    if (wallet.charged) await walletRefund(walletId, kind).catch((refundError) => console.error('[credits] Refund failed:', refundError));
    throw error;
  } finally {
    if (!wallet.deferRelease) await wallet.release();
  }
}

function noCreditsError(kind) {
  return kind === 'retry'
    ? apiError('No free retries left for this drawing.', 402, 'NO_RETRY_CREDITS')
    : apiError('No video credits left. Buy a credit package to continue.', 402, 'NO_CREDITS');
}

// Spends the credit after the provider has answered successfully; fails (nothing delivered) if it can no longer be paid.
async function chargeCredit(generationToken, wallet) {
  const spent = await walletConsume(wallet.walletId, wallet.creditKind);
  if (!spent.ok) throw noCreditsError(wallet.creditKind);
  wallet.charged = true;
  await saveVideo(generationToken, { creditCharged: true, paid: true });
  console.info(`[credits] Wallet ${wallet.walletId.slice(0, 8)}…: 1 ${wallet.creditKind} credit used after a successful generation (${spent.mainCredits} main / ${spent.retryCredits} retry left).`);
}

// Calls Fal.ai and guarantees a non-empty video URL; any failure or timeout is reported clearly and costs no credit.
async function requestFalVideo(imageUrl, motionPreset, options) {
  let url;
  try {
    url = await generateVideoFromImage(imageUrl, motionPreset, options);
  } catch (error) {
    if (!error.statusCode) error.statusCode = 502;
    error.message = `${error.message} Nessun credito è stato scalato. / No credit was charged.`;
    throw error;
  }
  if (typeof url !== 'string' || !url) {
    throw apiError('Il servizio video non ha restituito il video. Nessun credito è stato scalato. / The video service returned no video. No credit was charged.', 502, 'GENERATION_FAILED');
  }
  return url;
}
// A retry reuses the exact same drawing of a previous generation owned by the same wallet; anything else is a new video.
async function creditKindFor(payload, walletId) {
  if (payload.retryOfToken === undefined || payload.retryOfToken === null) return 'main';
  const previous = typeof payload.retryOfToken === 'string' && /^[\da-f-]{36}$/i.test(payload.retryOfToken)
    ? await getVideo(payload.retryOfToken)
    : null;
  const sameDrawing = previous?.walletId === walletId && previous.imageHash === hashImage(validateImageUrl(payload.imageUrl));
  if (!sameDrawing) throw apiError('Free retries are only available for the same drawing.', 409, 'RETRY_MISMATCH');
  return 'retry';
}

function hashImage(dataUrl) {
  return crypto.createHash('sha256').update(dataUrl).digest('hex');
}

const activeGenerations = new Set();

async function failGeneration(generationToken, error, { walletId, creditKind, charged }) {
  console.error(`[generation:${generationToken}] Background generation failed:`, error?.message, error?.cause ?? '');
  await saveVideo(generationToken, {
    generationStatus: 'ERROR',
    errorMessage: error instanceof Error ? error.message : 'Errore durante la generazione.'
  }).catch((saveError) => console.error('[generation] Unable to save error state:', saveError));
  // Only a credit that was actually charged is returned; before the charge nothing was spent.
  if (charged) await walletRefund(walletId, creditKind).catch((refundError) => console.error('[credits] Refund failed:', refundError));
}

async function runFalGeneration(generationToken, imageUrl, motionPreset, options, wallet) {
  try {
    const falVideoUrl = await requestFalVideo(imageUrl, motionPreset, options);
    await chargeCredit(generationToken, wallet);
    await saveVideo(generationToken, { sourceVideoUrl: falVideoUrl, generationStatus: 'RENDERING' });
    await renderAndSaveVideo(generationToken, falVideoUrl);
  } catch (error) {
    await failGeneration(generationToken, error, wallet);
  } finally {
    await wallet.release();
  }
}

async function createDanceInternal({ imageUrl: rawImageUrl, motionPreset: rawMotionPreset, aspectRatio: rawAspectRatio, renderStyle: rawRenderStyle, background: rawBackground, card: rawCard, music: rawMusic }, clientIp, wallet) {
  const { walletId, creditKind } = wallet;
  const aspectRatio = normalizeAspectRatio(rawAspectRatio);
  const card = normalizeCard(rawCard);
  const validatedImage = validateImageUrl(rawImageUrl);
  const imageHash = hashImage(validatedImage);
  const imageUrl = await saveImageAsPublicUrl(validatedImage, aspectRatio);
  const motionPreset = validateMotionPreset(rawMotionPreset);
  const useFal = Boolean(process.env.FAL_KEY);
  const { endpoint, apiKey } = useFal ? {} : getKlingConfig();
  // The per-IP quota (4/day, 10/month) is off by default: only credits limit generation. Set ENFORCE_IP_QUOTA=true to re-enable it.
  const enforceIpQuota = process.env.ENFORCE_IP_QUOTA === 'true';
  if (enforceIpQuota && (typeof clientIp !== 'string' || !clientIp.trim())) {
    throw requestError('Indirizzo IP non disponibile: impossibile applicare i limiti di generazione.', 503);
  }
  const quota = enforceIpQuota
    ? await consumeGeneration(clientIp)
    : { allowed: true };
  if (!quota.allowed) {
    const error = requestError('Hai raggiunto il limite di 4 video al giorno o 10 video al mese per questo indirizzo IP.', 429);
    error.quota = quota;
    throw error;
  }
  const generationToken = crypto.randomUUID();
  console.info(`[generation:${generationToken}] Submitting image-to-video request to Kling.`);
  const audioFile = pickTrack(rawMusic ?? motionPreset).file;
  await saveVideo(generationToken, {
    motionPreset,
    aspectRatio,
    card,
    walletId,
    imageHash,
    creditKind,
    audioFile,
    generationStatus: 'SUBMITTING',
    // paid (HD, watermark-free download) is set only once the credit is charged.
    paid: false
  });
  // The order id is the generation token; the exact Fal.ai inputs are kept so a free retry can replay them.
  await createOrder({
    orderId: generationToken,
    params: {
      prompt: buildPrompt(motionPreset, rawRenderStyle, rawBackground),
      style: rawRenderStyle ?? null,
      image: imageUrl,
      background: rawBackground ?? null,
      audio: audioFile,
      motionPreset,
      aspectRatio,
      card
    }
  }).catch((error) => console.error(`[orders] Unable to create order ${generationToken}:`, error.message));
  if (useFal && process.env.VERCEL) {
    // Serverless functions are frozen once the response is sent, so the job must complete within the request.
    const falVideoUrl = await requestFalVideo(imageUrl, motionPreset, { aspectRatio, renderStyle: rawRenderStyle, background: rawBackground });
    await chargeCredit(generationToken, wallet);
    await saveVideo(generationToken, { sourceVideoUrl: falVideoUrl, generationStatus: 'RENDERING' });
    const videoUrl = await renderAndSaveVideo(generationToken, falVideoUrl);
    return { generationToken, taskId: null, status: 'COMPLETE', videoUrl, canPoll: false };
  }
  if (useFal) {
    // Fal generation takes minutes: run it in the background and let the client poll, so no HTTP request stays open
    // (tunnels/proxies/browsers drop long-lived requests, which surfaced as "Couldn't reach /api/generate-dance").
    activeGenerations.add(generationToken);
    wallet.deferRelease = true;
    runFalGeneration(generationToken, imageUrl, motionPreset, { aspectRatio, renderStyle: rawRenderStyle, background: rawBackground }, wallet)
      .finally(() => activeGenerations.delete(generationToken));
    return { generationToken, taskId: null, status: 'PENDING', canPoll: true };
  }
  const providerResponse = await fetchKling(endpoint, apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageUrl, motionPreset, aspectRatio })
  });
  const normalized = normalizeProviderResult(providerResponse);
  console.info(`[generation:${generationToken}] Kling returned status ${normalized.status}${normalized.taskId ? ` (task ${normalized.taskId})` : ''}.`);
  if (normalized.status === 'ERROR') {
    throw requestError(normalized.error || 'Il gateway Kling non è riuscito a generare il video.', 502);
  }
  if (normalized.status === 'COMPLETE' && !normalized.videoUrl) {
    throw requestError('Il gateway Kling segnala il completamento senza restituire l’URL MP4.', 502);
  }
  if (!normalized.videoUrl && !normalized.taskId) {
    throw requestError('Il gateway Kling non ha restituito un URL video o un ID task.', 502);
  }

  await chargeCredit(generationToken, wallet);
  await saveVideo(generationToken, {
    taskId: normalized.taskId,
    motionPreset,
    sourceVideoUrl: normalized.videoUrl || null,
    generationStatus: normalized.videoUrl ? 'RENDERING' : normalized.status
  });
  const videoUrl = normalized.videoUrl
    ? await renderAndSaveVideo(generationToken, normalized.videoUrl)
    : null;
  return {
    generationToken,
    taskId: normalized.taskId,
    status: videoUrl ? 'COMPLETE' : normalized.status,
    videoUrl,
    canPoll: Boolean(normalized.taskId && process.env.KLING_API_STATUS_URL)
  };
}

async function getDanceStatus(generationToken) {
  const result = await getDanceStatusInternal(generationToken);
  const saved = await getVideo(generationToken);
  return { ...result, audioUrl: trackUrl(saved?.audioFile) };
}

async function getDanceStatusInternal(generationToken) {
  if (typeof generationToken !== 'string' || !/^[\da-f-]{36}$/i.test(generationToken)) {
    throw requestError('Identificativo della richiesta non valido.');
  }
  const savedVideo = await getVideo(generationToken);
  if (!savedVideo) throw requestError('Task non trovato o non più disponibile.', 404);
  if (savedVideo.generationStatus === 'ERROR') {
    return {
      generationToken,
      taskId: savedVideo.taskId,
      status: 'ERROR',
      error: savedVideo.errorMessage || 'Il gateway Kling non è riuscito a generare il video.',
      canPoll: false
    };
  }
  if (activeGenerations.has(generationToken)) {
    return { generationToken, taskId: null, status: 'PENDING', canPoll: true };
  }
  if (savedVideo.generatedVideoPath && savedVideo.videoUrl) {
    console.info(`[generation:${generationToken}] Returning cached loop preview.`);
    return {
      generationToken,
      taskId: savedVideo.taskId,
      status: 'COMPLETE',
      videoUrl: savedVideo.videoUrl,
      canPoll: false
    };
  }
  if (savedVideo.sourceVideoUrl) {
    console.info(`[generation:${generationToken}] Resuming loop render from saved Kling output.`);
    const videoUrl = await renderAndSaveVideo(generationToken, savedVideo.sourceVideoUrl);
    return {
      generationToken,
      taskId: savedVideo.taskId,
      status: 'COMPLETE',
      videoUrl,
      canPoll: false
    };
  }
  if (!savedVideo.taskId) {
    if (savedVideo.generationStatus === 'SUBMITTING' && savedVideo.walletId) {
      // The server was restarted while the video was being generated: the job is lost.
      await failGeneration(generationToken, new Error('La generazione è stata interrotta (server riavviato). Riprova: nessun credito è stato scalato.'), { walletId: savedVideo.walletId, creditKind: savedVideo.creditKind, charged: savedVideo.creditCharged === true });
      return { generationToken, taskId: null, status: 'ERROR', error: 'La generazione è stata interrotta (server riavviato). Riprova: nessun credito è stato scalato.', canPoll: false };
    }
    throw requestError('Task non trovato o non più disponibile.', 404);
  }

  const statusEndpoint = getStatusConfig(savedVideo.taskId);
  if (!statusEndpoint) {
    return { generationToken, taskId: savedVideo.taskId, status: savedVideo.generationStatus || 'PENDING', canPoll: false };
  }
  console.info(`[generation:${generationToken}] Checking Kling task ${savedVideo.taskId}.`);
  const { apiKey } = getKlingConfig();
  const providerResponse = await fetchKling(statusEndpoint, apiKey);
  const normalized = normalizeProviderResult(providerResponse);
  console.info(`[generation:${generationToken}] Kling task ${savedVideo.taskId} status: ${normalized.status}.`);
  if (normalized.status === 'ERROR') {
    await saveVideo(generationToken, { generationStatus: 'ERROR' });
    return {
      generationToken,
      taskId: savedVideo.taskId,
      status: 'ERROR',
      error: normalized.error || 'Il gateway Kling non è riuscito a generare il video.',
      canPoll: false
    };
  }
  if (normalized.videoUrl) {
    const videoUrl = await renderAndSaveVideo(generationToken, normalized.videoUrl);
    return {
      generationToken,
      taskId: savedVideo.taskId,
      status: 'COMPLETE',
      videoUrl,
      canPoll: false
    };
  } else if (normalized.status === 'COMPLETE') {
    throw requestError('Il gateway Kling segnala il completamento senza restituire l’URL MP4.', 502);
  } else if (normalized.status) {
    await saveVideo(generationToken, { generationStatus: normalized.status });
  }
  return {
    generationToken,
    taskId: savedVideo.taskId,
    status: normalized.videoUrl ? 'COMPLETE' : normalized.status,
    videoUrl: normalized.videoUrl,
    canPoll: !normalized.videoUrl
  };
}

module.exports = { createDance, getDanceStatus, renderAndSaveVideo };
