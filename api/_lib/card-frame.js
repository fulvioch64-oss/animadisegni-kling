const sharp = require('sharp');

// The artwork window is transparent so the FFmpeg video underneath shows through it.
const PAPER_COLOR = [255, 253, 250];
const CARD_TEXT_COLOR = [200, 50, 108];
const FRAME_COLOR = [244, 224, 221];
const RING_GAP = 6;

const rgb = (color) => `rgb(${color.join(',')})`;

function frameSvg(layout, messageSvg = '') {
  const { width, height, window: win } = layout;
  const ring = `<rect x="${win.x - RING_GAP}" y="${win.y - RING_GAP}" width="${win.width + RING_GAP * 2}" height="${win.height + RING_GAP * 2}" rx="12" fill="none" stroke="${rgb(FRAME_COLOR)}" stroke-width="2"/>`;
  const messageBand = layout.lines.length
    ? `<rect x="0" y="${layout.bannerTop}" width="${width}" height="${height - layout.bannerTop}" fill="rgb(255,248,248)"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" fill="${rgb(PAPER_COLOR)}"/>`
    + messageBand
    + messageSvg
    + ring
    + '</svg>';
}

async function buildFrameImage(layout, messageSvg = '') {
  const { width, height, window: win } = layout;
  const hole = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${win.x}" y="${win.y}" width="${win.width}" height="${win.height}"/></svg>`;
  return sharp(Buffer.from(frameSvg(layout, messageSvg)))
    .ensureAlpha()
    .composite([{ input: Buffer.from(hole), blend: 'dest-out' }])
    .png()
    .toBuffer();
}

module.exports = { buildFrameImage, PAPER_COLOR, FRAME_COLOR, CARD_TEXT_COLOR };
