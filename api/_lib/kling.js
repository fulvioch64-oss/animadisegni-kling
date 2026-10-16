const crypto = require('node:crypto');
const { consumeGeneration, getVideo, saveVideo } = require('./store.js');
const { renderLoopVideo } = require('./video-loop.js');
const { generateVideoFromImage } = require('./fal-video.js');

function previewUrl(generationToken) {
  return `/api/preview?id=${encodeURIComponent(generationToken)}`;
}

async function renderAndSaveVideo(generationToken, sourceVideoUrl) {
  console.info(`[generation:${generationToken}] Kling video ready; starting loop render.`);
  const generatedVideoPath = await renderLoopVideo(generationToken, sourceVideoUrl);
  const videoUrl = previewUrl(generationToken);
  await saveVideo(generationToken, {
    sourceVideoUrl,
    generatedVideoPath,
    videoUrl,
    generationStatus: 'COMPLETE'
  });
  console.info(`[generation:${generationToken}] Loop render complete; preview URL is ready.`);
  return videoUrl;
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw requestError('imageUrl deve essere un URL pubblico valido.');
  }
  let imageUrl;
  try {
    imageUrl = new URL(value);
  } catch {
    throw requestError('imageUrl deve essere un URL pubblico valido.');
  }
  if (!['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password) {
    throw requestError('imageUrl deve usare HTTP o HTTPS ed essere privo di credenziali.');
  }
  const host = imageUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isPrivateHost = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^(?:127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  if (isPrivateHost) {
    throw requestError('imageUrl non è raggiungibile da Kling: configura BLOB_READ_WRITE_TOKEN o PUBLIC_BASE_URL con un URL pubblico (es. tunnel).');
  }
  return imageUrl.href;
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

const TEST_IMAGE_URL = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop';

// Dev only: when the supplied image URL is missing or not publicly reachable (e.g. a localhost upload
// without PUBLIC_BASE_URL/blob storage), fall back to a public test image. Real public URLs are kept.
function resolveImageUrl(rawImageUrl) {
  try {
    return validateImageUrl(rawImageUrl);
  } catch (error) {
    if (process.env.NODE_ENV === 'production') throw error;
    console.warn(`[kling] Image URL not publicly reachable (${error.message}); using static test image.`);
    return validateImageUrl(TEST_IMAGE_URL);
  }
}

async function createDance({ imageUrl: rawImageUrl, motionPreset: rawMotionPreset }, clientIp) {
  const imageUrl = resolveImageUrl(rawImageUrl);
  const motionPreset = validateMotionPreset(rawMotionPreset);
  const useFal = Boolean(process.env.FAL_KEY);
  const { endpoint, apiKey } = useFal ? {} : getKlingConfig();
  if (typeof clientIp !== 'string' || !clientIp.trim()) {
    throw requestError('Indirizzo IP non disponibile: impossibile applicare i limiti di generazione.', 503);
  }
  const quota = process.env.NODE_ENV !== 'production'
    ? { allowed: true }
    : await consumeGeneration(clientIp);
  if (!quota.allowed) {
    const error = requestError('Hai raggiunto il limite di 4 video al giorno o 10 video al mese per questo indirizzo IP.', 429);
    error.quota = quota;
    throw error;
  }
  const generationToken = crypto.randomUUID();
  console.info(`[generation:${generationToken}] Submitting image-to-video request to Kling.`);
  await saveVideo(generationToken, {
    motionPreset,
    sourceImageUrl: imageUrl,
    generationStatus: 'SUBMITTING',
    paid: false
  });
  if (useFal) {
    const falVideoUrl = await generateVideoFromImage(imageUrl, motionPreset);
    await saveVideo(generationToken, { sourceVideoUrl: falVideoUrl, generationStatus: 'RENDERING' });
    const videoUrl = await renderAndSaveVideo(generationToken, falVideoUrl);
    return { generationToken, taskId: null, status: 'COMPLETE', videoUrl, canPoll: false };
  }
  const providerResponse = await fetchKling(endpoint, apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageUrl, motionPreset })
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

  await saveVideo(generationToken, {
    taskId: normalized.taskId,
    motionPreset,
    sourceImageUrl: imageUrl,
    sourceVideoUrl: normalized.videoUrl || null,
    generationStatus: normalized.videoUrl ? 'RENDERING' : normalized.status,
    paid: false
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
      error: 'Il gateway Kling non è riuscito a generare il video.',
      canPoll: false
    };
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
  if (!savedVideo.taskId) throw requestError('Task non trovato o non più disponibile.', 404);

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

module.exports = { createDance, getDanceStatus };
