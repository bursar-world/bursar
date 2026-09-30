// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Escrow} from "../../src/Escrow.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {CommittedMandateAccount} from "../../src/privacy/CommittedMandateAccount.sol";
import {CommittedMandateFactory} from "../../src/privacy/CommittedMandateFactory.sol";
import {DisclosureRegistry} from "../../src/privacy/DisclosureRegistry.sol";

import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockReputation} from "../mocks/MockReputation.sol";

/// Accepts every proof: the stand-in for a proving key whose setup was compromised.
contract AcceptAllVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract DisputeStubV1 {
    uint256 private _next = 1;

    function openDispute(uint256) external returns (uint256) {
        return _next++;
    }
}

/// The v1 escrow's external surface as far as a committed account reaches it: `lock`, `getLock`,
/// `disputeBondBps`, a one-argument `openDispute` on the resolver, and the refund hook on timeout
/// and cancel. Ported from the v1 source (commit 611a447) without release, rulings or fees. It has
/// no `grantDisclosure`, `reopen` or pause, which is exactly what a v1-escrow account must not need.
contract EscrowV1Surface {
    using SafeERC20 for IERC20;

    error BadTtl();
    error BadStatus();
    error NotParty();
    error NotPayee();
    error TooEarly();

    event PayerCreditFailed(uint256 indexed id);

    address public immutable settlementAsset;
    address public immutable resolver;
    uint16 public constant disputeBondBps = 500;
    uint64 public constant minTtl = 5 minutes;
    uint64 public constant maxTtl = 7 days;

    uint256 public nextId = 1;
    mapping(uint256 => IEscrow.Lock) private _locks;

    constructor(address settlementAsset_, address resolver_) {
        settlementAsset = settlementAsset_;
        resolver = resolver_;
    }

    function lock(
        address payee,
        bytes32 capabilityId,
        bytes32 inputCommit,
        string calldata inputURI,
        uint128 amount,
        uint64 deadline
    ) external returns (uint256 id) {
        if (deadline <= block.timestamp + minTtl || deadline >= block.timestamp + maxTtl) {
            revert BadTtl();
        }
        id = nextId++;
        IEscrow.Lock storage entry = _locks[id];
        entry.payer = msg.sender;
        entry.payee = payee;
        entry.capabilityId = capabilityId;
        entry.inputCommit = inputCommit;
        entry.inputURI = inputURI;
        entry.amount = amount;
        entry.deadline = deadline;
        entry.status = IEscrow.LockStatus.Locked;
        IERC20(settlementAsset).safeTransferFrom(msg.sender, address(this), amount);
    }

    function dispute(uint256 id) external {
        IEscrow.Lock storage entry = _locks[id];
        if (entry.status != IEscrow.LockStatus.Locked) revert BadStatus();
        if (msg.sender != entry.payer && msg.sender != entry.payee) revert NotParty();
        entry.disputedAt = uint64(block.timestamp);
        entry.disputer = msg.sender;
        entry.status = IEscrow.LockStatus.Disputed;
        uint128 bond = uint128((uint256(entry.amount) * disputeBondBps) / 10_000);
        entry.bond = bond;
        IERC20(settlementAsset).safeTransferFrom(msg.sender, address(this), bond);
        DisputeStubV1(resolver).openDispute(id);
    }

    function timeout(uint256 id) external {
        IEscrow.Lock storage entry = _locks[id];
        if (entry.status != IEscrow.LockStatus.Locked) revert BadStatus();
        if (block.timestamp <= entry.deadline) revert TooEarly();
        entry.status = IEscrow.LockStatus.TimedOut;
        _refund(id, entry.payer, entry.amount);
    }

    function cancel(uint256 id) external {
        IEscrow.Lock storage entry = _locks[id];
        if (entry.status != IEscrow.LockStatus.Locked) revert BadStatus();
        if (msg.sender != entry.payee) revert NotPayee();
        entry.status = IEscrow.LockStatus.Cancelled;
        _refund(id, entry.payer, entry.amount);
    }

    function getLock(uint256 id) external view returns (IEscrow.Lock memory) {
        return _locks[id];
    }

    function _refund(uint256 id, address payer, uint128 amount) private {
        IERC20(settlementAsset).safeTransfer(payer, amount);
        (bool credited,) = payer.call{gas: 150_000}(abi.encodeWithSignature("creditSpend(uint256,uint128)", id, amount));
        if (!credited) emit PayerCreditFailed(id);
    }
}

/// The ceiling that bounds a committed account whatever its proofs say, and the factory that sets
/// it, including a factory on the v1 escrow. Every proof here is accepted: that is the point.
contract CommittedMandateCeilingTest is Test {
    uint256 internal constant CEILING = 25e6;
    address internal constant PAYEE = address(0xbeef01);

    MockUsdg internal asset;
    Escrow internal escrow;
    AcceptAllVerifier internal verifier;
    CommittedMandateFactory internal factory;

    address internal principal = address(0xA11CE);
    address internal agent = address(0xA6E47);
    uint256 internal nullifier;

    function setUp() public {
        asset = new MockUsdg();
        escrow = new Escrow(
            address(asset),
            address(new MockReputation()),
            address(0x7EA5),
            100,
            50,
            500,
            5 minutes,
            7 days,
            1 hours,
            2 days
        );
        verifier = new AcceptAllVerifier();
        factory = new CommittedMandateFactory(address(escrow), address(asset), address(verifier), CEILING);
    }

    function _create(CommittedMandateFactory on, bytes32 salt) internal returns (CommittedMandateAccount account) {
        vm.prank(principal);
        account = CommittedMandateAccount(on.create(principal, agent, salt, 1, 2, hex"c1f3"));
        asset.mint(address(account), 100e6);
    }

    /// A spend under a proof nobody checked, with a fresh nullifier each time.
    function _forged(CommittedMandateAccount account, uint256 amount) internal returns (uint256 id) {
        CommittedMandateAccount.Spend memory s = CommittedMandateAccount.Spend({
            payee: PAYEE,
            capabilityId: keccak256("hire:anything:1"),
            inputCommit: keccak256("input"),
            inputURI: "",
            amount: uint128(amount),
            deadline: uint64(block.timestamp + 1 days),
            provenAt: uint64(block.timestamp),
            newCounter: 0,
            nullifier: ++nullifier
        });
        CommittedMandateAccount.Proof memory p;
        vm.prank(agent);
        id = account.spend(s, p);
    }

    function _expectOverCeiling(CommittedMandateAccount account, uint256 amount) internal {
        uint256 lockedAfter = account.lockedTotal() + amount;
        vm.expectRevert(abi.encodeWithSelector(CommittedMandateAccount.OverCeiling.selector, lockedAfter, CEILING));
        _forged(account, amount);
    }

    function test_forgedProofsCannotLockPastTheCeiling() public {
        CommittedMandateAccount account = _create(factory, bytes32(uint256(1)));
        _forged(account, 10e6);
        _forged(account, 10e6);
        _forged(account, 5e6);
        assertEq(account.lockedTotal(), CEILING);
        assertEq(asset.balanceOf(address(escrow)), CEILING);

        _expectOverCeiling(account, 1);
        assertEq(account.nonce(), 3);
        assertEq(asset.balanceOf(address(account)), 100e6 - CEILING);
    }

    function test_oneForgedSpendCannotTakeMoreThanTheCeiling() public {
        CommittedMandateAccount account = _create(factory, bytes32(uint256(1)));
        _expectOverCeiling(account, CEILING + 1);
        assertEq(account.lockedTotal(), 0);
    }

    function test_refundsAndAmendmentsDoNotRefillTheCeiling() public {
        CommittedMandateAccount account = _create(factory, bytes32(uint256(1)));
        uint256 id = _forged(account, CEILING);

        vm.warp(block.timestamp + 1 days + 1);
        escrow.timeout(id);
        assertEq(asset.balanceOf(address(account)), 100e6);
        assertEq(account.lockedTotal(), CEILING);

        uint64 nonce = account.nonce();
        vm.prank(principal);
        account.amend(3, 4, nonce, hex"aa");
        assertEq(account.lockedTotal(), CEILING);
        _expectOverCeiling(account, 1);
    }

    function testFuzz_lockedTotalNeverPassesTheCeiling(uint64[6] memory amounts) public {
        CommittedMandateAccount account = _create(factory, bytes32(uint256(1)));
        uint256 locked;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, 2 * CEILING);
            if (locked + amount > CEILING) {
                _expectOverCeiling(account, amount);
                continue;
            }
            _forged(account, amount);
            locked += amount;
        }
        assertEq(account.lockedTotal(), locked);
        assertLe(account.lockedTotal(), CEILING);
    }

    function test_theFactoryGivesEveryAccountItsCeiling() public {
        bytes32 salt = bytes32(uint256(7));
        address predicted = factory.predict(principal, agent, salt, 1, 2);
        CommittedMandateAccount account = _create(factory, salt);
        assertEq(address(account), predicted);
        assertEq(account.ceiling(), CEILING);
        assertEq(account.factory(), address(factory));
        assertEq(factory.accountsOf(principal)[0], predicted);

        CommittedMandateFactory other =
            new CommittedMandateFactory(address(escrow), address(asset), address(verifier), 1e6);
        assertTrue(other.predict(principal, agent, salt, 1, 2) != predicted);
        assertEq(_create(other, salt).ceiling(), 1e6);
    }

    function test_theFactoryRefusesAZeroCeilingAndAnotherPrincipal() public {
        vm.expectRevert(CommittedMandateFactory.ZeroCeiling.selector);
        new CommittedMandateFactory(address(escrow), address(asset), address(verifier), 0);

        vm.expectRevert(CommittedMandateFactory.NotPrincipal.selector);
        factory.create(principal, agent, bytes32(uint256(8)), 1, 1, "");

        CommittedMandateAccount account = _create(factory, bytes32(uint256(8)));
        vm.expectRevert(CommittedMandateAccount.NotFactory.selector);
        account.sealInitial("x");
        assertEq(account.version(), 1);

        vm.prank(principal);
        vm.expectRevert(CommittedMandateFactory.AlreadyDeployed.selector);
        factory.create(principal, agent, bytes32(uint256(8)), 1, 2, hex"c1f3");
    }

    function test_aFactoryOnTheV1EscrowCreatesAccountsThatSettleThere() public {
        DisputeStubV1 resolver = new DisputeStubV1();
        EscrowV1Surface v1 = new EscrowV1Surface(address(asset), address(resolver));
        CommittedMandateFactory onV1 =
            new CommittedMandateFactory(address(v1), address(asset), address(verifier), CEILING);
        CommittedMandateAccount account = _create(onV1, bytes32(uint256(1)));
        assertEq(account.escrow(), address(v1));

        uint256 contested = _forged(account, 1e6);
        IEscrow.Lock memory entry = v1.getLock(contested);
        assertEq(entry.payer, address(account));
        assertEq(entry.payee, PAYEE);
        assertEq(entry.amount, 1e6);
        assertEq(entry.capabilityId, keccak256("hire:anything:1"));

        // A dispute posts the v1 bond from the account's balance.
        vm.prank(principal);
        account.disputeSpend(contested);
        assertEq(uint8(v1.getLock(contested).status), uint8(IEscrow.LockStatus.Disputed));
        assertEq(asset.balanceOf(address(account)), 100e6 - 1e6 - 50_000);

        // The principal grants disclosure through the registry, which reads the v1 lock layout.
        DisclosureRegistry disclosures = new DisclosureRegistry();
        vm.expectEmit(true, true, true, true, address(disclosures));
        emit DisclosureRegistry.DisclosureGranted(
            address(v1), contested, address(0x5E501), principal, bytes32(0), hex"01"
        );
        vm.prank(principal);
        disclosures.grant(address(v1), contested, address(0x5E501), bytes32(0), hex"01");

        // Refunds reach the account through the v1 hook, and leave the ceiling's count alone.
        uint256 declined = _forged(account, 2e6);
        vm.recordLogs();
        vm.prank(PAYEE);
        v1.cancel(declined);
        assertEq(vm.getRecordedLogs().length, 1, "only the refund transfer, no PayerCreditFailed");
        assertEq(asset.balanceOf(address(account)), 100e6 - 1e6 - 50_000);
        assertEq(account.lockedTotal(), 3e6);

        uint256 lapsed = _forged(account, 3e6);
        vm.warp(block.timestamp + 1 days + 1);
        v1.timeout(lapsed);
        assertEq(uint8(v1.getLock(lapsed).status), uint8(IEscrow.LockStatus.TimedOut));
        assertEq(account.lockedTotal(), 6e6);
    }
}
