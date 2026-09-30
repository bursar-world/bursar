// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {Migration} from "./lib/Migration.sol";

/// The replaced staking pool as it was built. A request there marks shares for exit without moving
/// them, and the pool pays them out once the unbonding period has passed since the request.
interface IRetiringStaking {
    struct Position {
        uint256 shares;
        uint256 unbondingShares;
        uint256 rewardDebt;
        uint256 rewards;
        uint64 unbondingAt;
        uint32 epoch;
    }

    function positionOf(address account) external view returns (Position memory);
    function unbondingPeriod() external view returns (uint64);
    function requestUnbond(uint256 shares) external;
    function cancelUnbond() external;
    function completeUnbond() external returns (uint256 amount);
}

/// Takes a stake out of the replaced staking pool, from the staker's own key. Stakers do this in
/// the console; this is the same two steps for a key that runs from a shell.
///
///   forge script script/MigrateStake.s.sol --sig "leave()"    --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
///   forge script script/MigrateStake.s.sol --sig "complete()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
///
/// `leave` asks for the whole position back. A request already open for part of it is replaced by
/// one for all of it, so the whole stake matures on one date. `complete` pays the stake out once
/// that date has passed. The BRSR lands in the staker's wallet, to stake in the new pool or not.
contract MigrateStake is Migration {
    function leave() external {
        _begin();
        IRetiringStaking old = IRetiringStaking(_old("BURSAR_TOKEN_RECORD", ".contracts.Staking"));
        IRetiringStaking.Position memory p = old.positionOf(msg.sender);
        if (p.shares == 0) {
            _note("This key holds no stake on the replaced pool.");
            return;
        }
        if (p.unbondingShares == p.shares) {
            console2.log(
                string.concat(
                    "already leaving; the stake can be taken back from ", _utc(_maturesAt(old, p.unbondingAt))
                )
            );
            return;
        }

        vm.startBroadcast(msg.sender);
        if (p.unbondingShares != 0) old.cancelUnbond();
        old.requestUnbond(p.shares);
        vm.stopBroadcast();

        console2.log(
            string.concat(
                "asked for the whole stake back; it can be taken back from ", _utc(_maturesAt(old, block.timestamp))
            )
        );
    }

    function complete() external {
        _begin();
        IRetiringStaking old = IRetiringStaking(_old("BURSAR_TOKEN_RECORD", ".contracts.Staking"));
        IRetiringStaking.Position memory p = old.positionOf(msg.sender);
        if (p.unbondingShares == 0) {
            _note("Nothing requested on the replaced pool: run leave() first.");
            return;
        }
        uint256 maturesAt = _maturesAt(old, p.unbondingAt);
        if (block.timestamp < maturesAt) {
            console2.log(
                string.concat(
                    "not matured yet; the stake can be taken back from ", _utc(maturesAt), ", in ", _until(maturesAt)
                )
            );
            return;
        }

        vm.startBroadcast(msg.sender);
        uint256 amount = old.completeUnbond();
        vm.stopBroadcast();

        console2.log("stake returned to this key, BRSR wei", amount);
    }

    function _maturesAt(IRetiringStaking old, uint256 requestedAt) private view returns (uint256) {
        return requestedAt + old.unbondingPeriod();
    }
}
