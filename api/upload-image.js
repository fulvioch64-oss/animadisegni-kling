const path = require('node:path');
const fs = require('node:fs');
const localEnvFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', name))
  .filter((envPath) => fs.existsSync(envPath));
if (localEnvFiles.length) require('dotenv').config({ path: localEnvFiles });

const { uploadImage } = require('./_lib/image-upload.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Metodo non consentito.' });
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return sendJson(res, 400, { error: 'Corpo della richiesta non valido.' });
  }

  try {
    return sendJson(res, 201, await uploadImage(req.body.image, req));
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 503) {
      return sendJson(res, error.statusCode, { error: error.message });
    }
    console.error('Errore durante il caricamento dell’immagine:', error);
    return sendJson(res, 502, { error: error instanceof Error ? error.message : 'Caricamento dell’immagine non riuscito.' });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '14mb' } }
};
