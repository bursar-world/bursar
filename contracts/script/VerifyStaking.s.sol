// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";
import {V4Math} from "./lib/V4Math.sol";

import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";
import {IStaking} from "../src/token/interfaces/IStaking.sol";

/// Asks the chain what `DeployStaking.s.sol` asked its simulation, and says what governance still
/// owes the set: the buyback's keeper, the resolvers' bond floors, the rebate table, and the
/// credit pool's two roles on the staking pool.
///
/// Each of those is reported as owed while it is unset, and as a mismatch once it is set to
/// anything but what the record intends. On a staking pool carried over from the previous
/// deployment, the credit pool's two roles still name that deployment's pool until the batch
/// moves them, and that too is owed. `VerifyWiring.s.sol` checks the whole batch took effect.
abstract contract StakingChecks is Verifier {
    function _checkStaking() internal {
        address staking = _contract(K.STAKING);
        address buyback = _contract(K.BUYBACK);
        if (staking == address(0) || buyback == address(0)) return;

        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        _checkPool(Staking(staking), timelock);
        _checkBuyback(Buyback(buyback), staking, timelock);
        // No seeder is recorded until the pool is open: the staking run builds one for an open
        // pool, and the seed script brings its own when it opens one.
        if (_recordAddress(K.SEEDER) == address(0)) {
            _owe("no V4LiquiditySeeder is recorded: SeedPool.s.sol opens the market");
        } else {
            _checkSeeder(V4LiquiditySeeder(_contract(K.SEEDER)), buyback, timelock);
        }

        address registry = _recordAddress(K.ORACLE_REGISTRY);
        if (registry != address(0)) {
            _is("OracleRegistry.staking", staking, address(IOracleRegistry(registry).staking()));
        }
    }

    function _checkPool(Staking staking, address timelock) private {
        _is("Staking.stakeToken", _recordAddress(K.BRSR), address(staking.stakeToken()));
        _is("Staking.rewardToken", _settlementAsset(), address(staking.rewardToken()));
        _is("Staking.admin", timelock, staking.admin());
        _pendingAdmin("Staking.pendingAdmin", staking.pendingAdmin());
        _is("Staking.slashSink", _recordAddress(K.SLASH_SINK), staking.slashSink());
        _is("Staking.treasury", _recordAddress(K.TREASURY), staking.treasury());
        _isUint("Staking.unbondingPeriod", _param("Staking.unbondingPeriod"), staking.unbondingPeriod());
        _isUint("Staking.minBond", _param("Staking.minBond"), staking.minBond());
        bool paused = staking.paused();
        _fact("Staking.paused", paused);
        _isTrue("Staking is paused", !paused);

        uint256 floor = _param("Staking.resolverBondFloor");
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);
        for (uint256 i; i < resolvers.length; ++i) {
            _governedUint(
                string.concat("Staking.bondFloorOf(", vm.toString(resolvers[i]), ")"),
                floor,
                staking.bondFloorOf(resolvers[i])
            );
        }

        // Spread in and stake out both answer to the credit pool, once governance names it. A pool
        // carried over from the previous deployment names that deployment's credit pool until the
        // wiring batch moves both roles, which is owed, not wrong.
        address pool = _recordAddress(K.CREDIT_POOL);
        address previous = _previousAddress(K.CREDIT_POOL);
        _governedFrom("Staking.creditManager", pool, previous, staking.creditManager());
        _governedFrom("Staking.slasher", pool, previous, staking.slasher());
        _fact("Staking.totalStaked", staking.totalStaked());
        _checkTiers(staking.tiers());
    }

    function _checkTiers(IStaking.Tier[] memory live) private {
        IStaking.Tier[] memory intended = TokenConfig.rebateTiers();
        if (live.length == 0) {
            _owe("Staking.tiers is empty: the rebate table is part of the wiring batch");
            return;
        }
        _isUint("Staking.tiers.length", intended.length, live.length);
        for (uint256 i; i < intended.length && i < live.length; ++i) {
            string memory tier = string.concat("Staking.tiers[", vm.toString(i), "]");
            _isUint(string.concat(tier, ".minStake"), intended[i].minStake, live[i].minStake);
            _isUint(string.concat(tier, ".rebateBps"), intended[i].rebateBps, live[i].rebateBps);
        }
    }

    function _checkBuyback(Buyback buyback, address staking, address timelock) private {
        _is("Buyback.settlementAsset", _settlementAsset(), address(buyback.settlementAsset()));
        _is("Buyback.brsr", _recordAddress(K.BRSR), address(buyback.brsr()));
        _is("Buyback.poolManager", _recordAddress(K.POOL_MANAGER), address(buyback.poolManager()));
        _is("Buyback.staking", staking, address(buyback.staking()));
        _is("Buyback.treasury", _recordAddress(K.TREASURY), buyback.treasury());
        _is("Buyback.admin", timelock, buyback.admin());
        _pendingAdmin("Buyback.pendingAdmin", buyback.pendingAdmin());
        _governed("Buyback.keeper", _recordAddress(K.KEEPER), buyback.keeper());
        _isUint("Buyback.poolFee", _param("Buyback.poolFee"), buyback.poolFee());
        _is("Buyback.poolHooks", _recordAddress(".parameters.Buyback.poolHooks"), buyback.poolHooks());

        Buyback.Params memory p = buyback.params();
        _isUint("Buyback.spendPerCall", _param("Buyback.spendPerCall"), p.spendPerCallMicroUsd);
        _isUint("Buyback.maxSpendPerWindow", _param("Buyback.maxSpendPerWindow"), p.maxSpendPerWindowMicroUsd);
        _isUint("Buyback.minSpend", _param("Buyback.minSpend"), p.minSpendMicroUsd);
        _isUint("Buyback.window", _param("Buyback.window"), p.window);
        _isUint("Buyback.minInterval", _param("Buyback.minInterval"), p.minInterval);
        // The ceiling is governance's to move, so a later value is not a mismatch. One that has aged
        // out refuses every buyback and skips every slash until it is restated.
        _fact("Buyback.maxPriceMicroUsdPerBrsr", p.maxPriceMicroUsdPerBrsr);
        _fact("Buyback.ceilingSetAt", buyback.ceilingSetAt());
        _fact("Buyback.maxCeilingAge", buyback.maxCeilingAge());
        if (p.maxPriceMicroUsdPerBrsr == 0) {
            _owe("Buyback ceiling is zero: every buyback refuses until governance sets one");
        } else if (block.timestamp > uint256(buyback.ceilingSetAt()) + buyback.maxCeilingAge()) {
            _owe("Buyback ceiling is older than maxCeilingAge: restate it with Buyback.setParams");
        }
    }

    function _checkSeeder(V4LiquiditySeeder seeder, address buyback, address timelock) private {
        if (address(seeder) == address(0)) return;
        // A seeder the seed script opened the market with is offered to governance, and is
        // governance's once the timelock accepts it.
        if (seeder.owner() != timelock && seeder.pendingOwner() == timelock) {
            _owe("V4LiquiditySeeder: the timelock has to accept ownership");
        } else {
            _is("V4LiquiditySeeder.owner", timelock, seeder.owner());
            _pendingAdmin("V4LiquiditySeeder.pendingOwner", seeder.pendingOwner());
        }
        _is("V4LiquiditySeeder.buyback", buyback, seeder.buyback());
        _is("V4LiquiditySeeder.poolManager", _recordAddress(K.POOL_MANAGER), address(seeder.poolManager()));
        _isTrue(
            "V4LiquiditySeeder.poolId differs from the recorded pool",
            seeder.poolId() == vm.parseJsonBytes32(_json(), ".token.poolId")
        );
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(seeder.poolTickSpacing());
        _fact("V4LiquiditySeeder.liquidity", seeder.liquidityOf(lower, upper));
        if (seeder.liquidityOf(lower, upper) == 0) {
            _owe("V4LiquiditySeeder holds no liquidity: the migration moves the pool's position into it");
        }
    }
}

/// `forge script script/VerifyStaking.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployStaking.s.sol`.
contract VerifyStaking is StakingChecks {
    function run() external {
        _begin();
        _checkStaking();
        _end("staking");
    }
}
