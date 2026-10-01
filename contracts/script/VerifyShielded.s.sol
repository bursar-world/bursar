// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

/// The reads this check makes, declared here so it builds with the compiler the rest of the verify
/// scripts use. The contracts themselves are built with the one the vendored Privacy Pools code
/// pins, and a file cannot import both.
interface IEntrypointReads {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function assetConfig(address asset)
        external
        view
        returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS);
}

interface IShieldedPoolReads {
    function ENTRYPOINT() external view returns (address);
    function ASSET() external view returns (address);
    function ACCESS_REGISTRY() external view returns (address);
    function WITHDRAWAL_VERIFIER() external view returns (address);
    function RAGEQUIT_VERIFIER() external view returns (address);
    function MAX_DEPOSIT() external view returns (uint256);
    function MAX_TOTAL() external view returns (uint256);
    function MAX_PER_DEPOSITOR() external view returns (uint128);
    function DEPOSITOR_WINDOW() external view returns (uint64);
    function SCOPE() external view returns (uint256);
    function dead() external view returns (bool);
}

interface IShieldedRelayReads {
    function POOL() external view returns (address);
    function ENTRYPOINT() external view returns (address);
    function ACCESS_REGISTRY() external view returns (address);
    function MAX_FEE_BPS() external view returns (uint256);
}

/// Asks the chain what `DeployShielded.s.sol` asked its simulation: the timelock holds the
/// Entrypoint's owner role and the deploy key does not, the postman role sits with the recorded
/// postman alone, the pool is registered on the recorded terms, and the proxy runs the recorded
/// implementation with the recorded libraries linked in.
abstract contract ShieldedChecks is Verifier {
    bytes32 private constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 private constant ASP_POSTMAN = keccak256("ASP_POSTMAN");
    /// The ERC-1967 implementation slot, `keccak256("eip1967.proxy.implementation") - 1`.
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _checkShielded() internal {
        address entrypoint = _contract(K.ENTRYPOINT);
        address pool = _contract(K.SHIELDED_POOL);
        address relay = _contract(K.SHIELDED_RELAY);
        address implementation = _contract(K.ENTRYPOINT_IMPLEMENTATION);
        if (entrypoint == address(0) || pool == address(0) || relay == address(0)) return;

        _checkEntrypoint(IEntrypointReads(entrypoint), implementation, pool);
        _checkPool(IShieldedPoolReads(pool), entrypoint);

        IShieldedRelayReads r = IShieldedRelayReads(relay);
        _is("ShieldedRelay.POOL", pool, r.POOL());
        _is("ShieldedRelay.ENTRYPOINT", entrypoint, r.ENTRYPOINT());
        _is("ShieldedRelay.ACCESS_REGISTRY", _recordAddress(K.SHIELDED_ACCESS_REGISTRY), r.ACCESS_REGISTRY());
        _isUint("ShieldedRelay.MAX_FEE_BPS", _recordUint(K.SHIELDED_MAX_RELAY_FEE), r.MAX_FEE_BPS());

        _checkLibrary("PoseidonT3", _recordAddress(K.POSEIDON_T3), pool);
        _checkLibrary("PoseidonT4", _recordAddress(K.POSEIDON_T4), pool);
    }

    function _checkEntrypoint(IEntrypointReads e, address implementation, address pool) private {
        address timelock = _recordAddress(K.ADMIN_TIMELOCK);
        address deployer = _recordAddress(K.DEPLOYER);
        address postman = _recordAddress(K.ASP_POSTMAN);
        bool timelockOwns = e.hasRole(OWNER_ROLE, timelock);
        bool deployerOwns = e.hasRole(OWNER_ROLE, deployer);
        bool postmanPosts = e.hasRole(ASP_POSTMAN, postman);
        bool deployerPosts = e.hasRole(ASP_POSTMAN, deployer);
        _fact("Entrypoint.OWNER_ROLE held by the timelock", timelockOwns);
        _fact("Entrypoint.OWNER_ROLE held by the deploy key", deployerOwns);
        _fact("Entrypoint.ASP_POSTMAN held by the postman", postmanPosts);
        _fact("Entrypoint.ASP_POSTMAN held by the deploy key", deployerPosts);
        _isTrue("Entrypoint: the timelock does not hold OWNER_ROLE", timelockOwns);
        _isTrue("Entrypoint: the deploy key still holds OWNER_ROLE", !deployerOwns);
        _isTrue("Entrypoint: the postman does not hold ASP_POSTMAN", postmanPosts);
        _isTrue("Entrypoint: the deploy key holds ASP_POSTMAN", !deployerPosts);
        bytes32 slot = vm.load(address(e), IMPLEMENTATION_SLOT);
        _is("Entrypoint implementation", implementation, address(uint160(uint256(slot))));

        (address registered, uint256 minimumDeposit, uint256 vettingFee, uint256 maxRelayFee) =
            e.assetConfig(_settlementAsset());
        _is("Entrypoint.assetConfig.pool", pool, registered);
        _isUint("Entrypoint.minimumDeposit", _recordUint(K.SHIELDED_MIN_DEPOSIT), minimumDeposit);
        _isUint("Entrypoint.vettingFeeBps", _recordUint(K.SHIELDED_VETTING_FEE), vettingFee);
        _isUint("Entrypoint.maxRelayFeeBps", _recordUint(K.SHIELDED_MAX_RELAY_FEE), maxRelayFee);
    }

    function _checkPool(IShieldedPoolReads p, address entrypoint) private {
        address asset = _settlementAsset();
        _is("ShieldedPool.ENTRYPOINT", entrypoint, p.ENTRYPOINT());
        _is("ShieldedPool.ASSET", asset, p.ASSET());
        _is("privacy.shielded.asset", asset, _recordAddress(K.SHIELDED_ASSET));
        _is("ShieldedPool.ACCESS_REGISTRY", _recordAddress(K.SHIELDED_ACCESS_REGISTRY), p.ACCESS_REGISTRY());
        _is("ShieldedPool.WITHDRAWAL_VERIFIER", _contract(K.WITHDRAWAL_VERIFIER), p.WITHDRAWAL_VERIFIER());
        _is("ShieldedPool.RAGEQUIT_VERIFIER", _contract(K.COMMITMENT_VERIFIER), p.RAGEQUIT_VERIFIER());
        _isUint("ShieldedPool.MAX_DEPOSIT", _recordUint(K.SHIELDED_MAX_DEPOSIT), p.MAX_DEPOSIT());
        _isUint("ShieldedPool.MAX_TOTAL", _recordUint(K.SHIELDED_MAX_TOTAL), p.MAX_TOTAL());
        _isUint("ShieldedPool.MAX_PER_DEPOSITOR", _recordUint(K.SHIELDED_MAX_PER_DEPOSITOR), p.MAX_PER_DEPOSITOR());
        _isUint("ShieldedPool.DEPOSITOR_WINDOW", _recordUint(K.SHIELDED_DEPOSITOR_WINDOW), p.DEPOSITOR_WINDOW());
        _isUint("ShieldedPool.SCOPE", _recordUint(K.SHIELDED_SCOPE), p.SCOPE());
        bool dead = p.dead();
        _fact("ShieldedPool.dead", dead);
        _isTrue("ShieldedPool is wound down", !dead);
    }

    /// The pool calls its hashing libraries by address, so the recorded ones have to hold code and
    /// be the ones the pool's code names.
    function _checkLibrary(string memory name, address lib, address pool) private {
        if (lib.code.length == 0) {
            _mismatch(string.concat(name, " holds no code at ", vm.toString(lib)));
            return;
        }
        _isTrue(string.concat("ShieldedPool is not linked against the recorded ", name), _linksTo(pool, lib));
    }
}

/// `forge script script/VerifyShielded.s.sol --rpc-url "$RHC_RPC_URL"`, after `DeployShielded.s.sol`.
contract VerifyShielded is ShieldedChecks {
    function run() external {
        _begin();
        _checkShielded();
        _end("shielded");
    }
}
