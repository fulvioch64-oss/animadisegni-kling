process.env.POSTGRES_URL = '';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.FAL_KEY = 'fal_test_dummy';
process.env.VERCEL = '1'; // synchronous path: the provider answer is available inside the request
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

// Stub the provider, the image upload and the renderer so only the credit logic is exercised.
let falBehaviour = async () => 'https://fal.example/video.mp4';
const stub = (file, exports) => {
  const resolved = require.resolve(path.join('..', 'api', '_lib', file));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('fal-video.js', { generateVideoFromImage: (...args) => falBehaviour(...args), buildPrompt: () => 'prompt' });
stub('image-upload.js', {
  saveImageAsPublicUrl: async () => 'https://img.example/x.png',
  prepareImage: async (_dataUrl, _aspectRatio, background) => ({ url: 'https://img.example/x.png', background: background || 'original' })
});
stub('video-loop.js', { renderLoopVideo: async () => '/tmp/x.mp4', addAudioTrack: async () => '/tmp/x-audio.mp4', OUTPUT_DIRECTORY: '/tmp' });

const store = require('../api/_lib/store.js');
const { createDance } = require('../api/_lib/kling.js');

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
async function fundedWallet(main = 1, retry = 0) {
  const walletId = crypto.randomUUID();
  await store.walletAdjust(walletId, `order:${walletId}`, main, retry);
  return walletId;
}
const generate = (walletId) => createDance({ walletId, imageUrl: IMAGE, motionPreset: 'disco70' }, '127.0.0.1');

test('provider error: no credit is charged and the user gets a clear message', async () => {
  const walletId = await fundedWallet(1);
  falBehaviour = async () => { const error = new Error('Fal.ai ha risposto con un errore.'); error.statusCode = 502; throw error; };
  await assert.rejects(generate(walletId), (error) => error.statusCode === 502 && /No credit was charged/.test(error.message));
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('provider timeout: no credit is charged', async () => {
  const walletId = await fundedWallet(1);
  falBehaviour = async () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; };
  await assert.rejects(generate(walletId), /No credit was charged/);
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('empty provider answer: no credit is charged', async () => {
  const walletId = await fundedWallet(1);
  falBehaviour = async () => '';
  await assert.rejects(generate(walletId), { code: 'GENERATION_FAILED' });
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('success: the credit is charged exactly once, after the video URL is returned', async () => {
  const walletId = await fundedWallet(2);
  let balanceDuringCall;
  falBehaviour = async () => { balanceDuringCall = await store.walletGet(walletId); return 'https://fal.example/video.mp4'; };
  const result = await generate(walletId);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(balanceDuringCall, { mainCredits: 2, retryCredits: 0 });
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 1, retryCredits: 0 });
});

test('no credits: rejected before calling the provider', async () => {
  const walletId = await fundedWallet(0);
  let called = false;
  falBehaviour = async () => { called = true; return 'https://fal.example/video.mp4'; };
  await assert.rejects(generate(walletId), { code: 'NO_CREDITS' });
  assert.equal(called, false);
});

test('concurrent requests on one credit: a single generation runs and a single credit is spent', async () => {
  const walletId = await fundedWallet(1);
  let calls = 0;
  falBehaviour = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return 'https://fal.example/video.mp4'; };
  const outcomes = await Promise.allSettled([generate(walletId), generate(walletId)]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((o) => o.status === 'rejected').reason.code, 'GENERATION_IN_PROGRESS');
  assert.equal(calls, 1);
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 0, retryCredits: 0 });
});

test('the wallet lock is released after a failure so the user can retry', async () => {
  const walletId = await fundedWallet(1);
  falBehaviour = async () => { throw new Error('boom'); };
  await assert.rejects(generate(walletId));
  falBehaviour = async () => 'https://fal.example/video.mp4';
  assert.equal((await generate(walletId)).status, 'COMPLETE');
  assert.deepEqual(await store.walletGet(walletId), { mainCredits: 0, retryCredits: 0 });
});
