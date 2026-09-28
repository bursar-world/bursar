-- The collateral lane: posted collateral, the debts it backs, and the repayments that close them.
--
-- Everything in this file is confined to one lane by construction. `mandate_debts` carries a CHECK
-- that refuses any row whose lane is not `collateral`, so no future caller can open a debt against
-- a prefunded or direct call by passing the wrong argument.

CREATE TABLE IF NOT EXISTS mandate_collateral_assets (
  asset_id                TEXT PRIMARY KEY,
  symbol                  TEXT NOT NULL,
  chain                   TEXT NOT NULL,
  -- The discount applied to posted value before it counts as backing. USDC on the settlement
  -- chain is the asset it settles in, so it is taken at face value.
  haircut_bps             INT NOT NULL DEFAULT 0,
  volatility_buffer_bps   INT NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_collateral_asset_haircut CHECK (haircut_bps >= 0 AND haircut_bps <= 10000),
  CONSTRAINT chk_collateral_asset_buffer CHECK (volatility_buffer_bps >= 0 AND volatility_buffer_bps <= 10000),
  CONSTRAINT chk_collateral_asset_status CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS mandate_collateral_positions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  pool_id              TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  collateral_account   TEXT NOT NULL,
  asset_id             TEXT NOT NULL REFERENCES mandate_collateral_assets(asset_id),
  deposited_micro      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  withdrawn_micro      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  locked_micro         NUMERIC(20, 6) NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_position_deposited CHECK (deposited_micro >= 0 AND deposited_micro = trunc(deposited_micro)),
  CONSTRAINT chk_position_withdrawn CHECK (withdrawn_micro >= 0 AND withdrawn_micro = trunc(withdrawn_micro)),
  CONSTRAINT chk_position_locked CHECK (locked_micro >= 0 AND locked_micro = trunc(locked_micro)),
  CONSTRAINT chk_position_status CHECK (status IN ('active', 'frozen', 'closed')),
  -- Withdrawals can never exceed deposits, whichever path writes the row.
  CONSTRAINT chk_position_solvent CHECK (deposited_micro - withdrawn_micro - locked_micro >= 0),
  CONSTRAINT uq_position UNIQUE (agent_id, pool_id, collateral_account, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_agent_pool
  ON mandate_collateral_positions (agent_id, pool_id, status);

CREATE TABLE IF NOT EXISTS mandate_collateral_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  pool_id              TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  lane                 TEXT NOT NULL,
  collateral_account   TEXT NOT NULL,
  asset_id             TEXT NOT NULL REFERENCES mandate_collateral_assets(asset_id),
  reference_id         TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  amount_micro         NUMERIC(20, 6) NOT NULL,
  tx_hash              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_collateral_event_lane CHECK (lane = 'collateral'),
  CONSTRAINT chk_collateral_event_type CHECK (event_type IN ('deposit', 'withdraw')),
  CONSTRAINT chk_collateral_event_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT uq_collateral_event_reference UNIQUE (agent_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_collateral_events_agent
  ON mandate_collateral_events (agent_id, created_at DESC);

-- Borrowed principal, and what is still owed on it.
--
-- One debt per settlement. The unique constraint is what makes finalising a settlement twice a
-- no-op rather than a doubling.
CREATE TABLE IF NOT EXISTS mandate_debts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  payer_wallet       TEXT NOT NULL,
  repay_wallet       TEXT NOT NULL,
  network            TEXT NOT NULL,
  lane               TEXT NOT NULL,
  pool_id            TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  settlement_id      UUID NOT NULL UNIQUE REFERENCES mandate_settlements(id) ON DELETE CASCADE,
  authorization_id   UUID REFERENCES mandate_authorizations(id),
  reservation_id     UUID REFERENCES mandate_reservations(id),
  principal_micro    NUMERIC(20, 6) NOT NULL,
  outstanding_micro  NUMERIC(20, 6) NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at          TIMESTAMPTZ,
  -- The product boundary, written where it cannot be argued with.
  CONSTRAINT chk_debts_collateral_lane_only CHECK (lane = 'collateral'),
  CONSTRAINT chk_debts_principal CHECK (principal_micro > 0 AND principal_micro = trunc(principal_micro)),
  CONSTRAINT chk_debts_outstanding CHECK (
    outstanding_micro >= 0
    AND outstanding_micro = trunc(outstanding_micro)
    AND outstanding_micro <= principal_micro
  ),
  CONSTRAINT chk_debts_status CHECK (status IN ('open', 'closed', 'written_off')),
  CONSTRAINT chk_debts_closed_is_zero CHECK (status <> 'closed' OR outstanding_micro = 0),
  CONSTRAINT chk_debts_closed_at CHECK ((status = 'open') = (closed_at IS NULL))
);

-- Repayment walks open debts oldest first, so the ordering column is part of the index.
CREATE INDEX IF NOT EXISTS idx_debts_open_fifo
  ON mandate_debts (agent_id, created_at ASC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_debts_lane_pool
  ON mandate_debts (lane, pool_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS mandate_repayments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  debt_id         UUID REFERENCES mandate_debts(id),
  reference_id    TEXT NOT NULL,
  source          TEXT NOT NULL,
  amount_micro    NUMERIC(20, 6) NOT NULL,
  applied_micro   NUMERIC(20, 6) NOT NULL,
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_repayments_source CHECK (source IN ('settlement', 'transfer', 'collateral')),
  CONSTRAINT chk_repayments_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT chk_repayments_applied CHECK (
    applied_micro >= 0 AND applied_micro = trunc(applied_micro) AND applied_micro <= amount_micro
  ),
  CONSTRAINT uq_repayment_reference UNIQUE (agent_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_repayments_agent ON mandate_repayments (agent_id, created_at DESC);

-- What the pool looked like the last time collateral or debt moved. Kept as a series rather than
-- a single row so a liquidation argument can be reconstructed after the fact.
CREATE TABLE IF NOT EXISTS mandate_health_snapshots (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                 TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  lane                     TEXT NOT NULL,
  pool_id                  TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  collateral_value_micro   NUMERIC(20, 6) NOT NULL DEFAULT 0,
  outstanding_micro        NUMERIC(20, 6) NOT NULL DEFAULT 0,
  ltv_bps                  INT NOT NULL DEFAULT 0,
  -- Null when nothing is owed. A position with no debt has no health to measure, and writing
  -- zero there would read as the worst possible reading rather than as the absence of one.
  health_factor            NUMERIC(20, 6),
  source                   TEXT NOT NULL DEFAULT 'facilitator',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_health_lane CHECK (lane = 'collateral'),
  CONSTRAINT chk_health_collateral CHECK (
    collateral_value_micro >= 0 AND collateral_value_micro = trunc(collateral_value_micro)
  ),
  CONSTRAINT chk_health_outstanding CHECK (
    outstanding_micro >= 0 AND outstanding_micro = trunc(outstanding_micro)
  ),
  CONSTRAINT chk_health_ltv CHECK (ltv_bps >= 0 AND ltv_bps <= 10000),
  CONSTRAINT chk_health_factor CHECK (health_factor IS NULL OR health_factor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_health_agent_pool
  ON mandate_health_snapshots (agent_id, pool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mandate_risk_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  lane         TEXT NOT NULL,
  pool_id      TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  CONSTRAINT chk_risk_lane CHECK (lane IN ('prefund', 'collateral')),
  CONSTRAINT chk_risk_action CHECK (action IN ('freeze', 'throttle', 'unfreeze')),
  CONSTRAINT chk_risk_status CHECK (status IN ('active', 'resolved')),
  CONSTRAINT chk_risk_resolved_at CHECK ((status = 'active') = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_risk_actions_agent
  ON mandate_risk_actions (agent_id, status, created_at DESC);

-- The settlement asset is the only collateral the lane opens with. Anything else needs a haircut
-- somebody has argued for, and an inactive row is how that argument gets recorded before it is
-- accepted.
INSERT INTO mandate_collateral_assets (asset_id, symbol, chain, haircut_bps, volatility_buffer_bps, status)
VALUES ('usdc-arc', 'USDC', 'arc', 0, 0, 'active')
ON CONFLICT (asset_id) DO NOTHING;
