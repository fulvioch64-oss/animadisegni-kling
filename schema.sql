
CREATE TABLE IF NOT EXISTS wallets (
  wallet_id UUID PRIMARY KEY,
  main_credits INTEGER NOT NULL DEFAULT 0 CHECK (main_credits >= 0),
  retry_credits INTEGER NOT NULL DEFAULT 0 CHECK (retry_credits >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_events (
  event_key TEXT PRIMARY KEY,
  wallet_id UUID NOT NULL REFERENCES wallets(wallet_id),
  main_delta INTEGER NOT NULL,
  retry_delta INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_records (
  record_key TEXT PRIMARY KEY,
  record_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_locks (
  lock_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_locks_expiry_idx
  ON app_locks (expires_at);

CREATE INDEX IF NOT EXISTS app_records_updated_idx
  ON app_records (updated_at);

-- Google accounts: one server-generated wallet per user.
CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  wallet_id UUID NOT NULL UNIQUE REFERENCES wallets(wallet_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promo codes: each code grants bonus main credits and can be redeemed once in absolute.
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  main_credits INTEGER NOT NULL DEFAULT 3 CHECK (main_credits > 0),
  redeemed_by_user UUID REFERENCES users(user_id),
  redeemed_wallet_id UUID REFERENCES wallets(wallet_id),
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO promo_codes (code, main_credits) VALUES
  ('ANIMA3-TEST1', 3),
  ('ANIMA3-TEST2', 3)
ON CONFLICT (code) DO NOTHING;

-- Anonymous wallets already merged into an account (a wallet can be claimed only once).
CREATE TABLE IF NOT EXISTS wallet_claims (
  anon_wallet_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id),
  main_moved INTEGER NOT NULL DEFAULT 0,
  retry_moved INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
