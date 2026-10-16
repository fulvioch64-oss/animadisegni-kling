const path = require('node:path');
const fs = require('node:fs');
const localEnvFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', name))
  .filter((envPath) => fs.existsSync(envPath));
if (localEnvFiles.length) require('dotenv').config({ path: localEnvFiles });

const { createDance, getDanceStatus } = require('./_lib/kling.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return sendJson(res, 400, { error: 'Corpo della richiesta non valido.' });
      }
      const forwardedIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      const clientIp = req.ip || forwardedIp;
      const result = await createDance(req.body, clientIp);
      return sendJson(res, 200, result.status === 'COMPLETE' ? { success: true, ...result } : result);
    }
    if (req.method === 'GET') {
      return sendJson(res, 200, await getDanceStatus(req.query?.generationToken));
    }
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Metodo non consentito.' });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400
      : Number.isInteger(error.statusCode) ? error.statusCode : 502;
    if (status >= 500) console.error('Errore API Kling:', error);
    return sendJson(res, status, {
      error: error instanceof Error ? error.message : 'Errore durante la generazione Kling.',
      ...(error.quota ? { quota: error.quota } : {})
    });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};
