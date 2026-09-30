// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governance} from "./lib/Governance.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {TokenConfig} from "./lib/TokenConfig.sol";

import {Buyback} from "../src/token/Buyback.sol";
import {Staking} from "../src/token/Staking.sol";

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
///
/// Run after `DeployCollateral.s.sol`, from signer keys; `Governance.sol` describes the steps.
/// `VerifyWiring.s.sol` holds every call to done.
contract ProposeWiring is Governance {
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

        calls = new Call[](resolvers.length + 4);
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
    }

    function _applied(Call memory call) internal view override returns (bool) {
        bytes4 selector = bytes4(call.data);
        bytes memory args = _args(call.data);
        if (selector == Buyback.setKeeper.selector) {
            return Buyback(call.target).keeper() == abi.decode(args, (address));
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
        return false;
    }

    function _args(bytes memory data) private pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }
}
