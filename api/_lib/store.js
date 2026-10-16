const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const localEnvFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', '..', name))
  .filter((envPath) => fs.existsSync(envPath));
if (localEnvFiles.length) require('dotenv').config({ path: localEnvFiles });

const memory = new Map();
const memoryCounters = new Map();
const VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60;

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

function localStoreEnabled() {
  return process.env.NODE_ENV !== 'production';
}

async function redisCommand(command) {
  const config = redisConfig();
  if (!config) {
    const error = new Error('Configura KV_REST_API_URL e KV_REST_API_TOKEN (o le variabili Upstash equivalenti) per archiviare quote e pagamenti.');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    const error = new Error(`Archivio Redis non disponibile: ${result.error || `HTTP ${response.status}`}`);
    error.statusCode = 503;
    throw error;
  }
  return result.result;
}

function ttlSeconds(expiration) {
  return Math.max(1, Math.ceil((expiration - Date.now()) / 1000));
}

async function consumeGeneration(ipAddress) {
  const digest = crypto.createHash('sha256').update(ipAddress).digest('hex');
  const now = new Date();
  const dailyExpiry = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const monthlyExpiry = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const day = `${now.toISOString().slice(0, 10)}`;
  const month = `${now.toISOString().slice(0, 7)}`;
  const dailyTtl = ttlSeconds(dailyExpiry);
  const monthlyTtl = ttlSeconds(monthlyExpiry);

  if (redisConfig()) {
    const script = `
      local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
      local monthly = tonumber(redis.call('GET', KEYS[2]) or '0')
      if daily >= 4 or monthly >= 10 then
        return {0, daily, monthly}
      end
      daily = redis.call('INCR', KEYS[1])
      monthly = redis.call('INCR', KEYS[2])
      if daily == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      if monthly == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
      return {1, daily, monthly}
    `;
    const result = await redisCommand([
      'EVAL', script, 2,
      `animadisegni:quota:day:${digest}:${day}`,
      `animadisegni:quota:month:${digest}:${month}`,
      dailyTtl,
      monthlyTtl
    ]);
    return { allowed: Number(result[0]) === 1, daily: Number(result[1]), monthly: Number(result[2]) };
  }

  if (!localStoreEnabled()) {
    const error = new Error('Archivio Redis richiesto in produzione per applicare i limiti in modo persistente.');
    error.statusCode = 503;
    throw error;
  }
  const dailyKey = `${digest}:${day}`;
  const monthlyKey = `${digest}:${month}`;
  const daily = memoryCounters.get(dailyKey) || 0;
  const monthly = memoryCounters.get(monthlyKey) || 0;
  if (daily >= 4 || monthly >= 10) return { allowed: false, daily, monthly };
  memoryCounters.set(dailyKey, daily + 1);
  memoryCounters.set(monthlyKey, monthly + 1);
  return { allowed: true, daily: daily + 1, monthly: monthly + 1 };
}

async function getVideo(token) {
  if (redisConfig()) {
    const value = await redisCommand(['GET', `animadisegni:video:${token}`]);
    return value ? JSON.parse(value) : null;
  }
  if (!localStoreEnabled()) {
    const error = new Error('Archivio Redis richiesto in produzione per verificare i pagamenti.');
    error.statusCode = 503;
    throw error;
  }
  return memory.get(token) || null;
}

async function saveVideo(token, updates) {
  const previous = await getVideo(token);
  const video = { ...previous, ...updates, updatedAt: Date.now() };
  if (redisConfig()) {
    await redisCommand(['SET', `animadisegni:video:${token}`, JSON.stringify(video), 'EX', VIDEO_TTL_SECONDS]);
  } else {
    if (!localStoreEnabled()) {
      const error = new Error('Archivio Redis richiesto in produzione per salvare i video.');
      error.statusCode = 503;
      throw error;
    }
    memory.set(token, video);
  }
  return video;
}

module.exports = { consumeGeneration, getVideo, saveVideo };
