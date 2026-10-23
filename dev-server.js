const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const publicDirectory = path.resolve(__dirname, 'public');
const maxBodyBytes = 14 * 1024 * 1024;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp'
};

const apiHandlers = new Map([
  ['generate-dance', require('./api/generate-dance.js')],
  ['upload-image', require('./api/upload-image.js')],
  ['checkout', require('./api/checkout.js')],
  ['credits', require('./api/credits.js')],
  ['auth', require('./api/auth.js')],
  ['payment-status', require('./api/payment-status.js')],
  ['download', require('./api/download.js')],
  ['preview', require('./api/preview.js')],
  ['webhook', require('./api/webhook.js')],
  ['stripe-webhook', require('./api/stripe-webhook.js')],
  ['retry', require('./api/retry.js')],
  ['test-fal', require('./api/test-fal.js')]
]);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.resume();
      const error = new Error('La richiesta supera il limite di 14 MB.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Il corpo della richiesta deve essere JSON valido.');
    error.statusCode = 400;
    throw error;
  }
}

function resolvePublicFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(publicDirectory, relativePath);
  const relativeToPublic = path.relative(publicDirectory, filePath);
  if (relativeToPublic.startsWith('..') || path.isAbsolute(relativeToPublic)) return null;
  return filePath;
}

async function serveStatic(req, res, pathname) {
  const filePath = resolvePublicFile(pathname);
  if (!filePath) {
    sendJson(res, 400, { error: 'Percorso file non valido.' });
    return;
  }

  let fileInfo;
  try {
    fileInfo = await fs.promises.stat(filePath);
    if (fileInfo.isDirectory()) {
      return serveStatic(req, res, `${pathname.replace(/\/+$/, '')}/index.html`);
    }
    if (!fileInfo.isFile()) {
      sendJson(res, 404, { error: 'File non trovato.' });
      return;
    }
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      sendJson(res, 404, { error: 'File non trovato.' });
      return;
    }
    throw error;
  }

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileInfo.size,
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
  } catch {
    sendJson(res, 400, { error: 'URL della richiesta non valido.' });
    return;
  }

  const apiMatch = /^\/api\/([a-z-]+)$/.exec(requestUrl.pathname);
  if (apiMatch && apiHandlers.has(apiMatch[1])) {
    const handler = apiHandlers.get(apiMatch[1]);
    try {
      req.ip = req.socket.remoteAddress;
      req.query = Object.fromEntries(requestUrl.searchParams.entries());
      if (req.method === 'POST' && apiMatch[1] !== 'webhook' && apiMatch[1] !== 'stripe-webhook') req.body = await readJsonBody(req);
      res.status = function status(code) {
        res.statusCode = code;
        return res;
      };
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        console.error('Errore durante la risposta locale dell’API:', error);
        res.destroy(error);
        return;
      }
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      if (statusCode >= 500) console.error('Errore nel server di sviluppo:', error);
      sendJson(res, statusCode, {
        error: statusCode >= 500 ? 'Errore interno del server locale.' : error.message
      });
    }
    return;
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    console.error(`[dev-server] No API route for ${req.method} ${requestUrl.pathname}`);
    sendJson(res, 404, { error: `Route API non trovata: ${requestUrl.pathname}` });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'Metodo non consentito.' });
    return;
  }

  try {
    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    console.error('Errore nel server di sviluppo:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Errore durante la lettura del file statico.' });
    else res.destroy(error);
  }
});

// A stray error in a background generation must not kill the dev server (that made the browser lose the connection).
process.on('unhandledRejection', (reason) => console.error('[dev-server] Unhandled rejection:', reason));
process.on('uncaughtException', (error) => console.error('[dev-server] Uncaught exception:', error));

const port = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT deve essere un numero valido compreso tra 1 e 65535.');
}

server.listen(port, '127.0.0.1', () => {
  console.log(`AnimaDisegni disponibile su http://127.0.0.1:${port}`);
});
