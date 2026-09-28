-- Ties a broadcast to the hold it pays, and keys a direct settlement on the payer that signed it.
--
-- A settle that names a reservation used to read the hold, broadcast, and only then lock and
-- consume it. Two settles naming one hold could both broadcast, and a hold whose window ran out
-- during the receipt wait was expired and handed back while its transfer landed. The claim closes
-- both: a settle writes its replay-guard row onto the hold before anything is broadcast, a hold can
-- carry one claim, and a claimed hold neither expires nor consumes for anyone else.
--
-- The claim references the guard row rather than copying the nonce. Releasing the guard, which is
-- what happens when nothing was broadcast, then clears the claim in the same statement, so a hold
-- can never stay claimed by a payment this service has already given up on.

ALTER TABLE bursar_reservations
  ADD COLUMN IF NOT EXISTS settle_claim UUID
  REFERENCES bursar_payment_guard(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_settle_claim
  ON bursar_reservations (settle_claim) WHERE settle_claim IS NOT NULL;

-- When reconciliation last asked the chain about a guard row. A row the chain has no answer for
-- yet is asked again after the same interval, not on every maintenance pass.
ALTER TABLE bursar_payment_guard
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_guard_unsettled
  ON bursar_payment_guard (created_at ASC) WHERE settlement_id IS NULL;

-- An EIP-3009 nonce is unique to the payer that signed it, not to the network. Two payers can hold
-- the same one: a payload with no binding object derives its nonce from the request digest and an
-- all-zero salt. Keyed on the network alone, the second payer's settlement collided with the
-- first's and was answered with somebody else's settlement. Lowercased, because the guard row is
-- written lowercased and a checksummed address is the same payer.
DROP INDEX IF EXISTS uq_settlements_nonce;

CREATE UNIQUE INDEX IF NOT EXISTS uq_settlements_payer_nonce
  ON bursar_settlements (network, lower(payer_wallet), settle_nonce) WHERE settle_nonce IS NOT NULL;
