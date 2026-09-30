// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateAccount} from "../interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../interfaces/IMandateAccountFactory.sol";
import {IParkAsset} from "./interfaces/IParkAsset.sol";
import {ITreasuryPark} from "./interfaces/ITreasuryPark.sol";

/// Receives USDG a principal moves out of a mandate for parking. One per mandate, at an address
/// `TreasuryPark.vaultOf` predicts, so USDG sent here can only ever be parked for that mandate or
/// returned to it.
contract ParkVault {
    using SafeERC20 for IERC20;

    address public immutable park;

    error NotPark();

    constructor() {
        park = msg.sender;
    }

    function sweep(address token, address to, uint256 amount) external {
        if (msg.sender != park) revert NotPark();
        IERC20(token).safeTransfer(to, amount);
    }
}

/// The treasury lane: holds the idle part of a mandate's budget in a registered treasury token
/// and turns it back into USDG when the mandate needs to pay.
///
/// Parking. The principal sends USDG from the mandate to `vaultOf(mandate)` with the mandate's
/// own `withdraw`, then calls `park`. Only the amount above the principal's buffer can go: the
/// mandate has to keep at least `buffer(mandate)` in USDG after the move, so spending keeps
/// working while the market is closed and the treasury price is not trading. Only a mandate one
/// of `factories` created can park; any other contract that answers `principal()` would book
/// against the caps every mandate shares.
///
/// Value. A position counts at raw × feed, less the asset's haircut, and only while the price
/// guard calls it fresh: the feed inside the asset's valuation bound, the token, its oracle and
/// the access registry unpaused, and the pinned pool inside its band of the feed. Otherwise the
/// position counts zero. No yield or projected return enters any figure here.
///
/// Unparking. The principal or the agent can sell a position back to USDG, delivered to the
/// mandate. A mandate account that knows this contract calls `unparkFor` from inside a spend
/// when its USDG balance is short, and the spend settles in the same transaction. Disabling an
/// adapter stops new parks in it and leaves every way out open: the money in it is still the
/// mandate's.
contract TreasuryPark is ITreasuryPark, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    struct Position {
        uint128 raw;
        /// USDG put in, less the share of it that has been unparked. Caps are measured on this.
        uint128 basis;
    }

    IERC20 public immutable usdg;
    address public immutable deployer;

    address public admin;
    address public pendingAdmin;

    address[] private _adapters;
    IMandateAccountFactory[] private _factories;
    mapping(address adapter => bool) public isAdapter;
    mapping(address mandate => mapping(address adapter => Position)) private _positions;
    mapping(address adapter => uint256) public totalBasis;
    mapping(address mandate => uint128) public buffer;

    event AdapterSet(address indexed adapter, bool enabled);
    event BufferSet(address indexed mandate, uint128 buffer);
    event Parked(address indexed mandate, address indexed adapter, uint256 usdgIn, uint256 rawOut);
    event Unparked(address indexed mandate, address indexed adapter, uint256 rawIn, uint256 usdgOut);
    event IdleReturned(address indexed mandate, uint256 amount);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotPendingAdmin();
    error NotDeployer();
    error NotOperator();
    error NotPrincipal();
    error NotFactoryAccount(address mandate);
    error UnknownAdapter(address adapter);
    error ZeroAmount();
    error VaultShort(uint256 held, uint256 needed);
    error BelowBuffer(uint256 balance, uint256 buffer);
    error MandateCapExceeded(uint256 basis, uint256 cap);
    error TotalCapExceeded(uint256 basis, uint256 cap);
    error PositionShort(uint256 raw, uint256 needed);
    error NothingToUnpark(uint256 needed);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address usdg_, address admin_, IMandateAccountFactory[] memory factories_) {
        usdg = IERC20(usdg_);
        admin = admin_;
        deployer = msg.sender;
        _factories = factories_;
        emit AdminTransferred(address(0), admin_);
    }

    // --- wiring and admin ---

    /// The adapters take this contract's address in their constructors, so they exist only
    /// after it does. The deployer lists them once; every later change is the admin's.
    function initAdapters(address[] calldata list) external {
        if (msg.sender != deployer || _adapters.length != 0) revert NotDeployer();
        for (uint256 i; i < list.length; ++i) {
            _setAdapter(list[i], true);
        }
    }

    function setAdapter(address adapter, bool enabled) external onlyAdmin {
        _setAdapter(adapter, enabled);
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // --- principal ---

    function setBuffer(address mandate, uint128 amount) external {
        if (msg.sender != IMandateAccount(mandate).principal()) revert NotPrincipal();
        buffer[mandate] = amount;
        emit BufferSet(mandate, amount);
    }

    function park(address mandate, address adapter, uint256 usdgIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 rawOut)
    {
        _onlyOperator(mandate);
        if (!_fromFactory(mandate)) revert NotFactoryAccount(mandate);
        if (!isAdapter[adapter]) revert UnknownAdapter(adapter);
        if (usdgIn == 0) revert ZeroAmount();

        address vault = _vault(mandate);
        uint256 held = usdg.balanceOf(vault);
        if (held < usdgIn) revert VaultShort(held, usdgIn);

        uint256 liquid = usdg.balanceOf(mandate);
        if (liquid < buffer[mandate]) revert BelowBuffer(liquid, buffer[mandate]);

        _book(mandate, adapter, usdgIn);
        ParkVault(vault).sweep(address(usdg), adapter, usdgIn);
        rawOut = IParkAsset(adapter).acquire(usdgIn, minOut, mandate);
        _positions[mandate][adapter].raw += uint128(rawOut);

        emit Parked(mandate, adapter, usdgIn, rawOut);
    }

    function unpark(address mandate, address adapter, uint256 raw, uint256 minUsdg)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        if (msg.sender != mandate) _onlyOperator(mandate);
        if (raw == 0) revert ZeroAmount();
        Position storage p = _positions[mandate][adapter];
        if (p.raw < raw) revert PositionShort(p.raw, raw);

        _reduce(adapter, p, raw);
        usdgOut = IParkAsset(adapter).release(raw, minUsdg, mandate, mandate);

        emit Unparked(mandate, adapter, raw, usdgOut);
    }

    /// Called by a mandate account inside a spend. Sells positions in adapter order until the
    /// shortfall is covered: exactly the remainder from a position worth more, the whole position
    /// at market from one worth less, since a pool that fills under the feed never returns a
    /// position's full feed value. An adapter that cannot sell right now is passed over, so SGOV
    /// out of its trade bound on a Sunday leaves the USDG reserve to pay instead of failing the
    /// spend.
    function unparkFor(uint256 usdgNeeded) external override nonReentrant {
        address mandate = msg.sender;
        uint256 left = usdgNeeded;
        uint256 n = _adapters.length;
        for (uint256 i; i < n && left != 0; ++i) {
            address adapter = _adapters[i];
            Position storage p = _positions[mandate][adapter];
            if (p.raw == 0) continue;

            (uint256 worth,,, bool fresh) = IParkAsset(adapter).value(p.raw);
            if (!fresh || worth == 0) continue;

            (uint256 rawIn, uint256 usdgOut) = _release(adapter, mandate, p.raw, worth > left ? left : 0);
            if (rawIn == 0) continue;
            _reduce(adapter, p, rawIn);
            left = usdgOut < left ? left - usdgOut : 0;

            emit Unparked(mandate, adapter, rawIn, usdgOut);
        }
        if (left != 0) revert NothingToUnpark(left);
    }

    /// Sends USDG sitting in the mandate's vault back to the mandate.
    function returnIdle(address mandate) external nonReentrant {
        _onlyOperator(mandate);
        address vault = _vault(mandate);
        uint256 held = usdg.balanceOf(vault);
        if (held == 0) revert ZeroAmount();
        ParkVault(vault).sweep(address(usdg), mandate, held);
        emit IdleReturned(mandate, held);
    }

    // --- reads ---

    function adapters() external view returns (address[] memory) {
        return _adapters;
    }

    function factories() external view returns (IMandateAccountFactory[] memory) {
        return _factories;
    }

    function vaultOf(address mandate) public view returns (address) {
        return Create2.computeAddress(bytes32(uint256(uint160(mandate))), keccak256(type(ParkVault).creationCode));
    }

    function position(address mandate, address adapter)
        external
        view
        returns (uint256 raw, uint256 basis, uint256 value, uint256 priceE8, uint256 updatedAt, bool fresh)
    {
        Position memory p = _positions[mandate][adapter];
        raw = p.raw;
        basis = p.basis;
        (value, priceE8, updatedAt, fresh) = IParkAsset(adapter).value(raw);
    }

    /// Parked value at raw × feed, fresh positions only, before the haircut.
    function parkedValue(address mandate) public view returns (uint256 total, uint256 counted) {
        uint256 n = _adapters.length;
        for (uint256 i; i < n; ++i) {
            address adapter = _adapters[i];
            uint256 raw = _positions[mandate][adapter].raw;
            if (raw == 0) continue;
            (uint256 v,,, bool fresh) = IParkAsset(adapter).value(raw);
            if (!fresh) continue;
            total += v;
            counted += Math.mulDiv(v, BPS - IParkAsset(adapter).haircutBps(), BPS);
        }
    }

    /// USDG the mandate holds, plus USDG waiting in its vault, plus fresh parked value after the
    /// haircut. Never counts a stale position.
    function spendingPower(address mandate) external view returns (uint256) {
        (, uint256 counted) = parkedValue(mandate);
        return usdg.balanceOf(mandate) + usdg.balanceOf(vaultOf(mandate)) + counted;
    }

    // --- internals ---

    /// Sells `exact` USDG out of the position when that is set, falling back to the whole position
    /// at market when the position turns out too small for it. Zeros mean the adapter could not
    /// trade (a stale trade price, a paused token, a pool outside its band) and the caller moves
    /// on to the next one.
    function _release(address adapter, address mandate, uint256 raw, uint256 exact)
        private
        returns (uint256 rawIn, uint256 usdgOut)
    {
        if (exact != 0) {
            try IParkAsset(adapter).releaseExact(exact, raw, mandate, mandate) returns (uint256 spent) {
                return (spent, exact);
            } catch {}
        }
        try IParkAsset(adapter).release(raw, 0, mandate, mandate) returns (uint256 out) {
            return (raw, out);
        } catch {}
    }

    function _book(address mandate, address adapter, uint256 usdgIn) private {
        Position storage p = _positions[mandate][adapter];
        (uint128 perMandate, uint128 total) = IParkAsset(adapter).caps();
        uint256 basis = uint256(p.basis) + usdgIn;
        if (basis > perMandate) revert MandateCapExceeded(basis, perMandate);
        uint256 all = totalBasis[adapter] + usdgIn;
        if (all > total) revert TotalCapExceeded(all, total);
        p.basis = uint128(basis);
        totalBasis[adapter] = all;
    }

    function _reduce(address adapter, Position storage p, uint256 raw) private {
        uint256 cut = Math.mulDiv(p.basis, raw, p.raw, Math.Rounding.Ceil);
        if (cut > p.basis) cut = p.basis;
        p.raw -= uint128(raw);
        p.basis -= uint128(cut);
        totalBasis[adapter] -= cut;
    }

    /// The test `CollateralVault.openLine` applies: the mandate is on its principal's list at one
    /// of the known factories.
    function _fromFactory(address mandate) private view returns (bool) {
        address principal = IMandateAccount(mandate).principal();
        uint256 n = _factories.length;
        for (uint256 i; i < n; ++i) {
            address[] memory list = _factories[i].accountsOf(principal);
            for (uint256 j; j < list.length; ++j) {
                if (list[j] == mandate) return true;
            }
        }
        return false;
    }

    function _onlyOperator(address mandate) private view {
        if (msg.sender != IMandateAccount(mandate).principal() && msg.sender != IMandateAccount(mandate).agent()) {
            revert NotOperator();
        }
    }

    function _vault(address mandate) private returns (address vault) {
        vault = vaultOf(mandate);
        if (vault.code.length == 0) new ParkVault{salt: bytes32(uint256(uint160(mandate)))}();
    }

    function _setAdapter(address adapter, bool enabled) private {
        if (!isAdapter[adapter] && enabled) {
            bool known;
            for (uint256 i; i < _adapters.length; ++i) {
                if (_adapters[i] == adapter) known = true;
            }
            if (!known) _adapters.push(adapter);
        }
        isAdapter[adapter] = enabled;
        emit AdapterSet(adapter, enabled);
    }
}
