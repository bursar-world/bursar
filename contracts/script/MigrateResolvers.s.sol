// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {Staking} from "../src/token/Staking.sol";

/// Moves the three resolvers to the new dispute registry: the treasury sends each one its bond,
/// each resolver bonds it on the new registry and asks the previous registry for its old bond back,
/// and seven days later takes that back and returns it to the treasury, which paid for it.
///
///   forge script script/MigrateResolvers.s.sol --sig "fund()"    --keystore "$KEYS/treasury"   ...
///   forge script script/MigrateResolvers.s.sol --sig "bond()"    --keystore "$KEYS/resolver-1" ...
///   forge script script/MigrateResolvers.s.sol --sig "reclaim()" --keystore "$KEYS/resolver-1" ...
///
/// `bond` needs the resolver's floor on the record's staking pool. On a pool carried over from the
/// previous deployment the floors are already in place, so bonding waits for nothing; on a fresh
/// one governance names them in the wiring batch first, and until then nobody can bond, which is
/// the point of the allowlist.
///
/// The previous registry keeps ruling on the disputes already open on it while the bonds unbond,
/// and a bond with a vote still open stays until the vote closes.
contract MigrateResolvers is Migration {
    using SafeERC20 for IERC20;

    uint8 private constant ACTIVE = 1;
    uint8 private constant UNBONDING = 2;

    /// The treasury tops each resolver's wallet up to what its new bond still needs.
    function fund() external {
        _begin();
        _requireKey("treasury", _recordAddress(K.TREASURY));
        IERC20 brsr = IERC20(_upstream(K.BRSR));
        IOracleRegistry registry = IOracleRegistry(_upstream(K.ORACLE_REGISTRY));
        uint256 floor = _recordUint(".parameters.Staking.resolverBondFloor");
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);

        vm.startBroadcast(msg.sender);
        for (uint256 i; i < resolvers.length; ++i) {
            uint256 bonded = registry.getResolver(resolvers[i]).bond;
            uint256 needed = bonded >= floor ? 0 : floor - bonded;
            uint256 held = brsr.balanceOf(resolvers[i]);
            if (held >= needed) {
                console2.log("already covered                ", resolvers[i]);
                continue;
            }
            brsr.safeTransfer(resolvers[i], needed - held);
            console2.log("sent to                        ", resolvers[i]);
            console2.log("  BRSR wei                     ", needed - held);
        }
        vm.stopBroadcast();
    }

    /// Run by each resolver. Bonds the floor on the new registry, then asks the previous registry
    /// for the old bond back.
    function bond() external {
        _begin();
        address[] memory resolvers = _recordAddresses(K.RESOLVERS);
        bool listed;
        for (uint256 i; i < resolvers.length; ++i) {
            if (resolvers[i] == msg.sender) listed = true;
        }
        require(listed, "this key is not one of the recorded resolvers");

        IERC20 brsr = IERC20(_upstream(K.BRSR));
        IOracleRegistry registry = IOracleRegistry(_upstream(K.ORACLE_REGISTRY));
        Staking staking = Staking(_upstream(K.STAKING));
        uint256 floor = _recordUint(".parameters.Staking.resolverBondFloor");
        require(staking.isBondable(msg.sender, floor), "governance has not named this resolver's floor yet");

        IOracleRegistry.Resolver memory current = registry.getResolver(msg.sender);
        uint256 needed = current.bond >= floor ? 0 : floor - current.bond;
        require(brsr.balanceOf(msg.sender) >= needed, "the treasury has not sent this resolver its bond yet");

        vm.startBroadcast(msg.sender);
        if (needed != 0) {
            brsr.approve(address(registry), needed);
            // forge-lint: disable-next-line(unsafe-typecast)
            if (current.status == IOracleRegistry.ResolverStatus.Active) registry.increaseBond(uint128(needed));
            // forge-lint: disable-next-line(unsafe-typecast)
            else registry.register(uint128(needed));
            console2.log("bonded on the new registry, BRSR wei", needed);
        }
        _requestUnbond(_previousOptional(K.ORACLE_REGISTRY));
        vm.stopBroadcast();

        require(registry.getResolver(msg.sender).bond >= floor, "the new bond is below the floor");
    }

    /// Run by each resolver once the old bond has matured. Takes it back and returns it to the
    /// treasury.
    function reclaim() external {
        _begin();
        IERC20 brsr = IERC20(_upstream(K.BRSR));
        address treasury = _recordAddress(K.TREASURY);
        uint256 before = brsr.balanceOf(msg.sender);

        vm.startBroadcast(msg.sender);
        _completeUnbond(_previous(K.ORACLE_REGISTRY));
        uint256 returned = brsr.balanceOf(msg.sender) - before;
        if (returned != 0) brsr.safeTransfer(treasury, returned);
        vm.stopBroadcast();

        console2.log("returned to the treasury, BRSR wei", returned);
    }

    function _requestUnbond(address previous) private {
        if (previous == address(0)) return;
        IOracleRegistry.Resolver memory r = IOracleRegistry(previous).getResolver(msg.sender);
        if (uint8(r.status) != ACTIVE) return;
        IOracleRegistry(previous).requestUnbond();
        console2.log("asked for the old bond back from", previous);
    }

    function _completeUnbond(address previous) private {
        IOracleRegistry registry = IOracleRegistry(previous);
        IOracleRegistry.Resolver memory r = registry.getResolver(msg.sender);
        if (uint8(r.status) != UNBONDING) return;
        uint256 maturesAt = uint256(r.unbondingAt) + registry.config().unbondingPeriod;
        if (block.timestamp < maturesAt) {
            console2.log(
                string.concat(
                    "not matured yet at ",
                    vm.toString(previous),
                    ": matures ",
                    _utc(maturesAt),
                    ", in ",
                    _until(maturesAt)
                )
            );
            return;
        }
        registry.completeUnbond();
        console2.log("took the old bond back from", previous);
    }
}
