const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const opentype = require('opentype.js');
const { CARD_FONTS, layoutCard } = require('../api/_lib/card.js');

const FONT_DIRECTORY = path.join(__dirname, '..', 'api', '_lib', 'fonts');

function loadFont(file) {
  const data = fs.readFileSync(path.join(FONT_DIRECTORY, file));
  return opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

test('card layout fits long unbroken messages for every font and aspect ratio', async () => {
  for (const [fontName, fontOptions] of Object.entries(CARD_FONTS)) {
    const font = loadFont(fontOptions.file);
    for (const size of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const layout = await layoutCard({ message: 'W'.repeat(60), font: fontName }, size);
      assert.equal(layout.lines.length, 3);
      assert.ok(layout.lines.every((line) => Array.from(line).length <= 20));
      assert.ok(layout.lines.every((line) => font.getAdvanceWidth(line, layout.fontSize) + 2 <= size.width - 220));
      assert.ok(layout.bannerHeight < size.height);
      assert.ok(layout.areaHeight > 0);
      const { window: box } = layout;
      assert.ok(box.x >= 26 && box.x + box.width <= size.width - 26);
      assert.ok(box.y >= layout.topZone && box.y + box.height <= layout.bannerTop);
      assert.equal(box.height, layout.areaHeight);
    }
  }
});

test('blank or missing messages produce no text lines, padded messages are trimmed', async () => {
  const size = { width: 1080, height: 1080 };
  assert.equal((await layoutCard({ font: 'playful' }, size)).lines.length, 0);
  assert.equal((await layoutCard({ message: '   ', font: 'playful' }, size)).lines.length, 0);
  assert.deepEqual((await layoutCard({ message: '  Ciao  ', font: 'playful' }, size)).lines, ['Ciao']);
});

test('frame is full-bleed textured paper with no colored outer border', async () => {
  const sharp = require('sharp');
  const { buildFrameImage, PAPER_COLOR } = require('../api/_lib/card-frame.js');
  const { normalizeCard } = require('../api/_lib/card.js');
  const size = { width: 1080, height: 1920 };
  const layout = await layoutCard({ message: 'Ciao', font: 'playful' }, size);
  const { data, info } = await sharp(await buildFrameImage(layout)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  for (const [x, y] of [[0, 0], [5, 500], [1074, 900], [540, 1915]]) {
    const offset = (y * info.width + x) * info.channels;
    PAPER_COLOR.forEach((value, i) => assert.ok(Math.abs(data[offset + i] - value) < 45, `edge pixel ${x},${y}`));
  }
  assert.deepEqual(normalizeCard({ message: 'Ciao', borderColor: 'red' }), { message: 'Ciao', font: 'playful', theme: 'classic' });
  assert.equal(normalizeCard({ borderColor: 'red' }), null);
});

test('christmas theme: normalized, keeps frame without message, prompt and audio mapping', async () => {
  const { normalizeCard } = require('../api/_lib/card.js');
  const { buildPrompt } = require('../api/_lib/fal-video.js');
  const { pickTrack } = require('../api/_lib/music.js');
  assert.deepEqual(normalizeCard({ message: 'Ciao', theme: 'christmas' }), { message: 'Ciao', font: 'playful', theme: 'christmas' });
  assert.equal(normalizeCard({ theme: 'christmas' }).theme, 'christmas');
  assert.throws(() => normalizeCard({ message: 'x', theme: 'halloween' }), /card.theme/);
  assert.match(buildPrompt('disco70', 'real_photo', 'original', 'christmas'), /Christmas/);
  assert.doesNotMatch(buildPrompt('disco70', 'real_photo', 'original'), /Christmas/);
  assert.ok(pickTrack('christmas').file);
});

test('message path data never contains NaN (opentype rounding bug)', async () => {
  const sharp = require('sharp');
  const { prepareCardAssets } = require('../api/_lib/card.js');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'card-'));
  try {
    for (const theme of ['classic', 'christmas']) {
      await prepareCardAssets({ message: 'Merry Christmas Dad', font: 'cute', theme }, { width: 1080, height: 1920 }, directory);
      const { data, info } = await sharp(path.join(directory, 'card-frame.png')).raw().toBuffer({ resolveWithObject: true });
      // Rightmost part of the message line ("Dad") must have text-colored pixels.
      let dark = 0;
      for (let y = 1700; y < 1850; y += 1) {
        for (let x = 800; x < 900; x += 1) {
          const o = (y * info.width + x) * info.channels;
          if (data[o + 1] < 80 && data[o + 2] < 120) dark += 1;
        }
      }
      assert.ok(dark > 50, `${theme}: end of message not drawn`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
