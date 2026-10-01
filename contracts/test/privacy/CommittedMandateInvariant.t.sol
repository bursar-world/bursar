// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {CommittedMandateAccount} from "../../src/privacy/CommittedMandateAccount.sol";
import {CommittedMandateFactory} from "../../src/privacy/CommittedMandateFactory.sol";
import {WithinMandateVerifier} from "../../src/zk/WithinMandateVerifier.sol";

import {BondResolverStub} from "../EscrowDisputeBonds.t.sol";
import {MockReputation} from "../mocks/MockReputation.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {AcceptAllVerifier} from "./CommittedMandateCeiling.t.sol";

/// Random but legal traffic against committed mandates: the principal funds, pauses, revokes,
/// withdraws, amends terms and renames the agent; the agent and the principal spend, strangers
/// try to; nullifiers are replayed; locks time out, are cancelled, disputed, ruled and reopened
/// so refunds and bonds move back and forth; the principal opens more accounts; and time passes.
///
/// Two kinds of account are driven. Accounts the factory created run on a verifier that accepts
/// everything: a Groth16 proof cannot be produced inside a handler, and these accounts are where
/// the ceiling, the balance accounting and the controls are exercised under forged proofs, which
/// is the case the ceiling exists for. One account sits at the address the proof fixture in
/// test/fixtures/within_mandate.json was built for, on the real verifier, with the fixture's two
/// proofs the only ones that can ever land there; everything else presented to it, and anything
/// presented to a twin at another address, has to be refused. Every action swallows its own
/// revert, and counters carry the findings out.
contract CommittedMandateHandler is CommonBase, StdUtils {
    bytes32 internal constant CAPABILITY = keccak256("hire:anything:1");
    uint128 internal constant MIN_SPEND = 10_000;
    uint128 internal constant MAX_SPEND = 8e6;
    uint256 internal constant MAX_ACCOUNTS = 6;

    /// Why a forged spend has to be refused, or that it does not.
    enum Verdict {
        Fine,
        Stranger,
        Shut,
        Replay,
        OverCeiling,
        Short
    }

    struct Proven {
        CommittedMandateAccount.Spend spend;
        CommittedMandateAccount.Proof proof;
        uint256 counterBefore;
        uint64 nonceBefore;
        bool used;
    }

    CommittedMandateFactory public immutable factory;
    CommittedMandateAccount public immutable proven;
    CommittedMandateAccount public immutable twin;
    Escrow public immutable escrow;
    MockUsdg public immutable asset;
    BondResolverStub public immutable stub;
    address public immutable principal;
    uint256 public immutable ceiling;
    uint256 public immutable fixtureTerms;

    address[] public payees;
    address[] public strangers;
    address[] public accounts;

    /// Which accounts run on the verifier that accepts everything.
    mapping(address account => bool) public forged;
    mapping(address account => address) public agentOf;

    mapping(address account => uint256) public funded;
    mapping(address account => uint256) public withdrawn;
    /// Refunds and returned bonds, measured as the balance rose on each escrow exit.
    mapping(address account => uint256) public cameBack;
    /// Bonds posted on disputes, measured as the balance fell.
    mapping(address account => uint256) public bondsPosted;
    mapping(address account => uint256) public lockedHighWater;
    mapping(address account => uint64) public nonceHighWater;

    uint256[] public lockIds;
    mapping(uint256 id => address account) public lockOwner;
    mapping(address account => uint256[]) internal _spentNullifiers;

    Proven[2] internal _proven;
    uint256 internal _nextNullifier = 1;

    uint256 public spends;

    /// A spend past the ceiling, a spend on the real verifier that landed when it should not have
    /// or was refused when it should have landed, a forgery that landed, a replayed nullifier
    /// that landed, a reserved call that went through for a stranger, a spend from a paused or
    /// revoked account, a withdrawal the principal was refused, a nonce that moved back, a spend
    /// or amendment whose bookkeeping came out wrong, and a spend inside every rule that was
    /// refused. All asserted to be zero.
    uint256 public ceilingBreaks;
    uint256 public proofBreaks;
    uint256 public forgeryBreaks;
    uint256 public replayBreaks;
    uint256 public authBreaks;
    uint256 public gateBreaks;
    uint256 public withdrawBreaks;
    uint256 public nonceBreaks;
    uint256 public bookBreaks;
    uint256 public refusals;

    constructor(
        CommittedMandateFactory factory_,
        CommittedMandateAccount proven_,
        CommittedMandateAccount twin_,
        BondResolverStub stub_,
        address principal_,
        address agent_,
        address[] memory payees_,
        address[] memory strangers_,
        string memory fixture
    ) {
        factory = factory_;
        proven = proven_;
        twin = twin_;
        escrow = Escrow(factory_.escrow());
        asset = MockUsdg(factory_.settlementAsset());
        stub = stub_;
        principal = principal_;
        ceiling = factory_.ceiling();
        payees = payees_;
        strangers = strangers_;
        fixtureTerms = vm.parseJsonUint(fixture, ".termsCommitment");

        _adopt(address(proven_), false, agent_);
        _adopt(address(twin_), false, agent_);
        _loadProof(0, fixture, ".spend1", vm.parseJsonUint(fixture, ".counter"));
        _loadProof(1, fixture, ".spend2", _proven[0].spend.newCounter);
    }

    /// The factory's accounts are created after the handler exists, so the test hands them over.
    function adopt(address account) external {
        _adopt(account, true, agentOf[address(proven)]);
    }

    function fund(uint256 who, uint256 amount) external {
        address account = _account(who);
        amount = bound(amount, MIN_SPEND, 20e6);
        asset.mint(account, amount);
        funded[account] += amount;
    }

    /// A spend under a proof nobody checks, from the agent or the principal, with a fresh
    /// nullifier. Anything that stops it has to be one of the account's own rules.
    function spendForged(uint256 who, uint256 amountSeed, uint256 payeeSeed, bool asPrincipal) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        if (!forged[address(account)]) return;
        address caller = asPrincipal ? principal : agentOf[address(account)];
        if (caller == address(0)) caller = _stranger(amountSeed);
        _spend(account, caller, uint128(bound(amountSeed, MIN_SPEND, MAX_SPEND)), _payee(payeeSeed), _nextNullifier++);
    }

    function spendAsStranger(uint256 who, uint256 amountSeed, uint256 payeeSeed) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        if (!forged[address(account)]) return;
        address stranger = _stranger(who);
        if (stranger == agentOf[address(account)]) return;
        _spend(account, stranger, uint128(bound(amountSeed, MIN_SPEND, MAX_SPEND)), _payee(payeeSeed), _nextNullifier++);
    }

    /// Presents a nullifier the account already consumed, under terms that would otherwise pass.
    function spendReplay(uint256 who, uint256 pick) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        uint256[] storage used = _spentNullifiers[address(account)];
        if (!forged[address(account)] || used.length == 0) return;
        _spend(account, _operator(account), MIN_SPEND, _payee(pick), used[pick % used.length]);
    }

    /// One of the fixture's two proofs against the account they were built for. The clock is
    /// moved up to the time the proof was made for when it has not got there yet; once it is
    /// past, the proof is stale and has to be refused like anything else.
    function spendProven(uint256 which) external {
        Proven storage p = _proven[which % 2];
        if (block.timestamp < p.spend.provenAt) vm.warp(p.spend.provenAt);

        bool expected = !p.used && block.timestamp == p.spend.provenAt && _termsStand(p) && !proven.paused()
            && !proven.revoked() && proven.lockedTotal() + p.spend.amount <= ceiling
            && asset.balanceOf(address(proven)) >= p.spend.amount;

        uint256 lockedBefore = proven.lockedTotal();
        vm.prank(_operator(proven));
        try proven.spend(p.spend, p.proof) returns (uint256 id) {
            spends += 1;
            p.used = true;
            lockIds.push(id);
            lockOwner[id] = address(proven);
            if (!expected || proven.lockedTotal() != lockedBefore + p.spend.amount) proofBreaks += 1;
        } catch {
            if (expected) proofBreaks += 1;
        }
    }

    /// A fixture proof with one public input changed, or one bit of the proof flipped, or the
    /// proof presented to a twin of the account at another address. None of these may land.
    function spendForgedAgainstTheVerifier(uint256 which, uint256 mutation) external {
        Proven storage p = _proven[which % 2];
        CommittedMandateAccount.Spend memory s = p.spend;
        CommittedMandateAccount.Proof memory proof = p.proof;
        CommittedMandateAccount target = proven;
        uint256 choice = mutation % 7;
        if (choice == 0) s.amount += 1;
        else if (choice == 1) s.payee = _payee(mutation >> 8);
        else if (choice == 2) s.capabilityId = s.capabilityId ^ bytes32(uint256(1) << (mutation % 256));
        else if (choice == 3) proof.a[0] ^= 1;
        else if (choice == 4) s.nullifier += 1;
        else if (choice == 5) s.newCounter += 1;
        else target = twin;
        if (choice == 1 && s.payee == p.spend.payee) s.payee = strangers[0];
        if (block.timestamp < s.provenAt) vm.warp(s.provenAt);

        vm.prank(_operator(target));
        try target.spend(s, proof) returns (uint256 id) {
            spends += 1;
            lockIds.push(id);
            lockOwner[id] = address(target);
            forgeryBreaks += 1;
        } catch {}
    }

    /// The principal takes money out, paused or revoked or not. One call in eight asks for a unit
    /// more than is held, and has to fail; a stranger has to fail whatever it asks.
    function withdraw(uint256 who, uint256 amountSeed, bool asStranger) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        uint256 held = asset.balanceOf(address(account));
        uint256 amount = held == 0 || amountSeed % 8 == 0 ? held + 1 : bound(amountSeed, 1, held);
        address caller = asStranger ? _stranger(amountSeed) : principal;

        vm.prank(caller);
        try account.withdraw(principal, amount) {
            if (asStranger) authBreaks += 1;
            if (amount > held) bookBreaks += 1;
            withdrawn[address(account)] += amount;
        } catch {
            if (!asStranger && amount <= held) withdrawBreaks += 1;
        }
    }

    function revoke(uint256 who, bool asStranger) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        uint256 held = asset.balanceOf(address(account));
        address caller = asStranger ? _stranger(who) : principal;

        vm.prank(caller);
        try account.revoke() {
            if (asStranger) authBreaks += 1;
            withdrawn[address(account)] += held;
            if (asset.balanceOf(address(account)) != 0 || !account.revoked()) bookBreaks += 1;
        } catch {
            if (!asStranger) withdrawBreaks += 1;
        }
    }

    function setPaused(uint256 who, bool paused, bool asStranger) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        vm.prank(asStranger ? _stranger(who) : principal);
        try account.setPaused(paused) {
            if (asStranger) authBreaks += 1;
        } catch {}
    }

    /// Names a stranger as the agent, or nobody. The old agent is a stranger from then on.
    function setAgent(uint256 who, uint256 seed, bool asStranger) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        address next = seed % 8 == 0 ? address(0) : _stranger(seed);
        vm.prank(asStranger ? _stranger(who) : principal);
        try account.setAgent(next) {
            if (asStranger) authBreaks += 1;
            agentOf[address(account)] = next;
        } catch {}
    }

    /// New terms with a nonce at or past the current one, or one behind it in four, which the
    /// account has to refuse. The ceiling's count is not the terms' and has to stay put.
    function amend(uint256 who, uint256 seed, bool asStranger) external {
        CommittedMandateAccount account = CommittedMandateAccount(_account(who));
        uint64 nonce = account.nonce();
        uint64 next = seed % 4 == 0 && nonce != 0 ? nonce - 1 : nonce + uint64(bound(seed, 0, 3));
        uint256 lockedBefore = account.lockedTotal();
        uint64 versionBefore = account.version();

        vm.prank(asStranger ? _stranger(who) : principal);
        try account.amend(uint256(keccak256(abi.encode("terms", seed))), seed, next, hex"c1f3") {
            if (asStranger) authBreaks += 1;
            if (next < nonce) nonceBreaks += 1;
            if (
                account.lockedTotal() != lockedBefore || account.nonce() != next
                    || account.version() != versionBefore + 1
            ) {
                bookBreaks += 1;
            }
        } catch {
            if (!asStranger && next >= nonce) refusals += 1;
        }
        _observe(account);
    }

    /// The payee delivers and is paid. Nothing comes back to the account and the ceiling's count
    /// stays where the spend put it.
    function releaseLock(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;

        vm.prank(entry.payee);
        try escrow.release(id, keccak256("output"), "") {} catch {}
    }

    function timeoutLock(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;
        if (entry.status == IEscrow.LockStatus.Locked && block.timestamp <= entry.deadline) {
            vm.warp(entry.deadline + 1);
        }

        uint256 before = asset.balanceOf(entry.payer);
        try escrow.timeout(id) {
            cameBack[entry.payer] += asset.balanceOf(entry.payer) - before;
        } catch {}
    }

    function cancelLock(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;

        uint256 before = asset.balanceOf(entry.payer);
        vm.prank(entry.payee);
        try escrow.cancel(id) {
            cameBack[entry.payer] += asset.balanceOf(entry.payer) - before;
        } catch {}
    }

    /// The principal contests its own payment through the account, which posts the bond.
    function disputeLock(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;

        uint256 before = asset.balanceOf(entry.payer);
        vm.prank(principal);
        try CommittedMandateAccount(entry.payer).disputeSpend(id) {
            bondsPosted[entry.payer] += before - asset.balanceOf(entry.payer);
        } catch {}
    }

    function ruleLock(uint256 idSeed, uint256 refundSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;

        uint256 before = asset.balanceOf(entry.payer);
        try stub.rule(id, uint16(bound(refundSeed, 0, 10_000))) {
            cameBack[entry.payer] += asset.balanceOf(entry.payer) - before;
        } catch {}
    }

    function reopenLock(uint256 idSeed) external {
        (uint256 id, IEscrow.Lock memory entry) = _pickLock(idSeed);
        if (id == 0) return;

        uint256 before = asset.balanceOf(entry.payer);
        try stub.reopen(id) {
            cameBack[entry.payer] += asset.balanceOf(entry.payer) - before;
        } catch {}
    }

    /// The principal opens another account, or a stranger tries to open one in the principal's
    /// name and has to be refused.
    function create(uint256 salt, bool asStranger) external {
        address caller = asStranger ? _stranger(salt) : principal;
        if (!asStranger && accounts.length >= MAX_ACCOUNTS) return;

        vm.prank(caller);
        try factory.create(principal, agentOf[address(proven)], bytes32(salt), salt, salt + 1, hex"c1f3") returns (
            address account
        ) {
            if (asStranger) authBreaks += 1;
            _adopt(account, true, agentOf[address(proven)]);
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 minutes, 3 days));
    }

    /// One forged spend from wherever the run left the accounts: the first live account is
    /// unpaused, funded and spent from, or a new one is opened when every account is revoked
    /// or full. Expected to land.
    function driveSpend() external {
        CommittedMandateAccount account;
        for (uint256 i; i < accounts.length; ++i) {
            CommittedMandateAccount candidate = CommittedMandateAccount(accounts[i]);
            if (forged[accounts[i]] && !candidate.revoked() && candidate.lockedTotal() + MIN_SPEND <= ceiling) {
                account = candidate;
                break;
            }
        }
        if (address(account) == address(0)) {
            vm.prank(principal);
            account = CommittedMandateAccount(
                factory.create(principal, agentOf[address(proven)], keccak256("drive"), 1, 2, hex"c1f3")
            );
            _adopt(address(account), true, agentOf[address(proven)]);
        }

        vm.startPrank(principal);
        if (account.paused()) account.setPaused(false);
        if (agentOf[address(account)] == address(0)) {
            account.setAgent(strangers[0]);
            agentOf[address(account)] = strangers[0];
        }
        vm.stopPrank();
        asset.mint(address(account), MIN_SPEND);
        funded[address(account)] += MIN_SPEND;

        _spend(account, agentOf[address(account)], MIN_SPEND, payees[0], _nextNullifier++);
    }

    function accountCount() external view returns (uint256) {
        return accounts.length;
    }

    function payeeCount() external view returns (uint256) {
        return payees.length;
    }

    function lockCount() external view returns (uint256) {
        return lockIds.length;
    }

    function provenUsed(uint256 which) external view returns (bool) {
        return _proven[which].used;
    }

    function provenAmount(uint256 which) external view returns (uint128) {
        return _proven[which].spend.amount;
    }

    /// Opens a lock from `account` as `caller` under an unchecked proof and judges the outcome
    /// against the account's rules.
    function _spend(CommittedMandateAccount account, address caller, uint128 amount, address payee, uint256 nullifier)
        private
    {
        Verdict verdict = _judge(account, caller, amount, nullifier);
        uint64 nonceBefore = account.nonce();
        uint256 lockedBefore = account.lockedTotal();
        CommittedMandateAccount.Spend memory s = _request(payee, amount, nullifier);
        CommittedMandateAccount.Proof memory proof;

        vm.prank(caller);
        try account.spend(s, proof) returns (uint256 id) {
            spends += 1;
            lockIds.push(id);
            lockOwner[id] = address(account);
            _spentNullifiers[address(account)].push(nullifier);
            _charge(verdict);
            if (
                account.nonce() != nonceBefore + 1 || account.counter() != s.newCounter
                    || account.lockedTotal() != lockedBefore + amount || !account.nullifierUsed(nullifier)
                    || escrow.getLock(id).payer != address(account) || escrow.getLock(id).amount != amount
            ) bookBreaks += 1;
        } catch {
            if (verdict == Verdict.Fine) refusals += 1;
        }
        _observe(account);
    }

    function _judge(CommittedMandateAccount account, address caller, uint128 amount, uint256 nullifier)
        private
        view
        returns (Verdict)
    {
        if (caller != agentOf[address(account)] && caller != principal) return Verdict.Stranger;
        if (account.revoked() || account.paused()) return Verdict.Shut;
        if (account.nullifierUsed(nullifier)) return Verdict.Replay;
        if (account.lockedTotal() + amount > ceiling) return Verdict.OverCeiling;
        if (asset.balanceOf(address(account)) < amount) return Verdict.Short;
        return Verdict.Fine;
    }

    /// A spend that landed against a verdict other than Fine is one of the breaks below.
    function _charge(Verdict verdict) private {
        if (verdict == Verdict.Stranger) authBreaks += 1;
        else if (verdict == Verdict.Shut) gateBreaks += 1;
        else if (verdict == Verdict.Replay) replayBreaks += 1;
        else if (verdict == Verdict.OverCeiling) ceilingBreaks += 1;
        else if (verdict == Verdict.Short) bookBreaks += 1;
    }

    function _observe(CommittedMandateAccount account) private {
        uint256 locked = account.lockedTotal();
        if (locked < lockedHighWater[address(account)]) ceilingBreaks += 1;
        else lockedHighWater[address(account)] = locked;

        uint64 nonce = account.nonce();
        if (nonce < nonceHighWater[address(account)]) nonceBreaks += 1;
        else nonceHighWater[address(account)] = nonce;
    }

    /// The terms and counters the fixture proof was built against are the ones the account
    /// holds now, and the proof's nonce is the account's.
    function _termsStand(Proven storage p) private view returns (bool) {
        return proven.termsCommitment() == fixtureTerms && proven.counter() == p.counterBefore
            && proven.nonce() == p.nonceBefore && !proven.nullifierUsed(p.spend.nullifier);
    }

    /// Whoever may spend from the account right now: its agent, or the principal while no agent
    /// is named. Nothing is ever called from the zero address.
    function _operator(CommittedMandateAccount account) private view returns (address) {
        address agent = agentOf[address(account)];
        return agent == address(0) ? principal : agent;
    }

    function _request(address payee, uint128 amount, uint256 nullifier)
        private
        view
        returns (CommittedMandateAccount.Spend memory)
    {
        return CommittedMandateAccount.Spend({
            payee: payee,
            capabilityId: CAPABILITY,
            inputCommit: keccak256(abi.encode(payee, amount, nullifier)),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 days),
            provenAt: uint64(block.timestamp),
            newCounter: uint256(keccak256(abi.encode("counter", nullifier))),
            nullifier: nullifier
        });
    }

    function _adopt(address account, bool forged_, address agent) private {
        accounts.push(account);
        forged[account] = forged_;
        agentOf[account] = agent;
        funded[account] = asset.balanceOf(account);
    }

    function _loadProof(uint256 index, string memory fixture, string memory key, uint256 counterBefore) private {
        Proven storage p = _proven[index];
        p.spend = CommittedMandateAccount.Spend({
            payee: payees[0],
            capabilityId: vm.parseJsonBytes32(fixture, string.concat(key, ".capabilityId")),
            inputCommit: keccak256("input"),
            inputURI: "",
            amount: uint128(vm.parseJsonUint(fixture, string.concat(key, ".amount"))),
            deadline: uint64(vm.parseJsonUint(fixture, string.concat(key, ".provenAt")) + 1 days),
            provenAt: uint64(vm.parseJsonUint(fixture, string.concat(key, ".provenAt"))),
            newCounter: vm.parseJsonUint(fixture, string.concat(key, ".newCounter")),
            nullifier: vm.parseJsonUint(fixture, string.concat(key, ".nullifier"))
        });
        uint256[] memory a = vm.parseJsonUintArray(fixture, string.concat(key, ".a"));
        uint256[] memory b0 = vm.parseJsonUintArray(fixture, string.concat(key, ".b[0]"));
        uint256[] memory b1 = vm.parseJsonUintArray(fixture, string.concat(key, ".b[1]"));
        uint256[] memory c = vm.parseJsonUintArray(fixture, string.concat(key, ".c"));
        p.proof.a = [a[0], a[1]];
        p.proof.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.proof.c = [c[0], c[1]];
        p.counterBefore = counterBefore;
        p.nonceBefore = uint64(index);
    }

    function _pickLock(uint256 seed) private view returns (uint256 id, IEscrow.Lock memory entry) {
        if (lockIds.length == 0) return (0, entry);
        id = lockIds[seed % lockIds.length];
        entry = escrow.getLock(id);
    }

    function _account(uint256 seed) private view returns (address) {
        return accounts[seed % accounts.length];
    }

    function _payee(uint256 seed) private view returns (address) {
        return payees[seed % payees.length];
    }

    function _stranger(uint256 seed) private view returns (address) {
        return strangers[seed % strangers.length];
    }
}

/// Committed mandates under any sequence of the calls above: no account ever locks past the
/// ceiling its factory fixed, whatever its proofs say; the ceiling's count is every lock the
/// account ever opened and never falls; an account never pays out more than it was funded with;
/// on the real verifier only the fixture's proofs land, once each and in order; a nullifier
/// spends once; the nonce never goes back; and the principal can always withdraw.
contract CommittedMandateInvariantTest is Test {
    uint256 internal constant CEILING = 25e6;
    string internal constant ACCOUNT = "CommittedMandateAccount.sol:CommittedMandateAccount";

    MockUsdg internal asset;
    Escrow internal escrow;
    BondResolverStub internal stub;
    WithinMandateVerifier internal verifier;
    CommittedMandateFactory internal factory;
    CommittedMandateAccount internal proven;
    CommittedMandateAccount internal twin;
    CommittedMandateHandler internal handler;

    address internal principal = makeAddr("principal");
    address internal agent = makeAddr("agent");
    address internal treasury = makeAddr("treasury");
    address[] internal payees;
    address[] internal strangers;

    function setUp() public {
        string memory fixture = vm.readFile("test/fixtures/within_mandate.json");
        vm.warp(vm.parseJsonUint(fixture, ".now"));

        asset = new MockUsdg();
        MockReputation reputation = new MockReputation();
        escrow =
            new Escrow(address(asset), address(reputation), treasury, 100, 50, 500, 5 minutes, 7 days, 1 hours, 10_000);
        reputation.setEscrow(address(escrow));
        stub = new BondResolverStub(IEscrow(address(escrow)));
        escrow.setResolver(address(stub));
        verifier = new WithinMandateVerifier();
        factory =
            new CommittedMandateFactory(address(escrow), address(asset), address(new AcceptAllVerifier()), CEILING);

        // The fixture's proofs name the payee and the account address, so both are fixed here.
        payees.push(address(0xbeef01));
        payees.push(address(0xbeef02));
        strangers.push(makeAddr("stranger"));
        strangers.push(makeAddr("secondAgent"));
        strangers.push(agent);

        proven = _etch(vm.parseJsonAddress(fixture, ".mandate"), fixture);
        twin = _etch(address(0xacc002), fixture);

        handler = new CommittedMandateHandler(factory, proven, twin, stub, principal, agent, payees, strangers, fixture);
        for (uint256 i; i < 3; ++i) {
            vm.prank(principal);
            address account = factory.create(principal, agent, bytes32(i), i + 1, i + 2, hex"c1f3");
            asset.mint(account, 10e6);
            handler.adopt(account);
        }

        bytes4[] memory selectors = new bytes4[](22);
        selectors[0] = CommittedMandateHandler.fund.selector;
        selectors[1] = CommittedMandateHandler.spendForged.selector;
        selectors[2] = CommittedMandateHandler.spendForged.selector;
        selectors[3] = CommittedMandateHandler.spendForged.selector;
        selectors[4] = CommittedMandateHandler.spendAsStranger.selector;
        selectors[5] = CommittedMandateHandler.spendReplay.selector;
        selectors[6] = CommittedMandateHandler.spendProven.selector;
        selectors[7] = CommittedMandateHandler.spendForgedAgainstTheVerifier.selector;
        selectors[8] = CommittedMandateHandler.withdraw.selector;
        selectors[9] = CommittedMandateHandler.revoke.selector;
        selectors[10] = CommittedMandateHandler.setPaused.selector;
        selectors[11] = CommittedMandateHandler.setAgent.selector;
        selectors[12] = CommittedMandateHandler.amend.selector;
        selectors[13] = CommittedMandateHandler.releaseLock.selector;
        selectors[14] = CommittedMandateHandler.timeoutLock.selector;
        selectors[15] = CommittedMandateHandler.cancelLock.selector;
        selectors[16] = CommittedMandateHandler.disputeLock.selector;
        selectors[17] = CommittedMandateHandler.ruleLock.selector;
        selectors[18] = CommittedMandateHandler.reopenLock.selector;
        selectors[19] = CommittedMandateHandler.create.selector;
        selectors[20] = CommittedMandateHandler.warp.selector;
        selectors[21] = CommittedMandateHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Whatever the proofs say, no account locks past the ceiling the factory gave it, so the
    /// most all of them together can ever lock is the ceiling times their number.
    function invariant_noAccountEverLocksPastItsCeiling() public view {
        uint256 total;
        for (uint256 i; i < handler.accountCount(); ++i) {
            CommittedMandateAccount account = CommittedMandateAccount(handler.accounts(i));
            assertLe(account.lockedTotal(), CEILING, "an account locked past its ceiling");
            assertEq(account.ceiling(), CEILING, "an account carries a ceiling its factory did not set");
            total += account.lockedTotal();
        }
        assertLe(total, CEILING * handler.accountCount(), "the accounts together locked past their ceilings");
        assertEq(handler.ceilingBreaks(), 0, "a spend landed past the ceiling, or the ceiling's count fell");
    }

    /// The ceiling's count is the sum of every lock the account ever opened, as the escrow
    /// records them. Refunds, rulings and amendments leave it where it is.
    function invariant_lockedTotalIsEveryLockEverOpenedAndNeverFalls() public view {
        for (uint256 i; i < handler.accountCount(); ++i) {
            address account = handler.accounts(i);
            uint256 opened;
            for (uint256 j; j < handler.lockCount(); ++j) {
                uint256 id = handler.lockIds(j);
                if (handler.lockOwner(id) == account) opened += escrow.getLock(id).amount;
            }
            assertEq(
                CommittedMandateAccount(account).lockedTotal(), opened, "the ceiling's count is not the locks opened"
            );
            assertGe(CommittedMandateAccount(account).lockedTotal(), handler.lockedHighWater(account), "the count fell");
        }
    }

    /// What an account holds is what it was given and what came back from the escrow, less the
    /// locks it opened, the bonds it posted and what the principal took out. It never pays out
    /// more than that.
    function invariant_anAccountNeverPaysOutMoreThanItWasFunded() public view {
        for (uint256 i; i < handler.accountCount(); ++i) {
            address account = handler.accounts(i);
            uint256 given = handler.funded(account) + handler.cameBack(account);
            uint256 gone = CommittedMandateAccount(account).lockedTotal() + handler.bondsPosted(account)
                + handler.withdrawn(account);
            assertGe(given, gone, "an account paid out more than it was ever given");
            assertEq(asset.balanceOf(account), given - gone, "an account's balance drifted from its books");
        }
    }

    /// Every unit the accounts were funded with is on an account, in the escrow, with a payee,
    /// with the principal, with the resolver or with the treasury.
    function invariant_theSettlementAssetIsConservedAcrossEveryParty() public view {
        uint256 sum = asset.balanceOf(address(escrow)) + asset.balanceOf(address(stub)) + asset.balanceOf(principal)
            + asset.balanceOf(treasury);
        for (uint256 i; i < handler.accountCount(); ++i) {
            sum += asset.balanceOf(handler.accounts(i));
        }
        for (uint256 i; i < handler.payeeCount(); ++i) {
            sum += asset.balanceOf(handler.payees(i));
        }
        assertEq(sum, asset.totalSupply(), "settlement asset reached an address outside the system");
    }

    /// On the real verifier only the fixture's two proofs ever land, each once, in order, and
    /// only for the time they were made for. A changed input, a flipped bit, or the same proof
    /// at another address is refused.
    function invariant_aSpendNeedsAValidProofForTheCommittedTerms() public view {
        assertEq(
            handler.proofBreaks(),
            0,
            "a proven spend landed when it should not have, or was refused when it should have"
        );
        assertEq(handler.forgeryBreaks(), 0, "a forged proof landed on the real verifier");
        uint256 expected;
        if (handler.provenUsed(0)) expected += handler.provenAmount(0);
        if (handler.provenUsed(1)) expected += handler.provenAmount(1);
        assertEq(proven.lockedTotal(), expected, "the proven account locked something no fixture proof covers");
        assertEq(twin.lockedTotal(), 0, "the twin locked something");
        assertFalse(handler.provenUsed(1) && !handler.provenUsed(0), "the second proof landed before the first");
    }

    function invariant_aNullifierSpendsOnce() public view {
        assertEq(handler.replayBreaks(), 0, "a consumed nullifier opened a second lock");
    }

    function invariant_theNonceNeverGoesBack() public view {
        for (uint256 i; i < handler.accountCount(); ++i) {
            address account = handler.accounts(i);
            assertGe(CommittedMandateAccount(account).nonce(), handler.nonceHighWater(account), "a nonce went back");
        }
        assertEq(handler.nonceBreaks(), 0, "an amendment moved the nonce back");
    }

    function invariant_onlyTheAgentOrPrincipalSpendsAndOnlyThePrincipalGoverns() public view {
        assertEq(handler.authBreaks(), 0, "a stranger spent, governed, withdrew or opened an account");
    }

    function invariant_aPausedOrRevokedAccountNeverSpends() public view {
        assertEq(handler.gateBreaks(), 0, "a paused or revoked account spent");
    }

    /// The principal's way out never closes: a withdrawal of what is held lands whether the
    /// account is paused, revoked, full against its ceiling or none of those, and a revocation
    /// sweeps the balance to the principal.
    function invariant_thePrincipalCanAlwaysWithdraw() public view {
        assertEq(handler.withdrawBreaks(), 0, "the principal was refused a withdrawal or a revocation");
    }

    /// A spend that lands moves the nonce by one, sets the counter and the nullifier, and opens
    /// exactly the lock it asked for; one inside every rule is never refused.
    function invariant_everySpendIsBookedOnceAndNoneInsideTheRulesIsRefused() public view {
        assertEq(handler.bookBreaks(), 0, "a spend, amendment or withdrawal left the books wrong");
        assertEq(handler.refusals(), 0, "a spend or amendment inside every rule was refused");
    }

    /// A run that never spent proved nothing about the lock path, so one spend is driven from
    /// wherever the run left the accounts.
    function afterInvariant() public {
        if (handler.spends() == 0) handler.driveSpend();
        assertGt(handler.spends(), 0, "no spend ever landed");
        invariant_lockedTotalIsEveryLockEverOpenedAndNeverFalls();
        invariant_anAccountNeverPaysOutMoreThanItWasFunded();
        invariant_everySpendIsBookedOnceAndNoneInsideTheRulesIsRefused();
    }

    /// Guards against a vacuous proof path. The handler's proven step has to land the fixture's
    /// two proofs in order, refuse them again, and refuse every forgery it knows how to make.
    function test_theFixtureProofsLandOnceInOrderAndEveryForgeryIsRefused() public {
        handler.spendProven(1);
        assertFalse(handler.provenUsed(1), "the second proof landed before the first");

        for (uint256 mutation; mutation < 7; ++mutation) {
            handler.spendForgedAgainstTheVerifier(0, mutation);
        }
        assertEq(handler.forgeryBreaks(), 0, "a forgery landed");
        assertEq(proven.lockedTotal(), 0);

        handler.spendProven(0);
        assertTrue(handler.provenUsed(0), "the first proof did not land");
        handler.spendProven(0);
        handler.spendProven(1);
        assertTrue(handler.provenUsed(1), "the second proof did not land after the first");
        assertEq(proven.lockedTotal(), 170_000);
        assertEq(handler.proofBreaks(), 0, "a proven spend went against expectation");

        handler.warp(1 hours);
        handler.spendProven(0);
        assertEq(handler.proofBreaks(), 0, "a stale proof was judged wrongly");
        invariant_aSpendNeedsAValidProofForTheCommittedTerms();
        invariant_theSettlementAssetIsConservedAcrossEveryParty();
    }

    /// The fixture's terms at `where`, on the real verifier, funded. This test contract stands in
    /// for the factory and seals the first version itself.
    function _etch(address where, string memory fixture) private returns (CommittedMandateAccount account) {
        deployCodeTo(
            ACCOUNT,
            abi.encode(
                principal,
                agent,
                address(asset),
                address(escrow),
                address(verifier),
                vm.parseJsonUint(fixture, ".termsCommitment"),
                vm.parseJsonUint(fixture, ".counter"),
                CEILING
            ),
            where
        );
        account = CommittedMandateAccount(where);
        account.sealInitial(hex"c1f3");
        asset.mint(where, 1_000_000);
    }
}
