// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {PoolKey} from "../token/Buyback.sol";
import {IAggregatorV3} from "./interfaces/IRwaExternal.sol";

/// The list of tokens a mandate may hold through Bursar, and the terms each one trades under.
///
/// Keyed on the token's address and nothing else. A look-alike carrying SGOV's exact name and
/// symbol lives at 0x50f1…3218; a registry that matched on either would price it. An address
/// that is not in this list is refused by every contract in the RWA lane.
///
/// Values are USDG with six decimals. Feed answers are USD with eight. The value of a raw
/// amount is raw × feed / 10^(decimals + 2): the feed prices one raw token with the
/// multiplier already inside it, so the multiplier is not applied again.
contract AssetRegistry {
    uint16 internal constant BPS = 10_000;

    /// Outer bounds on what the admin can set. The band is how far a fill may land from the feed,
    /// so a wide one is a standing discount to whoever trades against the lane. A price past a
    /// week is not one to trade on, and past two weeks not one to count.
    uint16 public constant MAX_BAND_BPS = 500;
    uint32 public constant MAX_TRADE_STALENESS = 7 days;
    uint32 public constant MAX_VALUATION_STALENESS = 14 days;

    struct Asset {
        address feed;
        /// Oldest feed answer a park, unpark or purchase will trade against.
        uint32 tradeStaleness;
        /// Oldest feed answer that still counts parked value toward spending power.
        uint32 valuationStaleness;
        /// Widest accepted gap between the feed, the pinned pool's mid and a caller's quote.
        uint16 bandBps;
        /// Taken off parked value before it counts as spending power.
        uint16 haircutBps;
        /// Collateral terms, published now and read by the collateral lane later.
        uint8 collateralTier;
        uint16 collateralHaircutBps;
        uint8 decimals;
        bool eligible;
        bool isStock;
        bool isTreasury;
        /// Largest single purchase, in USDG.
        uint128 perTradeCap;
        /// Most that one mandate may park in this asset, and most parked across all mandates.
        uint128 perMandateCap;
        uint128 totalCap;
        /// The one hookless v4 pool every trade in this asset goes through.
        PoolKey pool;
    }

    address public immutable settlementAsset;

    address public admin;
    address public pendingAdmin;

    mapping(address asset => Asset) private _assets;
    address[] private _list;

    event AssetSet(address indexed asset, address indexed feed, bool eligible, bool isStock, bool isTreasury);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error NotRegistered(address asset);
    error FeedNot8Decimals(address feed);
    error BadBounds();
    error BadPool();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// `admin_` is the timelock. The launch assets are written here so the list is live the
    /// block the registry is, with no window in which the deployer holds the pen.
    constructor(address admin_, address settlementAsset_, address[] memory initial, Asset[] memory configs) {
        if (admin_ == address(0) || settlementAsset_ == address(0)) revert ZeroAddress();
        if (initial.length != configs.length) revert BadBounds();
        admin = admin_;
        settlementAsset = settlementAsset_;
        emit AdminTransferred(address(0), admin_);
        for (uint256 i; i < initial.length; ++i) {
            _set(initial[i], configs[i]);
        }
    }

    function setAsset(address asset, Asset calldata config) external onlyAdmin {
        _set(asset, config);
    }

    function setEligible(address asset, bool eligible) external onlyAdmin {
        Asset storage a = _assets[asset];
        if (a.feed == address(0)) revert NotRegistered(asset);
        a.eligible = eligible;
        emit AssetSet(asset, a.feed, eligible, a.isStock, a.isTreasury);
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

    /// Reverts for an address that was never registered. `eligible` is left to the caller,
    /// because a delisted asset still has to be valued and sold.
    function get(address asset) external view returns (Asset memory a) {
        a = _assets[asset];
        if (a.feed == address(0)) revert NotRegistered(asset);
    }

    function isRegistered(address asset) external view returns (bool) {
        return _assets[asset].feed != address(0);
    }

    function assets() external view returns (address[] memory) {
        return _list;
    }

    function poolId(address asset) external view returns (bytes32) {
        Asset storage a = _assets[asset];
        if (a.feed == address(0)) revert NotRegistered(asset);
        return keccak256(abi.encode(a.pool));
    }

    function _set(address asset, Asset memory config) private {
        if (asset == address(0) || config.feed == address(0)) revert ZeroAddress();
        if (IAggregatorV3(config.feed).decimals() != 8) revert FeedNot8Decimals(config.feed);
        if (
            config.tradeStaleness == 0 || config.tradeStaleness > MAX_TRADE_STALENESS
                || config.valuationStaleness < config.tradeStaleness
                || config.valuationStaleness > MAX_VALUATION_STALENESS || config.bandBps == 0
                || config.bandBps > MAX_BAND_BPS || config.haircutBps >= BPS || config.collateralHaircutBps >= BPS
                || config.perMandateCap > config.totalCap
        ) revert BadBounds();

        // One side of the pinned pool is the asset and the other is USDG, and it carries no hook:
        // a hook is third-party code that can reprice or refuse a trade after the guard has run.
        PoolKey memory p = config.pool;
        bool paired = (p.currency0 == asset && p.currency1 == settlementAsset)
            || (p.currency0 == settlementAsset && p.currency1 == asset);
        if (!paired || p.hooks != address(0)) revert BadPool();

        config.decimals = IERC20Metadata(asset).decimals();
        if (_assets[asset].feed == address(0)) _list.push(asset);
        _assets[asset] = config;

        emit AssetSet(asset, config.feed, config.eligible, config.isStock, config.isTreasury);
    }
}
