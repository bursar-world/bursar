-- One escrow lock, one settlement.
--
-- A mandate-lane settle broadcasts nothing: the payment is a lock already on chain, and the only
-- thing that stopped it being recorded twice was the replay guard, keyed on a nonce read off the
-- payload. A payer could write a fresh nonce into each payload and have one lock settled as often
-- as it liked. The nonce is now derived from the lock, and this table is the constraint behind it:
-- the lock's identity, as the chain holds it, is the primary key, written in the same transaction
-- as the settlement that redeems it. A second redemption fails on the key and takes its settlement
-- row with it when the transaction rolls back, whatever the payload around it said.
--
-- The escrow is stored lowercased, because the same address arrives checksummed from one client
-- and lowercased from another, and two spellings would be two keys.
CREATE TABLE IF NOT EXISTS bursar_lock_redemptions (
  chain_id       BIGINT NOT NULL,
  escrow         TEXT NOT NULL,
  lock_id        NUMERIC(78, 0) NOT NULL,
  settlement_id  UUID NOT NULL UNIQUE REFERENCES bursar_settlements(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, escrow, lock_id),
  CONSTRAINT chk_lock_redemptions_chain CHECK (chain_id > 0),
  CONSTRAINT chk_lock_redemptions_escrow CHECK (escrow = lower(escrow) AND escrow ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT chk_lock_redemptions_id CHECK (lock_id >= 0 AND lock_id = trunc(lock_id))
);
