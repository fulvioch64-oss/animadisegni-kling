const sharp = require('sharp');

// Printed-card look: full-bleed watercolor-paper background, a single thin keyline around the artwork window,
// a small bunting at the top and a clear band at the bottom reserved for the message. The artwork window is cut out
// (transparent) so the FFmpeg video underneath shows through it.
const PAPER_COLOR = [251, 246, 234];
const CARD_TEXT_COLOR = [200, 50, 108];
const RING_GAP = 10;

const rgb = (color) => `rgb(${color.join(',')})`;

const FESTIVE_COLORS = [[229, 57, 53], [253, 192, 40], [67, 160, 71], [30, 136, 229], [236, 100, 160], [251, 140, 0]];

function buntingSvg(layout) {
  const { width } = layout;
  const startX = 46;
  const endX = width - 46;
  const y0 = 30;
  const sag = 20;
  const count = Math.round(width / 56);
  const flags = Array.from({ length: count }, (_, i) => {
    const t = (i + 0.5) / count;
    const x = startX + t * (endX - startX);
    const y = y0 + 4 * sag * t * (1 - t);
    const angle = (Math.atan((4 * sag * (1 - 2 * t)) / (endX - startX)) * 180) / Math.PI;
    const color = rgb(FESTIVE_COLORS[i % FESTIVE_COLORS.length]);
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})">`
      + `<path d="M-18 0 L18 0 L0 44 Z" fill="${color}" stroke="${color}" stroke-width="4" stroke-linejoin="round"/></g>`;
  });
  return `<path d="M${startX} ${y0} Q${width / 2} ${y0 + 2 * sag} ${endX} ${y0}" fill="none" stroke="${rgb(CARD_TEXT_COLOR)}" stroke-width="3" stroke-linecap="round"/>${flags.join('')}`;
}

function frameSvg(layout, messageSvg = '') {
  const { width, height, window: win } = layout;
  const ring = (grow, radius, stroke) => `<rect x="${win.x - grow}" y="${win.y - grow}" width="${win.width + grow * 2}" height="${win.height + grow * 2}" rx="${radius}" fill="none" stroke="${rgb(CARD_TEXT_COLOR)}" stroke-width="${stroke}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + '<defs>'
    + '<filter id="wash" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="3" seed="11"/>'
    + '<feColorMatrix type="matrix" values="0 0 0 0 0.82 0 0 0 0 0.72 0 0 0 0 0.55 0.5 0 0 0 -0.12"/></filter>'
    + '<filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="5"/>'
    + '<feColorMatrix type="matrix" values="0 0 0 0 0.45 0 0 0 0 0.35 0 0 0 0 0.25 0.55 0 0 0 -0.2"/></filter>'
    + '</defs>'
    + `<rect width="${width}" height="${height}" fill="${rgb(PAPER_COLOR)}"/>`
    + `<rect width="${width}" height="${height}" filter="url(#wash)"/>`
    + `<rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.55"/>`
    + buntingSvg(layout)
    + messageSvg
    + ring(RING_GAP, 18, 3.5)
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

module.exports = { buildFrameImage, PAPER_COLOR, CARD_TEXT_COLOR };
