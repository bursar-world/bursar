// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";
import {IStockRouter} from "../src/interfaces/IStockRouter.sol";
import {Staking} from "../src/token/Staking.sol";

import {DualViewERC20} from "./mocks/DualViewERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockBRSR} from "./mocks/MockBRSR.sol";

/// Everything the handler needs to drive the deployment, carried as one struct because the
/// argument list is past the point where positional constructor arguments read.
struct SystemWiring {
    MockUsdg asset;
    MockBRSR bondAsset;
    Escrow escrow;
    OracleRegistry oracle;
    AgentRegistry registry;
    Reputation reputation;
    Staking pool;
    AdminTimelock timelock;
    InvariantRouter router;
    address guardian;
    address agent;
    address[2] principals;
    uint256[2] principalKeys;
    address[] payers;
    address[] payees;
    address[] resolvers;
    address[] accounts;
}

/// The escrow, the resolver registry and the agent registry all stop and restart this way.
interface IBrake {
    function paused() external view returns (bool);
    function unpause() external;
}

/// Fills a stock purchase at one unit per unit of the settlement asset. A fill is final, so what
/// it takes out of a mandate stays in `totalSpent` for good.
contract InvariantRouter is IStockRouter {
    IERC20 private immutable SETTLEMENT;
    MockERC20 public immutable STOCK;

    constructor(IERC20 settlement) {
        SETTLEMENT = settlement;
        STOCK = new MockERC20();
    }

    function buy(address, uint128 usdgIn, uint128, uint256, address to) external returns (uint256 amountOut) {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        SETTLEMENT.transferFrom(msg.sender, address(this), usdgIn);
        amountOut = usdgIn;
        STOCK.mint(to, amountOut);
    }
}

/// Random but legal traffic across the whole deployment: mandates spend, sign and revoke
/// approvals, change limits and change hands; payers lock directly; payees release and cancel;
/// both sides open bonded disputes; resolvers vote and get paid; governance slashes, evicts,
/// reconfigures and pulls the brake; the issuer freezes addresses; and stray transfers land on
/// contracts that never asked for them.
///
/// Every action swallows its own revert. A sequence that reaches an illegal transition is still
/// a sequence worth continuing, and the properties under test are about the states the system
/// does reach rather than about which calls happen to be admissible at step seventeen.
///
/// Counters carry findings out to the invariant functions instead of asserting in place. An
/// assertion here reverts, and a reverting handler call is discarded by the runner, which would
/// bury the failure it was meant to surface.
///
/// No call is made under a started prank. A call that reverts under `startPrank` leaves the
/// prank standing, and every step after it then fails on the cheatcode instead of the contract.
contract MandateSystemHandler is CommonBase, StdUtils {
    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint128 internal constant MAX_LOCK = 25_000e6;
    uint128 internal constant RESOLVER_BOND = 2_000e18;
    bytes32 internal constant CAPABILITY = keccak256("mandate.invariant.capability");

    /// A payment signed for once and then spent or revoked. Replayed at random to prove the
    /// id stays burned, a principal handover and handback included.
    struct Burned {
        address account;
        IMandateAccount.SpendApproval approval;
        bytes signature;
    }

    MockUsdg public immutable asset;
    MockBRSR public immutable bondAsset;
    Escrow public immutable escrow;
    OracleRegistry public immutable oracle;
    AgentRegistry public immutable registry;
    Reputation public immutable reputation;
    Staking public immutable pool;
    AdminTimelock public immutable timelock;
    InvariantRouter public immutable router;
    address public immutable guardian;
    address public immutable agent;

    address[2] public principals;
    address[] public payers;
    address[] public payees;
    address[] public resolvers;
    address[] public accounts;

    mapping(address principal => uint256 key) private _keyOf;

    /// Every id the fixture has ever opened. The escrow itself is the record of what each one
    /// became, so nothing about a lock's state is mirrored here.
    uint256[] public lockIds;

    /// Set for the ids a mandate account paid for, because a dispute on one of those has to be
    /// routed through the account, not opened by the account's own address.
    mapping(uint256 id => address account) public mandateLockOf;

    /// Who holds each account now. Principals hand accounts back and forth.
    mapping(address account => address principal) public principalOf;

    /// Accounts whose limits were rewritten, which can leave a window holding more than a cap
    /// that was lowered under it.
    mapping(address account => bool rewritten) public limitsRewritten;

    /// What each account spent on stock. Never credited back.
    mapping(address account => uint256 amount) public purchased;

    /// Stray transfers, per recipient. A donation is unaccounted by construction. The balance
    /// identities carry it as its own term.
    mapping(address holder => uint256 amount) public donated;

    /// Scores are chosen when a vote is committed and needed again when it is revealed.
    mapping(uint256 disputeId => mapping(address resolver => uint8 score)) public committedScore;

    Burned[] private _burned;

    /// Settlement paths that did not conserve value, mandate windows caught holding more spend
    /// than their cap admits, and burned approvals that opened a lock anyway. All three are
    /// asserted to be zero.
    uint256 public conservationBreaks;
    uint256 public capBreaks;
    uint256 public replays;

    /// Coverage. `finalized` is read by `afterInvariant`, so a run that never reached a ruling
    /// cannot pass by reaching no states at all.
    uint256 public settlements;
    uint256 public finalized;
    uint256 public approvalCount;

    constructor(SystemWiring memory wiring) {
        asset = wiring.asset;
        bondAsset = wiring.bondAsset;
        escrow = wiring.escrow;
        oracle = wiring.oracle;
        registry = wiring.registry;
        reputation = wiring.reputation;
        pool = wiring.pool;
        timelock = wiring.timelock;
        router = wiring.router;
        guardian = wiring.guardian;
        agent = wiring.agent;
        principals = wiring.principals;
        payers = wiring.payers;
        payees = wiring.payees;
        resolvers = wiring.resolvers;
        accounts = wiring.accounts;

        for (uint256 i; i < 2; ++i) {
            _keyOf[wiring.principals[i]] = wiring.principalKeys[i];
        }
        for (uint256 i; i < wiring.accounts.length; ++i) {
            principalOf[wiring.accounts[i]] = wiring.principals[0];
        }
    }

    function lockFromPayer(uint256 payerSeed, uint256 payeeSeed, uint256 amountSeed, uint256 ttlSeed) external {
        address payer = _pick(payers, payerSeed);
        address payee = _pick(payees, payeeSeed);
        uint128 amount = uint128(bound(amountSeed, escrow.minLock(), MAX_LOCK));
        uint64 deadline = _deadline(ttlSeed);

        if (!_fund(payer, amount)) return;
        bytes32 inputCommit = keccak256(abi.encode(payee, amount));

        vm.prank(payer);
        try escrow.lock(payee, CAPABILITY, inputCommit, "ipfs://job", amount, deadline) returns (uint256 id) {
            lockIds.push(id);
        } catch {}
    }

    /// Routes on the amount: a spend at or above the account's approval threshold needs the
    /// principal's consent, which is registered on chain and then consumed with an empty
    /// signature. Both admission paths therefore appear in the same sequence.
    function spendFromMandate(uint256 accountSeed, uint256 payeeSeed, uint256 amountSeed, uint256 ttlSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        address payee = _pick(payees, payeeSeed);
        uint128 amount = _spendable(account, amountSeed);
        if (amount == 0 || !_deposit(account, amount)) return;

        IMandateAccount.SpendRequest memory request = _request(payee, amount, ttlSeed);

        uint256 escrowId;
        if (amount >= account.approvalThreshold()) {
            IMandateAccount.SpendApproval memory approval = _approval(payee, amount);

            vm.prank(principalOf[address(account)]);
            try account.approveSpend(approval) {} catch {}

            vm.prank(agent);
            try account.spendApproved(request, new bytes32[](0), approval, "") returns (uint256 id) {
                escrowId = id;
            } catch {}
        } else {
            vm.prank(agent);
            try account.spend(request, new bytes32[](0)) returns (uint256 id) {
                escrowId = id;
            } catch {}
        }

        if (escrowId != 0) _recordSpend(account, escrowId);
    }

    /// The principal's consent as a signature only, the way a cold wallet or a Safe gives it.
    function spendSigned(uint256 accountSeed, uint256 payeeSeed, uint256 amountSeed, uint256 ttlSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        address payee = _pick(payees, payeeSeed);
        uint128 amount = _spendable(account, amountSeed);
        if (amount == 0 || !_deposit(account, amount)) return;

        IMandateAccount.SpendApproval memory approval = _approval(payee, amount);
        bytes memory signature = _sign(account, approval);

        vm.prank(agent);
        try account.spendApproved(_request(payee, amount, ttlSeed), new bytes32[](0), approval, signature) returns (
            uint256 id
        ) {
            _recordSpend(account, id);
            _burned.push(Burned({account: address(account), approval: approval, signature: signature}));
        } catch {}
    }

    /// Signs an approval and withdraws it before any agent can use it.
    function revokeSigned(uint256 accountSeed, uint256 payeeSeed, uint256 amountSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        uint128 amount = uint128(bound(amountSeed, escrow.minLock(), MAX_LOCK));
        IMandateAccount.SpendApproval memory approval = _approval(_pick(payees, payeeSeed), amount);
        bytes memory signature = _sign(account, approval);

        vm.prank(principalOf[address(account)]);
        try account.revokeApproval(approval.approvalId) {
            _burned.push(Burned({account: address(account), approval: approval, signature: signature}));
        } catch {}
    }

    /// Presents a spent or revoked signature again. Any lock it opens is a replay.
    function replayBurned(uint256 seed, uint256 ttlSeed) external {
        if (_burned.length == 0) return;
        Burned memory burned = _burned[seed % _burned.length];
        MandateAccount account = MandateAccount(burned.account);
        if (!_deposit(account, burned.approval.amount)) return;

        IMandateAccount.SpendRequest memory request =
            _request(burned.approval.merchant, burned.approval.amount, ttlSeed);

        vm.prank(agent);
        try account.spendApproved(request, new bytes32[](0), burned.approval, burned.signature) returns (uint256 id) {
            replays += 1;
            _recordSpend(account, id);
        } catch {}
    }

    /// Hands the account to the other principal, who accepts at once. Two handovers make the
    /// round trip that used to bring every signature the first holder had spent back to life.
    function handOver(uint256 accountSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        address from = principalOf[address(account)];
        address to = from == principals[0] ? principals[1] : principals[0];

        vm.prank(from);
        try account.transferPrincipal(to) {}
        catch {
            return;
        }
        vm.prank(to);
        try account.acceptPrincipal() {
            principalOf[address(account)] = to;
        } catch {}
    }

    function rewriteLimits(uint256 accountSeed, uint256 capSeed, uint256 thresholdSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        uint128 perCall = uint128(bound(capSeed, 1e6, 10_000e6));

        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: perCall,
            dailyCap: perCall * 4,
            monthlyCap: perCall * 15,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: uint128(bound(thresholdSeed, 1, uint256(perCall) * 2)),
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 0
        });

        vm.prank(principalOf[address(account)]);
        try account.setLimits(limits) {
            limitsRewritten[address(account)] = true;
        } catch {}
    }

    /// A purchase commits spend like any other and is never credited back.
    function buyStock(uint256 accountSeed, uint256 amountSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        uint128 ceiling = account.perCallCap();
        uint128 threshold = account.approvalThreshold();
        if (threshold <= ceiling) ceiling = threshold - 1;
        if (ceiling == 0) return;

        uint128 amount = uint128(bound(amountSeed, 1, ceiling));
        if (!_deposit(account, amount)) return;

        vm.prank(agent);
        try account.buy(address(router.STOCK()), amount, amount, 1e8) returns (uint256) {
            purchased[address(account)] += amount;
            _readWindows(account);
        } catch {}
    }

    function withdrawFromMandate(uint256 accountSeed, uint256 amountSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        address holder = principalOf[address(account)];
        uint256 amount = bound(amountSeed, 1, 50_000e6);

        vm.prank(holder);
        try account.withdraw(address(asset), holder, amount) {} catch {}
    }

    function release(uint256 idSeed, bytes32 outputCommit) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        (uint256 heldBefore, uint256 feesBefore, uint256 owedBefore) = _escrowLedger();

        vm.prank(entry.payee);
        try escrow.release(id, outputCommit, "ipfs://output") {
            _checkConservation(heldBefore, feesBefore, owedBefore, entry.amount, 0);
        } catch {}
    }

    function finalizeRelease(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        try escrow.finalizeRelease(id) {} catch {}
    }

    function timeoutLock(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        (uint256 heldBefore, uint256 feesBefore, uint256 owedBefore) = _escrowLedger();

        try escrow.timeout(id) {
            _checkConservation(heldBefore, feesBefore, owedBefore, entry.amount, 0);
        } catch {}
    }

    function cancelLock(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        (uint256 heldBefore, uint256 feesBefore, uint256 owedBefore) = _escrowLedger();

        vm.prank(entry.payee);
        try escrow.cancel(id) {
            _checkConservation(heldBefore, feesBefore, owedBefore, entry.amount, 0);
        } catch {}
    }

    function sweepFees() external {
        try escrow.sweepFees() {} catch {}
    }

    /// The bond is funded to the disputer first. What this exercises is the accounting around
    /// a posted bond, not whether a given actor happened to hold one.
    function openDispute(uint256 idSeed, bool byPayer) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        address opener = byPayer ? entry.payer : entry.payee;
        if (opener == address(0)) return;

        uint128 bond = uint128((uint256(entry.amount) * escrow.disputeBondBps()) / 10_000);
        if (bond != 0 && !_fund(opener, bond)) return;

        if (mandateLockOf[id] == opener) {
            vm.prank(principalOf[opener]);
            try MandateAccount(opener).disputeSpend(id) {} catch {}
            return;
        }

        vm.prank(opener);
        try escrow.dispute(id) {} catch {}
    }

    function commitVote(uint256 idSeed, uint256 resolverSeed, uint256 scoreSeed) external {
        uint256 disputeId = _pickDispute(idSeed);
        if (disputeId == 0) return;

        address resolver = _pick(resolvers, resolverSeed);
        uint8 score = uint8(bound(scoreSeed, 0, 100));
        committedScore[disputeId][resolver] = score;

        // Hashed before the prank, not inside the argument list. A prank binds to the next call
        // the handler makes, and a view call reaching for the hash would spend it.
        bytes32 commitment = oracle.commitmentHash(disputeId, resolver, score, _salt(disputeId, resolver));

        vm.prank(resolver);
        try oracle.commitVote(disputeId, commitment) {} catch {}
    }

    /// Reveals the whole roster in one call, and moves the clock to the reveal phase when it
    /// has not arrived. A commit-reveal scheme that is never revealed exercises only its own
    /// timeout, and the accounting under test lives on the other side of the vote.
    function revealVotes(uint256 idSeed) external {
        uint256 disputeId = _pickDispute(idSeed);
        if (disputeId == 0) return;

        IOracleRegistry.Dispute memory dispute = oracle.getDispute(disputeId);
        if (block.timestamp < dispute.commitEndsAt) vm.warp(dispute.commitEndsAt);

        address[] memory roster = oracle.voters(disputeId);
        for (uint256 i; i < roster.length; ++i) {
            address resolver = roster[i];
            vm.prank(resolver);
            try oracle.revealVote(disputeId, committedScore[disputeId][resolver], _salt(disputeId, resolver)) {}
                catch {}
        }
    }

    function finalizeDispute(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        uint256 disputeId = oracle.disputeIdOf(id);
        if (disputeId == 0) return;

        IOracleRegistry.Dispute memory dispute = oracle.getDispute(disputeId);
        if (block.timestamp < dispute.commitEndsAt) vm.warp(dispute.commitEndsAt);
        if (dispute.revealCount < dispute.commitCount && block.timestamp < dispute.revealEndsAt) {
            vm.warp(dispute.revealEndsAt);
        }

        IEscrow.Lock memory entry = escrow.getLock(id);
        (uint256 heldBefore, uint256 feesBefore, uint256 owedBefore) = _escrowLedger();

        // `finalize` calls the escrow without a try of its own, so a ruling that returns moved
        // the lock with it.
        try oracle.finalize(disputeId) {
            _checkConservation(heldBefore, feesBefore, owedBefore, entry.amount, entry.bond);
            settlements += 1;
            finalized += 1;
        } catch {}
    }

    function failDispute(uint256 idSeed) external {
        uint256 disputeId = _pickDispute(idSeed);
        if (disputeId == 0) return;

        try oracle.failDispute(disputeId) {} catch {}
    }

    /// One lock the whole way through a heard dispute: opened, contested, committed to by every
    /// resolver, revealed, ruled and paid out. Random traffic lines those steps up so rarely
    /// that an earlier version of this suite finished whole campaigns without a single ruling,
    /// and the money paths under test sit at the end of them.
    ///
    /// Whatever the run did to the actors first, they are put back where a dispute can be
    /// heard: unpaused, unfrozen, active, bonded above the floor. The step tests that a dispute
    /// can still be heard, not that a paused registry refuses one, so it is expected never to
    /// revert.
    function driveDispute(uint256 payerSeed, uint256 payeeSeed, uint256 amountSeed, uint256 scoreSeed, bool byPayer)
        external
    {
        address payer = _pick(payers, payerSeed);
        address payee = _pick(payees, payeeSeed);
        _restore(payer, payee);

        uint128 cap = reputation.capOf(payee);
        uint128 amount = uint128(bound(amountSeed, escrow.minLock(), cap < MAX_LOCK ? cap : MAX_LOCK));
        asset.mint(payer, amount);
        vm.prank(payer);
        uint256 id =
            escrow.lock(payee, CAPABILITY, keccak256(abi.encode(payer, amount)), "ipfs://job", amount, _deadline(0));
        lockIds.push(id);

        address opener = byPayer ? payer : payee;
        uint128 bond = uint128((uint256(amount) * escrow.disputeBondBps()) / 10_000);
        asset.mint(opener, bond);
        vm.prank(opener);
        escrow.dispute(id);

        uint256 disputeId = oracle.disputeIdOf(id);
        uint8 score = uint8(bound(scoreSeed, 0, 100));
        for (uint256 i; i < resolvers.length; ++i) {
            address resolver = resolvers[i];
            committedScore[disputeId][resolver] = score;
            bytes32 commitment = oracle.commitmentHash(disputeId, resolver, score, _salt(disputeId, resolver));
            vm.prank(resolver);
            oracle.commitVote(disputeId, commitment);
        }

        vm.warp(oracle.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < resolvers.length; ++i) {
            vm.prank(resolvers[i]);
            oracle.revealVote(disputeId, score, _salt(disputeId, resolvers[i]));
        }

        (uint256 heldBefore, uint256 feesBefore, uint256 owedBefore) = _escrowLedger();
        oracle.finalize(disputeId);
        _checkConservation(heldBefore, feesBefore, owedBefore, amount, bond);
        settlements += 1;
        finalized += 1;

        for (uint256 i; i < resolvers.length; ++i) {
            vm.prank(resolvers[i]);
            try oracle.claimRewards() {} catch {}
        }
    }

    function claimRewards(uint256 resolverSeed) external {
        address resolver = _pick(resolvers, resolverSeed);

        vm.prank(resolver);
        try oracle.claimRewards() {} catch {}
    }

    function sweepUnallocated() external {
        try oracle.sweepUnallocated() {} catch {}
    }

    /// Takes everything the registry holds above its reward ledger, which here is what was
    /// donated to it.
    function sweepSurplus() external {
        try oracle.sweepSurplus() {
            donated[address(oracle)] = 0;
        } catch {}
    }

    function resolverChurn(uint256 resolverSeed, uint256 actionSeed, uint256 amountSeed) external {
        address resolver = _pick(resolvers, resolverSeed);
        uint256 choice = bound(actionSeed, 0, 4);

        if (choice == 0) {
            uint128 amount = uint128(bound(amountSeed, 1, 5_000e18));
            bondAsset.mint(resolver, amount);
            vm.prank(resolver);
            try oracle.increaseBond(amount) {} catch {}
        } else if (choice == 1) {
            vm.prank(resolver);
            try oracle.requestUnbond() {} catch {}
        } else if (choice == 2) {
            vm.prank(resolver);
            try oracle.completeUnbond() {} catch {}
        } else if (choice == 3) {
            vm.prank(resolver);
            try oracle.cancelUnbond() {} catch {}
        } else {
            bondAsset.mint(resolver, RESOLVER_BOND);
            vm.prank(resolver);
            try oracle.register(RESOLVER_BOND) {} catch {}
        }
    }

    function agentChurn(uint256 payeeSeed, uint256 actionSeed, uint256 amountSeed) external {
        address payee = _pick(payees, payeeSeed);
        uint256 choice = bound(actionSeed, 0, 4);

        if (choice == 0) {
            uint128 amount = uint128(bound(amountSeed, 1, 5_000e6));
            if (!_fund(payee, amount)) return;
            vm.prank(payee);
            try registry.addStake(amount) {} catch {}
        } else if (choice == 1) {
            vm.prank(payee);
            try registry.requestWithdrawal(uint128(bound(amountSeed, 1, 5_000e6))) {} catch {}
        } else if (choice == 2) {
            vm.prank(payee);
            try registry.executeWithdrawal() {} catch {}
        } else if (choice == 3) {
            vm.prank(payee);
            try registry.deactivate() {} catch {}
        } else {
            vm.prank(payee);
            try registry.reactivate() {} catch {}
        }
    }

    /// The brake and the restart, on the escrow, the registry, the agent registry or one
    /// mandate. Stopping goes through the guardian, restarting through the timelock, as in
    /// the deployment.
    function pauseOrResume(uint256 targetSeed, bool stop) external {
        uint256 choice = bound(targetSeed, 0, 3);
        if (choice == 3) {
            MandateAccount account = MandateAccount(_pick(accounts, targetSeed));
            vm.prank(principalOf[address(account)]);
            try account.setPaused(stop) {} catch {}
            return;
        }

        address target = choice == 0 ? address(escrow) : choice == 1 ? address(oracle) : address(registry);
        if (stop) {
            address[] memory targets = new address[](1);
            targets[0] = target;
            vm.prank(guardian);
            timelock.guardianPause(targets);
        } else {
            _resume(target);
        }
    }

    /// Governance acting on the resolver set and the agent set: a slash, an eviction, or a new
    /// configuration for the votes still to come.
    function govern(uint256 actionSeed, uint256 targetSeed, uint256 amountSeed) external {
        uint256 choice = bound(actionSeed, 0, 3);
        address resolver = _pick(resolvers, targetSeed);

        if (choice == 0) {
            vm.prank(address(timelock));
            try oracle.slash(resolver, uint128(bound(amountSeed, 1, RESOLVER_BOND))) {} catch {}
        } else if (choice == 1) {
            vm.prank(address(timelock));
            try oracle.evict(resolver) {} catch {}
        } else if (choice == 2) {
            vm.prank(address(timelock));
            try registry.slash(_pick(payees, targetSeed), bound(amountSeed, 1, 1_000e6), bytes32("governance")) {}
                catch {}
        } else {
            vm.prank(address(timelock));
            try oracle.setConfig(_config(amountSeed)) {} catch {}
        }
    }

    /// The issuer's per-address freeze, on a payer, a payee or a mandate account. Every exit
    /// still has to land, with the frozen share booked instead of paid.
    function freeze(uint256 groupSeed, uint256 actorSeed, bool frozen) external {
        uint256 group = bound(groupSeed, 0, 2);
        address who =
            group == 0 ? _pick(payers, actorSeed) : group == 1 ? _pick(payees, actorSeed) : _pick(accounts, actorSeed);
        asset.setFrozen(who, frozen);
    }

    function claimOwed(uint256 groupSeed, uint256 actorSeed) external {
        uint256 group = bound(groupSeed, 0, 2);
        address who =
            group == 0 ? _pick(payers, actorSeed) : group == 1 ? _pick(payees, actorSeed) : _pick(accounts, actorSeed);
        try escrow.claim(who) {} catch {}
    }

    /// A stray transfer to a contract that keeps its own ledger. None of them may fold it into
    /// what they owe, so every balance identity carries `donated` as a separate term.
    function donate(uint256 targetSeed, uint256 amountSeed) external {
        uint256 choice = bound(targetSeed, 0, 3);
        address target = choice == 0
            ? address(escrow)
            : choice == 1 ? address(oracle) : choice == 2 ? address(registry) : _pick(accounts, amountSeed);

        uint256 amount = bound(amountSeed, 1, 10_000e6);
        if (!_fund(target, amount)) return;
        donated[target] += amount;
    }

    function warpForward(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 minutes, 10 days));
    }

    function lockCount() external view returns (uint256) {
        return lockIds.length;
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    function resolverCount() external view returns (uint256) {
        return resolvers.length;
    }

    function burnedCount() external view returns (uint256) {
        return _burned.length;
    }

    /// Everything the escrow has booked to a party it could not pay.
    function owedTotal() public view returns (uint256 total) {
        total = _owedAcross(payers) + _owedAcross(payees) + _owedAcross(accounts);
        total += escrow.owed(address(oracle));
    }

    /// The whole of decision D restated against the figures the escrow keeps:
    ///
    ///     refunded + paid + protocolFee + resolverFee + bondLeg == amount + bond
    ///
    /// Every leg on the left except `protocolFee` either leaves the contract or is booked to a
    /// party it could not reach, `protocolFee` is exactly the rise in `feesAccrued`, and a
    /// booked leg is exactly the rise in what is owed. Stated this way it covers release,
    /// timeout, cancellation and a ruling with one check.
    function _checkConservation(
        uint256 heldBefore,
        uint256 feesBefore,
        uint256 owedBefore,
        uint128 amount,
        uint128 bond
    ) private {
        (uint256 heldAfter, uint256 feesAfter, uint256 owedAfter) = _escrowLedger();
        uint256 kept = feesAfter - feesBefore;
        uint256 booked = owedAfter - owedBefore;

        if (heldBefore + kept + booked != heldAfter + uint256(amount) + bond) conservationBreaks += 1;
    }

    function _escrowLedger() private view returns (uint256 held, uint256 fees, uint256 owed) {
        return (asset.balanceOf(address(escrow)), escrow.feesAccrued(), owedTotal());
    }

    function _owedAcross(address[] storage group) private view returns (uint256 total) {
        for (uint256 i; i < group.length; ++i) {
            total += escrow.owed(group[i]);
        }
    }

    function _recordSpend(MandateAccount account, uint256 escrowId) private {
        lockIds.push(escrowId);
        mandateLockOf[escrowId] = address(account);
        _readWindows(account);
    }

    /// A window is allowed to sit at its cap and never above it. Read straight after a spend
    /// lands, because the invariant functions only see the end of a sequence and a bucket that
    /// overshot and then rolled would be gone by then.
    function _readWindows(MandateAccount account) private {
        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

        if (daily.spent > daily.cap || monthly.spent > monthly.cap) capBreaks += 1;
    }

    /// Puts the parties to a new dispute, and every resolver, back where a dispute can be heard.
    function _restore(address payer, address payee) private {
        _resume(address(escrow));
        _resume(address(oracle));
        _resume(address(registry));
        asset.setFrozen(payer, false);
        asset.setFrozen(payee, false);

        if (!registry.isActive(payee)) {
            uint256 floor = registry.minStake();
            uint256 staked = registry.stakeOf(payee);
            if (staked < floor) {
                // `floor` is a uint128 figure and `staked` is below it.
                // forge-lint: disable-next-line(unsafe-typecast)
                uint128 topUp = uint128(floor - staked);
                asset.mint(payee, topUp);
                vm.prank(payee);
                registry.addStake(topUp);
            }
            if (!registry.getAgent(payee).active) {
                vm.prank(payee);
                registry.reactivate();
            }
        }

        for (uint256 i; i < resolvers.length; ++i) {
            _seat(resolvers[i]);
        }
    }

    function _seat(address resolver) private {
        IOracleRegistry.Resolver memory record = oracle.getResolver(resolver);

        if (record.status == IOracleRegistry.ResolverStatus.Unbonding) {
            vm.prank(resolver);
            oracle.cancelUnbond();
        } else if (
            record.status == IOracleRegistry.ResolverStatus.None
                || record.status == IOracleRegistry.ResolverStatus.Exited
        ) {
            bondAsset.mint(resolver, RESOLVER_BOND);
            vm.prank(resolver);
            oracle.register(RESOLVER_BOND);
            return;
        }

        uint256 floor = pool.minBondOf(resolver);
        if (record.bond < floor) {
            // The floor is a BRSR amount far inside uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128 topUp = uint128(floor - record.bond);
            bondAsset.mint(resolver, topUp);
            vm.prank(resolver);
            oracle.increaseBond(topUp);
        }
    }

    /// Restarting is the timelock's call on all three, as in the deployment.
    function _resume(address target) private {
        if (!IBrake(target).paused()) return;
        vm.prank(address(timelock));
        IBrake(target).unpause();
    }

    /// Any configuration the registry accepts, up to a quorum all three resolvers can reach.
    function _config(uint256 seed) private pure returns (IOracleRegistry.Config memory cfg) {
        uint64 commit = uint64(bound(uint256(keccak256(abi.encode(seed, "commit"))), 10 minutes, 2 days));
        uint64 reveal = uint64(bound(uint256(keccak256(abi.encode(seed, "reveal"))), 10 minutes, 2 days));
        cfg = IOracleRegistry.Config({
            commitWindow: commit,
            revealWindow: reveal,
            unbondingPeriod: commit + reveal + uint64(bound(seed, 0, 7 days)),
            quorum: uint8(bound(seed >> 8, 1, 3)),
            maxVoters: 64,
            maxDeviation: uint8(bound(seed >> 16, 0, 100)),
            slashBps: uint16(bound(seed >> 24, 1, 10_000))
        });
    }

    /// Spendable now under the account's per-call cap, or zero when the cap sits under the
    /// escrow's floor and no spend can open a lock.
    function _spendable(MandateAccount account, uint256 amountSeed) private view returns (uint128) {
        uint128 floor = escrow.minLock();
        uint128 ceiling = account.perCallCap();
        if (ceiling < floor) return 0;
        return uint128(bound(amountSeed, floor, ceiling));
    }

    function _deposit(MandateAccount account, uint128 amount) private returns (bool) {
        address holder = principalOf[address(account)];
        if (!_fund(holder, amount)) return false;

        vm.prank(holder);
        try account.deposit(amount) {
            return true;
        } catch {
            return false;
        }
    }

    function _approval(address payee, uint128 amount) private returns (IMandateAccount.SpendApproval memory) {
        return IMandateAccount.SpendApproval({
            approvalId: keccak256(abi.encode("mandate.invariant.approval", ++approvalCount)),
            merchant: payee,
            capabilityId: CAPABILITY,
            amount: amount,
            expiry: uint64(block.timestamp + 30 days)
        });
    }

    function _sign(MandateAccount account, IMandateAccount.SpendApproval memory approval)
        private
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                account.SPEND_APPROVAL_TYPEHASH(),
                approval.approvalId,
                approval.merchant,
                approval.capabilityId,
                approval.amount,
                approval.expiry
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", account.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyOf[principalOf[address(account)]], digest);
        return abi.encodePacked(r, s, v);
    }

    function _request(address payee, uint128 amount, uint256 ttlSeed)
        private
        view
        returns (IMandateAccount.SpendRequest memory)
    {
        uint64 deadline = _deadline(ttlSeed);
        return IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: keccak256(abi.encode(payee, amount, deadline)),
            inputURI: "ipfs://job",
            amount: amount,
            deadline: deadline,
            spendClass: 0
        });
    }

    /// The issuer refuses a mint to a frozen address as it refuses any transfer to one.
    function _fund(address who, uint256 amount) private returns (bool) {
        if (asset.isFrozen(who)) return false;
        asset.mint(who, amount);
        return true;
    }

    function _deadline(uint256 ttlSeed) private view returns (uint64) {
        return uint64(block.timestamp + bound(ttlSeed, MIN_TTL + 1, MAX_TTL - 1));
    }

    function _pick(address[] storage group, uint256 seed) private view returns (address) {
        return group[seed % group.length];
    }

    function _pickLock(uint256 seed) private view returns (uint256) {
        if (lockIds.length == 0) return 0;
        return lockIds[seed % lockIds.length];
    }

    function _pickDispute(uint256 seed) private view returns (uint256) {
        uint256 id = _pickLock(seed);
        if (id == 0) return 0;
        return oracle.disputeIdOf(id);
    }

    function _salt(uint256 disputeId, address resolver) private pure returns (bytes32) {
        return keccak256(abi.encode("mandate.invariant.salt", disputeId, resolver));
    }
}

/// Protocol-wide properties, held under random sequences across the whole deployment.
///
/// The one the settlement asset exists to prove: a token that publishes a second, larger view
/// of the same balance, where both numbers describe the same money. A contract that reads the
/// larger view into an accounting figure inflates it by 1e12. Two tests stand behind that here,
/// a balance identity on every address the system touches and a bytecode scan proving no
/// contract can read the second view at all, and the solvency identities below would fail
/// loudly if either slipped. USDG does not publish one. Some USDC deployments do, which is why
/// the property is worth holding on to.
contract MandateInvariants is Test {
    uint16 internal constant FEE_BPS = 250;
    uint16 internal constant RESOLVER_FEE_BPS = 100;
    uint16 internal constant DISPUTE_BOND_BPS = 500;
    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint64 internal constant DISPUTE_WINDOW = 1 days;
    uint128 internal constant MIN_LOCK = 10_000;
    uint64 internal constant TIMELOCK_PERIOD = 48 hours;

    uint128 internal constant BASE_CAP = 20_000e6;
    uint128 internal constant CAP_PER_SCORE = 500e6;
    uint128 internal constant MAX_CAP = 60_000e6;

    uint128 internal constant MIN_STAKE = 1_000e6;

    /// Resolver bonds are BRSR at eighteen decimals, unlike every other figure here.
    uint128 internal constant MIN_BOND = 1_000e18;
    uint128 internal constant RESOLVER_BOND = 2_000e18;

    uint128 internal constant PER_CALL_CAP = 10_000e6;
    uint128 internal constant DAILY_CAP = 40_000e6;
    uint128 internal constant MONTHLY_CAP = 150_000e6;
    uint128 internal constant APPROVAL_THRESHOLD = 5_000e6;

    /// One unit at six decimals is 1e12 units at eighteen. Any accounting figure that had been
    /// read off the native view would be this many times too large.
    uint256 internal constant NATIVE_SCALE = 1e12;

    bytes32 internal constant CAPABILITY = keccak256("mandate.invariant.capability");

    DualViewERC20 internal asset;
    MockBRSR internal bondAsset;
    Staking internal pool;
    AdminTimelock internal timelock;
    Reputation internal reputation;
    Escrow internal escrow;
    OracleRegistry internal oracle;
    AgentRegistry internal registry;
    MandateAccountFactory internal factory;
    InvariantRouter internal router;
    MandateSystemHandler internal handler;

    address internal principal;
    address internal successor;
    uint256 internal principalKey;
    uint256 internal successorKey;
    address internal agent = makeAddr("agent");
    address internal treasury = makeAddr("treasury");
    address internal slashSink = makeAddr("slashSink");
    address internal guardian = makeAddr("guardian");

    address[3] internal signers;

    /// Keeps every approval id in the deterministic tests distinct. An id is burned on use, so
    /// a second approval reusing one is refused before the spend it was meant to authorise.
    uint256 internal fixtureNonce;

    address[] internal payers;
    address[] internal payees;
    address[] internal resolvers;
    address[] internal accounts;

    /// Every address the settlement asset can reach. Conservation is stated against this set,
    /// so a transfer to anywhere outside it would show up as supply that went missing.
    address[] internal holders;

    function setUp() public {
        (principal, principalKey) = makeAddrAndKey("principal");
        (successor, successorKey) = makeAddrAndKey("successor");

        asset = new DualViewERC20();
        bondAsset = new MockBRSR();

        signers[0] = makeAddr("timelockSignerOne");
        signers[1] = makeAddr("timelockSignerTwo");
        signers[2] = makeAddr("timelockSignerThree");

        timelock = new AdminTimelock(signers, guardian, TIMELOCK_PERIOD);

        reputation = new Reputation(
            address(timelock), IReputation.CapCurve({baseCap: BASE_CAP, capPerScore: CAP_PER_SCORE, maxCap: MAX_CAP})
        );

        escrow = new Escrow(
            address(asset),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            DISPUTE_WINDOW,
            MIN_LOCK
        );

        // Quorum of two, as deployed. The drive step in the handler takes a dispute all the way
        // to a ruling on its own, so the reward and bond accounting does not depend on the
        // random walk lining up a quorum. The unbonding period covers the whole vote.
        oracle = new OracleRegistry(
            address(asset),
            address(timelock),
            slashSink,
            IOracleRegistry.Config({
                commitWindow: 1 days,
                revealWindow: 1 days,
                unbondingPeriod: 3 days,
                quorum: 2,
                maxVoters: 64,
                maxDeviation: 15,
                slashBps: 500
            })
        );

        registry = new AgentRegistry(IERC20(address(asset)), address(timelock), slashSink, MIN_STAKE, 1_000);

        // Bonds are BRSR and the floor that admits one is the pool's. In the live system this
        // pool arrives with the token set and the deploy key closes the link; here the fixture
        // stands in for that second run.
        pool = new Staking(bondAsset, asset, address(timelock), slashSink, treasury, 7 days, MIN_BOND);

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(oracle));
        escrow.setPauser(address(timelock));
        oracle.setEscrow(address(escrow));
        oracle.setStaking(address(pool));
        escrow.setRegistry(registry);

        // `AgentRegistry.slasher` is left unset, as the deployment leaves it. The resolver
        // produces a quality score and has no figure to take off an agent's balance sheet, so
        // naming it here would assert a capability nothing in this system has.

        factory = new MandateAccountFactory(address(escrow), address(asset));
        router = new InvariantRouter(IERC20(address(asset)));

        _seedActors();
        _openMandates();
        _collectHolders();

        handler = new MandateSystemHandler(
            SystemWiring({
                asset: asset,
                bondAsset: bondAsset,
                escrow: escrow,
                oracle: oracle,
                registry: registry,
                reputation: reputation,
                pool: pool,
                timelock: timelock,
                router: router,
                guardian: guardian,
                agent: agent,
                principals: [principal, successor],
                principalKeys: [principalKey, successorKey],
                payers: payers,
                payees: payees,
                resolvers: resolvers,
                accounts: accounts
            })
        );
        holders.push(address(handler));

        bytes4[] memory selectors = new bytes4[](31);
        selectors[0] = MandateSystemHandler.lockFromPayer.selector;
        selectors[1] = MandateSystemHandler.spendFromMandate.selector;
        selectors[2] = MandateSystemHandler.spendSigned.selector;
        selectors[3] = MandateSystemHandler.revokeSigned.selector;
        selectors[4] = MandateSystemHandler.replayBurned.selector;
        selectors[5] = MandateSystemHandler.handOver.selector;
        selectors[6] = MandateSystemHandler.rewriteLimits.selector;
        selectors[7] = MandateSystemHandler.buyStock.selector;
        selectors[8] = MandateSystemHandler.withdrawFromMandate.selector;
        selectors[9] = MandateSystemHandler.release.selector;
        selectors[10] = MandateSystemHandler.finalizeRelease.selector;
        selectors[11] = MandateSystemHandler.timeoutLock.selector;
        selectors[12] = MandateSystemHandler.cancelLock.selector;
        selectors[13] = MandateSystemHandler.sweepFees.selector;
        selectors[14] = MandateSystemHandler.openDispute.selector;
        selectors[15] = MandateSystemHandler.commitVote.selector;
        selectors[16] = MandateSystemHandler.revealVotes.selector;
        selectors[17] = MandateSystemHandler.finalizeDispute.selector;
        selectors[18] = MandateSystemHandler.failDispute.selector;
        selectors[19] = MandateSystemHandler.driveDispute.selector;
        selectors[20] = MandateSystemHandler.claimRewards.selector;
        selectors[21] = MandateSystemHandler.sweepUnallocated.selector;
        selectors[22] = MandateSystemHandler.sweepSurplus.selector;
        selectors[23] = MandateSystemHandler.resolverChurn.selector;
        selectors[24] = MandateSystemHandler.agentChurn.selector;
        selectors[25] = MandateSystemHandler.pauseOrResume.selector;
        selectors[26] = MandateSystemHandler.govern.selector;
        selectors[27] = MandateSystemHandler.freeze.selector;
        selectors[28] = MandateSystemHandler.claimOwed.selector;
        selectors[29] = MandateSystemHandler.donate.selector;
        selectors[30] = MandateSystemHandler.warpForward.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// One balance, two numbers. The native view is the ERC-20 view scaled by 1e12 and never an
    /// account of its own, so anything that added them would report a holder's money twice.
    function invariant_theNativeViewIsAlwaysTheSameMoneyAsTheErc20View() public view {
        for (uint256 i; i < holders.length; ++i) {
            address holder = holders[i];
            assertEq(
                asset.nativeBalanceOf(holder),
                asset.balanceOf(holder) * NATIVE_SCALE,
                "the eighteen-decimal view drifted from the six-decimal view of the same balance"
            );
        }
    }

    /// A ledger figure taken from the native view would be a trillion times the six-decimal
    /// supply. None of them are within a factor of one of it.
    function invariant_noLedgerFigureEverCrossesIntoTheNativeScale() public view {
        uint256 supply = asset.totalSupply();

        assertLe(uint256(escrow.feesAccrued()), supply, "escrow fees exceed the entire settlement supply");
        assertLe(oracle.rewardFloat(), supply, "resolver rewards exceed the entire settlement supply");
        assertLe(uint256(oracle.totalBonded()), bondAsset.totalSupply(), "resolver bonds exceed the entire bond supply");
        assertLe(uint256(registry.totalStaked()), supply, "agent stake exceeds the entire settlement supply");

        for (uint256 i; i < accounts.length; ++i) {
            IMandateAccount.Window memory daily = MandateAccount(accounts[i]).window(IMandateAccount.WindowKind.Daily);
            assertLe(uint256(daily.spent), supply, "mandate window spend exceeds the entire settlement supply");
        }
    }

    /// Exact, not a floor. The escrow holds the principal of every live lock, the bonds posted
    /// against them, the fees it has not swept, the payouts it booked to parties it could not
    /// reach, and whatever was pushed at it by mistake. There is no sixth term, and a stray
    /// transfer is not reachable by `sweepFees` or `claim`.
    function invariant_escrowHoldsItsLiveLocksItsBondsAndTheFeesItOwes() public view {
        (uint256 livePrincipal, uint256 liveBonds) = _liveEscrowExposure();

        assertEq(
            asset.balanceOf(address(escrow)),
            livePrincipal + liveBonds + uint256(escrow.feesAccrued()) + handler.owedTotal()
                + handler.donated(address(escrow)),
            "escrow balance drifted from its live locks, posted bonds, accrued fees and booked payouts"
        );
    }

    function invariant_escrowNeverOwesTheTreasuryMoreThanItHolds() public view {
        assertLe(
            uint256(escrow.feesAccrued()),
            asset.balanceOf(address(escrow)),
            "accrued fees outran the escrow balance, so a sweep would pay out locked principal"
        );
    }

    /// Two assets, two ledgers, and neither reaches the other. The settlement asset held here
    /// is the reward float and nothing else, and the bonds are BRSR.
    function invariant_oracleRegistryHoldsOnlyBondsAndTheRewardFloat() public view {
        assertEq(
            asset.balanceOf(address(oracle)),
            oracle.rewardFloat() + handler.donated(address(oracle)),
            "resolver registry settlement balance drifted from its reward ledger"
        );
        assertEq(
            bondAsset.balanceOf(address(oracle)),
            uint256(oracle.totalBonded()),
            "resolver registry bond balance drifted from its bond ledger"
        );
    }

    /// A reward is credited to resolvers or set aside for the sink, never both and never
    /// neither. Otherwise the float is a number that pays nobody.
    function invariant_everyRewardInTheFloatIsOwedToSomeone() public view {
        uint256 owed;
        for (uint256 i; i < resolvers.length; ++i) {
            owed += oracle.rewardsOf(resolvers[i]);
        }

        assertEq(
            owed + oracle.unallocatedRewards(),
            oracle.rewardFloat(),
            "the reward float and the claims against it disagree"
        );
    }

    function invariant_agentRegistryHoldsExactlyTheStakeLedger() public view {
        assertEq(
            asset.balanceOf(address(registry)),
            uint256(registry.totalStaked()) + handler.donated(address(registry)),
            "agent registry balance drifted from its stake ledger"
        );
    }

    function invariant_settlementSupplyIsConservedAcrossEveryActor() public view {
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += asset.balanceOf(holders[i]);
        }

        assertEq(sum, asset.totalSupply(), "settlement asset left the set of addresses the system can reach");
    }

    /// Until its limits are rewritten, a bucket holding more than its cap can only have come
    /// from a spend that should have been refused. A cap lowered under what was already spent
    /// leaves the spend standing, so those accounts are held to the check made at each spend.
    function invariant_mandateWindowSpendNeverExceedsItsCap() public view {
        for (uint256 i; i < accounts.length; ++i) {
            MandateAccount account = MandateAccount(accounts[i]);
            if (handler.limitsRewritten(address(account))) continue;

            IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
            IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

            assertLe(daily.spent, daily.cap, "a mandate spent past its daily cap");
            assertLe(monthly.spent, monthly.cap, "a mandate spent past its monthly cap");
        }

        assertEq(handler.capBreaks(), 0, "a mandate window held more spend than its cap admits");
    }

    function invariant_everySettlementPathConservesTheLockAndItsBond() public view {
        assertEq(
            handler.conservationBreaks(),
            0,
            "a settlement moved a different amount than the lock and bond it was closing"
        );
    }

    /// A lock that still holds a disputed payment always has a way out that works, once its
    /// reveal window has closed: `finalize` when the vote reached quorum, `failDispute` when it
    /// did not. Tried against a snapshot, so the check moves nothing. A frozen party, a paused
    /// contract or a changed configuration may not close both doors.
    function invariant_everyDisputedLockHasAnExitThatSucceeds() public {
        uint256 count = handler.lockCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = handler.lockIds(i);
            IEscrow.Lock memory entry = escrow.getLock(id);
            if (entry.status != IEscrow.LockStatus.Disputed || entry.releasedAt != 0) continue;

            uint256 disputeId = oracle.disputeIdOf(id);
            IOracleRegistry.Dispute memory dispute = oracle.getDispute(disputeId);

            uint256 snapshot = vm.snapshotState();
            if (block.timestamp < dispute.revealEndsAt) vm.warp(dispute.revealEndsAt);

            bool heard = dispute.revealCount >= oracle.config().quorum;
            (bool exited,) = address(oracle)
                .call(
                    heard
                        ? abi.encodeCall(OracleRegistry.finalize, (disputeId))
                        : abi.encodeCall(OracleRegistry.failDispute, (disputeId))
                );
            IEscrow.LockStatus after_ = escrow.getLock(id).status;
            vm.revertToState(snapshot);

            assertTrue(exited, "a disputed lock had no exit that worked");
            assertTrue(after_ != IEscrow.LockStatus.Disputed, "the exit left the lock frozen");
        }
    }

    /// Every open vote is a commitment on a dispute that has not closed, and every such
    /// commitment is an open vote. A count that drifts either way either pins a bond for good
    /// or frees one a live vote still needs.
    function invariant_openVotesEqualTheCommitmentsOnOpenDisputes() public view {
        uint256 committed;
        uint256 next = oracle.nextDisputeId();
        for (uint256 disputeId = 1; disputeId < next; ++disputeId) {
            IOracleRegistry.Dispute memory dispute = oracle.getDispute(disputeId);
            bool open = dispute.status == IOracleRegistry.DisputeStatus.Committing
                || dispute.status == IOracleRegistry.DisputeStatus.Revealing;
            if (open) committed += dispute.commitCount;
        }

        uint256 held;
        for (uint256 i; i < resolvers.length; ++i) {
            held += oracle.openVotes(resolvers[i]);
        }

        assertEq(held, committed, "open votes and live commitments disagree");
    }

    /// A mandate's lifetime spend is what it can still get back from the escrow plus what it
    /// spent on stock, which never comes back. Anything else in `totalSpent` is budget the
    /// account lost or invented.
    function invariant_totalSpentIsWhatIsStillRefundablePlusWhatWasBought() public view {
        uint256 count = handler.lockCount();
        for (uint256 a; a < accounts.length; ++a) {
            MandateAccount account = MandateAccount(accounts[a]);

            uint256 refundable;
            for (uint256 i; i < count; ++i) {
                uint256 id = handler.lockIds(i);
                if (handler.mandateLockOf(id) == address(account)) refundable += account.creditable(id);
            }

            assertEq(
                account.totalSpent(),
                refundable + handler.purchased(address(account)),
                "a mandate's lifetime spend drifted from its locks and purchases"
            );
        }
    }

    /// One lock, one counter. Every counted lock moved exactly one of the payee's counters, and
    /// no counter moved for a lock that was not counted.
    function invariant_eachLockMovesAtMostOneReputationCounter() public view {
        uint256 counted;
        uint256 count = handler.lockCount();
        for (uint256 i; i < count; ++i) {
            if (escrow.getLock(handler.lockIds(i)).counted) counted += 1;
        }

        uint256 moved;
        for (uint256 i; i < payees.length; ++i) {
            (uint64 released, uint64 timedOut, uint64 disputed) = reputation.payeeStats(payees[i]);
            moved += uint256(released) + timedOut + disputed;
        }

        assertEq(moved, counted, "a lock moved a second counter, or a counter moved for no lock");
    }

    /// A spent or revoked approval id stays burned, through any number of handovers.
    function invariant_aBurnedApprovalNeverOpensALock() public view {
        assertEq(handler.replays(), 0, "a spent or revoked approval opened a lock");
    }

    /// A run that never reached a ruling proved nothing about the money paths. When the random
    /// walk did not get there, one more dispute is driven from wherever the run left the
    /// system, which also proves a dispute can still be heard from that state.
    function afterInvariant() public {
        if (handler.finalized() == 0) handler.driveDispute(0, 0, 5_000e6, 70, true);
        assertGt(handler.finalized(), 0, "no dispute reached a ruling in this run");
    }

    /// Reads the deployed bytecode, not the source, because a comment saying the native view
    /// is never touched is worth exactly as much as the compiler's opinion of it. BALANCE
    /// and SELFBALANCE are the only two ways an EVM contract can ask for the eighteen-decimal
    /// figure, and neither appears in any of these.
    function test_noContractInTheSystemCanReadTheNativeBalanceView() public view {
        _assertNoBalanceOpcode("Escrow", address(escrow));
        _assertNoBalanceOpcode("OracleRegistry", address(oracle));
        _assertNoBalanceOpcode("AgentRegistry", address(registry));
        _assertNoBalanceOpcode("Reputation", address(reputation));
        _assertNoBalanceOpcode("AdminTimelock", address(timelock));
        // The account's creation code lives in the blueprint, behind a STOP, and is never run
        // there. The factory is read as its own instructions here, and the child through every
        // account it has produced, below.
        _assertNoBalanceOpcode("MandateAccountFactory", address(factory));

        for (uint256 i; i < accounts.length; ++i) {
            _assertNoBalanceOpcode("MandateAccount", accounts[i]);
        }
    }

    function testFuzz_summingBothViewsOfOneBalanceCountsItTwice(uint96 amount) public {
        vm.assume(amount != 0);
        address holder = payees[0];

        uint256 before = asset.balanceOf(holder);
        asset.mint(holder, amount);

        uint256 erc20View = asset.balanceOf(holder);
        uint256 nativeView = asset.nativeBalanceOf(holder);

        assertEq(erc20View, before + amount, "the six-decimal view missed the mint");
        assertEq(nativeView, erc20View * NATIVE_SCALE, "the eighteen-decimal view is not the same balance scaled");
        assertEq(
            nativeView / NATIVE_SCALE + erc20View,
            erc20View * 2,
            "rescaling the native view and adding it reports the balance twice, which is the trap"
        );
    }

    /// Guards against a vacuous suite. Every handler action swallows its own revert, so a
    /// fixture wired slightly wrong would run clean and prove nothing. This drives one lock
    /// through a bonded dispute to a ruling and asserts the states it passed through.
    function test_theFixtureDrivesALockThroughABondedDisputeToARuling() public {
        handler.lockFromPayer(0, 0, 5_000e6, 2 days);
        assertEq(handler.lockCount(), 1, "the fixture could not open a single lock");

        uint256 id = handler.lockIds(0);
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked), "the lock did not open");

        handler.openDispute(0, true);
        IEscrow.Lock memory disputed = escrow.getLock(id);
        assertEq(uint8(disputed.status), uint8(IEscrow.LockStatus.Disputed), "the payer could not open a dispute");
        assertEq(disputed.bond, uint128((uint256(5_000e6) * DISPUTE_BOND_BPS) / 10_000), "the dispute took no bond");

        handler.commitVote(0, 0, 30);
        handler.commitVote(0, 1, 30);
        handler.revealVotes(0);
        handler.finalizeDispute(0);

        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Resolved), "the ruling never landed");
        assertEq(handler.settlements(), 1, "the ruling was not counted as a settlement");
        assertEq(handler.conservationBreaks(), 0, "the ruling did not conserve the lock and its bond");

        // A score of 30 is a full refund, and a payer who asked for one and got it keeps the
        // bond. What is left of the principal is the resolver fee, which is now at the oracle,
        // in the settlement asset and not among the BRSR bonds.
        assertEq(
            asset.balanceOf(address(oracle)), oracle.rewardFloat(), "the resolver fee did not land on the reward ledger"
        );
        assertEq(bondAsset.balanceOf(address(oracle)), uint256(oracle.totalBonded()), "a bond was touched");

        invariant_escrowHoldsItsLiveLocksItsBondsAndTheFeesItOwes();
        invariant_settlementSupplyIsConservedAcrossEveryActor();
        invariant_everyRewardInTheFloatIsOwedToSomeone();
    }

    /// The drive step is what the campaign leans on to reach the money paths, so it has to land
    /// from a clean start and from a messy one alike.
    function test_theDriveStepTakesADisputeToARulingEvenAfterTheSystemWasStopped() public {
        handler.driveDispute(0, 0, 5_000e6, 70, true);
        assertEq(handler.finalized(), 1, "the drive step did not reach a ruling");

        handler.pauseOrResume(0, true);
        handler.pauseOrResume(1, true);
        handler.freeze(1, 0, true);
        handler.govern(1, 0, 0);
        vm.prank(resolvers[1]);
        oracle.requestUnbond();

        handler.driveDispute(0, 0, 5_000e6, 70, true);
        assertEq(handler.finalized(), 2, "the drive step could not recover the system it found");
        assertEq(handler.conservationBreaks(), 0);
        invariant_openVotesEqualTheCommitmentsOnOpenDisputes();
        invariant_eachLockMovesAtMostOneReputationCounter();
    }

    /// Sign, spend, hand the account over and back, then present the same signature again.
    function test_aSpentSignatureStaysSpentAcrossAHandoverAndBack() public {
        handler.spendSigned(0, 0, 2_000e6, 3 days);
        assertEq(handler.burnedCount(), 1, "the signed spend did not land");

        handler.handOver(0);
        handler.handOver(0);
        assertEq(handler.principalOf(accounts[0]), principal, "the account did not come back");

        handler.replayBurned(0, 3 days);
        assertEq(handler.replays(), 0, "the spent signature opened a second lock");
        invariant_totalSpentIsWhatIsStillRefundablePlusWhatWasBought();
    }

    function test_theFixtureDrivesAMandateSpendThroughReleaseAndFeeSweep() public {
        handler.spendFromMandate(0, 1, 1_000e6, 3 days);
        assertEq(handler.lockCount(), 1, "the mandate could not spend");

        uint256 id = handler.lockIds(0);
        assertEq(escrow.getLock(id).payer, accounts[0], "the mandate account is not the payer on its own spend");

        handler.release(0, keccak256("output"));
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Released), "the payee could not release");

        uint128 fee = uint128((uint256(1_000e6) * FEE_BPS) / 10_000);
        assertEq(escrow.feesAccrued(), fee, "the protocol fee was not accrued");
        assertEq(asset.balanceOf(payees[1]), _stakeSurplus(payees[1]) + 1_000e6 - fee, "the payee was underpaid");

        handler.sweepFees();
        assertEq(asset.balanceOf(treasury), fee, "the treasury did not receive the swept fee");
        assertEq(asset.balanceOf(address(escrow)), 0, "the escrow kept value after settling its only lock");
        assertEq(handler.conservationBreaks(), 0, "the release did not conserve the lock");
    }

    /// The cap is the control that keeps a single lock from being larger than the payee's
    /// history supports, so it has to bind at exactly one unit over.
    function test_escrowRefusesALockOneUnitAboveThePayeeCap() public {
        address payer = payers[0];
        address payee = payees[2];
        uint128 cap = reputation.capOf(payee);
        assertEq(cap, BASE_CAP, "an unscored payee did not sit at the base cap");

        asset.mint(payer, uint256(cap) * 2 + 1);

        vm.prank(payer);
        vm.expectRevert(IEscrow.PayeeCapExceeded.selector);
        escrow.lock(payee, CAPABILITY, bytes32(0), "ipfs://job", cap + 1, uint64(block.timestamp + 2 days));

        vm.prank(payer);
        uint256 id = escrow.lock(payee, CAPABILITY, bytes32(0), "ipfs://job", cap, uint64(block.timestamp + 2 days));
        assertEq(escrow.getLock(id).amount, cap, "a lock at exactly the cap was refused");
    }

    function test_escrowRefusesALockOnAPayeeThatLeftTheRegistry() public {
        address payer = payers[0];
        address payee = payees[2];
        asset.mint(payer, 1_000e6);

        vm.prank(payee);
        registry.deactivate();

        vm.prank(payer);
        vm.expectRevert(IEscrow.PartyNotAllowed.selector);
        escrow.lock(payee, CAPABILITY, bytes32(0), "ipfs://job", 1_000e6, uint64(block.timestamp + 2 days));

        vm.prank(payee);
        registry.reactivate();

        vm.prank(payer);
        escrow.lock(payee, CAPABILITY, bytes32(0), "ipfs://job", 1_000e6, uint64(block.timestamp + 2 days));
    }

    /// Boundary and boundary plus one on the window the invariant watches: four spends fill the
    /// daily cap exactly, and the next unit is refused.
    function test_mandateRefusesTheUnitThatWouldCrossTheDailyCap() public {
        MandateAccount account = MandateAccount(accounts[0]);
        address payee = payees[0];

        for (uint256 i; i < DAILY_CAP / PER_CALL_CAP; ++i) {
            _spendExactly(account, payee, PER_CALL_CAP);
        }

        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        assertEq(daily.spent, DAILY_CAP, "the daily bucket did not fill to the cap");

        (, uint128 remainingDaily,) = account.remaining();
        assertEq(remainingDaily, 0, "a full bucket reported headroom");

        asset.mint(principal, 1);
        vm.prank(principal);
        account.deposit(1);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.DailyCapExceeded.selector);
        account.spend(
            IMandateAccount.SpendRequest({
                merchant: payee,
                capabilityId: CAPABILITY,
                inputCommit: bytes32(0),
                inputURI: "ipfs://job",
                amount: 1,
                deadline: uint64(block.timestamp + 2 days),
                spendClass: 0
            }),
            new bytes32[](0)
        );
    }

    /// The sweep is permissionless, so the only thing standing between a passer-by and a
    /// payer's locked principal is that `feesAccrued` is credited from settlements and never
    /// from a balance reading.
    function test_sweepingFeesCannotReachLockedPrincipal() public {
        address payer = payers[0];
        asset.mint(payer, 4_000e6);

        vm.prank(payer);
        uint256 id =
            escrow.lock(payees[0], CAPABILITY, bytes32(0), "ipfs://job", 4_000e6, uint64(block.timestamp + 2 days));

        vm.expectRevert(IEscrow.ZeroAmount.selector);
        escrow.sweepFees();

        vm.prank(payees[0]);
        escrow.release(id, keccak256("output"), "ipfs://output");

        uint128 fee = uint128(uint256(4_000e6) * FEE_BPS / 10_000);
        assertEq(escrow.sweepFees(), fee, "the sweep paid something other than the accrued fee");
        assertEq(asset.balanceOf(address(escrow)), 0, "the escrow held value it did not owe anyone");
    }

    function _seedActors() private {
        for (uint256 i; i < 3; ++i) {
            address payer = makeAddr(string.concat("payer", vm.toString(i)));
            payers.push(payer);
            vm.prank(payer);
            asset.approve(address(escrow), type(uint256).max);
        }

        for (uint256 i; i < 3; ++i) {
            address payee = makeAddr(string.concat("payee", vm.toString(i)));
            payees.push(payee);

            asset.mint(payee, 5_000e6);
            vm.startPrank(payee);
            asset.approve(address(escrow), type(uint256).max);
            asset.approve(address(registry), type(uint256).max);
            registry.register(string.concat("payee_", vm.toString(i)), 5_000e6);
            vm.stopPrank();
        }

        for (uint256 i; i < 3; ++i) {
            address resolver = makeAddr(string.concat("resolver", vm.toString(i)));
            resolvers.push(resolver);

            bondAsset.mint(resolver, RESOLVER_BOND);
            vm.startPrank(resolver);
            bondAsset.approve(address(oracle), type(uint256).max);
            oracle.register(RESOLVER_BOND);
            vm.stopPrank();
        }
    }

    function _openMandates() private {
        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: PER_CALL_CAP,
            dailyCap: DAILY_CAP,
            monthlyCap: MONTHLY_CAP,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: APPROVAL_THRESHOLD,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 0
        });

        for (uint256 i; i < 2; ++i) {
            vm.prank(principal);
            address account = factory.create(principal, agent, bytes32(i), limits);
            accounts.push(account);

            vm.prank(principal);
            MandateAccount(account).setCapability(CAPABILITY, true);
            vm.prank(principal);
            MandateAccount(account).setRouter(address(router));

            for (uint256 j; j < payees.length; ++j) {
                vm.prank(principal);
                MandateAccount(account).setMerchant(payees[j], true);
            }

            // Either principal may be holding the account when it is next funded.
            vm.prank(principal);
            asset.approve(account, type(uint256).max);
            vm.prank(successor);
            asset.approve(account, type(uint256).max);
        }
    }

    function _collectHolders() private {
        for (uint256 i; i < payers.length; ++i) {
            holders.push(payers[i]);
        }
        for (uint256 i; i < payees.length; ++i) {
            holders.push(payees[i]);
        }
        for (uint256 i; i < resolvers.length; ++i) {
            holders.push(resolvers[i]);
        }
        for (uint256 i; i < accounts.length; ++i) {
            holders.push(accounts[i]);
        }

        holders.push(principal);
        holders.push(successor);
        holders.push(address(router));
        holders.push(agent);
        holders.push(treasury);
        holders.push(slashSink);
        holders.push(address(escrow));
        holders.push(address(oracle));
        holders.push(address(registry));
        holders.push(address(reputation));
        holders.push(address(timelock));
        holders.push(address(factory));
        holders.push(address(this));
    }

    function _spendExactly(MandateAccount account, address payee, uint128 amount) private {
        asset.mint(principal, amount);
        vm.prank(principal);
        account.deposit(amount);

        IMandateAccount.SpendRequest memory request = IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: bytes32(0),
            inputURI: "ipfs://job",
            amount: amount,
            deadline: uint64(block.timestamp + 2 days),
            spendClass: 0
        });

        if (amount < account.approvalThreshold()) {
            vm.prank(agent);
            account.spend(request, new bytes32[](0));
            return;
        }

        IMandateAccount.SpendApproval memory approval = IMandateAccount.SpendApproval({
            approvalId: keccak256(abi.encode("mandate.fixture.approval", ++fixtureNonce)),
            merchant: payee,
            capabilityId: CAPABILITY,
            amount: amount,
            expiry: uint64(block.timestamp + 1 hours)
        });

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        account.spendApproved(request, new bytes32[](0), approval, "");
    }

    /// What the escrow is still carrying, read from the escrow itself rather than from a ghost
    /// ledger. A mirror of the contract's own bookkeeping would pass whenever the two agreed on
    /// being wrong.
    function _liveEscrowExposure() private view returns (uint256 lockedPrincipal, uint256 bonds) {
        uint256 count = handler.lockCount();
        for (uint256 i; i < count; ++i) {
            IEscrow.Lock memory entry = escrow.getLock(handler.lockIds(i));

            if (entry.status == IEscrow.LockStatus.Locked) {
                lockedPrincipal += entry.amount;
            } else if (entry.status == IEscrow.LockStatus.Disputed && entry.releasedAt == 0) {
                // A dispute raised after a release holds nothing: the money left at release,
                // and the complaint only moves the payee's history.
                lockedPrincipal += entry.amount;
                bonds += entry.bond;
            }
        }
    }

    /// A payee's balance carries whatever survived registration, which is not the subject of a
    /// payment assertion.
    function _stakeSurplus(address payee) private view returns (uint256) {
        return 5_000e6 - registry.stakeOf(payee);
    }

    /// Walks the runtime as instructions, not as bytes, skipping each PUSH payload. An
    /// immutable that happens to carry 0x31 in its inlined value is not mistaken for an opcode.
    /// The CBOR metadata the compiler appends is stripped first for the same reason: it is data,
    /// its last two bytes give its length, and disassembling it is meaningless.
    function _assertNoBalanceOpcode(string memory label, address target) private view {
        _assertNoBalanceOpcode(label, target, "");
    }

    /// `embedded` is creation code the target carries inside its own runtime, which is what a
    /// factory is. That blob ends in the child's metadata, and metadata is CBOR, not
    /// instructions: walking it reports whichever bytes the compiler happened to hash there,
    /// and a recompile can turn that into a false positive. It is skipped whole.
    function _assertNoBalanceOpcode(string memory label, address target, bytes memory embedded) private view {
        bytes memory runtime = target.code;
        uint256 end = runtime.length;
        assertGt(end, 0, string.concat(label, " has no deployed code to inspect"));

        uint256 skipFrom = type(uint256).max;
        uint256 skipTo;
        if (embedded.length != 0) {
            skipFrom = _indexOf(runtime, embedded);
            assertLt(skipFrom, end, string.concat(label, " does not carry the creation code it was given"));
            skipTo = skipFrom + embedded.length;
        }

        if (end > 2) {
            uint256 metaLength = (uint256(uint8(runtime[end - 2])) << 8) | uint256(uint8(runtime[end - 1]));
            if (metaLength + 2 <= end) {
                uint8 header = uint8(runtime[end - 2 - metaLength]);
                if (header == 0xa1 || header == 0xa2 || header == 0xa3) end -= metaLength + 2;
            }
        }

        uint256 i;
        while (i < end) {
            if (i >= skipFrom && i < skipTo) {
                i = skipTo;
                continue;
            }

            uint8 op = uint8(runtime[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += uint256(op) - 0x5f + 1;
                continue;
            }

            assertTrue(op != 0x31, string.concat(label, " reads BALANCE, which is the native 18-decimal view"));
            assertTrue(op != 0x47, string.concat(label, " reads SELFBALANCE, which is the native 18-decimal view"));
            ++i;
        }
    }

    /// Matched on the first thirty-two bytes, which is a contract's constructor prologue and
    /// carries the child's own length and offsets. Comparing the whole blob at every offset
    /// would be a hundred times the work for the same answer.
    function _indexOf(bytes memory haystack, bytes memory needle) private pure returns (uint256) {
        if (needle.length < 32 || haystack.length < needle.length) return type(uint256).max;

        uint256 limit = haystack.length - needle.length;
        for (uint256 i; i <= limit; ++i) {
            uint256 j;
            while (j < 32 && haystack[i + j] == needle[j]) {
                ++j;
            }
            if (j == 32) return i;
        }
        return type(uint256).max;
    }
}
