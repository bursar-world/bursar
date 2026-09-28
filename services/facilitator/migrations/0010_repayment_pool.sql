-- The pool a repayment was sent against, as the caller named it.
--
-- A repayment only knew its pool through the first debt it met, so money that arrived with nothing
-- owed was listed in an agent's history under no pool at all, even when the request named one.
-- Nullable because a caller may leave the pool out and let the repayment meet debts in any pool.
ALTER TABLE bursar_repayments
  ADD COLUMN IF NOT EXISTS pool_id TEXT;
