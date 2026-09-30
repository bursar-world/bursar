// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SeedPool} from "../../script/SeedPool.s.sol";
import {V4Math} from "../../script/lib/V4Math.sol";
import {Buyback, PoolKey} from "../../src/token/Buyback.sol";
import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {StubPoolManager} from "./V4LiquiditySeeder.t.sol";

/// v4's StateView over the stub: the price the pool opened at and the liquidity it holds.
contract StubStateView {
    StubPoolManager internal immutable manager;

    constructor(StubPoolManager manager_) {
        manager = manager_;
    }

    function getSlot0(bytes32 id) external view returns (uint160, int24, uint24, uint24) {
        return (manager.openedAt(id), 0, 0, 3000);
    }

    function getLiquidity(bytes32 id) external view returns (uint128) {
        return manager.liquidityOf(id);
    }
}

/// Calls the script from the address it broadcasts as, so the seeder it deploys is owned by the
/// key that signed for it.
contract SeedPoolRunner {
    function open(SeedPool script) external {
        script.run();
    }

    function add(SeedPool script) external {
        script.seedExisting();
    }
}

contract SeedPoolHarness is SeedPool {
    function openingSqrtPrice(uint256 priceMicroUsd) external pure returns (uint160) {
        return _openingSqrtPrice(priceMicroUsd);
    }

    function buyFeePips(uint24 lpFee, uint24 protocolFee, bool zeroForOne) external pure returns (uint256) {
        return _buyFeePips(lpFee, protocolFee, zeroForOne);
    }
}

/// The seeding script against a stub manager, in the order an operator meets it. Every case
/// that reads the environment runs inside one test, because the environment is process-wide
/// and Foundry runs tests in parallel; the script is pinned to a namespace of its own as well.
contract SeedPoolTest is Test {
    address internal constant RHC_BRSR = 0x00e503925880c4b07E5Fb70232D83aD871F57a7d;
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    string internal constant ENV = "SEEDPOOL_";

    /// What the live pool opened at, and the liquidity twenty-five USDG a side bought there.
    uint160 internal constant OPEN_SQRT_PRICE_X96 = 1120455419495722798374;
    uint128 internal constant OPEN_LIQUIDITY = 1767766952966368;

    SeedPoolHarness internal script;
    StubPoolManager internal manager;
    StubStateView internal stateView;
    Buyback internal buyback;
    BRSR internal brsr;
    MockUsdg internal usdg;
    bytes32 internal id;

    address internal timelock = makeAddr("timelock");

    function setUp() public {
        deployCodeTo(
            "BRSR.sol:BRSR",
            abi.encode(
                IBRSR.Allocation({
                    community: address(this),
                    team: makeAddr("team"),
                    treasury: makeAddr("treasury"),
                    liquidity: makeAddr("liquidity")
                })
            ),
            RHC_BRSR
        );
        deployCodeTo("MockUsdg.sol:MockUsdg", RHC_USDG);
        brsr = BRSR(RHC_BRSR);
        usdg = MockUsdg(RHC_USDG);

        manager = new StubPoolManager(RHC_BRSR, RHC_USDG);
        // The stub prices a position by the unit of liquidity; this keeps every cost under the
        // maxima the script computes with the real curve.
        manager.setRates(1e9, 0);
        stateView = new StubStateView(manager);

        Staking staking = new Staking(brsr, usdg, timelock, makeAddr("slashSink"), makeAddr("treasury"), 7 days, 1e18);
        buyback = new Buyback(
            RHC_USDG,
            RHC_BRSR,
            address(manager),
            3000,
            60,
            address(0),
            address(staking),
            timelock,
            makeAddr("treasury"),
            Buyback.Params({
                spendPerCallMicroUsd: 500_000,
                maxSpendPerWindowMicroUsd: 5_000_000,
                minSpendMicroUsd: 100_000,
                maxPriceMicroUsdPerBrsr: 240,
                window: 1 days,
                minInterval: 1 hours
            })
        );
        id = keccak256(
            abi.encode(
                PoolKey({currency0: RHC_BRSR, currency1: RHC_USDG, fee: 3000, tickSpacing: 60, hooks: address(0)})
            )
        );

        script = new SeedPoolHarness();
        script.pinEnvPrefix(ENV);

        vm.etch(DEFAULT_SENDER, address(new SeedPoolRunner()).code);
        brsr.transfer(DEFAULT_SENDER, 1_000_000e18);
        usdg.mint(DEFAULT_SENDER, 1_000e6);
    }

    function _set(string memory key, string memory value) internal {
        vm.setEnv(string.concat(ENV, key), value);
    }

    function _runner() internal pure returns (SeedPoolRunner) {
        return SeedPoolRunner(DEFAULT_SENDER);
    }

    function test_seedPool_opensAddsAndReadsBackOnlyOnTheBuybacksManager() public {
        _set("BURSAR_BUYBACK", vm.toString(address(buyback)));
        _set("BURSAR_STATE_VIEW", vm.toString(address(stateView)));
        _set("BURSAR_SEED_PRICE_MICRO_USD", "200");
        _set("BURSAR_SEED_USDG_MICRO", "25000000");
        _set("BURSAR_SEEDER", vm.toString(address(0)));

        // A manager named in the environment that is not the buyback's stops the run before the
        // one-shot opening price can go anywhere.
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(makeAddr("someOtherManager")));
        vm.expectRevert(bytes("BURSAR_BUYBACK_POOL_MANAGER is not the manager the buyback trades on"));
        _runner().open(script);
        assertEq(manager.openedAt(id), 0);

        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(address(manager)));
        address opener = vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER));
        _runner().open(script);

        assertEq(manager.openedAt(id), OPEN_SQRT_PRICE_X96);
        assertEq(manager.liquidityOf(id), OPEN_LIQUIDITY);
        // The key that opened the pool holds the position until governance accepts it.
        assertEq(V4LiquiditySeeder(opener).owner(), DEFAULT_SENDER);
        assertEq(V4LiquiditySeeder(opener).pendingOwner(), timelock);

        vm.expectRevert(bytes("the pool is already open; seedExisting adds to it"));
        _runner().open(script);

        // Adding to the open pool needs no opening price and no owner: the seeder it deploys is
        // governance's from its first block.
        _set("BURSAR_SEED_USDG_MICRO", "5000000");
        address adder = vm.computeCreateAddress(DEFAULT_SENDER, vm.getNonce(DEFAULT_SENDER));
        _runner().add(script);

        assertEq(V4LiquiditySeeder(adder).owner(), timelock);
        uint128 added = V4LiquiditySeeder(adder).liquidityOf(-887_220, 887_220);
        assertGt(added, 0);
        assertEq(manager.liquidityOf(id), OPEN_LIQUIDITY + added);
        assertEq(manager.openedAt(id), OPEN_SQRT_PRICE_X96);

        // An expected price the pool is a long way from stops the add.
        _set("BURSAR_SEED_PRICE_MICRO_USD", "300");
        vm.expectRevert(bytes("the pool is further from the expected price than allowed"));
        _runner().add(script);

        // Within the allowed distance it goes ahead.
        _set("BURSAR_SEED_PRICE_MICRO_USD", "201");
        _runner().add(script);

        // The read-back is not optional. Without a StateView there is no seed.
        _set("BURSAR_STATE_VIEW", "");
        vm.expectRevert();
        _runner().add(script);
    }

    /// The gate between the two derivations admits every price a seed could open at, down to a
    /// single micro-dollar, where the Q96 route is at its least precise.
    function test_theGateAdmitsTheBottomOfTheRange() public view {
        for (uint256 price = 1; price < 10; ++price) {
            assertEq(script.openingSqrtPrice(price), V4Math.initialSqrtPriceX96(1e18, price));
        }
        assertEq(script.openingSqrtPrice(200), OPEN_SQRT_PRICE_X96);
    }

    function testFuzz_theGateAdmitsEveryPrice(uint64 price) public view {
        uint256 p = bound(price, 1, 1e12);
        assertEq(script.openingSqrtPrice(p), V4Math.initialSqrtPriceX96(1e18, p));
    }

    /// The fee a buy pays on the live pool: the 0.30% LP fee and the 0.05% protocol fee v4 takes
    /// on this pool in each direction, combined the way the manager combines them.
    function test_theReportedFeeIsTheOneABuyPays() public view {
        uint24 protocolFee = (500 << 12) | 500;
        assertEq(script.buyFeePips(3000, protocolFee, false), 3499);
        assertEq(script.buyFeePips(3000, 0, false), 3000);
        assertEq(script.buyFeePips(3000, (100 << 12) | 500, true), 3499);
    }
}
