// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {BRSR} from "../src/token/BRSR.sol";
import {Vesting} from "../src/token/Vesting.sol";
import {IBRSR} from "../src/token/interfaces/IBRSR.sol";

/// Mints BRSR and writes the team's vesting schedule, once per chain.
///
/// On Robinhood Chain this has already run: the record names BRSR and Vesting, carried over from
/// the first deployment, and this script refuses to run against them. It exists for a fresh chain
/// and for local rehearsals, where the token has to exist before the staking deployment builds on
/// it.
///
/// BRSR has no admin at all: the supply is minted once inside its constructor and split four ways,
/// and the deploy key never holds a token. That mint is also the reason for the order below. BRSR
/// has to name the vesting contract as the team's recipient, and the vesting contract has to name
/// BRSR as the token it pays out, and neither address exists when the other constructor runs. The
/// script computes the token's address from the deploy key's nonce, builds the vesting contract
/// against it, then deploys the token and asserts that the address it predicted is the address it
/// got. A mismatch stops the run before a grant is written.
///
/// What the deploy key keeps is one call no constructor can make: `Vesting.createGrants`, which
/// writes the team schedule and closes it. It accepts exactly one call, and a run that stops
/// between the deployments and that call leaves a funded vesting contract with no schedule and no
/// second chance.
contract DeployToken is BursarScript {
    uint8 internal constant BRSR_DECIMALS = 18;

    /// The published split, checked against what the token actually minted.
    uint16 internal constant COMMUNITY_BPS = 8000;
    uint16 internal constant TEAM_BPS = 1000;
    uint16 internal constant TREASURY_BPS = 500;
    uint16 internal constant LIQUIDITY_BPS = 500;

    /// The published supply and the team's tenth of it. Both are constants in the token too; these
    /// exist so the preflight can check the grant amounts before anything is sent.
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant TEAM_ALLOCATION = 100_000_000e18;

    /// How far the vesting commencement date may sit from the deployment. Backdating is legitimate
    /// for a grant agreed before the contracts existed. Backdating past the cliff is a typo that
    /// vests a quarter of the team allocation immediately.
    uint64 internal constant MAX_BACKDATE = 90 days;
    uint64 internal constant MAX_POSTDATE = 90 days;

    struct Deployment {
        address brsr;
        address vesting;
    }

    error RoleCollision(string role, string otherRole, address account);
    error TokenAddressUnpredictable(address expected, address actual);
    error AllocationMismatch(uint256 allocated, uint256 totalSupply);
    error AllocationShareWrong(string share, uint256 allocation, uint256 expected);
    error VestingListLengthMismatch(uint256 beneficiaries, uint256 amounts);
    error VestingAmountsMismatch(uint256 sum, uint256 teamAllocation);
    error VestingStartOutOfRange(uint64 start, uint64 earliest, uint64 latest);
    error DeployerHoldsSupply(uint256 remaining);
    error ScheduleNotApplied(string what, uint256 expected, uint256 actual);

    address private timelock;
    address private treasury;
    address private community;
    address private liquidity;

    address[] private beneficiaries;
    uint128[] private grantAmounts;
    uint64 private vestingStart;

    BRSR private brsr;
    Vesting private vesting;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        _loadEnv();
        _preflight(deployer);

        vm.startBroadcast(deployer);
        _deploy(deployer);
        vm.stopBroadcast();

        _verify(deployer);
        _record();
        _report(deployer);

        return Deployment({brsr: address(brsr), vesting: address(vesting)});
    }

    function _loadEnv() private {
        timelock = _timelock();
        treasury = _role(K.TREASURY, "BURSAR_TREASURY");
        community = _role(K.COMMUNITY, "BURSAR_BRSR_COMMUNITY");
        liquidity = _role(K.LIQUIDITY, "BURSAR_BRSR_LIQUIDITY");

        vestingStart = _envUint64("BURSAR_VESTING_START");
        beneficiaries = _envAddressList("BURSAR_VESTING_BENEFICIARIES");
        grantAmounts = _envUint128List("BURSAR_VESTING_AMOUNTS");
    }

    /// Everything checkable before a single transaction is sent. A run that fails halfway leaves a
    /// live token whose whole supply is already placed and cannot be moved.
    function _preflight(address deployer) private view {
        _requireUnrecorded(K.BRSR);
        _requireUnrecorded(K.VESTING);

        // The deploy key signs from a shell with an unlocked keystore, and the token's mint is
        // final. Nothing it names as a recipient may be itself, and no two may be the same.
        if (community == deployer) revert RoleCollision("community", "deployer", community);
        if (liquidity == deployer) revert RoleCollision("liquidity", "deployer", liquidity);
        if (treasury == deployer) revert RoleCollision("treasury", "deployer", treasury);
        if (community == liquidity) revert RoleCollision("community", "liquidity", community);
        if (community == treasury) revert RoleCollision("community", "treasury", community);
        if (liquidity == treasury) revert RoleCollision("liquidity", "treasury", liquidity);

        if (beneficiaries.length != grantAmounts.length) {
            revert VestingListLengthMismatch(beneficiaries.length, grantAmounts.length);
        }
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            if (beneficiary == deployer) revert RoleCollision("beneficiary", "deployer", beneficiary);
            if (beneficiary == treasury) revert RoleCollision("beneficiary", "treasury", beneficiary);
            if (beneficiary == timelock) revert RoleCollision("beneficiary", "timelock", beneficiary);
        }

        uint256 grantSum;
        for (uint256 i; i < grantAmounts.length; ++i) {
            grantSum += grantAmounts[i];
        }
        if (grantSum != TEAM_ALLOCATION) revert VestingAmountsMismatch(grantSum, TEAM_ALLOCATION);

        // forge-lint: disable-start(unsafe-typecast)
        uint64 earliest = uint64(block.timestamp) - MAX_BACKDATE;
        uint64 latest = uint64(block.timestamp) + MAX_POSTDATE;
        // forge-lint: disable-end
        if (vestingStart < earliest || vestingStart > latest) {
            revert VestingStartOutOfRange(vestingStart, earliest, latest);
        }
    }

    function _deploy(address deployer) private {
        // The token's address, computed from the nonce this key is about to spend twice. The
        // prediction is proved on the vesting deployment, before the token is sent, so a bad one
        // costs a wasted deployment instead of a tenth of the supply.
        uint256 nonce = vm.getNonce(deployer);
        address predictedVesting = vm.computeCreateAddress(deployer, nonce);
        address predicted = vm.computeCreateAddress(deployer, nonce + 1);

        vesting = new Vesting(predicted, timelock, treasury);
        if (address(vesting) != predictedVesting) {
            revert TokenAddressUnpredictable(predictedVesting, address(vesting));
        }

        brsr = new BRSR(
            IBRSR.Allocation({community: community, team: address(vesting), treasury: treasury, liquidity: liquidity})
        );
        if (address(brsr) != predicted) revert TokenAddressUnpredictable(predicted, address(brsr));

        // The team allocation was minted into the vesting contract by the constructor above, so
        // the schedule can be written against tokens that are already there.
        vesting.createGrants(beneficiaries, grantAmounts, vestingStart);
    }

    /// Reads every decision back. BRSR cannot be minted twice, so a constructor handed an address
    /// a stale variable named is caught here, in the simulation, before anything is sent.
    function _verify(address deployer) private view {
        IERC20Metadata token = IERC20Metadata(address(brsr));
        _expectUint("brsr.decimals", BRSR_DECIMALS, token.decimals());

        uint256 supply = brsr.TOTAL_SUPPLY();
        _expectUint("brsr.totalSupply", supply, token.totalSupply());
        _expectUint("brsr.TOTAL_SUPPLY", TOTAL_SUPPLY, supply);
        _expectUint("brsr.TEAM_ALLOCATION", TEAM_ALLOCATION, brsr.TEAM_ALLOCATION());

        // The four allocations are constants in the token. Checked against the published split
        // and against the supply they divide, because a constant that drifted would deploy
        // cleanly and be wrong forever.
        _expectShare("community", brsr.COMMUNITY_ALLOCATION(), (supply * COMMUNITY_BPS) / BPS);
        _expectShare("team", brsr.TEAM_ALLOCATION(), (supply * TEAM_BPS) / BPS);
        _expectShare("treasury", brsr.TREASURY_ALLOCATION(), (supply * TREASURY_BPS) / BPS);
        _expectShare("liquidity", brsr.LIQUIDITY_ALLOCATION(), (supply * LIQUIDITY_BPS) / BPS);

        uint256 allocated = brsr.COMMUNITY_ALLOCATION() + brsr.TEAM_ALLOCATION() + brsr.TREASURY_ALLOCATION()
            + brsr.LIQUIDITY_ALLOCATION();
        if (allocated != supply) revert AllocationMismatch(allocated, supply);

        // The invariant that catches a mint gone astray in one read. Anything the token failed to
        // place would be here, in a key that signs from a shell.
        uint256 remaining = token.balanceOf(deployer);
        if (remaining != 0) revert DeployerHoldsSupply(remaining);

        _expectUint("balance.community", brsr.COMMUNITY_ALLOCATION(), token.balanceOf(community));
        _expectUint("balance.treasury", brsr.TREASURY_ALLOCATION(), token.balanceOf(treasury));
        _expectUint("balance.liquidity", brsr.LIQUIDITY_ALLOCATION(), token.balanceOf(liquidity));
        _expectUint("balance.vesting", brsr.TEAM_ALLOCATION(), token.balanceOf(address(vesting)));

        _expect("vesting.token", address(brsr), address(vesting.token()));
        _expect("vesting.admin", timelock, vesting.admin());
        _expect("vesting.pendingAdmin", address(0), vesting.pendingAdmin());
        _expect("vesting.treasury", treasury, vesting.treasury());
        _expect("vesting.deployer", deployer, vesting.deployer());
        // The schedule is a pair of constants in the contract. Read back, because a contract
        // swapped under this script would deploy cleanly and vest on someone else's terms.
        _expectSchedule("vesting.CLIFF", 365 days, vesting.CLIFF());
        _expectSchedule("vesting.DURATION", 1460 days, vesting.DURATION());
        _expectUint("vesting.grantsWritten", 1, vesting.grantsWritten() ? 1 : 0);
        _expectUint("vesting.outstandingWei", brsr.TEAM_ALLOCATION(), vesting.outstandingWei());
        // Every minted team token is spoken for. A remainder would sit here until governance
        // noticed it.
        _expectUint("vesting.unallocatedWei", 0, vesting.unallocatedWei());

        for (uint256 i; i < beneficiaries.length; ++i) {
            Vesting.Grant memory grant = vesting.grantOf(beneficiaries[i]);
            _expectUint("vesting.grant.totalWei", grantAmounts[i], grant.totalWei);
            _expectUint("vesting.grant.start", vestingStart, grant.start);
            _expectUint("vesting.grant.claimedWei", 0, grant.claimedWei);
            _expectUint("vesting.grant.revokedAt", 0, grant.revokedAt);
            // Nothing may be claimable on the day of the deployment. A backdated start that
            // slipped past the range check would show up here as a grant already through its
            // cliff.
            _expectUint("vesting.grant.claimable", 0, vesting.claimableOf(beneficiaries[i]));
        }
    }

    function _record() private {
        _write(K.TREASURY, treasury);
        _write(K.COMMUNITY, community);
        _write(K.LIQUIDITY, liquidity);
        _write(K.BRSR, address(brsr));
        _write(K.VESTING, address(vesting));
        _write(".parameters.Vesting.start", vestingStart);
        _write(".parameters.Vesting.beneficiaries", beneficiaries);
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("AdminTimelock", timelock);
        console2.log("BRSR", address(brsr));
        console2.log("  totalSupply", brsr.TOTAL_SUPPLY());
        console2.log("  community", community);
        console2.log("  liquidity", liquidity);
        console2.log("  treasury", treasury);
        console2.log("Vesting", address(vesting));
        console2.log("  grants", beneficiaries.length);
        console2.log("  start", vestingStart);
        console2.log("Next: DeployStaking.s.sol, which builds the staking pool and the buyback on this token");
    }

    function _expectShare(string memory share, uint256 allocation, uint256 expected) private pure {
        if (allocation != expected) revert AllocationShareWrong(share, allocation, expected);
    }

    function _expectSchedule(string memory what, uint256 expected, uint256 actual) private pure {
        if (expected != actual) revert ScheduleNotApplied(what, expected, actual);
    }
}
