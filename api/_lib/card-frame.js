const sharp = require('sharp');

// Printed-card look: full-bleed watercolor-paper background, double rounded keyline around the artwork window
// and multicolor festive decorations. The artwork window is cut out (transparent)
// so the FFmpeg video underneath shows through it.
const PAPER_COLOR = [251, 246, 234];
const CARD_TEXT_COLOR = [200, 50, 108];
const EDGE_MARGIN = 26;
const RING_GAP = 12;

const rgb = (color) => `rgb(${color.join(',')})`;

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FESTIVE_COLORS = [[229, 57, 53], [253, 192, 40], [67, 160, 71], [30, 136, 229], [236, 100, 160], [251, 140, 0]];

const PALETTE = { festive: FESTIVE_COLORS, dark: CARD_TEXT_COLOR };

function buntingSvg(layout, palette) {
  const { width } = layout;
  const startX = 46;
  const endX = width - 46;
  const y0 = 46;
  const sag = 34;
  const count = Math.round(width / 84);
  const colors = palette.festive;
  const flags = Array.from({ length: count }, (_, i) => {
    const t = (i + 0.5) / count;
    const x = startX + t * (endX - startX);
    const y = y0 + 4 * sag * t * (1 - t);
    const angle = (Math.atan((4 * sag * (1 - 2 * t)) / (endX - startX)) * 180) / Math.PI;
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})">`
      + `<path d="M-29 0 L29 0 L0 70 Z" fill="${rgb(colors[i % colors.length])}" stroke="${rgb(colors[i % colors.length])}" stroke-width="4" stroke-linejoin="round"/></g>`;
  });
  return `<path d="M${startX} ${y0} Q${width / 2} ${y0 + 2 * sag} ${endX} ${y0}" fill="none" stroke="${rgb(palette.dark)}" stroke-width="3" stroke-linecap="round"/>${flags.join('')}`;
}

function balloonSvg(cx, cy, rx, color) {
  const ry = rx * 1.25;
  return `<path d="M${cx} ${cy + ry + 6} q14 30 0 58 t0 58" fill="none" stroke="#9a8f86" stroke-width="2.5" stroke-linecap="round"/>`
    + `<path d="M${cx - 7} ${cy + ry + 13} L${cx} ${cy + ry - 2} L${cx + 7} ${cy + ry + 13} Z" fill="${rgb(color)}"/>`
    + `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${rgb(color)}"/>`
    + `<ellipse cx="${cx - rx * 0.38}" cy="${cy - ry * 0.4}" rx="${rx * 0.2}" ry="${ry * 0.3}" fill="#fff" fill-opacity="0.45" transform="rotate(-20 ${cx - rx * 0.38} ${cy - ry * 0.4})"/>`;
}

function heartPath(cx, cy, s) {
  return `M${cx} ${cy + s * 0.9} C${cx - s * 1.3} ${cy - s * 0.1} ${cx - s * 0.5} ${cy - s * 0.95} ${cx} ${cy - s * 0.35} `
    + `C${cx + s * 0.5} ${cy - s * 0.95} ${cx + s * 1.3} ${cy - s * 0.1} ${cx} ${cy + s * 0.9} Z`;
}

function starPath(cx, cy, radius) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  });
  return `M${points.join(' L')} Z`;
}

function decorationsSvg(layout) {
  const { width, height, window: win } = layout;
  const random = createRandom(1970);
  const blocked = [];
  const parts = [];
  const colors = PALETTE.festive;

  // Side balloons, only when the artwork leaves enough room.
  const sideSpace = win.x - EDGE_MARGIN;
  const radius = Math.min(40, (sideSpace - 50) / 2);
  if (radius >= 22) {
    [[0.22, 0], [0.6, 1]].forEach(([position, shade]) => {
      const cy = win.y + win.height * position;
      [['left', 0], ['right', 2]].forEach(([side, shift]) => {
        const slack = Math.max(0, sideSpace / 2 - radius - 20);
        const jitter = (random() * 2 - 1) * slack;
        const centerX = side === 'left' ? EDGE_MARGIN + sideSpace / 2 + jitter : width - EDGE_MARGIN - sideSpace / 2 + jitter;
        const color = colors[(shade * 3 + shift + (side === 'left' ? 0 : 1)) % colors.length];
        parts.push(balloonSvg(Math.round(centerX), Math.round(cy), Math.round(radius), color));
        blocked.push([centerX - radius, cy - radius * 1.25, centerX + radius, cy + radius * 1.25 + 130]);
      });
    });
  }

  blocked.push([win.x - 44, win.y - 44, win.x + win.width + 44, win.y + win.height + 44]);
  if (layout.lines.length) blocked.push([36, layout.bannerTop - 56, width - 36, layout.bannerTop + layout.bannerHeight + 56]);

  const placed = [];
  for (let attempt = 0; attempt < 260 && placed.length < 48; attempt += 1) {
    const x = EDGE_MARGIN + 20 + random() * (width - 2 * (EDGE_MARGIN + 20));
    const y = layout.topZone + 12 + random() * (height - layout.topZone - EDGE_MARGIN - 32);
    const size = 7 + random() * 8;
    const free = blocked.every(([x0, y0, x1, y1]) => x < x0 - size || x > x1 + size || y < y0 - size || y > y1 + size)
      && placed.every(([px, py]) => Math.hypot(px - x, py - y) > 40);
    if (!free) continue;
    placed.push([x, y]);
    const color = rgb(colors[Math.floor(random() * colors.length)]);
    const kind = random();
    const cx = x.toFixed(1);
    const cy = y.toFixed(1);
    if (kind < 0.35) {
      parts.push(`<rect x="${(x - size).toFixed(1)}" y="${(y - size / 3).toFixed(1)}" width="${(size * 2).toFixed(1)}" height="${(size * 0.65).toFixed(1)}" rx="2" fill="${color}" transform="rotate(${Math.round(random() * 180)} ${cx} ${cy})"/>`);
    } else if (kind < 0.55) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${(size * 0.5).toFixed(1)}" fill="${color}"/>`);
    } else if (kind < 0.8) {
      parts.push(`<path d="${starPath(x, y, size * 1.2)}" fill="${color}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
    } else {
      parts.push(`<path d="${heartPath(x, y, size * 1.1)}" fill="${color}"/>`);
    }
  }
  return parts.join('');
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
    + decorationsSvg(layout)
    + buntingSvg(layout, PALETTE)
    + messageSvg
    + ring(RING_GAP, 18, 3.5)
    + ring(RING_GAP + 10, 26, 1.6)
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
