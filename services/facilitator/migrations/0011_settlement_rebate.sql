-- The staking rebate a settlement's fee was priced with.
--
-- A payee whose staked BRSR reaches a tier in the staking pool pays less of the facilitator fee.
-- `fee_micro` stays what was charged. Beside it the row keeps the tier the pool reported and what
-- that tier took off, because the fee floor can leave the second at zero while the first is not.
-- Every row written before this was priced with no rebate, which is what the defaults record.
ALTER TABLE bursar_settlements
  ADD COLUMN IF NOT EXISTS rebate_bps INT NOT NULL DEFAULT 0
    CONSTRAINT chk_settlements_rebate_bps CHECK (rebate_bps >= 0 AND rebate_bps <= 10000),
  ADD COLUMN IF NOT EXISTS rebate_micro NUMERIC(20, 6) NOT NULL DEFAULT 0
    CONSTRAINT chk_settlements_rebate CHECK (rebate_micro >= 0 AND rebate_micro = trunc(rebate_micro));

-- The fee before the rebate never exceeded the payment, so the two together cannot either.
ALTER TABLE bursar_settlements
  ADD CONSTRAINT chk_settlements_rebate_within_amount CHECK (fee_micro + rebate_micro <= amount_micro);
