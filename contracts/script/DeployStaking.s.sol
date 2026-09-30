// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IUsdg} from "./interfaces/IUsdg.sol";
import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IStateView} from "../src/rwa/interfaces/IRwaExternal.sol";
import {Buyback, PoolKey} from "../src/token/Buyback.sol";
import {BRSR} from "../src/token/BRSR.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

/// Builds the token's economics on the BRSR the record names: the staking pool that holds
/// resolver bonds and first-loss stake, the buyback that turns treasury USDG into staked BRSR, and
/// the seeder that holds the BRSR/USDG position the buyback trades against. Then it closes the
/// last one-shot pairing in the core set, `OracleRegistry.setStaking`, from the key that deployed
/// the registry.
///
/// All three answer to the timelock from their constructors, so no part of this set is ever
/// administered by the deploy key. That is also why this run leaves four things to governance:
/// the buyback's keeper, the resolvers' bond floors, and the credit pool's slasher and credit
/// manager roles on the staking pool, the last two because the credit pool does not exist until
/// `DeployCollateral.s.sol`. `ProposeWiring.s.sol` puts all of them to the signers in one batch.
///
/// The bond floor for everyone starts at `BURSAR_STAKING_MIN_BOND`. At 1e27, more BRSR than exists,
/// nobody can bond until governance names a floor for a vetted resolver, which is the allowlist:
/// closed from the first block rather than open until a proposal lands.
///
/// The pool the buyback trades is named by five values fixed at construction. On Robinhood Chain
/// it is the BRSR/USDG pool that is already open, and the seeder deployed here, owned by the
/// timelock, is where the migration moves the existing position. On a chain where the pool is not
/// open yet there is no position to hold: `SeedPool.s.sol` opens the market at a price someone
/// chose, brings its own seeder and hands it to governance.
contract DeployStaking is BursarScript {
    uint8 internal constant BRSR_DECIMALS = 18;
    uint256 internal constant BRSR_SUPPLY = 1_000_000_000e18;

    /// Mirrors the buyback's own bound. A number entered in the wrong unit is named here, before a
    /// constructor hits it halfway through the run.
    uint128 internal constant MAX_PRICE_MICRO_USD_PER_BRSR = 1e12;

    /// v4 caps a static fee at 100%, expressed in hundredths of a basis point, and reserves the top
    /// bit for the dynamic-fee marker.
    uint24 internal constant MAX_POOL_FEE = 1_000_000;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant MAX_TICK_SPACING = 32_767;

    /// How long a buyback trusts a ceiling after governance restates it, as the buyback sets it.
    uint64 internal constant CEILING_AGE = 7 days;

    struct Deployment {
        address staking;
        address buyback;
        address seeder;
    }

    error NotBrsr(address token);
    error AssetDecimalsMismatch(address asset, uint8 found, uint8 expected);
    error OracleRegistryNotReady(string what, address found, address expected);
    error PoolHookNotContract(address hooks);
    error DynamicFeePoolRejected();
    error PoolFeeTooLarge(uint24 fee, uint24 max);
    error TickSpacingOutOfRange(int24 tickSpacing);
    error PriceCeilingNotAPrice(uint128 value, uint128 max);
    error BondFloorZero();
    error RoleCollision(string role, string otherRole, address account);
    error AddressFrozen(string role, address account);

    address private asset;
    address private timelock;
    address private brsr;
    address private treasury;
    address private slashSink;
    address private poolManager;
    address private stateView;
    bool private poolOpen;
    address private oracleRegistry;
    address private keeper;
    address[] private resolvers;

    uint64 private unbondingPeriod;
    uint256 private minBond;
    uint256 private bondFloor;

    uint24 private poolFee;
    int24 private poolTickSpacing;
    address private poolHooks;
    Buyback.Params private buybackParams;

    Staking private staking;
    Buyback private buyback;
    V4LiquiditySeeder private seeder;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        _loadEnv();
        _preflight(deployer);

        vm.startBroadcast(deployer);
        _deploy();
        vm.stopBroadcast();

        _verify();
        _record();
        _report(deployer);

        return Deployment({staking: address(staking), buyback: address(buyback), seeder: address(seeder)});
    }

    function _loadEnv() private {
        asset = _settlementAsset();
        timelock = _timelock();
        brsr = _upstream(K.BRSR);
        treasury = _role(K.TREASURY, "BURSAR_TREASURY");
        slashSink = _role(K.SLASH_SINK, "BURSAR_SLASH_SINK");

        // The manager is Uniswap's, not ours, so it lives with the chain's other outside
        // contracts. A parameter file that still names one has to name the same.
        poolManager = _upstream(K.POOL_MANAGER);
        address named = _envAddressOr("BURSAR_BUYBACK_POOL_MANAGER", address(0));
        if (named != address(0) && named != poolManager) revert RecordMismatch(K.POOL_MANAGER, poolManager, named);
        stateView = _upstream(K.STATE_VIEW);

        // Optional: a chain whose core set is not deployed yet has no registry to wire, and the
        // report says so. A recorded one has to hold code.
        oracleRegistry = _recordAddress(K.ORACLE_REGISTRY);
        if (oracleRegistry != address(0)) _requireCode(K.ORACLE_REGISTRY, oracleRegistry);

        resolvers = _recordAddresses(K.RESOLVERS);
        if (resolvers.length == 0) resolvers = _envAddressList("BURSAR_RESOLVERS");

        // Until a keeper service runs, the first resolver's key calls the buyback. It already
        // signs on a schedule, and the role can move by proposal the day a dedicated key exists.
        keeper = _roleOr(K.KEEPER, "BURSAR_BUYBACK_KEEPER", resolvers[0]);

        unbondingPeriod = _envUint64("BURSAR_STAKING_UNBONDING_PERIOD");
        minBond = _envUint("BURSAR_STAKING_MIN_BOND");
        bondFloor = _envUint("BURSAR_RESOLVER_BOND_FLOOR");

        poolFee = _envUint24("BURSAR_BUYBACK_POOL_FEE");
        poolTickSpacing = _envInt24("BURSAR_BUYBACK_POOL_TICK_SPACING");
        // Zero is the ordinary case for a pool with no hook, so this one read takes the sentinel
        // and accepts the zero address.
        poolHooks = _envAddressOr("BURSAR_BUYBACK_POOL_HOOKS", UNSET_ADDRESS);
        if (poolHooks == UNSET_ADDRESS) revert MissingEnv(_key("BURSAR_BUYBACK_POOL_HOOKS"));

        (address c0, address c1) = asset < brsr ? (asset, brsr) : (brsr, asset);
        bytes32 id = keccak256(
            abi.encode(
                PoolKey({currency0: c0, currency1: c1, fee: poolFee, tickSpacing: poolTickSpacing, hooks: poolHooks})
            )
        );
        (uint160 sqrtPriceX96,,,) = IStateView(stateView).getSlot0(id);
        poolOpen = sqrtPriceX96 != 0;

        _refuseRetired("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR");
        buybackParams = Buyback.Params({
            spendPerCallMicroUsd: _envUint128("BURSAR_BUYBACK_SPEND_PER_CALL"),
            maxSpendPerWindowMicroUsd: _envUint128("BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW"),
            minSpendMicroUsd: _envUint128("BURSAR_BUYBACK_MIN_SPEND"),
            // Unset deploys a ceiling of zero, which refuses every trade. That is the right state
            // for a buyback whose pool has no price yet.
            maxPriceMicroUsdPerBrsr: _envUint128Or("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", 0),
            window: _envUint64("BURSAR_BUYBACK_WINDOW"),
            minInterval: _envUint64("BURSAR_BUYBACK_MIN_INTERVAL")
        });
    }

    /// Everything checkable before a transaction is sent. `setStaking` takes one call and decides
    /// the currency of every future bond, so a failure after it is a redeploy of this whole set.
    function _preflight(address deployer) private view {
        _requireUnrecorded(K.STAKING);
        _requireUnrecorded(K.BUYBACK);
        _requireUnrecorded(K.SEEDER);

        // Identity, not just code: the buyback's whole arithmetic is one conversion between a
        // six-decimal price and an eighteen-decimal token.
        try IERC20Metadata(brsr).decimals() returns (uint8 decimals) {
            if (decimals != BRSR_DECIMALS) revert AssetDecimalsMismatch(brsr, decimals, BRSR_DECIMALS);
        } catch {
            revert NoAnswer("BRSR.decimals", brsr);
        }
        if (BRSR(brsr).TOTAL_SUPPLY() != BRSR_SUPPLY) revert NotBrsr(brsr);
        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        if (assetDecimals != SETTLEMENT_DECIMALS) {
            revert AssetDecimalsMismatch(asset, assetDecimals, SETTLEMENT_DECIMALS);
        }

        if (oracleRegistry != address(0)) {
            IOracleRegistry registry = IOracleRegistry(oracleRegistry);
            address registryDeployer = registry.deployer();
            if (registryDeployer != deployer) revert OracleRegistryNotReady("deployer", registryDeployer, deployer);
            address wired = address(registry.staking());
            if (wired != address(0)) revert OracleRegistryNotReady("staking", wired, address(0));
            address registryAsset = registry.settlementAsset();
            if (registryAsset != asset) revert OracleRegistryNotReady("settlementAsset", registryAsset, asset);
        }

        // A pool with no hook is the ordinary shape. A hook address with no code behind it is a
        // pool key that will never match a live pool, and every buyback would revert.
        if (poolHooks != address(0) && poolHooks.code.length == 0) revert PoolHookNotContract(poolHooks);
        // A dynamic-fee pool lets its hook set the fee per swap, which hands the venue a lever
        // over the price of every buyback this contract will ever make.
        if (poolFee == DYNAMIC_FEE_FLAG) revert DynamicFeePoolRejected();
        if (poolFee > MAX_POOL_FEE) revert PoolFeeTooLarge(poolFee, MAX_POOL_FEE);
        if (poolTickSpacing <= 0 || poolTickSpacing > MAX_TICK_SPACING) revert TickSpacingOutOfRange(poolTickSpacing);
        if (buybackParams.maxPriceMicroUsdPerBrsr > MAX_PRICE_MICRO_USD_PER_BRSR) {
            revert PriceCeilingNotAPrice(buybackParams.maxPriceMicroUsdPerBrsr, MAX_PRICE_MICRO_USD_PER_BRSR);
        }
        if (bondFloor == 0) revert BondFloorZero();

        // Slashed stake and fee revenue answer to different people and must not pool at one
        // address, and neither may be the key that signs from a shell.
        if (treasury == deployer) revert RoleCollision("treasury", "deployer", treasury);
        if (slashSink == deployer) revert RoleCollision("slashSink", "deployer", slashSink);
        if (slashSink == treasury) revert RoleCollision("slashSink", "treasury", slashSink);
        if (keeper == deployer) revert RoleCollision("keeper", "deployer", keeper);

        // The buyback pays USDG to the pool manager on every call. A frozen address cannot, and
        // the failure would read as a broken pool rather than a frozen address.
        if (block.chainid == RHC_CHAIN_ID) {
            if (IUsdg(asset).isFrozen(poolManager)) revert AddressFrozen("poolManager", poolManager);
            if (IUsdg(asset).isFrozen(treasury)) revert AddressFrozen("treasury", treasury);
        }
    }

    function _deploy() private {
        staking = new Staking(IERC20(brsr), IERC20(asset), timelock, slashSink, treasury, unbondingPeriod, minBond);

        // The last wiring call in the core set, and the one that puts resolver bonds in BRSR.
        if (oracleRegistry != address(0)) IOracleRegistry(oracleRegistry).setStaking(address(staking));

        buyback = new Buyback(
            asset,
            brsr,
            poolManager,
            poolFee,
            poolTickSpacing,
            poolHooks,
            address(staking),
            timelock,
            treasury,
            buybackParams
        );

        // Owned by governance from its first block. Anyone may add to the position; only the
        // timelock can take liquidity back out.
        if (poolOpen) seeder = new V4LiquiditySeeder(poolManager, address(buyback), timelock);
        else seeder = V4LiquiditySeeder(address(0));
    }

    /// The same questions `VerifyStaking.s.sol` asks the chain, asked of the simulation first so a
    /// wrong answer stops the run with nothing sent.
    function _verify() private view {
        _expect("staking.stakeToken", brsr, address(staking.stakeToken()));
        _expect("staking.rewardToken", asset, address(staking.rewardToken()));
        _expect("staking.admin", timelock, staking.admin());
        _expect("staking.pendingAdmin", address(0), staking.pendingAdmin());
        _expect("staking.slashSink", slashSink, staking.slashSink());
        _expect("staking.treasury", treasury, staking.treasury());
        _expectUint("staking.unbondingPeriod", unbondingPeriod, staking.unbondingPeriod());
        _expectUint("staking.minBond", minBond, staking.minBond());
        _expectUint("staking.totalShares", 0, staking.totalShares());
        // Stated rather than assumed: nothing can pay spread in or take stake until governance
        // names the credit pool, which is part of the wiring batch.
        _expect("staking.creditManager", address(0), staking.creditManager());
        _expect("staking.slasher", address(0), staking.slasher());

        if (oracleRegistry != address(0)) {
            IOracleRegistry registry = IOracleRegistry(oracleRegistry);
            _expect("oracleRegistry.staking", address(staking), address(registry.staking()));
            _expect("oracleRegistry.bondAsset", brsr, address(registry.bondAsset()));
        }

        _expect("buyback.settlementAsset", asset, address(buyback.settlementAsset()));
        _expect("buyback.brsr", brsr, address(buyback.brsr()));
        _expect("buyback.poolManager", poolManager, address(buyback.poolManager()));
        _expect("buyback.staking", address(staking), address(buyback.staking()));
        _expect("buyback.treasury", treasury, buyback.treasury());
        _expect("buyback.admin", timelock, buyback.admin());
        _expect("buyback.pendingAdmin", address(0), buyback.pendingAdmin());
        _expect("buyback.keeper", address(0), buyback.keeper());
        _expectUint("buyback.maxCeilingAge", CEILING_AGE, buyback.maxCeilingAge());

        // The pool key is re-derived, not echoed. Sorting decides the swap direction, and a
        // direction taken from the wrong side of the comparison would sell the treasury's USDG
        // instead of buying with it.
        (address c0, address c1) = asset < brsr ? (asset, brsr) : (brsr, asset);
        _expect("buyback.currency0", c0, buyback.currency0());
        _expect("buyback.currency1", c1, buyback.currency1());
        _expectUint("buyback.poolFee", poolFee, buyback.poolFee());
        _expect("buyback.poolHooks", poolHooks, buyback.poolHooks());
        _expectUint("buyback.settlementIsCurrency0", asset == c0 ? 1 : 0, buyback.settlementIsCurrency0() ? 1 : 0);

        Buyback.Params memory applied = buyback.params();
        _expectUint("buyback.spendPerCall", buybackParams.spendPerCallMicroUsd, applied.spendPerCallMicroUsd);
        _expectUint(
            "buyback.maxSpendPerWindow", buybackParams.maxSpendPerWindowMicroUsd, applied.maxSpendPerWindowMicroUsd
        );
        _expectUint("buyback.minSpend", buybackParams.minSpendMicroUsd, applied.minSpendMicroUsd);
        _expectUint("buyback.maxPrice", buybackParams.maxPriceMicroUsdPerBrsr, applied.maxPriceMicroUsdPerBrsr);
        _expectUint("buyback.window", buybackParams.window, applied.window);
        _expectUint("buyback.minInterval", buybackParams.minInterval, applied.minInterval);

        if (!poolOpen) return;
        _expect("seeder.owner", timelock, seeder.owner());
        _expect("seeder.pendingOwner", address(0), seeder.pendingOwner());
        _expect("seeder.buyback", address(buyback), seeder.buyback());
        _expect("seeder.poolManager", poolManager, address(seeder.poolManager()));
        if (seeder.poolId() != _poolId()) revert WiringFailed("seeder.poolId", address(buyback), address(seeder));
    }

    function _poolId() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                PoolKey({
                    currency0: buyback.currency0(),
                    currency1: buyback.currency1(),
                    fee: buyback.poolFee(),
                    tickSpacing: buyback.poolTickSpacing(),
                    hooks: buyback.poolHooks()
                })
            )
        );
    }

    function _record() private {
        _write(K.TREASURY, treasury);
        _write(K.SLASH_SINK, slashSink);
        _write(K.RESOLVERS, resolvers);
        _write(K.STAKING, address(staking));
        _write(K.BUYBACK, address(buyback));
        if (poolOpen) _write(K.SEEDER, address(seeder));
        _write(K.KEEPER, keeper);
        _write(".token.poolId", _poolId());
        _write(K.TOKEN_FROM_BLOCK, block.number);

        _write(".parameters.Staking.unbondingPeriod", unbondingPeriod);
        _writeAmount(".parameters.Staking.minBond", minBond);
        _writeAmount(".parameters.Staking.resolverBondFloor", bondFloor);
        _writeAmount(".parameters.Buyback.spendPerCall", buybackParams.spendPerCallMicroUsd);
        _writeAmount(".parameters.Buyback.maxSpendPerWindow", buybackParams.maxSpendPerWindowMicroUsd);
        _writeAmount(".parameters.Buyback.minSpend", buybackParams.minSpendMicroUsd);
        _writeAmount(".parameters.Buyback.maxPriceMicroUsdPerBrsr", buybackParams.maxPriceMicroUsdPerBrsr);
        _write(".parameters.Buyback.window", buybackParams.window);
        _write(".parameters.Buyback.minInterval", buybackParams.minInterval);
        _write(".parameters.Buyback.poolFee", poolFee);
        // forge-lint: disable-next-line(unsafe-typecast)
        _write(".parameters.Buyback.poolTickSpacing", uint256(uint24(poolTickSpacing)));
        _write(".parameters.Buyback.poolHooks", poolHooks);
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("Staking", address(staking));
        console2.log("  minBond, BRSR wei, for any resolver without a floor", minBond);
        console2.log("Buyback", address(buyback));
        console2.log("  maxPriceMicroUsdPerBrsr", buybackParams.maxPriceMicroUsdPerBrsr);
        if (poolOpen) {
            console2.log("V4LiquiditySeeder", address(seeder));
            console2.log("  owner", timelock);
        } else {
            console2.log("The BRSR/USDG pool is not open: SeedPool.s.sol opens it and records its seeder");
        }
        if (oracleRegistry == address(0)) {
            console2.log("  no OracleRegistry in the record: resolver bonds stay closed");
        } else {
            console2.log("  resolver bonds now post to", oracleRegistry);
        }
        console2.log("Next: ProposeWiring.s.sol, once DeployCollateral.s.sol has recorded the credit pool");
        console2.log("  keeper to set", keeper);
        console2.log("  floor to set per resolver, BRSR wei", bondFloor);
    }
}
