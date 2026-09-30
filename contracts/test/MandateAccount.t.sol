// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";

import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {InflatingERC20} from "./mocks/InflatingERC20.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockReputation} from "./mocks/MockReputation.sol";
import {ShrinkingERC20} from "./mocks/ShrinkingERC20.sol";

/// Drives the mandate the way an agent would, catching every refusal so the run keeps going,
/// and keeps the ghost totals the invariants are written against.
contract MandateAccountSpendHandler is Test {
    bytes32 public constant CAPABILITY = keccak256("mandate.core.inference");
    bytes32 public constant UNKNOWN_CAPABILITY = keccak256("mandate.core.unlisted");

    MandateAccount public immutable account;
    address public immutable principal;
    address public immutable merchant;
    address public immutable stranger;

    uint256 public locked;
    uint128 public largestSpend;
    uint256 public spendsWhilePaused;

    constructor(MandateAccount account_, address principal_, address merchant_, address stranger_) {
        account = account_;
        principal = principal_;
        merchant = merchant_;
        stranger = stranger_;
    }

    function spend(uint128 amount, bool knownMerchant, bool knownCapability) external {
        amount = uint128(bound(amount, 0, 200e6));

        IMandateAccount.SpendRequest memory request = IMandateAccount.SpendRequest({
            merchant: knownMerchant ? merchant : stranger,
            capabilityId: knownCapability ? CAPABILITY : UNKNOWN_CAPABILITY,
            inputCommit: keccak256(abi.encodePacked(amount)),
            inputURI: "ipfs://input",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });

        bool wasPaused = account.paused();

        try account.spend(request, new bytes32[](0)) returns (uint256) {
            locked += amount;
            if (amount > largestSpend) largestSpend = amount;
            if (wasPaused) ++spendsWhilePaused;
        } catch {}
    }

    function setPaused(bool paused_) external {
        vm.prank(principal);
        account.setPaused(paused_);
    }

    function passTime(uint32 elapsed) external {
        skip(bound(elapsed, 1 minutes, 2 days));
    }
}

/// Core mandate behaviour: who may call what, the caps at their exact edge, the gates, and the
/// two pull paths where a token that does not move what it was told to has to be caught.
contract MandateAccountCoreTest is Test {
    uint256 private constant PRINCIPAL_KEY = 0xA11CE;

    uint128 private constant PER_CALL_CAP = 100e6;
    uint128 private constant DAILY_CAP = 500e6;
    uint128 private constant MONTHLY_CAP = 5_000e6;
    uint64 private constant DAILY_WINDOW = 1 days;
    uint64 private constant MONTHLY_WINDOW = 30 days;
    uint128 private constant FUNDING = 1_000_000e6;

    uint16 private constant FEE_BPS = 100;
    uint16 private constant RESOLVER_FEE_BPS = 100;
    uint16 private constant DISPUTE_BOND_BPS = 500;
    uint64 private constant MIN_TTL = 1 minutes;
    uint64 private constant MAX_TTL = 30 days;

    /// The smallest lock the escrow opens at a five percent bond. What the escrow refuses on
    /// its own terms is not a decision of the mandate's.
    uint128 private constant MIN_LOCK = 20;

    bytes32 private constant CAPABILITY = keccak256("mandate.core.inference");
    bytes32 private constant OTHER_CAPABILITY = keccak256("mandate.core.storage");

    // Declared locally so the expectations can be written against the same shapes the account
    // emits without inheriting the interface.
    event AgentUpdated(address indexed agent);
    event AgentRevoked(address indexed agent);
    event PausedUpdated(bool paused);
    event MerchantUpdated(address indexed merchant, bool allowed);
    event CapabilityUpdated(bytes32 indexed capabilityId, bool allowed);
    event LimitsUpdated(uint64 indexed version, IMandateAccount.Limits limits);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event PrincipalTransferred(address indexed from, address indexed to);
    event Spent(
        uint256 indexed escrowId,
        address indexed merchant,
        bytes32 indexed capabilityId,
        uint128 amount,
        uint128 dailySpent,
        uint128 monthlySpent
    );

    address private principal;
    address private agent = makeAddr("agent");
    address private merchant = makeAddr("merchant");
    address private stranger = makeAddr("stranger");
    address private treasury = makeAddr("treasury");
    address private funder = makeAddr("funder");

    MockUsdg private asset;
    MockReputation private reputation;
    Escrow private escrow;
    MandateAccount private account;

    MandateAccountSpendHandler private handler;
    MockUsdg private soakAsset;
    MandateAccount private soakAccount;
    Escrow private soakEscrow;

    function setUp() public {
        // Start from a plausible wall clock. Window rollover and the validity bounds are both
        // read against block.timestamp, and a chain that begins at 1 hides sign errors.
        vm.warp(1_757_000_000);

        principal = vm.addr(PRINCIPAL_KEY);

        asset = new MockUsdg();
        reputation = new MockReputation();
        escrow = _deployEscrow(address(asset));
        reputation.setEscrow(address(escrow));

        account = _deployAccount(asset, escrow, _baseLimits());

        soakAsset = new MockUsdg();
        soakEscrow = _deployEscrow(address(soakAsset));
        soakAccount = _deployAccount(soakAsset, soakEscrow, _baseLimits());

        handler = new MandateAccountSpendHandler(soakAccount, principal, merchant, stranger);
        vm.prank(principal);
        soakAccount.setAgent(address(handler));

        targetContract(address(handler));
    }

    function test_constructorRejectsAZeroPrincipal() public {
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        new MandateAccount(address(0), agent, address(asset), address(escrow), _baseLimits());
    }

    function test_constructorRejectsAZeroSettlementAsset() public {
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        new MandateAccount(principal, agent, address(0), address(escrow), _baseLimits());
    }

    function test_constructorRejectsAZeroEscrow() public {
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        new MandateAccount(principal, agent, address(asset), address(0), _baseLimits());
    }

    function test_constructorAcceptsAZeroAgentSoAMandateCanBeFundedBeforeItIsStaffed() public {
        MandateAccount idle = new MandateAccount(principal, address(0), address(asset), address(escrow), _baseLimits());

        assertEq(idle.agent(), address(0), "the constructor stored the zero agent");
        assertFalse(idle.revoked(), "an unstaffed mandate is not a revoked one");
        assertEq(idle.version(), 1, "the first limit set is version one");
    }

    function test_constructorRejectsAZeroWindow() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyWindow = 0;
        vm.expectRevert(IMandateAccount.BadWindow.selector);
        new MandateAccount(principal, agent, address(asset), address(escrow), limits);

        limits = _baseLimits();
        limits.monthlyWindow = 0;
        vm.expectRevert(IMandateAccount.BadWindow.selector);
        new MandateAccount(principal, agent, address(asset), address(escrow), limits);
    }

    function test_constructorRejectsAZeroApprovalThreshold() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.approvalThreshold = 0;

        vm.expectRevert(IMandateAccount.BadApprovalThreshold.selector);
        new MandateAccount(principal, agent, address(asset), address(escrow), limits);
    }

    function test_constructorRejectsAValidityWindowThatClosesAtOrBeforeItOpens() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.validFrom = uint64(block.timestamp);
        limits.validUntil = uint64(block.timestamp);

        vm.expectRevert(IMandateAccount.BadValidity.selector);
        new MandateAccount(principal, agent, address(asset), address(escrow), limits);

        limits.validUntil = uint64(block.timestamp) - 1;
        vm.expectRevert(IMandateAccount.BadValidity.selector);
        new MandateAccount(principal, agent, address(asset), address(escrow), limits);
    }

    function test_aSpendLocksInTheEscrowAndDebitsBothWindows() public {
        uint128 amount = 40e6;
        uint256 accountBefore = asset.balanceOf(address(account));

        vm.expectEmit(true, true, true, true, address(account));
        emit Spent(1, merchant, CAPABILITY, amount, amount, amount);

        vm.prank(agent);
        uint256 escrowId = account.spend(_request(merchant, CAPABILITY, amount), _noProof());

        IEscrow.Lock memory entry = escrow.getLock(escrowId);
        assertEq(entry.payer, address(account), "the mandate is the payer of its own lock");
        assertEq(entry.payee, merchant, "the merchant of the spend is the payee of the lock");
        assertEq(entry.amount, amount, "the escrow holds the full requested amount");
        assertEq(uint8(entry.status), uint8(IEscrow.LockStatus.Locked));

        assertEq(asset.balanceOf(address(escrow)), amount, "funds moved to the escrow");
        assertEq(asset.balanceOf(address(account)), accountBefore - amount, "funds left the mandate");
        assertEq(account.creditable(escrowId), amount, "the whole spend is still creditable");

        (uint128 perCall, uint128 daily, uint128 monthly) = account.remaining();
        assertEq(perCall, PER_CALL_CAP, "the per-call cap is not a budget and does not deplete");
        assertEq(daily, DAILY_CAP - amount);
        assertEq(monthly, MONTHLY_CAP - amount);
    }

    function test_aSpendLeavesNoStandingAllowanceBehindIt() public {
        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 25e6), _noProof());

        assertEq(
            asset.allowance(address(account), address(escrow)),
            0,
            "an allowance surviving the lock would let the escrow pull again"
        );
    }

    function test_aSpendOfZeroIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ZeroAmount.selector);
        account.spend(_request(merchant, CAPABILITY, 0), _noProof());
    }

    function test_aSpendToTheZeroMerchantIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        account.spend(_request(address(0), CAPABILITY, 10e6), _noProof());
    }

    function test_aSpendAtExactlyThePerCallCapClears() public {
        vm.prank(agent);
        uint256 escrowId = account.spend(_request(merchant, CAPABILITY, PER_CALL_CAP), _noProof());

        assertEq(escrow.getLock(escrowId).amount, PER_CALL_CAP, "the cap is inclusive");
    }

    function test_aSpendOneUnitAboveThePerCallCapIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.PerCallCapExceeded.selector);
        account.spend(_request(merchant, CAPABILITY, PER_CALL_CAP + 1), _noProof());
    }

    function test_thePerCallCapIsReportedAheadOfTheWindowsWhenBothWouldRefuse() public {
        // Above the per-call cap and above what is left in the day. The caller is told the
        // limit it can do something about.
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.PerCallCapExceeded.selector);
        account.spend(_request(merchant, CAPABILITY, DAILY_CAP + 1), _noProof());
    }

    function test_aLoweredPerCallCapBindsTheVeryNextSpend() public {
        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, PER_CALL_CAP), _noProof());

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.perCallCap = 1e6;
        vm.prank(principal);
        account.setLimits(limits);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.PerCallCapExceeded.selector);
        account.spend(_request(merchant, CAPABILITY, 1e6 + 1), _noProof());

        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 1e6), _noProof());
    }

    function testFuzz_everyAmountAboveThePerCallCapIsRefusedAndEveryAmountAtOrBelowItClears(uint128 amount) public {
        amount = uint128(bound(amount, MIN_LOCK, PER_CALL_CAP * 4));

        if (amount > PER_CALL_CAP) {
            vm.prank(agent);
            vm.expectRevert(IMandateAccount.PerCallCapExceeded.selector);
            account.spend(_request(merchant, CAPABILITY, amount), _noProof());
            return;
        }

        vm.prank(agent);
        uint256 escrowId = account.spend(_request(merchant, CAPABILITY, amount), _noProof());
        assertEq(escrow.getLock(escrowId).amount, amount);
    }

    function test_anUnlistedMerchantCannotBePaid() public {
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MerchantNotAllowed.selector);
        account.spend(_request(stranger, CAPABILITY, 10e6), _noProof());
    }

    function test_revokingAMerchantStopsTheNextSpendToIt() public {
        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        vm.expectEmit(true, false, false, true, address(account));
        emit MerchantUpdated(merchant, false);
        vm.prank(principal);
        account.setMerchant(merchant, false);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.MerchantNotAllowed.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_aProofCarriedIntoAnAllowlistGateIsRefused() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("stale");

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.AllowlistGateActive.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), proof);
    }

    function test_theMerchantRosterCannotBeEditedWhileTheMerkleGateIsLive() public {
        vm.startPrank(principal);
        account.setMerchantGate(IMandateAccount.MerchantGate.MerkleRoot, keccak256("roster"));

        vm.expectRevert(IMandateAccount.MerkleGateActive.selector);
        account.setMerchant(stranger, true);
        vm.stopPrank();
    }

    function test_theMerkleGateRefusesAnEmptyRootAndTheAllowlistRefusesANonEmptyOne() public {
        vm.startPrank(principal);
        vm.expectRevert(IMandateAccount.BadMerkleProof.selector);
        account.setMerchantGate(IMandateAccount.MerchantGate.MerkleRoot, bytes32(0));

        vm.expectRevert(IMandateAccount.BadMerkleProof.selector);
        account.setMerchantGate(IMandateAccount.MerchantGate.Allowlist, keccak256("roster"));
        vm.stopPrank();
    }

    function test_previewSpendUnderTheMerkleGateSaysItCannotAnswer() public {
        vm.prank(principal);
        account.setMerchantGate(IMandateAccount.MerchantGate.MerkleRoot, keccak256("roster"));

        (bool allowed, bytes4 reason) = account.previewSpend(merchant, CAPABILITY, 10e6, 0);
        assertFalse(allowed);
        _assertReason(
            reason, IMandateAccount.MerkleGateActive.selector, "a preview without a proof cannot clear a root"
        );
    }

    function test_aMerchantUnderTheMerkleGateIsPaidOnlyAgainstAProof() public {
        // Two-leaf tree: the sibling is the other side of the root, so the proof for the
        // merchant is exactly one hash.
        bytes32 merchantLeaf = account.merchantLeaf(merchant);
        bytes32 siblingLeaf = account.merchantLeaf(stranger);
        bytes32 root = merchantLeaf < siblingLeaf
            ? keccak256(abi.encodePacked(merchantLeaf, siblingLeaf))
            : keccak256(abi.encodePacked(siblingLeaf, merchantLeaf));

        vm.prank(principal);
        account.setMerchantGate(IMandateAccount.MerchantGate.MerkleRoot, root);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = siblingLeaf;

        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 10e6), proof);

        proof[0] = keccak256("wrong");
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.BadMerkleProof.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), proof);
    }

    function test_anUnlistedCapabilityCannotBeBought() public {
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.CapabilityNotAllowed.selector);
        account.spend(_request(merchant, OTHER_CAPABILITY, 10e6), _noProof());
    }

    function test_revokingACapabilityStopsTheNextSpendAgainstIt() public {
        vm.expectEmit(true, false, false, true, address(account));
        emit CapabilityUpdated(CAPABILITY, false);
        vm.prank(principal);
        account.setCapability(CAPABILITY, false);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.CapabilityNotAllowed.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_anAllowedMerchantIsNoLicenceForAnotherCapability() public {
        vm.prank(principal);
        account.setCapability(OTHER_CAPABILITY, true);

        vm.prank(agent);
        account.spend(_request(merchant, OTHER_CAPABILITY, 10e6), _noProof());

        vm.prank(principal);
        account.setCapability(OTHER_CAPABILITY, false);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.CapabilityNotAllowed.selector);
        account.spend(_request(merchant, OTHER_CAPABILITY, 10e6), _noProof());
    }

    function test_aPausedMandateRefusesEverySpendAndResumesOnUnpause() public {
        vm.expectEmit(false, false, false, true, address(account));
        emit PausedUpdated(true);
        vm.prank(principal);
        account.setPaused(true);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.IsPaused.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        (bool allowed, bytes4 reason) = account.previewSpend(merchant, CAPABILITY, 10e6, 0);
        assertFalse(allowed);
        _assertReason(reason, IMandateAccount.IsPaused.selector, "a paused mandate must quote the pause");

        vm.prank(principal);
        account.setPaused(false);

        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_pausingDoesNotDisturbTheWindowsItInterrupts() public {
        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 30e6), _noProof());

        vm.startPrank(principal);
        account.setPaused(true);
        account.setPaused(false);
        vm.stopPrank();

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - 30e6, "a pause is not a reset");
    }

    /// The hash anchors the mandate document the underwriter reads off chain. Nothing on chain
    /// interprets it, so the test is that the principal owns it and that it is readable back.
    function test_thePrincipalAnchorsTheMandateDocument() public {
        assertEq(account.documentHash(), bytes32(0));

        vm.expectEmit(true, false, false, true, address(account));
        emit IMandateAccount.DocumentHashUpdated(keccak256("terms.v1"));
        vm.prank(principal);
        account.setDocumentHash(keccak256("terms.v1"));

        assertEq(account.documentHash(), keccak256("terms.v1"));

        // Re-anchoring is how a renegotiated mandate is recorded, so it is not one-shot.
        vm.prank(principal);
        account.setDocumentHash(keccak256("terms.v2"));

        assertEq(account.documentHash(), keccak256("terms.v2"));
    }

    function test_revokingTheAgentLeavesNobodyAbleToSpend() public {
        vm.expectEmit(true, false, false, true, address(account));
        emit AgentRevoked(agent);
        vm.prank(principal);
        account.revokeAgent();

        assertEq(account.agent(), address(0));
        assertTrue(account.revoked());

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        (bool allowed, bytes4 reason) = account.previewSpend(merchant, CAPABILITY, 10e6, 0);
        assertFalse(allowed);
        _assertReason(reason, IMandateAccount.IsRevoked.selector, "a quote must name revocation over a missing agent");
    }

    function test_appointingANewAgentLiftsTheRevocationAndStrandsTheOldOne() public {
        address successor = makeAddr("successor");

        vm.prank(principal);
        account.revokeAgent();

        vm.expectEmit(true, false, false, true, address(account));
        emit AgentUpdated(successor);
        vm.prank(principal);
        account.setAgent(successor);

        assertFalse(account.revoked(), "a fresh appointment clears the revocation flag");

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        vm.prank(successor);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_rotatingTheAgentCarriesTheSpentWindowsAcross() public {
        address successor = makeAddr("successor");

        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 60e6), _noProof());

        vm.prank(principal);
        account.setAgent(successor);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - 60e6, "the budget belongs to the mandate, not to the agent");
    }

    function test_onlyTheAgentMaySpend() public {
        vm.prank(principal);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_theAgentCheckOutranksEveryOtherRefusal() public {
        vm.prank(principal);
        account.setPaused(true);

        // A paused mandate still tells an impostor it is not the agent. Nothing about the
        // mandate's state leaks to a caller with no standing.
        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_everyPrincipalOnlySetterRefusesTheAgentAndAStranger() public {
        bytes[] memory calls = new bytes[](12);
        calls[0] = abi.encodeCall(IMandateAccount.setAgent, (stranger));
        calls[1] = abi.encodeCall(IMandateAccount.revokeAgent, ());
        calls[2] = abi.encodeCall(IMandateAccount.setLimits, (_baseLimits()));
        calls[3] = abi.encodeCall(IMandateAccount.setMerchant, (stranger, true));
        calls[4] = abi.encodeCall(
            IMandateAccount.setMerchantGate, (IMandateAccount.MerchantGate.MerkleRoot, keccak256("roster"))
        );
        calls[5] = abi.encodeCall(IMandateAccount.setCapability, (OTHER_CAPABILITY, true));
        calls[6] = abi.encodeCall(IMandateAccount.setPaused, (true));
        calls[7] = abi.encodeCall(IMandateAccount.setDocumentHash, (keccak256("terms")));
        calls[8] = abi.encodeCall(IMandateAccount.revokeApproval, (keccak256("approval")));
        calls[9] = abi.encodeCall(IMandateAccount.transferPrincipal, (stranger));
        calls[10] = abi.encodeCall(IMandateAccount.withdraw, (address(asset), stranger, 1));
        calls[11] = abi.encodeCall(IMandateAccount.disputeSpend, (1));

        for (uint256 i = 0; i < calls.length; ++i) {
            vm.prank(agent);
            (bool ok, bytes memory ret) = address(account).call(calls[i]);
            assertFalse(ok, "the agent held a principal power");
            // The refusal is a bare selector, so four bytes is the whole payload.
            // forge-lint: disable-next-line(unsafe-typecast)
            _assertReason(bytes4(ret), IMandateAccount.NotPrincipal.selector, "the refusal was not NotPrincipal");

            vm.prank(stranger);
            (ok, ret) = address(account).call(calls[i]);
            assertFalse(ok, "a stranger held a principal power");
            // forge-lint: disable-next-line(unsafe-typecast)
            _assertReason(bytes4(ret), IMandateAccount.NotPrincipal.selector, "the refusal was not NotPrincipal");
        }
    }

    function test_onlyTheEscrowMayCreditASpendBack() public {
        vm.prank(agent);
        uint256 escrowId = account.spend(_request(merchant, CAPABILITY, 20e6), _noProof());

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.NotEscrow.selector);
        account.creditSpend(escrowId, 20e6);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotEscrow.selector);
        account.creditSpend(escrowId, 20e6);
    }

    function test_theEscrowCannotCreditMoreThanASpendCommitted() public {
        vm.prank(agent);
        uint256 escrowId = account.spend(_request(merchant, CAPABILITY, 20e6), _noProof());

        vm.prank(address(escrow));
        vm.expectRevert(IMandateAccount.CreditExceedsSpend.selector);
        account.creditSpend(escrowId, 20e6 + 1);

        vm.prank(address(escrow));
        vm.expectRevert(IMandateAccount.UnknownSpend.selector);
        account.creditSpend(escrowId + 1, 1);
    }

    function test_thePrincipalHandoverNeedsTheSuccessorToAcceptIt() public {
        address successor = makeAddr("successor");

        vm.prank(principal);
        account.transferPrincipal(successor);

        assertEq(account.principal(), principal, "the seat is not vacated by the offer");

        vm.prank(successor);
        vm.expectRevert(IMandateAccount.NotPrincipal.selector);
        account.setPaused(true);

        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.NotPendingPrincipal.selector);
        account.acceptPrincipal();

        vm.expectEmit(true, true, false, true, address(account));
        emit PrincipalTransferred(principal, successor);
        vm.prank(successor);
        account.acceptPrincipal();

        assertEq(account.principal(), successor);
        assertEq(account.pendingPrincipal(), address(0));

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.NotPrincipal.selector);
        account.setPaused(true);
    }

    function test_thePrincipalHandoverRefusesTheZeroAddress() public {
        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        account.transferPrincipal(address(0));
    }

    function test_aDepositOfAWellBehavedAssetCreditsExactlyWhatWasNamed() public {
        uint256 amount = 250e6;
        asset.mint(funder, amount);

        uint256 accountBefore = asset.balanceOf(address(account));

        vm.startPrank(funder);
        asset.approve(address(account), amount);
        vm.expectEmit(true, false, false, true, address(account));
        emit Deposited(funder, amount);
        account.deposit(amount);
        vm.stopPrank();

        assertEq(asset.balanceOf(address(account)), accountBefore + amount);
        assertEq(asset.balanceOf(funder), 0);
    }

    function test_aDepositIsOpenToAnyoneSoATreasuryCanTopUpAMandateItDoesNotOwn() public {
        asset.mint(stranger, 10e6);

        vm.startPrank(stranger);
        asset.approve(address(account), 10e6);
        account.deposit(10e6);
        vm.stopPrank();

        assertEq(asset.balanceOf(address(account)), FUNDING + 10e6);
    }

    function test_aDepositOfZeroIsRefused() public {
        vm.prank(funder);
        vm.expectRevert(IMandateAccount.ZeroAmount.selector);
        account.deposit(0);
    }

    function test_aDepositOfAFeeTakingAssetCreditsWhatArrived() public {
        FeeOnTransferERC20 feeAsset = new FeeOnTransferERC20();
        MandateAccount feeMandate =
            new MandateAccount(principal, agent, address(feeAsset), address(escrow), _baseLimits());

        uint256 amount = 1_000e6;
        uint256 expected = amount - amount / 100;
        feeAsset.mint(funder, amount);

        vm.startPrank(funder);
        feeAsset.approve(address(feeMandate), amount);
        vm.expectEmit(true, false, false, true, address(feeMandate));
        emit Deposited(funder, expected);
        feeMandate.deposit(amount);
        vm.stopPrank();

        assertEq(feeAsset.balanceOf(address(feeMandate)), expected, "the mandate is funded for what landed");
    }

    function testFuzz_aDepositReportsTheMeasuredDeltaForAnyAmount(uint128 amount) public {
        amount = uint128(bound(amount, 1e6, 1_000_000e6));

        FeeOnTransferERC20 feeAsset = new FeeOnTransferERC20();
        MandateAccount feeMandate =
            new MandateAccount(principal, agent, address(feeAsset), address(escrow), _baseLimits());

        uint256 expected = amount - uint256(amount) / 100;
        feeAsset.mint(funder, amount);

        vm.startPrank(funder);
        feeAsset.approve(address(feeMandate), amount);
        vm.expectEmit(true, false, false, true, address(feeMandate));
        emit Deposited(funder, expected);
        feeMandate.deposit(amount);
        vm.stopPrank();

        assertEq(feeAsset.balanceOf(address(feeMandate)), expected);
    }

    function test_aDepositIsRefusedWhenTheAssetDeliversMoreThanItWasAskedTo() public {
        InflatingERC20 inflating = new InflatingERC20();
        MandateAccount inflatingMandate =
            new MandateAccount(principal, agent, address(inflating), address(escrow), _baseLimits());

        inflating.mint(funder, 100e6);

        vm.startPrank(funder);
        inflating.approve(address(inflatingMandate), 100e6);
        vm.expectRevert(IMandateAccount.TransferMismatch.selector);
        inflatingMandate.deposit(100e6);
        vm.stopPrank();
    }

    function test_aDepositIsRefusedWhenTheMandateBalanceFallsAcrossTheTransfer() public {
        ShrinkingERC20 shrinking = new ShrinkingERC20();
        MandateAccount shrinkingMandate =
            new MandateAccount(principal, agent, address(shrinking), address(escrow), _baseLimits());

        shrinking.mint(address(shrinkingMandate), 500e6);
        shrinking.mint(funder, 100e6);
        shrinking.arm(address(shrinkingMandate));

        vm.startPrank(funder);
        shrinking.approve(address(shrinkingMandate), 100e6);
        vm.expectRevert(IMandateAccount.TransferMismatch.selector);
        shrinkingMandate.deposit(100e6);
        vm.stopPrank();
    }

    function test_aFeeTakingSettlementAssetCannotFundALockAtAll() public {
        FeeOnTransferERC20 feeAsset = new FeeOnTransferERC20();
        Escrow feeEscrow = _deployEscrow(address(feeAsset));
        MandateAccount feeMandate =
            new MandateAccount(principal, agent, address(feeAsset), address(feeEscrow), _baseLimits());

        feeAsset.mint(address(feeMandate), FUNDING);
        vm.startPrank(principal);
        feeMandate.setMerchant(merchant, true);
        feeMandate.setCapability(CAPABILITY, true);
        vm.stopPrank();

        // The mandate would debit its window in full and the escrow would receive less than
        // the lock promises the merchant, so the escrow refuses the short delivery.
        vm.prank(agent);
        vm.expectRevert(IEscrow.TransferMismatch.selector);
        feeMandate.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_thePrincipalCanWithdrawTheSettlementAsset() public {
        vm.expectEmit(true, true, false, true, address(account));
        emit Withdrawn(address(asset), principal, 100e6);

        vm.prank(principal);
        account.withdraw(address(asset), principal, 100e6);

        assertEq(asset.balanceOf(principal), 100e6);
        assertEq(asset.balanceOf(address(account)), FUNDING - 100e6);
    }

    function test_thePrincipalCanSweepATokenTheMandateNeverAskedFor() public {
        MockERC20 stray = new MockERC20();
        stray.mint(address(account), 7e6);

        vm.prank(principal);
        account.withdraw(address(stray), principal, 7e6);

        assertEq(stray.balanceOf(principal), 7e6);
        assertEq(stray.balanceOf(address(account)), 0);
    }

    function test_aWithdrawalRefusesAZeroTokenOrAZeroRecipient() public {
        vm.startPrank(principal);
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        account.withdraw(address(0), principal, 1);

        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        account.withdraw(address(asset), address(0), 1);
        vm.stopPrank();
    }

    function test_aWithdrawalCannotReachPastWhatTheMandateHolds() public {
        vm.prank(principal);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(account), uint256(FUNDING), uint256(FUNDING) + 1
            )
        );
        account.withdraw(address(asset), principal, uint256(FUNDING) + 1);
    }

    function test_emptyingTheMandateLeavesTheLimitsIntactAndTheNextLockUnfunded() public {
        vm.prank(principal);
        account.withdraw(address(asset), principal, FUNDING);

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP, "a withdrawal is not a spend");

        // The limit still admits the call. The money is what is missing, so the failure
        // surfaces from the token.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(account), 0, uint256(10e6))
        );
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_theVersionStartsAtOneAndMovesOnEveryLimitChange() public {
        assertEq(account.version(), 1);

        IMandateAccount.Limits memory limits = _baseLimits();
        for (uint64 i = 2; i <= 5; ++i) {
            limits.perCallCap = uint128(i) * 1e6;
            vm.prank(principal);
            account.setLimits(limits);
            assertEq(account.version(), i, "each written mandate is a new version");
        }
    }

    function test_aLimitChangeAnnouncesTheVersionItProduced() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyCap = 900e6;

        vm.expectEmit(true, false, false, true, address(account));
        emit LimitsUpdated(2, limits);
        vm.prank(principal);
        account.setLimits(limits);

        IMandateAccount.Limits memory live = account.limits();
        assertEq(live.dailyCap, 900e6);
        assertEq(live.perCallCap, limits.perCallCap);
        assertEq(live.monthlyCap, limits.monthlyCap);
        assertEq(live.dailyWindow, limits.dailyWindow);
        assertEq(live.monthlyWindow, limits.monthlyWindow);
        assertEq(live.approvalThreshold, limits.approvalThreshold);
        assertEq(live.validFrom, limits.validFrom);
        assertEq(live.validUntil, limits.validUntil);
    }

    function test_aDirectLimitChangeSpendsTheNonceSoAHeldAuthorizationCannotLandLater() public {
        uint256 before = account.nonce();

        vm.prank(principal);
        account.setLimits(_baseLimits());

        assertEq(account.nonce(), before + 1, "an on-chain mandate outranks anything signed earlier");
    }

    function test_rewritingTheSameLimitsDoesNotRefillASpentDailyBucket() public {
        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, PER_CALL_CAP), _noProof());

        vm.prank(principal);
        account.setLimits(_baseLimits());

        (, uint128 daily,) = account.remaining();
        assertEq(daily, DAILY_CAP - PER_CALL_CAP, "a rewrite must not hand back budget already committed");
    }

    function test_aLimitChangeRefusesAZeroWindowOrAZeroThreshold() public {
        IMandateAccount.Limits memory limits = _baseLimits();
        limits.dailyWindow = 0;

        vm.startPrank(principal);
        vm.expectRevert(IMandateAccount.BadWindow.selector);
        account.setLimits(limits);

        limits = _baseLimits();
        limits.approvalThreshold = 0;
        vm.expectRevert(IMandateAccount.BadApprovalThreshold.selector);
        account.setLimits(limits);

        limits = _baseLimits();
        limits.validFrom = uint64(block.timestamp) + 10;
        limits.validUntil = limits.validFrom;
        vm.expectRevert(IMandateAccount.BadValidity.selector);
        account.setLimits(limits);
        vm.stopPrank();

        assertEq(account.version(), 1, "a refused mandate is not a version");
    }

    function test_aRelayedLimitChangeBumpsTheVersionAndBurnsItsNonce() public {
        IMandateAccount.Limits memory next = _baseLimits();
        next.perCallCap = 42e6;

        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 signedNonce = account.nonce();
        bytes memory signature = _signLimits(next, signedNonce, deadline);

        vm.prank(stranger);
        account.setLimitsWithAuthorization(next, signedNonce, deadline, signature);

        assertEq(account.version(), 2);
        assertEq(account.nonce(), signedNonce + 1);
        assertEq(account.perCallCap(), 42e6);

        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(next, signedNonce, deadline, signature);
    }

    function test_aRelayedLimitChangeExpiresWithItsDeadline() public {
        IMandateAccount.Limits memory next = _baseLimits();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _signLimits(next, account.nonce(), deadline);

        vm.warp(deadline + 1);

        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.AuthorizationExpired.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_aRelayedLimitChangeSignedByAnybodyElseIsRefused() public {
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        IMandateAccount.Limits memory next = _baseLimits();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 signedNonce = account.nonce();

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(impostorKey, _limitsDigest(next, signedNonce, deadline));

        vm.prank(stranger);
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, signedNonce, deadline, abi.encodePacked(r, s, v));
    }

    function test_aMandateThatHasNotOpenedYetRefusesTheSpendUntilTheSecondItDoes() public {
        uint64 opensAt = uint64(block.timestamp) + 7 days;

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.validFrom = opensAt;
        MandateAccount future = _deployAccount(asset, escrow, limits);

        vm.warp(opensAt - 1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotYetValid.selector);
        future.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        vm.warp(opensAt);
        vm.prank(agent);
        future.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_aMandateSpendsOnItsClosingSecondAndNotOneSecondLater() public {
        uint64 closesAt = uint64(block.timestamp) + 7 days;

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.validUntil = closesAt;
        MandateAccount expiring = _deployAccount(asset, escrow, limits);

        vm.warp(closesAt);
        vm.prank(agent);
        expiring.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        vm.warp(closesAt + 1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.Expired.selector);
        expiring.spend(_request(merchant, CAPABILITY, 10e6), _noProof());

        (bool allowed, bytes4 reason) = expiring.previewSpend(merchant, CAPABILITY, 10e6, 0);
        assertFalse(allowed);
        _assertReason(reason, IMandateAccount.Expired.selector, "an expired mandate must quote the expiry");
    }

    function test_aZeroValidUntilIsOpenEnded() public {
        vm.warp(block.timestamp + 3650 days);

        vm.prank(agent);
        account.spend(_request(merchant, CAPABILITY, 10e6), _noProof());
    }

    function test_anExpiredMandateStillLetsThePrincipalTakeTheMoneyOut() public {
        uint64 closesAt = uint64(block.timestamp) + 1 days;

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.validUntil = closesAt;
        MandateAccount expiring = _deployAccount(asset, escrow, limits);

        vm.warp(closesAt + 1);

        vm.prank(principal);
        expiring.withdraw(address(asset), principal, FUNDING);

        assertEq(asset.balanceOf(address(expiring)), 0, "expiry ends the agent's authority, not the principal's");
    }

    function testFuzz_theValidityWindowAdmitsExactlyTheInstantsInsideIt(uint64 opensIn, uint64 lasts, uint64 offset)
        public
    {
        uint64 start = uint64(block.timestamp);
        opensIn = uint64(bound(opensIn, 1, 365 days));
        lasts = uint64(bound(lasts, 1, 365 days));

        IMandateAccount.Limits memory limits = _baseLimits();
        limits.validFrom = start + opensIn;
        limits.validUntil = limits.validFrom + lasts;
        MandateAccount bounded = _deployAccount(asset, escrow, limits);

        uint64 at = uint64(bound(offset, start, limits.validUntil + 365 days));
        vm.warp(at);

        (bool allowed, bytes4 reason) = bounded.previewSpend(merchant, CAPABILITY, 10e6, 0);

        if (at < limits.validFrom) {
            assertFalse(allowed);
            _assertReason(reason, IMandateAccount.NotYetValid.selector, "a mandate before its start must quote that");
        } else if (at > limits.validUntil) {
            assertFalse(allowed);
            _assertReason(reason, IMandateAccount.Expired.selector, "an expired mandate must quote the expiry");
        } else {
            assertTrue(allowed, "an instant inside the window must be spendable");
        }
    }

    function testFuzz_previewSpendPredictsExactlyWhatSpendWillDo(
        uint128 amount,
        bool merchantAllowed,
        bool capabilityAllowed,
        bool pausedNow
    ) public {
        amount = uint128(bound(amount, MIN_LOCK, uint256(PER_CALL_CAP) * 2));

        vm.startPrank(principal);
        account.setMerchant(merchant, merchantAllowed);
        account.setCapability(CAPABILITY, capabilityAllowed);
        account.setPaused(pausedNow);
        vm.stopPrank();

        (bool allowed, bytes4 reason) = account.previewSpend(merchant, CAPABILITY, amount, 0);

        vm.prank(agent);
        (bool ok, bytes memory ret) = address(account)
            .call(abi.encodeCall(IMandateAccount.spend, (_request(merchant, CAPABILITY, amount), _noProof())));

        assertEq(ok, allowed, "the quote and the settlement disagreed on the outcome");
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!allowed) _assertReason(bytes4(ret), reason, "the quote named a different refusal");
    }

    function invariant_theEscrowHoldsExactlyWhatTheMandateLocked() public view {
        assertEq(soakAsset.balanceOf(address(soakEscrow)), handler.locked());
    }

    function invariant_noLockEverExceedsThePerCallCap() public view {
        assertLe(handler.largestSpend(), soakAccount.perCallCap());
    }

    function invariant_aPausedMandateNeverSettles() public view {
        assertEq(handler.spendsWhilePaused(), 0);
    }

    function invariant_theMandateBalancePlusWhatItLockedIsWhatItWasFunded() public view {
        assertEq(soakAsset.balanceOf(address(soakAccount)) + handler.locked(), FUNDING);
    }

    function _deployEscrow(address asset_) private returns (Escrow) {
        return new Escrow(
            asset_,
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            MIN_TTL,
            MAX_TTL,
            1 days,
            MIN_LOCK
        );
    }

    function _deployAccount(MockUsdg asset_, Escrow escrow_, IMandateAccount.Limits memory limits)
        private
        returns (MandateAccount deployed)
    {
        deployed = new MandateAccount(principal, agent, address(asset_), address(escrow_), limits);
        asset_.mint(address(deployed), FUNDING);

        vm.startPrank(principal);
        deployed.setMerchant(merchant, true);
        deployed.setCapability(CAPABILITY, true);
        vm.stopPrank();
    }

    /// The threshold sits out of reach of the caps, so consent is not a term in any of these
    /// tests. The approval path is exercised where it belongs.
    function _baseLimits() private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: PER_CALL_CAP,
            dailyCap: DAILY_CAP,
            monthlyCap: MONTHLY_CAP,
            dailyWindow: DAILY_WINDOW,
            monthlyWindow: MONTHLY_WINDOW,
            approvalThreshold: type(uint128).max,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });
    }

    function _request(address merchant_, bytes32 capabilityId, uint128 amount)
        private
        view
        returns (IMandateAccount.SpendRequest memory)
    {
        return IMandateAccount.SpendRequest({
            merchant: merchant_,
            capabilityId: capabilityId,
            inputCommit: keccak256("input"),
            inputURI: "ipfs://input",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    function _noProof() private pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    /// forge-std compares bytes32 but not bytes4, and a selector padded the same way on both
    /// sides is still an exact comparison.
    function _assertReason(bytes4 actual, bytes4 expected, string memory note) private pure {
        assertEq(bytes32(actual), bytes32(expected), note);
    }

    function _limitsDigest(IMandateAccount.Limits memory limits, uint256 nonce, uint64 deadline)
        private
        view
        returns (bytes32)
    {
        bytes32 limitsHash = keccak256(
            abi.encode(
                account.LIMITS_TYPEHASH(),
                limits.perCallCap,
                limits.dailyCap,
                limits.monthlyCap,
                limits.dailyWindow,
                limits.monthlyWindow,
                limits.approvalThreshold,
                limits.validFrom,
                limits.validUntil,
                limits.classMask,
                limits.totalCap,
                limits.lane
            )
        );
        bytes32 structHash = keccak256(abi.encode(account.SET_LIMITS_TYPEHASH(), limitsHash, nonce, deadline));

        return keccak256(abi.encodePacked("\x19\x01", account.DOMAIN_SEPARATOR(), structHash));
    }

    function _signLimits(IMandateAccount.Limits memory limits, uint256 nonce, uint64 deadline)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRINCIPAL_KEY, _limitsDigest(limits, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }
}
