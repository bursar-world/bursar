-- Moves the lane's opening collateral asset to the one this chain has.
--
-- 0003 seeded USDC on Arc, which was the settlement asset then. BURSAR settles in USDG on
-- Robinhood Chain 4663, and USDC has no contract there, so the seeded row named collateral nobody
-- could post. The old row is kept and marked inactive rather than deleted: positions and events
-- reference it, and a deployment's history is not something a migration gets to erase.
--
-- The settlement asset is still the only collateral the lane opens with. Anything else needs a
-- haircut somebody has argued for.

INSERT INTO bursar_collateral_assets (asset_id, symbol, chain, haircut_bps, volatility_buffer_bps, status)
VALUES ('usdg-rhc', 'USDG', 'robinhood-chain', 0, 0, 'active')
ON CONFLICT (asset_id) DO NOTHING;

UPDATE bursar_collateral_assets
SET status = 'inactive', updated_at = NOW()
WHERE asset_id = 'usdc-arc' AND status = 'active';
