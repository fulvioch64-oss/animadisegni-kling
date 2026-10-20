const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FONT_DIRECTORY = path.join(__dirname, 'fonts');
const MAX_MESSAGE_LENGTH = 60;

// Greeting-card fonts. To add one: put the TTF in api/_lib/fonts, add an entry here, a Google Fonts family in
// public/index.html, the CSS family in public/app.js and a label in the locales.
// `width` is the approximate glyph width / font size ratio, `scale` evens out the optical size between fonts.
const CARD_FONTS = {
  playful: { file: 'Fredoka.ttf', width: 0.56, scale: 1 },
  handwritten: { file: 'Caveat.ttf', width: 0.42, scale: 1.3 },
  party: { file: 'Baloo2.ttf', width: 0.55, scale: 1 },
  cute: { file: 'PatrickHand.ttf', width: 0.46, scale: 1.2 }
};
const DEFAULT_FONT = 'playful';

// Card frames. `border`/`inner` are the frame colors, `text` is the message color.
const CARD_TEMPLATES = {
  classic: { border: [255, 94, 126], inner: [255, 196, 87], text: [59, 47, 74] },
  balloons: { border: [66, 153, 225], inner: [255, 255, 255], text: [43, 108, 176] },
  stars: { border: [198, 45, 66], inner: [47, 143, 91], text: [158, 28, 48] },
  hearts: { border: [255, 127, 168], inner: [255, 255, 255], text: [200, 50, 108] }
};
const DEFAULT_TEMPLATE = 'classic';

function cardError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Returns a sanitized card or null when the user did not customize anything.
function normalizeCard(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw cardError('card must be an object.');
  const message = typeof raw.message === 'string'
    ? raw.message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (message.length > MAX_MESSAGE_LENGTH) throw cardError(`card.message can have at most ${MAX_MESSAGE_LENGTH} characters.`);
  const font = raw.font === undefined || raw.font === '' ? DEFAULT_FONT : raw.font;
  if (typeof font !== 'string' || !Object.hasOwn(CARD_FONTS, font)) {
    throw cardError(`card.font must be one of: ${Object.keys(CARD_FONTS).join(', ')}.`);
  }
  const template = raw.template === undefined || raw.template === '' ? DEFAULT_TEMPLATE : raw.template;
  if (typeof template !== 'string' || !Object.hasOwn(CARD_TEMPLATES, template)) {
    throw cardError(`card.template must be one of: ${Object.keys(CARD_TEMPLATES).join(', ')}.`);
  }
  if (!message && template === DEFAULT_TEMPLATE) return null;
  return { message, font, template };
}

function wrapMessage(message, maxChars) {
  const lines = [];
  let current = '';
  for (const word of message.split(' ')) {
    if (current && `${current} ${word}`.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Geometry shared by the frame image and the FFmpeg filters.
function layoutCard(card, { width, height }) {
  const font = CARD_FONTS[card.font];
  const lines = card.message ? wrapMessage(card.message, 20) : [];
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const fontSize = lines.length
    ? Math.round(Math.min(96 * font.scale, (width - 220) / (longest * font.width)))
    : 0;
  const lineHeight = Math.round(fontSize * 1.18);
  const bannerHeight = lines.length ? lines.length * lineHeight + 70 : 0;
  const bannerBottomMargin = 64;
  const areaHeight = lines.length ? height - bannerHeight - bannerBottomMargin - 26 : height;
  return {
    width, height, lines, fontSize, lineHeight, bannerHeight, areaHeight,
    bannerTop: height - bannerBottomMargin - bannerHeight
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  blend(x, y, color, coverage) {
    const alpha = (color[3] === undefined ? 255 : color[3]) / 255 * coverage;
    if (alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const dstA = d[i + 3] / 255;
    const outA = alpha + dstA * (1 - alpha);
    for (let c = 0; c < 3; c += 1) {
      d[i + c] = Math.round((color[c] * alpha + d[i + c] * dstA * (1 - alpha)) / outA);
    }
    d[i + 3] = Math.round(outA * 255);
  }

  // Fills every pixel where inside(x, y) is true, using 3x3 supersampling for smooth edges.
  fill(bounds, inside, color) {
    const x0 = Math.max(0, Math.floor(bounds[0]));
    const y0 = Math.max(0, Math.floor(bounds[1]));
    const x1 = Math.min(this.width - 1, Math.ceil(bounds[2]));
    const y1 = Math.min(this.height - 1, Math.ceil(bounds[3]));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        let hits = 0;
        for (let sy = 0; sy < 3; sy += 1) {
          for (let sx = 0; sx < 3; sx += 1) {
            if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits += 1;
          }
        }
        if (hits) this.blend(x, y, color, hits / 9);
      }
    }
  }

  rect(x, y, w, h, color) {
    for (let py = Math.max(0, y); py < Math.min(this.height, y + h); py += 1) {
      for (let px = Math.max(0, x); px < Math.min(this.width, x + w); px += 1) this.blend(px, py, color, 1);
    }
  }

  ellipse(cx, cy, rx, ry, color) {
    this.fill([cx - rx, cy - ry, cx + rx, cy + ry], (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, color);
  }

  polygon(points, color) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    this.fill([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], (x, y) => {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, color);
  }

  roundRect(x, y, w, h, radius, color) {
    this.fill([x, y, x + w, y + h], (px, py) => {
      const dx = Math.max(x + radius - px, 0, px - (x + w - radius));
      const dy = Math.max(y + radius - py, 0, py - (y + h - radius));
      return dx * dx + dy * dy <= radius * radius;
    }, color);
  }

  line(x0, y0, x1, y1, thickness, color) {
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = (-(y1 - y0) / length) * (thickness / 2);
    const ny = ((x1 - x0) / length) * (thickness / 2);
    this.polygon([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], color);
  }

  frame(inset, thickness, color, radius) {
    const w = this.width - inset * 2;
    const h = this.height - inset * 2;
    this.fill([inset, inset, inset + w, inset + h], (x, y) => {
      const outer = inside(x, y, inset, w, h, radius);
      const innerInset = inset + thickness;
      return outer && !inside(x, y, innerInset, this.width - innerInset * 2, this.height - innerInset * 2, Math.max(0, radius - thickness));
    }, color);
  }
}

function inside(x, y, inset, w, h, radius) {
  const dx = Math.max(inset + radius - x, 0, x - (inset + w - radius));
  const dy = Math.max(inset + radius - y, 0, y - (inset + h - radius));
  return x >= inset && y >= inset && x <= inset + w && y <= inset + h && dx * dx + dy * dy <= radius * radius;
}

function star(cx, cy, outer, rotation = -Math.PI / 2) {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outer : outer * 0.45;
    const angle = rotation + (i * Math.PI) / 5;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
}

function heart(cx, cy, size) {
  const points = [];
  for (let i = 0; i < 60; i += 1) {
    const t = (i / 60) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    points.push([cx + (x / 17) * size, cy - (y / 17) * size]);
  }
  return points;
}

function balloon(canvas, cx, cy, size, color) {
  const rx = size * 0.8;
  const ry = size;
  canvas.line(cx, cy + ry, cx - size * 0.15, cy + ry + size * 1.9, 4, [90, 90, 110, 200]);
  canvas.polygon([[cx, cy + ry - 2], [cx - size * 0.16, cy + ry + size * 0.2], [cx + size * 0.16, cy + ry + size * 0.2]], color);
  canvas.ellipse(cx, cy, rx, ry, color);
  canvas.ellipse(cx - rx * 0.35, cy - ry * 0.4, rx * 0.16, ry * 0.26, [255, 255, 255, 120]);
}

function decorate(canvas, templateName, W, H) {
  const m = Math.min(W, H) / 1080;
  if (templateName === 'balloons') {
    const colors = [[255, 94, 126], [255, 196, 87], [66, 153, 225], [92, 200, 130]];
    const spots = [[120, 150, 62, 0], [215, 112, 54, 1], [305, 168, 58, 2], [W / m - 120, 150, 62, 3], [W / m - 215, 112, 54, 0], [W / m - 305, 168, 58, 1]];
    spots.forEach(([x, y, s, c]) => balloon(canvas, x * m, y * m, s * m, colors[c]));
    [[0.2, 0.34], [0.8, 0.3], [0.06, 0.5], [0.94, 0.55], [0.1, 0.72], [0.9, 0.78]].forEach(([fx, fy], i) => {
      canvas.ellipse(W * fx, H * fy, 9 * m, 9 * m, colors[i % colors.length]);
    });
  } else if (templateName === 'stars') {
    const gold = [255, 200, 60];
    [[110, 120, 62], [W / m - 110, 120, 62], [230, 80, 34], [W / m - 230, 80, 34]].forEach(([x, y, s]) => {
      canvas.polygon(star(x * m, y * m, s * m), gold);
    });
    [[0.07, 0.42, 26], [0.93, 0.38, 26], [0.06, 0.62, 18], [0.94, 0.6, 18]].forEach(([fx, fy, s]) => {
      canvas.polygon(star(W * fx, H * fy, s * m), [255, 255, 255]);
    });
  } else if (templateName === 'hearts') {
    const pinks = [[255, 94, 126], [255, 160, 190], [220, 60, 110]];
    [[110, 120, 64, 0], [215, 82, 38, 1], [W / m - 110, 120, 64, 2], [W / m - 215, 82, 38, 0]].forEach(([x, y, s, c]) => {
      canvas.polygon(heart(x * m, y * m, s * m), pinks[c]);
    });
    [[0.07, 0.4, 24], [0.93, 0.45, 24], [0.06, 0.62, 16], [0.94, 0.66, 16]].forEach(([fx, fy, s], i) => {
      canvas.polygon(heart(W * fx, H * fy, s * m), pinks[i % pinks.length]);
    });
  } else {
    [[70, 70], [W / m - 70, 70]].forEach(([x, y]) => canvas.ellipse(x * m, y * m, 15 * m, 15 * m, [255, 196, 87]));
  }
}

function buildFrameImage(card, layout) {
  const { width: W, height: H } = layout;
  const theme = CARD_TEMPLATES[card.template];
  const canvas = new Canvas(W, H);
  canvas.frame(0, 26, [...theme.border, 255], 0);
  canvas.frame(36, 6, [...theme.inner, 255], 28);
  decorate(canvas, card.template, W, H);
  if (layout.lines.length) {
    const x = 60;
    const w = W - 120;
    canvas.roundRect(x - 6, layout.bannerTop - 6, w + 12, layout.bannerHeight + 12, 40, [...theme.border, 255]);
    canvas.roundRect(x, layout.bannerTop, w, layout.bannerHeight, 34, [255, 255, 255, 245]);
  }
  return encodePng(canvas.data, W, H);
}

// Writes the frame PNG, font and text lines into `directory` and returns FFmpeg filters that burn the card in.
// File names are relative: FFmpeg must run with `directory` as its working directory, which avoids escaping
// Windows drive letters inside filter arguments.
async function prepareCardAssets(card, size, directory) {
  const layout = layoutCard(card, size);
  const theme = CARD_TEMPLATES[card.template];
  const font = CARD_FONTS[card.font];
  await fs.promises.writeFile(path.join(directory, 'card-frame.png'), buildFrameImage(card, layout));
  const textColor = theme.text.map((value) => value.toString(16).padStart(2, '0')).join('');
  const drawtexts = [];
  if (layout.lines.length) {
    await fs.promises.copyFile(path.join(FONT_DIRECTORY, font.file), path.join(directory, 'card-font.ttf'));
    for (let i = 0; i < layout.lines.length; i += 1) {
      const textFile = `card-line-${i}.txt`;
      await fs.promises.writeFile(path.join(directory, textFile), layout.lines[i], 'utf8');
      const y = layout.bannerTop + 35 + i * layout.lineHeight;
      drawtexts.push(
        `drawtext=fontfile=card-font.ttf:textfile=${textFile}:expansion=none:fontsize=${layout.fontSize}`
        + `:fontcolor=0x${textColor}:borderw=2:bordercolor=0x${textColor}:x=(w-text_w)/2:y=${y}`
      );
    }
  }
  const fit = `scale=${size.width}:${layout.areaHeight}:force_original_aspect_ratio=decrease,`
    + `pad=${size.width}:${size.height}:(ow-iw)/2:(${layout.areaHeight}-ih)/2:white,setsar=1`;
  return { layout, fit, drawtext: drawtexts.join(','), frameFile: 'card-frame.png' };
}

module.exports = { CARD_FONTS, CARD_TEMPLATES, MAX_MESSAGE_LENGTH, normalizeCard, layoutCard, prepareCardAssets };
