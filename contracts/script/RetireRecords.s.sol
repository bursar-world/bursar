// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {IShieldedPoolReads} from "./VerifyShielded.s.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {CreditPool} from "../src/rwa/CreditPool.sol";
import {Staking} from "../src/token/Staking.sol";

/// What the previous shielded pool owes its notes, which its own code tracks: a transfer sent to
/// the pool outside a deposit belongs to no note and does not count.
interface IPreviousShieldedPool is IShieldedPoolReads {
    function poolValue() external view returns (uint256);
}

/// The record-keeping end of the move, in three parts, each from the deploy key.
///
/// `settle` closes out what anyone may close on the previous escrow: every lock whose deadline
/// passed with no release goes back to its payer, and the fees the escrow booked go to the treasury
/// it names. It sends only those calls.
///
/// `goLive` marks this record live and the previous one superseded, naming this one in its
/// `supersededBy`, as soon as the new set can take the apps: its examples exist and the wiring
/// batch has landed. The address book the apps read resolves from the live record, so this is the
/// moment they move. The previous record stays readable for what its contracts still hold.
///
/// `run` checks that nothing is left open on the previous set, then marks its record retired, kept
/// as the account of what ran and never again looked up by chain, and this one live if `goLive`
/// has not run. It sends nothing. Open means:
///
/// - a payment on the previous escrow still locked, disputed, or inside its dispute window, and
///   any USDG left in the escrow at all;
/// - cash or debt in the previous credit pool, and any balance in the previous vault, booked to a
///   line or not;
/// - notes in the previous shielded pool;
/// - a stake still on the previous agent registry, a bond or an unclaimed reward still on the
///   previous resolver registry.
///
/// Anything still open stops the run and is named; `BURSAR_FORCE=1` retires the record anyway and
/// lists what was left.
///
///   forge script script/RetireRecords.s.sol --sig "settle()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" [--broadcast]
///   forge script script/RetireRecords.s.sol --sig "goLive()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" --broadcast
///   forge script script/RetireRecords.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" --broadcast
///
/// The last two send nothing, and still take `--broadcast`: a simulation writes no file.
contract RetireRecords is Migration {
    error StillOpen(uint256 count);
    error NotReadyForLive(string what);

    string[4] internal symbols = ["SGOV", "SPY", "NVDA", "AAPL"];

    uint256 private open;

    function settle() external {
        _begin();
        Escrow escrow = Escrow(_previous(K.ESCROW));
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

    function goLive() external {
        _begin();
        _requireUsable();
        string memory next = vm.parseJsonString(_json(), K.NETWORK);
        string memory previous = _previousPath();
        if (bytes(previous).length != 0) {
            _previousJson();
            _putAt(previous, K.STATUS, _quoted("superseded"));
            _putAt(previous, K.SUPERSEDED_BY, _quoted(next));
            console2.log("superseded:", previous);
        }
        _writeString(K.STATUS, "live");
        console2.log("live:", next);
    }

    function run() external {
        _begin();
        open = 0;
        _checkEscrow();
        _checkLanes();
        _checkRegistries();
        if (open != 0 && !_envFlag("BURSAR_FORCE")) revert StillOpen(open);

        string memory previous = _previousPath();
        _previousJson();
        string memory next = vm.parseJsonString(_json(), K.NETWORK);
        _putAt(previous, K.STATUS, _quoted("retired"));
        _putAt(
            previous,
            K.RETIRED,
            _quoted(
                string.concat(
                    "Replaced by ",
                    next,
                    ". Nothing is open on its escrow, registries, credit pool, collateral vault or shielded pool."
                )
            )
        );
        _putAt(previous, K.SUPERSEDED_BY, _quoted(next));
        _writeString(K.STATUS, "live");
        console2.log("record retired:", previous);
        console2.log("this record is live:", next);
    }

    /// The apps can move once the new set has its examples and the carried staking pool answers to
    /// the new credit pool. The committed example needs terms sealed with the payer's own
    /// signature, so its absence is noted and stops nothing.
    function _requireUsable() private view {
        if (_recordAddress(".exampleMandate.address").code.length == 0) {
            revert NotReadyForLive("exampleMandate: MigrateExamples.s.sol create() has not run");
        }
        if (_recordAddress(".exampleCollateralMandate.address").code.length == 0) {
            revert NotReadyForLive("exampleCollateralMandate: MigrateExamples.s.sol create() has not run");
        }
        if (_recordAddress(".exampleCommittedMandate.address").code.length == 0) {
            console2.log("no committed example yet: create() with the terms from script/committed-example.mjs");
        }
        Staking staking = Staking(_upstream(K.STAKING));
        address pool = _upstream(K.CREDIT_POOL);
        if (staking.creditManager() != pool) {
            revert NotReadyForLive("Staking.creditManager: the wiring has not landed");
        }
        if (staking.slasher() != pool) revert NotReadyForLive("Staking.slasher: the wiring has not landed");
        address previousPool = _previousOptional(K.SHIELDED_POOL);
        if (previousPool != address(0) && !IShieldedPoolReads(previousPool).dead()) {
            revert NotReadyForLive("the previous shielded pool still takes deposits: the wiring has not landed");
        }
    }

    /// Money that has not reached its payee or its payer: a lock still `Locked` or `Disputed`, or
    /// released so recently that its payer can still dispute it. Once none is left, the escrow
    /// should hold nothing: what it still holds is a payout its asset refused, claimable by its
    /// party, or a stray transfer.
    function _checkEscrow() private {
        Escrow escrow = Escrow(_previous(K.ESCROW));
        uint256 window = escrow.disputeWindow();
        uint256 last = escrow.nextId();
        for (uint256 id = 1; id < last; ++id) {
            IEscrow.Lock memory entry = escrow.getLock(id);
            bool disputable =
                entry.status == IEscrow.LockStatus.Released && block.timestamp <= uint256(entry.releasedAt) + window;
            if (entry.status == IEscrow.LockStatus.Locked || entry.status == IEscrow.LockStatus.Disputed || disputable)
            {
                ++open;
                console2.log("still open on the previous escrow: lock", id);
            }
        }
        uint256 held = IERC20(_settlementAsset()).balanceOf(address(escrow));
        if (held != 0) {
            ++open;
            console2.log("still held by the previous escrow, micro-USD", held);
        }
    }

    function _checkLanes() private {
        CreditPool credit = CreditPool(_previous(K.CREDIT_POOL));
        if (credit.cash() != 0 || credit.totalDebt() != 0) {
            ++open;
            console2.log("the previous credit pool still holds cash or debt");
        }

        // Every balance the vault holds, booked to a line or left by a sale that stopped short or
        // a transfer sent by hand: each is still somebody's.
        address vault = _previous(K.COLLATERAL_VAULT);
        for (uint256 i; i < symbols.length; ++i) {
            address asset = _previousOptional(string.concat(K.RWA_ASSETS, ".", symbols[i], ".address"));
            if (asset == address(0) || IERC20(asset).balanceOf(vault) == 0) continue;
            ++open;
            console2.log(string.concat("the previous collateral vault still holds ", symbols[i]));
        }
        if (IERC20(_settlementAsset()).balanceOf(vault) != 0) {
            ++open;
            console2.log("the previous collateral vault still holds USDG");
        }

        uint256 notes = IPreviousShieldedPool(_previous(K.SHIELDED_POOL)).poolValue();
        if (notes != 0) {
            ++open;
            console2.log("the previous shielded pool still owes its notes, micro-USD", notes);
        }
    }

    function _checkRegistries() private {
        uint256 staked = AgentRegistry(_previous(K.AGENT_REGISTRY)).totalStaked();
        if (staked != 0) {
            ++open;
            console2.log("the previous agent registry still holds stake, micro-USD", staked);
        }

        IOracleRegistry registry = IOracleRegistry(_previous(K.ORACLE_REGISTRY));
        uint256 bonded = registry.totalBonded();
        if (bonded != 0) {
            ++open;
            console2.log("the previous resolver registry still holds bonds, BRSR wei", bonded);
        }
        uint256 rewards = registry.rewardFloat();
        if (rewards != 0) {
            ++open;
            console2.log("the previous resolver registry still holds unclaimed rewards, micro-USD", rewards);
        }
    }
}
