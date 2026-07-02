-- Intentional Budget API — D1 (SQLite) schema
-- One owner. Stores ENCRYPTED Plaid access tokens + a cache of categorized transactions.

CREATE TABLE IF NOT EXISTS items (
  item_id           TEXT PRIMARY KEY,        -- Plaid item_id
  institution       TEXT,                    -- best-effort display name
  access_token_enc  TEXT NOT NULL,           -- AES-256-GCM ciphertext (base64), app-layer encrypted
  cursor            TEXT,                    -- transactions/sync cursor
  error_code        TEXT,                    -- last Plaid error (e.g. ITEM_LOGIN_REQUIRED); NULL = healthy
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  txn_id        TEXT PRIMARY KEY,            -- Plaid transaction_id
  item_id       TEXT,
  date          TEXT,                        -- 'YYYY-MM-DD'
  name          TEXT,
  merchant      TEXT,
  amount        REAL,                        -- Plaid sign: + = money out, - = money in
  iso_currency  TEXT,
  pfc_primary   TEXT,                        -- Plaid personal_finance_category.primary
  pfc_detailed  TEXT,                        -- Plaid personal_finance_category.detailed
  bucket        TEXT,                        -- needs | wants | savings | income | ignore
  bucket_source TEXT,                        -- auto | rule | manual
  pending       INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_date   ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_bucket ON transactions(bucket);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type  TEXT,                          -- merchant | name_contains | pfc
  match_value TEXT,
  bucket      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT DEFAULT (datetime('now')),
  event  TEXT,
  detail TEXT
);
