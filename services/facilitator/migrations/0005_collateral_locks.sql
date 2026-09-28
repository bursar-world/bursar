-- What each debt holds against, so collateral cannot be withdrawn out from under it.
--
-- `mandate_collateral_positions.locked_micro` existed from 0003 and nothing ever wrote it, which
-- left the withdrawal guard reading `deposited - withdrawn >= amount`: an agent could take every
-- unit of its collateral back while still owing on it. Opening a debt now locks the posted amount
-- that backs it, grossed up by the asset's haircut, and closing the debt releases it.
--
-- The lock is recorded per position rather than summed into one column on the debt, because an
-- agent may back one debt with several positions and the release has to put each amount back where
-- it came from.

CREATE TABLE IF NOT EXISTS mandate_debt_collateral_locks (
  debt_id       UUID NOT NULL REFERENCES mandate_debts(id) ON DELETE CASCADE,
  position_id   UUID NOT NULL REFERENCES mandate_collateral_positions(id) ON DELETE CASCADE,
  locked_micro  NUMERIC(20, 6) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (debt_id, position_id),
  CONSTRAINT chk_debt_lock_amount CHECK (locked_micro > 0 AND locked_micro = trunc(locked_micro))
);

CREATE INDEX IF NOT EXISTS idx_debt_locks_position
  ON mandate_debt_collateral_locks (position_id);
