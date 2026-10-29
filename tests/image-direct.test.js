process.env.FAL_KEY = 'fal_test_dummy';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { fal } = require('@fal-ai/client');
const { saveImageAsPublicUrl } = require('../api/_lib/image-upload.js');

test('the user image is sent to the video provider as-is, with no background removal', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#88c"/>'
    + '<circle cx="300" cy="300" r="120" fill="#fc9"/></svg>';
  const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  let uploaded;
  Object.defineProperty(fal, 'storage', {
    configurable: true,
    value: { upload: async (blob) => { uploaded = Buffer.from(await blob.arrayBuffer()); return 'https://v3.fal.media/files/photo.jpg'; } }
  });
  const url = await saveImageAsPublicUrl(`data:image/jpeg;base64,${jpeg.toString('base64')}`, '9:16');
  assert.equal(url, 'https://v3.fal.media/files/photo.jpg');
  const { data, info } = await sharp(uploaded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  // A corner pixel of the original photo is still opaque (nothing was cut out).
  assert.equal(data[(2 * info.width + 2) * 4 + 3], 255);
});
