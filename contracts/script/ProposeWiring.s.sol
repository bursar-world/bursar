// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governance} from "./lib/Governance.sol";
import {IAdministered} from "./lib/Handover.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";
import {V4Math} from "./lib/V4Math.sol";

import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";
import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";
import {Vesting} from "../src/token/Vesting.sol";

/// The parts of the previous deployment's Entrypoint and shielded pool this batch reaches. The
/// vendored Privacy Pools code pins a compiler this script cannot import alongside the rest, so
/// the two reads and the one call are declared here.
interface IPreviousEntrypoint {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function windDownPool(address pool) external;
}

interface IPreviousShieldedPool {
    function dead() external view returns (bool);
}

/// The wiring no constructor could do, because each piece is governance's to decide: who may
/// trigger a buyback, which resolvers may bond and at what floor, the rebate a staked balance
/// earns, and the two roles the credit pool holds on the staking pool.
///
/// - `Buyback.setKeeper`, to the keeper the record names, or `Buyback.pause` when the record has
///   buybacks off: no keeper, and nobody can trade until governance unpauses it and names one.
/// - `Staking.setBondFloor` for each recorded resolver. The global floor was set above the whole
///   supply at construction, so these floors are the allowlist: nobody else can bond.
/// - `Staking.setTiers`, the rebate table in `TokenConfig`.
/// - `Staking.setCreditManager` and `Staking.setSlasher`, both to the credit pool, so its spread
///   reaches stakers and a written-off line reaches their stake.
/// - `V4LiquiditySeeder.acceptOwnership`, when the recorded seeder is one `SeedPool.s.sol` opened
///   the market with and offered to the timelock. A seeder the staking run deployed is the
///   timelock's already, and the call is left out.
/// - `TreasuryPark.setAdapter`, twice, when the record carries the park over from the previous
///   deployment and names a treasury adapter of its own: the new adapter on, the previous one off.
///   A new park lists its adapter from the deployer and needs neither.
/// - `Entrypoint.windDownPool` on the previous deployment's Entrypoint, for its shielded pool,
///   when `BURSAR_PREVIOUS_RECORD` names one the record does not carry over. The pool stops taking
///   deposits and every note in it stays withdrawable. The timelock holds that Entrypoint's owner
///   role, so the call is its.
/// - When the record replaces the previous deployment's token set, as the seventh does in moving
///   from BRSR to $BURSAR: `Buyback.pause` on the previous buyback, `V4LiquiditySeeder.removeLiquidity`
///   of the previous seeder's whole position to the treasury, and `Vesting.revoke` for each
///   beneficiary in `BURSAR_VESTING_REVOKE`, whose unvested balance returns to the treasury. The
///   previous registry's resolver bonds are not evicted here: `MigrateResolvers.s.sol` unbonds them
///   from each resolver's own key and returns them to the treasury.
///
/// A deployment that carries its staking pool and buyback over finds the keeper, the floors and
/// the rebate table already applied, and the batch proposes only what differs: the credit pool's
/// two roles, which move to the new pool, the adapter switch and the wind-down.
///
/// Each call goes to the timelock that administers its target on the chain, read as the batch is
/// built, with that timelock's delay. While a governance handover has been offered and not yet
/// accepted the record's timelock is not it, and a call put to the wrong one would wait out its
/// delay and revert.
///
/// Run after `DeployCollateral.s.sol`, from signer keys; `Governance.sol` describes the steps.
/// `VerifyWiring.s.sol` checks that every call in the batch took effect.
contract ProposeWiring is Governance {
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");

    error EntrypointNotGoverned(address entrypoint, address timelock);

    function _calls() internal view override returns (Call[] memory calls) {
        address staking = _upstream(K.STAKING);
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);
        if (resolvers.length == 0) revert NotRecorded(K.RESOLVERS);
        Call[] memory conditional = _conditional(_governs(staking));
        calls = new Call[](resolvers.length + 4 + conditional.length);
        uint256 n = _standing(calls, staking, resolvers);
        for (uint256 i; i < conditional.length; ++i) {
            calls[n + i] = conditional[i];
        }
    }

    /// The calls every batch carries: the keeper, a floor per resolver, the rebate table and the
    /// credit pool's two roles. Written into the front of `calls`; returns how many.
    function _standing(Call[] memory calls, address staking, address[] memory resolvers)
        private
        view
        returns (uint256 n)
    {
        address governance = _governs(staking);
        address buyback = _upstream(K.BUYBACK);
        address pool = _upstream(K.CREDIT_POOL);
        address keeper = _recordAddress(K.KEEPER);
        if (keeper == address(0) && !_recordBool(K.BUYBACKS_OFF)) revert NotRecorded(K.KEEPER);
        uint256 floor = _recordUint(".parameters.Staking.resolverBondFloor");

        if (_recordBool(K.BUYBACKS_OFF)) {
            calls[n++] =
                Call(_governs(buyback), buyback, abi.encodeCall(Buyback.pause, ()), "Buyback.pause, buybacks off");
        } else {
            calls[n++] =
                Call(_governs(buyback), buyback, abi.encodeCall(Buyback.setKeeper, (keeper)), "Buyback.setKeeper");
        }
        for (uint256 i; i < resolvers.length; ++i) {
            calls[n++] = Call(
                governance,
                staking,
                abi.encodeCall(Staking.setBondFloor, (resolvers[i], floor)),
                string.concat("Staking.setBondFloor ", vm.toString(resolvers[i]))
            );
        }
        calls[n++] = Call(
            governance,
            staking,
            abi.encodeCall(Staking.setTiers, (TokenConfig.rebateTiers(_recorded(K.BURSAR)))),
            "Staking.setTiers"
        );
        calls[n++] =
            Call(governance, staking, abi.encodeCall(Staking.setCreditManager, (pool)), "Staking.setCreditManager");
        calls[n++] = Call(governance, staking, abi.encodeCall(Staking.setSlasher, (pool)), "Staking.setSlasher");
    }

    /// The calls a batch carries only when the chain asks for them: the seeder's acceptance, the
    /// park's adapter switch, the previous shielded pool's wind-down and the previous token set's.
    function _conditional(address governance) private view returns (Call[] memory extra) {
        Call[] memory retired = _previousTokenSet();
        Call[] memory list = new Call[](4 + retired.length);
        uint256 n;

        address seeder = _recordAddress(K.SEEDER);
        if (seeder.code.length != 0 && V4LiquiditySeeder(seeder).pendingOwner() == governance) {
            list[n++] = Call(
                governance,
                seeder,
                abi.encodeCall(V4LiquiditySeeder.acceptOwnership, ()),
                "V4LiquiditySeeder.acceptOwnership"
            );
        }

        (address park, address adapter, address previousAdapter) = _adapterSwitch();
        if (adapter != address(0)) {
            address parkGovernance = _governs(park);
            list[n++] = Call(
                parkGovernance,
                park,
                abi.encodeCall(TreasuryPark.setAdapter, (adapter, true)),
                "TreasuryPark.setAdapter, the new treasury adapter on"
            );
            list[n++] = Call(
                parkGovernance,
                park,
                abi.encodeCall(TreasuryPark.setAdapter, (previousAdapter, false)),
                "TreasuryPark.setAdapter, the previous treasury adapter off"
            );
        }

        (address entrypoint, address previousPool) = _previousShielded(governance);
        if (previousPool != address(0)) {
            list[n++] = Call(
                governance,
                entrypoint,
                abi.encodeCall(IPreviousEntrypoint.windDownPool, (previousPool)),
                "Entrypoint.windDownPool, the previous shielded pool"
            );
        }
        for (uint256 i; i < retired.length; ++i) {
            list[n++] = retired[i];
        }

        extra = new Call[](n);
        for (uint256 i; i < n; ++i) {
            extra[i] = list[i];
        }
    }

    /// The previous deployment's buyback, seeder and vesting, closed when the record replaces its
    /// token set. Empty when the shell names no previous record or the record carries the buyback.
    function _previousTokenSet() private view returns (Call[] memory calls) {
        address buyback = _previousAddress(K.BUYBACK);
        if (buyback == address(0) || buyback == _recordAddress(K.BUYBACK)) return calls;
        _requireCode("the previous buyback", buyback);

        address seeder = _previousAddress(K.SEEDER);
        uint128 liquidity;
        int24 lower;
        int24 upper;
        if (seeder.code.length != 0) {
            (lower, upper) = V4Math.fullRangeTicks(V4LiquiditySeeder(seeder).poolTickSpacing());
            liquidity = V4LiquiditySeeder(seeder).liquidityOf(lower, upper);
        }
        address vesting = _previousAddress(K.VESTING);
        bool revoking = vesting.code.length != 0 && bytes(_envRaw(_key("BURSAR_VESTING_REVOKE"))).length != 0;
        address[] memory beneficiaries = revoking ? _envAddressList("BURSAR_VESTING_REVOKE") : new address[](0);

        calls = new Call[](1 + (liquidity == 0 ? 0 : 1) + beneficiaries.length);
        uint256 n;
        calls[n++] =
            Call(_governs(buyback), buyback, abi.encodeCall(Buyback.pause, ()), "Buyback.pause, the previous buyback");
        if (liquidity != 0) {
            // No floors: every holder of the previous token is one of this deployment's own keys, so
            // nobody outside can move the pool's price between the proposal and its execution.
            calls[n++] = Call(
                V4LiquiditySeeder(seeder).owner(),
                seeder,
                abi.encodeCall(
                    V4LiquiditySeeder.removeLiquidity, (lower, upper, liquidity, 0, 0, _recordAddress(K.TREASURY))
                ),
                "V4LiquiditySeeder.removeLiquidity, the previous position to the treasury"
            );
        }
        for (uint256 i; i < beneficiaries.length; ++i) {
            calls[n++] = Call(
                _governs(vesting),
                vesting,
                abi.encodeCall(Vesting.revoke, (beneficiaries[i])),
                string.concat("Vesting.revoke ", vm.toString(beneficiaries[i]))
            );
        }
    }

    /// The timelock that administers `target` on the chain today.
    function _governs(address target) private view returns (address timelock) {
        timelock = IAdministered(target).admin();
        _requireCode(string.concat("the admin of ", vm.toString(target)), timelock);
    }

    /// The park and the two treasury adapters to switch on it, all zero unless the record carries
    /// the park over from the previous deployment and names a treasury adapter that is not the
    /// previous one.
    function _adapterSwitch() private view returns (address park, address adapter, address previous) {
        park = _recordAddress(K.TREASURY_PARK);
        adapter = _recordAddress(K.SGOV_ADAPTER);
        previous = _previousAddress(K.SGOV_ADAPTER);
        bool carriedPark = park != address(0) && _previousAddress(K.TREASURY_PARK) == park;
        if (!carriedPark || adapter == address(0) || previous == address(0) || previous == adapter) {
            return (address(0), address(0), address(0));
        }
        _requireCode(K.SGOV_ADAPTER, adapter);
    }

    /// The previous deployment's Entrypoint and shielded pool, both zero when the shell names no
    /// previous record or the record carries that pool over. The timelock has to hold the
    /// Entrypoint's owner role, or the call would land and revert after its delay.
    function _previousShielded(address timelock) private view returns (address entrypoint, address pool) {
        pool = _previousAddress(K.SHIELDED_POOL);
        if (pool == address(0) || pool == _recordAddress(K.SHIELDED_POOL)) return (address(0), address(0));
        _requireCode(K.SHIELDED_POOL, pool);
        entrypoint = _previousAddress(K.ENTRYPOINT);
        _requireCode(K.ENTRYPOINT, entrypoint);
        if (!IPreviousEntrypoint(entrypoint).hasRole(OWNER_ROLE, timelock)) {
            revert EntrypointNotGoverned(entrypoint, timelock);
        }
    }

    function _applied(Call memory call) internal view override returns (bool) {
        bytes4 selector = bytes4(call.data);
        bytes memory args = _args(call.data);
        if (selector == Buyback.setKeeper.selector) {
            return Buyback(call.target).keeper() == abi.decode(args, (address));
        }
        if (selector == Buyback.pause.selector) return Buyback(call.target).paused();
        if (selector == V4LiquiditySeeder.removeLiquidity.selector) {
            (int24 lower, int24 upper) = V4Math.fullRangeTicks(V4LiquiditySeeder(call.target).poolTickSpacing());
            return V4LiquiditySeeder(call.target).liquidityOf(lower, upper) == 0;
        }
        if (selector == Vesting.revoke.selector) {
            return Vesting(call.target).grantOf(abi.decode(args, (address))).revokedAt != 0;
        }
        if (selector == IPreviousEntrypoint.windDownPool.selector) {
            return IPreviousShieldedPool(abi.decode(args, (address))).dead();
        }
        if (selector == TreasuryPark.setAdapter.selector) {
            (address adapter, bool enabled) = abi.decode(args, (address, bool));
            return TreasuryPark(call.target).isAdapter(adapter) == enabled;
        }
        Staking staking = Staking(call.target);
        if (selector == Staking.setBondFloor.selector) {
            (address resolver, uint256 floor) = abi.decode(args, (address, uint256));
            return staking.bondFloorOf(resolver) == floor;
        }
        if (selector == Staking.setTiers.selector) {
            return keccak256(abi.encode(staking.tiers()))
                == keccak256(abi.encode(TokenConfig.rebateTiers(_recorded(K.BURSAR))));
        }
        if (selector == Staking.setCreditManager.selector) {
            return staking.creditManager() == abi.decode(args, (address));
        }
        if (selector == Staking.setSlasher.selector) return staking.slasher() == abi.decode(args, (address));
        if (selector == V4LiquiditySeeder.acceptOwnership.selector) {
            return V4LiquiditySeeder(call.target).owner() == call.timelock;
        }
        return false;
    }

    function _args(bytes memory data) private pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }
}
