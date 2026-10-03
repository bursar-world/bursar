// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {MandateAccount} from "../../src/MandateAccount.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {Buyback, IPoolManager, PoolKey} from "../../src/token/Buyback.sol";
import {Staking} from "../../src/token/Staking.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {IAccessRegistry, IStateView} from "../../src/rwa/interfaces/IRwaExternal.sol";
import {MockBRSR} from "../mocks/MockBRSR.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAccess, MockAccounts, MockEscrow, MockFeed, MockStock, MockV4} from "./RwaMocks.sol";

/// Random but legal traffic through the collateral lane: principals post and take back three
/// assets across two lines, agents spend on credit, debt is repaid, feeds move, go quiet,
/// collapse and recover, pools wander in and out of their bands, the clock crosses sessions, a
/// keeper observes, governance drops an asset from its tier and puts it back, keepers liquidate
/// and anyone pays the seized pot out to the lender.
///
/// Every action swallows its own revert, as in the system-wide handler. Counters carry findings
/// out to the invariant functions: an assertion here would revert, and the runner discards a
/// reverting handler call. The ghost totals record what the write-offs seized and what the
/// claims paid out, which is the only way tokens leave the vault without a line's say.
contract CollateralHandler is CommonBase, StdUtils {
    uint256 internal constant BPS = 10_000;
    bytes32 internal constant CAP = keccak256("service:gpu.render:1");

    CollateralVault public immutable vault;
    CreditPool public immutable pool;
    PriceGuard public immutable guard;
    AssetRegistry public immutable registry;
    MockV4 public immutable v4;
    MockERC20 public immutable usdg;
    address public immutable principal;
    address public immutable agent;
    address public immutable admin;
    address public immutable merchant;

    MandateAccount[] public lines;
    MockStock[] public tokens;
    MockFeed[] public feeds;
    uint8[] public tiers;
    uint256[] public basePrices;

    mapping(address asset => uint256) public seizedEver;
    mapping(address asset => uint256) public claimed;
    uint256 public writeOffs;
    uint256 public draws;
    /// A write-off that left the line any debt. Collateral may remain: the equity a write-off
    /// returns above the debt is the borrower's, withdrawable against a line that now owes nothing.
    uint256 public writeOffBreaks;
    /// A draw that landed with no position counted by the draw rule, or a position the rule
    /// counted without a valid aged sample behind it.
    uint256 public drawBreaks;
    /// A non-keeper that managed to plant a reading.
    uint256 public keeperGateBreaks;
    /// A sale that completed while the guard reported a halt on the asset.
    uint256 public saleBreaks;
    /// A write-off that seized more than the debt was worth at the feed, every seized feed
    /// readable.
    uint256 public seizeBreaks;

    constructor(
        CollateralVault vault_,
        MandateAccount[] memory lines_,
        MockStock[] memory tokens_,
        MockFeed[] memory feeds_,
        address principal_,
        address agent_,
        address admin_,
        address merchant_
    ) {
        vault = vault_;
        pool = vault_.pool();
        guard = vault_.guard();
        registry = vault_.registry();
        v4 = MockV4(address(vault_.poolManager()));
        usdg = MockERC20(address(vault_.usdg()));
        principal = principal_;
        agent = agent_;
        admin = admin_;
        merchant = merchant_;
        for (uint256 i; i < lines_.length; ++i) {
            lines.push(lines_[i]);
        }
        for (uint256 i; i < tokens_.length; ++i) {
            tokens.push(tokens_[i]);
            feeds.push(feeds_[i]);
            tiers.push(vault_.tierOf(address(tokens_[i])));
            basePrices.push(uint256(feeds_[i].answer()));
        }
        usdg.approve(address(pool), type(uint256).max);
    }

    function lineCount() external view returns (uint256) {
        return lines.length;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function deposit(uint256 who, uint256 which, uint256 raw) external {
        MockStock token = _token(which);
        raw = bound(raw, 0.005e18, 0.1e18);
        token.mint(principal, raw);
        vm.prank(principal);
        token.approve(address(vault), raw);
        vm.prank(principal);
        try vault.deposit(address(_line(who)), address(token), raw) {} catch {}
    }

    function withdraw(uint256 who, uint256 which, uint256 raw) external {
        address line = address(_line(who));
        address token = address(_token(which));
        uint256 held = vault.collateralOf(line, token);
        if (held == 0) return;
        raw = bound(raw, 1, held);
        vm.prank(principal);
        try vault.withdraw(line, token, raw, principal) {} catch {}
    }

    /// A spend from a mandate that holds no USDG of its own draws the whole amount, sized to the
    /// room the line shows so that most land and some overshoot. The rule the draw has to pass is
    /// read first, so a draw that lands without it is a break.
    function draw(uint256 who, uint256 amount) external {
        MandateAccount line = _line(who);
        (,,, uint256 headroom,) = vault.account(address(line));
        amount = bound(amount, 1, Math.max(headroom, 1) * 3 / 2);
        bool counted;
        for (uint256 i; i < tokens.length; ++i) {
            address token = address(tokens[i]);
            if (vault.drawHalt(token) != PriceGuard.DrawHalt.None) continue;
            (uint48 at,,) = guard.aged(token);
            uint256 age = block.timestamp - at;
            if (at == 0 || age < guard.MIN_OBSERVATION_AGE() || age > guard.MAX_OBSERVATION_AGE()) ++drawBreaks;
            if (vault.collateralOf(address(line), token) != 0 && vault.tierOf(token) != 0) counted = true;
        }
        uint256 scaled = pool.scaledDebtOf(address(line));
        vm.prank(agent);
        try line.spend(_request(uint128(amount)), new bytes32[](0)) {
            if (pool.scaledDebtOf(address(line)) == scaled) return;
            ++draws;
            if (!counted) ++drawBreaks;
        } catch {}
    }

    function repay(uint256 who, uint256 amount) external {
        address line = address(_line(who));
        uint256 owed = pool.debtOf(line);
        if (owed == 0) return;
        amount = bound(amount, 1, owed * 2);
        usdg.mint(address(this), amount);
        try pool.repay(line, amount) {} catch {}
    }

    /// Most rounds are the ordinary kind: a fresh answer within 60 bps of the last, which the
    /// arbitrageurs carry into the pool. The rest are the cases the lane has to survive: a move
    /// of up to 30% the pool has not followed, an answer dated anywhere up to past the
    /// valuation bound, and a round 1e8 too large.
    function moveFeed(uint256 which, uint256 bps, uint256 age, uint256 shape) external {
        MockFeed feed = _feed(which);
        uint256 price = _feedPrice(which);
        uint256 kind = shape % 16;
        if (kind < 10) {
            bps = bound(bps, 0, 60);
            price = shape % 2 == 0 ? price * (BPS + bps) / BPS : price * (BPS - bps) / BPS;
            feed.set(int256(price), block.timestamp);
            _setPool(which, price);
            return;
        }
        if (kind < 14) {
            bps = bound(bps, 0, 3_000);
            price = shape % 2 == 0 ? price * (BPS + bps) / BPS : price * (BPS - bps) / BPS;
            feed.set(int256(price), block.timestamp);
            return;
        }
        if (kind == 14) {
            feed.set(int256(price), block.timestamp - bound(age, 0, 110 hours));
            return;
        }
        feed.set(int256(price * 1e8), block.timestamp);
    }

    /// A collapse to a hundredth of a cent, the pool along with it, which makes every position
    /// in the asset dust; or the recovery back to the launch price.
    function crash(uint256 which, bool recover) external {
        MockFeed feed = _feed(which);
        uint256 price = recover ? basePrices[which % tokens.length] : 1e4;
        feed.set(int256(price), block.timestamp);
        _setPool(which, price);
    }

    /// A feed replaced by a proxy that reverts on every read, or repaired.
    function breakFeed(uint256 which, bool repair) external {
        _feed(which).setBroken(!repair);
    }

    /// Half the time the pool is brought back to within its band of the feed; the rest it is
    /// pushed up to 20% away from it.
    function movePool(uint256 which, uint256 bps, uint256 shape) external {
        bps = shape % 2 == 0 ? bound(bps, 0, 90) : bound(bps, 0, 2_000);
        uint256 price = _feedPrice(which);
        _setPool(which, shape % 4 < 2 ? price * (BPS + bps) / BPS : price * (BPS - bps) / BPS);
    }

    /// Short hops keep the aged samples alive. Long ones cross sessions; through half of them
    /// the keeper keeps its five-minute schedule and the feeds publish their heartbeat round, so
    /// the lane comes out the other side with a sample that stands, and through the other half
    /// nothing ran and every sample has expired.
    function warp(uint256 dt, uint256 shape) external {
        if (shape % 4 != 0) {
            vm.warp(block.timestamp + bound(dt, 1 minutes, 10 minutes));
            return;
        }
        dt = bound(dt, 1 hours, 3 days);
        if (shape % 8 == 4) {
            vm.warp(block.timestamp + dt);
            return;
        }
        vm.warp(block.timestamp + dt - 2 * guard.MIN_OBSERVATION_AGE());
        _heartbeat();
        _observeAll();
        vm.warp(block.timestamp + guard.MIN_OBSERVATION_AGE());
        _observeAll();
        vm.warp(block.timestamp + guard.MIN_OBSERVATION_AGE());
    }

    /// One keeper round over every asset.
    function observe() external {
        _observeAll();
    }

    function untier(uint256 which, bool drop) external {
        MockStock token = _token(which);
        vm.prank(admin);
        vault.setAssetTier(address(token), drop ? 0 : tiers[which % tokens.length]);
    }

    /// A write-off is recognised by the pool's bad debt growing. It has to leave the line with no
    /// debt, no more collateral than the debt was worth at the feed, and everything it took in the
    /// seized pots. A sale, recognised by collateral moving for proceeds, has to have found the
    /// guard in its OK state.
    function liquidate(uint256 who, uint256 which) external {
        address line = address(_line(who));
        address asset = address(_token(which));
        uint256 bad = pool.badDebt();
        PriceGuard.DrawHalt halt = vault.drawHalt(asset);
        uint256[] memory before = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            before[i] = vault.seized(address(tokens[i]));
        }
        uint256 sold;
        try vault.liquidate(line, asset) returns (uint256 raw) {
            sold = raw;
        } catch {}
        for (uint256 i; i < tokens.length; ++i) {
            seizedEver[address(tokens[i])] += vault.seized(address(tokens[i])) - before[i];
        }
        if (sold > 0 && halt != PriceGuard.DrawHalt.None) ++saleBreaks;
        if (pool.badDebt() == bad) return;
        ++writeOffs;
        if (pool.debtOf(line) != 0) ++writeOffBreaks;
        _checkSeize(pool.badDebt() - bad, before);
    }

    /// A write-off values each seized position at the feed, as `health` does, and takes no more
    /// than the written-off debt while every seized position has a feed to price it. Every tier
    /// here shares the registry's valuation bound, so the registry's stands in for the tier's.
    function _checkSeize(uint256 writtenOff, uint256[] memory before) internal {
        uint256 seizedFeedValue;
        bool allReadable = true;
        for (uint256 i; i < tokens.length; ++i) {
            address token = address(tokens[i]);
            uint256 took = vault.seized(token) - before[i];
            // slither-disable-next-line incorrect-equality
            if (took == 0) continue;
            (uint256 priceE8, uint256 updatedAt, bool unpaused,) = guard.valuation(token);
            AssetRegistry.Asset memory a = registry.get(token);
            bool counted = priceE8 != 0 && block.timestamp - updatedAt <= a.valuationStaleness && unpaused;
            if (!counted) {
                allReadable = false;
                continue;
            }
            seizedFeedValue += Math.mulDiv(took, priceE8, 10 ** (uint256(a.decimals) + 2));
        }
        if (allReadable && seizedFeedValue > writtenOff + tokens.length) ++seizeBreaks;
    }

    /// Pushes one asset's pool off its band, has a non-keeper try to observe (which must be
    /// refused), lets the keeper observe the pushed pool, then puts the pool back, all in one
    /// step. The draw and sale rules have to catch the pushed reading, and the keeper gate has to
    /// turn the outsider away.
    function pushObserveUnwind(uint256 which, uint256 bps, bool keeperToo) external {
        MockStock token = _token(which);
        uint256 price = _feedPrice(which);
        bps = bound(bps, 200, 2_000);
        _setPool(which, price * (BPS - bps) / BPS);
        address outsider = address(uint160(uint256(keccak256(abi.encode("outsider", which)))));
        vm.prank(outsider);
        try guard.observe(address(token)) {
            ++keeperGateBreaks;
        } catch {}
        if (keeperToo) {
            try guard.observe(address(token)) {} catch {}
        }
        _setPool(which, price);
    }

    function claim(uint256 which) external {
        address token = address(_token(which));
        try vault.claimSeized(token) returns (uint256 raw) {
            claimed[token] += raw;
        } catch {}
    }

    function _setPool(uint256 which, uint256 priceE8) internal {
        MockStock token = _token(which);
        PoolKey memory k = registry.get(address(token)).pool;
        bool tokenIs0 = k.currency0 == address(token);
        uint256 q192 = 1 << 192;
        uint256 ratio = tokenIs0 ? Math.mulDiv(priceE8, q192, 1e20) : Math.mulDiv(1e20, q192, priceE8);
        v4.setPrice(k, uint160(Math.sqrt(ratio)));
    }

    function _observeAll() internal {
        for (uint256 i; i < tokens.length; ++i) {
            try guard.observe(address(tokens[i])) {} catch {}
        }
    }

    /// Every feed publishes its answer again, dated now.
    function _heartbeat() internal {
        for (uint256 i; i < feeds.length; ++i) {
            feeds[i].set(feeds[i].answer(), block.timestamp);
        }
    }

    /// The last answer, or a dollar for a feed that has none. A mis-scaled round is read back at
    /// its true scale, so the next move starts from a price and not from the error.
    function _feedPrice(uint256 which) internal view returns (uint256) {
        int256 answer = _feed(which).answer();
        if (answer <= 0) return 1e8;
        uint256 price = uint256(answer);
        return price >= 1e16 ? price / 1e8 : price;
    }

    function _request(uint128 amount) internal view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant,
            capabilityId: CAP,
            inputCommit: bytes32(0),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    function _line(uint256 who) internal view returns (MandateAccount) {
        return lines[who % lines.length];
    }

    function _token(uint256 which) internal view returns (MockStock) {
        return tokens[which % tokens.length];
    }

    function _feed(uint256 which) internal view returns (MockFeed) {
        return feeds[which % feeds.length];
    }
}

/// The books the vault and the pool keep against the tokens the vault holds, under any sequence
/// of the calls above.
contract CollateralInvariantTest is Test {
    uint256 internal constant SPY_E8 = 771_21266423;
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint256 internal constant AAPL_E8 = 300e8;
    uint256 internal constant MIN_AGE = 5 minutes;
    uint256 internal constant MAX_AGE = 1 hours;
    // A Monday, 14:13 UTC, inside the 24/5 session.
    uint256 internal constant T0 = 1_790_000_000;

    MockERC20 usdg;
    MockStock[] tokens;
    MockFeed[] feeds;
    MockV4 v4;
    MockAccounts accounts;
    AssetRegistry reg;
    PriceGuard guard;
    CreditPool pool;
    CollateralVault vault;
    CollateralHandler handler;
    MandateAccount[] lines;

    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address admin = makeAddr("timelock");
    address lender = makeAddr("lender");
    address merchant = makeAddr("merchant");

    function setUp() public {
        vm.warp(T0 - 2 * MIN_AGE);
        usdg = new MockERC20();
        v4 = new MockV4();
        accounts = new MockAccounts();
        usdg.mint(address(v4), 1_000_000e6);

        (address[] memory list, uint8[] memory assetTiers) = _registerAssets();
        guard = new PriceGuard(
            reg, IAccessRegistry(address(new MockAccess())), IStateView(address(v4)), MIN_AGE, MAX_AGE, 1_500, admin
        );
        // This contract takes the keeper's first rounds in `setUp`; the handler takes every round
        // and the adversarial action after it.
        vm.prank(admin);
        guard.setKeeper(address(this), true);
        pool = _creditPool();
        vault = new CollateralVault(
            reg,
            guard,
            pool,
            IMandateAccountFactory(address(accounts)),
            IPoolManager(address(v4)),
            admin,
            CollateralVault.Params({minBorrowHealth: 1.25e18, liquidationTarget: 1.05e18, bountyBps: 500}),
            _tiers(),
            list,
            assetTiers
        );
        pool.bindVault(address(vault));

        usdg.mint(lender, 100e6);
        vm.startPrank(lender);
        usdg.approve(address(pool), 100e6);
        pool.fund(100e6);
        vm.stopPrank();
        _openLines();

        // The keeper's first two rounds, so the run starts with draws open.
        _observeAll();
        vm.warp(T0 - MIN_AGE);
        _observeAll();
        vm.warp(T0);

        handler = new CollateralHandler(vault, lines, tokens, feeds, principal, agent, admin, merchant);
        vm.prank(admin);
        guard.setKeeper(address(handler), true);
        _target();
    }

    /// Three assets, one per tier, each with a feed and a pinned pool priced at it.
    function _registerAssets() private returns (address[] memory list, uint8[] memory assetTiers) {
        string[3] memory symbols = ["SGOV", "SPY", "AAPL"];
        uint256[3] memory prices = [SGOV_E8, SPY_E8, AAPL_E8];
        uint16[3] memory bands = [uint16(50), 100, 100];
        list = new address[](3);
        assetTiers = new uint8[](3);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](3);
        for (uint256 i; i < 3; ++i) {
            MockStock token = new MockStock(symbols[i]);
            MockFeed feed = new MockFeed();
            feed.set(int256(prices[i]), block.timestamp);
            tokens.push(token);
            feeds.push(feed);
            PoolKey memory k = _key(address(token), 500, 10);
            v4.setPrice(k, _sqrt(prices[i], k.currency0 == address(token)));
            list[i] = address(token);
            configs[i] = _cfg(address(feed), k, i != 0, i == 0, bands[i]);
            assetTiers[i] = uint8(i + 1);
        }
        reg = new AssetRegistry(admin, address(usdg), list, configs);
    }

    /// A pool on a staking contract and buyback of its own, as the deploy scripts pair them.
    function _creditPool() private returns (CreditPool p) {
        MockBRSR brsr = new MockBRSR();
        address treasury = makeAddr("treasury");
        Staking staking = new Staking(
            IERC20(address(brsr)), IERC20(address(usdg)), admin, makeAddr("slashSink"), treasury, 7 days, 1e18
        );
        Buyback buyback = new Buyback(
            address(usdg),
            address(brsr),
            address(v4),
            3000,
            60,
            address(0),
            address(staking),
            admin,
            treasury,
            Buyback.Params({
                spendPerCallMicroUsd: 1e6,
                maxSpendPerWindowMicroUsd: 10e6,
                minSpendMicroUsd: 0.1e6,
                maxPriceMicroUsdPerBrsr: 50_000,
                window: 1 days,
                minInterval: 1 hours
            })
        );
        p = new CreditPool(address(usdg), address(staking), address(buyback), admin, lender, 100e6, 20e6, 200, 1_800);
        vm.prank(admin);
        staking.setCreditManager(address(p));
    }

    /// Two lane-1 mandates with no USDG of their own, so every spend is a draw.
    function _openLines() private {
        MockEscrow escrow = new MockEscrow(IERC20(address(usdg)));
        for (uint256 i; i < 2; ++i) {
            MandateAccount m = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits());
            accounts.add(principal, address(m));
            vm.startPrank(principal);
            m.setTreasuryPark(address(vault));
            m.setCapability(keccak256("service:gpu.render:1"), true);
            m.setMerchant(merchant, true);
            vault.openLine(address(m));
            vm.stopPrank();
            lines.push(m);
        }
    }

    function _observeAll() private {
        for (uint256 i; i < tokens.length; ++i) {
            guard.observe(address(tokens[i]));
        }
    }

    function _target() private {
        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = CollateralHandler.deposit.selector;
        selectors[1] = CollateralHandler.deposit.selector;
        selectors[2] = CollateralHandler.withdraw.selector;
        selectors[3] = CollateralHandler.draw.selector;
        selectors[4] = CollateralHandler.draw.selector;
        selectors[5] = CollateralHandler.repay.selector;
        selectors[6] = CollateralHandler.moveFeed.selector;
        selectors[7] = CollateralHandler.movePool.selector;
        selectors[8] = CollateralHandler.warp.selector;
        selectors[9] = CollateralHandler.observe.selector;
        selectors[10] = CollateralHandler.observe.selector;
        selectors[11] = CollateralHandler.untier.selector;
        selectors[12] = CollateralHandler.liquidate.selector;
        selectors[13] = CollateralHandler.liquidate.selector;
        selectors[14] = CollateralHandler.claim.selector;
        selectors[15] = CollateralHandler.warp.selector;
        selectors[16] = CollateralHandler.crash.selector;
        selectors[17] = CollateralHandler.breakFeed.selector;
        selectors[18] = CollateralHandler.pushObserveUnwind.selector;
        selectors[19] = CollateralHandler.pushObserveUnwind.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _tiers() private pure returns (CollateralVault.Tier[] memory t) {
        t = new CollateralVault.Tier[](3);
        t[0] = CollateralVault.Tier(500, 1_000, 26 hours, 100 hours, "Treasury");
        t[1] = CollateralVault.Tier(2_000, 3_500, 26 hours, 100 hours, "Index fund");
        t[2] = CollateralVault.Tier(3_000, 5_000, 26 hours, 100 hours, "Single stock");
    }

    /// The fixture lends from its first block, so the draw properties are not vacuous.
    function test_theFixtureDrawsOnCreditFromTheStart() public {
        handler.deposit(0, 1, 0.01e18);
        handler.draw(0, 2e6);
        assertEq(handler.draws(), 1);
        assertEq(pool.debtOf(address(lines[0])), 2e6);
        assertEq(handler.drawBreaks(), 0);
    }

    /// The handler reaches a write-off and a claim, and reads both the way the invariants need.
    function test_theFixtureWritesOffSeizesAndPaysTheLender() public {
        handler.deposit(0, 1, 0.01e18);
        handler.draw(0, 4e6);
        // SPY to a hundredth of a cent, pool along with it: the position is dust.
        handler.crash(1, false);
        handler.liquidate(0, 1);
        assertEq(handler.writeOffs(), 1);
        assertEq(handler.writeOffBreaks(), 0);
        assertEq(handler.seizedEver(address(tokens[1])), 0.01e18);
        invariant_tokensAreConservedPerAsset();
        invariant_aLineWithNoDebtCanWithdrawEverything();

        handler.claim(1);
        assertEq(handler.claimed(address(tokens[1])), 0.01e18);
        assertEq(tokens[1].balanceOf(lender), 0.01e18);
        invariant_seizedOnlyEverLeavesToTheLender();
    }

    /// Every token the vault holds is some line's collateral or sits in the seized pot.
    function invariant_tokensAreConservedPerAsset() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = address(tokens[i]);
            uint256 posted;
            for (uint256 j; j < lines.length; ++j) {
                posted += vault.collateralOf(address(lines[j]), token);
            }
            assertEq(tokens[i].balanceOf(address(vault)), posted + vault.seized(token), "vault balance drifted");
        }
    }

    /// The debt the vault shows a line is the pool's, the pool's total is the lines' sum, and
    /// only a line with no debt reads as infinitely healthy.
    function invariant_poolDebtMatchesTheVaultsView() public view {
        uint256 scaled;
        uint256 debt;
        for (uint256 i; i < lines.length; ++i) {
            address line = address(lines[i]);
            (,, uint256 shown,, uint256 h) = vault.account(line);
            assertEq(shown, pool.debtOf(line), "the vault shows another debt than the pool");
            assertEq(h == type(uint256).max, shown == 0, "health reads infinite with debt or finite without");
            scaled += pool.scaledDebtOf(line);
            debt += pool.debtOf(line);
        }
        assertEq(scaled, pool.totalScaled(), "scaled debt outside the lines");
        assertApproxEqAbs(debt, pool.totalDebt(), lines.length, "the lines' debts do not sum to the pool's");
    }

    function invariant_aWriteOffLeavesNoDebt() public view {
        assertEq(handler.writeOffBreaks(), 0, "a write-off left the line debt");
    }

    function invariant_noDrawWithoutAValidAgedObservation() public view {
        assertEq(handler.drawBreaks(), 0, "a draw landed without the draw rule behind it");
    }

    function invariant_aNonKeeperNeverPlantsAReading() public view {
        assertEq(handler.keeperGateBreaks(), 0, "a non-keeper planted a price-guard reading");
    }

    function invariant_noSaleCompletesWhileTheGuardHalts() public view {
        assertEq(handler.saleBreaks(), 0, "a sale completed while the guard reported a halt");
    }

    function invariant_aWriteOffNeverSeizesMoreThanTheDebtAtTheFeed() public view {
        assertEq(handler.seizeBreaks(), 0, "a write-off seized more than the debt was worth at the feed");
    }

    /// Tried against a snapshot, so the check moves nothing: whatever the feeds, pools and
    /// samples say, a line that owes nothing takes all of its collateral back.
    function invariant_aLineWithNoDebtCanWithdrawEverything() public {
        for (uint256 i; i < lines.length; ++i) {
            address line = address(lines[i]);
            if (pool.debtOf(line) != 0) continue;
            uint256 snapshot = vm.snapshotState();
            for (uint256 j; j < tokens.length; ++j) {
                address token = address(tokens[j]);
                uint256 held = vault.collateralOf(line, token);
                if (held == 0) continue;
                vm.prank(principal);
                (bool ok,) =
                    address(vault).call(abi.encodeCall(CollateralVault.withdraw, (line, token, held, principal)));
                assertTrue(ok, "a line with no debt could not take its collateral back");
            }
            vm.revertToState(snapshot);
        }
    }

    /// What the write-offs seized is in the pots or with the lender, and nowhere else.
    function invariant_seizedOnlyEverLeavesToTheLender() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address token = address(tokens[i]);
            assertEq(
                vault.seized(token) + handler.claimed(token), handler.seizedEver(token), "seized tokens went astray"
            );
            assertEq(
                tokens[i].balanceOf(lender), handler.claimed(token), "the lender holds other than what was claimed"
            );
        }
    }

    function _limits() internal pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 50e6,
            dailyCap: 1_000e6,
            monthlyCap: 10_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 100e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 1
        });
    }

    function _key(address stock, uint24 fee, int24 ts) internal view returns (PoolKey memory) {
        (address c0, address c1) = stock < address(usdg) ? (stock, address(usdg)) : (address(usdg), stock);
        return PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: ts, hooks: address(0)});
    }

    function _sqrt(uint256 priceE8, bool stockIs0) internal pure returns (uint160) {
        uint256 q192 = 1 << 192;
        uint256 ratio = stockIs0 ? Math.mulDiv(priceE8, q192, 1e20) : Math.mulDiv(1e20, q192, priceE8);
        return uint160(Math.sqrt(ratio));
    }

    function _cfg(address feed, PoolKey memory pool_, bool isStock, bool isTreasury, uint16 band)
        internal
        pure
        returns (AssetRegistry.Asset memory)
    {
        return AssetRegistry.Asset({
            feed: feed,
            tradeStaleness: 26 hours,
            valuationStaleness: 100 hours,
            bandBps: band,
            haircutBps: 50,
            collateralHaircutBps: 0,
            decimals: 0,
            eligible: true,
            isStock: isStock,
            isTreasury: isTreasury,
            perTradeCap: 25e6,
            perMandateCap: 100e6,
            totalCap: 1_000e6,
            pool: pool_
        });
    }
}
