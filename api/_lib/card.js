const fs = require('node:fs');
const path = require('node:path');
const opentype = require('opentype.js');
const { buildFrameImage, christmasTemplate, PAPER_COLOR, themeTextColor } = require('./card-frame.js');

const MAX_MESSAGE_LENGTH = 60;

// Greeting-card fonts. To add one: put the TTF in api/_lib/fonts, add an entry here, a Google Fonts family in
// public/index.html, the CSS family in public/app.js and a label in the locales.
// `scale` evens out the optical size between fonts.
const CARD_FONTS = {
  playful: { file: 'Fredoka.ttf', scale: 1 },
  handwritten: { file: 'Caveat.ttf', scale: 1.3 },
  party: { file: 'Baloo2.ttf', scale: 1 },
  cute: { file: 'PatrickHand.ttf', scale: 1.2 }
};
const DEFAULT_FONT = 'playful';
const CARD_THEMES = ['classic', 'christmas'];

function cardError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// Returns a sanitized card or null when there is no message.
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
  const theme = raw.theme === undefined || raw.theme === '' ? 'classic' : raw.theme;
  if (typeof theme !== 'string' || !CARD_THEMES.includes(theme)) {
    throw cardError(`card.theme must be one of: ${CARD_THEMES.join(', ')}.`);
  }
  if (!message && theme === 'classic') return null;
  return { message, font, theme };
}

function wrapMessage(message, maxChars) {
  const lines = [];
  let current = '';
  for (const word of message.split(' ')) {
    if (Array.from(word).length > maxChars) {
      if (current) lines.push(current);
      const characters = Array.from(word);
      while (characters.length > maxChars) lines.push(characters.splice(0, maxChars).join(''));
      current = characters.join('');
      continue;
    }
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
async function layoutCard(card, { width, height }) {
  // The PNG template is 9:16; other formats keep the generated SVG decorations.
  const template = card.theme === 'christmas' && width * 16 === height * 9 ? await christmasTemplate(width, height) : null;
  const font = CARD_FONTS[card.font];
  const text = (card.message || '').trim();
  const lines = text ? wrapMessage(text, 20) : [];
  const loadedFont = lines.length ? await loadCardFont(card.font) : null;
  const widestLine = lines.length
    ? Math.max(...lines.map((line) => loadedFont.getAdvanceWidth(line, 1) + 2))
    : 1;
  // With the template the message sits in the free paper area below the window, inside the printed border.
  const freeTop = template ? template.window.y + template.window.height + 24 : 0;
  const freeBottom = template ? Math.round(height * 0.94) : 0;
  const textWidth = template ? width - 380 : width - 220;
  let fontSize = lines.length
    ? Math.floor(Math.min(96 * font.scale, textWidth / widestLine))
    : 0;
  if (template && lines.length) fontSize = Math.min(fontSize, Math.floor((freeBottom - freeTop - 24) / (lines.length * 1.18)));
  const lineHeight = Math.round(fontSize * 1.18);
  const bannerHeight = lines.length ? lines.length * lineHeight + 24 : 0;
  const bannerBottomMargin = 84;
  const bannerTop = template
    ? Math.round(freeTop + (freeBottom - freeTop - bannerHeight) / 2)
    : height - bannerBottomMargin - bannerHeight;
  const topZone = Math.round(Math.min(width, height) * 0.15);
  // Room kept around the artwork window for its double keyline (RING_EXTENT) and breathing space.
  const regionTop = topZone + 30;
  const regionBottom = (lines.length ? bannerTop - 8 : height - 26 - 110) - 22;
  const regionHeight = regionBottom - regionTop;
  const windowHeight = Math.max(2, Math.floor(Math.min(regionHeight, ((width - 200) * height) / width)));
  const windowWidth = Math.floor((windowHeight * width) / height);
  const windowBox = template ? template.window : {
    x: Math.round((width - windowWidth) / 2),
    y: regionTop + Math.round((regionHeight - windowHeight) / 2),
    width: windowWidth,
    height: windowHeight
  };
  return {
    width, height, lines, fontSize, lineHeight, bannerHeight, bannerTop, topZone, template,
    window: windowBox, areaHeight: windowBox.height
  };
}

// Literal paths so serverless bundlers (Vercel file tracing) ship the font files with the function.
const FONT_FILES = {
  'Fredoka.ttf': path.join(__dirname, 'fonts', 'Fredoka.ttf'),
  'Caveat.ttf': path.join(__dirname, 'fonts', 'Caveat.ttf'),
  'Baloo2.ttf': path.join(__dirname, 'fonts', 'Baloo2.ttf'),
  'PatrickHand.ttf': path.join(__dirname, 'fonts', 'PatrickHand.ttf')
};
const loadedFonts = new Map();

// Awaited before any drawing; the promise is cached so concurrent renders share one load, and a failed load is retried.
function loadFont(file) {
  if (!loadedFonts.has(file)) {
    const promise = fs.promises.readFile(FONT_FILES[file])
      .then((data) => opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    promise.catch(() => loadedFonts.delete(file));
    loadedFonts.set(file, promise);
  }
  return loadedFonts.get(file);
}

// Falls back to the default font so a message that is present is always drawn.
async function loadCardFont(fontKey) {
  try {
    return await loadFont(CARD_FONTS[fontKey].file);
  } catch (error) {
    if (fontKey === DEFAULT_FONT) throw error;
    return loadFont(CARD_FONTS[DEFAULT_FONT].file);
  }
}

// The message is drawn as vector glyph outlines (no FFmpeg `drawtext`, which needs a libfreetype build that
// serverless FFmpeg binaries do not ship). The SVG fragment is embedded in the frame PNG, so FFmpeg only needs `overlay`.
// opentype's own toPathData emits "NaN" for coordinates such as 772.0000000000001, which truncates the SVG.
const formatNumber = (value) => String(Number(value.toFixed(2)));
function pathData(commands) {
  return commands.map((command) => {
    const points = { M: ['x', 'y'], L: ['x', 'y'], Q: ['x1', 'y1', 'x', 'y'], C: ['x1', 'y1', 'x2', 'y2', 'x', 'y'] }[command.type] || [];
    return command.type + points.map((key) => formatNumber(command[key])).join(' ');
  }).join('');
}

async function messageSvg(card, layout) {
  if (!layout.lines.length) return '';
  const font = await loadCardFont(card.font);
  const color = themeTextColor(card.theme).join(',');
  const ascent = (font.ascender / font.unitsPerEm) * layout.fontSize;
  const paths = layout.lines.map((line, i) => {
    const x = (layout.width - font.getAdvanceWidth(line, layout.fontSize)) / 2;
    const baseline = layout.bannerTop + 12 + i * layout.lineHeight + ascent;
    return pathData(font.getPath(line, x, baseline, layout.fontSize).commands);
  });
  return `<path d="${paths.join(' ')}" fill="rgb(${color})" stroke="rgb(${color})" stroke-width="2" stroke-linejoin="round"/>`;
}

// Writes the frame PNG (message included) into `directory` and returns the FFmpeg fit filter.
// File names are relative: FFmpeg must run with `directory` as its working directory.
async function prepareCardAssets(card, size, directory) {
  const layout = await layoutCard(card, size);
  const message = await messageSvg(card, layout);
  const frame = await buildFrameImage(layout, message, card.theme);
  await fs.promises.writeFile(path.join(directory, 'card-frame.png'), frame);
  const { window: box } = layout;
  const fit = `scale=${box.width}:${box.height}:force_original_aspect_ratio=${layout.template ? 'increase' : 'decrease'},${layout.template ? `crop=${box.width}:${box.height},` : ''}`
    + `pad=${size.width}:${size.height}:${box.x}+(${box.width}-iw)/2:${box.y}+(${box.height}-ih)/2:0x${PAPER_COLOR.map((value) => value.toString(16).padStart(2, '0')).join('')},setsar=1`;
  return { layout, fit, frameFile: 'card-frame.png' };
}

module.exports = { CARD_FONTS, MAX_MESSAGE_LENGTH, normalizeCard, layoutCard, prepareCardAssets };
