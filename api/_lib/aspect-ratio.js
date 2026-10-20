// Supported output formats. To add one, add an entry here and an option in public/index.html.
const ASPECT_RATIOS = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
};
const DEFAULT_ASPECT_RATIO = '9:16';

function normalizeAspectRatio(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_ASPECT_RATIO;
  if (typeof value !== 'string' || !Object.hasOwn(ASPECT_RATIOS, value.trim())) {
    const error = new Error(`aspectRatio must be one of: ${Object.keys(ASPECT_RATIOS).join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

// FFmpeg filter that fits the frame inside the target size, padding with white (no cropping of the drawing).
function fitFilter(aspectRatio) {
  const { width, height } = ASPECT_RATIOS[normalizeAspectRatio(aspectRatio)];
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`;
}

module.exports = { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO, normalizeAspectRatio, fitFilter };
