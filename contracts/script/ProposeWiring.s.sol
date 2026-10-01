// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governance} from "./lib/Governance.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";

import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../src/token/V4LiquiditySeeder.sol";

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
/// - `Buyback.setKeeper`, to the keeper the record names.
/// - `Staking.setBondFloor` for each recorded resolver. The global floor was set above the whole
///   supply at construction, so these floors are the allowlist: nobody else can bond.
/// - `Staking.setTiers`, the rebate table in `TokenConfig`.
/// - `Staking.setCreditManager` and `Staking.setSlasher`, both to the credit pool, so its spread
///   reaches stakers and a written-off line reaches their stake.
/// - `V4LiquiditySeeder.acceptOwnership`, when the recorded seeder is one `SeedPool.s.sol` opened
///   the market with and offered to the timelock. A seeder the staking run deployed is the
///   timelock's already, and the call is left out.
/// - `Entrypoint.windDownPool` on the previous deployment's Entrypoint, for its shielded pool,
///   when `BURSAR_PREVIOUS_RECORD` names one. The pool stops taking deposits and every note in it
///   stays withdrawable. The timelock holds that Entrypoint's owner role, so the call is its.
///
/// A deployment that carries its staking pool and buyback over finds the keeper, the floors and
/// the rebate table already applied, and the batch proposes only what differs: the credit pool's
/// two roles, which move to the new pool, and the wind-down.
///
/// Run after `DeployCollateral.s.sol`, from signer keys; `Governance.sol` describes the steps.
/// `VerifyWiring.s.sol` checks that every call in the batch took effect.
contract ProposeWiring is Governance {
    bytes32 internal constant OWNER_ROLE = keccak256("OWNER_ROLE");

    error EntrypointNotGoverned(address entrypoint, address timelock);

    function _calls() internal view override returns (Call[] memory calls) {
        address timelock = _upstream(K.ADMIN_TIMELOCK);
        address staking = _upstream(K.STAKING);
        address buyback = _upstream(K.BUYBACK);
        address pool = _upstream(K.CREDIT_POOL);
        address keeper = _recordAddress(K.KEEPER);
        if (keeper == address(0)) revert NotRecorded(K.KEEPER);
        uint256 floor = _recordUint(".parameters.Staking.resolverBondFloor");
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);
        if (resolvers.length == 0) revert NotRecorded(K.RESOLVERS);

        address seeder = _recordAddress(K.SEEDER);
        bool acceptSeeder = seeder.code.length != 0 && V4LiquiditySeeder(seeder).pendingOwner() == timelock;

        (address entrypoint, address previousPool) = _previousShielded(timelock);
        bool windDown = previousPool != address(0);

        calls = new Call[](resolvers.length + 4 + (acceptSeeder ? 1 : 0) + (windDown ? 1 : 0));
        calls[0] = Call(timelock, buyback, abi.encodeCall(Buyback.setKeeper, (keeper)), "Buyback.setKeeper");
        for (uint256 i; i < resolvers.length; ++i) {
            calls[1 + i] = Call(
                timelock,
                staking,
                abi.encodeCall(Staking.setBondFloor, (resolvers[i], floor)),
                string.concat("Staking.setBondFloor ", vm.toString(resolvers[i]))
            );
        }
        uint256 n = 1 + resolvers.length;
        calls[n] =
            Call(timelock, staking, abi.encodeCall(Staking.setTiers, (TokenConfig.rebateTiers())), "Staking.setTiers");
        calls[n + 1] =
            Call(timelock, staking, abi.encodeCall(Staking.setCreditManager, (pool)), "Staking.setCreditManager");
        calls[n + 2] = Call(timelock, staking, abi.encodeCall(Staking.setSlasher, (pool)), "Staking.setSlasher");
        n += 3;
        if (acceptSeeder) {
            calls[n++] = Call(
                timelock,
                seeder,
                abi.encodeCall(V4LiquiditySeeder.acceptOwnership, ()),
                "V4LiquiditySeeder.acceptOwnership"
            );
        }
        if (windDown) {
            calls[n] = Call(
                timelock,
                entrypoint,
                abi.encodeCall(IPreviousEntrypoint.windDownPool, (previousPool)),
                "Entrypoint.windDownPool, the previous shielded pool"
            );
        }
    }

    /// The previous deployment's Entrypoint and shielded pool, both zero when the shell names no
    /// previous record. The timelock has to hold the Entrypoint's owner role, or the call would
    /// land and revert after its delay.
    function _previousShielded(address timelock) private view returns (address entrypoint, address pool) {
        pool = _previousAddress(K.SHIELDED_POOL);
        if (pool == address(0)) return (address(0), address(0));
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
        if (selector == IPreviousEntrypoint.windDownPool.selector) {
            return IPreviousShieldedPool(abi.decode(args, (address))).dead();
        }
        Staking staking = Staking(call.target);
        if (selector == Staking.setBondFloor.selector) {
            (address resolver, uint256 floor) = abi.decode(args, (address, uint256));
            return staking.bondFloorOf(resolver) == floor;
        }
        if (selector == Staking.setTiers.selector) {
            return keccak256(abi.encode(staking.tiers())) == keccak256(abi.encode(TokenConfig.rebateTiers()));
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
