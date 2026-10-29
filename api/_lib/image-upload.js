const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DEFAULT_ASPECT_RATIO, normalizeAspectRatio, fitFilter } = require('./aspect-ratio.js');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LOCAL_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_UPLOAD_DIRECTORY = path.resolve(__dirname, '..', '..', 'public', 'uploads');
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

// Returns a URL the video provider can download: Fal storage when FAL_KEY is set, otherwise public/uploads served through
// PUBLIC_BASE_URL. The user's image is sent as-is (only fitted to the target aspect ratio); no background removal.
// Illustrated scenes are described in the prompt (see fal-video.js).
async function saveImageAsPublicUrl(dataUrl, aspectRatio = DEFAULT_ASPECT_RATIO) {
  const { image, extension } = parseImageDataUrl(dataUrl);
  const ratio = normalizeAspectRatio(aspectRatio);
  const useFalStorage = Boolean(getFalKey());
  const baseUrl = useFalStorage ? null : resolvePublicBaseUrl();
  const outputDirectory = useFalStorage ? os.tmpdir() : PUBLIC_UPLOAD_DIRECTORY;
  if (!useFalStorage) await removeExpiredLocalUploads();
  const id = crypto.randomUUID();
  const rawPath = path.join(outputDirectory, `${id}-source.${extension}`);
  const fittedPath = path.join(outputDirectory, `${id}-fitted.jpg`);
  await fs.promises.writeFile(rawPath, image, { flag: 'wx' });
  try {
    await fitImageToAspectRatio(rawPath, fittedPath, ratio);
    if (useFalStorage) {
      try {
        return await uploadFileToFalStorage(fittedPath, 'image/jpeg');
      } catch (error) {
        console.error('[image-upload] Fal storage upload failed:', error?.status, error?.message, JSON.stringify(error?.body ?? ''));
        throw inputError(`Upload dell’immagine su Fal storage non riuscito: ${describeFalError(error)}.`, 502);
      }
    }
    const localName = `${id}.jpg`;
    await fs.promises.copyFile(fittedPath, path.join(outputDirectory, localName));
    return `${baseUrl}/uploads/${localName}`;
  } finally {
    await Promise.all([rawPath, fittedPath].map((file) => fs.promises.rm(file, { force: true })));
  }
}

module.exports = { uploadImage, saveImageAsPublicUrl, TUNNEL_HELP };
