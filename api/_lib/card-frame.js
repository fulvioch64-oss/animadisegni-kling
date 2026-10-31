const path = require('node:path');
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

const CHRISTMAS_RED = [190, 30, 45];
const CHRISTMAS_GREEN = [38, 112, 62];
const CHRISTMAS_GOLD = [226, 168, 36];
const SNOW_BLUE = [120, 170, 205];

// `text` colors the message, `ring` the keyline around the artwork window.
const THEME_COLORS = {
  classic: { text: CARD_TEXT_COLOR, ring: CARD_TEXT_COLOR },
  christmas: { text: [183, 28, 28], ring: CHRISTMAS_RED }
};

const themeColors = (theme) => THEME_COLORS[theme] || THEME_COLORS.classic;
const themeTextColor = (theme) => themeColors(theme).text;

function decorPalette(theme) {
  return theme === 'christmas'
    ? { festive: [CHRISTMAS_RED, CHRISTMAS_GOLD, CHRISTMAS_GREEN], dark: CHRISTMAS_GREEN }
    : { festive: FESTIVE_COLORS, dark: CARD_TEXT_COLOR };
}

function snowflakeSvg(cx, cy, radius, color) {
  const arms = [0, 60, 120].map((angle) => {
    const a = (angle * Math.PI) / 180;
    const dx = Math.cos(a) * radius;
    const dy = Math.sin(a) * radius;
    const bx = Math.cos(a) * radius * 0.62;
    const by = Math.sin(a) * radius * 0.62;
    const px = -Math.sin(a) * radius * 0.28;
    const py = Math.cos(a) * radius * 0.28;
    const branch = (sign) => `M${(cx + sign * bx).toFixed(1)} ${(cy + sign * by).toFixed(1)} l${(sign * radius * 0.2 * Math.cos(a) + px).toFixed(1)} ${(sign * radius * 0.2 * Math.sin(a) + py).toFixed(1)} `
      + `M${(cx + sign * bx).toFixed(1)} ${(cy + sign * by).toFixed(1)} l${(sign * radius * 0.2 * Math.cos(a) - px).toFixed(1)} ${(sign * radius * 0.2 * Math.sin(a) - py).toFixed(1)}`;
    return `M${(cx - dx).toFixed(1)} ${(cy - dy).toFixed(1)} L${(cx + dx).toFixed(1)} ${(cy + dy).toFixed(1)} ${branch(1)} ${branch(-1)}`;
  });
  return `<path d="${arms.join(' ')}" fill="none" stroke="${rgb(color)}" stroke-width="${Math.max(2, radius * 0.09).toFixed(1)}" stroke-linecap="round"/>`;
}

function baubleSvg(cx, cy, radius, color) {
  return `<path d="M${cx} ${cy - radius - 60} V${cy - radius}" stroke="#9a8f86" stroke-width="2.5" stroke-linecap="round"/>`
    + `<rect x="${cx - radius * 0.28}" y="${cy - radius - 8}" width="${radius * 0.56}" height="10" rx="2" fill="${rgb(CHRISTMAS_GOLD)}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${rgb(color)}"/>`
    + `<path d="M${cx - radius * 0.85} ${cy + radius * 0.1} Q${cx} ${cy - radius * 0.45} ${cx + radius * 0.85} ${cy + radius * 0.1}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="3"/>`
    + `<circle cx="${cx - radius * 0.38}" cy="${cy - radius * 0.4}" r="${radius * 0.16}" fill="#fff" fill-opacity="0.5"/>`;
}

function miniTreeSvg(cx, cy, size) {
  const tier = (top, half) => `<path d="M${cx} ${cy + top} L${cx + half} ${cy + top + size * 0.5} L${cx - half} ${cy + top + size * 0.5} Z" fill="${rgb(CHRISTMAS_GREEN)}" stroke="${rgb(CHRISTMAS_GREEN)}" stroke-width="3" stroke-linejoin="round"/>`;
  return tier(-size, size * 0.42) + tier(-size * 0.68, size * 0.56) + tier(-size * 0.36, size * 0.7)
    + `<rect x="${cx - size * 0.08}" y="${cy + size * 0.14}" width="${size * 0.16}" height="${size * 0.2}" fill="#7a4a2a"/>`
    + `<path d="${starPath(cx, cy - size - 6, size * 0.24)}" fill="${rgb(CHRISTMAS_GOLD)}" stroke="${rgb(CHRISTMAS_GOLD)}" stroke-width="2" stroke-linejoin="round"/>`
    + [[-0.12, -0.55], [0.18, -0.3], [-0.3, -0.02], [0.3, 0.02]].map(([dx, dy], i) => `<circle cx="${(cx + dx * size).toFixed(1)}" cy="${(cy + dy * size).toFixed(1)}" r="${(size * 0.06).toFixed(1)}" fill="${rgb(i % 2 ? CHRISTMAS_GOLD : CHRISTMAS_RED)}"/>`).join('');
}

// Pine garland swag with baubles and stars, replacing the bunting.
function garlandSvg(layout) {
  const { width } = layout;
  const startX = 46;
  const endX = width - 46;
  const y0 = 46;
  const sag = 34;
  const pointAt = (t) => ({ x: startX + t * (endX - startX), y: y0 + 4 * sag * t * (1 - t) });
  const sprigs = [];
  const count = Math.round(width / 24);
  for (let i = 0; i < count; i += 1) {
    const { x, y } = pointAt((i + 0.5) / count);
    const side = i % 2 === 0 ? 1 : -1;
    const length = 26 + (i % 3) * 5;
    sprigs.push(`<ellipse cx="${(x + side * 6).toFixed(1)}" cy="${(y + length * 0.55).toFixed(1)}" rx="6.5" ry="${length}" fill="${rgb(i % 4 === 0 ? [58, 140, 80] : CHRISTMAS_GREEN)}" transform="rotate(${side * 28} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
  }
  const ornaments = [];
  const ornamentCount = 9;
  for (let i = 0; i < ornamentCount; i += 1) {
    const { x, y } = pointAt((i + 0.5) / ornamentCount);
    if (i % 3 === 1) {
      ornaments.push(`<path d="${starPath(x, y + 34, 20)}" fill="${rgb(CHRISTMAS_GOLD)}" stroke="${rgb(CHRISTMAS_GOLD)}" stroke-width="2" stroke-linejoin="round"/>`);
    } else {
      const color = i % 3 === 0 ? CHRISTMAS_RED : CHRISTMAS_GOLD;
      ornaments.push(`<circle cx="${x.toFixed(1)}" cy="${(y + 38).toFixed(1)}" r="15" fill="${rgb(color)}"/>`
        + `<circle cx="${(x - 5).toFixed(1)}" cy="${(y + 32).toFixed(1)}" r="4" fill="#fff" fill-opacity="0.5"/>`);
    }
  }
  return `<path d="M${startX} ${y0} Q${width / 2} ${y0 + 2 * sag} ${endX} ${y0}" fill="none" stroke="${rgb(CHRISTMAS_GREEN)}" stroke-width="10" stroke-linecap="round"/>${sprigs.join('')}${ornaments.join('')}`;
}

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

function decorationsSvg(layout, palette, theme) {
  const { width, height, window: win } = layout;
  const random = createRandom(1970);
  const blocked = [];
  const parts = [];
  const colors = palette.festive;
  const christmas = theme === 'christmas';

  // Side ornaments (balloons, or snowflakes/tree decorations for Christmas), only when the artwork leaves enough room.
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
        if (christmas) {
          const index = shade * 2 + (side === 'left' ? 0 : 1);
          if (index % 2 === 0) {
            parts.push(snowflakeSvg(Math.round(centerX), Math.round(cy), Math.round(radius * 1.1), SNOW_BLUE));
            blocked.push([centerX - radius * 1.2, cy - radius * 1.2, centerX + radius * 1.2, cy + radius * 1.2]);
          } else if (index === 1) {
            parts.push(baubleSvg(Math.round(centerX), Math.round(cy), Math.round(radius * 0.8), color));
            blocked.push([centerX - radius, cy - radius - 70, centerX + radius, cy + radius]);
          } else {
            parts.push(miniTreeSvg(Math.round(centerX), Math.round(cy), Math.round(radius * 1.7)));
            blocked.push([centerX - radius, cy - radius * 2.3, centerX + radius, cy + radius * 0.6]);
          }
          return;
        }
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
    if (christmas) {
      if (kind < 0.45) parts.push(snowflakeSvg(x, y, size * 1.3, SNOW_BLUE));
      else if (kind < 0.75) parts.push(`<path d="${starPath(x, y, size * 1.2)}" fill="${rgb(CHRISTMAS_GOLD)}" stroke="${rgb(CHRISTMAS_GOLD)}" stroke-width="2" stroke-linejoin="round"/>`);
      else parts.push(`<circle cx="${cx}" cy="${cy}" r="${(size * 0.45).toFixed(1)}" fill="${color}"/>`);
      continue;
    }
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

function frameSvg(layout, messageSvg = '', theme = 'classic') {
  const { width, height, window: win } = layout;
  const palette = decorPalette(theme);
  const ringColor = themeColors(theme).ring;
  const ring = (grow, radius, stroke) => `<rect x="${win.x - grow}" y="${win.y - grow}" width="${win.width + grow * 2}" height="${win.height + grow * 2}" rx="${radius}" fill="none" stroke="${rgb(ringColor)}" stroke-width="${stroke}"/>`;
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
    + decorationsSvg(layout, palette, theme)
    + (theme === 'christmas' ? garlandSvg(layout) : buntingSvg(layout, palette))
    + messageSvg
    + ring(RING_GAP, 18, 3.5)
    + ring(RING_GAP + 10, 26, 1.6)
    + '</svg>';
}

const CHRISTMAS_FRAME_FILE = path.join(__dirname, '..', '..', 'public', 'sfondi', 'christmas-frame.png');
const christmasTemplates = new Map();

// Fixed, global geometry for the Christmas video window: it fills the cream area of the template between the garland
// and the message area, so the template needs no extra keyline. Returns the PNG plus the window box.
const CHRISTMAS_WINDOW = { x: 0.148, width: 0.705, top: 0.268, height: 0.532 };
function christmasTemplate(width, height) {
  const key = `${width}x${height}`;
  if (!christmasTemplates.has(key)) {
    const promise = (async () => {
      const box = {
        x: Math.round(width * CHRISTMAS_WINDOW.x),
        width: Math.round(width * CHRISTMAS_WINDOW.width),
        y: Math.round(height * CHRISTMAS_WINDOW.top),
        height: Math.round(height * CHRISTMAS_WINDOW.height)
      };
      const base = await sharp(CHRISTMAS_FRAME_FILE).resize(width, height, { fit: 'fill' }).ensureAlpha().png().toBuffer();
      const hole = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"/></svg>`;
      const png = await sharp(base)
        .composite([{ input: Buffer.from(hole), blend: 'dest-out' }])
        .png()
        .toBuffer();
      return { png, window: box };
    })();
    promise.catch(() => christmasTemplates.delete(key));
    christmasTemplates.set(key, promise);
  }
  return christmasTemplates.get(key);
}
async function buildFrameImage(layout, messageSvg = '', theme = 'classic') {
  const { width, height, window: win } = layout;
  if (layout.template) {
    return sharp(layout.template.png)
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${messageSvg}</svg>`) }])
      .png()
      .toBuffer();
  }
  const hole = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${win.x}" y="${win.y}" width="${win.width}" height="${win.height}"/></svg>`;
  return sharp(Buffer.from(frameSvg(layout, messageSvg, theme)))
    .ensureAlpha()
    .composite([{ input: Buffer.from(hole), blend: 'dest-out' }])
    .png()
    .toBuffer();
}

module.exports = { buildFrameImage, christmasTemplate, PAPER_COLOR, CARD_TEXT_COLOR, themeTextColor };
