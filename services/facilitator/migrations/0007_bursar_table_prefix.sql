-- Moves the ledger from the `mandate_` table prefix to `bursar_`.
--
-- The prefix names the product, not the thing a row describes. The product is BURSAR now, so the
-- prefix moves with it. Nothing about a row changes: no column is added, dropped or rewritten, and
-- a mandate is still called a mandate everywhere it is one, including the `mandate_account` column
-- that holds its address.
--
-- The earlier files are left as they were applied. A database that already has them keeps its
-- checksums and arrives here; a fresh one creates the tables under the old names and renames them
-- in the same run. Both end with the same schema.

ALTER TABLE mandate_settlements           RENAME TO bursar_settlements;
ALTER TABLE mandate_fee_ledger            RENAME TO bursar_fee_ledger;
ALTER TABLE mandate_payment_guard         RENAME TO bursar_payment_guard;
ALTER TABLE mandate_accounts              RENAME TO bursar_accounts;
ALTER TABLE mandate_pools                 RENAME TO bursar_pools;
ALTER TABLE mandate_pool_reserves         RENAME TO bursar_pool_reserves;
ALTER TABLE mandate_lane_balances         RENAME TO bursar_lane_balances;
ALTER TABLE mandate_funding_events        RENAME TO bursar_funding_events;
ALTER TABLE mandate_authorizations        RENAME TO bursar_authorizations;
ALTER TABLE mandate_reservations          RENAME TO bursar_reservations;
ALTER TABLE mandate_billable_events       RENAME TO bursar_billable_events;
ALTER TABLE mandate_collateral_assets     RENAME TO bursar_collateral_assets;
ALTER TABLE mandate_collateral_positions  RENAME TO bursar_collateral_positions;
ALTER TABLE mandate_collateral_events     RENAME TO bursar_collateral_events;
ALTER TABLE mandate_debts                 RENAME TO bursar_debts;
ALTER TABLE mandate_debt_collateral_locks RENAME TO bursar_debt_collateral_locks;
ALTER TABLE mandate_repayments            RENAME TO bursar_repayments;
ALTER TABLE mandate_health_snapshots      RENAME TO bursar_health_snapshots;
ALTER TABLE mandate_risk_actions          RENAME TO bursar_risk_actions;
ALTER TABLE mandate_trust_events          RENAME TO bursar_trust_events;
ALTER TABLE mandate_trust_outbox          RENAME TO bursar_trust_outbox;
ALTER TABLE mandate_trust_dead_letter     RENAME TO bursar_trust_dead_letter;

-- Primary keys, unique constraints, foreign keys and identity sequences were named by Postgres
-- after the table they belong to, and a table rename leaves them behind. Ninety-odd of them, all
-- mechanical, so they are renamed from the catalogue rather than listed. Constraints come first:
-- renaming one also renames the index behind it, and the index pass would otherwise do it twice.
DO $$
DECLARE
  old TEXT;
  owner TEXT;
BEGIN
  FOR old, owner IN
    SELECT c.conname, c.conrelid::regclass::text
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relnamespace = 'public'::regnamespace AND c.conname LIKE 'mandate\_%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', owner, old, 'bursar_' || substr(old, 9));
  END LOOP;

  FOR old IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE 'mandate\_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', old, 'bursar_' || substr(old, 9));
  END LOOP;

  FOR old IN
    SELECT relname FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'S' AND relname LIKE 'mandate\_%'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', old, 'bursar_' || substr(old, 9));
  END LOOP;
END
$$;
