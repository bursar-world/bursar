# Live deployment check: rhc-mainnet-v4

| | |
|---|---|
| Result | PASS |
| Record | `deployments/rhc-mainnet-v4.json` |
| Chain | 4663 |
| Block | 78237878 |
| Time | 2026-10-02 12:40:01 UTC |
| Endpoint | https://robinhood.drpc.org |
| Strict verify | deployment: 0 mismatched, 0 owed |
| Sourcify | 32 contracts asked, 0 not verified, 0 unanswered |

## Findings

None: every value read matches the record, and nothing is owed.

## What the chain answers

Every value the verify scripts read at block 78237878, in the order they read it.

| Read | Value |
|---|---|
| contracts.AdminTimelock | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| contracts.Reputation | 0x4FEa7af88C60988E80b065F6e2af071C7fB3F5E8 |
| contracts.Escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A |
| contracts.OracleRegistry | 0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3 |
| contracts.AgentRegistry | 0x6501ABAb6aF58549De0Dd42040240665591c6C2a |
| contracts.MandateAccountFactory | 0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562 |
| AdminTimelock.timelockPeriod | 3600 |
| AdminTimelock.guardian | 0x7cfF32B8B4DB47E2Cde5907c8F5c93EC6a095E2A |
| roles.timelockSigners | 3 |
| AdminTimelock.signer[0] | 0xb51c63568324848DfC88A09f91F06fA86771aB69 |
| AdminTimelock.signer[1] | 0x3C7facc7C72c3aCeB2EF93703813652aC9039266 |
| AdminTimelock.signer[2] | 0x1f3eE000728EF363B9F867f88BBF618F2A17c42d |
| AdminTimelock.isSigner(deploy key) | 0 |
| AdminTimelock.isSigner(guardian) | 0 |
| Reputation.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| Reputation.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| Reputation.escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A |
| Reputation.deployer | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| Reputation.baseCap | 25000000 |
| Reputation.capPerScore | 2250000 |
| Reputation.maxCap | 250000000 |
| Reputation.minScored | 1000000 |
| Reputation.edgeCap | 62500000 |
| Reputation.fullCredit | 250000000 |
| Escrow.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| Escrow.reputation | 0x4FEa7af88C60988E80b065F6e2af071C7fB3F5E8 |
| Escrow.resolver | 0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3 |
| Escrow.registry | 0x6501ABAb6aF58549De0Dd42040240665591c6C2a |
| Escrow.pauser | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| Escrow.treasury | 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21 |
| Escrow.pendingTreasury | 0x0000000000000000000000000000000000000000 |
| Escrow.deployer | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| Escrow.feeBps | 100 |
| Escrow.resolverFeeBps | 50 |
| Escrow.disputeBondBps | 500 |
| Escrow.minTtl | 300 |
| Escrow.maxTtl | 604800 |
| Escrow.disputeWindow | 3600 |
| Escrow.minLock | 10000 |
| Escrow.paused | 0 |
| OracleRegistry.escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A |
| OracleRegistry.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| OracleRegistry.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| OracleRegistry.slashSink | 0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF |
| OracleRegistry.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| OracleRegistry.deployer | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| OracleRegistry.paused | 0 |
| OracleRegistry.commitWindow | 3600 |
| OracleRegistry.revealWindow | 3600 |
| OracleRegistry.unbondingPeriod | 604800 |
| OracleRegistry.quorum | 2 |
| OracleRegistry.maxVoters | 64 |
| OracleRegistry.maxDeviation | 20 |
| OracleRegistry.slashBps | 1000 |
| OracleRegistry.staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| OracleRegistry.bondAsset | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| AgentRegistry.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| AgentRegistry.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| AgentRegistry.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| AgentRegistry.slasher | 0x0000000000000000000000000000000000000000 |
| AgentRegistry.slashSink | 0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF |
| AgentRegistry.minStake | 5000000 |
| AgentRegistry.slashBps | 1000 |
| MandateAccountFactory.escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A |
| MandateAccountFactory.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| token.BRSR | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| token.Vesting | 0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F |
| BRSR.decimals | 18 |
| BRSR.totalSupply | 1000000000000000000000000000 |
| BRSR.TOTAL_SUPPLY | 1000000000000000000000000000 |
| Vesting.token | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| Vesting.treasury | 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21 |
| Vesting.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| Vesting.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| token.Staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| token.Buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab |
| Staking.stakeToken | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| Staking.rewardToken | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| Staking.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| Staking.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| Staking.slashSink | 0xb4A7D77a710f6b1fF4cDDd9D3c9b66E3f917A4FF |
| Staking.treasury | 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21 |
| Staking.unbondingPeriod | 604800 |
| Staking.minBond | 1000000000000000000000000000 |
| Staking.paused | false |
| Staking.bondFloorOf(0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599) | 30000000000000000000000 |
| Staking.bondFloorOf(0xC284CdA6c6982447f202830f4e969F13cBcB0b94) | 30000000000000000000000 |
| Staking.bondFloorOf(0x7062A480732EC7B0F00a3D0c968356e1671dd356) | 30000000000000000000000 |
| Staking.creditManager | 0xFcE28EA7316506F3299b300C25C861F3FA071796 |
| Staking.slasher | 0xFcE28EA7316506F3299b300C25C861F3FA071796 |
| Staking.totalStaked | 0 |
| Staking.tiers.length | 4 |
| Staking.tiers[0].minStake | 25000000000000000000000 |
| Staking.tiers[0].rebateBps | 500 |
| Staking.tiers[1].minStake | 100000000000000000000000 |
| Staking.tiers[1].rebateBps | 1000 |
| Staking.tiers[2].minStake | 500000000000000000000000 |
| Staking.tiers[2].rebateBps | 2000 |
| Staking.tiers[3].minStake | 2500000000000000000000000 |
| Staking.tiers[3].rebateBps | 3000 |
| Buyback.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| Buyback.brsr | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| Buyback.poolManager | 0x8366a39CC670B4001A1121B8F6A443A643e40951 |
| Buyback.staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| Buyback.treasury | 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21 |
| Buyback.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| Buyback.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| Buyback.keeper | 0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599 |
| Buyback.poolFee | 3000 |
| Buyback.poolHooks | 0x0000000000000000000000000000000000000000 |
| Buyback.spendPerCall | 500000 |
| Buyback.maxSpendPerWindow | 5000000 |
| Buyback.minSpend | 100000 |
| Buyback.window | 86400 |
| Buyback.minInterval | 3600 |
| Buyback.maxPriceMicroUsdPerBrsr | 240 |
| Buyback.ceilingSetAt | 1790766009 |
| Buyback.maxCeilingAge | 604800 |
| token.V4LiquiditySeeder | 0x2cD0c0f114A4E7A20EF7967355E0986D0F82e125 |
| V4LiquiditySeeder.owner | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| V4LiquiditySeeder.pendingOwner | 0x0000000000000000000000000000000000000000 |
| V4LiquiditySeeder.buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab |
| V4LiquiditySeeder.poolManager | 0x8366a39CC670B4001A1121B8F6A443A643e40951 |
| V4LiquiditySeeder.liquidity | 1767766882262484 |
| rwa.AssetRegistry | 0xbd4950505d45e53740DA4941B666B3C796818393 |
| rwa.PriceGuard | 0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36 |
| rwa.StockSpendRouter | 0x4061b1346bedE97DcA8D7295977B703046fA9905 |
| rwa.TreasuryPark | 0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f |
| rwa.adapters.SGOV | 0xFb71c36F32d42251039494761A674E24d2cc712b |
| rwa.adapters.USDG | 0xC92F0275717CaB35CD5A501223bCEE042b4a5506 |
| AssetRegistry.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| AssetRegistry.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| AssetRegistry.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| AssetRegistry.assets | 4 |
| rwa.assets.SGOV.address | 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5 |
| SGOV.feed | 0xa0DF4ee0fFf975306345875E3548Fcc519577A11 |
| SGOV.bandBps | 50 |
| SGOV.perTradeCap | 0 |
| SGOV.totalCap | 1000000000 |
| rwa.assets.SPY.address | 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C |
| SPY.feed | 0x319724394D3A0e3669269846abE664Cd621f9f6A |
| SPY.bandBps | 100 |
| SPY.perTradeCap | 25000000 |
| SPY.totalCap | 0 |
| rwa.assets.NVDA.address | 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC |
| NVDA.feed | 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 |
| NVDA.bandBps | 100 |
| NVDA.perTradeCap | 25000000 |
| NVDA.totalCap | 0 |
| rwa.assets.AAPL.address | 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 |
| AAPL.feed | 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0 |
| AAPL.bandBps | 100 |
| AAPL.perTradeCap | 25000000 |
| AAPL.totalCap | 0 |
| PriceGuard.registry | 0xbd4950505d45e53740DA4941B666B3C796818393 |
| PriceGuard.accessRegistry | 0xe10b6f6B275de231345c20D14Ab812db62151b00 |
| PriceGuard.stateView | 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b |
| PriceGuard.minObservationAge | 300 |
| PriceGuard.maxObservationAge | 3600 |
| PriceGuard.maxFeedJumpBps | 1500 |
| StockSpendRouter.registry | 0xbd4950505d45e53740DA4941B666B3C796818393 |
| StockSpendRouter.guard | 0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36 |
| TreasuryPark.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| TreasuryPark.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| TreasuryPark.factories | 1 |
| TreasuryPark.factory | 0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562 |
| RobinhoodStockAdapter.park | 0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f |
| RobinhoodStockAdapter.asset | 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5 |
| RobinhoodStockAdapter.guard | 0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36 |
| UsdgAdapter.park | 0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f |
| UsdgAdapter.asset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| rwa.collateral.CreditPool | 0xFcE28EA7316506F3299b300C25C861F3FA071796 |
| rwa.collateral.CollateralVault | 0xcb2D73D7E99A5a66E2d458c05394652c04A502a7 |
| rwa.collateral.Staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| CreditPool.usdg | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| CreditPool.staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| CreditPool.buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab |
| CreditPool.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| CreditPool.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| CreditPool.lender | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| CreditPool.vault | 0xcb2D73D7E99A5a66E2d458c05394652c04A502a7 |
| CreditPool.totalDebtCap | 100000000 |
| CreditPool.perMandateCap | 10000000 |
| CreditPool.baseRateBps | 200 |
| CreditPool.slopeBps | 1800 |
| CreditPool.cash | 20000000 |
| CreditPool.totalDebt | 0 |
| CollateralVault.registry | 0xbd4950505d45e53740DA4941B666B3C796818393 |
| CollateralVault.guard | 0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36 |
| CollateralVault.pool | 0xFcE28EA7316506F3299b300C25C861F3FA071796 |
| CollateralVault.factory | 0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562 |
| CollateralVault.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| CollateralVault.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| CollateralVault.tierOf(SGOV) | 1 |
| CollateralVault.tierOf(SPY) | 2 |
| CollateralVault.tierOf(NVDA) | 3 |
| CollateralVault.tierOf(AAPL) | 3 |
| privacy.WithinMandateVerifier | 0xFF4b6B355c2A923fdf585BC4DaBec152D615B459 |
| privacy.CommittedMandateFactory | 0x227259542FE9C6b1F1899A94ec13d7A824A4B4EB |
| privacy.DisclosureRegistry | 0x2C7B264f596302806d945f42DCF242A757188994 |
| privacy.SolvencyLog | 0x9B0131e101080A19Ef5D94b47B0a4BBD7e342020 |
| CommittedMandateFactory.escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A |
| CommittedMandateFactory.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| CommittedMandateFactory.verifier | 0xFF4b6B355c2A923fdf585BC4DaBec152D615B459 |
| CommittedMandateFactory.ceiling | 25000000 |
| SolvencyLog.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| SolvencyLog.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| SolvencyLog.poster | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| privacy.shielded.Entrypoint | 0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee |
| privacy.shielded.ShieldedPool | 0xdF48d94951d4944A15d73e33fCc695bAe6161256 |
| privacy.shielded.ShieldedRelay | 0x2aC40b3A95b4B88d0Fc774E503926ad96Fbed440 |
| privacy.shielded.EntrypointImplementation | 0x20989ee637c7513428f9b1ca8020BE67c1D60f1d |
| Entrypoint.OWNER_ROLE held by the timelock | true |
| Entrypoint.OWNER_ROLE held by the deploy key | false |
| Entrypoint.ASP_POSTMAN held by the postman | true |
| Entrypoint.ASP_POSTMAN held by the deploy key | false |
| Entrypoint.implementation | 0x20989ee637c7513428f9b1ca8020BE67c1D60f1d |
| Entrypoint.assetConfig.pool | 0xdF48d94951d4944A15d73e33fCc695bAe6161256 |
| Entrypoint.minimumDeposit | 1000000 |
| Entrypoint.vettingFeeBps | 10 |
| Entrypoint.maxRelayFeeBps | 500 |
| ShieldedPool.ENTRYPOINT | 0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee |
| ShieldedPool.ASSET | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| privacy.shielded.asset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| ShieldedPool.ACCESS_REGISTRY | 0xe10b6f6B275de231345c20D14Ab812db62151b00 |
| privacy.shielded.WithdrawalVerifier | 0xE78C90A981036Db48Bd7a611974148d78417bBE0 |
| ShieldedPool.WITHDRAWAL_VERIFIER | 0xE78C90A981036Db48Bd7a611974148d78417bBE0 |
| privacy.shielded.CommitmentVerifier | 0x888922cc4F2C1428f04788823D36511b6062F85b |
| ShieldedPool.RAGEQUIT_VERIFIER | 0x888922cc4F2C1428f04788823D36511b6062F85b |
| ShieldedPool.MAX_DEPOSIT | 100000000 |
| ShieldedPool.MAX_TOTAL | 1000000000 |
| ShieldedPool.MAX_PER_DEPOSITOR | 250000000 |
| ShieldedPool.DEPOSITOR_WINDOW | 604800 |
| ShieldedPool.SCOPE | 11316643497466844207784243260997288539593440902365347383061115370798862767815 |
| ShieldedPool.dead | false |
| ShieldedRelay.POOL | 0xdF48d94951d4944A15d73e33fCc695bAe6161256 |
| ShieldedRelay.ENTRYPOINT | 0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee |
| ShieldedRelay.ACCESS_REGISTRY | 0xe10b6f6B275de231345c20D14Ab812db62151b00 |
| ShieldedRelay.MAX_FEE_BPS | 500 |
| previous ShieldedPool.dead | true |

## Source verification on Sourcify

| Contract | Address | Match |
|---|---|---|
| shielded-PoseidonT3 | 0xf967B532757ae8DfE2F9a82F956fE04730A666bA | exact_match |
| shielded-PoseidonT4 | 0xD483B2384ed0DC1395dEb401b673f8d36362757b | exact_match |
| v3-AdminTimelock | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF | exact_match |
| v3-Staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A | exact_match |
| v3-Buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab | exact_match |
| v3-V4LiquiditySeeder | 0x2cD0c0f114A4E7A20EF7967355E0986D0F82e125 | exact_match |
| v4-Reputation | 0x4FEa7af88C60988E80b065F6e2af071C7fB3F5E8 | exact_match |
| v4-Escrow | 0x11e73B5632837355e250fC236cFC2Be03aD0845A | exact_match |
| v4-OracleRegistry | 0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3 | exact_match |
| v4-AgentRegistry | 0x6501ABAb6aF58549De0Dd42040240665591c6C2a | exact_match |
| v4-MandateAccountFactory | 0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562 | exact_match |
| v4-AssetRegistry | 0xbd4950505d45e53740DA4941B666B3C796818393 | exact_match |
| v4-PriceGuard | 0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36 | exact_match |
| v4-StockSpendRouter | 0x4061b1346bedE97DcA8D7295977B703046fA9905 | exact_match |
| v4-TreasuryPark | 0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f | exact_match |
| v4-adapters-SGOV | 0xFb71c36F32d42251039494761A674E24d2cc712b | exact_match |
| v4-adapters-USDG | 0xC92F0275717CaB35CD5A501223bCEE042b4a5506 | exact_match |
| v4-CreditPool | 0xFcE28EA7316506F3299b300C25C861F3FA071796 | exact_match |
| v4-CollateralVault | 0xcb2D73D7E99A5a66E2d458c05394652c04A502a7 | exact_match |
| v4-WithinMandateVerifier | 0xFF4b6B355c2A923fdf585BC4DaBec152D615B459 | exact_match |
| v4-CommittedMandateFactory | 0x227259542FE9C6b1F1899A94ec13d7A824A4B4EB | exact_match |
| v4-DisclosureRegistry | 0x2C7B264f596302806d945f42DCF242A757188994 | exact_match |
| v4-SolvencyLog | 0x9B0131e101080A19Ef5D94b47B0a4BBD7e342020 | exact_match |
| v4-WithdrawalVerifier | 0xE78C90A981036Db48Bd7a611974148d78417bBE0 | exact_match |
| v4-CommitmentVerifier | 0x888922cc4F2C1428f04788823D36511b6062F85b | exact_match |
| v4-EntrypointImplementation | 0x20989ee637c7513428f9b1ca8020BE67c1D60f1d | exact_match |
| v4-Entrypoint | 0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee | exact_match |
| v4-ShieldedPool | 0xdF48d94951d4944A15d73e33fCc695bAe6161256 | exact_match |
| v4-ShieldedRelay | 0x2aC40b3A95b4B88d0Fc774E503926ad96Fbed440 | exact_match |
| v4-exampleMandate | 0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c | exact_match |
| v4-exampleCollateralMandate | 0x856471C6922A3ccBa6b514E316B617B5f5C4bA18 | exact_match |
| v4-exampleCommittedMandate | 0xc80D3D2C188faa94977824149CE7e63175B22F32 | exact_match |

## Endpoints tried

- https://robinhood.drpc.org answered
