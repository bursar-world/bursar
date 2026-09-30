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

interface IRetiringStakingView {
    function totalStaked() external view returns (uint256);
}

/// What `settle` calls on a replaced escrow. Both builds that went live answer these to anyone.
interface IRetiringEscrow {
    function nextId() external view returns (uint256);
    function getLock(uint256 id) external view returns (IEscrow.Lock memory);
    function disputeWindow() external view returns (uint64);
    function feesAccrued() external view returns (uint128);
    function timeout(uint256 id) external;
    function sweepFees() external returns (uint128);
}

/// The migration's last step, in two parts.
///
/// `settle` closes out what anyone may close on the replaced escrows: every lock whose deadline
/// passed with no release goes back to its payer, and the fees the escrows booked go to the
/// treasury they name. It sends only those calls, from whichever key runs it.
///
/// `run` checks that nothing is left open on the sets being replaced, then marks their records
/// retired, names what replaced them, and marks the new record live. It sends nothing: it reads the
/// chain and writes four files. Retired means a record is kept as the account of what ran and is
/// never again looked up by chain, so the check comes first:
///
/// - no payment on either old escrow still locked, disputed, or inside its dispute window, and no
///   USDG left in either escrow at all;
/// - no cash or debt in the old credit pool and no collateral in the old vault;
/// - no liquidity in the old seeder, no stake in the old staking pool and no USDG in the old buyback;
/// - nothing in the old shielded pool;
/// - the vesting contract answering to the new timelock.
///
/// Anything still open stops the run and is named; `BURSAR_FORCE=1` retires the records anyway and
/// lists what was left.
///
///   forge script script/RetireRecords.s.sol --sig "settle()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" [--broadcast]
///   forge script script/RetireRecords.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" --broadcast
///
/// The second sends nothing, and still takes `--broadcast`: a simulation writes no file.
contract RetireRecords is Migration {
    error StillOpen(uint256 count);

    string[4] internal symbols = ["SGOV", "SPY", "NVDA", "AAPL"];

    uint256 private open;

    function settle() external {
        _begin();
        _settle(IRetiringEscrow(_old("BURSAR_V2_RECORD", ".contracts.Escrow")));
        _settle(IRetiringEscrow(_old("BURSAR_V1_RECORD", ".contracts.Escrow")));
    }

    function run() external {
        _begin();
        open = 0;
        _checkEscrow("BURSAR_V2_RECORD");
        _checkEscrow("BURSAR_V1_RECORD");
        _checkLanes();
        _checkToken();
        if (open != 0 && !_envFlag("BURSAR_FORCE")) revert StillOpen(open);

        string memory v1 = _envString("BURSAR_V1_RECORD");
        string memory v2 = _envString("BURSAR_V2_RECORD");
        string memory token = _envString("BURSAR_TOKEN_RECORD");
        string memory next = vm.parseJsonString(_json(), K.NETWORK);

        _retire(
            v1,
            vm.parseJsonString(vm.readFile(v2), K.NETWORK),
            "Retired: every contract in this set was replaced, and nothing open remains on its escrow."
        );
        _retire(
            v2,
            next,
            "Retired: replaced by the hardened contract set, and nothing open remains on its escrow, credit pool, collateral vault or shielded pool."
        );
        _retire(
            token,
            next,
            "Retired: the staking pool, buyback and seeder were replaced. BRSR and Vesting carry over into the record that replaced this one."
        );
        _writeString(K.STATUS, "live");
        console2.log("records retired; this record is live:", next);
    }

    function _settle(IRetiringEscrow escrow) private {
        uint256 last = escrow.nextId();
        vm.startBroadcast(msg.sender);
        for (uint256 id = 1; id < last; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);
            if (entry.status != IEscrow.LockStatus.Locked || block.timestamp <= entry.deadline) continue;
            escrow.timeout(id);
            console2.log("timed out, back to its payer: lock", id);
        }
        uint128 fees = escrow.feesAccrued();
        if (fees != 0) {
            escrow.sweepFees();
            console2.log("fees swept to the treasury, micro-USD", fees);
        }
        vm.stopBroadcast();
    }

    function _retire(string memory path, string memory replacedBy, string memory why) private {
        _putAt(path, K.STATUS, _quoted("retired"));
        _putAt(path, K.RETIRED, _quoted(why));
        _putAt(path, K.SUPERSEDED_BY, _quoted(replacedBy));
    }

    /// Money that has not reached its payee or its payer: a lock still `Locked` or `Disputed`, or
    /// released so recently that its payer can still dispute it. Every escrow that went live lays a
    /// lock out the way `IEscrow.Lock` does. Once none is left, the escrow should hold nothing.
    function _checkEscrow(string memory recordEnv) private {
        IRetiringEscrow escrow = IRetiringEscrow(_old(recordEnv, ".contracts.Escrow"));
        uint256 window = escrow.disputeWindow();
        uint256 last = escrow.nextId();
        for (uint256 id = 1; id < last; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);
            bool disputable =
                entry.status == IEscrow.LockStatus.Released && block.timestamp <= uint256(entry.releasedAt) + window;
            if (entry.status == IEscrow.LockStatus.Locked || entry.status == IEscrow.LockStatus.Disputed || disputable)
            {
                ++open;
                console2.log(string.concat("still open on ", recordEnv, ": lock"), id);
            }
        }
        uint256 held = IERC20(_settlementAsset()).balanceOf(address(escrow));
        if (held != 0) {
            ++open;
            console2.log(string.concat("still held by the escrow of ", recordEnv, ", micro-USD"), held);
        }
    }

    function _checkLanes() private {
        IRetiringCreditPool credit = IRetiringCreditPool(_old("BURSAR_V2_RECORD", ".rwa.collateral.CreditPool"));
        if (credit.cash() != 0 || credit.totalDebt() != 0) {
            ++open;
            console2.log("the replaced credit pool still holds cash or debt");
        }

        address vault = _old("BURSAR_V2_RECORD", ".rwa.collateral.CollateralVault");
        for (uint256 i; i < symbols.length; ++i) {
            address asset = _oldOptional("BURSAR_V2_RECORD", string.concat(".rwa.assets.", symbols[i], ".address"));
            if (asset == address(0) || IERC20(asset).balanceOf(vault) == 0) continue;
            ++open;
            console2.log(string.concat("the replaced collateral vault still holds ", symbols[i]));
        }

        address pool = _old("BURSAR_V2_RECORD", ".privacy.shielded.ShieldedPool");
        if (IERC20(IRetiringShieldedPoolView(pool).ASSET()).balanceOf(pool) != 0) {
            ++open;
            console2.log("the replaced shielded pool still holds notes");
        }
    }

    function _checkToken() private {
        IRetiringSeederView seeder = IRetiringSeederView(_old("BURSAR_TOKEN_RECORD", ".contracts.V4LiquiditySeeder"));
        (int24 lower, int24 upper) = V4Math.fullRangeTicks(seeder.poolTickSpacing());
        if (seeder.liquidityOf(lower, upper) != 0) {
            ++open;
            console2.log("the replaced seeder still holds liquidity");
        }

        // Stakers leave the replaced pool themselves, seven days after they ask. Until the last one
        // has, the record that shows them where their stake is stays in use.
        uint256 staked = IRetiringStakingView(_old("BURSAR_TOKEN_RECORD", ".contracts.Staking")).totalStaked();
        if (staked != 0) {
            ++open;
            console2.log("the replaced staking pool still holds stake, BRSR wei", staked);
        }
        address buyback = _old("BURSAR_TOKEN_RECORD", ".contracts.Buyback");
        uint256 unspent = IERC20(_settlementAsset()).balanceOf(buyback);
        if (unspent != 0) {
            ++open;
            console2.log("the replaced buyback still holds USDG, micro", unspent);
        }

        if (Vesting(_upstream(K.VESTING)).admin() != _upstream(K.ADMIN_TIMELOCK)) {
            ++open;
            console2.log("the vesting contract still answers to the first timelock");
        }
    }
}
