// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// The team allocation, released over four years behind a one-year cliff.
///
/// BRSR mints the team's tenth of the supply straight to this address, so the tokens are here
/// before anyone can promise them. The schedule is a pair of constants, not a parameter: it is
/// the term the allocation was published under, and a term governance can shorten is not a
/// lock-up. Nothing vests in the first year. At the cliff a quarter becomes
/// claimable in one step, and the rest accrues every second until the four years are up.
///
/// The grant set is written once, by the address that deployed this contract, in the
/// deployment run, and it closes behind that call. A later cohort gets its own deployment,
/// never a door left open in this one.
///
/// ## Revocation
///
/// Only the timelock can revoke, and a revocation stops the clock rather than reversing it.
/// Everything vested up to the moment of the call stays the beneficiary's and stays claimable
/// for as long as they care to wait; the unvested remainder returns to the treasury. Someone
/// who leaves in year three keeps three years and loses the fourth, which is what a schedule
/// is for. Pulling back what has already vested would make the schedule advisory, and this
/// contract has no path that does it.
///
/// Revocation is one-way. There is no reinstatement, and the timelock's delay sits in front of
/// a call that cannot be taken back. That is where a delay is worth having.
///
/// A grant is bound to the address it was written for and cannot be moved. Losing the key
/// loses the grant. The alternative, an address the beneficiary can change, is a second way
/// to take the allocation and it points at whoever holds the key today.
contract Vesting is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Counted in days, not calendar years: four 365-day years is 1,460 days, which lands
    /// about a leap day short of the fourth anniversary. Stating it in days is what
    /// makes the arithmetic here agree with what an operator computes off chain.
    uint64 public constant CLIFF = 365 days;
    uint64 public constant DURATION = 1460 days;

    struct Grant {
        /// BRSR wei. A revocation rewrites this to the amount vested at the moment of the
        /// call, which is what lets every read below stay correct afterwards without a second
        /// branch in the arithmetic.
        uint128 totalWei;
        uint128 claimedWei;
        uint64 start;
        /// Zero while the grant is live.
        uint64 revokedAt;
    }

    // forge-lint: disable-start(screaming-snake-case-immutable)
    IERC20 public immutable token;
    address public immutable deployer;

    /// Where a revoked remainder and any unallocated surplus go. Fixed at construction, so a
    /// revocation cannot be turned into a transfer to an address the caller picked.
    address public immutable treasury;
    // forge-lint: disable-end

    address public admin;
    address public pendingAdmin;

    /// True once `createGrants` has run. `sealed` is a reserved word.
    bool public grantsWritten;

    /// Every live grant, less what has been claimed against it. The balance covers this at
    /// all times and the difference is the unallocated surplus.
    uint128 public outstandingWei;

    mapping(address beneficiary => Grant grant) private _grants;

    event GrantCreated(address indexed beneficiary, uint128 totalWei, uint64 start);
    event Claimed(address indexed beneficiary, uint128 amountWei);
    event Revoked(address indexed beneficiary, uint128 vestedWei, uint128 forfeitedWei);
    event Swept(uint256 amountWei);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error ZeroAddress();
    error NotAdmin();
    error NotDeployer();
    error NotAuthorized();
    error AlreadyWritten();
    error LengthMismatch(uint256 beneficiaries, uint256 amounts);
    error NoGrants();
    error ZeroAmount();
    error DuplicateBeneficiary(address beneficiary);
    error StartIsZero();
    error Underfunded(uint256 required, uint256 held);
    error NoGrant(address beneficiary);
    error NothingToClaim();
    error AlreadyRevoked(address beneficiary);
    error NothingUnallocated();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address token_, address admin_, address treasury_) {
        if (token_ == address(0) || admin_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        token = IERC20(token_);
        deployer = msg.sender;
        treasury = treasury_;
        admin = admin_;

        emit AdminTransferred(address(0), admin_);
    }

    /// Writes the whole grant set in one call, from the deploying address, and closes the set
    /// behind it. The tokens have to be here already: a grant this contract cannot pay is a
    /// promise, and the reason to have a contract at all is that it is not one.
    ///
    /// One `start` covers every grant. The allocation has a single vesting commencement date,
    /// and per-grant dates would be an invitation to reopen the set one beneficiary at a time.
    function createGrants(address[] calldata beneficiaries, uint128[] calldata amountsWei, uint64 start) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (grantsWritten) revert AlreadyWritten();
        if (beneficiaries.length != amountsWei.length) {
            revert LengthMismatch(beneficiaries.length, amountsWei.length);
        }
        if (beneficiaries.length == 0) revert NoGrants();
        // A zero start puts the cliff at the epoch and vests everything in the first block,
        // and it is also exactly what an unset environment variable looks like.
        if (start == 0) revert StartIsZero();

        grantsWritten = true;

        uint256 total;
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            uint128 amount = amountsWei[i];

            if (beneficiary == address(0)) revert ZeroAddress();
            if (amount == 0) revert ZeroAmount();
            if (_grants[beneficiary].start != 0) revert DuplicateBeneficiary(beneficiary);

            _grants[beneficiary] = Grant({totalWei: amount, claimedWei: 0, start: start, revokedAt: 0});
            total += amount;

            emit GrantCreated(beneficiary, amount, start);
        }

        uint256 held = token.balanceOf(address(this));
        if (held < total) revert Underfunded(total, held);

        // forge-lint: disable-next-line(unsafe-typecast)
        outstandingWei = uint128(total);
    }

    function claim() external nonReentrant returns (uint128 amountWei) {
        Grant storage grant = _grants[msg.sender];
        if (grant.start == 0) revert NoGrant(msg.sender);

        uint128 vested = _vested(grant);
        amountWei = vested - grant.claimedWei;
        if (amountWei == 0) revert NothingToClaim();

        grant.claimedWei = vested;
        outstandingWei -= amountWei;

        token.safeTransfer(msg.sender, amountWei);

        emit Claimed(msg.sender, amountWei);
    }

    /// Stops the clock and returns the unvested remainder to the treasury. What has already
    /// vested is untouched and stays claimable, claimed or not.
    function revoke(address beneficiary) external onlyAdmin nonReentrant returns (uint128 forfeitedWei) {
        Grant storage grant = _grants[beneficiary];
        if (grant.start == 0) revert NoGrant(beneficiary);
        if (grant.revokedAt != 0) revert AlreadyRevoked(beneficiary);

        uint128 vested = _vested(grant);
        forfeitedWei = grant.totalWei - vested;

        // Collapsing the total onto the vested amount is what freezes the schedule. From here
        // `_vested` returns this number at every future timestamp, so nothing keeps accruing
        // and nothing already earned is taken.
        grant.totalWei = vested;
        // forge-lint: disable-next-line(unsafe-typecast)
        grant.revokedAt = uint64(block.timestamp);

        if (forfeitedWei != 0) {
            outstandingWei -= forfeitedWei;
            token.safeTransfer(treasury, forfeitedWei);
        }

        emit Revoked(beneficiary, vested, forfeitedWei);
    }

    /// Returns tokens held here beyond what is owed. Reachable only through the timelock, and
    /// only for the surplus: the balance backing live grants is not sweepable at any point in
    /// the schedule.
    function sweep() external onlyAdmin nonReentrant returns (uint256 amountWei) {
        amountWei = token.balanceOf(address(this)) - outstandingWei;
        if (amountWei == 0) revert NothingUnallocated();

        token.safeTransfer(treasury, amountWei);

        emit Swept(amountWei);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(msg.sender, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function grantOf(address beneficiary) external view returns (Grant memory) {
        return _grants[beneficiary];
    }

    function vestedOf(address beneficiary) external view returns (uint128) {
        return _vested(_grants[beneficiary]);
    }

    function claimableOf(address beneficiary) external view returns (uint128) {
        Grant memory grant = _grants[beneficiary];
        return _vested(grant) - grant.claimedWei;
    }

    /// When the first tokens become claimable and when the last of them do. Both zero for an
    /// address with no grant.
    function scheduleOf(address beneficiary) external view returns (uint64 cliffAt, uint64 endsAt) {
        uint64 start = _grants[beneficiary].start;
        if (start == 0) return (0, 0);
        return (start + CLIFF, start + DURATION);
    }

    function unallocatedWei() external view returns (uint256) {
        return token.balanceOf(address(this)) - outstandingWei;
    }

    function _vested(Grant memory grant) private view returns (uint128) {
        if (grant.start == 0) return 0;
        // A revocation already rewrote the total to what had vested, so the frozen schedule
        // needs no clock of its own.
        if (grant.revokedAt != 0) return grant.totalWei;
        if (block.timestamp < grant.start + CLIFF) return 0;

        uint256 elapsed = block.timestamp - grant.start;
        if (elapsed >= DURATION) return grant.totalWei;

        // The cliff gates the same straight line and carves no tranche out of it: at
        // exactly one year this is a quarter of the grant, and it has been accruing per second
        // since the start date whether or not it could be claimed.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((uint256(grant.totalWei) * elapsed) / DURATION);
    }
}
