const { getVideo } = require('./_lib/store.js');
const sendVideoFile = require('./_lib/send-video-file.js');

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
    if (!video?.videoUrl) return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato o scaduto.' }));
    if (video.paid !== true) return res.status(402).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Pagamento non ancora verificato da LemonSqueezy.' }));
    const remoteUrl = video.downloadRemoteUrl || video.previewRemoteUrl;
    if (remoteUrl && /^https:\/\//.test(remoteUrl)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Location', remoteUrl);
      return res.status(302).end();
    }
    if (video.downloadVideoPath) return await sendVideoFile(req, res, video.downloadVideoPath, true);
    if (video.generatedVideoPath) return await sendVideoFile(req, res, video.generatedVideoPath, true);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', video.videoUrl);
    return res.status(302).end();
  } catch (error) {
    console.error('Errore durante il download del video:', error);
    return res.status(503).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Download temporaneamente non disponibile.' }));
  }
};
