const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DEFAULT_ASPECT_RATIO, ASPECT_RATIOS, normalizeAspectRatio, fitFilter } = require('./aspect-ratio.js');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LOCAL_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_UPLOAD_DIRECTORY = path.resolve(__dirname, '..', '..', 'public', 'uploads');
const BACKGROUND_DIRECTORY = path.resolve(__dirname, '..', '..', 'public', 'sfondi');
const DEFAULT_BACKGROUND = 'original';
// Illustrated scenes in public/sfondi/ (key = `background` value sent by the client). To add a scene, add a PNG and one entry.
const BACKGROUND_FILES = {
  playroom: 'stanza-giochi.png',
  enchanted_stage: 'palco-incantato.png',
  neon_stage: 'palco-neon.png'
};
const BACKGROUND_IDS = [DEFAULT_BACKGROUND, ...Object.keys(BACKGROUND_FILES)];

function normalizeBackground(value) {
  return typeof value === 'string' && BACKGROUND_IDS.includes(value) ? value : DEFAULT_BACKGROUND;
}
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

function inputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw inputError('Carica un’immagine prima di avviare il caricamento.');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw inputError('L’immagine deve essere un file JPG, PNG o WEBP valido.');

  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) {
    throw inputError('L’immagine deve avere una dimensione massima di 10 MB.');
  }
  return { image, mimeType: match[1], extension: MIME_EXTENSIONS.get(match[1]) };
}

async function removeExpiredLocalUploads() {
  await fs.promises.mkdir(PUBLIC_UPLOAD_DIRECTORY, { recursive: true });
  const entries = await fs.promises.readdir(PUBLIC_UPLOAD_DIRECTORY, { withFileTypes: true });
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !/^[\da-f-]{36}\.(?:jpg|png|webp)$/i.test(entry.name)) return;
    const filePath = path.join(PUBLIC_UPLOAD_DIRECTORY, entry.name);
    const info = await fs.promises.stat(filePath);
    if (now - info.mtimeMs > LOCAL_UPLOAD_TTL_MS) await fs.promises.unlink(filePath);
  }));
}

function resolvePublicBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL;
  if (!configured) {
    throw inputError('Configura PUBLIC_BASE_URL con un URL pubblico raggiungibile da Fal.ai/Kling (es. un tunnel verso questo server).', 503);
  }
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw inputError('PUBLIC_BASE_URL non è un URL valido.', 503);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw inputError('PUBLIC_BASE_URL deve usare HTTP o HTTPS.', 503);
  if (isLocalHostname(url.hostname)) {
    console.error(TUNNEL_HELP(`PUBLIC_BASE_URL punta a un indirizzo locale (${url.host})`));
    throw inputError('PUBLIC_BASE_URL punta a localhost: Fal.ai non può scaricare l’immagine. Avvia un tunnel (es. "ngrok http 3000" o "npx localtunnel --port 3000") e aggiorna PUBLIC_BASE_URL in .env.local, poi riavvia il server.', 503);
  }
  return url.href.replace(/\/$/, '');
}

function isLocalHostname(hostname) {
  return /^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(hostname) || hostname.endsWith('.local');
}

const TUNNEL_HELP = (reason) => [
  `[public-url] ${reason}.`,
  '[public-url] Fal.ai deve scaricare l’immagine da internet. Per sviluppo locale:',
  '[public-url]   1. avvia un tunnel: "ngrok http 3000", "npx localtunnel --port 3000" o "cloudflared tunnel --url http://localhost:3000";',
  '[public-url]   2. copia l’URL https generato in PUBLIC_BASE_URL dentro .env.local;',
  '[public-url]   3. riavvia il server di sviluppo.'
].join('\n');

// Validates the uploaded image and returns it as a data URI, used for the instant preview in the UI.
async function uploadImage(dataUrl) {
  const { mimeType, image } = parseImageDataUrl(dataUrl);
  return { imageUrl: `data:${mimeType};base64,${image.toString('base64')}`, storage: 'inline' };
}

// Fits the image on a white canvas with the target aspect ratio; the video model derives the video format from the image.
function fitImageToAspectRatio(inputPath, outputPath, aspectRatio) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath) {
      reject(new Error('FFmpeg binary is unavailable for this platform.'));
      return;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vf', fitFilter(aspectRatio), '-frames:v', '1', '-q:v', '2', outputPath];
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.on('error', (error) => reject(new Error(`Unable to start FFmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Unable to adapt the image to ${aspectRatio}: ${stderr.trim() || `FFmpeg exit code ${code}`}`));
    });
  });
}

function getFalKey() {
  return (process.env.FAL_KEY || '')
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .replace(/^["']|["']$/g, '');
}

// Fal errors carry the useful reason in `body.detail` (e.g. "Exhausted balance"); `message` is often just "Forbidden".
function describeFalError(error) {
  const detail = typeof error?.body?.detail === 'string' ? error.body.detail : JSON.stringify(error?.body?.detail ?? '');
  if (/exhausted balance|locked/i.test(detail)) return 'credito Fal.ai esaurito: ricarica il saldo su fal.ai/dashboard/billing';
  if (error?.status === 401 || error?.status === 403) return `FAL_KEY non valida o senza permessi (${detail || error.message})`;
  return detail && detail !== '""' ? `${error?.message || 'errore'} (${detail})` : (error?.message || 'errore sconosciuto');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}: timeout di ${Math.round(ms / 1000)} secondi`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function configureFal() {
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: getFalKey() });
  return fal;
}

// Uploads to Fal's own storage so Fal never needs to reach this machine (no tunnel / PUBLIC_BASE_URL required).
async function uploadFileToFalStorage(filePath, contentType = 'image/jpeg') {
  const fal = configureFal();
  const buffer = await fs.promises.readFile(filePath);
  return withTimeout(fal.storage.upload(new Blob([buffer], { type: contentType })), 60_000, 'Upload su Fal storage');
}

function runFfmpeg(args, failureMessage) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath) {
      reject(new Error('FFmpeg binary is unavailable for this platform.'));
      return;
    }
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.on('error', (error) => reject(new Error(`Unable to start FFmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${failureMessage}: ${stderr.trim() || `FFmpeg exit code ${code}`}`));
    });
  });
}

const BACKGROUND_REMOVAL_TIMEOUT_MS = 90_000;

// Cut-out tuning for drawings on white/light paper. A pixel is "paper" when it is within PAPER_DISTANCE (RGB euclidean) of the
// border colour and connected to the image border, so white areas enclosed by the character's outline stay opaque.
const PAPER_DISTANCE = 48;
const PAPER_MIN_BRIGHTNESS = 150;
const PAPER_MAX_BORDER_SPREAD = 28;
const MIN_SUBJECT_COVERAGE = 0.005;
const MAX_SUBJECT_COVERAGE = 0.85;

function describeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    cause: error?.cause?.message ?? error?.cause,
    stack: String(error?.stack ?? '').split('\n').slice(0, 4).join(' | ')
  };
}

// Fast, deterministic cut-out for paper drawings: flood-fills the paper colour from the border and softens the alpha edge.
async function removePaperBackgroundToFile(imageFilePath, outputPngPath) {
  const sharp = require('sharp');
  const { data, info } = await sharp(imageFilePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const at = (x, y) => (y * width + x) * 3;

  const border = [];
  for (let x = 0; x < width; x++) border.push(at(x, 0), at(x, height - 1));
  for (let y = 1; y < height - 1; y++) border.push(at(0, y), at(width - 1, y));
  const mean = [0, 1, 2].map((c) => border.reduce((sum, i) => sum + data[i + c], 0) / border.length);
  const spread = Math.max(...[0, 1, 2].map((c) => Math.sqrt(border.reduce((sum, i) => sum + (data[i + c] - mean[c]) ** 2, 0) / border.length)));
  const brightness = (mean[0] + mean[1] + mean[2]) / 3;
  if (brightness < PAPER_MIN_BRIGHTNESS || spread > PAPER_MAX_BORDER_SPREAD) {
    throw new Error(`The image border is not a uniform light paper (brightness ${brightness.toFixed(0)}, spread ${spread.toFixed(1)})`);
  }

  const isPaper = (i) => Math.hypot(data[i] - mean[0], data[i + 1] - mean[1], data[i + 2] - mean[2]) <= PAPER_DISTANCE;
  const background = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const p = y * width + x;
    if (background[p] || !isPaper(p * 3)) return;
    background[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  const alpha = Buffer.alloc(width * height);
  let subjectPixels = 0;
  for (let p = 0; p < alpha.length; p++) {
    if (!background[p]) { alpha[p] = 255; subjectPixels++; }
  }
  const coverage = subjectPixels / alpha.length;
  console.info(`[image-upload] Paper cut-out: paper rgb(${mean.map((v) => v.toFixed(0)).join(',')}), border spread ${spread.toFixed(1)}, subject coverage ${(coverage * 100).toFixed(1)}%.`);
  if (coverage < MIN_SUBJECT_COVERAGE || coverage > MAX_SUBJECT_COVERAGE) {
    throw new Error(`No clear subject found on the paper (coverage ${(coverage * 100).toFixed(1)}%)`);
  }

  // A light blur on the mask feathers the edge so the drawing doesn't show a white halo on the scene.
  const softAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } }).blur(1.2).toColourspace('b-w').raw().toBuffer();
  await sharp(data, { raw: { width, height, channels: 3 } })
    .joinChannel(softAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toFile(outputPngPath);
}

// Segmentation model for photos / non-uniform backgrounds. The input must be a PNG so the model gets lossless pixels.
async function removeBackgroundWithModel(imageFilePath, outputPngPath) {
  const { removeBackground } = await import('@imgly/background-removal-node');
  const buffer = await require('sharp')(imageFilePath).png().toBuffer();
  const blob = await withTimeout(
    removeBackground(new Blob([buffer], { type: 'image/png' }), { model: 'medium', output: { format: 'image/png' } }),
    BACKGROUND_REMOVAL_TIMEOUT_MS,
    'Local background removal'
  );
  await fs.promises.writeFile(outputPngPath, Buffer.from(await blob.arrayBuffer()));
}

// Detached-part cleanup. Works on a downscaled mask: an erosion breaks thin links (railings, props touching the subject),
// the main components are kept, and a constrained dilation gives the subject its original shape back.
const CLEANUP_MASK_SIZE = 256;
const CLEANUP_ERODE_STEPS = 3;
const CLEANUP_KEEP_RATIO = 0.2;
const CLEANUP_MIN_KEPT_AREA = 0.5;

function morph(mask, width, height, mode) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = mode === 'erode' ? 1 : 0;
      for (let dy = -1; dy <= 1 && (mode === 'erode' ? value : !value); dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
          const v = inside ? mask[ny * width + nx] : 0;
          if (mode === 'erode' && !v) { value = 0; break; }
          if (mode === 'dilate' && v) { value = 1; break; }
        }
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

function largestComponents(mask, width, height) {
  const labels = new Int32Array(mask.length);
  const areas = [0];
  const stack = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = areas.length;
    let area = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const p = stack[--top];
      area++;
      const x = p % width;
      const y = (p - x) / width;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (mask[q] && !labels[q]) { labels[q] = label; stack[top++] = q; }
      }
    }
    areas.push(area);
  }
  const biggest = Math.max(0, ...areas);
  const keep = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) {
    if (labels[p] && areas[labels[p]] >= biggest * CLEANUP_KEEP_RATIO) keep[p] = 1;
  }
  return keep;
}

// Keeps only the main subject of a transparent PNG; never destroys the cut-out if the result looks wrong.
async function keepMainSubject(pngPath) {
  const sharp = require('sharp');
  const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const scale = Math.min(1, CLEANUP_MASK_SIZE / Math.max(width, height));
  const smallW = Math.max(1, Math.round(width * scale));
  const smallH = Math.max(1, Math.round(height * scale));
  const alpha = Buffer.alloc(width * height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = data[p * 4 + 3];
  const small = await sharp(alpha, { raw: { width, height, channels: 1 } }).resize(smallW, smallH, { kernel: 'nearest' }).toColourspace('b-w').raw().toBuffer();
  const original = Uint8Array.from(small, (v) => (v > 127 ? 1 : 0));

  let eroded = original;
  for (let i = 0; i < CLEANUP_ERODE_STEPS; i++) eroded = morph(eroded, smallW, smallH, 'erode');
  if (!eroded.some(Boolean)) return { applied: false, reason: 'subject too thin to analyse' };
  let keep = largestComponents(eroded, smallW, smallH);
  for (let i = 0; i < CLEANUP_ERODE_STEPS + 1; i++) {
    const grown = morph(keep, smallW, smallH, 'dilate');
    for (let p = 0; p < grown.length; p++) grown[p] = grown[p] && original[p] ? 1 : 0;
    keep = grown;
  }
  const before = original.reduce((sum, v) => sum + v, 0);
  const after = keep.reduce((sum, v) => sum + v, 0);
  const removed = before - after;
  if (removed <= before * 0.002) return { applied: false, reason: 'nothing to remove', removedPercent: 0 };
  if (after < before * CLEANUP_MIN_KEPT_AREA) return { applied: false, reason: `too much would be removed (${(100 - (after / before) * 100).toFixed(0)}%)` };

  const keepFull = await sharp(Buffer.from(keep.map((v) => v * 255)), { raw: { width: smallW, height: smallH, channels: 1 } })
    .resize(width, height, { kernel: 'cubic' }).blur(1.5).toColourspace('b-w').raw().toBuffer();
  for (let p = 0; p < alpha.length; p++) data[p * 4 + 3] = Math.round((data[p * 4 + 3] * keepFull[p]) / 255);
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(`${pngPath}.clean.png`);
  await fs.promises.rename(`${pngPath}.clean.png`, pngPath);
  return { applied: true, removedPercent: (removed / before) * 100 };
}

// Drawings sit on a uniform light sheet; anything else is treated as a photo of a person/scene.
async function looksLikePaperDrawing(imageFilePath) {
  const { data, info } = await require('sharp')(imageFilePath).removeAlpha().resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const values = [];
  for (let i = 0; i < 64; i++) for (const [x, y] of [[i, 0], [i, 63], [0, i], [63, i]]) values.push(...data.subarray((y * 64 + x) * info.channels, (y * 64 + x) * info.channels + 3));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const spread = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return mean >= PAPER_MIN_BRIGHTNESS && spread <= PAPER_MAX_BORDER_SPREAD * 1.5;
}

// Primary cut-out: Fal.ai BiRefNet. Photos use the 'Portrait' model so only the person is kept; drawings use the general model.
// Env overrides: FAL_BG_REMOVAL_MODEL (endpoint), FAL_BG_REMOVAL_PHOTO_MODEL / FAL_BG_REMOVAL_DRAWING_MODEL (BiRefNet variants).
const FAL_BACKGROUND_REMOVAL_MODEL = () => (process.env.FAL_BG_REMOVAL_MODEL || 'fal-ai/birefnet/v2').trim();

async function removeBackgroundWithFal(imageFilePath, outputPngPath) {
  if (!getFalKey()) throw new Error('FAL_KEY is not set');
  const fal = configureFal();
  const isDrawing = await looksLikePaperDrawing(imageFilePath);
  const variant = isDrawing
    ? (process.env.FAL_BG_REMOVAL_DRAWING_MODEL || 'General Use (Light)').trim()
    : (process.env.FAL_BG_REMOVAL_PHOTO_MODEL || 'Portrait').trim();
  console.info(`[image-upload] Fal.ai cut-out input looks like a ${isDrawing ? 'drawing' : 'photo'}: BiRefNet variant "${variant}".`);
  const imageUrl = await uploadFileToFalStorage(imageFilePath, 'image/jpeg');
  const result = await withTimeout(
    fal.subscribe(FAL_BACKGROUND_REMOVAL_MODEL(), { input: { image_url: imageUrl, model: variant, output_format: 'png' }, logs: false }),
    BACKGROUND_REMOVAL_TIMEOUT_MS,
    'Fal.ai background removal'
  );
  const cutoutUrl = result?.data?.image?.url;
  if (!cutoutUrl) throw new Error('Fal.ai background removal returned no image');
  const response = await withTimeout(fetch(cutoutUrl), 60_000, 'Cut-out download');
  if (!response.ok) throw new Error(`Cut-out download failed (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());

  // Reject empty or untouched results so a bad cut-out never replaces the drawing.
  const sharp = require('sharp');
  const { channels } = await sharp(buffer).metadata();
  if (channels < 4) throw new Error('Fal.ai cut-out has no transparency');
  const alpha = await sharp(buffer).ensureAlpha().extractChannel(3).raw().toBuffer();
  let opaque = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 127) opaque++;
  const coverage = opaque / alpha.length;
  console.info(`[image-upload] Fal.ai cut-out (${FAL_BACKGROUND_REMOVAL_MODEL()}): subject coverage ${(coverage * 100).toFixed(1)}%.`);
  if (coverage < MIN_SUBJECT_COVERAGE || coverage > 0.97) {
    throw new Error(`Fal.ai cut-out is not usable (coverage ${(coverage * 100).toFixed(1)}%)`);
  }
  await fs.promises.writeFile(outputPngPath, buffer);
}

// Removes the background: Fal.ai BiRefNet first (photos and drawings), then local paper keying, then the local segmentation model.
async function removeBackgroundToFile(imageFilePath, outputPngPath) {
  if (getFalKey()) {
    try {
      await removeBackgroundWithFal(imageFilePath, outputPngPath);
      return 'fal-birefnet';
    } catch (falError) {
      console.warn('[image-upload] Fal.ai background removal failed, trying local methods:', describeError(falError), describeFalError(falError));
    }
  }
  try {
    await removePaperBackgroundToFile(imageFilePath, outputPngPath);
    return 'paper';
  } catch (paperError) {
    console.warn('[image-upload] Paper cut-out not applicable, trying the segmentation model:', describeError(paperError));
  }
  await removeBackgroundWithModel(imageFilePath, outputPngPath);
  return 'model';
}

// Places the cut-out subject (already centered in the target frame) over the scene, covering the whole frame.
function compositeOnBackground(backgroundPath, subjectPngPath, outputPath, aspectRatio) {
  const { width, height } = ASPECT_RATIOS[normalizeAspectRatio(aspectRatio)];
  const subjectWidth = Math.round(width * 0.9);
  const subjectHeight = Math.round(height * 0.9);
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[bg]`,
    `[1:v]format=rgba,scale=${subjectWidth}:${subjectHeight}:force_original_aspect_ratio=decrease[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p'
  ].join(';');
  return runFfmpeg(['-i', backgroundPath, '-i', subjectPngPath, '-filter_complex', filter, '-frames:v', '1', '-q:v', '2', outputPath], 'Unable to compose the subject on the background');
}

// Tries to place the drawing subject on the themed scene. Any failure (e.g. "unable to remove background") is swallowed:
// the caller then keeps the original image, so a background problem never stops the generation.
async function composeThemedImage(fittedPath, backgroundPath, cutoutPath, composedPath, ratio) {
  let stage = 'scene file';
  try {
    await fs.promises.access(backgroundPath);
    stage = 'background removal';
    const method = await removeBackgroundToFile(fittedPath, cutoutPath);
    stage = 'subject cleanup';
    try {
      const cleanup = await keepMainSubject(cutoutPath);
      console.info('[image-upload] Subject cleanup:', cleanup.applied ? `removed ${cleanup.removedPercent.toFixed(1)}% detached/secondary area` : `skipped (${cleanup.reason})`);
    } catch (cleanupError) {
      console.warn('[image-upload] Subject cleanup failed, using the cut-out as is:', describeError(cleanupError));
    }
    stage = 'composition';
    await compositeOnBackground(backgroundPath, cutoutPath, composedPath, ratio);
    console.info(`[image-upload] Background replaced (cut-out method: ${method}).`);
    return true;
  } catch (error) {
    console.error(`[image-upload] Background replacement failed at "${stage}", falling back to the original background:`, describeError(error));
    return false;
  }
}

// Returns the URL the video provider can download (Fal storage when FAL_KEY is set, otherwise public/uploads served through
// PUBLIC_BASE_URL) and the background that was really applied: 'original' keeps the paper sheet as drawn, a themed scene
// replaces it, and any failure of the replacement silently degrades to 'original'.
async function prepareImage(dataUrl, aspectRatio = DEFAULT_ASPECT_RATIO, requestedBackground = DEFAULT_BACKGROUND) {
  const { image, extension } = parseImageDataUrl(dataUrl);
  const ratio = normalizeAspectRatio(aspectRatio);
  const background = normalizeBackground(requestedBackground);
  const useFalStorage = Boolean(getFalKey());
  const baseUrl = useFalStorage ? null : resolvePublicBaseUrl();
  const outputDirectory = useFalStorage ? os.tmpdir() : PUBLIC_UPLOAD_DIRECTORY;
  if (!useFalStorage) await removeExpiredLocalUploads();
  const id = crypto.randomUUID();
  const rawPath = path.join(outputDirectory, `${id}-source.${extension}`);
  const fittedPath = path.join(outputDirectory, `${id}-fitted.jpg`);
  const cutoutPath = path.join(outputDirectory, `${id}-cutout.png`);
  const composedPath = path.join(outputDirectory, `${id}-composed.jpg`);
  await fs.promises.writeFile(rawPath, image, { flag: 'wx' });
  try {
    await fitImageToAspectRatio(rawPath, fittedPath, ratio);
    let uploadPath = fittedPath;
    let appliedBackground = DEFAULT_BACKGROUND;
    if (background !== DEFAULT_BACKGROUND
      && await composeThemedImage(fittedPath, path.join(BACKGROUND_DIRECTORY, BACKGROUND_FILES[background]), cutoutPath, composedPath, ratio)) {
      uploadPath = composedPath;
      appliedBackground = background;
    }
    if (useFalStorage) {
      try {
        return { url: await uploadFileToFalStorage(uploadPath, 'image/jpeg'), background: appliedBackground };
      } catch (error) {
        console.error('[image-upload] Fal storage upload failed:', error?.status, error?.message, JSON.stringify(error?.body ?? ''));
        throw inputError(`Upload dell’immagine su Fal storage non riuscito: ${describeFalError(error)}.`, 502);
      }
    }
    const localName = `${id}.jpg`;
    await fs.promises.copyFile(uploadPath, path.join(outputDirectory, localName));
    return { url: `${baseUrl}/uploads/${localName}`, background: appliedBackground };
  } finally {
    await Promise.all([rawPath, fittedPath, cutoutPath, composedPath].map((file) => fs.promises.rm(file, { force: true })));
  }
}

async function saveImageAsPublicUrl(dataUrl, aspectRatio, background) {
  return (await prepareImage(dataUrl, aspectRatio, background)).url;
}

module.exports = { uploadImage, prepareImage, saveImageAsPublicUrl, uploadFileToFalStorage, normalizeBackground, BACKGROUND_IDS, DEFAULT_BACKGROUND, TUNNEL_HELP, keepMainSubject };
