const { fal } = require('@fal-ai/client');

const MODEL_ID = 'fal-ai/kling-video/v1.5/pro/image-to-video';
const DEFAULT_PROMPT = 'A character dancing reggaeton, smooth movement';

const STYLE_LABELS = {
  reggaeton: 'reggaeton',
  'hip-hop': 'hip-hop',
  hiphop: 'hip-hop',
  salsa: 'salsa',
  ballet: 'ballet'
};

// Accepts a known style/motionPreset ID and returns a full prompt; any other
// non-empty string is treated as an already complete custom prompt.
function buildPrompt(promptStyle) {
  const value = typeof promptStyle === 'string' ? promptStyle.trim() : '';
  if (!value) return DEFAULT_PROMPT;
  const style = STYLE_LABELS[value.toLowerCase()];
  if (!style) return value;
  return `A character dancing ${style}, dynamic body movement, full body shot`;
}

async function generateVideoFromImage(imageUrl, promptStyle) {
  try {
    fal.config({ credentials: process.env.FAL_KEY });
    const input = {
      image_url: imageUrl,
      prompt: buildPrompt(promptStyle),
      aspect_ratio: '9:16',
      duration: '5',
    };
    console.info(`[fal-video] Calling ${MODEL_ID} with payload:`, JSON.stringify({ input }));
    const result = await fal.subscribe(MODEL_ID, { input, logs: true });

    return result.data.video.url;
  } catch (error) {
    console.error('[fal-video] generateVideoFromImage failed:', error?.status, JSON.stringify(error?.body ?? error?.message));
    throw error;
  }
}

module.exports = { generateVideoFromImage };
