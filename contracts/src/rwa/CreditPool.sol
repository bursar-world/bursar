// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// The part of Staking the pool calls. `distribute` only accepts the address governance named
/// as `creditManager`.
interface ICreditStaking {
    function creditManager() external view returns (address);
    function distribute(uint256 amount) external;
}

/// The lender side of the collateral lane: USDG an operator supplies, lent only to mandates
/// that `CollateralVault` has checked against posted collateral.
///
/// Debt. Each mandate owes a scaled amount; the global index grows at the spread rate, so a
/// debt costs `scaled × index`. Nothing else in the protocol borrows, and the only address that
/// can open or close debt is the vault.
///
/// Spread. The rate is `baseRateBps + slopeBps × utilisation`, a year's rate in basis points.
/// All of it is booked to `reserves` and swept to Staking as USDG rewards. The lender earns
/// principal back, not the spread, while the lane runs on operator capital.
///
/// Caps. `totalDebtCap` across all mandates and `perMandateCap` for one, both in USDG.
contract CreditPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_RATE_BPS = 5_000;

    IERC20 public immutable usdg;
    ICreditStaking public immutable staking;
    address public immutable deployer;

    address public admin;
    address public pendingAdmin;
    /// May take back the USDG it supplied that is not lent out and not owed to stakers.
    address public lender;
    address public vault;

    uint128 public totalDebtCap;
    uint128 public perMandateCap;
    uint16 public baseRateBps;
    uint16 public slopeBps;

    uint256 public borrowIndex = WAD;
    uint64 public lastAccrual;
    uint256 public totalScaled;
    /// Spread earned and not yet swept to Staking.
    uint256 public reserves;
    /// Debt written off after a position ran out of collateral.
    uint256 public badDebt;
    uint256 public spreadPaid;

    mapping(address mandate => uint256) public scaledDebtOf;

    event VaultBound(address indexed vault);
    event Funded(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event Borrowed(address indexed mandate, address indexed to, uint256 amount, uint256 debt);
    event Repaid(address indexed mandate, address indexed payer, uint256 amount, uint256 debt);
    event WrittenOff(address indexed mandate, uint256 amount);
    event SpreadSwept(uint256 amount);
    event CapsSet(uint128 totalDebtCap, uint128 perMandateCap);
    event RatesSet(uint16 baseRateBps, uint16 slopeBps);
    event LenderSet(address indexed lender);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotPendingAdmin();
    error NotDeployer();
    error NotVault();
    error NotLender();
    error ZeroAddress();
    error ZeroAmount();
    error BadRates();
    error TotalCapExceeded(uint256 debt, uint256 cap);
    error MandateCapExceeded(uint256 debt, uint256 cap);
    error InsufficientCash(uint256 cash, uint256 needed);
    error NoDebt(address mandate);
    error NothingToSweep();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(
        address usdg_,
        address staking_,
        address admin_,
        address lender_,
        uint128 totalDebtCap_,
        uint128 perMandateCap_,
        uint16 baseRateBps_,
        uint16 slopeBps_
    ) {
        if (usdg_ == address(0) || staking_ == address(0) || admin_ == address(0) || lender_ == address(0)) {
            revert ZeroAddress();
        }
        usdg = IERC20(usdg_);
        staking = ICreditStaking(staking_);
        admin = admin_;
        lender = lender_;
        deployer = msg.sender;
        lastAccrual = uint64(block.timestamp);
        _setCaps(totalDebtCap_, perMandateCap_);
        _setRates(baseRateBps_, slopeBps_);
        emit AdminTransferred(address(0), admin_);
        emit LenderSet(lender_);
    }

    /// The vault takes this pool's address in its constructor, so it exists only after the pool.
    /// The deployer binds it once; nothing can rebind it.
    function bindVault(address vault_) external {
        if (msg.sender != deployer || vault != address(0)) revert NotDeployer();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultBound(vault_);
    }

    // --- lender ---

    /// Anyone can add USDG to lend. Only `lender` can take unlent USDG back out.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function withdrawLiquidity(address to, uint256 amount) external nonReentrant {
        if (msg.sender != lender) revert NotLender();
        _accrue();
        uint256 c = cash();
        if (amount > c) revert InsufficientCash(c, amount);
        usdg.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    // --- vault ---

    function borrow(address mandate, uint256 amount, address to)
        external
        onlyVault
        nonReentrant
        returns (uint256 debt)
    {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        uint256 c = cash();
        if (amount > c) revert InsufficientCash(c, amount);

        uint256 scaled = Math.mulDiv(amount, WAD, borrowIndex, Math.Rounding.Ceil);
        scaledDebtOf[mandate] += scaled;
        totalScaled += scaled;

        debt = debtOf(mandate);
        if (debt > perMandateCap) revert MandateCapExceeded(debt, perMandateCap);
        uint256 all = totalDebt();
        if (all > totalDebtCap) revert TotalCapExceeded(all, totalDebtCap);

        usdg.safeTransfer(to, amount);
        emit Borrowed(mandate, to, amount, debt);
    }

    /// Clears what a liquidation could not cover once the position holds nothing more to sell.
    function writeOff(address mandate) external onlyVault returns (uint256 amount) {
        _accrue();
        uint256 scaled = scaledDebtOf[mandate];
        if (scaled == 0) return 0;
        amount = Math.mulDiv(scaled, borrowIndex, WAD, Math.Rounding.Ceil);
        scaledDebtOf[mandate] = 0;
        totalScaled -= scaled;
        badDebt += amount;
        emit WrittenOff(mandate, amount);
    }

    // --- anyone ---

    /// Pays down `mandate`'s debt from the caller's USDG. Takes at most what is owed.
    function repay(address mandate, uint256 amount) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        uint256 scaled = scaledDebtOf[mandate];
        if (scaled == 0) revert NoDebt(mandate);
        uint256 owed = Math.mulDiv(scaled, borrowIndex, WAD, Math.Rounding.Ceil);

        uint256 burn;
        if (amount >= owed) {
            paid = owed;
            burn = scaled;
        } else {
            paid = amount;
            burn = Math.mulDiv(amount, WAD, borrowIndex);
        }
        scaledDebtOf[mandate] = scaled - burn;
        totalScaled -= burn;

        usdg.safeTransferFrom(msg.sender, address(this), paid);
        emit Repaid(mandate, msg.sender, paid, debtOf(mandate));
    }

    /// Sends the accrued spread to Staking, where it is paid to stakers as USDG. Reverts inside
    /// Staking until governance names this pool as `creditManager`.
    function sweepSpread() external nonReentrant returns (uint256 amount) {
        _accrue();
        uint256 held = usdg.balanceOf(address(this));
        amount = reserves < held ? reserves : held;
        if (amount == 0) revert NothingToSweep();
        reserves -= amount;
        spreadPaid += amount;
        usdg.forceApprove(address(staking), amount);
        staking.distribute(amount);
        emit SpreadSwept(amount);
    }

    function accrue() external {
        _accrue();
    }

    // --- admin ---

    function setCaps(uint128 totalDebtCap_, uint128 perMandateCap_) external onlyAdmin {
        _setCaps(totalDebtCap_, perMandateCap_);
    }

    function setRates(uint16 baseRateBps_, uint16 slopeBps_) external onlyAdmin {
        _accrue();
        _setRates(baseRateBps_, slopeBps_);
    }

    function setLender(address lender_) external onlyAdmin {
        if (lender_ == address(0)) revert ZeroAddress();
        lender = lender_;
        emit LenderSet(lender_);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // --- reads ---

    function debtOf(address mandate) public view returns (uint256) {
        uint256 scaled = scaledDebtOf[mandate];
        if (scaled == 0) return 0;
        return Math.mulDiv(scaled, currentIndex(), WAD, Math.Rounding.Ceil);
    }

    function totalDebt() public view returns (uint256) {
        return Math.mulDiv(totalScaled, currentIndex(), WAD, Math.Rounding.Ceil);
    }

    /// USDG that can be lent: the balance less the spread owed to stakers.
    function cash() public view returns (uint256) {
        uint256 held = usdg.balanceOf(address(this));
        uint256 r = reserves + _pendingInterest();
        return held > r ? held - r : 0;
    }

    /// Debt over debt plus cash, in basis points.
    function utilisationBps() public view returns (uint256) {
        uint256 d = Math.mulDiv(totalScaled, borrowIndex, WAD);
        uint256 held = usdg.balanceOf(address(this));
        uint256 c = held > reserves ? held - reserves : 0;
        if (d == 0) return 0;
        return Math.mulDiv(d, BPS, d + c);
    }

    /// The spread a borrower pays right now, as a year's rate in basis points.
    function rateBps() public view returns (uint256) {
        return baseRateBps + Math.mulDiv(slopeBps, utilisationBps(), BPS);
    }

    function currentIndex() public view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || totalScaled == 0) return borrowIndex;
        return borrowIndex + Math.mulDiv(borrowIndex, rateBps() * dt, BPS * YEAR);
    }

    /// Remaining room for one mandate and for the pool, whichever binds first, and the cash.
    function capacityFor(address mandate) external view returns (uint256) {
        uint256 d = debtOf(mandate);
        uint256 all = totalDebt();
        uint256 m = d >= perMandateCap ? 0 : perMandateCap - d;
        uint256 t = all >= totalDebtCap ? 0 : totalDebtCap - all;
        uint256 c = cash();
        return Math.min(Math.min(m, t), c);
    }

    // --- internals ---

    function _pendingInterest() private view returns (uint256) {
        if (totalScaled == 0) return 0;
        uint256 idx = currentIndex();
        return Math.mulDiv(totalScaled, idx - borrowIndex, WAD);
    }

    function _accrue() private {
        if (block.timestamp == lastAccrual) return;
        if (totalScaled != 0) {
            uint256 idx = currentIndex();
            reserves += Math.mulDiv(totalScaled, idx - borrowIndex, WAD);
            borrowIndex = idx;
        }
        lastAccrual = uint64(block.timestamp);
    }

    function _setCaps(uint128 t, uint128 m) private {
        if (t == 0 || m == 0 || m > t) revert BadRates();
        totalDebtCap = t;
        perMandateCap = m;
        emit CapsSet(t, m);
    }

    function _setRates(uint16 base, uint16 slope) private {
        if (uint256(base) + slope > MAX_RATE_BPS) revert BadRates();
        baseRateBps = base;
        slopeBps = slope;
        emit RatesSet(base, slope);
    }
}
