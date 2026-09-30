// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {CreditPool} from "../src/rwa/CreditPool.sol";

/// The part of the replaced credit pool this step calls. Its interface is the one deployed, read
/// from the source it was built from.
interface IRetiringCreditPool {
    function lender() external view returns (address);
    function cash() external view returns (uint256);
    function totalDebt() external view returns (uint256);
    function withdrawLiquidity(address to, uint256 amount) external;
}

/// Moves the collateral lane's lending cash from the replaced credit pool to the new one, from the
/// lender's key.
///
/// `run` takes back every unit of USDG the old pool is not lending out. The pool pays it to the
/// lender alone, so the key this runs with has to be the lender both pools name. A line still
/// drawn there keeps its debt, and whatever it repays later can be taken back the same way.
///
/// `fund(amount)` lends `amount` micro-USD to the new pool. Anyone may fund; only the recorded
/// lender can take it back out.
///
///   forge script script/MigrateCredit.s.sol --rpc-url "$RHC_RPC_URL" --account rh-deployer [--broadcast]
///   forge script script/MigrateCredit.s.sol --sig "fund(uint256)" 30000000 --rpc-url "$RHC_RPC_URL" \
///     --account rh-deployer [--broadcast]
contract MigrateCredit is Migration {
    function run() external {
        _begin();
        IRetiringCreditPool old = IRetiringCreditPool(_old("BURSAR_V2_RECORD", ".rwa.collateral.CreditPool"));
        _requireKey("lender of the replaced credit pool", old.lender());

        uint256 cash = old.cash();
        uint256 debt = old.totalDebt();
        console2.log("replaced credit pool          ", address(old));
        console2.log("cash it can return, micro-USD ", cash);
        console2.log("still lent out, micro-USD     ", debt);
        if (cash == 0) {
            _note("Nothing to take back.");
            return;
        }

        IERC20 usdg = IERC20(_settlementAsset());
        uint256 before = usdg.balanceOf(msg.sender);
        vm.startBroadcast(msg.sender);
        old.withdrawLiquidity(msg.sender, cash);
        vm.stopBroadcast();

        require(old.cash() == 0, "the replaced pool still holds cash");
        require(usdg.balanceOf(msg.sender) == before + cash, "the lender did not receive the cash");
        console2.log("returned to the lender, micro ", cash);
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

        require(pool.cash() == before + amount, "the pool did not book the funding");
        console2.log("new credit pool               ", address(pool));
        console2.log("lendable cash now, micro-USD  ", pool.cash());
        console2.log("lender, who alone can take it back", pool.lender());
    }
}
