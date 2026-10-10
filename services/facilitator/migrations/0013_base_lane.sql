-- The Base lane: one escrow lock on Robinhood Chain, one USDC authorization on Base.
--
-- A row is written the moment the facilitator signs an authorization from its Base float, keyed on
-- the lock that pays for it as the chain holds it. A second pay naming the same lock fails on the
-- key before anything is signed, whatever the payload around it said. The nonce is unique to the
-- float as well, which is the token's own replay rule written down here so the ledger and USDC
-- cannot disagree about which authorization a row is.
--
-- `signed` means an authorization is out and the USDC may move until `valid_before`. `paid` means
-- USDC reports the nonce used and the lock's release is pending. `settled` means the lock released
-- to the float. `returned` means the authorization expired unused and the lock was cancelled, which
-- hands the USDG back to the mandate and credits its windows. Promised float is the sum over `signed`.
CREATE TABLE IF NOT EXISTS bursar_base_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id         BIGINT NOT NULL,
  escrow           TEXT NOT NULL,
  lock_id          NUMERIC(78, 0) NOT NULL,
  lock_tx_hash     TEXT NOT NULL,
  mandate          TEXT NOT NULL,
  float            TEXT NOT NULL,
  network          TEXT NOT NULL,
  asset            TEXT NOT NULL,
  pay_to           TEXT NOT NULL,
  resource         TEXT NOT NULL,
  amount_micro     NUMERIC(20, 6) NOT NULL,
  lock_micro       NUMERIC(20, 6) NOT NULL,
  fee_micro        NUMERIC(20, 6) NOT NULL,
  nonce            TEXT NOT NULL,
  valid_before     BIGINT NOT NULL,
  deadline         BIGINT NOT NULL,
  signed_block     BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'signed',
  reported_tx_hash TEXT,
  base_tx_hash     TEXT,
  rhc_tx_hash      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  CONSTRAINT uq_base_payments_lock UNIQUE (chain_id, escrow, lock_id),
  CONSTRAINT uq_base_payments_nonce UNIQUE (float, nonce),
  CONSTRAINT chk_base_payments_status CHECK (status IN ('signed', 'paid', 'settled', 'returned')),
  CONSTRAINT chk_base_payments_amount CHECK (amount_micro > 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT chk_base_payments_lock_micro CHECK (lock_micro >= amount_micro AND lock_micro = trunc(lock_micro)),
  CONSTRAINT chk_base_payments_fee CHECK (fee_micro >= 0 AND fee_micro = trunc(fee_micro) AND fee_micro = lock_micro - amount_micro),
  CONSTRAINT chk_base_payments_lowercase CHECK (escrow = lower(escrow) AND float = lower(float) AND nonce = lower(nonce)),
  CONSTRAINT chk_base_payments_closed CHECK (
    (status IN ('settled', 'returned') AND rhc_tx_hash IS NOT NULL AND closed_at IS NOT NULL)
    OR (status IN ('signed', 'paid') AND closed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_base_payments_open
  ON bursar_base_payments (created_at ASC) WHERE status IN ('signed', 'paid');
CREATE INDEX IF NOT EXISTS idx_base_payments_mandate
  ON bursar_base_payments (mandate, created_at DESC);
