// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Escrow} from "../src/Escrow.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {Staking} from "../src/token/Staking.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockBRSR} from "./mocks/MockBRSR.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// Drives the registry from the escrow seat without a live lock behind it, which is what lets
/// a test post a reward the tokens never backed or refuse a ruling on demand.
contract StubEscrow {
    address internal constant PAYER = address(0xA11CE);
    address internal constant PAYEE = address(0xB0B);

    OracleRegistry private immutable REGISTRY;
    IERC20 private immutable ASSET;

    uint256 public reopenCount;
    uint256 public lastReopenedId;

    uint256 public resolveCount;
    uint256 public lastEscrowId;
    uint16 public lastRefundBps;
    bool public refuseRulings;

    constructor(OracleRegistry registry_, IERC20 asset_) {
        REGISTRY = registry_;
        ASSET = asset_;
    }

    function open(uint256 escrowId) external returns (uint256) {
        return REGISTRY.openDispute(escrowId, PAYER, PAYEE);
    }

    /// The honest sequence: move the tokens, then name the figure.
    function postReward(uint256 disputeId, uint256 amount) external {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        ASSET.transfer(address(REGISTRY), amount);
        REGISTRY.notifyReward(disputeId, amount);
    }

    /// The dishonest one. Nothing arrives and the figure is large enough to drain the roster's
    /// bonds if the registry credited what it was told instead of what it holds.
    function postRewardWithoutPaying(uint256 disputeId, uint256 amount) external {
        REGISTRY.notifyReward(disputeId, amount);
    }

    function setRefuseRulings(bool refuse) external {
        refuseRulings = refuse;
    }

    function resolve(uint256 id, uint16 refundBps, uint8) external {
        if (refuseRulings) revert IEscrow.BadStatus();
        resolveCount += 1;
        lastEscrowId = id;
        lastRefundBps = refundBps;
    }

    function reopen(uint256 id) external {
        if (refuseRulings) revert IEscrow.BadStatus();
        reopenCount += 1;
        lastReopenedId = id;
    }
}

/// Opens disputes as a payer contract whose `principal()` answers with whoever sent the
/// transaction. Read on every vote, that named every resolver voting from its own key as the
/// payer's principal and barred it.
contract OriginPayer {
    function lock(Escrow escrow, MockUsdg asset, address payee, uint128 amount, uint64 deadline)
        external
        returns (uint256)
    {
        asset.approve(address(escrow), type(uint256).max);
        return escrow.lock(payee, keccak256("capability"), keccak256("input"), "ipfs://in", amount, deadline);
    }

    function dispute(Escrow escrow, uint256 id) external {
        escrow.dispute(id);
    }

    function principal() external view returns (address) {
        return tx.origin;
    }
}

/// A resolver seat bought by a party to the dispute, voting the way the party wants.
contract SybilResolver {
    bytes32 private constant SALT = keccak256("sybil");

    function register(OracleRegistry registry, MockBRSR bond, uint128 amount) external {
        bond.approve(address(registry), amount);
        registry.register(amount);
    }

    function commit(OracleRegistry registry, uint256 disputeId, uint8 score) external {
        registry.commitVote(disputeId, registry.commitmentHash(disputeId, address(this), score, SALT));
    }

    function reveal(OracleRegistry registry, uint256 disputeId, uint8 score) external {
        registry.revealVote(disputeId, score, SALT);
    }
}

contract OracleRegistryTest is Test {
    uint128 private constant MIN_BOND = 1_000e18;
    uint128 private constant BOND = 2_000e18;
    uint64 private constant COMMIT_WINDOW = 1 hours;
    uint64 private constant REVEAL_WINDOW = 1 hours;
    uint64 private constant UNBONDING_PERIOD = 7 days;
    uint8 private constant QUORUM = 3;
    /// The roster's size. Anything lower lets the first committers fill the panel.
    uint8 private constant MAX_VOTERS = 64;
    uint8 private constant MAX_DEVIATION = 10;
    uint16 private constant SLASH_BPS = 2_000;

    /// 20% of a 2,000 BRSR bond.
    uint128 private constant SLASH_TAKE = 400e18;

    bytes32 private constant SALT = keccak256("mandate.test.salt");
    bytes32 private constant SLASH_TOPIC = keccak256("ResolverSlashed(address,uint256,uint128)");

    /// Two assets, held apart. Bonds are BRSR and rewards are the settlement
    /// asset the escrow took its fee in, so nothing paid out of one can come from the other.
    MockBRSR private bond;
    MockUsdg private usdg;
    Staking private pool;
    OracleRegistry private registry;
    StubEscrow private stub;

    address private admin = makeAddr("admin");
    address private sink = makeAddr("slashSink");
    address private treasury = makeAddr("treasury");

    address private r1;
    address private r2;
    address private r3;
    address private r4;
    address private r5;
    address private r6;

    function setUp() public {
        vm.warp(1_700_000_000);

        bond = new MockBRSR();
        usdg = new MockUsdg();
        pool = new Staking(bond, usdg, admin, sink, treasury, 7 days, MIN_BOND);

        registry = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        stub = new StubEscrow(registry, IERC20(address(usdg)));
        registry.setEscrow(address(stub));
        registry.setStaking(address(pool));

        usdg.mint(address(stub), 1_000_000e6);

        r1 = _bond("r1", BOND);
        r2 = _bond("r2", BOND);
        r3 = _bond("r3", BOND);
        r4 = _bond("r4", BOND);
        r5 = _bond("r5", BOND);
        r6 = _bond("r6", BOND);
    }

    function test_constructor_rejectsZeroSlashBpsSoSlashingIsNeverANoOp() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.slashBps = 0;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_setConfig_rejectsZeroSlashBpsAfterDeploymentToo() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.slashBps = 0;

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        registry.setConfig(cfg);
    }

    function test_constructor_acceptsTheSmallestNonZeroSlash() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.slashBps = 1;

        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, cfg);
        assertEq(fresh.config().slashBps, 1);
    }

    function test_constructor_rejectsASlashAboveTheWholeBond() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.slashBps = 10_001;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_acceptsASlashOfTheWholeBond() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.slashBps = 10_000;

        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, cfg);
        assertEq(fresh.config().slashBps, 10_000);
    }

    function test_constructor_rejectsAZeroLengthCommitWindow() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.commitWindow = 0;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_rejectsAZeroLengthRevealWindow() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.revealWindow = 0;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_rejectsAQuorumOfZero() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.quorum = 0;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_rejectsAQuorumNoRosterCouldReach() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.quorum = 65;
        cfg.maxVoters = 255;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_acceptsAQuorumOfTheWholeRoster() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.quorum = 64;

        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, cfg);
        assertEq(fresh.config().quorum, 64);
    }

    /// A cap below the roster is a panel whoever commits first can fill, and the resolvers it
    /// shuts out are then slashed or outvoted by the ones that got in.
    function test_constructor_rejectsAVoterCapBelowTheRosterSize() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.maxVoters = 63;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        registry.setConfig(cfg);
    }

    function test_constructor_acceptsAVoterCapAtOrAboveTheRosterSize() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.maxVoters = 64;
        assertEq(new OracleRegistry(address(usdg), admin, sink, cfg).config().maxVoters, 64);

        // The roster already bounds the panel, so a larger figure changes nothing.
        cfg.maxVoters = 255;
        assertEq(new OracleRegistry(address(usdg), admin, sink, cfg).config().maxVoters, 255);
    }

    function test_constructor_rejectsAWindowShorterThanTenMinutes() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.commitWindow = 10 minutes - 1;
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);

        cfg.commitWindow = 10 minutes;
        cfg.revealWindow = 10 minutes - 1;
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        registry.setConfig(cfg);

        cfg.revealWindow = 10 minutes;
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, cfg);
        assertEq(fresh.config().commitWindow, 10 minutes);
        assertEq(fresh.config().revealWindow, 10 minutes);
    }

    function test_constructor_rejectsADeviationBandWiderThanTheScoreRange() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.maxDeviation = 101;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_rejectsACooldownShorterThanOneVote() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.unbondingPeriod = COMMIT_WINDOW + REVEAL_WINDOW - 1;

        vm.expectRevert(IOracleRegistry.BadConfig.selector);
        new OracleRegistry(address(usdg), admin, sink, cfg);
    }

    function test_constructor_acceptsACooldownExactlyOneVoteLong() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.unbondingPeriod = COMMIT_WINDOW + REVEAL_WINDOW;

        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, cfg);
        assertEq(fresh.config().unbondingPeriod, COMMIT_WINDOW + REVEAL_WINDOW);
    }

    function test_constructor_rejectsAZeroAssetAdminOrSink() public {
        IOracleRegistry.Config memory cfg = _defaultConfig();

        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        new OracleRegistry(address(0), admin, sink, cfg);

        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        new OracleRegistry(address(usdg), address(0), sink, cfg);

        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        new OracleRegistry(address(usdg), admin, address(0), cfg);
    }

    function test_constructor_recordsTheDeployerAndTheOpeningState() public view {
        assertEq(registry.deployer(), address(this));
        assertEq(registry.admin(), admin);
        assertEq(registry.slashSink(), sink);
        assertEq(registry.settlementAsset(), address(usdg));
        assertEq(registry.nextDisputeId(), 1);
        assertEq(registry.scoreMax(), 100);
    }

    function test_onlyTheAdminCanRewriteTheConfig() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotAdmin.selector);
        registry.setConfig(_defaultConfig());
    }

    function test_setConfig_leavesALiveDisputeOnItsOriginalClock() public {
        uint256 disputeId = _openDispute();
        IOracleRegistry.Dispute memory before = registry.getDispute(disputeId);

        IOracleRegistry.Config memory cfg = _defaultConfig();
        cfg.commitWindow = 10 days;
        cfg.revealWindow = 10 days;
        cfg.unbondingPeriod = 120 days;
        vm.prank(admin);
        registry.setConfig(cfg);

        IOracleRegistry.Dispute memory live = registry.getDispute(disputeId);
        assertEq(live.commitEndsAt, before.commitEndsAt);
        assertEq(live.revealEndsAt, before.revealEndsAt);
    }

    function test_register_pullsTheBondAndSeatsTheResolver() public {
        address who = makeAddr("newcomer");
        bond.mint(who, BOND);

        uint128 bondedBefore = registry.totalBonded();
        uint256 rosterBefore = registry.resolverCount();

        vm.startPrank(who);
        bond.approve(address(registry), BOND);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.ResolverRegistered(who, BOND);
        registry.register(BOND);
        vm.stopPrank();

        IOracleRegistry.Resolver memory record = registry.getResolver(who);
        assertEq(uint8(record.status), uint8(IOracleRegistry.ResolverStatus.Active));
        assertEq(record.bond, BOND);
        assertEq(registry.totalBonded(), bondedBefore + BOND);
        assertEq(registry.resolverCount(), rosterBefore + 1);
        assertEq(bond.balanceOf(who), 0);
    }

    function test_register_rejectsABondBelowTheFloorTheStakingPoolSets() public {
        address who = makeAddr("underfunded");
        bond.mint(who, MIN_BOND);

        vm.startPrank(who);
        bond.approve(address(registry), MIN_BOND);
        vm.expectRevert(
            abi.encodeWithSelector(IOracleRegistry.BondNotAccepted.selector, MIN_BOND - 1, uint256(MIN_BOND))
        );
        registry.register(MIN_BOND - 1);
        vm.stopPrank();
    }

    /// The floor is governance's answer to a bond whose token has fallen, and it binds the
    /// moment it changes, not on the next registration.
    function test_register_followsTheFloorWhenGovernanceRaisesIt() public {
        address who = makeAddr("latecomer");
        bond.mint(who, BOND);

        vm.prank(admin);
        pool.setMinBond(BOND + 1);

        vm.startPrank(who);
        bond.approve(address(registry), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IOracleRegistry.BondNotAccepted.selector, BOND, uint256(BOND) + 1));
        registry.register(BOND);
        vm.stopPrank();
    }

    /// A resolver already seated keeps its bond and loses its vote, which is the whole of the
    /// mitigation for a bond denominated in something that moves.
    function test_commitVote_benchesAResolverThatFallsBelowARaisedFloor() public {
        uint256 disputeId = _openDispute();

        vm.prank(admin);
        pool.setBondFloor(r1, BOND + 1);

        bytes32 commitment = registry.commitmentHash(disputeId, r1, 40, SALT);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BondTooSmall.selector);
        registry.commitVote(disputeId, commitment);

        assertEq(registry.getResolver(r1).bond, BOND, "benching a resolver must not touch its bond");

        // Topping up to the new floor puts it back in the room.
        bond.mint(r1, 1e18);
        vm.startPrank(r1);
        bond.approve(address(registry), 1e18);
        registry.increaseBond(1e18);
        vm.stopPrank();

        _commit(r1, disputeId, 40, SALT);
        assertEq(registry.getDispute(disputeId).commitCount, 1);
    }

    /// A resolver governance has barred is refused whatever it posts, and it cannot get back in
    /// by topping up one instalment at a time either.
    function test_register_refusesAResolverGovernanceHasBarred() public {
        address who = makeAddr("barred");
        bond.mint(who, BOND * 10);

        vm.prank(admin);
        pool.setBondingDenied(who, true);

        vm.startPrank(who);
        bond.approve(address(registry), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IOracleRegistry.BondNotAccepted.selector, BOND * 10, uint256(MIN_BOND)));
        registry.register(BOND * 10);
        vm.stopPrank();

        vm.prank(admin);
        pool.setBondingDenied(r1, true);
        bond.mint(r1, 1e18);
        vm.startPrank(r1);
        bond.approve(address(registry), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(IOracleRegistry.BondNotAccepted.selector, BOND + 1e18, uint256(MIN_BOND))
        );
        registry.increaseBond(1e18);
        vm.stopPrank();
    }

    /// Bonds are BRSR and rewards are the settlement asset. The registry never holds the two in
    /// one balance, so a mistake in the reward path has no bond to reach.
    function test_theBondAssetIsBrsrAndTheRewardAssetIsTheSettlementAsset() public view {
        assertEq(address(registry.bondAsset()), address(bond));
        assertEq(address(registry.staking()), address(pool));
        assertEq(registry.settlementAsset(), address(usdg));

        assertEq(bond.balanceOf(address(registry)), uint256(registry.totalBonded()));
        assertEq(usdg.balanceOf(address(registry)), registry.rewardFloat());
    }

    /// Until the token set is deployed there is no pool to price a bond, and the registry says
    /// so instead of accepting one in the wrong currency.
    function test_bondingIsClosedUntilTheStakingPoolIsNamed() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        address who = makeAddr("early");
        bond.mint(who, BOND);

        vm.startPrank(who);
        bond.approve(address(fresh), BOND);
        vm.expectRevert(IOracleRegistry.StakingNotSet.selector);
        fresh.register(BOND);
        vm.stopPrank();

        fresh.setStaking(address(pool));

        vm.prank(who);
        fresh.register(BOND);
        assertEq(fresh.getResolver(who).bond, BOND);
    }

    function test_onlyTheDeployerNamesTheStakingPoolAndOnlyOnce() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.NotDeployer.selector);
        fresh.setStaking(address(pool));

        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        fresh.setStaking(address(0));

        vm.expectEmit(true, true, false, false, address(fresh));
        emit IOracleRegistry.StakingSet(address(pool), address(bond));
        fresh.setStaking(address(pool));

        vm.expectRevert(IOracleRegistry.AlreadySet.selector);
        fresh.setStaking(address(pool));
    }

    /// One token in both roles would put bonds and rewards in one balance, and a pool paying a
    /// different reward asset would mean two halves of one deployment settling in different
    /// money.
    function test_setStaking_refusesAPoolThatDisagreesAboutTheAssets() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());

        MockBRSR other = new MockBRSR();
        Staking wrongBondAsset = new Staking(usdg, other, admin, sink, treasury, 7 days, MIN_BOND);
        vm.expectRevert(
            abi.encodeWithSelector(IOracleRegistry.StakingAssetMismatch.selector, address(usdg), address(usdg))
        );
        fresh.setStaking(address(wrongBondAsset));

        MockUsdg otherReward = new MockUsdg();
        Staking wrongRewardAsset = new Staking(bond, otherReward, admin, sink, treasury, 7 days, MIN_BOND);
        vm.expectRevert(
            abi.encodeWithSelector(IOracleRegistry.StakingAssetMismatch.selector, address(otherReward), address(usdg))
        );
        fresh.setStaking(address(wrongRewardAsset));
    }

    function test_register_acceptsABondExactlyAtTheFloor() public {
        address who = makeAddr("exact");
        bond.mint(who, MIN_BOND);

        vm.startPrank(who);
        bond.approve(address(registry), MIN_BOND);
        registry.register(MIN_BOND);
        vm.stopPrank();

        assertEq(registry.getResolver(who).bond, MIN_BOND);
    }

    function test_register_rejectsAZeroBond() public {
        address who = makeAddr("freeloader");

        vm.prank(who);
        vm.expectRevert(IOracleRegistry.ZeroAmount.selector);
        registry.register(0);
    }

    function test_register_rejectsASecondRegistrationWhileActive() public {
        bond.mint(r1, BOND);

        vm.startPrank(r1);
        bond.approve(address(registry), BOND);
        vm.expectRevert(IOracleRegistry.AlreadyRegistered.selector);
        registry.register(BOND);
        vm.stopPrank();
    }

    function test_register_rejectsARegistrationWhileUnbonding() public {
        vm.prank(r1);
        registry.requestUnbond();

        bond.mint(r1, BOND);
        vm.startPrank(r1);
        bond.approve(address(registry), BOND);
        vm.expectRevert(IOracleRegistry.AlreadyRegistered.selector);
        registry.register(BOND);
        vm.stopPrank();
    }

    function test_register_creditsOnlyWhatTheTokenDelivered() public {
        FeeOnTransferERC20 lossy = new FeeOnTransferERC20();
        OracleRegistry lossyRegistry = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        lossyRegistry.setStaking(address(new Staking(lossy, usdg, admin, sink, treasury, 7 days, MIN_BOND)));

        address who = makeAddr("lossy-resolver");
        uint128 named = 1_100e18;
        uint128 delivered = named - named / 100;
        lossy.mint(who, named);

        vm.startPrank(who);
        lossy.approve(address(lossyRegistry), named);
        lossyRegistry.register(named);
        vm.stopPrank();

        assertEq(lossyRegistry.getResolver(who).bond, delivered);
        assertEq(lossyRegistry.totalBonded(), delivered);
        assertEq(lossy.balanceOf(address(lossyRegistry)), delivered);
    }

    function test_register_rejectsABondThatFallsUnderTheFloorInTransit() public {
        FeeOnTransferERC20 lossy = new FeeOnTransferERC20();
        OracleRegistry lossyRegistry = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        lossyRegistry.setStaking(address(new Staking(lossy, usdg, admin, sink, treasury, 7 days, MIN_BOND)));

        address who = makeAddr("almost-enough");
        lossy.mint(who, MIN_BOND);

        vm.startPrank(who);
        lossy.approve(address(lossyRegistry), MIN_BOND);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOracleRegistry.BondNotAccepted.selector, MIN_BOND - MIN_BOND / 100, uint256(MIN_BOND)
            )
        );
        lossyRegistry.register(MIN_BOND);
        vm.stopPrank();
    }

    function test_register_rejectsTheSixtyFifthResolver() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        fresh.setStaking(address(pool));

        for (uint256 i; i < 64; ++i) {
            address who = makeAddr(string.concat("bulk", vm.toString(i)));
            bond.mint(who, MIN_BOND);
            vm.startPrank(who);
            bond.approve(address(fresh), MIN_BOND);
            fresh.register(MIN_BOND);
            vm.stopPrank();
        }
        assertEq(fresh.resolverCount(), 64);

        address surplus = makeAddr("surplus");
        bond.mint(surplus, MIN_BOND);
        vm.startPrank(surplus);
        bond.approve(address(fresh), MIN_BOND);
        vm.expectRevert(IOracleRegistry.RosterFull.selector);
        fresh.register(MIN_BOND);
        vm.stopPrank();
    }

    function test_increaseBond_addsToTheExistingBond() public {
        bond.mint(r1, 500e18);

        vm.startPrank(r1);
        bond.approve(address(registry), 500e18);
        registry.increaseBond(500e18);
        vm.stopPrank();

        assertEq(registry.getResolver(r1).bond, BOND + 500e18);
    }

    function test_increaseBond_rejectsAnUnregisteredCaller() public {
        address who = makeAddr("stranger");

        vm.prank(who);
        vm.expectRevert(IOracleRegistry.NotRegistered.selector);
        registry.increaseBond(1e18);
    }

    function test_increaseBond_rejectsAResolverThatIsOnItsWayOut() public {
        vm.prank(r1);
        registry.requestUnbond();

        bond.mint(r1, 1e18);
        vm.startPrank(r1);
        bond.approve(address(registry), 1e18);
        vm.expectRevert(IOracleRegistry.NotActive.selector);
        registry.increaseBond(1e18);
        vm.stopPrank();
    }

    function test_increaseBond_rejectsAZeroTopUp() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.ZeroAmount.selector);
        registry.increaseBond(0);
    }

    function test_requestUnbond_benchesTheResolverWithoutTouchingTheBond() public {
        vm.prank(r1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.UnbondRequested(r1, uint64(block.timestamp) + UNBONDING_PERIOD);
        registry.requestUnbond();

        IOracleRegistry.Resolver memory record = registry.getResolver(r1);
        assertEq(uint8(record.status), uint8(IOracleRegistry.ResolverStatus.Unbonding));
        assertEq(record.bond, BOND);
        assertEq(record.unbondingAt, uint64(block.timestamp));
        assertEq(registry.totalBonded(), BOND * 6);
    }

    function test_requestUnbond_rejectsASecondRequest() public {
        vm.startPrank(r1);
        registry.requestUnbond();
        vm.expectRevert(IOracleRegistry.UnbondAlreadyRequested.selector);
        registry.requestUnbond();
        vm.stopPrank();
    }

    function test_requestUnbond_rejectsAnUnregisteredCaller() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IOracleRegistry.NotRegistered.selector);
        registry.requestUnbond();
    }

    function test_completeUnbond_rejectsAResolverThatNeverAskedToLeave() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.UnbondNotRequested.selector);
        registry.completeUnbond();
    }

    function test_completeUnbond_rejectsTheSecondBeforeTheCooldownMatures() public {
        vm.prank(r1);
        registry.requestUnbond();

        vm.warp(block.timestamp + UNBONDING_PERIOD - 1);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.UnbondNotMatured.selector);
        registry.completeUnbond();
    }

    function test_completeUnbond_paysOutExactlyWhenTheCooldownMatures() public {
        uint256 requestedAt = block.timestamp;

        vm.prank(r1);
        registry.requestUnbond();

        vm.warp(requestedAt + UNBONDING_PERIOD);
        vm.prank(r1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.UnbondCompleted(r1, BOND);
        registry.completeUnbond();

        IOracleRegistry.Resolver memory record = registry.getResolver(r1);
        assertEq(uint8(record.status), uint8(IOracleRegistry.ResolverStatus.Exited));
        assertEq(record.bond, 0);
        assertEq(bond.balanceOf(r1), BOND);
        assertEq(registry.totalBonded(), BOND * 5);
        assertEq(registry.resolverCount(), 5);
    }

    function test_completeUnbond_refusesWhileABondStillBacksALiveVote() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.prank(r1);
        registry.requestUnbond();
        assertEq(registry.openVotes(r1), 1);

        vm.warp(block.timestamp + UNBONDING_PERIOD);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BondLocked.selector);
        registry.completeUnbond();

        registry.failDispute(disputeId);
        assertEq(registry.openVotes(r1), 0);

        vm.prank(r1);
        registry.completeUnbond();
        assertEq(uint8(registry.getResolver(r1).status), uint8(IOracleRegistry.ResolverStatus.Exited));
    }

    function test_cancelUnbond_returnsTheResolverToActive() public {
        vm.startPrank(r1);
        registry.requestUnbond();
        vm.expectEmit(true, false, false, false, address(registry));
        emit IOracleRegistry.UnbondCancelled(r1);
        registry.cancelUnbond();
        vm.stopPrank();

        IOracleRegistry.Resolver memory record = registry.getResolver(r1);
        assertEq(uint8(record.status), uint8(IOracleRegistry.ResolverStatus.Active));
        assertEq(record.unbondingAt, 0);
        assertEq(record.bond, BOND);
    }

    function test_cancelUnbond_rejectsAnActiveResolver() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.UnbondNotRequested.selector);
        registry.cancelUnbond();
    }

    function test_register_keepsTheSlashHistoryOfAResolverThatLeftAndCameBack() public {
        vm.prank(admin);
        registry.slash(r1, 100e18);
        assertEq(registry.getResolver(r1).slashes, 1);

        vm.prank(r1);
        registry.requestUnbond();
        vm.warp(block.timestamp + UNBONDING_PERIOD);
        vm.prank(r1);
        registry.completeUnbond();

        bond.mint(r1, BOND);
        vm.startPrank(r1);
        bond.approve(address(registry), BOND);
        registry.register(BOND);
        vm.stopPrank();

        IOracleRegistry.Resolver memory record = registry.getResolver(r1);
        assertEq(uint8(record.status), uint8(IOracleRegistry.ResolverStatus.Active));
        assertEq(record.bond, BOND);
        assertEq(record.slashes, 1);
    }

    function test_onlyTheEscrowCanOpenADispute() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotEscrow.selector);
        registry.openDispute(1, address(0xA11CE), address(0xB0B));
    }

    function test_openDispute_numbersFromOneAndSetsBothWindows() public {
        uint256 openedAt = block.timestamp;

        vm.expectEmit(true, true, false, true, address(registry));
        // forge-lint: disable-next-line(unsafe-typecast)
        emit IOracleRegistry.DisputeOpened(1, 77, uint64(openedAt) + COMMIT_WINDOW);
        uint256 disputeId = stub.open(77);

        assertEq(disputeId, 1);
        assertEq(registry.nextDisputeId(), 2);
        assertEq(registry.disputeIdOf(77), 1);

        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        assertEq(dispute.escrowId, 77);
        assertEq(dispute.openedAt, openedAt);
        assertEq(dispute.commitEndsAt, openedAt + COMMIT_WINDOW);
        assertEq(dispute.revealEndsAt, openedAt + COMMIT_WINDOW + REVEAL_WINDOW);
        assertEq(uint8(dispute.status), uint8(IOracleRegistry.DisputeStatus.Committing));
    }

    function test_openDispute_rejectsASecondDisputeOnTheSameLock() public {
        stub.open(77);

        vm.expectRevert(IOracleRegistry.DisputeAlreadyOpen.selector);
        stub.open(77);
    }

    function test_commitVote_recordsTheCommitmentAndHoldsTheBond() public {
        uint256 disputeId = _openDispute();
        bytes32 commitment = registry.commitmentHash(disputeId, r1, 40, SALT);

        vm.prank(r1);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IOracleRegistry.VoteCommitted(disputeId, r1, 1);
        registry.commitVote(disputeId, commitment);

        assertEq(registry.committedBy(disputeId, r1), commitment);
        assertEq(registry.openVotes(r1), 1);
        assertEq(registry.getDispute(disputeId).commitCount, 1);
        assertEq(registry.voters(disputeId).length, 1);
        assertEq(registry.voters(disputeId)[0], r1);
    }

    function test_commitVote_rejectsAZeroCommitment() public {
        uint256 disputeId = _openDispute();

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NoCommitment.selector);
        registry.commitVote(disputeId, bytes32(0));
    }

    function test_commitVote_rejectsAnUnbondedCaller() public {
        uint256 disputeId = _openDispute();

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IOracleRegistry.NotRegistered.selector);
        registry.commitVote(disputeId, keccak256("x"));
    }

    function test_commitVote_rejectsAResolverOnItsWayOut() public {
        uint256 disputeId = _openDispute();

        vm.prank(r1);
        registry.requestUnbond();

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotActive.selector);
        registry.commitVote(disputeId, keccak256("x"));
    }

    function test_commitVote_benchesAResolverWhoseBondWasThinnedBelowTheMinimum() public {
        vm.prank(admin);
        registry.slash(r1, BOND - MIN_BOND + 1);
        assertLt(registry.getResolver(r1).bond, MIN_BOND);

        uint256 disputeId = _openDispute();

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BondTooSmall.selector);
        registry.commitVote(disputeId, keccak256("x"));
    }

    function test_commitVote_rejectsAnUnknownDispute() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.DisputeNotFound.selector);
        registry.commitVote(999, keccak256("x"));
    }

    function test_commitVote_rejectsASecondCommitmentFromTheSameResolver() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        bytes32 replacement = registry.commitmentHash(disputeId, r1, 90, SALT);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.AlreadyCommitted.selector);
        registry.commitVote(disputeId, replacement);
    }

    function test_commitVote_acceptsACommitOneSecondBeforeTheWindowCloses() public {
        uint256 disputeId = _openDispute();

        vm.warp(registry.getDispute(disputeId).commitEndsAt - 1);
        _commit(r1, disputeId, 40, SALT);

        assertEq(registry.getDispute(disputeId).commitCount, 1);
    }

    function test_commitVote_rejectsACommitAtTheInstantTheWindowCloses() public {
        uint256 disputeId = _openDispute();

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.CommitWindowClosed.selector);
        registry.commitVote(disputeId, keccak256("x"));
    }

    /// A full roster, every seat voting on one dispute. Nobody is turned away however late it
    /// commits, and the finalisation that walks all sixty-four votes stays well inside a block.
    function test_commitVote_admitsEverySeatOnTheRoster() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());
        StubEscrow seat = new StubEscrow(fresh, IERC20(address(usdg)));
        fresh.setEscrow(address(seat));
        fresh.setStaking(address(pool));

        address[] memory roster = new address[](64);
        for (uint256 i; i < roster.length; ++i) {
            roster[i] = makeAddr(string.concat("seat", vm.toString(i)));
            bond.mint(roster[i], MIN_BOND);
            vm.startPrank(roster[i]);
            bond.approve(address(fresh), MIN_BOND);
            fresh.register(MIN_BOND);
            vm.stopPrank();
        }

        uint256 disputeId = seat.open(1);
        for (uint256 i; i < roster.length; ++i) {
            bytes32 commitment = fresh.commitmentHash(disputeId, roster[i], 40, SALT);
            vm.prank(roster[i]);
            fresh.commitVote(disputeId, commitment);
        }
        assertEq(fresh.getDispute(disputeId).commitCount, 64, "a seated resolver was turned away");

        vm.warp(fresh.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < roster.length; ++i) {
            vm.prank(roster[i]);
            fresh.revealVote(disputeId, 40, SALT);
        }

        uint256 before = gasleft();
        fresh.finalize(disputeId);
        uint256 used = before - gasleft();

        assertEq(fresh.getDispute(disputeId).rewardShares, 64);
        assertLt(used, 8_000_000, "the widest vote no longer fits comfortably in a block");
    }

    function test_commitVote_commitmentBindsTheVoterSoAnotherResolverCannotReplayIt() public {
        uint256 disputeId = _openDispute();

        // A commitment that omitted the voter would be a pure function of (disputeId, score,
        // salt), so r2 could lift r1's preimage out of the mempool, commit the identical hash
        // and reveal it. Binding the voter means r2's copy can never open.
        bytes32 stolen = registry.commitmentHash(disputeId, r1, 40, SALT);

        vm.prank(r1);
        registry.commitVote(disputeId, stolen);
        vm.prank(r2);
        registry.commitVote(disputeId, stolen);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r2);
        vm.expectRevert(IOracleRegistry.BadReveal.selector);
        registry.revealVote(disputeId, 40, SALT);

        vm.prank(r1);
        registry.revealVote(disputeId, 40, SALT);

        (bool revealed, uint8 score) = registry.revealedBy(disputeId, r1);
        assertTrue(revealed);
        assertEq(score, 40);
        (bool copied,) = registry.revealedBy(disputeId, r2);
        assertFalse(copied);
    }

    function test_commitmentHash_bindsAllFourFields() public view {
        bytes32 base = registry.commitmentHash(1, r1, 40, SALT);

        assertTrue(base != registry.commitmentHash(2, r1, 40, SALT), "dispute id is not bound");
        assertTrue(base != registry.commitmentHash(1, r2, 40, SALT), "voter is not bound");
        assertTrue(base != registry.commitmentHash(1, r1, 41, SALT), "score is not bound");
        assertTrue(base != registry.commitmentHash(1, r1, 40, keccak256("other")), "salt is not bound");
    }

    function testFuzz_commitmentHash_neverCollidesAcrossVoters(
        uint256 disputeId,
        address a,
        address b,
        uint8 score,
        bytes32 salt
    ) public view {
        vm.assume(a != b);
        assertTrue(
            registry.commitmentHash(disputeId, a, score, salt) != registry.commitmentHash(disputeId, b, score, salt)
        );
    }

    function test_revealVote_rejectsAScoreAboveTheMaximum() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 100, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BadScore.selector);
        registry.revealVote(disputeId, 101, SALT);
    }

    function test_revealVote_acceptsTheTopOfTheScoreRange() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 100, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        _reveal(r1, disputeId, 100, SALT);

        (, uint8 score) = registry.revealedBy(disputeId, r1);
        assertEq(score, 100);
    }

    function test_revealVote_rejectsARevealWhileTheCommitWindowIsStillOpen() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt - 1);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.CommitWindowOpen.selector);
        registry.revealVote(disputeId, 40, SALT);
    }

    function test_revealVote_opensAtTheInstantTheCommitWindowCloses() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        vm.prank(r1);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IOracleRegistry.VoteRevealed(disputeId, r1, 40);
        registry.revealVote(disputeId, 40, SALT);

        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        assertEq(dispute.revealCount, 1);
        assertEq(uint8(dispute.status), uint8(IOracleRegistry.DisputeStatus.Revealing));
    }

    function test_revealVote_acceptsARevealOneSecondBeforeTheWindowCloses() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt - 1);
        _reveal(r1, disputeId, 40, SALT);

        assertEq(registry.getDispute(disputeId).revealCount, 1);
    }

    function test_revealVote_rejectsARevealAtTheInstantTheWindowCloses() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.RevealWindowClosed.selector);
        registry.revealVote(disputeId, 40, SALT);
    }

    function test_revealVote_rejectsAResolverThatNeverCommitted() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r2);
        vm.expectRevert(IOracleRegistry.NoCommitment.selector);
        registry.revealVote(disputeId, 40, SALT);
    }

    function test_revealVote_rejectsASecondReveal() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.AlreadyRevealed.selector);
        registry.revealVote(disputeId, 40, SALT);
    }

    function test_revealVote_rejectsADifferentScoreUnderTheSameSalt() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BadReveal.selector);
        registry.revealVote(disputeId, 41, SALT);
    }

    function test_revealVote_rejectsTheRightScoreUnderTheWrongSalt() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BadReveal.selector);
        registry.revealVote(disputeId, 40, keccak256("wrong"));
    }

    function test_revealVote_rejectsACommitmentBorrowedFromAnotherDispute() public {
        uint256 first = _openDispute();
        uint256 second = _openDispute();

        bytes32 borrowed = registry.commitmentHash(first, r1, 40, SALT);

        vm.prank(r1);
        registry.commitVote(second, borrowed);

        vm.warp(registry.getDispute(second).commitEndsAt);
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BadReveal.selector);
        registry.revealVote(second, 40, SALT);
    }

    function test_finalize_takesTheMiddleOfThreeRevealedScoresAndRulesOnTheEscrow() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 45, SALT);
        _commit(r3, disputeId, 42, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 45, SALT);
        _reveal(r3, disputeId, 42, SALT);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.DisputeFinalized(disputeId, 42, 10_000, 3);
        registry.finalize(disputeId);

        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        assertEq(dispute.medianScore, 42);
        assertEq(dispute.refundBps, 10_000);
        assertEq(dispute.rewardShares, 3);
        assertEq(uint8(dispute.status), uint8(IOracleRegistry.DisputeStatus.Finalized));

        assertEq(stub.resolveCount(), 1);
        assertEq(stub.lastEscrowId(), dispute.escrowId);
        assertEq(stub.lastRefundBps(), 10_000);
    }

    function test_finalize_takesTheMeanOfTheTwoMiddleScoresOnAnEvenVote() public {
        uint256 disputeId = _openDispute();
        _commitAll4(disputeId, 40, 50, 60, 70);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _revealAll4(disputeId, 40, 50, 60, 70);

        registry.finalize(disputeId);

        // (50 + 60) / 2, truncated, which lands the tie on the payer's side of the tiers.
        assertEq(registry.getDispute(disputeId).medianScore, 55);
        assertEq(registry.getDispute(disputeId).refundBps, 7_500);
    }

    function test_finalize_leavesAScoreExactlyAtTheDeviationBandUnslashed() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 50, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);
        _reveal(r3, disputeId, 50, SALT);

        registry.finalize(disputeId);

        assertEq(registry.getDispute(disputeId).medianScore, 40);
        assertEq(registry.getResolver(r3).bond, BOND, "a score exactly at the band was slashed");
        assertEq(registry.getResolver(r3).slashes, 0);
        assertEq(registry.getResolver(r3).finalized, 1);
        assertEq(registry.getDispute(disputeId).rewardShares, 3);
        assertEq(bond.balanceOf(sink), 0);
    }

    function test_finalize_slashesAScoreOnePointOutsideTheDeviationBand() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 51, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);
        _reveal(r3, disputeId, 51, SALT);

        vm.expectEmit(true, true, false, true, address(registry));
        emit IOracleRegistry.ResolverSlashed(r3, disputeId, SLASH_TAKE);
        registry.finalize(disputeId);

        assertEq(registry.getResolver(r3).bond, BOND - SLASH_TAKE);
        assertEq(registry.getResolver(r3).slashes, 1);
        assertEq(registry.getResolver(r3).finalized, 0);
        assertEq(bond.balanceOf(sink), SLASH_TAKE);
        assertEq(registry.totalBonded(), BOND * 6 - SLASH_TAKE);
        assertEq(registry.getDispute(disputeId).rewardShares, 2);
        assertFalse(registry.rewardedBy(disputeId, r3));
    }

    function test_finalize_treatsAMajorityOutsideTheBandAsAVoteWithNoCentre() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 0, SALT);
        _commit(r2, disputeId, 50, SALT);
        _commit(r3, disputeId, 100, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 0, SALT);
        _reveal(r2, disputeId, 50, SALT);
        _reveal(r3, disputeId, 100, SALT);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.DisputeFailed(disputeId, IOracleRegistry.QuorumSuspect.selector);
        registry.finalize(disputeId);

        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        assertEq(uint8(dispute.status), uint8(IOracleRegistry.DisputeStatus.Failed));
        assertEq(dispute.refundBps, 10_000, "a vote with no centre must refund the payer");
        assertEq(dispute.rewardShares, 0);
        assertEq(stub.lastRefundBps(), 10_000);

        // Nobody is slashed: the contract cannot tell which half was honest, so it charges
        // neither and makes the payer whole instead.
        assertEq(registry.totalBonded(), BOND * 6);
        assertEq(bond.balanceOf(sink), 0);
        assertEq(registry.getResolver(r1).slashes, 0);
        assertEq(registry.getResolver(r3).slashes, 0);
    }

    function test_finalize_treatsAnExactlyEvenSplitAsAResultRatherThanNoise() public {
        uint256 disputeId = _openDispute();
        _commitAll4(disputeId, 40, 50, 60, 70);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _revealAll4(disputeId, 40, 50, 60, 70);

        registry.finalize(disputeId);

        // Two of four sit outside the band. Half is not a majority, so the median stands.
        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        assertEq(uint8(dispute.status), uint8(IOracleRegistry.DisputeStatus.Finalized));
        assertEq(dispute.rewardShares, 2);
        assertEq(registry.getResolver(r1).slashes, 1);
        assertEq(registry.getResolver(r4).slashes, 1);
        assertEq(registry.getResolver(r2).slashes, 0);
        assertEq(registry.getResolver(r3).slashes, 0);
    }

    function test_finalize_rejectsACallWhileTheCommitWindowIsOpen() public {
        uint256 disputeId = _openDispute();

        vm.expectRevert(IOracleRegistry.CommitWindowOpen.selector);
        registry.finalize(disputeId);
    }

    function test_finalize_rejectsACallWhileACommitmentCouldStillBeRevealed() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);

        vm.expectRevert(IOracleRegistry.RevealWindowOpen.selector);
        registry.finalize(disputeId);
    }

    function test_finalize_runsEarlyOnceEveryCommitmentHasBeenRevealed() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);
        _reveal(r3, disputeId, 40, SALT);

        assertLt(block.timestamp, registry.getDispute(disputeId).revealEndsAt);
        registry.finalize(disputeId);

        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Finalized));
    }

    function test_finalize_rejectsAVoteThatNeverReachedQuorum() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        vm.expectRevert(IOracleRegistry.QuorumNotMet.selector);
        registry.finalize(disputeId);
    }

    function test_finalize_slashesTheSilentOnceTheirRevealWindowHasClosed() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 40, SALT);
        _commit(r4, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 40, SALT);
        _reveal(r3, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        registry.finalize(disputeId);

        assertEq(registry.getResolver(r4).bond, BOND - SLASH_TAKE, "silence after the window is free");
        assertEq(registry.getResolver(r4).slashes, 1);
        assertEq(registry.getResolver(r1).bond, BOND);
        assertEq(bond.balanceOf(sink), SLASH_TAKE);
    }

    function test_finalize_rejectsASecondFinalisation() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        vm.expectRevert(IOracleRegistry.BadStatus.selector);
        registry.finalize(disputeId);
    }

    function test_finalize_rejectsAnUnknownDispute() public {
        vm.expectRevert(IOracleRegistry.DisputeNotFound.selector);
        registry.finalize(999);
    }

    function test_finalize_releasesEveryBondItWasHolding() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        assertEq(registry.openVotes(r1), 0);
        assertEq(registry.openVotes(r2), 0);
        assertEq(registry.openVotes(r3), 0);
        assertEq(registry.getDispute(disputeId).rewardShares, 3);
    }

    /// A ruling the escrow refuses is not a ruling. Closing the dispute anyway would hand the
    /// lock to the escrow's timeout, so the whole finalize reverts and the vote stays open.
    function test_finalize_revertsWholeWhenTheEscrowRefusesTheRuling() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 42, SALT);
        _commit(r3, disputeId, 45, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 42, SALT);
        _reveal(r3, disputeId, 45, SALT);

        stub.setRefuseRulings(true);

        vm.expectRevert(IEscrow.BadStatus.selector);
        registry.finalize(disputeId);

        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Revealing));
        assertEq(registry.openVotes(r1), 1);

        stub.setRefuseRulings(false);
        registry.finalize(disputeId);
        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Finalized));
        assertEq(registry.openVotes(r1), 0);
    }

    function test_failDispute_doesNotSlashCommittersWhileTheRevealWindowIsStillOpen() public {
        // Two commitments against a quorum of three. The dispute is already doomed when the
        // commit window shuts, which is before anyone could have revealed. Slashing here would
        // charge resolvers for a quorum they had no way to reach, on a clock the caller picks.
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);

        IOracleRegistry.Dispute memory dispute = registry.getDispute(disputeId);
        vm.warp(dispute.commitEndsAt);
        assertLt(block.timestamp, dispute.revealEndsAt);

        vm.recordLogs();
        registry.failDispute(disputeId);
        _assertNoResolverWasSlashed();

        assertEq(registry.getResolver(r1).bond, BOND);
        assertEq(registry.getResolver(r2).bond, BOND);
        assertEq(registry.getResolver(r1).slashes, 0);
        assertEq(registry.getResolver(r2).slashes, 0);
        assertEq(registry.totalBonded(), BOND * 6);
        assertEq(bond.balanceOf(sink), 0);

        // The bonds still have to come free, or the fix would trade a bad slash for a lock-up.
        assertEq(registry.openVotes(r1), 0);
        assertEq(registry.openVotes(r2), 0);

        // No vote is no ruling: the lock is reopened, never refunded.
        assertEq(stub.reopenCount(), 1);
        assertEq(stub.resolveCount(), 0);
    }

    function test_failDispute_stillDoesNotSlashOneSecondBeforeTheRevealWindowCloses() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt - 1);

        vm.recordLogs();
        registry.failDispute(disputeId);
        _assertNoResolverWasSlashed();

        assertEq(registry.getResolver(r1).bond, BOND);
        assertEq(registry.getResolver(r2).bond, BOND);
        assertEq(bond.balanceOf(sink), 0);
    }

    function test_failDispute_slashesSilentCommittersOnceTheRevealWindowHasClosed() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);

        vm.expectEmit(true, true, false, true, address(registry));
        emit IOracleRegistry.ResolverSlashed(r1, disputeId, SLASH_TAKE);
        registry.failDispute(disputeId);

        assertEq(registry.getResolver(r1).bond, BOND - SLASH_TAKE);
        assertEq(registry.getResolver(r2).bond, BOND - SLASH_TAKE);
        assertEq(registry.getResolver(r1).slashes, 1);
        assertEq(registry.getResolver(r2).slashes, 1);
        assertEq(registry.totalBonded(), BOND * 6 - SLASH_TAKE * 2);
        assertEq(bond.balanceOf(sink), SLASH_TAKE * 2);
        assertEq(registry.openVotes(r1), 0);
        assertEq(registry.openVotes(r2), 0);
    }

    function test_failDispute_doesNotSlashAResolverThatRevealedAndWasOutnumbered() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        registry.failDispute(disputeId);

        assertEq(registry.getResolver(r1).bond, BOND, "a resolver that spoke was slashed for silence");
        assertEq(registry.getResolver(r2).bond, BOND - SLASH_TAKE);
    }

    function test_failDispute_rejectsACallWhileTheCommitWindowIsOpen() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.expectRevert(IOracleRegistry.CommitWindowOpen.selector);
        registry.failDispute(disputeId);
    }

    function test_failDispute_makesAQuorateVoteWaitOutTheRevealWindow() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 40, SALT);
        _commit(r3, disputeId, 40, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        vm.expectRevert(IOracleRegistry.RevealWindowOpen.selector);
        registry.failDispute(disputeId);
    }

    function test_failDispute_refusesToDiscardAVoteThatReachedQuorum() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);
        _commit(r2, disputeId, 42, SALT);
        _commit(r3, disputeId, 45, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 42, SALT);
        _reveal(r3, disputeId, 45, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        vm.expectRevert(IOracleRegistry.BadStatus.selector);
        registry.failDispute(disputeId);
    }

    function test_failDispute_reopensTheLockWhenNobodyCommittedAtAll() public {
        uint256 disputeId = _openDispute();

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.DisputeFailed(disputeId, IOracleRegistry.QuorumNotMet.selector);
        registry.failDispute(disputeId);

        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Failed));
        assertEq(stub.resolveCount(), 0);
        assertEq(stub.reopenCount(), 1);
        assertEq(stub.lastReopenedId(), registry.getDispute(disputeId).escrowId);
    }

    function test_failDispute_rejectsASecondCall() public {
        uint256 disputeId = _openDispute();
        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        registry.failDispute(disputeId);

        vm.expectRevert(IOracleRegistry.BadStatus.selector);
        registry.failDispute(disputeId);
    }

    function test_failDispute_rejectsADisputeThatAlreadyFinalized() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        vm.expectRevert(IOracleRegistry.BadStatus.selector);
        registry.failDispute(disputeId);
    }

    function test_onlyTheEscrowCanPostAReward() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotEscrow.selector);
        registry.notifyReward(1, 1e6);
    }

    function test_notifyReward_splitsTheFeeEvenlyAmongTheResolversWhoseScoresHeld() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.RewardsPosted(disputeId, 30e6, 3, 10e6);
        stub.postReward(disputeId, 30e6);

        assertEq(registry.rewardsOf(r1), 10e6);
        assertEq(registry.rewardsOf(r2), 10e6);
        assertEq(registry.rewardsOf(r3), 10e6);
        assertEq(registry.rewardFloat(), 30e6);
        assertEq(registry.unallocatedRewards(), 0);
    }

    function test_notifyReward_paysNothingToAResolverOutsideTheDeviationBand() public {
        uint256 disputeId = _openDispute();
        _commitAll4(disputeId, 40, 42, 45, 90);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _revealAll4(disputeId, 40, 42, 45, 90);

        registry.finalize(disputeId);
        assertEq(registry.getDispute(disputeId).rewardShares, 3);

        stub.postReward(disputeId, 30e6);

        assertEq(registry.rewardsOf(r1), 10e6);
        assertEq(registry.rewardsOf(r2), 10e6);
        assertEq(registry.rewardsOf(r3), 10e6);
        assertEq(registry.rewardsOf(r4), 0, "an outlier was paid for its vote");
        assertFalse(registry.rewardedBy(disputeId, r4));
    }

    function test_notifyReward_paysNothingToAResolverThatStayedSilent() public {
        uint256 disputeId = _openDispute();
        _commitAll4(disputeId, 40, 42, 45, 44);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, 40, SALT);
        _reveal(r2, disputeId, 42, SALT);
        _reveal(r3, disputeId, 45, SALT);

        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        registry.finalize(disputeId);

        stub.postReward(disputeId, 30e6);

        assertEq(registry.rewardsOf(r4), 0, "silence was paid");
        assertEq(registry.rewardsOf(r1), 10e6);
    }

    function test_notifyReward_parksAFeeThatNoResolverEarned() public {
        uint256 disputeId = _openDispute();
        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        registry.failDispute(disputeId);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.RewardsPosted(disputeId, 30e6, 0, 0);
        stub.postReward(disputeId, 30e6);

        assertEq(registry.unallocatedRewards(), 30e6);
        assertEq(registry.rewardFloat(), 30e6);
    }

    function test_notifyReward_parksAPotTooSmallToSplit() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        stub.postReward(disputeId, 2);

        assertEq(registry.unallocatedRewards(), 2);
        assertEq(registry.rewardsOf(r1), 0);
    }

    function test_notifyReward_sendsSplitDustToTheSinkRatherThanLeavingItStuck() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        stub.postReward(disputeId, 10);

        assertEq(registry.rewardsOf(r1), 3);
        assertEq(registry.rewardsOf(r2), 3);
        assertEq(registry.rewardsOf(r3), 3);
        assertEq(registry.unallocatedRewards(), 1);
    }

    function test_notifyReward_ignoresAZeroPost() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        stub.postReward(disputeId, 0);

        assertEq(registry.rewardFloat(), 0);
        assertEq(registry.rewardsOf(r1), 0);
    }

    function test_notifyReward_cannotCreditRewardsOutOfTheRosterBonds() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        uint128 bondedBefore = registry.totalBonded();
        assertEq(bond.balanceOf(address(registry)), bondedBefore);
        assertEq(usdg.balanceOf(address(registry)), 0);

        // The escrow names a figure it never transferred. Crediting it would mint claims
        // against a reward float nothing paid for.
        stub.postRewardWithoutPaying(disputeId, 1_000_000e6);

        assertEq(registry.rewardFloat(), 0);
        assertEq(registry.rewardsOf(r1), 0);
        assertEq(registry.rewardsOf(r2), 0);
        assertEq(registry.rewardsOf(r3), 0);
        assertEq(registry.totalBonded(), bondedBefore);
    }

    function test_notifyReward_creditsOnlyTheShortfallWhenTheEscrowOverstatesThePot() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);

        vm.prank(address(stub));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdg.transfer(address(registry), 9e6);

        vm.prank(address(stub));
        registry.notifyReward(disputeId, 30e6);

        assertEq(registry.rewardFloat(), 9e6);
        assertEq(registry.rewardsOf(r1), 3e6);
        assertEq(registry.rewardsOf(r2), 3e6);
        assertEq(registry.rewardsOf(r3), 3e6);
    }

    function test_claimRewards_paysOutAndClearsTheBalance() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);
        stub.postReward(disputeId, 30e6);

        vm.prank(r1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.RewardsClaimed(r1, 10e6);
        uint256 claimed = registry.claimRewards();

        assertEq(claimed, 10e6);
        assertEq(usdg.balanceOf(r1), 10e6);
        assertEq(registry.rewardsOf(r1), 0);
        assertEq(registry.rewardFloat(), 20e6);
    }

    function test_claimRewards_rejectsACallerWithNothingOwed() public {
        vm.prank(r4);
        vm.expectRevert(IOracleRegistry.NothingToClaim.selector);
        registry.claimRewards();
    }

    function test_claimRewards_rejectsASecondClaim() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);
        stub.postReward(disputeId, 30e6);

        vm.startPrank(r1);
        registry.claimRewards();
        vm.expectRevert(IOracleRegistry.NothingToClaim.selector);
        registry.claimRewards();
        vm.stopPrank();
    }

    function test_claimRewards_accumulatesAcrossSeveralDisputes() public {
        uint256 first = _finalizedDispute(40, 42, 45);
        stub.postReward(first, 30e6);
        uint256 second = _finalizedDispute(40, 42, 45);
        stub.postReward(second, 60e6);

        vm.prank(r1);
        assertEq(registry.claimRewards(), 30e6);
    }

    function test_claimRewards_stillPaysAResolverThatHasSinceLeftTheRoster() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);
        stub.postReward(disputeId, 30e6);

        vm.prank(r1);
        registry.requestUnbond();
        vm.warp(block.timestamp + UNBONDING_PERIOD);
        vm.startPrank(r1);
        registry.completeUnbond();
        assertEq(registry.claimRewards(), 10e6);
        vm.stopPrank();

        assertEq(bond.balanceOf(r1), BOND, "the returned bond comes back in BRSR");
        assertEq(usdg.balanceOf(r1), 10e6, "and the reward it earned comes back in the settlement asset");
    }

    function test_sweepUnallocated_sendsOrphanedFeesToTheSink() public {
        uint256 disputeId = _openDispute();
        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        registry.failDispute(disputeId);
        stub.postReward(disputeId, 30e6);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.UnallocatedSwept(sink, 30e6);
        assertEq(registry.sweepUnallocated(), 30e6);

        assertEq(usdg.balanceOf(sink), 30e6);
        assertEq(registry.unallocatedRewards(), 0);
        assertEq(registry.rewardFloat(), 0);
    }

    function test_sweepUnallocated_rejectsASweepOfNothing() public {
        vm.expectRevert(IOracleRegistry.NothingToClaim.selector);
        registry.sweepUnallocated();
    }

    function test_rewards_neverEatIntoTheBondsTheContractHolds() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);
        stub.postReward(disputeId, 30e6);

        uint128 bondedBefore = registry.totalBonded();

        vm.prank(r1);
        registry.claimRewards();
        vm.prank(r2);
        registry.claimRewards();
        vm.prank(r3);
        registry.claimRewards();

        assertEq(registry.rewardFloat(), 0);
        assertEq(registry.totalBonded(), bondedBefore);
        assertEq(bond.balanceOf(address(registry)), bondedBefore);
        assertEq(usdg.balanceOf(address(registry)), 0);
    }

    function test_onlyTheAdminCanSlashAResolver() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotAdmin.selector);
        registry.slash(r2, 1e18);
    }

    function test_slash_movesTheBondToTheSinkAndRecordsItAsGovernance() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IOracleRegistry.ResolverSlashed(r1, 0, 500e18);
        registry.slash(r1, 500e18);

        assertEq(registry.getResolver(r1).bond, BOND - 500e18);
        assertEq(registry.getResolver(r1).slashes, 1);
        assertEq(bond.balanceOf(sink), 500e18);
        assertEq(registry.totalBonded(), BOND * 6 - 500e18);
    }

    function test_slash_clampsToTheBondOnHand() public {
        vm.prank(admin);
        registry.slash(r1, BOND * 10);

        assertEq(registry.getResolver(r1).bond, 0);
        assertEq(bond.balanceOf(sink), BOND);
        assertEq(registry.totalBonded(), BOND * 5);
    }

    function test_slash_rejectsAZeroTargetOrAmount() public {
        vm.startPrank(admin);
        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        registry.slash(address(0), 1e18);
        vm.expectRevert(IOracleRegistry.ZeroAmount.selector);
        registry.slash(r1, 0);
        vm.stopPrank();
    }

    function test_slash_rejectsATargetThatIsNotOnTheRoster() public {
        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.NotRegistered.selector);
        registry.slash(makeAddr("stranger"), 1e18);
    }

    /// A slash takes the bond, not the seat. Before eviction existed a resolver slashed to
    /// nothing held one of the sixty-four seats for good.
    function test_slash_toNothingKeepsTheSeatUntilTheAdminEvicts() public {
        uint256 seated = registry.resolverCount();

        vm.prank(admin);
        registry.slash(r1, type(uint128).max);

        assertEq(registry.getResolver(r1).bond, 0);
        assertEq(uint8(registry.getResolver(r1).status), uint8(IOracleRegistry.ResolverStatus.Active));
        assertEq(registry.resolverCount(), seated, "the slash freed the seat by itself");

        vm.prank(admin);
        registry.evict(r1);
        assertEq(registry.resolverCount(), seated - 1);
    }

    function test_evict_freesASeatOnAFullRosterAndReturnsTheBond() public {
        uint256 open = 64 - registry.resolverCount();
        for (uint256 i; i < open; ++i) {
            _bond(string.concat("filler", vm.toString(i)), MIN_BOND);
        }
        assertEq(registry.resolverCount(), 64);

        address newcomer = makeAddr("newcomer");
        bond.mint(newcomer, MIN_BOND);
        vm.startPrank(newcomer);
        bond.approve(address(registry), MIN_BOND);
        vm.expectRevert(IOracleRegistry.RosterFull.selector);
        registry.register(MIN_BOND);
        vm.stopPrank();

        uint256 bondedBefore = registry.totalBonded();

        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.ResolverEvicted(r2, BOND);
        registry.evict(r2);

        assertEq(uint8(registry.getResolver(r2).status), uint8(IOracleRegistry.ResolverStatus.Exited));
        assertEq(registry.getResolver(r2).bond, 0);
        assertEq(bond.balanceOf(r2), BOND, "the bond went back to the resolver it belonged to");
        assertEq(registry.totalBonded(), bondedBefore - BOND);
        assertEq(registry.resolverCount(), 63);

        vm.prank(newcomer);
        registry.register(MIN_BOND);
        assertEq(registry.resolverCount(), 64);
    }

    function test_evict_waitsForEveryVoteTheBondBacks() public {
        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, 40, SALT);

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.BondLocked.selector);
        registry.evict(r1);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        registry.failDispute(disputeId);

        vm.prank(admin);
        registry.evict(r1);
        assertEq(uint8(registry.getResolver(r1).status), uint8(IOracleRegistry.ResolverStatus.Exited));
    }

    function test_evict_isTheAdminsCallAndOnlyForASeatedResolver() public {
        vm.prank(r2);
        vm.expectRevert(IOracleRegistry.NotAdmin.selector);
        registry.evict(r1);

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.NotRegistered.selector);
        registry.evict(makeAddr("stranger"));
    }

    function test_sweepSurplus_sendsAStrayTransferToTheSinkAndLeavesRewardsAlone() public {
        uint256 disputeId = _finalizedDispute(40, 42, 45);
        stub.postReward(disputeId, 30e6);
        uint256 floated = registry.rewardFloat();

        vm.expectRevert(IOracleRegistry.NothingToClaim.selector);
        registry.sweepSurplus();

        usdg.mint(address(registry), 7e6);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IOracleRegistry.SurplusSwept(sink, 7e6);
        assertEq(registry.sweepSurplus(), 7e6);

        assertEq(usdg.balanceOf(sink), 7e6);
        assertEq(registry.rewardFloat(), floated, "the sweep reached the reward ledger");
        assertEq(usdg.balanceOf(address(registry)), floated);

        vm.prank(r1);
        assertEq(registry.claimRewards(), 10e6, "a resolver lost what it had earned");
    }

    /// The payer's principal is read once, when the dispute opens, and stored with the parties.
    /// No vote calls back into the payer.
    function test_openDispute_recordsThePrincipalOnceAndNeverAsksAgain() public {
        OriginPayer payerContract = new OriginPayer();
        address opener = makeAddr("opener");

        vm.prank(address(stub), opener);
        uint256 disputeId = registry.openDispute(1_234, address(payerContract), address(0xB0B));

        (address payer, address payee, address principal) = registry.partiesOf(disputeId);
        assertEq(payer, address(payerContract));
        assertEq(payee, address(0xB0B));
        assertEq(principal, opener, "the principal is what the payer answered at the open");

        // Every resolver votes with itself as the origin, and none of them is the principal.
        bytes32 commitment = registry.commitmentHash(disputeId, r1, 40, SALT);
        vm.prank(r1, r1);
        registry.commitVote(disputeId, commitment);

        commitment = registry.commitmentHash(disputeId, opener, 40, SALT);
        _bondAs(opener);
        vm.prank(opener, opener);
        vm.expectRevert(IOracleRegistry.PartyCannotVote.selector);
        registry.commitVote(disputeId, commitment);
    }

    function test_onlyTheAdminMovesTheSlashSinkAndNeverToZero() public {
        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotAdmin.selector);
        registry.setSlashSink(r1);

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        registry.setSlashSink(address(0));

        address replacement = makeAddr("newSink");
        vm.prank(admin);
        registry.setSlashSink(replacement);
        assertEq(registry.slashSink(), replacement);
    }

    function test_onlyTheDeployerNamesTheEscrowAndOnlyOnce() public {
        OracleRegistry fresh = new OracleRegistry(address(usdg), admin, sink, _defaultConfig());

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.NotDeployer.selector);
        fresh.setEscrow(address(stub));

        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        fresh.setEscrow(address(0));

        fresh.setEscrow(address(stub));
        assertEq(fresh.escrow(), address(stub));

        vm.expectRevert(IOracleRegistry.AlreadySet.selector);
        fresh.setEscrow(address(this));
    }

    function test_transferAdmin_handsOverOnlyAfterTheSuccessorAccepts() public {
        address next = makeAddr("nextAdmin");

        vm.prank(admin);
        registry.transferAdmin(next);
        assertEq(registry.admin(), admin);
        assertEq(registry.pendingAdmin(), next);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.NotPendingAdmin.selector);
        registry.acceptAdmin();

        vm.prank(next);
        vm.expectEmit(true, true, false, false, address(registry));
        emit IOracleRegistry.AdminTransferred(admin, next);
        registry.acceptAdmin();

        assertEq(registry.admin(), next);
        assertEq(registry.pendingAdmin(), address(0));

        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.NotAdmin.selector);
        registry.slash(r1, 1e6);
    }

    function test_transferAdmin_rejectsTheZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(IOracleRegistry.ZeroAddress.selector);
        registry.transferAdmin(address(0));
    }

    function test_refundBpsForScore_stepsAtEveryTierBoundary() public view {
        assertEq(registry.refundBpsForScore(0), 10_000);
        assertEq(registry.refundBpsForScore(49), 10_000);
        assertEq(registry.refundBpsForScore(50), 7_500);
        assertEq(registry.refundBpsForScore(64), 7_500);
        assertEq(registry.refundBpsForScore(65), 3_500);
        assertEq(registry.refundBpsForScore(79), 3_500);
        assertEq(registry.refundBpsForScore(80), 0);
        assertEq(registry.refundBpsForScore(100), 0);
    }

    function testFuzz_refundBpsForScore_neverRisesWithABetterScore(uint8 low, uint8 high) public view {
        low = uint8(bound(low, 0, 100));
        high = uint8(bound(high, low, 100));

        assertGe(registry.refundBpsForScore(low), registry.refundBpsForScore(high));
        assertLe(registry.refundBpsForScore(low), 10_000);
    }

    function testFuzz_register_creditsExactlyWhatTheBondAssetDelivered(uint128 amount) public {
        amount = uint128(bound(amount, MIN_BOND, 1e24));

        address who = makeAddr("fuzzed");
        bond.mint(who, amount);

        vm.startPrank(who);
        bond.approve(address(registry), amount);
        registry.register(amount);
        vm.stopPrank();

        assertEq(registry.getResolver(who).bond, amount);
        assertEq(registry.totalBonded(), BOND * 6 + amount);
        assertEq(bond.balanceOf(address(registry)), BOND * 6 + amount);
    }

    function testFuzz_finalize_medianIsTheMiddleOfThreeRevealedScores(uint8 a, uint8 b, uint8 c) public {
        a = uint8(bound(a, 0, 100));
        b = uint8(bound(b, 0, 100));
        c = uint8(bound(c, 0, 100));

        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, a, SALT);
        _commit(r2, disputeId, b, SALT);
        _commit(r3, disputeId, c, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, a, SALT);
        _reveal(r2, disputeId, b, SALT);
        _reveal(r3, disputeId, c, SALT);

        registry.finalize(disputeId);

        assertEq(registry.getDispute(disputeId).medianScore, _middleOfThree(a, b, c));
    }

    function testFuzz_revealVote_acceptsOnlyTheCommittedPreimage(uint8 score, bytes32 salt, uint8 other) public {
        score = uint8(bound(score, 0, 100));
        other = uint8(bound(other, 0, 100));
        vm.assume(other != score);

        uint256 disputeId = _openDispute();
        _commit(r1, disputeId, score, salt);
        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r1);
        vm.expectRevert(IOracleRegistry.BadReveal.selector);
        registry.revealVote(disputeId, other, salt);

        _reveal(r1, disputeId, score, salt);
        (bool revealed,) = registry.revealedBy(disputeId, r1);
        assertTrue(revealed);
    }

    function testFuzz_slash_neverTakesMoreThanTheBond(uint128 amount) public {
        amount = uint128(bound(amount, 1, type(uint128).max));

        vm.prank(admin);
        registry.slash(r1, amount);

        uint128 taken = amount > BOND ? BOND : amount;
        assertEq(registry.getResolver(r1).bond, BOND - taken);
        assertEq(bond.balanceOf(sink), taken);
        assertEq(registry.totalBonded(), BOND * 6 - taken);
    }

    function _defaultConfig() private pure returns (IOracleRegistry.Config memory) {
        return IOracleRegistry.Config({
            commitWindow: COMMIT_WINDOW,
            revealWindow: REVEAL_WINDOW,
            unbondingPeriod: UNBONDING_PERIOD,
            quorum: QUORUM,
            maxVoters: MAX_VOTERS,
            maxDeviation: MAX_DEVIATION,
            slashBps: SLASH_BPS
        });
    }

    function _bondAs(address who) private {
        bond.mint(who, BOND);
        vm.startPrank(who);
        bond.approve(address(registry), BOND);
        registry.register(BOND);
        vm.stopPrank();
    }

    function _bond(string memory label, uint128 amount) private returns (address who) {
        who = makeAddr(label);
        bond.mint(who, amount);

        vm.startPrank(who);
        bond.approve(address(registry), amount);
        registry.register(amount);
        vm.stopPrank();
    }

    function _openDispute() private returns (uint256 disputeId) {
        disputeId = stub.open(registry.nextDisputeId() + 1_000);
    }

    function _commit(address who, uint256 disputeId, uint8 score, bytes32 salt) private {
        // The hash is read before the prank: a view call on the registry would otherwise
        // consume it, and `commitVote` would arrive from the test contract.
        bytes32 commitment = registry.commitmentHash(disputeId, who, score, salt);
        vm.prank(who);
        registry.commitVote(disputeId, commitment);
    }

    function _reveal(address who, uint256 disputeId, uint8 score, bytes32 salt) private {
        vm.prank(who);
        registry.revealVote(disputeId, score, salt);
    }

    function _commitAll4(uint256 disputeId, uint8 a, uint8 b, uint8 c, uint8 d) private {
        _commit(r1, disputeId, a, SALT);
        _commit(r2, disputeId, b, SALT);
        _commit(r3, disputeId, c, SALT);
        _commit(r4, disputeId, d, SALT);
    }

    function _revealAll4(uint256 disputeId, uint8 a, uint8 b, uint8 c, uint8 d) private {
        _reveal(r1, disputeId, a, SALT);
        _reveal(r2, disputeId, b, SALT);
        _reveal(r3, disputeId, c, SALT);
        _reveal(r4, disputeId, d, SALT);
    }

    function _finalizedDispute(uint8 a, uint8 b, uint8 c) private returns (uint256 disputeId) {
        disputeId = _openDispute();
        _commit(r1, disputeId, a, SALT);
        _commit(r2, disputeId, b, SALT);
        _commit(r3, disputeId, c, SALT);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        _reveal(r1, disputeId, a, SALT);
        _reveal(r2, disputeId, b, SALT);
        _reveal(r3, disputeId, c, SALT);

        registry.finalize(disputeId);
    }

    function _assertNoResolverWasSlashed() private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(registry) || logs[i].topics.length == 0) continue;
            assertTrue(logs[i].topics[0] != SLASH_TOPIC, "a resolver was slashed while it could still reveal");
        }
    }

    function _middleOfThree(uint8 a, uint8 b, uint8 c) private pure returns (uint8) {
        if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
        if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
        return c;
    }
}

/// The registry and the escrow paying each other, with no stand-in on either side. What is under
/// test here is the money: the fee the escrow deducts has to land on the resolvers that earned it
/// and nowhere else, and the lock has to close with the escrow holding nothing.
contract OracleRegistryEscrowIntegrationTest is Test {
    uint128 private constant MIN_BOND = 1_000e18;
    uint128 private constant BOND = 2_000e18;
    uint128 private constant AMOUNT = 1_000e6;
    uint128 private constant DISPUTE_BOND = 50e6;
    uint128 private constant RESOLVER_FEE = 20e6;

    uint16 private constant FEE_BPS = 100;
    uint16 private constant RESOLVER_FEE_BPS = 200;
    uint16 private constant DISPUTE_BOND_BPS = 500;

    uint64 private constant COMMIT_WINDOW = 1 hours;
    uint64 private constant REVEAL_WINDOW = 1 hours;

    bytes32 private constant SALT = keccak256("mandate.integration.salt");

    MockUsdg private token;
    MockBRSR private bond;
    Staking private pool;
    MockReputation private reputation;
    Escrow private escrow;
    OracleRegistry private registry;

    address private admin = makeAddr("admin");
    address private sink = makeAddr("slashSink");
    address private treasury = makeAddr("treasury");
    address private payer = makeAddr("payer");
    address private payee = makeAddr("payee");

    address private r1;
    address private r2;
    address private r3;

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new MockUsdg();
        reputation = new MockReputation();
        escrow = new Escrow(
            address(token),
            address(reputation),
            treasury,
            FEE_BPS,
            RESOLVER_FEE_BPS,
            DISPUTE_BOND_BPS,
            1 hours,
            30 days,
            1 days,
            10_000
        );
        registry = new OracleRegistry(
            address(token),
            admin,
            sink,
            IOracleRegistry.Config({
                commitWindow: COMMIT_WINDOW,
                revealWindow: REVEAL_WINDOW,
                unbondingPeriod: 7 days,
                quorum: 3,
                maxVoters: 64,
                maxDeviation: 10,
                slashBps: 2_000
            })
        );

        bond = new MockBRSR();
        pool = new Staking(bond, token, admin, sink, treasury, 7 days, MIN_BOND);

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(registry));
        registry.setEscrow(address(escrow));
        registry.setStaking(address(pool));

        r1 = _bond("r1");
        r2 = _bond("r2");
        r3 = _bond("r3");
    }

    function test_integration_resolverFeeSplitsBetweenTheResolversWhoseScoresHeld() public {
        uint256 lockId = _lock();

        token.mint(payer, DISPUTE_BOND);
        vm.startPrank(payer);
        token.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(lockId);
        vm.stopPrank();

        uint256 disputeId = registry.disputeIdOf(lockId);
        assertEq(disputeId, 1);

        _vote(disputeId, 40, 42, 45);
        registry.finalize(disputeId);

        // refunded 980 + paid 0 + protocolFee 0 + resolverFee 20 + bond 50 == 1000 + 50.
        assertEq(escrow.getLock(lockId).amount, AMOUNT);
        assertEq(token.balanceOf(payer), AMOUNT - RESOLVER_FEE + DISPUTE_BOND);
        assertEq(token.balanceOf(payee), 0);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(token.balanceOf(address(escrow)), 0, "the escrow kept part of a settled lock");

        assertEq(registry.rewardFloat(), RESOLVER_FEE);
        assertEq(registry.rewardsOf(r1), 6_666_666);
        assertEq(registry.rewardsOf(r2), 6_666_666);
        assertEq(registry.rewardsOf(r3), 6_666_666);
        assertEq(registry.unallocatedRewards(), 2);

        vm.prank(r1);
        registry.claimRewards();
        assertEq(token.balanceOf(r1), 6_666_666);

        registry.sweepUnallocated();
        assertEq(token.balanceOf(sink), 2);
    }

    function test_integration_forfeitedDisputeBondJoinsTheResolverReward() public {
        uint256 lockId = _lock();

        token.mint(payee, DISPUTE_BOND);
        vm.startPrank(payee);
        token.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(lockId);
        vm.stopPrank();

        uint256 disputeId = registry.disputeIdOf(lockId);
        _vote(disputeId, 40, 42, 45);

        // A full refund is the opposite of what the payee asked for, so its bond is forfeited
        // and pays the resolvers who ruled against it.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEscrow.BondForfeited(lockId, payee, DISPUTE_BOND);
        registry.finalize(disputeId);

        uint256 pot = RESOLVER_FEE + DISPUTE_BOND;
        assertEq(registry.rewardFloat(), pot);
        assertEq(registry.rewardsOf(r1), pot / 3);
        assertEq(registry.rewardsOf(r2), pot / 3);
        assertEq(registry.rewardsOf(r3), pot / 3);
        assertEq(registry.unallocatedRewards(), pot % 3);

        assertEq(token.balanceOf(payer), AMOUNT - RESOLVER_FEE);
        assertEq(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_integration_aVoteWithNoCentreRefundsThePayerAndPaysNoResolver() public {
        uint256 lockId = _lock();

        token.mint(payer, DISPUTE_BOND);
        vm.startPrank(payer);
        token.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(lockId);
        vm.stopPrank();

        uint256 disputeId = registry.disputeIdOf(lockId);
        _vote(disputeId, 0, 50, 100);
        registry.finalize(disputeId);

        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Failed));
        assertEq(registry.rewardsOf(r1), 0);
        assertEq(registry.rewardsOf(r2), 0);
        assertEq(registry.rewardsOf(r3), 0);

        // Nobody earned the resolver fee, so it is never taken: the payer gets the lock and its
        // bond back whole, and nothing is left for the sink.
        assertEq(token.balanceOf(payer), AMOUNT + DISPUTE_BOND);
        assertEq(registry.unallocatedRewards(), 0);
        assertEq(registry.rewardFloat(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    /// A payer contract that answers `principal()` with `tx.origin` names whoever sends each
    /// transaction. Read on every vote, that barred every resolver voting from its own key and
    /// left the payer's own seats to rule alone. Read once at the open, it names the key that
    /// opened the dispute and nobody else.
    function test_integration_aPayerCannotBarTheResolversByNamingEachVoterItsPrincipal() public {
        OriginPayer origin = new OriginPayer();
        token.mint(address(origin), AMOUNT);
        uint256 lockId = origin.lock(escrow, token, payee, AMOUNT, _deadline());

        address opener = makeAddr("opener");
        token.mint(address(origin), DISPUTE_BOND);
        vm.prank(opener, opener);
        origin.dispute(escrow, lockId);
        uint256 disputeId = registry.disputeIdOf(lockId);

        SybilResolver s1 = _sybil("sybil1");
        SybilResolver s2 = _sybil("sybil2");
        s1.commit(registry, disputeId, 0);
        s2.commit(registry, disputeId, 0);

        _commitAsItself(r1, disputeId, 90);
        _commitAsItself(r2, disputeId, 90);
        _commitAsItself(r3, disputeId, 90);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        s1.reveal(registry, disputeId, 0);
        s2.reveal(registry, disputeId, 0);
        _revealAll(disputeId, 90);

        registry.finalize(disputeId);

        // Three honest scores against two: the payee is paid for the job it delivered, the seats
        // the payer bought are slashed, and they earn nothing.
        assertEq(registry.getDispute(disputeId).medianScore, 90);
        assertEq(token.balanceOf(payee), (AMOUNT - RESOLVER_FEE) - ((AMOUNT - RESOLVER_FEE) * FEE_BPS) / 10_000);
        assertEq(registry.getResolver(address(s1)).slashes, 1);
        assertEq(registry.rewardsOf(address(s1)), 0);
        assertGt(registry.rewardsOf(r1), 0);
    }

    /// Five seats used to go to whoever committed first, so three seats bought by the payer and
    /// filled in the block the dispute opened left room for two honest votes and outvoted them.
    /// Every seated resolver votes now, and the honest ones are not shut out, slashed or benched.
    function test_integration_seatsBoughtByAPartyCannotCrowdTheResolversOut() public {
        uint256 disputeId = _dispute(payer, _lock());

        SybilResolver[3] memory sybils = [_sybil("sybil1"), _sybil("sybil2"), _sybil("sybil3")];
        for (uint256 i; i < sybils.length; ++i) {
            sybils[i].commit(registry, disputeId, 0);
        }

        _commitAsItself(r1, disputeId, 90);
        _commitAsItself(r2, disputeId, 90);
        _commitAsItself(r3, disputeId, 90);
        assertEq(registry.getDispute(disputeId).commitCount, 6, "an honest resolver was turned away");

        vm.warp(registry.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < sybils.length; ++i) {
            sybils[i].reveal(registry, disputeId, 0);
        }
        _revealAll(disputeId, 90);
        registry.finalize(disputeId);

        // Three against three has no centre. The payer is refunded, as for any vote with no
        // result, and nobody who revealed is slashed for it.
        assertEq(uint8(registry.getDispute(disputeId).status), uint8(IOracleRegistry.DisputeStatus.Failed));
        assertEq(registry.getResolver(r1).bond, BOND);
        assertEq(registry.getResolver(r2).bond, BOND);
        assertEq(registry.getResolver(r3).bond, BOND);

        // And the next dispute hears them.
        uint256 next = _dispute(payer, _lock());
        _commitAsItself(r1, next, 90);
        assertEq(registry.getDispute(next).commitCount, 1);
    }

    /// The issuer freezes the payee while the vote runs. The ruling still lands, the payee's
    /// leg is booked for later, and the voters' bonds come free.
    function test_integration_aFrozenPayeeCannotHoldARulingOrTheVotersBonds() public {
        uint256 lockId = _lock();
        uint256 disputeId = _dispute(payer, lockId);
        _vote(disputeId, 70, 70, 70);

        token.setFrozen(payee, true);
        registry.finalize(disputeId);

        (uint128 refunded, uint128 paid) = _legs();
        assertEq(uint8(escrow.getLock(lockId).status), uint8(IEscrow.LockStatus.Resolved));
        assertEq(token.balanceOf(payer), refunded, "the payer's leg landed");
        assertEq(escrow.owed(payee), paid, "the frozen payee's leg was booked");
        assertEq(registry.openVotes(r1), 0);
        assertEq(registry.openVotes(r2), 0);
        assertEq(registry.openVotes(r3), 0);

        vm.prank(r1);
        registry.requestUnbond();
        vm.warp(block.timestamp + 7 days);
        vm.prank(r1);
        registry.completeUnbond();
        assertEq(bond.balanceOf(r1), BOND, "a voter left with its bond");

        token.setFrozen(payee, false);
        escrow.claim(payee);
        assertEq(token.balanceOf(payee), paid);
        assertEq(token.balanceOf(address(escrow)), escrow.feesAccrued());
    }

    function test_integration_aFrozenPayerCannotHoldARulingOpen() public {
        uint256 lockId = _lock();
        uint256 disputeId = _dispute(payee, lockId);
        _vote(disputeId, 70, 70, 70);

        token.setFrozen(payer, true);
        registry.finalize(disputeId);

        (uint128 refunded, uint128 paid) = _legs();
        assertEq(uint8(escrow.getLock(lockId).status), uint8(IEscrow.LockStatus.Resolved));
        assertEq(escrow.owed(payer), refunded, "the frozen payer's refund was booked");
        assertEq(token.balanceOf(payee), paid + DISPUTE_BOND, "the payee was paid and vindicated");
        assertEq(registry.openVotes(r1), 0);

        token.setFrozen(payer, false);
        escrow.claim(payer);
        assertEq(token.balanceOf(payer), refunded);
    }

    function test_integration_aFrozenDisputerCannotHoldAFailedVoteOpen() public {
        uint256 lockId = _lock();
        uint256 disputeId = _dispute(payee, lockId);
        _commitAsItself(r1, disputeId, 70);

        token.setFrozen(payee, true);
        vm.warp(registry.getDispute(disputeId).revealEndsAt);
        registry.failDispute(disputeId);

        assertEq(uint8(escrow.getLock(lockId).status), uint8(IEscrow.LockStatus.Locked), "the lock reopened");
        assertEq(escrow.owed(payee), DISPUTE_BOND, "the frozen disputer's bond was booked");
        assertEq(registry.openVotes(r1), 0);

        vm.prank(r1);
        registry.requestUnbond();
        vm.warp(block.timestamp + 7 days);
        vm.prank(r1);
        registry.completeUnbond();
        assertEq(uint8(registry.getResolver(r1).status), uint8(IOracleRegistry.ResolverStatus.Exited));
    }

    function _bond(string memory label) private returns (address who) {
        who = makeAddr(label);
        bond.mint(who, BOND);

        vm.startPrank(who);
        bond.approve(address(registry), BOND);
        registry.register(BOND);
        vm.stopPrank();
    }

    function _lock() private returns (uint256 lockId) {
        token.mint(payer, AMOUNT);

        vm.startPrank(payer);
        token.approve(address(escrow), AMOUNT);
        lockId = escrow.lock(payee, keccak256("capability"), keccak256("input"), "ipfs://in", AMOUNT, _deadline());
        vm.stopPrank();
    }

    function _vote(uint256 disputeId, uint8 a, uint8 b, uint8 c) private {
        bytes32 ca = registry.commitmentHash(disputeId, r1, a, SALT);
        bytes32 cb = registry.commitmentHash(disputeId, r2, b, SALT);
        bytes32 cc = registry.commitmentHash(disputeId, r3, c, SALT);

        vm.prank(r1);
        registry.commitVote(disputeId, ca);
        vm.prank(r2);
        registry.commitVote(disputeId, cb);
        vm.prank(r3);
        registry.commitVote(disputeId, cc);

        vm.warp(registry.getDispute(disputeId).commitEndsAt);

        vm.prank(r1);
        registry.revealVote(disputeId, a, SALT);
        vm.prank(r2);
        registry.revealVote(disputeId, b, SALT);
        vm.prank(r3);
        registry.revealVote(disputeId, c, SALT);
    }

    function _deadline() private view returns (uint64) {
        return uint64(block.timestamp + 7 days);
    }

    function _dispute(address disputer, uint256 lockId) private returns (uint256 disputeId) {
        token.mint(disputer, DISPUTE_BOND);
        vm.startPrank(disputer);
        token.approve(address(escrow), DISPUTE_BOND);
        escrow.dispute(lockId);
        vm.stopPrank();
        disputeId = registry.disputeIdOf(lockId);
    }

    /// Each resolver votes from its own key, so it is also the transaction's origin.
    function _commitAsItself(address resolver, uint256 disputeId, uint8 score) private {
        bytes32 commitment = registry.commitmentHash(disputeId, resolver, score, SALT);
        vm.prank(resolver, resolver);
        registry.commitVote(disputeId, commitment);
    }

    function _revealAll(uint256 disputeId, uint8 score) private {
        vm.prank(r1);
        registry.revealVote(disputeId, score, SALT);
        vm.prank(r2);
        registry.revealVote(disputeId, score, SALT);
        vm.prank(r3);
        registry.revealVote(disputeId, score, SALT);
    }

    function _sybil(string memory label) private returns (SybilResolver sybil) {
        sybil = new SybilResolver();
        vm.label(address(sybil), label);
        bond.mint(address(sybil), MIN_BOND);
        sybil.register(registry, bond, MIN_BOND);
    }

    /// 35% refund on a thousand: both legs are non-zero.
    function _legs() private pure returns (uint128 refunded, uint128 paid) {
        uint128 divisible = AMOUNT - RESOLVER_FEE;
        refunded = (divisible * 3_500) / 10_000;
        uint128 awarded = divisible - refunded;
        paid = awarded - (awarded * FEE_BPS) / 10_000;
    }
}

/// Drives the registry from every entry point at once, from the escrow seat, so the solvency
/// properties are asserted against sequences nobody wrote by hand.
contract RegistryHandler is Test {
    OracleRegistry public immutable REGISTRY;
    MockUsdg public immutable TOKEN;
    MockBRSR public immutable BOND;

    error NothingRevealed();

    bytes32 private constant SALT = keccak256("mandate.invariant.salt");

    /// The staking pool's floor in this fixture.
    uint128 private constant FLOOR = 1_000e18;

    /// Disputes `drive` took all the way to a ruling. Read by `afterInvariant`.
    uint256 public finalized;

    /// A commitment the registry accepted. Held because a reveal drawn at random from the
    /// actor set and the dispute set almost never lands on one that was committed, and a
    /// campaign that never reveals never reaches finalisation, rewards or slashing either.
    struct Commitment {
        uint256 disputeId;
        address voter;
    }

    address[4] private _actors;
    uint256[] private _disputeIds;
    Commitment[] private _commitments;
    uint256 private _nextEscrowId = 1;

    mapping(uint256 disputeId => mapping(address actor => uint8 score)) private _scores;

    constructor(OracleRegistry registry_, MockUsdg token_, MockBRSR bond_) {
        REGISTRY = registry_;
        TOKEN = token_;
        BOND = bond_;

        _actors[0] = makeAddr("handler-a");
        _actors[1] = makeAddr("handler-b");
        _actors[2] = makeAddr("handler-c");
        _actors[3] = makeAddr("handler-d");
    }

    function actors() external view returns (address[4] memory) {
        return _actors;
    }

    /// One prank per call, never a started one. A call that reverts under `startPrank` leaves
    /// the prank standing, and every later step in the run then fails on the cheatcode rather
    /// than on the contract, which is how an earlier version of this suite never reached a
    /// single ruling.
    function register(uint256 actorSeed, uint128 amount) external {
        address who = _actor(actorSeed);
        amount = uint128(bound(amount, 1, 50_000e18));

        _approveBond(who, amount);
        vm.prank(who);
        REGISTRY.register(amount);
    }

    function increaseBond(uint256 actorSeed, uint128 amount) external {
        address who = _actor(actorSeed);
        amount = uint128(bound(amount, 1, 50_000e18));

        _approveBond(who, amount);
        vm.prank(who);
        REGISTRY.increaseBond(amount);
    }

    function requestUnbond(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        REGISTRY.requestUnbond();
    }

    function completeUnbond(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        REGISTRY.completeUnbond();
    }

    function cancelUnbond(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        REGISTRY.cancelUnbond();
    }

    function openDispute() external {
        _disputeIds.push(REGISTRY.openDispute(_nextEscrowId++, address(0xA11CE), address(0xB0B)));
    }

    function commitVote(uint256 actorSeed, uint256 disputeSeed, uint8 score) external {
        uint256 disputeId = _dispute(disputeSeed);
        address who = _actor(actorSeed);
        score = uint8(bound(score, 0, 100));

        _scores[disputeId][who] = score;
        bytes32 commitment = REGISTRY.commitmentHash(disputeId, who, score, SALT);
        vm.prank(who);
        REGISTRY.commitVote(disputeId, commitment);

        // Reached only when the commit stood: a revert unwinds the whole handler call.
        _commitments.push(Commitment({disputeId: disputeId, voter: who}));
    }

    /// Opens every commitment standing on one dispute. A vote reaches quorum only when more
    /// than one voter opens, and revealing them one at a time leaves finalisation out of reach
    /// of a campaign of any practical length.
    function revealVotes(uint256 seed) external {
        uint256 disputeId = _commitment(seed).disputeId;
        uint256 opened;

        for (uint256 i; i < _commitments.length; ++i) {
            Commitment memory c = _commitments[i];
            if (c.disputeId != disputeId) continue;

            vm.prank(c.voter);
            try REGISTRY.revealVote(disputeId, _scores[disputeId][c.voter], SALT) {
                opened += 1;
            } catch {}
        }

        if (opened == 0) revert NothingRevealed();
    }

    function finalize(uint256 seed) external {
        REGISTRY.finalize(_commitment(seed).disputeId);
    }

    function failDispute(uint256 seed) external {
        REGISTRY.failDispute(_commitment(seed).disputeId);
    }

    function postReward(uint256 seed, uint256 amount) external {
        uint256 disputeId = _commitment(seed).disputeId;
        amount = bound(amount, 1, 10_000e6);

        TOKEN.mint(address(REGISTRY), amount);
        REGISTRY.notifyReward(disputeId, amount);
    }

    function claimRewards(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        REGISTRY.claimRewards();
    }

    function sweepUnallocated() external {
        REGISTRY.sweepUnallocated();
    }

    function advanceTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 minutes, 12 hours));
    }

    /// Jumps to the instant a committed dispute's commit window closes. Warping at random
    /// almost never lands inside a reveal window, and a campaign that cannot reveal never
    /// reaches finalisation, the reward split or the slash either.
    function openRevealWindow(uint256 seed) external {
        IOracleRegistry.Dispute memory dispute = REGISTRY.getDispute(_commitment(seed).disputeId);
        if (dispute.commitEndsAt == 0 || block.timestamp >= dispute.commitEndsAt) return;

        vm.warp(dispute.commitEndsAt);
    }

    /// One dispute the whole way: opened, committed by every actor, revealed, finalised, paid
    /// and claimed. A random walk lines those six steps up so rarely that a campaign of any
    /// practical length used to finish without a single ruling, and the reward split, the
    /// slash and the bond release all sit at the end of them.
    ///
    /// Whatever the run did to the actors first, they are seated again with a bond the floor
    /// accepts. This step is about whether a vote can still be heard, not about who left.
    function drive(uint256 scoreSeed) external {
        uint8 score = uint8(bound(scoreSeed, 0, 100));
        uint256 disputeId = REGISTRY.openDispute(_nextEscrowId++, address(0xA11CE), address(0xB0B));
        _disputeIds.push(disputeId);

        for (uint256 i; i < _actors.length; ++i) {
            address who = _actors[i];
            _seat(who);

            _scores[disputeId][who] = score;
            bytes32 commitment = REGISTRY.commitmentHash(disputeId, who, score, SALT);
            vm.prank(who);
            REGISTRY.commitVote(disputeId, commitment);
            _commitments.push(Commitment({disputeId: disputeId, voter: who}));
        }

        vm.warp(REGISTRY.getDispute(disputeId).commitEndsAt);
        for (uint256 i; i < _actors.length; ++i) {
            vm.prank(_actors[i]);
            REGISTRY.revealVote(disputeId, score, SALT);
        }

        REGISTRY.finalize(disputeId);
        finalized += 1;

        uint256 pot = 4e6;
        TOKEN.mint(address(REGISTRY), pot);
        REGISTRY.notifyReward(disputeId, pot);

        for (uint256 i; i < _actors.length; ++i) {
            vm.prank(_actors[i]);
            REGISTRY.claimRewards();
        }
    }

    /// The registry rules and reopens through this seat.
    function resolve(uint256, uint16, uint8) external {}

    function reopen(uint256) external {}

    function disputeIds() external view returns (uint256[] memory) {
        return _disputeIds;
    }

    function _seat(address who) private {
        IOracleRegistry.Resolver memory record = REGISTRY.getResolver(who);

        if (record.status == IOracleRegistry.ResolverStatus.Unbonding) {
            vm.prank(who);
            REGISTRY.cancelUnbond();
        }

        if (
            record.status == IOracleRegistry.ResolverStatus.None
                || record.status == IOracleRegistry.ResolverStatus.Exited
        ) {
            _approveBond(who, FLOOR);
            vm.prank(who);
            REGISTRY.register(FLOOR);
        } else if (record.bond < FLOOR) {
            uint128 topUp = FLOOR - record.bond;
            _approveBond(who, topUp);
            vm.prank(who);
            REGISTRY.increaseBond(topUp);
        }
    }

    function _approveBond(address who, uint128 amount) private {
        BOND.mint(who, amount);
        vm.prank(who);
        BOND.approve(address(REGISTRY), amount);
    }

    function _actor(uint256 seed) private view returns (address) {
        return _actors[seed % _actors.length];
    }

    function _dispute(uint256 seed) private view returns (uint256) {
        if (_disputeIds.length == 0) return 0;
        return _disputeIds[seed % _disputeIds.length];
    }

    /// Dispute zero does not exist, so an empty book sends the caller into `DisputeNotFound`
    /// and the runner discards the call.
    function _commitment(uint256 seed) private view returns (Commitment memory) {
        if (_commitments.length == 0) return Commitment({disputeId: 0, voter: address(0)});
        return _commitments[seed % _commitments.length];
    }
}

/// A vote runs open, commit, reveal, finalise, reward, claim in that order, and a shallow
/// campaign rarely draws all six in sequence. The depth is raised in this suite alone, because
/// it is the only one whose interesting states sit that far in.
///
/// forge-config: default.invariant.depth = 128
contract OracleRegistrySolvencyInvariants is Test {
    MockUsdg private token;
    MockBRSR private bond;
    OracleRegistry private registry;
    RegistryHandler private handler;

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new MockUsdg();
        bond = new MockBRSR();
        address admin = makeAddr("admin");
        address sink = makeAddr("slashSink");

        registry = new OracleRegistry(
            address(token),
            admin,
            sink,
            IOracleRegistry.Config({
                commitWindow: 1 days,
                revealWindow: 1 days,
                unbondingPeriod: 2 days,
                quorum: 2,
                maxVoters: 64,
                maxDeviation: 10,
                slashBps: 2_000
            })
        );

        handler = new RegistryHandler(registry, token, bond);
        registry.setEscrow(address(handler));
        registry.setStaking(address(new Staking(bond, token, admin, sink, makeAddr("treasury"), 7 days, 1_000e18)));

        targetContract(address(handler));
    }

    /// Bonds and accrued rewards are claims on two different tokens, and neither may be paid
    /// out of the other. If either of these fails, someone's bond funded someone else's reward.
    function invariant_bondsAndRewardsAreBothFullyBacked() public view {
        assertGe(bond.balanceOf(address(registry)), uint256(registry.totalBonded()));
        assertGe(token.balanceOf(address(registry)), registry.rewardFloat());
    }

    function invariant_perResolverBondsSumToTotalBonded() public view {
        address[4] memory actors = handler.actors();
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += registry.getResolver(actors[i]).bond;
        }
        assertEq(sum, registry.totalBonded());
    }

    function invariant_unallocatedFeesNeverExceedTheRewardFloat() public view {
        assertLe(registry.unallocatedRewards(), registry.rewardFloat());
    }

    /// Every open vote is a commitment on a dispute that has not closed, and every such
    /// commitment is an open vote. A count that drifts either way either pins a bond for good
    /// or releases one a live vote still needs.
    function invariant_openVotesEqualTheCommitmentsOnOpenDisputes() public view {
        uint256[] memory ids = handler.disputeIds();
        uint256 committed;
        for (uint256 i; i < ids.length; ++i) {
            IOracleRegistry.Dispute memory dispute = registry.getDispute(ids[i]);
            bool open = dispute.status == IOracleRegistry.DisputeStatus.Committing
                || dispute.status == IOracleRegistry.DisputeStatus.Revealing;
            if (open) committed += dispute.commitCount;
        }

        address[4] memory actors = handler.actors();
        uint256 held;
        for (uint256 i; i < actors.length; ++i) {
            held += registry.openVotes(actors[i]);
        }
        assertEq(held, committed);
    }

    /// A run that never reached a ruling proved nothing about the money paths. When the random
    /// walk did not get there, one more dispute is driven from wherever the run left the
    /// registry, which also proves a vote can still be heard from that state.
    function afterInvariant() public {
        if (handler.finalized() == 0) handler.drive(40);
        assertGt(handler.finalized(), 0, "no dispute reached a ruling in this run");
    }

    function invariant_rosterCountMatchesTheBondedResolvers() public view {
        address[4] memory actors = handler.actors();
        uint256 seated;
        for (uint256 i; i < actors.length; ++i) {
            IOracleRegistry.ResolverStatus status = registry.getResolver(actors[i]).status;
            if (status == IOracleRegistry.ResolverStatus.Active || status == IOracleRegistry.ResolverStatus.Unbonding) {
                seated += 1;
            }
        }
        assertEq(seated, registry.resolverCount());
    }
}
