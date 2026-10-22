// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DeployStockRouter} from "../../script/DeployStockRouter.s.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {StockSpendRouter} from "../../src/rwa/StockSpendRouter.sol";
import {World} from "./World.sol";

/// A router from before sales: it names its registry and guard and answers nothing else, which is
/// what the live record holds until this move.
contract LegacyRouter {
    address public immutable registry;
    address public immutable guard;

    constructor(address registry_, address guard_) {
        registry = registry_;
        guard = guard_;
    }
}

/// The router move on a deployed lane: the new router lands against the carried registry and
/// guard, the record names both routers, a second run is refused, and the example mandate's
/// principal adopts it with both policies set.
contract DeployStockRouterTest is World {
    address internal principal = makeAddr("example-principal");

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYSTOCKROUTER_";
    }

    function setUp() public {
        _world("deploy-stock-router");
        _core();
        _rwa();
        // The lane script deploys the router that sells; the live record holds one that does not.
        address legacy = address(new LegacyRouter(_readAddress(path, K.ASSET_REGISTRY), _readAddress(path, K.PRICE_GUARD)));
        vm.writeJson(vm.toString(legacy), path, K.STOCK_ROUTER);
        _save();
    }

    function test_deployStockRouter_replacesTheRouterAndTheExampleAdoptsIt() public {
        address previous = _readAddress(path, K.STOCK_ROUTER);
        address registry = _readAddress(path, K.ASSET_REGISTRY);
        address guard = _readAddress(path, K.PRICE_GUARD);

        StockSpendRouter router = abi.decode(_run(DEPLOYER, address(new DeployStockRouter())), (StockSpendRouter));

        assertEq(_readAddress(path, K.STOCK_ROUTER), address(router));
        assertEq(_readAddress(path, ".rwa.previousStockRouter"), previous);
        assertEq(address(router.registry()), registry);
        assertEq(address(router.guard()), guard);
        assertEq(router.custodyOf(address(1)), router.custodyOf(address(1)));

        // The recorded router now sells, so another run would only split callers.
        DeployStockRouter again = DeployStockRouter(_pinned(address(new DeployStockRouter())));
        vm.expectRevert(abi.encodeWithSelector(DeployStockRouter.AlreadySells.selector, address(router)));
        _as(DEPLOYER, address(again), abi.encodeCall(again.run, ()));

        _theExampleAdoptsTheRouter(router, previous);
    }

    function _theExampleAdoptsTheRouter(StockSpendRouter router, address previous) private {
        IMandateAccount acct = _newMandate();
        vm.prank(principal);
        acct.setRouter(previous);
        vm.writeJson(vm.toString(address(acct)), path, ".exampleMandate.address");

        DeployStockRouter script = DeployStockRouter(_pinned(address(new DeployStockRouter())));
        vm.expectRevert(
            abi.encodeWithSelector(DeployStockRouter.NotExamplePrincipal.selector, address(acct), principal, DEPLOYER)
        );
        _as(DEPLOYER, address(script), abi.encodeCall(script.repointExample, ()));

        _as(principal, address(script), abi.encodeCall(script.repointExample, ()));
        assertEq(acct.router(), address(router));
        assertEq(router.maxSlippageBps(address(acct)), 100);
        address spy = _readAddress(path, string.concat(K.RWA_ASSETS, ".SPY.address"));
        address sgov = _readAddress(path, string.concat(K.RWA_ASSETS, ".SGOV.address"));
        assertTrue(router.assetAllowed(address(acct), spy));
        assertTrue(router.saleAllowed(address(acct), spy));
        assertFalse(router.assetAllowed(address(acct), sgov));
        assertFalse(router.saleAllowed(address(acct), sgov));

        // Repeatable: the same run from the same key changes nothing and refuses nothing.
        _as(principal, address(script), abi.encodeCall(script.repointExample, ()));
        assertEq(acct.router(), address(router));
    }

    function _newMandate() private returns (IMandateAccount acct) {
        IMandateAccount.Limits memory limits = IMandateAccount.Limits({
            perCallCap: 10e6,
            dailyCap: 50e6,
            monthlyCap: 100e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 10e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 0
        });
        MandateAccountFactory factory = MandateAccountFactory(_readAddress(path, K.FACTORY));
        vm.prank(principal);
        acct = IMandateAccount(factory.create(principal, principal, keccak256("example"), limits));
    }
}
