// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {Entrypoint} from "../../vendor/privacy-pools-core/src/contracts/Entrypoint.sol";
import {Constants} from "../../vendor/privacy-pools-core/src/contracts/lib/Constants.sol";
import {ProofLib} from "../../vendor/privacy-pools-core/src/contracts/lib/ProofLib.sol";
import {IEntrypoint} from "../../vendor/privacy-pools-core/src/interfaces/IEntrypoint.sol";
import {IPrivacyPool} from "../../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";

import {ShieldedPool} from "../../src/shielded/ShieldedPool.sol";
import {ShieldedRelay} from "../../src/shielded/ShieldedRelay.sol";

import {MockAccessRegistry} from "../mocks/MockAccessRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

/// Random but legal traffic against one shielded pool: deposits from several depositors through
/// the Entrypoint, withdrawals taken straight from the pool and through the relay, ragequits, the
/// registry listing and delisting depositors, tokens sent to the pool outside any deposit, and
/// time passing between them.
///
/// The verifiers accept every proof, so the handler writes the public signals itself and keeps
/// the circuits' promises on their behalf: a withdrawal takes no more than its note holds and
/// leaves the rest as a new note under the same label. What is under test is the pool's
/// accounting and its gates, never the circuits.
///
/// Every action swallows its own revert and compares the outcome with what the caps and the
/// registry predict. A difference is counted, not asserted, because the runner discards a
/// reverting handler call and would bury the finding. No call is made under a started prank.
contract ShieldedHandler is CommonBase, StdUtils {
    uint256 internal constant FIELD = Constants.SNARK_SCALAR_FIELD;

    struct Note {
        address owner;
        uint256 label;
        uint256 commitment;
        uint256 value;
        bool live;
    }

    /// A depositor's window, kept by the rule the pool is held to: it opens at the first deposit
    /// after the last one ran out and runs `DEPOSITOR_WINDOW` from there.
    struct Window {
        uint256 deposited;
        uint256 start;
    }

    ShieldedPool public immutable pool;
    ShieldedRelay public immutable relay;
    Entrypoint public immutable entrypoint;
    MockERC20 public immutable usdg;
    MockAccessRegistry public immutable registry;
    address public immutable relayer;
    address public immutable feeRecipient;
    uint256 public immutable minDeposit;
    uint256 public immutable vettingFeeBps;

    address[] public actors;
    Note[] public notes;
    mapping(address depositor => Window window) private _windows;

    /// What crossed the pool's edge: deposits in, after the vetting fee; payouts out; and tokens
    /// that arrived outside any deposit.
    uint256 public deposited;
    uint256 public paidOut;
    uint256 public donated;
    mapping(address depositor => uint256 amount) public depositedBy;
    mapping(address recipient => uint256 amount) public paidWhileBlocked;

    /// Deposits admitted or refused against what the caps predict, payouts to a listed address
    /// against what its allowance predicts, and refusals that spent the note anyway. All three
    /// are asserted to be zero.
    uint256 public gateBreaks;
    uint256 public exitBreaks;
    uint256 public spentOnRefusal;

    /// Coverage.
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public relayed;
    uint256 public ragequits;
    uint256 public blockedPayouts;
    uint256 public refusals;

    uint256 private _salt;

    constructor(ShieldedPool pool_, ShieldedRelay relay_, address relayer_, address feeRecipient_) {
        pool = pool_;
        relay = relay_;
        entrypoint = Entrypoint(payable(address(pool_.ENTRYPOINT())));
        usdg = MockERC20(pool_.ASSET());
        registry = MockAccessRegistry(address(pool_.ACCESS_REGISTRY()));
        relayer = relayer_;
        feeRecipient = feeRecipient_;
        (, minDeposit, vettingFeeBps,) = entrypoint.assetConfig(IERC20(address(usdg)));

        for (uint256 i; i < 4; ++i) {
            address actor = address(uint160(uint256(keccak256(abi.encode("depositor", i)))));
            actors.push(actor);
            usdg.mint(actor, 100_000e6);
            vm.prank(actor);
            usdg.approve(address(entrypoint), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function noteCount() external view returns (uint256) {
        return notes.length;
    }

    /// The depositor's window as the handler keeps it, rolled to now.
    function window(address depositor) external view returns (uint256 inWindow, uint256 start) {
        Window memory w = _rolled(_windows[depositor]);
        return (w.deposited, w.start);
    }

    function ragequitProofFor(uint256 id) public view returns (ProofLib.RagequitProof memory p) {
        Note memory n = notes[id];
        p.pubSignals = [n.commitment, _nullifier(id), n.value, n.label];
    }

    function deposit(uint256 who, uint256 amountSeed, uint256 shape) external {
        address actor = _actor(who);
        uint256 gross = _grossFor(actor, amountSeed, shape);
        uint256 net = gross - (gross * vettingFeeBps) / 10_000;
        bytes4 expected = _depositRefusal(actor, net);
        uint256 precommitment = _fresh("precommitment");

        vm.prank(actor);
        try entrypoint.deposit(IERC20(address(usdg)), gross, precommitment) returns (uint256 commitment) {
            if (expected != 0) ++gateBreaks;
            uint256 label = uint256(keccak256(abi.encodePacked(pool.SCOPE(), pool.nonce()))) % FIELD;
            notes.push(Note({owner: actor, label: label, commitment: commitment, value: net, live: true}));
            Window memory w = _rolled(_windows[actor]);
            w.deposited += net;
            _windows[actor] = w;
            deposited += net;
            depositedBy[actor] += net;
            ++deposits;
        } catch (bytes memory reason) {
            if (bytes4(reason) != expected) ++gateBreaks;
            ++refusals;
        }
    }

    /// A note's owner proves a withdrawal to any processooor it likes; here that is any depositor,
    /// so a listed address is sometimes paid out of someone else's note, which is exactly what the
    /// allowance has to bound.
    function withdraw(uint256 noteSeed, uint256 amountSeed, uint256 toSeed) external {
        (bool found, uint256 id) = _liveNote(noteSeed);
        if (!found) return;
        address to = _actor(toSeed);
        uint256 amount = bound(amountSeed, 1, notes[id].value);
        IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal({processooor: to, data: ""});
        ProofLib.WithdrawProof memory p = _withdrawProof(id, amount, w);
        bool allowed = _payable(to, amount);

        vm.prank(to);
        try pool.withdraw(w, p) {
            if (!allowed) ++exitBreaks;
            _spend(id, amount, p.pubSignals[0], to);
            ++withdrawals;
        } catch (bytes memory reason) {
            _refused(id, allowed, bytes4(reason));
        }
    }

    /// The relay screens the final recipient itself and the pool pays the relay, which the
    /// registry never lists here, so the only gate on this path is the relay's.
    function relayWithdrawal(uint256 noteSeed, uint256 amountSeed, uint256 toSeed, uint256 feeSeed) external {
        (bool found, uint256 id) = _liveNote(noteSeed);
        if (!found) return;
        address to = _actor(toSeed);
        uint256 amount = bound(amountSeed, 1, notes[id].value);
        IEntrypoint.RelayData memory data = IEntrypoint.RelayData({
            recipient: to, feeRecipient: feeRecipient, relayFeeBPS: bound(feeSeed, 0, relay.MAX_FEE_BPS())
        });
        IPrivacyPool.Withdrawal memory w =
            IPrivacyPool.Withdrawal({processooor: address(relay), data: abi.encode(data)});
        ProofLib.WithdrawProof memory p = _withdrawProof(id, amount, w);
        bool allowed = !registry.isBlocked(to);

        vm.prank(relayer);
        try relay.relay(w, p) {
            if (!allowed) ++exitBreaks;
            _spend(id, amount, p.pubSignals[0], address(relay));
            ++relayed;
        } catch (bytes memory reason) {
            _refused(id, allowed, bytes4(reason));
        }
    }

    function ragequit(uint256 noteSeed) external {
        (bool found, uint256 id) = _liveNote(noteSeed);
        if (!found) return;
        Note memory n = notes[id];
        bool allowed = _payable(n.owner, n.value);

        vm.prank(n.owner);
        try pool.ragequit(ragequitProofFor(id)) {
            if (!allowed) ++exitBreaks;
            _spend(id, n.value, 0, n.owner);
            ++ragequits;
        } catch (bytes memory reason) {
            _refused(id, allowed, bytes4(reason));
        }
    }

    /// Lists a depositor a third of the time and delists it otherwise, so listed actors do not
    /// pile up and starve the paths that need an open one.
    function list(uint256 who, uint256 shape) external {
        registry.setBlocked(_actor(who), shape % 3 == 0);
    }

    function donate(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 100e6);
        usdg.mint(address(pool), amount);
        donated += amount;
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 4 days));
    }

    /// Mostly a random amount reaching a tenth over the deposit cap, so refusals for size happen.
    /// One deposit in four aims at the exact room left in the depositor's window or the pool,
    /// whichever is smaller, cut to the deposit cap, so the caps are met head-on and not only
    /// overshot. No room at all becomes the smallest deposit the Entrypoint takes: one too many.
    function _grossFor(address actor, uint256 seed, uint256 shape) private view returns (uint256) {
        uint256 cap = pool.MAX_DEPOSIT();
        if (shape % 4 != 0) return bound(seed, minDeposit, cap + cap / 10);

        uint256 target = pool.MAX_PER_DEPOSITOR() - _rolled(_windows[actor]).deposited;
        uint256 poolRoom = pool.MAX_TOTAL() - pool.poolValue();
        if (poolRoom < target) target = poolRoom;
        if (cap < target) target = cap;
        // The smallest gross whose net is the target. Net gains at most one unit per unit of
        // gross, so stepping up from the floor cannot skip it.
        uint256 gross = (target * 10_000) / (10_000 - vettingFeeBps);
        while (gross - (gross * vettingFeeBps) / 10_000 < target) {
            ++gross;
        }
        return gross < minDeposit ? minDeposit : gross;
    }

    /// The refusal the gates predict for this deposit, in the order the pool checks them, or zero
    /// when they admit it.
    function _depositRefusal(address actor, uint256 net) private view returns (bytes4) {
        if (registry.isBlocked(actor)) return ShieldedPool.DepositorBlocked.selector;
        if (net > pool.MAX_DEPOSIT()) return ShieldedPool.DepositAboveCap.selector;
        if (_rolled(_windows[actor]).deposited + net > pool.MAX_PER_DEPOSITOR()) {
            return ShieldedPool.DepositorCapReached.selector;
        }
        if (pool.poolValue() + net > pool.MAX_TOTAL()) return ShieldedPool.PoolCapReached.selector;
        return bytes4(0);
    }

    /// Whether the pool's gate lets `recipient` be paid `amount` now: always while unlisted, and
    /// while listed only up to what it deposited.
    function _payable(address recipient, uint256 amount) private view returns (bool) {
        if (!registry.isBlocked(recipient)) return true;
        return paidWhileBlocked[recipient] + amount <= depositedBy[recipient];
    }

    /// The note is spent. What it held beyond `amount` is the new note the proof committed to,
    /// under the same label, so its depositor can still ragequit it.
    function _spend(uint256 id, uint256 amount, uint256 newCommitment, address recipient) private {
        Note memory n = notes[id];
        notes[id].live = false;
        if (n.value > amount) {
            notes.push(
                Note({owner: n.owner, label: n.label, commitment: newCommitment, value: n.value - amount, live: true})
            );
        }
        paidOut += amount;
        if (registry.isBlocked(recipient)) {
            paidWhileBlocked[recipient] += amount;
            ++blockedPayouts;
        }
    }

    /// A payout refused: wrong when the gates allowed it or when the reason is not the gate's,
    /// and a finding of its own when the note was spent anyway. The pool's and the relay's
    /// refusals carry the same name and the same selector.
    function _refused(uint256 id, bool allowed, bytes4 reason) private {
        if (allowed || reason != ShieldedPool.RecipientBlocked.selector) ++exitBreaks;
        if (pool.nullifierHashes(_nullifier(id))) ++spentOnRefusal;
        ++refusals;
    }

    function _withdrawProof(uint256 id, uint256 amount, IPrivacyPool.Withdrawal memory w)
        private
        returns (ProofLib.WithdrawProof memory p)
    {
        p.pubSignals[0] = _fresh("commitment");
        p.pubSignals[1] = _nullifier(id);
        p.pubSignals[2] = amount;
        p.pubSignals[3] = pool.currentRoot();
        p.pubSignals[4] = pool.currentTreeDepth();
        p.pubSignals[5] = entrypoint.latestRoot();
        p.pubSignals[6] = 1;
        p.pubSignals[7] = uint256(keccak256(abi.encode(w, pool.SCOPE()))) % FIELD;
    }

    /// One nullifier per note, derived from its commitment the way the circuit derives it from
    /// the note's secrets, so a note that is tried twice is tried with the same one.
    function _nullifier(uint256 id) private view returns (uint256) {
        return uint256(keccak256(abi.encode("nullifier", notes[id].commitment))) % FIELD;
    }

    function _fresh(string memory what) private returns (uint256) {
        return uint256(keccak256(abi.encode(what, ++_salt))) % FIELD;
    }

    function _rolled(Window memory w) private view returns (Window memory) {
        if (w.deposited != 0 && block.timestamp - w.start < pool.DEPOSITOR_WINDOW()) return w;
        return Window({deposited: 0, start: block.timestamp});
    }

    function _liveNote(uint256 seed) private view returns (bool, uint256) {
        uint256 count = notes.length;
        if (count == 0) return (false, 0);
        uint256 first = seed % count;
        for (uint256 i; i < count; ++i) {
            uint256 id = (first + i) % count;
            if (notes[id].live) return (true, id);
        }
        return (false, 0);
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }
}

/// The pool's books against the balance it holds and the gates it enforces, under any sequence
/// of the calls above.
contract ShieldedInvariantTest is Test {
    uint256 internal constant MAX_DEPOSIT = 100e6;
    uint256 internal constant MAX_TOTAL = 1_000e6;
    uint128 internal constant MAX_PER_DEPOSITOR = 250e6;
    uint64 internal constant WINDOW = 7 days;
    uint256 internal constant MIN_DEPOSIT = 1e6;
    uint256 internal constant VETTING_FEE_BPS = 10;
    uint256 internal constant MAX_RELAY_FEE_BPS = 500;

    MockERC20 internal usdg;
    MockAccessRegistry internal registry;
    Entrypoint internal entrypoint;
    ShieldedPool internal pool;
    ShieldedRelay internal relay;
    ShieldedHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal postman = makeAddr("postman");
    address internal relayer = makeAddr("relayer");
    address internal feeRecipient = makeAddr("feeRecipient");

    function setUp() public {
        usdg = new MockERC20();
        registry = new MockAccessRegistry();
        address verifier = address(new MockVerifier());
        address impl = address(new Entrypoint());
        entrypoint = Entrypoint(
            payable(address(new ERC1967Proxy(impl, abi.encodeCall(Entrypoint.initialize, (owner, postman)))))
        );
        pool = new ShieldedPool(
            address(entrypoint),
            verifier,
            verifier,
            address(usdg),
            registry,
            MAX_DEPOSIT,
            MAX_TOTAL,
            MAX_PER_DEPOSITOR,
            WINDOW
        );
        relay = new ShieldedRelay(pool, registry, MAX_RELAY_FEE_BPS);

        vm.prank(owner);
        entrypoint.registerPool(IERC20(address(usdg)), pool, MIN_DEPOSIT, VETTING_FEE_BPS, MAX_RELAY_FEE_BPS);
        // One association root is all the proofs need: the verifiers accept anything against it.
        vm.prank(postman);
        entrypoint.updateRoot(1, "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");

        handler = new ShieldedHandler(pool, relay, relayer, feeRecipient);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = ShieldedHandler.deposit.selector;
        selectors[1] = ShieldedHandler.deposit.selector;
        selectors[2] = ShieldedHandler.deposit.selector;
        selectors[3] = ShieldedHandler.withdraw.selector;
        selectors[4] = ShieldedHandler.relayWithdrawal.selector;
        selectors[5] = ShieldedHandler.ragequit.selector;
        selectors[6] = ShieldedHandler.list.selector;
        selectors[7] = ShieldedHandler.donate.selector;
        selectors[8] = ShieldedHandler.warp.selector;
        selectors[9] = ShieldedHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Every unit the pool owes came in through a deposit and has not left through a payout, and
    /// the pool never owes more than its cap.
    function invariant_thePoolOwesWhatCameInLessWhatWentOut() public view {
        assertEq(
            pool.poolValue(), handler.deposited() - handler.paidOut(), "poolValue drifted from deposits less payouts"
        );
        assertLe(pool.poolValue(), MAX_TOTAL, "the pool owes more than its cap");
    }

    /// The balance covers what is owed, and the only balance beyond it is what arrived outside a
    /// deposit. The relay keeps nothing.
    function invariant_theBalanceCoversTheBooks() public view {
        uint256 balance = usdg.balanceOf(address(pool));
        assertGe(balance, pool.poolValue(), "the pool holds less than it owes");
        assertEq(balance, pool.poolValue() + handler.donated(), "a unit of the balance is neither owed nor donated");
        assertEq(usdg.balanceOf(address(relay)), 0, "the relay kept tokens");
    }

    /// No depositor has put more than its cap into one window; the room the pool reports is the
    /// cap less what the handler saw go into the open window, and the reset time is that window's
    /// end. Every deposit was admitted or refused exactly as the caps predict.
    function invariant_noDepositorExceedsItsWindow() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            (uint256 inWindow, uint256 start) = handler.window(actor);
            assertLe(inWindow, MAX_PER_DEPOSITOR, "a depositor put more than its cap into one window");
            assertEq(
                pool.depositRoom(actor), MAX_PER_DEPOSITOR - inWindow, "the room disagrees with the deposits taken"
            );
            assertEq(
                pool.windowResetsAt(actor), inWindow == 0 ? 0 : start + WINDOW, "the reset time is not the window's end"
            );
        }
        assertEq(handler.gateBreaks(), 0, "a deposit was admitted or refused against the caps");
    }

    /// A listed address has been paid at most what it deposited, the pool's books say the same
    /// as the handler's, and every payout to a listed address went exactly as the allowance
    /// predicts.
    function invariant_aBlockedAddressIsNeverPaidMoreThanItDeposited() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            address actor = handler.actors(i);
            assertLe(
                handler.paidWhileBlocked(actor),
                handler.depositedBy(actor),
                "a blocked address was paid past its deposits"
            );
            assertEq(pool.paidWhileBlocked(actor), handler.paidWhileBlocked(actor), "paidWhileBlocked drifted");
            assertEq(pool.depositedBy(actor), handler.depositedBy(actor), "depositedBy drifted");
        }
        assertEq(handler.exitBreaks(), 0, "a payout to a listed address went against the allowance");
    }

    function invariant_aRefusalNeverSpendsTheNote() public view {
        assertEq(handler.spentOnRefusal(), 0, "a refused payout spent the nullifier");
    }

    /// Every live note can be taken back by its depositor: always while the depositor is
    /// unlisted, and while listed exactly when its allowance covers the note. Tried against a
    /// snapshot, so the check moves nothing.
    function invariant_aDepositorCanAlwaysRagequitALiveNote() public {
        uint256 count = handler.noteCount();
        for (uint256 i; i < count; ++i) {
            (address depositor,,, uint256 value, bool live) = handler.notes(i);
            if (!live) continue;
            bool expected = !registry.isBlocked(depositor)
                || pool.paidWhileBlocked(depositor) + value <= pool.depositedBy(depositor);

            // Read before the prank: a call into the handler would use it up.
            bytes memory call = abi.encodeCall(pool.ragequit, (handler.ragequitProofFor(i)));
            uint256 snapshot = vm.snapshotState();
            vm.prank(depositor);
            (bool ok,) = address(pool).call(call);
            vm.revertToState(snapshot);

            assertEq(
                ok,
                expected,
                expected
                    ? "a depositor could not ragequit a live note"
                    : "a listed depositor was paid past its allowance"
            );
        }
    }

    /// Guards against a vacuous suite. Every handler action swallows its own revert, so a fixture
    /// wired slightly wrong would run clean and prove nothing. This drives one depositor through a
    /// deposit, a listing, a withdrawal to itself out of its own note, the ragequit that uses up
    /// its allowance, a refusal out of someone else's note once the allowance is spent, and a
    /// relayed withdrawal once delisted.
    function test_theFixtureDrivesADepositorThroughEveryExit() public {
        address alice = handler.actors(0);
        handler.deposit(0, 100e6, 1);
        assertEq(handler.deposits(), 1, "the fixture could not deposit");
        (,,, uint256 value, bool live) = handler.notes(0);
        assertTrue(live, "the deposit left no live note");
        assertEq(value, 99_900_000, "the note is not the deposit less the vetting fee");
        assertEq(pool.depositedBy(alice), 99_900_000);

        handler.list(0, 0);
        assertTrue(registry.isBlocked(alice), "the listing did not take");
        handler.deposit(0, 50e6, 1);
        assertEq(handler.deposits(), 1, "a listed depositor deposited");
        assertEq(handler.refusals(), 1);

        // Listed, alice takes 40 USDG of her own note straight out, inside her allowance.
        handler.withdraw(0, 40e6, 0);
        assertEq(handler.withdrawals(), 1, "a listed depositor could not take its own money out");
        assertEq(pool.paidWhileBlocked(alice), 40e6);
        assertEq(handler.blockedPayouts(), 1);

        // The rest, as the new note the withdrawal left, goes back by ragequit and uses the
        // allowance up.
        handler.ragequit(1);
        assertEq(handler.ragequits(), 1, "a listed depositor could not ragequit the rest");
        assertEq(pool.paidWhileBlocked(alice), 99_900_000);
        assertEq(pool.poolValue(), 0);

        // Bob deposits. Alice, still listed and with nothing left to take back, cannot be paid
        // out of his note.
        handler.deposit(1, 100e6, 1);
        handler.withdraw(2, 1, 0);
        assertEq(handler.withdrawals(), 1, "a listed address was paid out of someone else's note");
        assertEq(handler.refusals(), 2);
        assertEq(handler.spentOnRefusal(), 0, "the refusal spent the note");

        // Delisted, she is paid through the relay out of the same note.
        handler.list(0, 1);
        handler.relayWithdrawal(2, 10e6, 0, 100);
        assertEq(handler.relayed(), 1, "the relay did not pay a delisted recipient");

        assertEq(handler.gateBreaks(), 0);
        assertEq(handler.exitBreaks(), 0);
        invariant_thePoolOwesWhatCameInLessWhatWentOut();
        invariant_theBalanceCoversTheBooks();
        invariant_noDepositorExceedsItsWindow();
        invariant_aBlockedAddressIsNeverPaidMoreThanItDeposited();
        invariant_aDepositorCanAlwaysRagequitALiveNote();
    }

    /// The deposits that aim at the exact room left reach the depositor cap and the pool cap on
    /// the nose, and the deposit after each is the refusal the caps predict.
    function test_theFixtureMeetsBothCapsHeadOn() public {
        for (uint256 who; who < 4; ++who) {
            for (uint256 i; i < 3; ++i) {
                handler.deposit(who, 0, 0);
            }
            assertEq(pool.depositRoom(handler.actors(who)), 0, "a depositor did not reach its cap");
            handler.deposit(who, 0, 0);
        }
        assertEq(pool.poolValue(), MAX_TOTAL, "the pool was not filled to its cap");
        assertEq(handler.deposits(), 12);
        assertEq(handler.refusals(), 4);
        assertEq(handler.gateBreaks(), 0, "a refusal at a cap was not the one the caps predict");
        invariant_noDepositorExceedsItsWindow();
    }
}
