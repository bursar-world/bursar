// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CollateralConfig as C} from "./lib/CollateralConfig.sol";
import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";
import {RwaConfig} from "./lib/RwaConfig.sol";

import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {CreditPool} from "../src/rwa/CreditPool.sol";

/// Asks the chain what `DeployCollateral.s.sol` asked its simulation: the pool lends only through
/// the vault it was bound to, pays its spread to and slashes the record's staking pool, answers
/// to the timelock, and lets the named lender alone take cash back out.
abstract contract CollateralChecks is Verifier {
    function _checkCollateral() internal {
        address pool = _contract(K.CREDIT_POOL);
        address vault = _contract(K.COLLATERAL_VAULT);
        if (pool == address(0) || vault == address(0)) return;

        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        address staking = _recordAddress(K.STAKING);
        _is("rwa.collateral.Staking", staking, _recordAddress(K.COLLATERAL_STAKING));

        CreditPool p = CreditPool(pool);
        _is("CreditPool.usdg", _settlementAsset(), address(p.usdg()));
        _is("CreditPool.staking", staking, address(p.staking()));
        _is("CreditPool.buyback", _recordAddress(K.BUYBACK), address(p.buyback()));
        _is("CreditPool.admin", timelock, p.admin());
        _is("CreditPool.pendingAdmin", address(0), p.pendingAdmin());
        _is("CreditPool.lender", _recordAddress(K.LENDER), p.lender());
        _is("CreditPool.vault", vault, p.vault());
        _isUint("CreditPool.totalDebtCap", _param("CreditPool.totalDebtCap"), p.totalDebtCap());
        _isUint("CreditPool.perMandateCap", _param("CreditPool.perMandateCap"), p.perMandateCap());
        _isUint("CreditPool.baseRateBps", _param("CreditPool.baseRateBps"), p.baseRateBps());
        _isUint("CreditPool.slopeBps", _param("CreditPool.slopeBps"), p.slopeBps());
        if (p.cash() == 0) _owe("CreditPool holds no cash to lend: the lender funds it");

        CollateralVault v = CollateralVault(vault);
        _is("CollateralVault.registry", _recordAddress(K.ASSET_REGISTRY), address(v.registry()));
        _is("CollateralVault.guard", _recordAddress(K.PRICE_GUARD), address(v.guard()));
        _is("CollateralVault.pool", pool, address(v.pool()));
        _is("CollateralVault.factory", _recordAddress(K.FACTORY), address(v.factory()));
        _is("CollateralVault.admin", timelock, v.admin());
        _is("CollateralVault.pendingAdmin", address(0), v.pendingAdmin());

        RwaConfig.Term[] memory terms = RwaConfig.terms();
        for (uint256 i; i < terms.length; ++i) {
            address token = _recordAddress(string.concat(K.RWA_ASSETS, ".", terms[i].symbol, ".address"));
            _isUint(
                string.concat("CollateralVault.tierOf(", terms[i].symbol, ")"),
                C.tierOf(terms[i].symbol),
                v.tierOf(token)
            );
        }
    }
}

/// `forge script script/VerifyCollateral.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployCollateral.s.sol`.
contract VerifyCollateral is CollateralChecks {
    function run() external {
        _begin();
        _checkCollateral();
        _end("collateral");
    }
}
