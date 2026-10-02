// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Every path a script reads or writes in a deployment record, named once so the deploy
/// scripts, the verify scripts and the tests agree on them. `deployments/schema.json` describes
/// the same layout.
///
/// Each section holds one part of the deployment: the contracts it deployed, the operators that
/// part answers to, and the block it started at. `contracts` holds the core six under the names
/// the TypeScript address book reads, and `rwa`, `privacy` and their nested `collateral` and
/// `shielded` sections keep the shape it reads too.
library RecordKeys {
    string internal constant NETWORK = ".network";
    string internal constant CHAIN_ID = ".chainId";
    string internal constant STATUS = ".status";
    string internal constant LOCAL = ".local";
    string internal constant SETTLEMENT_ASSET = ".settlementAsset";
    string internal constant SETTLEMENT_DECIMALS = ".settlementDecimals";
    string internal constant DEPLOYER = ".deployer";
    string internal constant FROM_BLOCK = ".fromBlock";
    string internal constant SUPERSEDES = ".supersedes";
    string internal constant SUPERSEDED_BY = ".supersededBy";
    string internal constant RETIRED = ".retired";

    string internal constant POOL_MANAGER = ".external.PoolManager";
    string internal constant STATE_VIEW = ".external.StateView";
    string internal constant ACCESS_REGISTRY = ".external.AccessRegistry";
    string internal constant EXTERNAL_ASSETS = ".external.assets";
    string internal constant EXTERNAL_POSEIDON_T3 = ".external.PoseidonT3";
    string internal constant EXTERNAL_POSEIDON_T4 = ".external.PoseidonT4";

    string internal constant SIGNERS = ".roles.timelockSigners";
    string internal constant GUARDIAN = ".roles.guardian";
    string internal constant TREASURY = ".roles.treasury";
    string internal constant SLASH_SINK = ".roles.slashSink";
    string internal constant LIQUIDITY = ".roles.liquidity";
    string internal constant COMMUNITY = ".roles.community";
    string internal constant RESOLVERS = ".roles.resolvers";

    string internal constant ADMIN_TIMELOCK = ".contracts.AdminTimelock";
    /// The escrow's pauser, when it is not the timelock: the one-shot setter named the first
    /// governance, and a later one administers everything else.
    string internal constant ESCROW_PAUSER = ".contracts.escrowPauser";
    string internal constant REPUTATION = ".contracts.Reputation";
    string internal constant ESCROW = ".contracts.Escrow";
    string internal constant ORACLE_REGISTRY = ".contracts.OracleRegistry";
    string internal constant AGENT_REGISTRY = ".contracts.AgentRegistry";
    string internal constant FACTORY = ".contracts.MandateAccountFactory";

    string internal constant BRSR = ".token.BRSR";
    string internal constant VESTING = ".token.Vesting";
    string internal constant STAKING = ".token.Staking";
    string internal constant BUYBACK = ".token.Buyback";
    string internal constant SEEDER = ".token.V4LiquiditySeeder";
    string internal constant KEEPER = ".token.keeper";
    string internal constant TOKEN_FROM_BLOCK = ".token.fromBlock";

    string internal constant ASSET_REGISTRY = ".rwa.AssetRegistry";
    string internal constant PRICE_GUARD = ".rwa.PriceGuard";
    string internal constant STOCK_ROUTER = ".rwa.StockSpendRouter";
    string internal constant TREASURY_PARK = ".rwa.TreasuryPark";
    string internal constant SGOV_ADAPTER = ".rwa.adapters.SGOV";
    string internal constant USDG_ADAPTER = ".rwa.adapters.USDG";
    string internal constant RWA_ASSETS = ".rwa.assets";
    string internal constant RWA_FROM_BLOCK = ".rwa.fromBlock";

    string internal constant CREDIT_POOL = ".rwa.collateral.CreditPool";
    string internal constant COLLATERAL_VAULT = ".rwa.collateral.CollateralVault";
    string internal constant COLLATERAL_STAKING = ".rwa.collateral.Staking";
    string internal constant LENDER = ".rwa.collateral.lender";
    string internal constant COLLATERAL_FROM_BLOCK = ".rwa.collateral.fromBlock";

    string internal constant VERIFIER = ".privacy.WithinMandateVerifier";
    string internal constant COMMITTED_FACTORY = ".privacy.CommittedMandateFactory";
    string internal constant DISCLOSURES = ".privacy.DisclosureRegistry";
    string internal constant SOLVENCY_LOG = ".privacy.SolvencyLog";
    string internal constant SOLVENCY_POSTER = ".privacy.solvencyPoster";
    string internal constant PRIVACY_FROM_BLOCK = ".privacy.fromBlock";

    string internal constant POSEIDON_T3 = ".privacy.shielded.PoseidonT3";
    string internal constant POSEIDON_T4 = ".privacy.shielded.PoseidonT4";
    string internal constant WITHDRAWAL_VERIFIER = ".privacy.shielded.WithdrawalVerifier";
    string internal constant COMMITMENT_VERIFIER = ".privacy.shielded.CommitmentVerifier";
    string internal constant ENTRYPOINT_IMPLEMENTATION = ".privacy.shielded.EntrypointImplementation";
    string internal constant ENTRYPOINT = ".privacy.shielded.Entrypoint";
    string internal constant SHIELDED_POOL = ".privacy.shielded.ShieldedPool";
    string internal constant SHIELDED_RELAY = ".privacy.shielded.ShieldedRelay";
    string internal constant SHIELDED_ACCESS_REGISTRY = ".privacy.shielded.AccessRegistry";
    string internal constant SHIELDED_ASSET = ".privacy.shielded.asset";
    string internal constant SHIELDED_SCOPE = ".privacy.shielded.scope";
    string internal constant SHIELDED_MAX_DEPOSIT = ".privacy.shielded.maxDeposit";
    string internal constant SHIELDED_MAX_TOTAL = ".privacy.shielded.maxTotal";
    string internal constant SHIELDED_MAX_PER_DEPOSITOR = ".privacy.shielded.maxPerDepositor";
    string internal constant SHIELDED_DEPOSITOR_WINDOW = ".privacy.shielded.depositorWindow";
    string internal constant SHIELDED_MIN_DEPOSIT = ".privacy.shielded.minimumDeposit";
    string internal constant SHIELDED_VETTING_FEE = ".privacy.shielded.vettingFeeBps";
    string internal constant SHIELDED_MAX_RELAY_FEE = ".privacy.shielded.maxRelayFeeBps";
    string internal constant ASP_POSTMAN = ".privacy.shielded.aspPostman";
    string internal constant SHIELDED_RELAYER = ".privacy.shielded.relayer";
    string internal constant SHIELDED_FROM_BLOCK = ".privacy.shielded.fromBlock";

    /// The 48-hour governance that replaces the first timelock: deployed first, handed everything,
    /// then written into `contracts.AdminTimelock` by the last step. `previous` is the timelock it
    /// replaced, which keeps the escrow's brake.
    string internal constant GOVERNANCE48_TIMELOCK = ".governance48.AdminTimelock";
    string internal constant GOVERNANCE48_SIGNERS = ".governance48.signers";
    string internal constant GOVERNANCE48_GUARDIAN = ".governance48.guardian";
    string internal constant GOVERNANCE48_PERIOD = ".governance48.timelockPeriod";
    string internal constant GOVERNANCE48_PREVIOUS = ".governance48.previous";
    string internal constant GOVERNANCE48_FROM_BLOCK = ".governance48.fromBlock";

    /// What each contract was deployed with, as applied. The verify scripts read these back.
    string internal constant PARAMETERS = ".parameters";
}
