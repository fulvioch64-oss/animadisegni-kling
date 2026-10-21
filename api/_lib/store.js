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
  const usable = candidates.filter(([, config]) => config?.url && config?.token).map(([name, config]) => ({ name, url: config.url, token: config.token }));
  redisConfig.all = usable;
  const found = usable.find((item) => item.name === redisConfig.preferred) || usable[0];
  if (!found) return null;
  if (!redisConfig.logged) {
    redisConfig.logged = true;
    console.info(`[redis] Using ${found.name} (${new URL(found.url).host}).`);
  }
  return found;
}

// Same-database alternatives (same host, different token), tried only when the current token lacks write permission.
function alternativeConfigs(current) {
  const host = new URL(current.url).host;
  return (redisConfig.all || []).filter((item) => item.name !== current.name && item.token !== current.token && new URL(item.url).host === host);
}

async function withWriteFallback(run) {
  const primary = redisConfig();
  if (!primary) return run(null);
  try {
    return await run(primary);
  } catch (error) {
    if (!error.noPerm) throw error;
    for (const alternative of alternativeConfigs(primary)) {
      try {
        const result = await run(alternative);
        redisConfig.preferred = alternative.name;
        console.info(`[redis] Switched to ${alternative.name}: ${primary.name} has no write permission.`);
        return result;
      } catch (alternativeError) {
        if (!alternativeError.noPerm) throw alternativeError;
      }
    }
    throw error;
  }
}

function redisFailure(config, label, detail, status) {
  const noPerm = /NOPERM/i.test(String(detail));
  console.error(`[redis] ${label} failed on ${new URL(config.url).host} via ${config.name} (HTTP ${status}, ${noPerm ? 'NOPERM' : /WRONGPASS/i.test(String(detail)) ? 'WRONGPASS' : 'error'}): ${detail}`);
  let hint = '';
  if (/WRONGPASS/i.test(String(detail))) hint = ' The Redis token does not match this database: copy the REST token of the same database from the Upstash console and redeploy.';
  if (noPerm) hint = ' The Redis token has no write permission (read-only token?): use the standard REST token of the database.';
  const error = new Error(`Archivio Redis non disponibile: ${detail}.${hint}`);
  error.statusCode = 503;
  error.noPerm = noPerm;
  return error;
}

function localStoreEnabled() {
  return process.env.NODE_ENV !== 'production';
}

async function redisCommandWith(command, config) {
  if (!config) {
    const error = new Error('Configura KV_REST_API_URL e KV_REST_API_TOKEN (o le variabili Upstash equivalenti) per archiviare quote e pagamenti.');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    throw redisFailure(config, `Command ${String(command[0]).toUpperCase()}`, result.error || `HTTP ${response.status}`, response.status);
  }
  return result.result;
}

function redisCommand(command) {
  return withWriteFallback((config) => redisCommandWith(command, config));
}

// Runs several commands as one atomic MULTI/EXEC transaction through the Upstash REST API (no Lua/EVAL needed).
async function redisTransactionWith(commands, config) {
  if (!config) {
    const error = new Error('Redis is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${config.url}/multi-exec`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(10000)
  });
  const results = await response.json().catch(() => null);
  // A discarded transaction returns one {error}; otherwise each command reports its own result or error.
  const names = commands.map((item) => String(item[0]).toUpperCase()).join('+');
  if (!response.ok || !Array.isArray(results)) {
    throw redisFailure(config, `Transaction ${names}`, results?.error || `HTTP ${response.status}`, response.status);
  }
  const failed = results.findIndex((item) => item?.error);
  if (failed !== -1 || results.length !== commands.length) {
    throw redisFailure(config, `Transaction ${names}`, failed !== -1 ? results[failed].error : 'Unexpected response length', response.status);
  }
  return results.map((item) => item.result);
}

function redisTransaction(commands) {
  return withWriteFallback((config) => redisTransactionWith(commands, config));
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
    // INCR first, then undo both counters when over the limit: atomic per command, no Lua/EVAL required.
    const dailyKey = `animadisegni:quota:day:${digest}:${day}`;
    const monthlyKey = `animadisegni:quota:month:${digest}:${month}`;
    const [dailyCount, monthlyCount] = (await redisTransaction([
      ['INCR', dailyKey],
      ['INCR', monthlyKey],
      ['EXPIRE', dailyKey, dailyTtl],
      ['EXPIRE', monthlyKey, monthlyTtl]
    ])).map(Number);
    if (dailyCount > 4 || monthlyCount > 10) {
      await redisTransaction([['DECR', dailyKey], ['DECR', monthlyKey]]);
      return { allowed: false, daily: dailyCount - 1, monthly: monthlyCount - 1 };
    }
    return { allowed: true, daily: dailyCount, monthly: monthlyCount };
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
// Redis operations use only plain commands (SET NX, HINCRBY, INCR) and MULTI/EXEC: no EVAL, which restricted Upstash tokens reject.
const memoryWallets = new Map();
const memoryOrderKeys = new Set();
const WALLET_COUNTERS = { main: 0, retry: 1 };

function walletKey(walletId) {
  return `animadisegni:wallet:${walletId}`;
}

function toBalance(main, retry) {
  return { mainCredits: Math.max(0, Number(main) || 0), retryCredits: Math.max(0, Number(retry) || 0) };
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
    const marker = `animadisegni:wallet-event:${dedupeKey}`;
    const key = walletKey(walletId);
    // 1) Claim the event with SET NX (short TTL, so a crashed attempt can be retried).
    const claimed = await redisCommand(['SET', marker, 'pending', 'NX', 'EX', 60]);
    if (claimed !== 'OK') {
      const state = await redisCommand(['GET', marker]);
      if (state !== 'done') {
        const error = new Error('This event is already being processed; retry shortly.');
        error.statusCode = 503;
        throw error;
      }
      const [main, retry] = await redisCommand(['HMGET', key, 'main', 'retry']);
      return { applied: false, ...toBalance(main, retry) };
    }
    // 2) Apply both counters and mark the event as done in a single atomic transaction.
    // If it fails, the marker stays "pending" and expires, so the provider's retry applies the credits once.
    const results = await redisTransaction([
      ['HINCRBY', key, 'main', String(mainDelta)],
      ['HINCRBY', key, 'retry', String(retryDelta)],
      ['SET', marker, 'done']
    ]);
    let main = Number(results[0]);
    let retry = Number(results[1]);
    if (main < 0 || retry < 0) {
      main = Math.max(0, main);
      retry = Math.max(0, retry);
      await redisCommand(['HSET', key, 'main', String(main), 'retry', String(retry)]);
    }
    return { applied: true, ...toBalance(main, retry) };
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
    // HINCRBY is atomic: a result below zero means the balance was empty, so the decrement is undone.
    const key = walletKey(walletId);
    const after = Number(await redisCommand(['HINCRBY', key, kind, -1]));
    const ok = after >= 0;
    if (!ok) await redisCommand(['HINCRBY', key, kind, 1]);
    const [main, retry] = await redisCommand(['HMGET', key, 'main', 'retry']);
    return { ok, ...toBalance(main, retry) };
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
