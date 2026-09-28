-- Renames the lane a payer's own authorisation settles in, from `none` to `direct`.
--
-- `direct` is the name the product uses for it: it is what `GET /config` advertises, what the
-- README describes, and what a customer is told they are using. `none` was only ever the internal
-- spelling, and a lane you can read about but cannot name in a request is worse than no lane at
-- all. One word, everywhere.
--
-- Rows are rewritten before the constraints are, so the check never sees a value it would refuse.

UPDATE mandate_pools SET lane = 'direct' WHERE lane = 'none';
UPDATE mandate_pool_reserves SET lane = 'direct' WHERE lane = 'none';
UPDATE mandate_authorizations SET lane = 'direct' WHERE lane = 'none';
UPDATE mandate_reservations SET lane = 'direct' WHERE lane = 'none';
UPDATE mandate_billable_events SET lane = 'direct' WHERE lane = 'none';

ALTER TABLE mandate_pools DROP CONSTRAINT IF EXISTS chk_pools_lane;
ALTER TABLE mandate_pools
  ADD CONSTRAINT chk_pools_lane CHECK (lane IN ('direct', 'prefund', 'collateral'));

ALTER TABLE mandate_pool_reserves DROP CONSTRAINT IF EXISTS chk_reserves_lane;
ALTER TABLE mandate_pool_reserves
  ADD CONSTRAINT chk_reserves_lane CHECK (lane IN ('direct', 'prefund', 'collateral'));

ALTER TABLE mandate_authorizations DROP CONSTRAINT IF EXISTS chk_auth_lane;
ALTER TABLE mandate_authorizations
  ADD CONSTRAINT chk_auth_lane CHECK (lane IN ('direct', 'prefund', 'collateral'));

ALTER TABLE mandate_reservations DROP CONSTRAINT IF EXISTS chk_reservations_lane;
ALTER TABLE mandate_reservations
  ADD CONSTRAINT chk_reservations_lane CHECK (lane IN ('direct', 'prefund', 'collateral'));

ALTER TABLE mandate_billable_events DROP CONSTRAINT IF EXISTS chk_billable_lane;
ALTER TABLE mandate_billable_events
  ADD CONSTRAINT chk_billable_lane CHECK (lane IN ('direct', 'prefund', 'collateral'));
