// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {CreditPool} from "../src/rwa/CreditPool.sol";

/// Moves the collateral lane's lending cash from the previous credit pool to the new one, from the
/// lender's key.
///
/// `run` takes back every unit of USDG the previous pool is not lending out. The pool pays it to
/// the lender alone, so the key this runs with has to be the lender both pools name. A line still
/// drawn there keeps its debt, and whatever it repays later can be taken back the same way.
///
/// `fund(amount)` lends `amount` micro-USD to the new pool. Anyone may fund; only the recorded
/// lender can take it back out.
///
///   forge script script/MigrateCredit.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" [--broadcast]
///   forge script script/MigrateCredit.s.sol --sig "fund(uint256)" 25000000 --rpc-url "$RHC_RPC_URL" \
///     --keystore "$KEYS/rh-deployer" [--broadcast]
contract MigrateCredit is Migration {
    function run() external {
        _begin();
        CreditPool previous = CreditPool(_previous(K.CREDIT_POOL));
        _requireKey("lender of the previous credit pool", previous.lender());

        uint256 cash = previous.cash();
        uint256 debt = previous.totalDebt();
        console2.log("previous credit pool          ", address(previous));
        console2.log("cash it can return, micro-USD ", cash);
        console2.log("still lent out, micro-USD     ", debt);
        if (cash == 0) {
            _note("Nothing to take back.");
            return;
        }

        IERC20 usdg = IERC20(_settlementAsset());
        uint256 before = usdg.balanceOf(msg.sender);
        vm.startBroadcast(msg.sender);
        previous.withdrawLiquidity(msg.sender, cash);
        vm.stopBroadcast();

        // At least, never exactly: anyone can send the lender a unit in between.
        require(usdg.balanceOf(msg.sender) >= before + cash, "the lender did not receive the cash");
        console2.log("returned to the lender, micro ", cash);
        console2.log("left in the previous pool, micro", previous.cash());
    }

    function fund(uint256 amount) external {
        _begin();
        if (amount == 0) revert NothingToMove("a zero amount");
        CreditPool pool = CreditPool(_upstream(K.CREDIT_POOL));
        IERC20 usdg = IERC20(_settlementAsset());
        uint256 held = usdg.balanceOf(msg.sender);
        require(held >= amount, "the funding key holds less USDG than the amount");

        uint256 before = pool.cash();
        vm.startBroadcast(msg.sender);
        usdg.approve(address(pool), amount);
        pool.fund(amount);
        vm.stopBroadcast();

        require(pool.cash() >= before + amount, "the pool did not book the funding");
        console2.log("new credit pool               ", address(pool));
        console2.log("lendable cash now, micro-USD  ", pool.cash());
        console2.log("lender, who alone can take it back", pool.lender());
    }
}
