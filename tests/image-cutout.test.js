process.env.FAL_KEY = 'fal_test_dummy';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { fal } = require('@fal-ai/client');
const { saveImageAsPublicUrl } = require('../api/_lib/image-upload.js');

async function photoDataUrl() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#88c"/>'
    + '<circle cx="300" cy="300" r="120" fill="#fc9"/><rect x="220" y="420" width="160" height="260" rx="40" fill="#e33"/></svg>';
  const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

async function captureUpload(background) {
  let uploaded;
  const storage = {
    upload: async (blob) => { uploaded = { type: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) }; return 'https://v3.fal.media/files/cutout.png'; }
  };
  Object.defineProperty(fal, 'storage', { value: storage, configurable: true });
  const url = await saveImageAsPublicUrl(await photoDataUrl(), '9:16', background);
  return { url, uploaded };
}

test('the video provider receives the transparent cut-out PNG, not the original photo', async () => {
  const { url, uploaded } = await captureUpload(null);
  assert.equal(url, 'https://v3.fal.media/files/cutout.png');
  assert.equal(uploaded.type, 'image/png');
  const { data, info } = await sharp(uploaded.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  const alphaAt = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alphaAt(2, 2), 0, 'the photo background must be transparent');
  assert.ok(alphaAt(info.width / 2, Math.round(info.height * 0.4)) > 200, 'the subject must stay opaque');
});

test('with an illustrated scene the cut-out is composed onto it (opaque JPEG)', async () => {
  const { uploaded } = await captureUpload('stanza_giochi');
  assert.equal(uploaded.type, 'image/jpeg');
  assert.equal((await sharp(uploaded.buffer).metadata()).hasAlpha, false);
});
