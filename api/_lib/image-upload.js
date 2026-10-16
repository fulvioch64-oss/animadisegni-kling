const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { put } = require('@vercel/blob');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LOCAL_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_UPLOAD_DIRECTORY = path.resolve(__dirname, '..', '..', 'public', 'uploads');
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
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

function resolvePublicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_BASE_URL deve usare HTTP o HTTPS.');
    return url.href.replace(/\/$/, '');
  }

  const host = req?.headers?.host || '127.0.0.1:3000';
  return `http://${host}`;
}

async function uploadImage(dataUrl, req) {
  const { image, mimeType, extension } = parseImageDataUrl(dataUrl);
  const filename = `${crypto.randomUUID()}.${extension}`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (token) {
    const blob = await put(filename, image, {
      access: 'public',
      contentType: mimeType,
      token
    });
    return { imageUrl: blob.url, storage: 'vercel-blob' };
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Configura BLOB_READ_WRITE_TOKEN per caricare immagini in produzione.');
    error.statusCode = 503;
    throw error;
  }

  await removeExpiredLocalUploads();
  await fs.promises.writeFile(path.join(PUBLIC_UPLOAD_DIRECTORY, filename), image, { flag: 'wx' });
  const imageUrl = `${resolvePublicBaseUrl(req)}/uploads/${filename}`;
  return { imageUrl, storage: 'local', expiresInSeconds: LOCAL_UPLOAD_TTL_MS / 1000 };
}

module.exports = { uploadImage };
