// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";
import {IShieldedPoolReads} from "./VerifyShielded.s.sol";

import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";
import {Vesting} from "../src/token/Vesting.sol";
import {IStaking} from "../src/token/interfaces/IStaking.sol";
import {V4Math} from "./lib/V4Math.sol";

/// Checks that every call in `ProposeWiring.s.sol` took effect: the buyback's keeper is the
/// recorded keeper, or with buybacks off the buyback has none and is paused, every recorded resolver has its floor and nobody else can bond, the rebate
/// table is in place, the credit pool is both the staking pool's credit manager and its slasher,
/// a recorded seeder belongs to the timelock, a carried park lists the record's treasury adapter
/// and not the previous deployment's, and the previous deployment's shielded pool, when
/// `BURSAR_PREVIOUS_RECORD` names one the record does not carry, takes no more deposits. A previous
/// token set the record replaces is closed: its buyback paused, its seeder empty, and each grant in
/// `BURSAR_VESTING_REVOKE` revoked. Nothing here is owed: unset is a mismatch.
abstract contract WiringChecks is Verifier {
    function _checkWiring() internal {
        address staking = _contract(K.STAKING);
        address buyback = _contract(K.BUYBACK);
        address pool = _contract(K.CREDIT_POOL);
        if (staking == address(0) || buyback == address(0) || pool == address(0)) return;

        if (_recordBool(K.BUYBACKS_OFF)) {
            _is("Buyback.keeper", address(0), Buyback(buyback).keeper());
            _isTrue("Buyback is not paused while buybacks are off", Buyback(buyback).paused());
        } else {
            address keeper = _recordAddress(K.KEEPER);
            _isTrue("token.keeper is not recorded", keeper != address(0));
            _is("Buyback.keeper", keeper, Buyback(buyback).keeper());
        }

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
        IStaking.Tier[] memory intended = TokenConfig.rebateTiers(_recorded(K.BURSAR));
        _isTrue(
            "Staking.tiers differs from the rebate table",
            keccak256(abi.encode(live)) == keccak256(abi.encode(intended))
        );

        _checkAdapterSwitch();
        _checkPreviousPool();
        _checkPreviousTokenSet(buyback);

        if (_recordAddress(K.SEEDER) == address(0)) return;
        address seeder = _contract(K.SEEDER);
        if (seeder != address(0)) _checkSeeder(V4LiquiditySeeder(seeder), s.admin());
    }

    /// The seeder belongs to the record's timelock. One still offered to the timelock that governs
    /// the staking pool today was the batch's to accept, and is a mismatch. One offered to the
    /// record's timelock while another governs is the governance handover's to accept, which
    /// `VerifyStaking.s.sol` lists as owed; the batch did not touch it.
    function _checkSeeder(V4LiquiditySeeder seeder, address governance) private {
        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        if (governance != timelock && seeder.pendingOwner() == timelock) {
            _fact("V4LiquiditySeeder.owner", seeder.owner());
            return;
        }
        _is("V4LiquiditySeeder.owner", timelock, seeder.owner());
    }

    /// On a park carried over from the previous deployment the batch switches treasury adapters:
    /// the record's on, the previous deployment's off.
    function _checkAdapterSwitch() private {
        address park = _recordAddress(K.TREASURY_PARK);
        address adapter = _recordAddress(K.SGOV_ADAPTER);
        address previous = _previousAddress(K.SGOV_ADAPTER);
        if (park.code.length == 0 || _previousAddress(K.TREASURY_PARK) != park) return;
        if (adapter == address(0) || previous == address(0) || previous == adapter) return;
        TreasuryPark p = TreasuryPark(park);
        _isTrue("TreasuryPark does not list the treasury adapter", p.isAdapter(adapter));
        _isTrue("TreasuryPark still lists the previous treasury adapter", !p.isAdapter(previous));
    }

    /// The previous deployment's shielded pool is wound down by the batch: no new deposit, every
    /// note still withdrawable. A pool the record carries over stays open.
    function _checkPreviousPool() private {
        address pool = _previousAddress(K.SHIELDED_POOL);
        if (pool == address(0) || pool == _recordAddress(K.SHIELDED_POOL)) return;
        if (pool.code.length == 0) {
            _mismatch(string.concat("the previous shielded pool holds no code at ", vm.toString(pool)));
            return;
        }
        bool dead = IShieldedPoolReads(pool).dead();
        _fact("previous ShieldedPool.dead", dead);
        _isTrue("the previous shielded pool still takes deposits", dead);
    }

    /// The previous token set, when the record replaces it: its buyback can no longer trade, its
    /// seeder holds no position, and the grants named in `BURSAR_VESTING_REVOKE` stopped vesting.
    function _checkPreviousTokenSet(address buyback) private {
        address previous = _previousAddress(K.BUYBACK);
        if (previous == address(0) || previous == buyback) return;
        _isTrue("the previous buyback is not paused", Buyback(previous).paused());

        address seeder = _previousAddress(K.SEEDER);
        if (seeder.code.length != 0) {
            (int24 lower, int24 upper) = V4Math.fullRangeTicks(V4LiquiditySeeder(seeder).poolTickSpacing());
            _isUint("previous V4LiquiditySeeder.liquidity", 0, V4LiquiditySeeder(seeder).liquidityOf(lower, upper));
        }

        address vesting = _previousAddress(K.VESTING);
        if (vesting.code.length == 0 || bytes(_envRaw(_key("BURSAR_VESTING_REVOKE"))).length == 0) return;
        address[] memory beneficiaries = _envAddressList("BURSAR_VESTING_REVOKE");
        for (uint256 i; i < beneficiaries.length; ++i) {
            _isTrue(
                string.concat("the previous grant to ", vm.toString(beneficiaries[i]), " is not revoked"),
                Vesting(vesting).grantOf(beneficiaries[i]).revokedAt != 0
            );
        }
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
