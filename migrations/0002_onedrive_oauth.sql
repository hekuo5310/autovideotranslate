CREATE TABLE IF NOT EXISTS onedrive_connections (
  id TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  account_id TEXT,
  account_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onedrive_connections_active
ON onedrive_connections(active, updated_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
ON oauth_states(expires_at);
