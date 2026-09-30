// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {CollateralConfig as C} from "./lib/CollateralConfig.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

import {IMandateAccountFactory} from "../src/interfaces/IMandateAccountFactory.sol";
import {Buyback, IPoolManager} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {AssetRegistry} from "../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {CreditPool} from "../src/rwa/CreditPool.sol";
import {PriceGuard} from "../src/rwa/PriceGuard.sol";

/// The collateral lane: `CreditPool`, then `CollateralVault`, then the one-time bind between them.
///
/// Everything it builds on comes from the record: the asset registry and price guard the RWA run
/// deployed, the factory whose lane-1 mandates may borrow, the staking pool whose stakers take
/// first loss, and the buyback whose price ceiling converts a write-off into BRSR. The lender, the
/// only address that can take unlent USDG back out, is named explicitly in `BURSAR_LENDER`: it is
/// who carries the lane's losses, so it is never inferred from the key that happens to sign.
///
/// Both contracts answer to the timelock from their constructors. The staking pool does not know
/// this pool yet: naming it the credit manager, so the spread reaches stakers, and the slasher, so
/// a write-off reaches their stake, is governance's, in `ProposeWiring.s.sol`.
contract DeployCollateral is BursarScript {
    struct Deployment {
        CreditPool pool;
        CollateralVault vault;
    }

    error NoTier(string symbol);
    error BuybackStakingMismatch(address found, address expected);
    error RoleCollision(string role, string otherRole, address account);

    address private asset;
    address private timelock;
    address private registry;
    address private guard;
    address private factory;
    address private staking;
    address private buyback;
    address private poolManager;
    address private lender;
    address private escrow;

    address[] private collateral;
    uint8[] private collateralTiers;

    Deployment private d;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        _load();
        _preflight(deployer);

        vm.startBroadcast(deployer);
        _deploy();
        vm.stopBroadcast();

        _verify();
        _record();
        _report(deployer);
        return d;
    }

    function _load() private {
        asset = _settlementAsset();
        timelock = _timelock();
        registry = _upstream(K.ASSET_REGISTRY);
        guard = _upstream(K.PRICE_GUARD);
        factory = _upstream(K.FACTORY);
        escrow = _upstream(K.ESCROW);
        staking = _upstream(K.STAKING);
        buyback = _upstream(K.BUYBACK);
        poolManager = _upstream(K.POOL_MANAGER);
        lender = _role(K.LENDER, "BURSAR_LENDER");

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        for (uint256 i; i < terms.length; ++i) {
            uint8 tier = C.tierOf(terms[i].symbol);
            if (tier == 0) revert NoTier(terms[i].symbol);
            collateral.push(_upstream(string.concat(K.RWA_ASSETS, ".", terms[i].symbol, ".address")));
            collateralTiers.push(tier);
        }
    }

    /// Each upstream contract answers the read that says it is the one this lane expects: the
    /// registry settles in the record's asset, the guard reads that registry, the factory builds on
    /// the record's escrow, and the buyback compounds into the record's staking pool. A pool built
    /// on a pair that disagrees would slash one deployment's stakers at another's price.
    function _preflight(address deployer) private view {
        _requireUnrecorded(K.CREDIT_POOL);
        _requireUnrecorded(K.COLLATERAL_VAULT);

        _expect("registry.settlementAsset", asset, AssetRegistry(registry).settlementAsset());
        _expect("registry.admin", timelock, AssetRegistry(registry).admin());
        _expect("guard.registry", registry, address(PriceGuard(guard).registry()));
        _expect("factory.escrow", escrow, IMandateAccountFactory(factory).escrow());
        _expect("staking.rewardToken", asset, address(Staking(staking).rewardToken()));
        _expect("staking.admin", timelock, Staking(staking).admin());
        address compoundsInto = address(Buyback(buyback).staking());
        if (compoundsInto != staking) revert BuybackStakingMismatch(compoundsInto, staking);
        _expect("buyback.poolManager", poolManager, address(Buyback(buyback).poolManager()));

        for (uint256 i; i < collateral.length; ++i) {
            if (!AssetRegistry(registry).isRegistered(collateral[i])) revert NotRecorded(K.RWA_ASSETS);
        }

        // The lender takes cash back out and carries the lane's losses. The timelock cannot be it
        // without every withdrawal becoming a proposal, and the treasury is fee revenue.
        if (lender == timelock) revert RoleCollision("lender", "timelock", lender);
        address treasury = _recordAddress(K.TREASURY);
        if (lender == treasury) revert RoleCollision("lender", "treasury", lender);
        if (lender == deployer) console2.log("BURSAR_LENDER is the deploy key: it can take unlent USDG back out");
    }

    function _deploy() private {
        d.pool = new CreditPool(
            asset, staking, buyback, timelock, lender, C.TOTAL_DEBT_CAP, C.PER_MANDATE_CAP, C.BASE_RATE_BPS, C.SLOPE_BPS
        );
        d.vault = new CollateralVault(
            AssetRegistry(registry),
            PriceGuard(guard),
            d.pool,
            IMandateAccountFactory(factory),
            IPoolManager(poolManager),
            timelock,
            C.params(),
            C.tiers(),
            collateral,
            collateralTiers
        );
        // The vault takes the pool's address in its constructor, so it exists only after the pool.
        // The deployer binds it once and nothing can rebind it.
        d.pool.bindVault(address(d.vault));
    }

    function _verify() private view {
        _expect("pool.usdg", asset, address(d.pool.usdg()));
        _expect("pool.staking", staking, address(d.pool.staking()));
        _expect("pool.buyback", buyback, address(d.pool.buyback()));
        _expect("pool.admin", timelock, d.pool.admin());
        _expect("pool.pendingAdmin", address(0), d.pool.pendingAdmin());
        _expect("pool.lender", lender, d.pool.lender());
        _expect("pool.vault", address(d.vault), d.pool.vault());
        _expectUint("pool.totalDebtCap", C.TOTAL_DEBT_CAP, d.pool.totalDebtCap());
        _expectUint("pool.perMandateCap", C.PER_MANDATE_CAP, d.pool.perMandateCap());
        _expectUint("pool.baseRateBps", C.BASE_RATE_BPS, d.pool.baseRateBps());
        _expectUint("pool.slopeBps", C.SLOPE_BPS, d.pool.slopeBps());

        _expect("vault.registry", registry, address(d.vault.registry()));
        _expect("vault.guard", guard, address(d.vault.guard()));
        _expect("vault.pool", address(d.pool), address(d.vault.pool()));
        _expect("vault.factory", factory, address(d.vault.factory()));
        _expect("vault.admin", timelock, d.vault.admin());
        _expect("vault.pendingAdmin", address(0), d.vault.pendingAdmin());
        for (uint256 i; i < collateral.length; ++i) {
            _expectUint("vault.tierOf", collateralTiers[i], d.vault.tierOf(collateral[i]));
        }
    }

    function _record() private {
        _write(K.CREDIT_POOL, address(d.pool));
        _write(K.COLLATERAL_VAULT, address(d.vault));
        _write(K.COLLATERAL_STAKING, staking);
        _write(K.LENDER, lender);
        _write(K.COLLATERAL_FROM_BLOCK, block.number);

        _writeAmount(".parameters.CreditPool.totalDebtCap", C.TOTAL_DEBT_CAP);
        _writeAmount(".parameters.CreditPool.perMandateCap", C.PER_MANDATE_CAP);
        _write(".parameters.CreditPool.baseRateBps", C.BASE_RATE_BPS);
        _write(".parameters.CreditPool.slopeBps", C.SLOPE_BPS);
        CollateralVault.Params memory p = C.params();
        _write(".parameters.CollateralVault.minBorrowHealth", p.minBorrowHealth);
        _write(".parameters.CollateralVault.liquidationTarget", p.liquidationTarget);
        _write(".parameters.CollateralVault.bountyBps", p.bountyBps);
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("CreditPool", address(d.pool));
        console2.log("  lender", lender);
        console2.log("CollateralVault", address(d.vault));
        console2.log("Pending: fund the pool, and ProposeWiring.s.sol so the spread and write-offs reach Staking");
    }
}
