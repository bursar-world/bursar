-- The lane ledger: accounts, pools, prefunded balances, authorisation decisions, reservations.
--
-- A lane is how a call is funded.
--
--   prefund     the principal has already funded the mandate account; the facilitator debits
--               against the on-chain limit per call and merchants are paid net.
--   collateral  the call is funded against posted collateral and opens a debt.
--   none        the payer's own authorisation settles the call directly, one transaction each.
--
-- Debt exists in the collateral lane and nowhere else. That is enforced in 0003 by a CHECK on the
-- debts table itself, not only by the code that writes to it.

CREATE TABLE IF NOT EXISTS mandate_accounts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  TEXT NOT NULL UNIQUE,
  -- The MandateAccount contract this agent spends through. It is the source of truth for every
  -- limit below; the columns here are a mirror kept for refusing a call before it costs gas.
  mandate_account           TEXT,
  payer_wallet              TEXT NOT NULL,
  repay_wallet              TEXT NOT NULL,
  networks                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  per_call_cap_micro        NUMERIC(20, 6),
  daily_cap_micro           NUMERIC(20, 6),
  monthly_cap_micro         NUMERIC(20, 6),
  approval_threshold_micro  NUMERIC(20, 6),
  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_accounts_status CHECK (status IN ('active', 'suspended')),
  CONSTRAINT chk_accounts_per_call CHECK (
    per_call_cap_micro IS NULL OR (per_call_cap_micro >= 0 AND per_call_cap_micro = trunc(per_call_cap_micro))
  ),
  CONSTRAINT chk_accounts_daily CHECK (
    daily_cap_micro IS NULL OR (daily_cap_micro >= 0 AND daily_cap_micro = trunc(daily_cap_micro))
  ),
  CONSTRAINT chk_accounts_monthly CHECK (
    monthly_cap_micro IS NULL OR (monthly_cap_micro >= 0 AND monthly_cap_micro = trunc(monthly_cap_micro))
  ),
  CONSTRAINT chk_accounts_approval CHECK (
    approval_threshold_micro IS NULL
    OR (approval_threshold_micro >= 0 AND approval_threshold_micro = trunc(approval_threshold_micro))
  )
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON mandate_accounts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_mandate_account ON mandate_accounts (mandate_account);

CREATE TABLE IF NOT EXISTS mandate_pools (
  pool_id             TEXT PRIMARY KEY,
  lane                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  -- Only meaningful in the collateral lane. A prefund pool lends nothing, so its cap is zero.
  ltv_cap_bps         INT NOT NULL DEFAULT 0,
  min_health_factor   NUMERIC(20, 6) NOT NULL DEFAULT 1.500000,
  max_single_micro    NUMERIC(20, 6) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pools_lane CHECK (lane IN ('none', 'prefund', 'collateral')),
  CONSTRAINT chk_pools_status CHECK (status IN ('active', 'paused', 'frozen')),
  CONSTRAINT chk_pools_ltv CHECK (ltv_cap_bps >= 0 AND ltv_cap_bps <= 10000),
  CONSTRAINT chk_pools_health CHECK (min_health_factor > 0),
  CONSTRAINT chk_pools_max_single CHECK (max_single_micro >= 0 AND max_single_micro = trunc(max_single_micro)),
  -- A pool that is not the collateral lane must not carry a borrowing cap, or a later change
  -- could start lending from it without anyone editing the lane.
  CONSTRAINT chk_pools_credit_is_collateral_only CHECK (lane = 'collateral' OR ltv_cap_bps = 0)
);

CREATE TABLE IF NOT EXISTS mandate_pool_reserves (
  pool_id                  TEXT PRIMARY KEY REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  lane                     TEXT NOT NULL,
  reserved_micro           NUMERIC(20, 6) NOT NULL DEFAULT 0,
  outstanding_micro        NUMERIC(20, 6) NOT NULL DEFAULT 0,
  collateral_value_micro   NUMERIC(20, 6) NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reserves_lane CHECK (lane IN ('none', 'prefund', 'collateral')),
  CONSTRAINT chk_reserves_reserved CHECK (reserved_micro >= 0 AND reserved_micro = trunc(reserved_micro)),
  CONSTRAINT chk_reserves_outstanding CHECK (outstanding_micro >= 0 AND outstanding_micro = trunc(outstanding_micro)),
  CONSTRAINT chk_reserves_collateral CHECK (
    collateral_value_micro >= 0 AND collateral_value_micro = trunc(collateral_value_micro)
  ),
  -- Outstanding balance is borrowed money. Outside the collateral lane there is none.
  CONSTRAINT chk_reserves_debt_is_collateral_only CHECK (lane = 'collateral' OR outstanding_micro = 0)
);

-- Prefunded balance, per agent per pool.
--
-- `available` is what a new reservation may lock, `reserved` is locked against calls in flight,
-- and `spent` is what consumed reservations took. The three only ever move between each other, so
-- their sum changes only when a funding event adds to or removes from the account.
CREATE TABLE IF NOT EXISTS mandate_lane_balances (
  agent_id         TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  pool_id          TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  available_micro  NUMERIC(20, 6) NOT NULL DEFAULT 0,
  reserved_micro   NUMERIC(20, 6) NOT NULL DEFAULT 0,
  spent_micro      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, pool_id),
  CONSTRAINT chk_balances_available CHECK (available_micro >= 0 AND available_micro = trunc(available_micro)),
  CONSTRAINT chk_balances_reserved CHECK (reserved_micro >= 0 AND reserved_micro = trunc(reserved_micro)),
  CONSTRAINT chk_balances_spent CHECK (spent_micro >= 0 AND spent_micro = trunc(spent_micro))
);

CREATE INDEX IF NOT EXISTS idx_balances_pool ON mandate_lane_balances (pool_id, updated_at DESC);

-- A confirmed movement of prefunded USDC into or out of a pool balance.
--
-- `reference_id` is the caller's idempotency key, normally the transaction hash of the deposit.
-- Replaying the same reference returns the same event rather than crediting twice.
CREATE TABLE IF NOT EXISTS mandate_funding_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  lane           TEXT NOT NULL,
  pool_id        TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  reference_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  amount_micro   NUMERIC(20, 6) NOT NULL,
  tx_hash        TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Posting collateral is not funding a balance. It has its own table and its own events, so the
  -- only lane that funds a balance here is the prefund one.
  CONSTRAINT chk_funding_lane CHECK (lane = 'prefund'),
  CONSTRAINT chk_funding_type CHECK (event_type IN ('deposit', 'withdraw')),
  CONSTRAINT chk_funding_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT uq_funding_reference UNIQUE (agent_id, pool_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_funding_agent ON mandate_funding_events (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_pool ON mandate_funding_events (pool_id, created_at DESC);

-- The underwriting decision a reservation is opened against.
--
-- The decision itself is made elsewhere; this is the ledger's copy of what was approved, so a
-- reservation can be audited back to the terms it was granted under after the fact.
CREATE TABLE IF NOT EXISTS mandate_authorizations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  payer_wallet       TEXT NOT NULL,
  repay_wallet       TEXT NOT NULL,
  request_nonce      TEXT NOT NULL,
  network            TEXT NOT NULL,
  lane               TEXT NOT NULL,
  pool_id            TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  requested_micro    NUMERIC(20, 6) NOT NULL,
  approved           BOOLEAN NOT NULL,
  approved_micro     NUMERIC(20, 6) NOT NULL,
  available_micro    NUMERIC(20, 6) NOT NULL,
  outstanding_micro  NUMERIC(20, 6) NOT NULL,
  reason_codes       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  policy_id          TEXT,
  policy_version     TEXT,
  ltv_bps            INT,
  health_factor      NUMERIC(20, 6),
  request_hash       TEXT,
  document_hash      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_auth_lane CHECK (lane IN ('none', 'prefund', 'collateral')),
  CONSTRAINT chk_auth_requested CHECK (requested_micro >= 0 AND requested_micro = trunc(requested_micro)),
  CONSTRAINT chk_auth_approved CHECK (approved_micro >= 0 AND approved_micro = trunc(approved_micro)),
  CONSTRAINT chk_auth_available CHECK (available_micro >= 0 AND available_micro = trunc(available_micro)),
  CONSTRAINT chk_auth_outstanding CHECK (outstanding_micro >= 0 AND outstanding_micro = trunc(outstanding_micro)),
  CONSTRAINT chk_auth_ltv CHECK (ltv_bps IS NULL OR (ltv_bps >= 0 AND ltv_bps <= 10000)),
  CONSTRAINT chk_auth_health CHECK (health_factor IS NULL OR health_factor >= 0),
  CONSTRAINT uq_auth_nonce UNIQUE (payer_wallet, request_nonce)
);

CREATE INDEX IF NOT EXISTS idx_auth_agent ON mandate_authorizations (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_lane_pool ON mandate_authorizations (lane, pool_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_request_hash ON mandate_authorizations (request_hash);

-- A hold on funding while a call is in flight.
--
-- Reservations expire. A call that never reports back must not hold a principal's balance for
-- ever, so `expires_at` is checked at consume time and the hold released on the spot.
CREATE TABLE IF NOT EXISTS mandate_reservations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id UUID NOT NULL REFERENCES mandate_authorizations(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  payer_wallet     TEXT NOT NULL,
  merchant_wallet  TEXT NOT NULL,
  request_nonce    TEXT NOT NULL,
  network          TEXT NOT NULL,
  lane             TEXT NOT NULL,
  pool_id          TEXT NOT NULL REFERENCES mandate_pools(pool_id) ON DELETE CASCADE,
  amount_micro     NUMERIC(20, 6) NOT NULL,
  locked_micro     NUMERIC(20, 6) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'reserved',
  expires_at       TIMESTAMPTZ NOT NULL,
  settlement_id    UUID REFERENCES mandate_settlements(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reservations_lane CHECK (lane IN ('none', 'prefund', 'collateral')),
  CONSTRAINT chk_reservations_status CHECK (status IN ('reserved', 'consumed', 'released', 'expired')),
  CONSTRAINT chk_reservations_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT chk_reservations_locked CHECK (locked_micro >= 0 AND locked_micro = trunc(locked_micro)),
  -- The prefund lane exists to lock funds. A reservation in it that locks nothing has failed to
  -- do the one thing that makes the lane safe.
  CONSTRAINT chk_reservations_prefund_locks CHECK (lane <> 'prefund' OR locked_micro > 0),
  CONSTRAINT chk_reservations_others_lock_nothing CHECK (lane = 'prefund' OR locked_micro = 0),
  CONSTRAINT uq_reservations_nonce UNIQUE (payer_wallet, request_nonce)
);

CREATE INDEX IF NOT EXISTS idx_reservations_agent ON mandate_reservations (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_open
  ON mandate_reservations (expires_at) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_reservations_lane_pool
  ON mandate_reservations (lane, pool_id, status, created_at DESC);

-- What a consumed reservation owes the billing system, emitted once and only once.
CREATE TABLE IF NOT EXISTS mandate_billable_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id   UUID NOT NULL REFERENCES mandate_reservations(id) ON DELETE CASCADE,
  settlement_id    UUID NOT NULL REFERENCES mandate_settlements(id) ON DELETE CASCADE,
  debt_id          UUID,
  agent_id         TEXT NOT NULL REFERENCES mandate_accounts(agent_id) ON DELETE CASCADE,
  payer_wallet     TEXT NOT NULL,
  merchant_wallet  TEXT NOT NULL,
  network          TEXT NOT NULL,
  lane             TEXT NOT NULL,
  pool_id          TEXT NOT NULL,
  amount_micro     NUMERIC(20, 6) NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  emitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_billable_lane CHECK (lane IN ('none', 'prefund', 'collateral')),
  CONSTRAINT chk_billable_amount CHECK (amount_micro >= 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT uq_billable_reservation_settlement UNIQUE (reservation_id, settlement_id),
  CONSTRAINT uq_billable_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billable_emitted ON mandate_billable_events (emitted_at DESC);
