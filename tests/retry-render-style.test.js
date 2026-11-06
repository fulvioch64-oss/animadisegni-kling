process.env.POSTGRES_URL = '';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (file, exports) => {
  const resolved = require.resolve(path.join('..', 'api', '_lib', file));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const historicalOrder = {
  status: 'paid',
  retry_available: true,
  video_url: 'https://example.test/old-video.mp4',
  original_prompt_params: {
    image: 'https://example.test/image.png',
    motionPreset: 'disco70',
    aspectRatio: '9:16',
    style: 'claymation',
    background: 'original',
    audio: 'disco.mp3',
    card: null
  }
};
const retryCalls = [];

stub('orders.js', {
  isValidOrderId: () => true,
  getOrder: async () => historicalOrder,
  markRetryUsed: async () => {},
  lockRetry: async () => true,
  unlockRetry: async () => {}
});
stub('fal-video.js', {
  generateVideoFromImage: async (...args) => {
    retryCalls.push(args);
    return 'https://example.test/new-video.mp4';
  }
});
stub('kling.js', {
  renderAndSaveVideo: async () => '/tmp/retry.mp4'
});
stub('store.js', { saveVideo: async () => {} });

const retry = require('../api/retry.js');

test('retry of a historical Claymation order generates with Real Draw without changing the order', async () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(body) {
      this.body = JSON.parse(body);
      return this;
    }
  };

  await retry({ method: 'POST', body: { order_id: 'historical-order' } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(retryCalls[0][2].renderStyle, 'real_photo');
  assert.equal(historicalOrder.original_prompt_params.style, 'claymation');
});
