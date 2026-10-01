// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Entrypoint} from "../../vendor/privacy-pools-core/src/contracts/Entrypoint.sol";
import {ProofLib} from "../../vendor/privacy-pools-core/src/contracts/lib/ProofLib.sol";
import {CommitmentVerifier} from "../../vendor/privacy-pools-core/src/contracts/verifiers/CommitmentVerifier.sol";
import {WithdrawalVerifier} from "../../vendor/privacy-pools-core/src/contracts/verifiers/WithdrawalVerifier.sol";
import {IEntrypoint} from "../../vendor/privacy-pools-core/src/interfaces/IEntrypoint.sol";
import {IPrivacyPool} from "../../vendor/privacy-pools-core/src/interfaces/IPrivacyPool.sol";
import {IState} from "../../vendor/privacy-pools-core/src/interfaces/IState.sol";

import {IAccessRegistry} from "../../src/shielded/IAccessRegistry.sol";
import {ShieldedPool} from "../../src/shielded/ShieldedPool.sol";
import {ShieldedRelay} from "../../src/shielded/ShieldedRelay.sol";

import {MockERC20} from "../mocks/MockERC20.sol";

contract MockAccessRegistry is IAccessRegistry {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function isBlocked(address account) external view returns (bool) {
        return blocked[account];
    }
}

/// The proofs in test/fixtures/shielded.json are real Groth16 proofs made with the official
/// Privacy Pools v1.3.0 proving keys by packages/sdk/scripts/shielded-fixture.ts. They are bound to
/// the chain id, the asset and the addresses setUp produces: each contract below is created by its
/// own pranked deployer at nonce 0, so the addresses do not depend on anything else in the test.
contract ShieldedTest is Test {
    using stdJson for string;

    uint256 internal constant CHAIN_ID = 4663;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ENTRYPOINT_DEPLOYER = address(0xe0001);
    address internal constant POOL_DEPLOYER = address(0xe0002);
    address internal constant RELAY_DEPLOYER = address(0xe0003);
    address internal constant RECIPIENT = address(0xe0010);
    address internal constant FEE_RECIPIENT = address(0xe0011);
    address internal constant DIRECT = address(0xe0012);

    address internal owner = address(0x0A11);
    address internal postman = address(0x9057);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal relayer = address(0x7E1A);

    MockERC20 internal usdg;
    MockAccessRegistry internal registry;
    Entrypoint internal entrypoint;
    ShieldedPool internal pool;
    ShieldedRelay internal relay;
    string internal fixture;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        // The pool scope hashes the asset address, so the mock sits at the real USDG address.
        vm.etch(USDG, address(new MockERC20()).code);
        usdg = MockERC20(USDG);
        registry = new MockAccessRegistry();
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/shielded.json"));

        address withdrawalVerifier = address(new WithdrawalVerifier());
        address ragequitVerifier = address(new CommitmentVerifier());
        address impl = address(new Entrypoint());

        vm.prank(ENTRYPOINT_DEPLOYER);
        entrypoint = Entrypoint(
            payable(address(new ERC1967Proxy(impl, abi.encodeCall(Entrypoint.initialize, (owner, postman)))))
        );
        vm.prank(POOL_DEPLOYER);
        pool =
            new ShieldedPool(address(entrypoint), withdrawalVerifier, ragequitVerifier, USDG, registry, 100e6, 1_000e6);
        vm.prank(RELAY_DEPLOYER);
        relay = new ShieldedRelay(pool, registry, 500);

        assertEq(address(entrypoint), vm.computeCreateAddress(ENTRYPOINT_DEPLOYER, 0));
        assertEq(address(pool), vm.computeCreateAddress(POOL_DEPLOYER, 0));
        assertEq(address(relay), vm.computeCreateAddress(RELAY_DEPLOYER, 0));
        assertEq(pool.SCOPE(), fixture.readUint(".scope"), "scope differs from the fixture");

        vm.prank(owner);
        entrypoint.registerPool(IERC20(USDG), pool, 10_000, 0, 500);

        usdg.mint(alice, 2_000e6);
        usdg.mint(bob, 2_000e6);
        vm.prank(alice);
        usdg.approve(address(entrypoint), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(entrypoint), type(uint256).max);
        vm.deal(relayer, 1 ether);
    }

    function _depositBoth() internal {
        vm.prank(alice);
        uint256 c1 = entrypoint.deposit(
            IERC20(USDG), fixture.readUint(".deposit1.value"), fixture.readUint(".deposit1.precommitment")
        );
        assertEq(c1, fixture.readUint(".deposit1.commitment"));
        vm.prank(bob);
        uint256 c2 = entrypoint.deposit(
            IERC20(USDG), fixture.readUint(".deposit2.value"), fixture.readUint(".deposit2.precommitment")
        );
        assertEq(c2, fixture.readUint(".deposit2.commitment"));
    }

    /// The ASP root for {label1, label2}: a two-leaf lean tree is Poseidon(label1, label2), which
    /// the relayed proof carries as its public ASPRoot.
    function _postRoot(string memory key) internal {
        uint256 root = fixture.readUintArray(string.concat(key, ".pubSignals"))[5];
        vm.prank(postman);
        entrypoint.updateRoot(root, "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    }

    function _withdrawProof(string memory key) internal view returns (ProofLib.WithdrawProof memory p) {
        uint256[] memory a = fixture.readUintArray(string.concat(key, ".pA"));
        uint256[] memory b0 = fixture.readUintArray(string.concat(key, ".pB[0]"));
        uint256[] memory b1 = fixture.readUintArray(string.concat(key, ".pB[1]"));
        uint256[] memory c = fixture.readUintArray(string.concat(key, ".pC"));
        uint256[] memory s = fixture.readUintArray(string.concat(key, ".pubSignals"));
        p.pA = [a[0], a[1]];
        p.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.pC = [c[0], c[1]];
        for (uint256 i; i < 8; ++i) {
            p.pubSignals[i] = s[i];
        }
    }

    function _ragequitProof() internal view returns (ProofLib.RagequitProof memory p) {
        uint256[] memory a = fixture.readUintArray(".ragequit.pA");
        uint256[] memory b0 = fixture.readUintArray(".ragequit.pB[0]");
        uint256[] memory b1 = fixture.readUintArray(".ragequit.pB[1]");
        uint256[] memory c = fixture.readUintArray(".ragequit.pC");
        uint256[] memory s = fixture.readUintArray(".ragequit.pubSignals");
        p.pA = [a[0], a[1]];
        p.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.pC = [c[0], c[1]];
        for (uint256 i; i < 4; ++i) {
            p.pubSignals[i] = s[i];
        }
    }

    /// A deposit from an address setUp did not fund. No proof exists for the note it creates; it
    /// is there so the address has deposits of its own on the pool's books.
    function _depositFrom(address who, uint256 value, uint256 precommitment) internal {
        usdg.mint(who, value);
        vm.startPrank(who);
        usdg.approve(address(entrypoint), value);
        entrypoint.deposit(IERC20(USDG), value, precommitment);
        vm.stopPrank();
    }

    function _relayWithdrawal() internal view returns (IPrivacyPool.Withdrawal memory) {
        return IPrivacyPool.Withdrawal({processooor: address(relay), data: fixture.readBytes(".relayData")});
    }

    function _relayTo(address recipient, address feeRecipient) internal view returns (IPrivacyPool.Withdrawal memory) {
        return IPrivacyPool.Withdrawal({
            processooor: address(relay),
            data: abi.encode(
                IEntrypoint.RelayData({recipient: recipient, feeRecipient: feeRecipient, relayFeeBPS: 100})
            )
        });
    }

    function test_depositRecordsLabelAndDepositor() public {
        _depositBoth();
        assertEq(pool.depositors(fixture.readUint(".deposit1.label")), alice);
        assertEq(pool.depositors(fixture.readUint(".deposit2.label")), bob);
        assertEq(pool.depositedBy(alice), 1_000_000);
        assertEq(pool.depositedBy(bob), 300_000);
        assertEq(usdg.balanceOf(address(pool)), 1_300_000);
        assertEq(pool.currentTreeSize(), 2);
    }

    function test_depositAbovePerDepositCapReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositAboveCap.selector, 100e6 + 1, 100e6));
        entrypoint.deposit(IERC20(USDG), 100e6 + 1, 123);
    }

    function test_depositPastPoolCapReverts() public {
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            entrypoint.deposit(IERC20(USDG), 100e6, 1_000 + i);
        }
        assertEq(usdg.balanceOf(address(pool)), 1_000e6);
        assertEq(pool.poolValue(), 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.PoolCapReached.selector, 1_000e6 + 10_000, 1_000e6));
        entrypoint.deposit(IERC20(USDG), 10_000, 9_999);
    }

    function test_aDonationDoesNotCountTowardTheCap() public {
        // A transfer outside a deposit belongs to no note. Counted, it would fill the cap for free.
        usdg.mint(address(pool), 999e6);
        vm.prank(alice);
        entrypoint.deposit(IERC20(USDG), 100e6, 1_000);
        assertEq(pool.poolValue(), 100e6);
        assertEq(usdg.balanceOf(address(pool)), 1_099e6);

        for (uint256 i = 1; i < 10; ++i) {
            vm.prank(alice);
            entrypoint.deposit(IERC20(USDG), 100e6, 1_000 + i);
        }
        assertEq(pool.poolValue(), 1_000e6);

        // The cap still binds, on what the pool owes its notes and nothing else.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.PoolCapReached.selector, 1_000e6 + 10_000, 1_000e6));
        entrypoint.deposit(IERC20(USDG), 10_000, 9_999);
    }

    function test_payoutsFreeRoomUnderTheCap() public {
        _depositBoth();
        _postRoot(".relayed");
        relay.relay(_relayWithdrawal(), _withdrawProof(".relayed"));
        assertEq(pool.poolValue(), 900_000);
        vm.prank(bob);
        pool.ragequit(_ragequitProof());
        assertEq(pool.poolValue(), 600_000);
        assertEq(usdg.balanceOf(address(pool)), 600_000);
    }

    function test_theVettingFeeComesOffBeforeTheDepositCap() public {
        vm.prank(owner);
        entrypoint.updatePoolConfiguration(IERC20(USDG), 1e6, 10, 500);

        vm.prank(alice);
        vm.expectRevert(IEntrypoint.MinimumDepositAmount.selector);
        entrypoint.deposit(IERC20(USDG), 1e6 - 1, 1);

        // 100.1001 USDG less 10 bps is exactly the 100 USDG cap; one unit more is over it.
        vm.prank(alice);
        entrypoint.deposit(IERC20(USDG), 100_100_100, 2);
        assertEq(pool.poolValue(), 100e6);
        assertEq(usdg.balanceOf(address(entrypoint)), 100_100);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositAboveCap.selector, 100e6 + 1, 100e6));
        entrypoint.deposit(IERC20(USDG), 100_100_101, 3);
    }

    /// Any run of deposits, at any vetting fee, leaves the pool inside both caps, and every refusal
    /// is the one the caps predict.
    function testFuzz_depositsStayInsideTheCaps(uint256[8] memory values, uint16 feeBps) public {
        uint256 fee = bound(feeBps, 0, 100);
        vm.prank(owner);
        entrypoint.updatePoolConfiguration(IERC20(USDG), 10_000, fee, 500);
        usdg.mint(alice, 2_000e6);

        uint256 expected;
        for (uint256 i; i < values.length; ++i) {
            uint256 value = bound(values[i], 10_000, 250e6);
            uint256 net = value - (value * fee) / 10_000;
            vm.prank(alice);
            if (net > 100e6) {
                vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositAboveCap.selector, net, 100e6));
            } else if (expected + net > 1_000e6) {
                vm.expectRevert(abi.encodeWithSelector(ShieldedPool.PoolCapReached.selector, expected + net, 1_000e6));
            } else {
                expected += net;
            }
            entrypoint.deposit(IERC20(USDG), value, 10_000 + i);
            assertEq(pool.poolValue(), expected);
        }
        assertLe(pool.poolValue(), pool.MAX_TOTAL());
        assertEq(usdg.balanceOf(address(pool)), expected);
    }

    function test_blockedDepositorCannotDeposit() public {
        registry.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositorBlocked.selector, alice));
        entrypoint.deposit(IERC20(USDG), 1e6, 77);
    }

    function test_depositBelowMinimumReverts() public {
        vm.prank(alice);
        vm.expectRevert(IEntrypoint.MinimumDepositAmount.selector);
        entrypoint.deposit(IERC20(USDG), 9_999, 5);
    }

    function test_capsAreConstructorChecked() public {
        vm.expectRevert(IPrivacyPool.InvalidDepositValue.selector);
        new ShieldedPool(address(entrypoint), address(1), address(1), USDG, registry, 10, 9);
    }

    function test_relayPaysRecipientFeeAndGas() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");

        vm.prank(relayer);
        relay.relay{value: 0.0002 ether}(_relayWithdrawal(), p);

        // 0.4 USDG at 100 bps: 0.396 to the recipient, 0.004 to the relayer's fee address.
        assertEq(usdg.balanceOf(RECIPIENT), 396_000);
        assertEq(usdg.balanceOf(FEE_RECIPIENT), 4_000);
        assertEq(RECIPIENT.balance, 0.0002 ether);
        assertEq(usdg.balanceOf(address(pool)), 900_000);
        assertEq(usdg.balanceOf(address(relay)), 0);
        assertTrue(pool.nullifierHashes(p.pubSignals[1]));
        assertEq(pool.currentTreeSize(), 3);
    }

    function test_relayedProofCannotBeReplayed() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        relay.relay(_relayWithdrawal(), p);
        vm.expectRevert(IState.NullifierAlreadySpent.selector);
        relay.relay(_relayWithdrawal(), p);
    }

    /// The relay screens the final recipient and cannot tell whose note it forwards, so a blocked
    /// recipient is refused there even with deposits of its own on the pool's books.
    function test_blockedRecipientRefusedWithoutBurningNullifier() public {
        _depositBoth();
        _depositFrom(RECIPIENT, 400_000, 77);
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        registry.setBlocked(RECIPIENT, true);

        vm.expectRevert(abi.encodeWithSelector(ShieldedRelay.RecipientBlocked.selector, RECIPIENT));
        relay.relay(_relayWithdrawal(), p);
        assertFalse(pool.nullifierHashes(p.pubSignals[1]), "a refusal must not spend the note");

        // Unblocked, the same proof still works: the note was never touched.
        registry.setBlocked(RECIPIENT, false);
        relay.relay(_relayWithdrawal(), p);
        assertEq(usdg.balanceOf(RECIPIENT), 396_000);
        assertEq(pool.paidWhileBlocked(RECIPIENT), 0);
    }

    function test_blockedFeeRecipientRefused() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        registry.setBlocked(FEE_RECIPIENT, true);
        vm.expectRevert(abi.encodeWithSelector(ShieldedRelay.RecipientBlocked.selector, FEE_RECIPIENT));
        relay.relay(_relayWithdrawal(), p);
        assertFalse(pool.nullifierHashes(p.pubSignals[1]));
    }

    function test_relayRefusesToPayItselfThePoolOrTheEntrypoint() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        address[3] memory sinks = [address(relay), address(pool), address(entrypoint)];
        for (uint256 i; i < sinks.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ShieldedRelay.InvalidRecipient.selector, sinks[i]));
            relay.relay(_relayTo(sinks[i], FEE_RECIPIENT), p);
            vm.expectRevert(abi.encodeWithSelector(ShieldedRelay.InvalidRecipient.selector, sinks[i]));
            relay.relay(_relayTo(RECIPIENT, sinks[i]), p);
        }
        assertFalse(pool.nullifierHashes(p.pubSignals[1]));
        assertEq(relay.ENTRYPOINT(), address(entrypoint));
    }

    function test_relayRejectsAlteredRecipient() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        IPrivacyPool.Withdrawal memory w = _relayWithdrawal();
        w.data = abi.encode(IEntrypoint.RelayData({recipient: relayer, feeRecipient: FEE_RECIPIENT, relayFeeBPS: 100}));
        vm.expectRevert(IPrivacyPool.ContextMismatch.selector);
        relay.relay(w, p);
    }

    function test_relayRejectsStaleAspRoot() public {
        _depositBoth();
        _postRoot(".relayed");
        vm.prank(postman);
        entrypoint.updateRoot(42, "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
        vm.expectRevert(IPrivacyPool.IncorrectASPRoot.selector);
        relay.relay(_relayWithdrawal(), _withdrawProof(".relayed"));
    }

    function test_relayRejectsForgedProof() public {
        _depositBoth();
        _postRoot(".relayed");
        ProofLib.WithdrawProof memory p = _withdrawProof(".relayed");
        p.pA[0] = p.pA[0] ^ 1;
        vm.expectRevert(IPrivacyPool.InvalidProof.selector);
        relay.relay(_relayWithdrawal(), p);
    }

    function test_relayRejectsFeeAboveMax() public {
        vm.prank(RELAY_DEPLOYER);
        ShieldedRelay strict = new ShieldedRelay(pool, registry, 50);
        IPrivacyPool.Withdrawal memory w =
            IPrivacyPool.Withdrawal({processooor: address(strict), data: fixture.readBytes(".relayData")});
        vm.expectRevert(abi.encodeWithSelector(ShieldedRelay.FeeAboveMax.selector, 100, 50));
        strict.relay(w, _withdrawProof(".relayed"));
    }

    function test_upstreamEntrypointRelayIsRefused() public {
        _depositBoth();
        _postRoot(".viaEntrypoint");
        ProofLib.WithdrawProof memory p = _withdrawProof(".viaEntrypoint");
        IPrivacyPool.Withdrawal memory w =
            IPrivacyPool.Withdrawal({processooor: address(entrypoint), data: fixture.readBytes(".relayData")});
        // A valid proof for the Entrypoint path: the pool refuses to pay the Entrypoint, because the
        // Entrypoint would then pay a recipient the pool never screened.
        uint256 scope = pool.SCOPE();
        vm.expectRevert(ShieldedPool.RelayThroughShieldedRelay.selector);
        entrypoint.relay(w, p, scope);
        assertFalse(pool.nullifierHashes(p.pubSignals[1]));
    }

    function test_ragequitReturnsDepositToDepositor() public {
        _depositBoth();
        uint256 before = usdg.balanceOf(bob);
        vm.prank(bob);
        pool.ragequit(_ragequitProof());
        assertEq(usdg.balanceOf(bob), before + 300_000);
        assertEq(usdg.balanceOf(address(pool)), 1_000_000);
    }

    function test_ragequitWorksWithoutAnyAspRoot() public {
        _depositBoth();
        vm.expectRevert(IEntrypoint.NoRootsAvailable.selector);
        entrypoint.latestRoot();
        vm.prank(bob);
        pool.ragequit(_ragequitProof());
    }

    function test_ragequitOnlyByDepositor() public {
        _depositBoth();
        vm.prank(alice);
        vm.expectRevert(IPrivacyPool.OnlyOriginalDepositor.selector);
        pool.ragequit(_ragequitProof());
    }

    /// A depositor the registry blocks after its deposit still has ragequit, the exit that needs
    /// nobody's approval, and takes back what it put in.
    function test_aBlockedDepositorRagequitsItsOwnDeposit() public {
        _depositBoth();
        registry.setBlocked(bob, true);
        ProofLib.RagequitProof memory p = _ragequitProof();
        uint256 before = usdg.balanceOf(bob);

        vm.prank(bob);
        pool.ragequit(p);

        assertEq(usdg.balanceOf(bob), before + 300_000);
        assertEq(pool.poolValue(), 1_000_000);
        assertTrue(pool.nullifierHashes(p.pubSignals[1]));
    }

    function test_aWithdrawalNamingTheRelayCannotBeTakenDirectly() public {
        _depositBoth();
        _postRoot(".relayed");
        vm.expectRevert(IPrivacyPool.InvalidProcessooor.selector);
        pool.withdraw(_relayWithdrawal(), _withdrawProof(".relayed"));
    }

    /// The fixture proves a withdrawal whose processooor is DIRECT itself, taken straight from the
    /// pool with no relay in between, so the pool is the only screen on this path. DIRECT never
    /// deposited: blocked, it has nothing to take back, and the note stays spendable.
    function test_aBlockedAddressThatNeverDepositedIsRefusedWithoutBurningTheNote() public {
        _depositBoth();
        _postRoot(".direct");
        ProofLib.WithdrawProof memory p = _withdrawProof(".direct");
        IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal({processooor: DIRECT, data: ""});
        registry.setBlocked(DIRECT, true);

        vm.prank(DIRECT);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.RecipientBlocked.selector, DIRECT));
        pool.withdraw(w, p);
        assertFalse(pool.nullifierHashes(p.pubSignals[1]), "a refusal must not spend the note");

        registry.setBlocked(DIRECT, false);
        vm.prank(DIRECT);
        pool.withdraw(w, p);
        assertEq(usdg.balanceOf(DIRECT), 400_000);
        assertEq(pool.poolValue(), 900_000);
    }

    /// The same withdrawal pays 0.4 USDG of alice's note to DIRECT. With 0.4 USDG of deposits of
    /// its own on the books, a blocked DIRECT is paid exactly that, and has then taken out
    /// everything it brought in.
    function test_aBlockedAddressIsPaidExactlyWhatItPutIn() public {
        _depositBoth();
        _depositFrom(DIRECT, 400_000, 77);
        _postRoot(".direct");
        registry.setBlocked(DIRECT, true);

        vm.prank(DIRECT);
        pool.withdraw(IPrivacyPool.Withdrawal({processooor: DIRECT, data: ""}), _withdrawProof(".direct"));

        assertEq(usdg.balanceOf(DIRECT), 400_000);
        assertEq(pool.depositedBy(DIRECT), 400_000);
        assertEq(pool.paidWhileBlocked(DIRECT), 400_000);
        assertEq(pool.poolValue(), 1_300_000);
    }

    /// One unit short of what the withdrawal pays, and the blocked address is refused without the
    /// note being spent. Once it has deposited more of its own, the same proof goes through.
    function test_aBlockedAddressIsRefusedOneUnitAboveWhatItPutIn() public {
        _depositBoth();
        _depositFrom(DIRECT, 399_999, 77);
        _postRoot(".direct");
        ProofLib.WithdrawProof memory p = _withdrawProof(".direct");
        IPrivacyPool.Withdrawal memory w = IPrivacyPool.Withdrawal({processooor: DIRECT, data: ""});
        registry.setBlocked(DIRECT, true);

        vm.prank(DIRECT);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.RecipientBlocked.selector, DIRECT));
        pool.withdraw(w, p);
        assertFalse(pool.nullifierHashes(p.pubSignals[1]), "a refusal must not spend the note");
        assertEq(pool.paidWhileBlocked(DIRECT), 0);

        // A blocked address cannot deposit, so the top-up happens between two listings.
        registry.setBlocked(DIRECT, false);
        _depositFrom(DIRECT, 10_000, 78);
        registry.setBlocked(DIRECT, true);

        vm.prank(DIRECT);
        pool.withdraw(w, p);
        assertEq(usdg.balanceOf(DIRECT), 400_000);
        assertEq(pool.depositedBy(DIRECT), 409_999);
        assertEq(pool.paidWhileBlocked(DIRECT), 400_000);
    }
}
