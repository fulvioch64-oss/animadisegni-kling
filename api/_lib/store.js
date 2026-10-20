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
  const clean = (value) => (typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : '');
  // Accepts a bare host ("xyz.upstash.io") as well as a full URL.
  const restUrl = (value) => {
    const cleaned = clean(value);
    if (!cleaned) return '';
    return (/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`).replace(/\/+$/, '');
  };
  // Upstash TCP URLs (rediss://default:<token>@host:6379) carry the same token as the REST API, with the same host.
  const fromTcpUrl = (value) => {
    try {
      const parsed = new URL(clean(value));
      if (!/^rediss?:$/.test(parsed.protocol) || !parsed.password) return null;
      return { url: `https://${parsed.hostname}`, token: decodeURIComponent(parsed.password) };
    } catch {
      return null;
    }
  };
  // URL and token always come from the same source, so stale values from one provider never mix with another's.
  const candidates = [
    ['UPSTASH_REDIS_REST_*', { url: restUrl(process.env.UPSTASH_REDIS_REST_URL), token: clean(process.env.UPSTASH_REDIS_REST_TOKEN) }],
    ['KV_REST_API_*', { url: restUrl(process.env.KV_REST_API_URL), token: clean(process.env.KV_REST_API_TOKEN) }],
    ['REDIS_URL', fromTcpUrl(process.env.REDIS_URL)],
    ['KV_URL', fromTcpUrl(process.env.KV_URL)]
  ];
  const found = candidates.find(([, config]) => config?.url && config?.token);
  if (!found) return null;
  if (!redisConfig.logged) {
    redisConfig.logged = true;
    console.info(`[redis] Using ${found[0]} (${new URL(found[1].url).host}).`);
  }
  return found[1];
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
    const detail = result.error || `HTTP ${response.status}`;
    console.error(`[redis] Command rejected by ${new URL(config.url).host}: ${detail}`);
    const hint = /WRONGPASS/i.test(String(detail)) ? ' The Redis token does not match this database: copy the REST token of the same database from the Upstash console and redeploy.' : '';
    const error = new Error(`Archivio Redis non disponibile: ${detail}.${hint}`);
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

// ---- Credit wallets ----
// A wallet holds two counters: main (new videos) and retry (free regenerations of the same drawing).
// Redis operations are atomic Lua scripts; the in-memory fallback (local dev only) never awaits between read and write.
const memoryWallets = new Map();
const memoryOrderKeys = new Set();
const WALLET_COUNTERS = { main: 0, retry: 1 };

function walletKey(walletId) {
  return `animadisegni:wallet:${walletId}`;
}

function toBalance(main, retry) {
  return { mainCredits: Number(main) || 0, retryCredits: Number(retry) || 0 };
}

function requireWalletStore() {
  if (redisConfig()) return true;
  if (!localStoreEnabled()) {
    const error = new Error('A Redis store is required in production to keep credit balances. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) for this Vercel environment, then redeploy.');
    error.statusCode = 503;
    throw error;
  }
  return false;
}

async function walletGet(walletId) {
  if (requireWalletStore()) {
    const [main, retry] = await redisCommand(['HMGET', walletKey(walletId), 'main', 'retry']);
    return toBalance(main, retry);
  }
  const wallet = memoryWallets.get(walletId) || { main: 0, retry: 0 };
  return toBalance(wallet.main, wallet.retry);
}

// Adds (or, with negative deltas, removes) credits once per dedupeKey, e.g. "order:<id>". Balances never go below 0.
async function walletAdjust(walletId, dedupeKey, mainDelta, retryDelta) {
  if (requireWalletStore()) {
    const script = `
      if redis.call('SET', KEYS[2], '1', 'NX') == false then
        local m = redis.call('HMGET', KEYS[1], 'main', 'retry')
        return {0, tonumber(m[1] or '0'), tonumber(m[2] or '0')}
      end
      local main = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'main') or '0') + tonumber(ARGV[1]))
      local retry = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'retry') or '0') + tonumber(ARGV[2]))
      redis.call('HSET', KEYS[1], 'main', main, 'retry', retry)
      return {1, main, retry}
    `;
    const [applied, main, retry] = await redisCommand([
      'EVAL', script, 2, walletKey(walletId), `animadisegni:wallet-event:${dedupeKey}`, mainDelta, retryDelta
    ]);
    return { applied: Number(applied) === 1, ...toBalance(main, retry) };
  }
  const wallet = memoryWallets.get(walletId) || { main: 0, retry: 0 };
  if (memoryOrderKeys.has(dedupeKey)) return { applied: false, ...toBalance(wallet.main, wallet.retry) };
  memoryOrderKeys.add(dedupeKey);
  wallet.main = Math.max(0, wallet.main + mainDelta);
  wallet.retry = Math.max(0, wallet.retry + retryDelta);
  memoryWallets.set(walletId, wallet);
  return { applied: true, ...toBalance(wallet.main, wallet.retry) };
}

// Spends one credit of the given kind ('main' | 'retry'). Returns { ok: false } when none is left.
async function walletConsume(walletId, kind) {
  if (!Object.hasOwn(WALLET_COUNTERS, kind)) throw new Error(`Unknown credit kind: ${kind}`);
  if (requireWalletStore()) {
    const script = `
      local value = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
      if value <= 0 then
        local m = redis.call('HMGET', KEYS[1], 'main', 'retry')
        return {0, tonumber(m[1] or '0'), tonumber(m[2] or '0')}
      end
      redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
      local m = redis.call('HMGET', KEYS[1], 'main', 'retry')
      return {1, tonumber(m[1] or '0'), tonumber(m[2] or '0')}
    `;
    const [ok, main, retry] = await redisCommand(['EVAL', script, 1, walletKey(walletId), kind]);
    return { ok: Number(ok) === 1, ...toBalance(main, retry) };
  }
  const wallet = memoryWallets.get(walletId) || { main: 0, retry: 0 };
  if (wallet[kind] <= 0) return { ok: false, ...toBalance(wallet.main, wallet.retry) };
  wallet[kind] -= 1;
  memoryWallets.set(walletId, wallet);
  return { ok: true, ...toBalance(wallet.main, wallet.retry) };
}

async function walletRefund(walletId, kind) {
  if (!Object.hasOwn(WALLET_COUNTERS, kind)) throw new Error(`Unknown credit kind: ${kind}`);
  if (requireWalletStore()) {
    await redisCommand(['HINCRBY', walletKey(walletId), kind, 1]);
    return;
  }
  const wallet = memoryWallets.get(walletId) || { main: 0, retry: 0 };
  wallet[kind] += 1;
  memoryWallets.set(walletId, wallet);
}

// ---- Generic JSON records (used by orders) and short-lived locks ----
const memoryRecords = new Map();
const memoryLocks = new Map();

async function getRecord(key) {
  if (redisConfig()) {
    const value = await redisCommand(['GET', key]);
    return value ? JSON.parse(value) : null;
  }
  requireWalletStore();
  return memoryRecords.has(key) ? structuredClone(memoryRecords.get(key)) : null;
}

async function setRecord(key, value) {
  if (redisConfig()) {
    await redisCommand(['SET', key, JSON.stringify(value)]);
    return;
  }
  requireWalletStore();
  memoryRecords.set(key, structuredClone(value));
}

// Atomic "set if absent" with expiry; returns true when the lock was acquired.
async function acquireLock(key, ttlSeconds) {
  if (redisConfig()) {
    return (await redisCommand(['SET', key, '1', 'NX', 'EX', ttlSeconds])) === 'OK';
  }
  requireWalletStore();
  const expiresAt = memoryLocks.get(key);
  if (expiresAt && expiresAt > Date.now()) return false;
  memoryLocks.set(key, Date.now() + ttlSeconds * 1000);
  return true;
}

async function releaseLock(key) {
  if (redisConfig()) {
    await redisCommand(['DEL', key]);
    return;
  }
  memoryLocks.delete(key);
}

module.exports = { consumeGeneration, getVideo, saveVideo, walletGet, walletAdjust, walletConsume, walletRefund, getRecord, setRecord, acquireLock, releaseLock };
