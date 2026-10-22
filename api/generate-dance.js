const path = require('node:path');
const fs = require('node:fs');
const localEnvFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', name))
  .filter((envPath) => fs.existsSync(envPath));
if (localEnvFiles.length) require('dotenv').config({ path: localEnvFiles });

const { createDance, getDanceStatus } = require('./_lib/kling.js');
const { currentUser } = require('./_lib/auth.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      // Anonymous visitors are rejected first: no body parsing, image processing or temporary files.
      const user = await currentUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Sign in with Google to generate videos.', code: 'AUTH_REQUIRED' });
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return sendJson(res, 400, { error: 'Corpo della richiesta non valido.' });
      }
      const forwardedIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      const clientIp = req.ip || forwardedIp;
      // The charged wallet always comes from the session, never from a client-supplied ID.
      const body = { ...req.body, walletId: user.walletId };
      const result = await createDance(body, clientIp);
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
    if (status >= 500) console.error(`[generate-dance] ${req.method} failed (HTTP ${status}):`, error?.message, error?.cause ?? error);
    return sendJson(res, status, {
      error: error instanceof Error ? error.message : 'Errore durante la generazione Kling.',
      ...(error.code && typeof error.code === 'string' ? { code: error.code } : {}),
      ...(error.quota ? { quota: error.quota } : {})
    });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '14mb' } }
};
