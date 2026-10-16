const { getVideo } = require('./_lib/store.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Metodo non consentito.' }));
  }
  const token = req.query?.id;
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) {
    return res.status(400).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Identificativo della richiesta non valido.' }));
  }
  try {
    const video = await getVideo(token);
    if (!video) return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato o scaduto.' }));
    const simulationAvailable = process.env.NODE_ENV !== 'production' && process.env.LOCAL_PAYMENT_SIMULATION !== 'false';
    return res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({
      paid: video.paid === true,
      simulationAvailable
    }));
  } catch (error) {
    console.error('Errore durante la verifica dello stato del pagamento:', error);
    return res.status(503).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Impossibile verificare il pagamento in questo momento.' }));
  }
};
