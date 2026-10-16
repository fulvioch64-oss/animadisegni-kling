const { generateVideoFromImage } = require('./_lib/fal-video.js');

const SAMPLE_IMAGE_URL = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
  }
  try {
    const videoUrl = await generateVideoFromImage(SAMPLE_IMAGE_URL);
    return res.status(200).end(JSON.stringify({ success: true, videoUrl }));
  } catch (error) {
    console.error('Errore test-fal:', error);
    return res.status(500).end(JSON.stringify({ success: false, error: error?.message || 'Generation failed.' }));
  }
};
