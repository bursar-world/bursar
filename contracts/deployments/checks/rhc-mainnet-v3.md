# Live deployment check: rhc-mainnet-v3

| | |
|---|---|
| Result | STOPPED |
| Record | `deployments/rhc-mainnet-v3.json` |
| Chain | 4663 |
| Block | 77664830 |
| Time | 2026-10-01 20:34:30 UTC |
| Endpoint | https://rpc.mainnet.chain.robinhood.com |
| Strict verify | stopped: NotRecorded(".privacy.shielded.maxPerDepositor") |
| Sourcify | 32 contracts asked, 0 not verified, 0 unanswered |

## Findings

- the verify run stopped before its summary: NotRecorded(".privacy.shielded.maxPerDepositor")
- mismatch: Reputation.weights: 0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238 does not answer
- owed: Vesting.admin is 0x5a32Eab02454f97a39857E85b536F83EE0f844Bf: its handover to the timelock is owed
- mismatch: PriceGuard.minObservationAge: 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b does not answer
- mismatch: PriceGuard.maxObservationAge: 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b does not answer
- mismatch: PriceGuard.maxFeedJumpBps: 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b does not answer

## What the chain answers

Every value the verify scripts read at block 77664830, in the order they read it, up to where the run stopped.

| Read | Value |
|---|---|
| contracts.AdminTimelock | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| contracts.Reputation | 0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238 |
| contracts.Escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 |
| contracts.OracleRegistry | 0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF |
| contracts.AgentRegistry | 0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9 |
| contracts.MandateAccountFactory | 0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07 |
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
| Reputation.escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 |
| Reputation.deployer | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| Reputation.baseCap | 25000000 |
| Reputation.capPerScore | 2250000 |
| Reputation.maxCap | 250000000 |
| Escrow.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| Escrow.reputation | 0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238 |
| Escrow.resolver | 0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF |
| Escrow.registry | 0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9 |
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
| OracleRegistry.escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 |
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
| MandateAccountFactory.escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 |
| MandateAccountFactory.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| token.BRSR | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| token.Vesting | 0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F |
| BRSR.decimals | 18 |
| BRSR.totalSupply | 1000000000000000000000000000 |
| BRSR.TOTAL_SUPPLY | 1000000000000000000000000000 |
| Vesting.token | 0x00e503925880c4b07E5Fb70232D83aD871F57a7d |
| Vesting.treasury | 0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21 |
| Vesting.admin | 0x5a32Eab02454f97a39857E85b536F83EE0f844Bf |
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
| Staking.creditManager | 0x60736a2395F3333BB7f822CaBE5ed893F85AA15D |
| Staking.slasher | 0x60736a2395F3333BB7f822CaBE5ed893F85AA15D |
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
| rwa.AssetRegistry | 0x91BbeFa8d36aFE097D7579053efEd2EA7ebb6F0E |
| rwa.PriceGuard | 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b |
| rwa.StockSpendRouter | 0x6419E4aD018ca61775C4dc98AdfcB214425F43B4 |
| rwa.TreasuryPark | 0x2c49571a26bb090BAEa3D295B64D7230287e7459 |
| rwa.adapters.SGOV | 0xF757F9c79d4C737Eb6D132c43527949B58Ce5fBA |
| rwa.adapters.USDG | 0x8c824083F77d7d8A57d5Ca4fA9554b4688a7793d |
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
| PriceGuard.registry | 0x91BbeFa8d36aFE097D7579053efEd2EA7ebb6F0E |
| PriceGuard.accessRegistry | 0xe10b6f6B275de231345c20D14Ab812db62151b00 |
| PriceGuard.stateView | 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b |
| StockSpendRouter.registry | 0x91BbeFa8d36aFE097D7579053efEd2EA7ebb6F0E |
| StockSpendRouter.guard | 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b |
| TreasuryPark.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| TreasuryPark.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| TreasuryPark.factories | 1 |
| TreasuryPark.factory | 0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07 |
| RobinhoodStockAdapter.park | 0x2c49571a26bb090BAEa3D295B64D7230287e7459 |
| RobinhoodStockAdapter.asset | 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5 |
| RobinhoodStockAdapter.guard | 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b |
| UsdgAdapter.park | 0x2c49571a26bb090BAEa3D295B64D7230287e7459 |
| UsdgAdapter.asset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| rwa.collateral.CreditPool | 0x60736a2395F3333BB7f822CaBE5ed893F85AA15D |
| rwa.collateral.CollateralVault | 0xc1F22f29cB72d5b5CC58277E5F9c2EC2BC311b6C |
| rwa.collateral.Staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| CreditPool.usdg | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| CreditPool.staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A |
| CreditPool.buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab |
| CreditPool.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| CreditPool.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| CreditPool.lender | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| CreditPool.vault | 0xc1F22f29cB72d5b5CC58277E5F9c2EC2BC311b6C |
| CreditPool.totalDebtCap | 100000000 |
| CreditPool.perMandateCap | 10000000 |
| CreditPool.baseRateBps | 200 |
| CreditPool.slopeBps | 1800 |
| CreditPool.cash | 25000000 |
| CreditPool.totalDebt | 0 |
| CollateralVault.registry | 0x91BbeFa8d36aFE097D7579053efEd2EA7ebb6F0E |
| CollateralVault.guard | 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b |
| CollateralVault.pool | 0x60736a2395F3333BB7f822CaBE5ed893F85AA15D |
| CollateralVault.factory | 0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07 |
| CollateralVault.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| CollateralVault.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| CollateralVault.tierOf(SGOV) | 1 |
| CollateralVault.tierOf(SPY) | 2 |
| CollateralVault.tierOf(NVDA) | 3 |
| CollateralVault.tierOf(AAPL) | 3 |
| privacy.WithinMandateVerifier | 0x26B780AfF35Db0C371A2c33B8E48AA1c61962Ac3 |
| privacy.CommittedMandateFactory | 0xBF48A1e16203401432caE992F3355A4Cc3a0D9cd |
| privacy.DisclosureRegistry | 0x3F805111312Eed1076278f515D3fD2cA9370345a |
| privacy.SolvencyLog | 0x21811Ce7994fB6E49D71502b8ad13c22771B1aF3 |
| CommittedMandateFactory.escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 |
| CommittedMandateFactory.settlementAsset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| CommittedMandateFactory.verifier | 0x26B780AfF35Db0C371A2c33B8E48AA1c61962Ac3 |
| CommittedMandateFactory.ceiling | 25000000 |
| SolvencyLog.admin | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF |
| SolvencyLog.pendingAdmin | 0x0000000000000000000000000000000000000000 |
| SolvencyLog.poster | 0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4 |
| privacy.shielded.Entrypoint | 0x8baf2B9fB7D779651c2Dfd59C71ba0D2de3135F0 |
| privacy.shielded.ShieldedPool | 0x91F91bD9584D5fB57e9d2761728452c95b7b11A4 |
| privacy.shielded.ShieldedRelay | 0xc82CdEba05915F65E58a975dFb01dC9FD9CEfECc |
| privacy.shielded.EntrypointImplementation | 0xe3d710744971B17bBC05228d66579338D4d0B12b |
| Entrypoint.OWNER_ROLE held by the timelock | true |
| Entrypoint.OWNER_ROLE held by the deploy key | false |
| Entrypoint.ASP_POSTMAN held by the postman | true |
| Entrypoint.ASP_POSTMAN held by the deploy key | false |
| Entrypoint.implementation | 0xe3d710744971B17bBC05228d66579338D4d0B12b |
| Entrypoint.assetConfig.pool | 0x91F91bD9584D5fB57e9d2761728452c95b7b11A4 |
| Entrypoint.minimumDeposit | 1000000 |
| Entrypoint.vettingFeeBps | 10 |
| Entrypoint.maxRelayFeeBps | 500 |
| ShieldedPool.ENTRYPOINT | 0x8baf2B9fB7D779651c2Dfd59C71ba0D2de3135F0 |
| ShieldedPool.ASSET | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| privacy.shielded.asset | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 |
| ShieldedPool.ACCESS_REGISTRY | 0xe10b6f6B275de231345c20D14Ab812db62151b00 |
| privacy.shielded.WithdrawalVerifier | 0xD9869A7a4b8C878558D09aF705D9F81da0f864FE |
| ShieldedPool.WITHDRAWAL_VERIFIER | 0xD9869A7a4b8C878558D09aF705D9F81da0f864FE |
| privacy.shielded.CommitmentVerifier | 0x0A36E95bAc3C354E27223c4033842Eec786690e3 |
| ShieldedPool.RAGEQUIT_VERIFIER | 0x0A36E95bAc3C354E27223c4033842Eec786690e3 |
| ShieldedPool.MAX_DEPOSIT | 100000000 |
| ShieldedPool.MAX_TOTAL | 1000000000 |

## Source verification on Sourcify

| Contract | Address | Match |
|---|---|---|
| shielded-PoseidonT3 | 0xf967B532757ae8DfE2F9a82F956fE04730A666bA | exact_match |
| shielded-PoseidonT4 | 0xD483B2384ed0DC1395dEb401b673f8d36362757b | exact_match |
| v3-AdminTimelock | 0xD91A6577828424E386900D0bB41596c6eF3BF8DF | exact_match |
| v3-Reputation | 0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238 | exact_match |
| v3-Escrow | 0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919 | exact_match |
| v3-OracleRegistry | 0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF | exact_match |
| v3-AgentRegistry | 0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9 | exact_match |
| v3-MandateAccountFactory | 0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07 | exact_match |
| v3-Staking | 0x31CbD06003089B00897F0d7e3c283C66a1768d9A | exact_match |
| v3-Buyback | 0x51a88fb749738CB31ddb1F35A426ab2189F45eab | exact_match |
| v3-V4LiquiditySeeder | 0x2cD0c0f114A4E7A20EF7967355E0986D0F82e125 | exact_match |
| v3-AssetRegistry | 0x91BbeFa8d36aFE097D7579053efEd2EA7ebb6F0E | exact_match |
| v3-PriceGuard | 0xEcCDd1cBb5474cBe98f3038A864182F2766dFd8b | exact_match |
| v3-StockSpendRouter | 0x6419E4aD018ca61775C4dc98AdfcB214425F43B4 | exact_match |
| v3-TreasuryPark | 0x2c49571a26bb090BAEa3D295B64D7230287e7459 | exact_match |
| v3-adapters-SGOV | 0xF757F9c79d4C737Eb6D132c43527949B58Ce5fBA | exact_match |
| v3-adapters-USDG | 0x8c824083F77d7d8A57d5Ca4fA9554b4688a7793d | exact_match |
| v3-CreditPool | 0x60736a2395F3333BB7f822CaBE5ed893F85AA15D | exact_match |
| v3-CollateralVault | 0xc1F22f29cB72d5b5CC58277E5F9c2EC2BC311b6C | exact_match |
| v3-WithinMandateVerifier | 0x26B780AfF35Db0C371A2c33B8E48AA1c61962Ac3 | exact_match |
| v3-CommittedMandateFactory | 0xBF48A1e16203401432caE992F3355A4Cc3a0D9cd | exact_match |
| v3-DisclosureRegistry | 0x3F805111312Eed1076278f515D3fD2cA9370345a | exact_match |
| v3-SolvencyLog | 0x21811Ce7994fB6E49D71502b8ad13c22771B1aF3 | exact_match |
| v3-WithdrawalVerifier | 0xD9869A7a4b8C878558D09aF705D9F81da0f864FE | exact_match |
| v3-CommitmentVerifier | 0x0A36E95bAc3C354E27223c4033842Eec786690e3 | exact_match |
| v3-EntrypointImplementation | 0xe3d710744971B17bBC05228d66579338D4d0B12b | exact_match |
| v3-Entrypoint | 0x8baf2B9fB7D779651c2Dfd59C71ba0D2de3135F0 | exact_match |
| v3-ShieldedPool | 0x91F91bD9584D5fB57e9d2761728452c95b7b11A4 | exact_match |
| v3-ShieldedRelay | 0xc82CdEba05915F65E58a975dFb01dC9FD9CEfECc | exact_match |
| v3-exampleMandate | 0x4a373BFCc5bb36dc6cA10C407189c45eb40058E5 | exact_match |
| v3-exampleCollateralMandate | 0x6CE1bF2833C8790e7D63E988FA308727a04dFDDA | exact_match |
| v3-exampleCommittedMandate | 0x322b062E4B7989B9C80FCfeBed61A721Ebf3c633 | exact_match |

## Endpoints tried

- https://rpc.mainnet.chain.robinhood.com answered
