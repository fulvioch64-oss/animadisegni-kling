const { getVideo } = require('./_lib/store.js');
const sendVideoFile = require('./_lib/send-video-file.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Metodo non consentito.' }));
  }
  const token = req.query?.id;
  if (typeof token !== 'string' || !/^[\da-f-]{36}$/i.test(token)) {
    return res.status(400).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Identificativo della richiesta non valido.' }));
  }
  try {
    const video = await getVideo(token);
    if (video?.previewRemoteUrl && /^https:\/\//.test(video.previewRemoteUrl)) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Location', video.previewRemoteUrl);
      return res.status(302).end();
    }
    if (!video?.generatedVideoPath) {
      return res.status(404).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Video non trovato o non ancora pronto.' }));
    }
    return await sendVideoFile(req, res, video.generatedVideoPath);
  } catch (error) {
    console.error('Errore durante la riproduzione dell’anteprima:', error);
    return res.status(503).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify({ error: 'Anteprima temporaneamente non disponibile.' }));
  }
};
