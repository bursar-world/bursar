// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployCollateral} from "../../script/DeployCollateral.s.sol";
import {BursarScript} from "../../script/lib/BursarScript.sol";
import {CollateralConfig as C} from "../../script/lib/CollateralConfig.sol";
import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {Staking} from "../../src/token/Staking.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {World} from "./World.sol";

/// The collateral lane, built entirely on what the record names: the registry and guard the RWA
/// run deployed, the record's factory, staking pool and buyback, and a lender named on purpose.
/// Every address comes from the record or the parameter file.
contract DeployCollateralTest is World {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function _prefix() internal pure override returns (string memory) {
        return "DEPLOYCOLLATERAL_";
    }

    function setUp() public {
        _world("deploy-collateral");
        _core();
        _token();
        _staking();
        _rwa();
        _save();
    }

    function test_deployCollateral_buildsOnTheRecordAndLendsOnlyToTheNamedLender() public {
        _theLaneIsBuiltOnTheRecord();
        _onlyTheNamedLenderTakesCashBack();
        _aSecondRunIsRefused();
        _aLenderIsNeverInferred();
        _aLenderWearingAnotherHatIsRefused();
        _aRegistryOnAnotherAssetIsRefused();
        _aBuybackForAnotherPoolIsRefused();
    }

    function _deploy() private returns (DeployCollateral.Deployment memory) {
        return abi.decode(_run(DEPLOYER, address(new DeployCollateral())), (DeployCollateral.Deployment));
    }

    function _expectRefused(bytes memory reason) private {
        address script = _pinned(address(new DeployCollateral()));
        vm.expectRevert(reason);
        _as(DEPLOYER, script, abi.encodeWithSignature("run()"));
    }

    function _theLaneIsBuiltOnTheRecord() private {
        _restore();
        DeployCollateral.Deployment memory out = _deploy();
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);

        assertEq(address(out.pool.staking()), _readAddress(path, K.STAKING));
        assertEq(address(out.pool.buyback()), _readAddress(path, K.BUYBACK));
        assertEq(out.pool.admin(), timelock);
        assertEq(out.pool.lender(), vm.envAddress(_key("BURSAR_LENDER")));
        assertEq(out.pool.vault(), address(out.vault));
        assertEq(out.pool.totalDebtCap(), C.TOTAL_DEBT_CAP);
        assertEq(address(out.vault.registry()), _readAddress(path, K.ASSET_REGISTRY));
        assertEq(address(out.vault.guard()), _readAddress(path, K.PRICE_GUARD));
        assertEq(address(out.vault.factory()), _readAddress(path, K.FACTORY));
        assertEq(out.vault.admin(), timelock);
        assertEq(out.vault.tierOf(_readAddress(path, ".rwa.assets.SPY.address")), 2);

        assertEq(_readAddress(path, K.CREDIT_POOL), address(out.pool));
        assertEq(_readAddress(path, K.COLLATERAL_VAULT), address(out.vault));
        assertEq(_readAddress(path, K.COLLATERAL_STAKING), _readAddress(path, K.STAKING));
        assertEq(_readAddress(path, K.LENDER), out.pool.lender());

        // The bind is one-shot: nothing can point the pool at another vault.
        vm.prank(DEPLOYER);
        vm.expectRevert(CreditPool.NotDeployer.selector);
        out.pool.bindVault(address(this));
    }

    function _onlyTheNamedLenderTakesCashBack() private {
        _restore();
        DeployCollateral.Deployment memory out = _deploy();
        MockUsdg(USDG).mint(address(this), 5e6);
        IERC20(USDG).approve(address(out.pool), 5e6);
        out.pool.fund(5e6);

        vm.expectRevert(CreditPool.NotLender.selector);
        out.pool.withdrawLiquidity(address(this), 5e6);

        address lender = out.pool.lender();
        vm.prank(lender);
        out.pool.withdrawLiquidity(lender, 5e6);
        assertEq(out.pool.cash(), 0);
    }

    function _aSecondRunIsRefused() private {
        _restore();
        DeployCollateral.Deployment memory out = _deploy();
        _expectRefused(abi.encodeWithSelector(BursarScript.AlreadyRecorded.selector, K.CREDIT_POOL, address(out.pool)));
    }

    /// The lender carries the lane's losses, so the run never falls back to whichever key signs.
    function _aLenderIsNeverInferred() private {
        _restore();
        string memory lender = vm.envString(_key("BURSAR_LENDER"));
        _set("BURSAR_LENDER", vm.toString(address(0)));
        _expectRefused(abi.encodeWithSelector(BursarScript.MissingEnv.selector, _key("BURSAR_LENDER")));
        _set("BURSAR_LENDER", lender);
    }

    function _aLenderWearingAnotherHatIsRefused() private {
        _restore();
        string memory lender = vm.envString(_key("BURSAR_LENDER"));
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        _set("BURSAR_LENDER", vm.toString(timelock));
        _expectRefused(abi.encodeWithSelector(DeployCollateral.RoleCollision.selector, "lender", "timelock", timelock));

        address treasury = _readAddress(path, K.TREASURY);
        _set("BURSAR_LENDER", vm.toString(treasury));
        _expectRefused(abi.encodeWithSelector(DeployCollateral.RoleCollision.selector, "lender", "treasury", treasury));
        _set("BURSAR_LENDER", lender);
    }

    /// The vault values collateral through the registry and lends against it from a pool in the
    /// record's asset. A registry that settles in something else would value the wrong money, and
    /// an address that is not a registry at all is named in the error.
    function _aRegistryOnAnotherAssetIsRefused() private {
        _restore();
        MockUsdg otherAsset = new MockUsdg();
        address[] memory none = new address[](0);
        AssetRegistry.Asset[] memory noConfigs = new AssetRegistry.Asset[](0);
        AssetRegistry other =
            new AssetRegistry(_readAddress(path, K.ADMIN_TIMELOCK), address(otherAsset), none, noConfigs);
        vm.writeJson(vm.toString(address(other)), path, K.ASSET_REGISTRY);
        _expectRefused(
            abi.encodeWithSelector(
                BursarScript.WiringFailed.selector, "registry.settlementAsset", USDG, address(otherAsset)
            )
        );

        _restore();
        address vesting = _readAddress(path, K.VESTING);
        vm.writeJson(vm.toString(vesting), path, K.ASSET_REGISTRY);
        _expectRefused(abi.encodeWithSelector(BursarScript.NoAnswer.selector, "AssetRegistry.settlementAsset", vesting));
    }

    /// A write-off converts at the buyback's ceiling and slashes the staking pool, so the two have
    /// to be one deployment's pair.
    function _aBuybackForAnotherPoolIsRefused() private {
        _restore();
        address timelock = _readAddress(path, K.ADMIN_TIMELOCK);
        address paired = _readAddress(path, K.STAKING);
        Staking other = new Staking(
            IERC20(_readAddress(path, K.BRSR)),
            IERC20(USDG),
            timelock,
            _readAddress(path, K.SLASH_SINK),
            _readAddress(path, K.TREASURY),
            7 days,
            1e27
        );
        vm.writeJson(vm.toString(address(other)), path, K.STAKING);
        _expectRefused(abi.encodeWithSelector(DeployCollateral.BuybackStakingMismatch.selector, paired, address(other)));
    }
}
