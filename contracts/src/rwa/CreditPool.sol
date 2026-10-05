// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Buyback} from "../token/Buyback.sol";
import {ICreditStaking} from "./interfaces/ICreditStaking.sol";

/// The lender side of the collateral lane: USDG an operator supplies, lent only to mandates
/// that `CollateralVault` has checked against posted collateral.
///
/// Debt. Each mandate owes a scaled amount; the global index grows at the spread rate, so a
/// debt costs `scaled × index`. Nothing else in the protocol borrows, and the only address that
/// can open or close debt is the vault.
///
/// Spread. The rate is `baseRateBps + slopeBps × utilisation`, a year's rate in basis points,
/// and it accrues on the debt. A repayment meets accrued spread before principal, and only
/// spread that has been paid is booked to `reserves` and swept to Staking as USDG rewards. Spread
/// on a debt that ends in a write-off was never paid, so it never reaches stakers out of the
/// lender's cash. The lender earns principal back, not the spread, while the lane runs on
/// operator capital.
///
/// Losses. A write-off books the unpaid debt as `badDebt`. The vault seizes collateral worth the
/// debt at the feed for the lender, as far as the line still holds that much, and the lender
/// carries the rest in USDG. Once Staking names this pool its slasher, the same write-off
/// penalises stakers for that rest alone: the uncovered loss is converted to BRSR at the
/// Buyback's price ceiling, the BRSR price governance restates on chain, and slashed up to the
/// window cap. That BRSR goes to Staking's slash sink and none of it comes back to the lender,
/// who is covered once, in seized collateral, and never a second time out of stake. A ceiling
/// that is unset, or older than the Buyback would trade on, is not a price, and nothing is
/// slashed against it.
///
/// Caps. `totalDebtCap` across all mandates and `perMandateCap` for one, both in USDG.
contract CreditPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_RATE_BPS = 5_000;
    /// One whole BRSR in wei. The ceiling is micro-USD per whole BRSR.
    uint256 internal constant BRSR_UNIT = 1e18;

    /// Why a write-off slashed nothing.
    enum SlashSkip {
        NotSlasher,
        CeilingUnset,
        CeilingStale
    }

    IERC20 public immutable usdg;
    ICreditStaking public immutable staking;
    /// Its price ceiling converts a write-off into BRSR.
    Buyback public immutable buyback;
    address public immutable deployer;

    address public admin;
    address public pendingAdmin;
    /// May take back USDG that is not lent out and not owed to stakers.
    address public lender;
    address public vault;

    uint128 public totalDebtCap;
    uint128 public perMandateCap;
    uint16 public baseRateBps;
    uint16 public slopeBps;

    uint256 public borrowIndex = WAD;
    uint64 public lastAccrual;
    uint256 public totalScaled;
    /// Spread borrowers have paid that is not yet swept to Staking.
    uint256 public reserves;
    /// Debt written off after a position ran out of collateral.
    uint256 public badDebt;
    /// The part of `badDebt` the vault seized collateral for, valued at the feed as it was seized:
    /// what the lender recovers through the vault's seized pots rather than carrying in USDG.
    uint256 public lossCovered;
    uint256 public spreadPaid;

    mapping(address mandate => uint256) public scaledDebtOf;
    /// What each mandate borrowed and has not paid back.
    mapping(address mandate => uint256) public principalOf;

    event VaultBound(address indexed vault);
    event Funded(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);
    event Borrowed(address indexed mandate, address indexed to, uint256 amount, uint256 debt);
    event Repaid(address indexed mandate, address indexed payer, uint256 amount, uint256 debt);
    event WrittenOff(address indexed mandate, uint256 amount, uint256 slashedBrsr);
    /// How a write-off split: `covered` is what seized collateral is worth to the lender at the
    /// feed, `uncovered` the loss the lender carries and stakers are slashed for.
    event WriteOffCovered(address indexed mandate, uint256 covered, uint256 uncovered);
    event SlashSkipped(address indexed mandate, uint256 loss, SlashSkip reason);
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
    error BuybackStakingMismatch(address found, address expected);
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
        address buyback_,
        address admin_,
        address lender_,
        uint128 totalDebtCap_,
        uint128 perMandateCap_,
        uint16 baseRateBps_,
        uint16 slopeBps_
    ) {
        if (
            usdg_ == address(0) || staking_ == address(0) || buyback_ == address(0) || admin_ == address(0)
                || lender_ == address(0)
        ) {
            revert ZeroAddress();
        }
        // A write-off converts at this Buyback's ceiling and slashes this Staking, so the two
        // have to be one deployment's pair.
        address compoundsInto = address(Buyback(buyback_).staking());
        if (compoundsInto != staking_) revert BuybackStakingMismatch(compoundsInto, staking_);
        usdg = IERC20(usdg_);
        staking = ICreditStaking(staking_);
        buyback = Buyback(buyback_);
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
        principalOf[mandate] += amount;

        debt = debtOf(mandate);
        if (debt > perMandateCap) revert MandateCapExceeded(debt, perMandateCap);
        uint256 all = totalDebt();
        if (all > totalDebtCap) revert TotalCapExceeded(all, totalDebtCap);

        usdg.safeTransfer(to, amount);
        emit Borrowed(mandate, to, amount, debt);
    }

    /// Clears what a liquidation could not cover once the position holds nothing more to sell.
    /// The debt stops accruing here. The spread in it was never paid, so none of it was booked.
    /// `coveredAtFeed` is what the vault seizes for the lender against this debt, valued at the
    /// feed; it is cut to the debt. The lender carries the rest in USDG, and stakers are slashed
    /// for that rest alone, so a loss the collateral covers is never made good twice, once in
    /// seized stock and once in stake.
    function writeOff(address mandate, uint256 coveredAtFeed) external onlyVault nonReentrant returns (uint256 amount) {
        _accrue();
        uint256 scaled = scaledDebtOf[mandate];
        if (scaled == 0) return 0;
        amount = Math.mulDiv(scaled, borrowIndex, WAD, Math.Rounding.Ceil);
        scaledDebtOf[mandate] = 0;
        principalOf[mandate] = 0;
        totalScaled -= scaled;
        badDebt += amount;
        uint256 covered = coveredAtFeed > amount ? amount : coveredAtFeed;
        uint256 uncovered = amount - covered;
        lossCovered += covered;
        emit WriteOffCovered(mandate, covered, uncovered);
        // A loss the seized collateral covers in full takes no stake.
        // slither-disable-next-line incorrect-equality
        uint256 slashedBrsr = uncovered == 0 ? 0 : _slash(mandate, uncovered);
        emit WrittenOff(mandate, amount, slashedBrsr);
    }

    /// Pays down `mandate`'s debt from the caller's USDG. Takes at most what is owed.
    function repay(address mandate, uint256 amount) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        uint256 scaled = scaledDebtOf[mandate];
        if (scaled == 0) revert NoDebt(mandate);
        uint256 owed = Math.mulDiv(scaled, borrowIndex, WAD, Math.Rounding.Ceil);

        uint256 burn;
        uint256 principal = principalOf[mandate];
        uint256 toPrincipal;
        if (amount >= owed) {
            paid = owed;
            burn = scaled;
            toPrincipal = principal;
        } else {
            paid = amount;
            burn = Math.mulDiv(amount, WAD, borrowIndex);
            // Spread first. Measured against the debt rounded down, principal never reads above
            // what is owed.
            uint256 debt = Math.mulDiv(scaled, borrowIndex, WAD);
            uint256 spread = debt > principal ? debt - principal : 0;
            toPrincipal = paid > spread ? paid - spread : 0;
        }
        scaledDebtOf[mandate] = scaled - burn;
        totalScaled -= burn;
        principalOf[mandate] = principal - toPrincipal;
        reserves += paid - toPrincipal;

        usdg.safeTransferFrom(msg.sender, address(this), paid);
        emit Repaid(mandate, msg.sender, paid, debtOf(mandate));
    }

    /// Sends the accrued spread to Staking, where it is paid to stakers as USDG. Reverts inside
    /// Staking until governance names this pool as `creditManager`.
    function sweepSpread() external nonReentrant returns (uint256 amount) {
        _accrue();
        uint256 held = usdg.balanceOf(address(this));
        amount = reserves < held ? reserves : held;
        // No spread is booked, or there is no balance to pay it from.
        // slither-disable-next-line incorrect-equality
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

    function debtOf(address mandate) public view returns (uint256) {
        uint256 scaled = scaledDebtOf[mandate];
        // No line is open. Scaled debt is a ledger entry and not a balance.
        // slither-disable-next-line incorrect-equality
        if (scaled == 0) return 0;
        return Math.mulDiv(scaled, currentIndex(), WAD, Math.Rounding.Ceil);
    }

    function totalDebt() public view returns (uint256) {
        return Math.mulDiv(totalScaled, currentIndex(), WAD, Math.Rounding.Ceil);
    }

    /// USDG that can be lent: the balance less the spread owed to stakers.
    function cash() public view returns (uint256) {
        uint256 held = usdg.balanceOf(address(this));
        return held > reserves ? held - reserves : 0;
    }

    /// Debt over debt plus cash, in basis points.
    function utilisationBps() public view returns (uint256) {
        uint256 d = Math.mulDiv(totalScaled, borrowIndex, WAD);
        uint256 held = usdg.balanceOf(address(this));
        uint256 c = held > reserves ? held - reserves : 0;
        // Nothing is lent, and with the pool empty as well the division below would be by zero.
        // slither-disable-next-line incorrect-equality
        if (d == 0) return 0;
        return Math.mulDiv(d, BPS, d + c);
    }

    /// The spread a borrower pays right now, as a year's rate in basis points.
    function rateBps() public view returns (uint256) {
        return baseRateBps + Math.mulDiv(slopeBps, utilisationBps(), BPS);
    }

    function currentIndex() public view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        // No time has passed, or there is no debt for it to have accrued on.
        // slither-disable-next-line incorrect-equality
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

    function _accrue() private {
        // Already accrued in this block. `lastAccrual` is only ever set to a block's own time.
        // slither-disable-next-line incorrect-equality
        if (block.timestamp == lastAccrual) return;
        if (totalScaled != 0) borrowIndex = currentIndex();
        lastAccrual = uint64(block.timestamp);
    }

    /// Slashes stakers for `loss`, converted to BRSR at the Buyback's ceiling. USDG has six
    /// decimals, so the loss is already in micro-USD, and the quotient is rounded down. Staking
    /// takes no more than its slash allowance.
    function _slash(address mandate, uint256 loss) private returns (uint256) {
        if (!_isSlasher()) return _skipSlash(mandate, loss, SlashSkip.NotSlasher);
        uint256 ceiling = buyback.params().maxPriceMicroUsdPerBrsr;
        if (ceiling == 0) return _skipSlash(mandate, loss, SlashSkip.CeilingUnset);
        if (block.timestamp > buyback.ceilingSetAt() + buyback.maxCeilingAge()) {
            return _skipSlash(mandate, loss, SlashSkip.CeilingStale);
        }
        return staking.slash(Math.mulDiv(loss, BRSR_UNIT, ceiling));
    }

    /// The first Staking deployment has no slasher role. Asked there, the call reverts, and the
    /// write-off goes ahead without a slash rather than failing.
    function _isSlasher() private view returns (bool) {
        try staking.slasher() returns (address slasher) {
            return slasher == address(this);
        } catch {
            return false;
        }
    }

    function _skipSlash(address mandate, uint256 loss, SlashSkip reason) private returns (uint256) {
        emit SlashSkipped(mandate, loss, reason);
        return 0;
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
