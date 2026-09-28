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
import {Staking} from "../src/token/Staking.sol";

import {DualViewERC20} from "./mocks/DualViewERC20.sol";
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
    address principal;
    address agent;
    address[] payers;
    address[] payees;
    address[] resolvers;
    address[] accounts;
}

/// Random but legal traffic across the whole deployment: mandates spend, payers lock directly,
/// payees release and cancel, both sides open bonded disputes, resolvers vote and get paid, and
/// stray transfers land on contracts that never asked for them.
///
/// Every action swallows its own revert. A sequence that reaches an illegal transition is still
/// a sequence worth continuing, and the properties under test are about the states the system
/// does reach rather than about which calls happen to be admissible at step seventeen.
///
/// Two counters carry findings out to the invariant functions instead of asserting in place.
/// An assertion here reverts, and a reverting handler call is discarded by the runner, which
/// would bury the failure it was meant to surface.
contract MandateSystemHandler is CommonBase, StdUtils {
    uint64 internal constant MIN_TTL = 1 hours;
    uint64 internal constant MAX_TTL = 30 days;
    uint128 internal constant MAX_LOCK = 25_000e6;
    bytes32 internal constant CAPABILITY = keccak256("mandate.invariant.capability");

    MockUsdg public immutable asset;
    MockBRSR public immutable bondAsset;
    Escrow public immutable escrow;
    OracleRegistry public immutable oracle;
    AgentRegistry public immutable registry;
    address public immutable principal;
    address public immutable agent;

    address[] public payers;
    address[] public payees;
    address[] public resolvers;
    address[] public accounts;

    /// Every id the fixture has ever opened. The escrow itself is the record of what each one
    /// became, so nothing about a lock's state is mirrored here.
    uint256[] public lockIds;

    /// Set for the ids a mandate account paid for, because a dispute on one of those has to be
    /// routed through the account, not opened by the account's own address.
    mapping(uint256 id => address account) public mandateLockOf;

    /// Stray transfers, per recipient. A donation is unaccounted by construction. The balance
    /// identities carry it as its own term.
    mapping(address holder => uint256 amount) public donated;

    /// Scores are chosen when a vote is committed and needed again when it is revealed.
    mapping(uint256 disputeId => mapping(address resolver => uint8 score)) public committedScore;

    /// Settlement paths that did not conserve value, and mandate windows caught holding more
    /// spend than their cap admits. Both are asserted to be zero.
    uint256 public conservationBreaks;
    uint256 public capBreaks;

    /// Coverage, read by the deterministic drive test so a fixture that silently reverts on
    /// every call cannot pass by reaching no states at all.
    uint256 public settlements;
    uint256 public approvalCount;

    constructor(SystemWiring memory wiring) {
        asset = wiring.asset;
        bondAsset = wiring.bondAsset;
        escrow = wiring.escrow;
        oracle = wiring.oracle;
        registry = wiring.registry;
        principal = wiring.principal;
        agent = wiring.agent;
        payers = wiring.payers;
        payees = wiring.payees;
        resolvers = wiring.resolvers;
        accounts = wiring.accounts;
    }

    function lockFromPayer(uint256 payerSeed, uint256 payeeSeed, uint256 amountSeed, uint256 ttlSeed) external {
        address payer = _pick(payers, payerSeed);
        address payee = _pick(payees, payeeSeed);
        uint128 amount = uint128(bound(amountSeed, 1, MAX_LOCK));
        uint64 deadline = _deadline(ttlSeed);

        _fund(payer, amount);
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
        uint128 amount = uint128(bound(amountSeed, 1, account.perCallCap()));
        uint64 deadline = _deadline(ttlSeed);

        _fund(principal, amount);
        vm.prank(principal);
        account.deposit(amount);

        IMandateAccount.SpendRequest memory request = IMandateAccount.SpendRequest({
            merchant: payee,
            capabilityId: CAPABILITY,
            inputCommit: keccak256(abi.encode(payee, amount, deadline)),
            inputURI: "ipfs://job",
            amount: amount,
            deadline: deadline,
            spendClass: 0
        });

        uint256 escrowId;
        if (amount >= account.approvalThreshold()) {
            IMandateAccount.SpendApproval memory approval = IMandateAccount.SpendApproval({
                approvalId: keccak256(abi.encode("mandate.invariant.approval", ++approvalCount)),
                merchant: payee,
                capabilityId: CAPABILITY,
                amount: amount,
                expiry: uint64(block.timestamp + 1 hours)
            });

            vm.prank(principal);
            account.approveSpend(approval);

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

        if (escrowId == 0) return;

        lockIds.push(escrowId);
        mandateLockOf[escrowId] = address(account);
        _readWindows(account);
    }

    function withdrawFromMandate(uint256 accountSeed, uint256 amountSeed) external {
        MandateAccount account = MandateAccount(_pick(accounts, accountSeed));
        uint256 amount = bound(amountSeed, 1, 50_000e6);

        vm.prank(principal);
        try account.withdraw(address(asset), principal, amount) {} catch {}
    }

    function release(uint256 idSeed, bytes32 outputCommit) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        uint256 heldBefore = asset.balanceOf(address(escrow));
        uint256 feesBefore = escrow.feesAccrued();

        vm.prank(entry.payee);
        try escrow.release(id, outputCommit, "ipfs://output") {
            _checkConservation(heldBefore, feesBefore, entry.amount, 0);
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
        uint256 heldBefore = asset.balanceOf(address(escrow));
        uint256 feesBefore = escrow.feesAccrued();

        try escrow.timeout(id) {
            _checkConservation(heldBefore, feesBefore, entry.amount, 0);
        } catch {}
    }

    function cancelLock(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        uint256 heldBefore = asset.balanceOf(address(escrow));
        uint256 feesBefore = escrow.feesAccrued();

        vm.prank(entry.payee);
        try escrow.cancel(id) {
            _checkConservation(heldBefore, feesBefore, entry.amount, 0);
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

        if (mandateLockOf[id] == opener) {
            vm.prank(principal);
            try MandateAccount(opener).disputeSpend(id) {} catch {}
            return;
        }

        uint128 bond = uint128((uint256(entry.amount) * escrow.disputeBondBps()) / 10_000);
        if (bond != 0) _fund(opener, bond);

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
        bool holdsFunds = entry.status == IEscrow.LockStatus.Disputed && entry.releasedAt == 0;
        uint256 heldBefore = asset.balanceOf(address(escrow));
        uint256 feesBefore = escrow.feesAccrued();

        bool ruled;
        try oracle.finalize(disputeId) {
            ruled = true;
        } catch {}

        // The ruling reaches the escrow through a try/catch of its own, so a vote can finalise
        // without the lock moving. Only measure the paths where it did.
        if (!ruled || !holdsFunds) return;
        if (escrow.getLock(id).status != IEscrow.LockStatus.Resolved) return;

        _checkConservation(heldBefore, feesBefore, entry.amount, entry.bond);
        settlements += 1;
    }

    function failDispute(uint256 idSeed) external {
        uint256 disputeId = _pickDispute(idSeed);
        if (disputeId == 0) return;

        try oracle.failDispute(disputeId) {} catch {}
    }

    function timeoutDispute(uint256 idSeed) external {
        uint256 id = _pickLock(idSeed);
        if (id == 0) return;

        IEscrow.Lock memory entry = escrow.getLock(id);
        if (entry.status != IEscrow.LockStatus.Disputed || entry.releasedAt != 0) return;

        uint256 matures = uint256(entry.disputedAt) + escrow.disputeTimeoutPeriod() + 1;
        if (block.timestamp < matures) vm.warp(matures);

        uint256 heldBefore = asset.balanceOf(address(escrow));
        uint256 feesBefore = escrow.feesAccrued();

        try escrow.disputeTimeout(id) {
            _checkConservation(heldBefore, feesBefore, entry.amount, entry.bond);
            settlements += 1;
        } catch {}
    }

    function claimRewards(uint256 resolverSeed) external {
        address resolver = _pick(resolvers, resolverSeed);

        vm.prank(resolver);
        try oracle.claimRewards() {} catch {}
    }

    function sweepUnallocated() external {
        try oracle.sweepUnallocated() {} catch {}
    }

    function resolverChurn(uint256 resolverSeed, uint256 actionSeed, uint256 amountSeed) external {
        address resolver = _pick(resolvers, resolverSeed);
        uint256 choice = bound(actionSeed, 0, 3);

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
        } else {
            vm.prank(resolver);
            try oracle.cancelUnbond() {} catch {}
        }
    }

    function agentChurn(uint256 payeeSeed, uint256 actionSeed, uint256 amountSeed) external {
        address payee = _pick(payees, payeeSeed);
        uint256 choice = bound(actionSeed, 0, 4);

        if (choice == 0) {
            uint128 amount = uint128(bound(amountSeed, 1, 5_000e6));
            _fund(payee, amount);
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

    /// A stray transfer to a contract that keeps its own ledger. None of them may fold it into
    /// what they owe, so every balance identity carries `donated` as a separate term.
    function donate(uint256 targetSeed, uint256 amountSeed) external {
        uint256 choice = bound(targetSeed, 0, 3);
        address target = choice == 0
            ? address(escrow)
            : choice == 1 ? address(oracle) : choice == 2 ? address(registry) : _pick(accounts, amountSeed);

        uint256 amount = bound(amountSeed, 1, 10_000e6);
        asset.mint(target, amount);
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

    /// The whole of decision D restated against the only two figures the escrow keeps:
    ///
    ///     refunded + paid + protocolFee + resolverFee + bondLeg == amount + bond
    ///
    /// Everything on the left except `protocolFee` leaves the contract, and `protocolFee` is
    /// exactly the rise in `feesAccrued`, so the identity is equivalent to the balance moving
    /// by the principal and bond it was carrying, less the fee it kept. Stated this way it
    /// covers release, timeout, cancellation, a ruling and a dispute timeout with one check.
    function _checkConservation(uint256 heldBefore, uint256 feesBefore, uint128 amount, uint128 bond) private {
        uint256 heldAfter = asset.balanceOf(address(escrow));
        uint256 kept = escrow.feesAccrued() - feesBefore;

        if (heldBefore + kept != heldAfter + uint256(amount) + bond) conservationBreaks += 1;
    }

    /// A window is allowed to sit at its cap and never above it. Read straight after a spend
    /// lands, because the invariant functions only see the end of a sequence and a bucket that
    /// overshot and then rolled would be gone by then.
    function _readWindows(MandateAccount account) private {
        IMandateAccount.Window memory daily = account.window(IMandateAccount.WindowKind.Daily);
        IMandateAccount.Window memory monthly = account.window(IMandateAccount.WindowKind.Monthly);

        if (daily.spent > daily.cap || monthly.spent > monthly.cap) capBreaks += 1;
    }

    function _fund(address who, uint256 amount) private {
        asset.mint(who, amount);
    }

    function _deadline(uint256 ttlSeed) private view returns (uint64) {
        return uint64(block.timestamp + bound(ttlSeed, MIN_TTL + 1, MAX_TTL - 1));
    }

    function _pick(address[] storage pool, uint256 seed) private view returns (address) {
        return pool[seed % pool.length];
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
    uint64 internal constant DISPUTE_TIMEOUT = 5 days;
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
    MandateSystemHandler internal handler;

    address internal principal = makeAddr("principal");
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
            DISPUTE_TIMEOUT
        );

        // Quorum of one keeps a single honest resolver enough to settle a dispute. The reward
        // and bond accounting is then reached often, not only in the tail of the run.
        // The unbonding period covers the whole vote, and the escrow's dispute timeout sits
        // past it, so a lock cannot be refunded from under a vote that is still open.
        oracle = new OracleRegistry(
            address(asset),
            address(timelock),
            slashSink,
            IOracleRegistry.Config({
                commitWindow: 1 days,
                revealWindow: 1 days,
                unbondingPeriod: 3 days,
                quorum: 1,
                maxVoters: 8,
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
        oracle.setEscrow(address(escrow));
        oracle.setStaking(address(pool));
        escrow.setRegistry(registry);

        // `AgentRegistry.slasher` is left unset, as the deployment leaves it. The resolver
        // produces a quality score and has no figure to take off an agent's balance sheet, so
        // naming it here would assert a capability nothing in this system has.

        factory = new MandateAccountFactory(address(escrow), address(asset));

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
                principal: principal,
                agent: agent,
                payers: payers,
                payees: payees,
                resolvers: resolvers,
                accounts: accounts
            })
        );
        holders.push(address(handler));

        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = MandateSystemHandler.lockFromPayer.selector;
        selectors[1] = MandateSystemHandler.spendFromMandate.selector;
        selectors[2] = MandateSystemHandler.withdrawFromMandate.selector;
        selectors[3] = MandateSystemHandler.release.selector;
        selectors[4] = MandateSystemHandler.finalizeRelease.selector;
        selectors[5] = MandateSystemHandler.timeoutLock.selector;
        selectors[6] = MandateSystemHandler.cancelLock.selector;
        selectors[7] = MandateSystemHandler.sweepFees.selector;
        selectors[8] = MandateSystemHandler.openDispute.selector;
        selectors[9] = MandateSystemHandler.commitVote.selector;
        selectors[10] = MandateSystemHandler.revealVotes.selector;
        selectors[11] = MandateSystemHandler.finalizeDispute.selector;
        selectors[12] = MandateSystemHandler.failDispute.selector;
        selectors[13] = MandateSystemHandler.timeoutDispute.selector;
        selectors[14] = MandateSystemHandler.claimRewards.selector;
        selectors[15] = MandateSystemHandler.resolverChurn.selector;
        selectors[16] = MandateSystemHandler.agentChurn.selector;
        selectors[17] = MandateSystemHandler.sweepUnallocated.selector;
        selectors[18] = MandateSystemHandler.donate.selector;
        selectors[19] = MandateSystemHandler.warpForward.selector;

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
    /// against them, the fees it has not swept, and whatever was pushed at it by mistake. There
    /// is no fifth term, and a stray transfer is not reachable by `sweepFees`.
    function invariant_escrowHoldsItsLiveLocksItsBondsAndTheFeesItOwes() public view {
        (uint256 livePrincipal, uint256 liveBonds) = _liveEscrowExposure();

        assertEq(
            asset.balanceOf(address(escrow)),
            livePrincipal + liveBonds + uint256(escrow.feesAccrued()) + handler.donated(address(escrow)),
            "escrow balance drifted from its live locks, posted bonds and accrued fees"
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

    /// The caps are fixed for the run: no action rewrites the limits, so a bucket holding more
    /// than its cap can only have come from a spend that should have been refused.
    function invariant_mandateWindowSpendNeverExceedsItsCap() public view {
        for (uint256 i; i < accounts.length; ++i) {
            MandateAccount account = MandateAccount(accounts[i]);

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

    function test_theFixtureDrivesAMandateSpendThroughReleaseAndFeeSweep() public {
        handler.spendFromMandate(0, 1, 1_000e6, 3 days);
        assertEq(handler.lockCount(), 1, "the mandate could not spend");

        uint256 id = handler.lockIds(0);
        assertEq(escrow.getLock(id).payer, accounts[0], "the mandate account is not the payer on its own spend");

        handler.release(0, keccak256("output"));
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Released), "the payee could not release");

        uint128 fee = uint128(uint256(1_000e6) * FEE_BPS / 10_000);
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
            classMask: 3,
            totalCap: 0,
            lane: 0
        });

        for (uint256 i; i < 2; ++i) {
            vm.prank(principal);
            address account = factory.create(principal, agent, bytes32(i), limits);
            accounts.push(account);

            vm.prank(principal);
            MandateAccount(account).setCapability(CAPABILITY, true);

            for (uint256 j; j < payees.length; ++j) {
                vm.prank(principal);
                MandateAccount(account).setMerchant(payees[j], true);
            }

            vm.prank(principal);
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
