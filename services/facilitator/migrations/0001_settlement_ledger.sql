-- Settlement records, the fee ledger, and the replay guard that sits in front of both.
--
-- Money columns are NUMERIC(20,6) holding atomic micro-USD, the same six-decimal units the
-- contracts and x402 payloads use. The declared scale is never populated: every amount is an
-- integer and every check below says so, because a fraction of one micro-USD in this ledger would
-- mean something other than this service wrote to it.

CREATE TABLE IF NOT EXISTS mandate_settlements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network           TEXT NOT NULL,
  asset             TEXT NOT NULL,
  payer_wallet      TEXT NOT NULL,
  merchant_wallet   TEXT NOT NULL,
  amount_micro      NUMERIC(20, 6) NOT NULL,
  fee_micro         NUMERIC(20, 6) NOT NULL DEFAULT 0,
  -- `authorized` means the ledger has committed to the payment and the payer's funds are
  -- accounted for. `settled` means a transaction moved them and its hash is on this row. The
  -- distinction is the whole point of a net lane, so the two are never collapsed into one word.
  status            TEXT NOT NULL DEFAULT 'authorized',
  tx_hash           TEXT,
  -- The authorisation a direct settlement spent. One authorisation buys one payment, so this is
  -- what makes a retried settle idempotent. It is null in the net lanes, where the payer signed
  -- no per-call authorisation and one transaction covers many payments.
  settle_nonce      TEXT,
  settled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_settlements_status CHECK (status IN ('authorized', 'settled', 'failed')),
  CONSTRAINT chk_settlements_amount CHECK (amount_micro >= 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT chk_settlements_fee CHECK (fee_micro >= 0 AND fee_micro = trunc(fee_micro)),
  CONSTRAINT chk_settlements_fee_within_amount CHECK (fee_micro <= amount_micro),
  -- A settled row without a hash cannot be audited against the chain, and a hash on an
  -- unsettled row is a claim nothing backs.
  CONSTRAINT chk_settlements_settled_has_tx CHECK (
    (status = 'settled' AND tx_hash IS NOT NULL AND settled_at IS NOT NULL)
    OR (status <> 'settled' AND settled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_settlements_merchant_status
  ON mandate_settlements (merchant_wallet, status, created_at);
CREATE INDEX IF NOT EXISTS idx_settlements_payer
  ON mandate_settlements (payer_wallet, created_at DESC);
-- Deliberately not unique on the transaction hash. One transaction pays many authorised calls in
-- the prefund lane, which is the whole reason that lane exists.
CREATE INDEX IF NOT EXISTS idx_settlements_tx_hash
  ON mandate_settlements (network, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlements_nonce
  ON mandate_settlements (network, settle_nonce) WHERE settle_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS mandate_fee_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id  UUID NOT NULL REFERENCES mandate_settlements(id) ON DELETE CASCADE,
  fee_type       TEXT NOT NULL,
  amount_micro   NUMERIC(20, 6) NOT NULL,
  treasury       TEXT NOT NULL,
  treasury_tx    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fee_ledger_type CHECK (fee_type IN ('settlement', 'lane_spread')),
  CONSTRAINT chk_fee_ledger_amount CHECK (amount_micro >= 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT uq_fee_ledger_settlement_type UNIQUE (settlement_id, fee_type)
);

CREATE INDEX IF NOT EXISTS idx_fee_ledger_created ON mandate_fee_ledger (created_at DESC);

-- One authorisation, one settlement.
--
-- The token contract already refuses a spent EIP-3009 nonce, so this table is not the replay
-- protection; the chain is. What it buys is a refusal that costs no gas and does not race: two
-- requests carrying the same authorisation cannot both reach the broadcast, because the second
-- one loses the unique index before either of them spends anything.
CREATE TABLE IF NOT EXISTS mandate_payment_guard (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network        TEXT NOT NULL,
  payer_wallet   TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  usage          TEXT NOT NULL,
  amount_micro   NUMERIC(20, 6) NOT NULL,
  settlement_id  UUID REFERENCES mandate_settlements(id) ON DELETE SET NULL,
  tx_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_guard_usage CHECK (usage IN ('verify', 'settle')),
  CONSTRAINT chk_payment_guard_amount CHECK (amount_micro >= 0 AND amount_micro = trunc(amount_micro)),
  CONSTRAINT uq_payment_guard UNIQUE (network, payer_wallet, nonce)
);

CREATE INDEX IF NOT EXISTS idx_payment_guard_created ON mandate_payment_guard (created_at DESC);
