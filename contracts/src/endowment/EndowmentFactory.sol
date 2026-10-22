// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AssetRegistry} from "../rwa/AssetRegistry.sol";
import {PriceGuard} from "../rwa/PriceGuard.sol";
import {StockSpendRouter} from "../rwa/StockSpendRouter.sol";
import {Endowment} from "./Endowment.sol";
import {EndowmentDeployer} from "./EndowmentDeployer.sol";
import {PatronMark} from "./PatronMark.sol";

/// Starts endowments and keeps the list of every one it started. It has no owner: the wiring is
/// fixed at deployment, and the terms of each endowment are fixed when it is created.
contract EndowmentFactory {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint16 public constant MIN_DRAW_BPS = 100;
    uint16 public constant MAX_DRAW_BPS = 600;
    /// The most a principal held mostly in one company's stock may draw: a single name falls
    /// further and recovers less often than an index.
    uint16 public constant MAX_CONCENTRATED_DRAW_BPS = 350;
    uint256 public constant MAX_ASSETS = 4;

    StockSpendRouter public immutable router;
    PriceGuard public immutable guard;
    AssetRegistry public immutable registry;
    IERC20 public immutable usdg;
    IERC721 public immutable identity;
    PatronMark public immutable marks;
    address public immutable feeTo;
    uint16 public immutable feeBps;
    address public immutable guardian;
    EndowmentDeployer public immutable deployer;

    /// Every endowment, oldest first.
    address[] public all;
    mapping(address => bool) public isEndowment;
    /// Funds that hold a market rather than one company, which may make up a principal at the full rate.
    mapping(address => bool) public diversified;
    mapping(uint256 => address[]) private _byAgent;

    event Created(
        address indexed endowment, uint256 indexed agentId, address indexed settlor, uint16 drawBps, uint16 earnShareBps
    );

    error BadAssets();
    error BadWeights();
    error BadDraw(uint16 drawBps);
    error BadShare(uint16 earnShareBps);
    error NotAStock(address asset);
    error NoAgent(uint256 agentId);
    error ZeroAddress();
    error MarksNotBound(address marks);

    constructor(
        StockSpendRouter router_,
        PriceGuard guard_,
        AssetRegistry registry_,
        IERC20 usdg_,
        IERC721 identity_,
        address feeTo_,
        uint16 feeBps_,
        address guardian_,
        PatronMark marks_,
        address[] memory diversified_,
        EndowmentDeployer deployer_
    ) {
        if (feeTo_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 1_000) revert BadShare(feeBps_);
        router = router_;
        guard = guard_;
        registry = registry_;
        usdg = usdg_;
        identity = identity_;
        feeTo = feeTo_;
        feeBps = feeBps_;
        guardian = guardian_;
        // The marks are deployed first, naming the address this factory was going to have.
        if (address(marks_.factory()) != address(this)) revert MarksNotBound(address(marks_));
        marks = marks_;
        deployer = deployer_;
        for (uint256 i; i < diversified_.length; ++i) {
            diversified[diversified_[i]] = true;
        }
    }

    /// Starts an endowment for `t.agentId` and, when `gift` is above zero, makes the caller its
    /// first patron with that much USDG.
    function create(Endowment.Terms calldata t, uint256 gift) external returns (Endowment e) {
        _check(t);
        e = deployer.deploy(
            msg.sender,
            t,
            Endowment.Wiring({
                router: router,
                guard: guard,
                registry: registry,
                usdg: usdg,
                identity: identity,
                marks: marks,
                feeTo: feeTo,
                feeBps: feeBps,
                guardian: guardian
            })
        );
        isEndowment[address(e)] = true;
        all.push(address(e));
        _byAgent[t.agentId].push(address(e));
        emit Created(address(e), t.agentId, msg.sender, t.drawBps, t.earnShareBps);

        if (gift != 0) {
            usdg.safeTransferFrom(msg.sender, address(this), gift);
            usdg.forceApprove(address(e), gift);
            e.giveFor(msg.sender, gift);
        }
    }

    function count() external view returns (uint256) {
        return all.length;
    }

    function endowmentsOf(uint256 agentId) external view returns (address[] memory) {
        return _byAgent[agentId];
    }

    function _check(Endowment.Terms calldata t) private view {
        // Reverts for an identity that was never minted, so nobody endows a number.
        if (identity.ownerOf(t.agentId) == address(0)) revert NoAgent(t.agentId);
        if (t.drawBps < MIN_DRAW_BPS || t.drawBps > MAX_DRAW_BPS) revert BadDraw(t.drawBps);
        if (t.earnShareBps > BPS) revert BadShare(t.earnShareBps);
        uint256 n = t.assets.length;
        if (n == 0 || n > MAX_ASSETS) revert BadAssets();
        if (t.weightsBps.length != n) revert BadWeights();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address asset = t.assets[i];
            for (uint256 j; j < i; ++j) {
                if (t.assets[j] == asset) revert BadAssets();
            }
            AssetRegistry.Asset memory a = registry.get(asset);
            if (!a.isStock || !a.eligible) revert NotAStock(asset);
            if (t.weightsBps[i] == 0) revert BadWeights();
            sum += t.weightsBps[i];
        }
        if (sum != BPS) revert BadWeights();
        for (uint256 i; i < n; ++i) {
            if (!diversified[t.assets[i]] && t.weightsBps[i] > BPS / 2 && t.drawBps > MAX_CONCENTRATED_DRAW_BPS) {
                revert BadDraw(t.drawBps);
            }
        }
    }
}
