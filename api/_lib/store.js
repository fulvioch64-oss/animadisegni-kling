
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const envFiles = ['.env.local', '.env']
  .map((name) => path.resolve(__dirname, '..', '..', name))
  .filter((file) => fs.existsSync(file));

if (envFiles.length) {
  require('dotenv').config({ path: envFiles });
}

const VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60;

let pool;

function getPool() {
  if (pool) return pool;

  const connectionString =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    const error = new Error(
      'PostgreSQL non configurato: manca POSTGRES_URL.'
    );
    error.statusCode = 503;
    throw error;
  }

  pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
  });

  pool.on('error', (error) => {
    console.error('[postgres] Errore pool:', error.message);
  });

  return pool;
}

function localMode() {
  return process.env.NODE_ENV !== 'production';
}

function useDatabase() {
  const configured = Boolean(
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING
  );

  if (!configured && !localMode()) {
    const error = new Error(
      'PostgreSQL richiesto in produzione. Configura POSTGRES_URL.'
    );
    error.statusCode = 503;
    throw error;
  }

  return configured;
}

const memoryVideos = new Map();
const memoryCounters = new Map();
const memoryWallets = new Map();
const memoryEvents = new Set();
const memoryRecords = new Map();
const memoryLocks = new Map();

function balance(main, retry) {
  return {
    mainCredits: Math.max(0, Number(main) || 0),
    retryCredits: Math.max(0, Number(retry) || 0),
  };
}

async function consumeGeneration(ipAddress) {
  const digest = crypto
    .createHash('sha256')
    .update(String(ipAddress || 'unknown'))
    .digest('hex');

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  const dayExpiry = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));

  const monthExpiry = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1
  ));

  if (!useDatabase()) {
    const dayKey = `${digest}:${day}`;
    const monthKey = `${digest}:${month}`;
    const daily = memoryCounters.get(dayKey) || 0;
    const monthly = memoryCounters.get(monthKey) || 0;

    if (daily >= 4 || monthly >= 10) {
      return { allowed: false, daily, monthly };
    }

    memoryCounters.set(dayKey, daily + 1);
    memoryCounters.set(monthKey, monthly + 1);

    return {
      allowed: true,
      daily: daily + 1,
      monthly: monthly + 1,
    };
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const dayKey = `day:${digest}:${day}`;
    const monthKey = `month:${digest}:${month}`;

    const dailyResult = await client.query(
      `INSERT INTO quota_counters
         (counter_key, counter_value, expires_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (counter_key)
       DO UPDATE SET
         counter_value = quota_counters.counter_value + 1,
         expires_at = EXCLUDED.expires_at
       RETURNING counter_value`,
      [dayKey, dayExpiry]
    );

    const monthlyResult = await client.query(
      `INSERT INTO quota_counters
         (counter_key, counter_value, expires_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (counter_key)
       DO UPDATE SET
         counter_value = quota_counters.counter_value + 1,
         expires_at = EXCLUDED.expires_at
       RETURNING counter_value`,
      [monthKey, monthExpiry]
    );

    let daily = Number(dailyResult.rows[0].counter_value);
    let monthly = Number(monthlyResult.rows[0].counter_value);

    if (daily > 4 || monthly > 10) {
      await client.query(
        `UPDATE quota_counters
         SET counter_value = GREATEST(0, counter_value - 1)
         WHERE counter_key = ANY($1::text[])`,
        [[dayKey, monthKey]]
      );

      daily = Math.max(0, daily - 1);
      monthly = Math.max(0, monthly - 1);

      await client.query('COMMIT');
      return { allowed: false, daily, monthly };
    }

    await client.query('COMMIT');
    return { allowed: true, daily, monthly };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getVideo(token) {
  if (!useDatabase()) {
    return memoryVideos.get(token) || null;
  }

  const result = await getPool().query(
    `SELECT record_value
     FROM app_records
     WHERE record_key = $1
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [`animadisegni:video:${token}`]
  );

  return result.rows[0]?.record_value ?? null;
}

async function saveVideo(token, updates) {
  const previous = await getVideo(token);
  const video = {
    ...(previous || {}),
    ...updates,
    updatedAt: Date.now(),
  };

  if (!useDatabase()) {
    memoryVideos.set(token, video);
    return video;
  }

  await getPool().query(
    `INSERT INTO app_records
       (record_key, record_value, updated_at, expires_at)
     VALUES (
       $1, $2::jsonb, NOW(),
       NOW() + ($3 * INTERVAL '1 second')
     )
     ON CONFLICT (record_key)
     DO UPDATE SET
       record_value = EXCLUDED.record_value,
       updated_at = NOW(),
       expires_at = EXCLUDED.expires_at`,
    [
      `animadisegni:video:${token}`,
      JSON.stringify(video),
      VIDEO_TTL_SECONDS,
    ]
  );

  return video;
}

async function ensureWallet(client, walletId) {
  await client.query(
    `INSERT INTO wallets (wallet_id)
     VALUES ($1)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [walletId]
  );
}

async function walletGet(walletId) {
  if (!useDatabase()) {
    const wallet = memoryWallets.get(walletId) || {
      main: 0,
      retry: 0,
    };

    return balance(wallet.main, wallet.retry);
  }

  const result = await getPool().query(
    `SELECT main_credits, retry_credits
     FROM wallets
     WHERE wallet_id = $1`,
    [walletId]
  );

  const row = result.rows[0];
  return balance(row?.main_credits, row?.retry_credits);
}

async function walletAdjust(walletId, dedupeKey, mainDelta, retryDelta) {
  if (!useDatabase()) {
    const wallet = memoryWallets.get(walletId) || {
      main: 0,
      retry: 0,
    };

    if (memoryEvents.has(dedupeKey)) {
      return {
        applied: false,
        ...balance(wallet.main, wallet.retry),
      };
    }

    memoryEvents.add(dedupeKey);
    wallet.main = Math.max(0, wallet.main + Number(mainDelta));
    wallet.retry = Math.max(0, wallet.retry + Number(retryDelta));
    memoryWallets.set(walletId, wallet);

    return {
      applied: true,
      ...balance(wallet.main, wallet.retry),
    };
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await ensureWallet(client, walletId);

    const eventKey = `animadisegni:wallet-event:${dedupeKey}`;

    const inserted = await client.query(
      `INSERT INTO wallet_events
         (event_key, wallet_id, main_delta, retry_delta)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING event_key`,
      [eventKey, walletId, mainDelta, retryDelta]
    );

    if (inserted.rowCount > 0) {
      await client.query(
        `UPDATE wallets
         SET main_credits =
               GREATEST(0, main_credits + $2),
             retry_credits =
               GREATEST(0, retry_credits + $3),
             updated_at = NOW()
         WHERE wallet_id = $1`,
        [walletId, mainDelta, retryDelta]
      );
    }

    const result = await client.query(
      `SELECT main_credits, retry_credits
       FROM wallets
       WHERE wallet_id = $1`,
      [walletId]
    );

    await client.query('COMMIT');

    return {
      applied: inserted.rowCount > 0,
      ...balance(
        result.rows[0].main_credits,
        result.rows[0].retry_credits
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function walletConsume(walletId, kind) {
  if (!['main', 'retry'].includes(kind)) {
    throw new Error(`Unknown credit kind: ${kind}`);
  }

  if (!useDatabase()) {
    const wallet = memoryWallets.get(walletId) || {
      main: 0,
      retry: 0,
    };

    if (wallet[kind] <= 0) {
      return {
        ok: false,
        ...balance(wallet.main, wallet.retry),
      };
    }

    wallet[kind] -= 1;
    memoryWallets.set(walletId, wallet);

    return {
      ok: true,
      ...balance(wallet.main, wallet.retry),
    };
  }

  const column = kind === 'main'
    ? 'main_credits'
    : 'retry_credits';

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await ensureWallet(client, walletId);

    const changed = await client.query(
      `UPDATE wallets
       SET ${column} = ${column} - 1,
           updated_at = NOW()
       WHERE wallet_id = $1 AND ${column} > 0
       RETURNING main_credits, retry_credits`,
      [walletId]
    );

    const result = changed.rows[0]
      ? changed
      : await client.query(
          `SELECT main_credits, retry_credits
           FROM wallets WHERE wallet_id = $1`,
          [walletId]
        );

    await client.query('COMMIT');

    return {
      ok: changed.rowCount > 0,
      ...balance(
        result.rows[0].main_credits,
        result.rows[0].retry_credits
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function walletRefund(walletId, kind) {
  if (!['main', 'retry'].includes(kind)) {
    throw new Error(`Unknown credit kind: ${kind}`);
  }

  if (!useDatabase()) {
    const wallet = memoryWallets.get(walletId) || {
      main: 0,
      retry: 0,
    };

    wallet[kind] += 1;
    memoryWallets.set(walletId, wallet);
    return;
  }

  const column = kind === 'main'
    ? 'main_credits'
    : 'retry_credits';

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await ensureWallet(client, walletId);

    await client.query(
      `UPDATE wallets
       SET ${column} = ${column} + 1,
           updated_at = NOW()
       WHERE wallet_id = $1`,
      [walletId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getRecord(key) {
  if (!useDatabase()) {
    return memoryRecords.has(key)
      ? structuredClone(memoryRecords.get(key))
      : null;
  }

  const result = await getPool().query(
    `SELECT record_value
     FROM app_records
     WHERE record_key = $1
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [key]
  );

  return result.rows[0]?.record_value ?? null;
}

async function setRecord(key, value) {
  if (!useDatabase()) {
    memoryRecords.set(key, structuredClone(value));
    return;
  }

  await getPool().query(
    `INSERT INTO app_records
       (record_key, record_value, updated_at, expires_at)
     VALUES ($1, $2::jsonb, NOW(), NULL)
     ON CONFLICT (record_key)
     DO UPDATE SET
       record_value = EXCLUDED.record_value,
       updated_at = NOW(),
       expires_at = NULL`,
    [key, JSON.stringify(value)]
  );
}

async function acquireLock(key, ttlSeconds) {
  if (!useDatabase()) {
    const expiry = memoryLocks.get(key);

    if (expiry && expiry > Date.now()) return false;

    memoryLocks.set(
      key,
      Date.now() + Math.max(1, Number(ttlSeconds) || 1) * 1000
    );

    return true;
  }

  const result = await getPool().query(
    `INSERT INTO app_locks (lock_key, expires_at)
     VALUES ($1, NOW() + ($2 * INTERVAL '1 second'))
     ON CONFLICT (lock_key)
     DO UPDATE SET expires_at = EXCLUDED.expires_at
     WHERE app_locks.expires_at <= NOW()
     RETURNING lock_key`,
    [key, Math.max(1, Number(ttlSeconds) || 1)]
  );

  return result.rowCount > 0;
}

async function releaseLock(key) {
  if (!useDatabase()) {
    memoryLocks.delete(key);
    return;
  }

  await getPool().query(
    'DELETE FROM app_locks WHERE lock_key = $1',
    [key]
  );
}

module.exports = {
  consumeGeneration,
  getVideo,
  saveVideo,
  walletGet,
  walletAdjust,
  walletConsume,
  walletRefund,
  getRecord,
  setRecord,
  acquireLock,
  releaseLock,
};
