// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SeedPool} from "../../script/SeedPool.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";
import {V4Math} from "../../script/lib/V4Math.sol";

import {Buyback, PoolKey} from "../../src/token/Buyback.sol";
import {BRSR} from "../../src/token/BRSR.sol";
import {Staking} from "../../src/token/Staking.sol";
import {V4LiquiditySeeder} from "../../src/token/V4LiquiditySeeder.sol";
import {IBRSR} from "../../src/token/interfaces/IBRSR.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {StubPoolManager} from "../token/V4LiquiditySeeder.t.sol";
import {ScriptHarness} from "./ScriptHarness.sol";

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

contract SeedPoolHarness is SeedPool {
    function openingSqrtPrice(uint256 priceMicroUsd) external pure returns (uint160) {
        return _openingSqrtPrice(priceMicroUsd);
    }

    function buyFeePips(uint24 lpFee, uint24 protocolFee, bool zeroForOne) external pure returns (uint256) {
        return _buyFeePips(lpFee, protocolFee, zeroForOne);
    }
}

/// The seeding script against a stub manager, in the order an operator meets it, with the buyback,
/// the StateView and the seeder read from a record.
contract SeedPoolTest is ScriptHarness {
    address internal constant RHC_BRSR = 0x00e503925880c4b07E5Fb70232D83aD871F57a7d;
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

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
    string internal path;

    address internal timelock = makeAddr("timelock");
    address internal operator = makeAddr("operator");

    function _prefix() internal pure override returns (string memory) {
        return "SEEDPOOL_";
    }

    function setUp() public {
        vm.chainId(4663);
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
        buyback = _buyback();
        id = keccak256(
            abi.encode(
                PoolKey({currency0: RHC_BRSR, currency1: RHC_USDG, fee: 3000, tickSpacing: 60, hooks: address(0)})
            )
        );

        script = new SeedPoolHarness();
        script.pinEnvPrefix(_prefix());

        brsr.transfer(operator, 1_000_000e18);
        usdg.mint(operator, 1_000e6);
    }

    function _buyback() private returns (Buyback) {
        Staking staking = new Staking(brsr, usdg, timelock, makeAddr("slashSink"), makeAddr("treasury"), 7 days, 1e18);
        return new Buyback(
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
    }

    /// A record naming this suite's buyback and StateView, and nothing else of the market.
    function _record(bool local) private returns (string memory at) {
        at = _useRecord("seed-pool", _baseRecord("seed-pool", 4663, local, RHC_USDG));
        vm.writeJson(vm.toString(address(buyback)), at, K.BUYBACK);
        vm.writeJson(vm.toString(address(stateView)), at, K.STATE_VIEW);
        vm.writeJson(vm.toString(address(manager)), at, K.POOL_MANAGER);
        _set("BURSAR_LOCAL", local ? "1" : "0");
    }

    function _open() private {
        _as(operator, address(script), abi.encodeCall(script.run, ()));
    }

    function _add() private {
        _as(operator, address(script), abi.encodeCall(script.seedExisting, ()));
    }

    function test_seedPool_opensAddsAndReadsBackOnlyOnTheRecordsMarket() public {
        _set("BURSAR_SEED_PRICE_MICRO_USD", "200");
        _set("BURSAR_SEED_USDG_MICRO", "25000000");

        // On Robinhood Chain the market changes only with the phrase. Without it the run prints
        // the plan and sends nothing.
        path = _record(false);
        _set("BURSAR_ALLOW_MAINNET_SEED", "");
        _open();
        assertEq(manager.openedAt(id), 0);

        // A manager anywhere but the buyback's stops the run before the one-shot opening price can
        // go anywhere.
        vm.writeJson(vm.toString(makeAddr("someOtherManager")), path, K.POOL_MANAGER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.RecordMismatch.selector, K.POOL_MANAGER, makeAddr("someOtherManager"), address(manager)
            )
        );
        _open();
        vm.writeJson(vm.toString(address(manager)), path, K.POOL_MANAGER);
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(makeAddr("someOtherManager")));
        vm.expectRevert(bytes("BURSAR_BUYBACK_POOL_MANAGER is not the manager the buyback trades on"));
        _open();
        _set("BURSAR_BUYBACK_POOL_MANAGER", vm.toString(address(manager)));

        // The seeder used to be named in the shell. The record names it now.
        _set("BURSAR_SEEDER", vm.toString(makeAddr("aSeeder")));
        vm.expectRevert(
            abi.encodeWithSelector(
                BursarScript.RetiredEnv.selector, _key("BURSAR_SEEDER"), "the record's token.V4LiquiditySeeder"
            )
        );
        _open();
        _unset("BURSAR_SEEDER");
        assertEq(manager.openedAt(id), 0);

        _set("BURSAR_ALLOW_MAINNET_SEED", "i-am-opening-the-market");
        address opener = vm.computeCreateAddress(operator, vm.getNonce(operator));
        _open();
        assertEq(manager.openedAt(id), OPEN_SQRT_PRICE_X96);
        assertEq(manager.liquidityOf(id), OPEN_LIQUIDITY);
        // The key that opened the pool holds the position until governance accepts it.
        assertEq(V4LiquiditySeeder(opener).owner(), operator);
        assertEq(V4LiquiditySeeder(opener).pendingOwner(), timelock);
        assertEq(_readAddress(path, K.SEEDER), opener);

        vm.expectRevert(bytes("the pool is already open; seedExisting adds to it"));
        _open();

        // Adding goes through the recorded seeder, at the price the pool stands at. The phrase
        // that opened the market does not add to it.
        _set("BURSAR_SEED_PRICE_MICRO_USD", "0");
        _set("BURSAR_SEED_USDG_MICRO", "5000000");
        _add();
        assertEq(manager.liquidityOf(id), OPEN_LIQUIDITY);
        _set("BURSAR_ALLOW_MAINNET_SEED", "i-am-adding-to-the-market");
        _add();
        uint128 added = V4LiquiditySeeder(opener).liquidityOf(-887_220, 887_220) - OPEN_LIQUIDITY;
        assertGt(added, 0);
        assertEq(manager.liquidityOf(id), OPEN_LIQUIDITY + added);
        assertEq(manager.openedAt(id), OPEN_SQRT_PRICE_X96);

        // An expected price the pool is a long way from stops the add; within the allowed
        // distance it goes ahead.
        _set("BURSAR_SEED_PRICE_MICRO_USD", "300");
        vm.expectRevert(bytes("the pool is further from the expected price than allowed"));
        _add();
        _set("BURSAR_SEED_PRICE_MICRO_USD", "201");
        _add();

        // A recorded seeder built for another buyback would add to another pool.
        V4LiquiditySeeder stranger = new V4LiquiditySeeder(address(manager), address(_buyback()), timelock);
        vm.writeJson(vm.toString(address(stranger)), path, K.SEEDER);
        vm.expectRevert(bytes("the recorded seeder seeds a different buyback's pool"));
        _add();

        // With no seeder recorded, the add deploys one that is governance's from its first block,
        // and records it. A rehearsal record needs no phrase.
        path = _record(true);
        _set("BURSAR_ALLOW_MAINNET_SEED", "");
        address adder = vm.computeCreateAddress(operator, vm.getNonce(operator));
        _add();
        assertEq(V4LiquiditySeeder(adder).owner(), timelock);
        assertEq(_readAddress(path, K.SEEDER), adder);

        // The read-back is not optional. Without a StateView there is no seed.
        address nothing = makeAddr("noStateView");
        vm.writeJson(vm.toString(nothing), path, K.STATE_VIEW);
        vm.expectRevert(abi.encodeWithSelector(BursarScript.NotContract.selector, K.STATE_VIEW, nothing));
        _add();
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
