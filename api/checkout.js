const { getVideo } = require('./_lib/store.js');

function sendJson(res, status, body) {
  return res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Metodo non consentito.' });
  }
  const checkoutUrl = process.env.LEMON_CHECKOUT_URL;
  const appUrl = process.env.PUBLIC_BASE_URL || (process.env.NODE_ENV !== 'production' ? `http://${req.headers.host || 'localhost:3000'}` : '');
  if (!checkoutUrl || !appUrl) return sendJson(res, 503, { error: 'Configura LEMON_CHECKOUT_URL e PUBLIC_BASE_URL per attivare il checkout.' });

  const token = req.body?.generationToken;
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) return sendJson(res, 400, { error: 'Identificativo della richiesta non valido.' });

  try {
    const video = await getVideo(token);
    if (!video?.videoUrl) return sendJson(res, 409, { error: 'Il video non è pronto per il checkout.' });
    const target = new URL(checkoutUrl);
    target.searchParams.set('checkout[custom][generation_id]', token);
    target.searchParams.set('checkout[redirect_url]', `${appUrl.replace(/\/$/, '')}/?purchase=success&id=${encodeURIComponent(token)}`);
    return sendJson(res, 200, { url: target.href });
  } catch (error) {
    console.error('Errore durante la preparazione del checkout LemonSqueezy:', error);
    return sendJson(res, 503, { error: error instanceof Error ? error.message : 'Checkout non disponibile.' });
  }
};
