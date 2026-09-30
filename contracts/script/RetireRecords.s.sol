// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {V4Math} from "./lib/V4Math.sol";

import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {Vesting} from "../src/token/Vesting.sol";

interface IRetiringCreditPool {
    function cash() external view returns (uint256);
    function totalDebt() external view returns (uint256);
}

interface IRetiringSeederView {
    function liquidityOf(int24 tickLower, int24 tickUpper) external view returns (uint128);
    function poolTickSpacing() external view returns (int24);
}

interface IRetiringShieldedPoolView {
    function ASSET() external view returns (address);
}

/// The migration's last step. Checks that nothing is left open on the sets being replaced, then
/// marks their records retired, names what replaced them, and marks the new record live. Sends
/// nothing: it reads the chain and writes four files.
///
/// Retired means a record is kept as the account of what ran and is never again looked up by
/// chain. So the check comes first: no open payment or dispute on either old escrow, no cash or
/// debt in the old credit pool, no liquidity in the old seeder, nothing in the old shielded pool,
/// and the vesting contract answering to the new timelock. Anything still open stops the run and
/// is named; `BURSAR_FORCE=1` retires the records anyway and lists what was left.
///
///   forge script script/RetireRecords.s.sol --rpc-url "$RHC_RPC_URL"
contract RetireRecords is Migration {
    error StillOpen(uint256 count);

    uint256 private open;

    function run() external {
        _begin();
        open = 0;
        _checkEscrow("BURSAR_V2_RECORD");
        _checkEscrow("BURSAR_V1_RECORD");
        _checkLanes();
        if (open != 0 && !_envFlag("BURSAR_FORCE")) revert StillOpen(open);

        string memory v1 = vm.envString(_key("BURSAR_V1_RECORD"));
        string memory v2 = vm.envString(_key("BURSAR_V2_RECORD"));
        string memory token = vm.envString(_key("BURSAR_TOKEN_RECORD"));
        string memory next = vm.parseJsonString(_json(), K.NETWORK);

        _retire(
            v1,
            vm.parseJsonString(vm.readFile(v2), K.NETWORK),
            "Retired: every contract in this set was replaced, and nothing open remains on its escrow."
        );
        _retire(
            v2,
            next,
            "Retired: replaced by the hardened contract set, and nothing open remains on its escrow, credit pool, seeder or shielded pool."
        );
        _retire(
            token,
            next,
            "Retired: the staking pool, buyback and seeder were replaced. BRSR and Vesting carry over into the record that replaced this one."
        );
        _writeString(K.STATUS, "live");
        console2.log("records retired; this record is live:", next);
    }

    function _retire(string memory path, string memory replacedBy, string memory why) private {
        _putAt(path, K.STATUS, _quoted("retired"));
        _putAt(path, K.RETIRED, _quoted(why));
        _putAt(path, K.SUPERSEDED_BY, _quoted(replacedBy));
    }

    /// Every lock still `Locked` or `Disputed` is money that has not reached its payee or its
    /// payer. Every escrow that went live lays a lock out the way `IEscrow.Lock` does.
    function _checkEscrow(string memory recordEnv) private {
        IEscrow escrow = IEscrow(_old(recordEnv, ".contracts.Escrow"));
        uint256 last = escrow.nextId();
        for (uint256 id = 1; id < last; ++id) {
            IEscrow.LockStatus status = escrow.getLock(id).status;
            if (status == IEscrow.LockStatus.Locked || status == IEscrow.LockStatus.Disputed) {
                ++open;
                console2.log(string.concat("still open on ", recordEnv, ": lock"), id);
            }
        }
    }

    function _checkLanes() private {
        IRetiringCreditPool credit = IRetiringCreditPool(_old("BURSAR_V2_RECORD", ".rwa.collateral.CreditPool"));
        if (credit.cash() != 0 || credit.totalDebt() != 0) {
            ++open;
            console2.log("the replaced credit pool still holds cash or debt");
        }

        IRetiringSeederView seeder = IRetiringSeederView(_old("BURSAR_TOKEN_RECORD", ".contracts.V4LiquiditySeeder"));
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(seeder.poolTickSpacing());
        if (seeder.liquidityOf(lower, upper) != 0) {
            ++open;
            console2.log("the replaced seeder still holds liquidity");
        }

        address pool = _old("BURSAR_V2_RECORD", ".privacy.shielded.ShieldedPool");
        if (IERC20(IRetiringShieldedPoolView(pool).ASSET()).balanceOf(pool) != 0) {
            ++open;
            console2.log("the replaced shielded pool still holds notes");
        }

        if (Vesting(_upstream(K.VESTING)).admin() != _upstream(K.ADMIN_TIMELOCK)) {
            ++open;
            console2.log("the vesting contract still answers to the first timelock");
        }
    }
}
