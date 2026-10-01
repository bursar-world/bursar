// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";
import {IShieldedPoolReads} from "./VerifyShielded.s.sol";

import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";
import {IStaking} from "../src/token/interfaces/IStaking.sol";

/// Checks that every call in `ProposeWiring.s.sol` took effect: the buyback's keeper is the
/// recorded keeper, every recorded resolver has its floor and nobody else can bond, the rebate
/// table is in place, the credit pool is both the staking pool's credit manager and its slasher,
/// a recorded seeder belongs to the timelock, and the previous deployment's shielded pool, when
/// `BURSAR_PREVIOUS_RECORD` names one, takes no more deposits. Nothing here is owed: unset is a
/// mismatch.
abstract contract WiringChecks is Verifier {
    function _checkWiring() internal {
        address staking = _contract(K.STAKING);
        address buyback = _contract(K.BUYBACK);
        address pool = _contract(K.CREDIT_POOL);
        if (staking == address(0) || buyback == address(0) || pool == address(0)) return;

        address keeper = _recordAddress(K.KEEPER);
        _isTrue("token.keeper is not recorded", keeper != address(0));
        _is("Buyback.keeper", keeper, Buyback(buyback).keeper());

        Staking s = Staking(staking);
        _is("Staking.creditManager", pool, s.creditManager());
        _is("Staking.slasher", pool, s.slasher());

        uint256 floor = _param("Staking.resolverBondFloor");
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);
        _isTrue("roles.resolvers is empty", resolvers.length != 0);
        for (uint256 i; i < resolvers.length; ++i) {
            _isUint(
                string.concat("Staking.bondFloorOf(", vm.toString(resolvers[i]), ")"),
                floor,
                s.bondFloorOf(resolvers[i])
            );
        }
        // The allowlist: a resolver without a floor meets a global minimum no holder can reach.
        _isTrue("Staking.minBond lets a resolver without a floor bond", s.minBond() > floor);

        IStaking.Tier[] memory live = s.tiers();
        IStaking.Tier[] memory intended = TokenConfig.rebateTiers();
        _isTrue(
            "Staking.tiers differs from the rebate table",
            keccak256(abi.encode(live)) == keccak256(abi.encode(intended))
        );

        _checkPreviousPool();

        if (_recordAddress(K.SEEDER) == address(0)) return;
        address seeder = _contract(K.SEEDER);
        if (seeder != address(0)) {
            _is("V4LiquiditySeeder.owner", _recordAddress(K.ADMIN_TIMELOCK), V4LiquiditySeeder(seeder).owner());
        }
    }

    /// The previous deployment's shielded pool is wound down by the batch: no new deposit, every
    /// note still withdrawable.
    function _checkPreviousPool() private {
        address pool = _previousAddress(K.SHIELDED_POOL);
        if (pool == address(0)) return;
        if (pool.code.length == 0) {
            _mismatch(string.concat("the previous shielded pool holds no code at ", vm.toString(pool)));
            return;
        }
        bool dead = IShieldedPoolReads(pool).dead();
        _fact("previous ShieldedPool.dead", dead);
        _isTrue("the previous shielded pool still takes deposits", dead);
    }
}

/// `forge script script/VerifyWiring.s.sol --rpc-url "$RHC_RPC_URL"`, once the wiring batch has executed.
contract VerifyWiring is WiringChecks {
    function run() external {
        _begin();
        _checkWiring();
        _end("wiring");
    }
}
