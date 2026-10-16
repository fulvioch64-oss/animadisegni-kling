const { getVideo, saveVideo } = require('./_lib/store.js');

module.exports = async function handler(req, res) {
  const enabled = process.env.NODE_ENV !== 'production' && process.env.LOCAL_PAYMENT_SIMULATION !== 'false';
  if (!enabled) return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Endpoint non disponibile.' }));
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Metodo non consentito.' }));
  }
  const token = req.body?.generationToken;
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) {
    return res.status(400).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Identificativo della richiesta non valido.' }));
  }
  try {
    const video = await getVideo(token);
    if (!video?.videoUrl) return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato o non ancora pronto.' }));
    await saveVideo(token, { paid: true });
    return res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ paid: true }));
  } catch (error) {
    console.error('Errore durante la simulazione locale del pagamento:', error);
    return res.status(503).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Simulazione di pagamento non disponibile.' }));
  }
};
