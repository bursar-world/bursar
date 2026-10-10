-- One row per assistant connection: the mandate it is bound to, the agent key the host generated
-- for it, encrypted under the operator's key-encryption key, and the hash of the bearer token that
-- opens it. The token itself is never stored; the hash is what a request is matched against.

CREATE TABLE IF NOT EXISTS bursar_mcp_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id        INTEGER NOT NULL,
  -- Addresses are stored lowercase so a lookup never depends on the checksum a caller typed.
  mandate         TEXT NOT NULL,
  owner           TEXT NOT NULL,
  agent           TEXT NOT NULL,
  label           TEXT,
  token_hash      TEXT NOT NULL,
  key_ciphertext  BYTEA NOT NULL,
  key_nonce       BYTEA NOT NULL,
  key_tag         BYTEA NOT NULL,
  -- Which key-encryption key sealed this row, so a rotation can tell which rows it still opens.
  kek_id          TEXT NOT NULL,
  -- The nonce from the owner's signed message. One signature opens one connection.
  proof_nonce     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  CONSTRAINT chk_mcp_connections_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT chk_mcp_connections_mandate CHECK (mandate ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_mcp_connections_owner CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_mcp_connections_agent CHECK (agent ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_mcp_connections_revoked CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR (status = 'active' AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_token ON bursar_mcp_connections (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_agent ON bursar_mcp_connections (chain_id, agent);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_proof ON bursar_mcp_connections (owner, proof_nonce);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_mandate ON bursar_mcp_connections (chain_id, mandate, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_owner_created ON bursar_mcp_connections (owner, created_at DESC);
