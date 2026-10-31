process.env.POSTGRES_URL = '';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.FAL_KEY = 'fal_test_dummy';
process.env.VERCEL = '1'; // queued path: the request only submits the job, status polls finish it
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

// Stub the provider, the image upload and the renderer so only the credit logic is exercised.
let submitBehaviour = async () => ({ requestId: 'req-1', modelId: 'fal-ai/test' });
let checkBehaviour = async () => ({ done: true, url: 'https://fal.example/video.mp4' });
const stub = (file, exports) => {
  const resolved = require.resolve(path.join('..', 'api', '_lib', file));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('fal-video.js', { submitVideoFromImage: (...args) => submitBehaviour(...args), checkFalVideo: (...args) => checkBehaviour(...args), buildPrompt: () => 'prompt' });
stub('image-upload.js', {
  saveImageAsPublicUrl: async () => 'https://img.example/x.png',
  prepareImage: async (_dataUrl, _aspectRatio, background) => ({ url: 'https://img.example/x.png', background: background || 'original' })
});
stub('video-loop.js', { renderLoopVideo: async () => '/tmp/x.mp4', addAudioTrack: async () => '/tmp/x-audio.mp4', OUTPUT_DIRECTORY: '/tmp' });

const store = require('../api/_lib/store.js');
const { createDance, getDanceStatus } = require('../api/_lib/kling.js');

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
async function fundedWallet(main = 1, retry = 0) {
  const walletId = crypto.randomUUID();
  await store.walletAdjust(walletId, `order:${walletId}`, main, retry);
  return walletId;
}
const generate = (walletId) => createDance({ walletId, imageUrl: IMAGE, motionPreset: 'disco70' }, '127.0.0.1');

test('the request answers at once with PENDING and spends no credit', async () => {
  const walletId = await fundedWallet(1);
  const result = await generate(walletId);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.canPoll, true);
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('submit error: no credit is charged and the user gets a clear message', async () => {
  const walletId = await fundedWallet(1);
  submitBehaviour = async () => { const error = new Error('Fal.ai ha risposto con un errore.'); error.statusCode = 502; throw error; };
  await assert.rejects(generate(walletId), { statusCode: 502 });
  submitBehaviour = async () => ({ requestId: 'req-1', modelId: 'fal-ai/test' });
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('polling: still processing stays PENDING, then COMPLETE and the credit is charged once', async () => {
  const walletId = await fundedWallet(2);
  const { generationToken } = await generate(walletId);
  checkBehaviour = async () => ({ done: false, status: 'IN_PROGRESS' });
  assert.equal((await getDanceStatus(generationToken)).status, 'PENDING');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 2, retryCredits: 0 });
  checkBehaviour = async () => ({ done: true, url: 'https://fal.example/video.mp4' });
  const done = await getDanceStatus(generationToken);
  assert.equal(done.status, 'COMPLETE');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
  assert.equal((await getDanceStatus(generationToken)).status, 'COMPLETE');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('provider failure while polling: ERROR, no credit charged, a new generation can start', async () => {
  const walletId = await fundedWallet(1);
  const { generationToken } = await generate(walletId);
  checkBehaviour = async () => { throw new Error('boom'); };
  const failed = await getDanceStatus(generationToken);
  assert.equal(failed.status, 'ERROR');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
  checkBehaviour = async () => ({ done: true, url: 'https://fal.example/video.mp4' });
  const next = await generate(walletId);
  assert.equal((await getDanceStatus(next.generationToken)).status, 'COMPLETE');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 0, retryCredits: 0 });
});

test('no credits: rejected before calling the provider', async () => {
  const walletId = await fundedWallet(0);
  let called = false;
  submitBehaviour = async () => { called = true; return { requestId: 'x', modelId: 'y' }; };
  await assert.rejects(generate(walletId), { code: 'NO_CREDITS' });
  assert.equal(called, false);
});
