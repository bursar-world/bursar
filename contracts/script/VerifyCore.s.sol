// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Verifier} from "./lib/Verifier.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";

/// Asks the chain what `Deploy.s.sol` asked its simulation, against what the record says it
/// deployed: every one-shot pairing closed, every admin the timelock with nothing pending, the
/// deploy key holding no seat, and every figure the one recorded as applied.
///
/// Each contract is checked on its own, and every read goes through `_ask`, so a record that names
/// a missing contract, an empty address or the wrong kind of contract yields a list of mismatches
/// and the run still asks everything else before it fails.
abstract contract CoreChecks is Verifier {
    function _checkCore() internal {
        address timelock = _contract(K.ADMIN_TIMELOCK);
        address reputation = _contract(K.REPUTATION);
        address escrow = _contract(K.ESCROW);
        address registry = _contract(K.ORACLE_REGISTRY);
        address agents = _contract(K.AGENT_REGISTRY);
        address factory = _contract(K.FACTORY);

        address deployer = _recordAddress(K.DEPLOYER);
        if (timelock != address(0)) _checkTimelock(timelock, deployer);
        if (reputation != address(0)) _checkReputation(reputation, deployer);
        if (escrow != address(0)) _checkEscrow(escrow, deployer);
        if (registry != address(0)) _checkRegistry(registry, deployer);
        if (agents != address(0)) _checkAgents(agents);
        if (factory != address(0)) _checkFactory(factory);
    }

    function _checkTimelock(address timelock, address deployer) private {
        AdminTimelock t = AdminTimelock(timelock);
        _isParamAt("AdminTimelock.timelockPeriod", timelock, _sig(t.timelockPeriod.selector));
        (bool hasGuardian, address guardian) =
            _askAddress("AdminTimelock.guardian", timelock, _sig(t.guardian.selector));
        if (hasGuardian) _is("AdminTimelock.guardian", _recordAddress(K.GUARDIAN), guardian);

        address[] memory signers = _recordAddresses(K.SIGNERS);
        _isUint("roles.timelockSigners", 3, signers.length);
        (bool ok, bytes memory answer) = _ask("AdminTimelock.getSigners", timelock, _sig(t.getSigners.selector), 3);
        if (ok) {
            uint256[3] memory live = abi.decode(answer, (uint256[3]));
            for (uint256 i; i < 3 && i < signers.length; ++i) {
                string memory seat = string.concat("AdminTimelock.signer[", vm.toString(i), "]");
                (bool isAddress, address signer) = _asAddress(seat, timelock, live[i]);
                if (isAddress) _is(seat, signers[i], signer);
            }
        }
        _isUintAt("the deploy key holds a signer seat", 0, timelock, abi.encodeCall(t.isSigner, (deployer)));
        if (hasGuardian) {
            _isUintAt("the guardian holds a signer seat", 0, timelock, abi.encodeCall(t.isSigner, (guardian)));
        }
    }

    function _checkReputation(address reputation, address deployer) private {
        Reputation r = Reputation(reputation);
        _isAt("Reputation.admin", _recordAddress(K.ADMIN_TIMELOCK), reputation, _sig(r.admin.selector));
        _isAt("Reputation.pendingAdmin", address(0), reputation, _sig(r.pendingAdmin.selector));
        _isAt("Reputation.escrow", _recordAddress(K.ESCROW), reputation, _sig(r.escrow.selector));
        _isAt("Reputation.deployer", deployer, reputation, _sig(r.deployer.selector));

        (bool ok, bytes memory answer) = _ask("Reputation.curve", reputation, _sig(r.curve.selector), 3);
        if (!ok) return;
        (uint256 baseCap, uint256 capPerScore, uint256 maxCap) = abi.decode(answer, (uint256, uint256, uint256));
        _isParam("Reputation.baseCap", baseCap);
        _isParam("Reputation.capPerScore", capPerScore);
        _isParam("Reputation.maxCap", maxCap);
        // The ceiling has to be one a perfect score reaches, or the top of the curve is decoration.
        _isTrue(
            "Reputation.maxCap is above what a perfect score reaches",
            baseCap <= type(uint128).max && capPerScore <= type(uint128).max && baseCap + 100 * capPerScore >= maxCap
        );

        (ok, answer) = _ask("Reputation.weights", reputation, _sig(r.weights.selector), 3);
        if (!ok) return;
        (uint256 minScored, uint256 edgeCap, uint256 fullCredit) = abi.decode(answer, (uint256, uint256, uint256));
        _isParam("Reputation.minScored", minScored);
        _isParam("Reputation.edgeCap", edgeCap);
        _isParam("Reputation.fullCredit", fullCredit);
        // A full score has to be reachable in whole edges, and the first lock a new payee can take
        // has to be large enough to count, or the curve is decoration again.
        _isTrue("Reputation.fullCredit is under one edge", fullCredit >= edgeCap);
        _isTrue("Reputation.minScored is above the cap a new payee starts with", minScored <= baseCap);
    }

    function _checkEscrow(address escrow, address deployer) private {
        Escrow e = Escrow(escrow);
        _isAt("Escrow.settlementAsset", _settlementAsset(), escrow, _sig(e.settlementAsset.selector));
        _isAt("Escrow.reputation", _recordAddress(K.REPUTATION), escrow, _sig(e.reputation.selector));
        _isAt("Escrow.resolver", _recordAddress(K.ORACLE_REGISTRY), escrow, _sig(e.resolver.selector));
        _isAt("Escrow.registry", _recordAddress(K.AGENT_REGISTRY), escrow, _sig(e.registry.selector));
        _isAt("Escrow.pauser", _recordAddress(K.ADMIN_TIMELOCK), escrow, _sig(e.pauser.selector));
        _isAt("Escrow.treasury", _recordAddress(K.TREASURY), escrow, _sig(e.treasury.selector));
        _isAt("Escrow.pendingTreasury", address(0), escrow, _sig(e.pendingTreasury.selector));
        _isAt("Escrow.deployer", deployer, escrow, _sig(e.deployer.selector));
        _isParamAt("Escrow.feeBps", escrow, _sig(e.feeBps.selector));
        _isParamAt("Escrow.resolverFeeBps", escrow, _sig(e.resolverFeeBps.selector));
        _isParamAt("Escrow.disputeBondBps", escrow, _sig(e.disputeBondBps.selector));
        _isParamAt("Escrow.minTtl", escrow, _sig(e.minTtl.selector));
        _isParamAt("Escrow.maxTtl", escrow, _sig(e.maxTtl.selector));
        _isParamAt("Escrow.disputeWindow", escrow, _sig(e.disputeWindow.selector));
        _isParamAt("Escrow.minLock", escrow, _sig(e.minLock.selector));
        _isUintAt("Escrow is paused", 0, escrow, _sig(e.paused.selector));
    }

    function _checkRegistry(address registry, address deployer) private {
        OracleRegistry o = OracleRegistry(registry);
        _isAt("OracleRegistry.escrow", _recordAddress(K.ESCROW), registry, _sig(o.escrow.selector));
        _isAt("OracleRegistry.admin", _recordAddress(K.ADMIN_TIMELOCK), registry, _sig(o.admin.selector));
        _isAt("OracleRegistry.pendingAdmin", address(0), registry, _sig(o.pendingAdmin.selector));
        _isAt("OracleRegistry.slashSink", _recordAddress(K.SLASH_SINK), registry, _sig(o.slashSink.selector));
        _isAt("OracleRegistry.settlementAsset", _settlementAsset(), registry, _sig(o.settlementAsset.selector));
        _isAt("OracleRegistry.deployer", deployer, registry, _sig(o.deployer.selector));
        _isUintAt("OracleRegistry is paused", 0, registry, _sig(o.paused.selector));

        (bool ok, bytes memory answer) = _ask("OracleRegistry.config", registry, _sig(o.config.selector), 7);
        if (ok) {
            uint256[7] memory c = abi.decode(answer, (uint256[7]));
            _isParam("OracleRegistry.commitWindow", c[0]);
            _isParam("OracleRegistry.revealWindow", c[1]);
            _isParam("OracleRegistry.unbondingPeriod", c[2]);
            _isParam("OracleRegistry.quorum", c[3]);
            _isParam("OracleRegistry.maxVoters", c[4]);
            _isParam("OracleRegistry.maxDeviation", c[5]);
            _isParam("OracleRegistry.slashBps", c[6]);
        }

        // The one pairing the core run cannot close. Until the staking run does, no resolver can
        // bond, and that is reported as owed.
        (bool answered, address wired) = _askAddress("OracleRegistry.staking", registry, _sig(o.staking.selector));
        if (!answered) return;
        address staking = _recordAddress(K.STAKING);
        if (staking == address(0) || wired == address(0)) {
            if (wired == address(0)) _owe("OracleRegistry.staking is unset: DeployStaking.s.sol closes it");
            else _mismatch("OracleRegistry.staking names a pool the record does not");
            return;
        }
        _is("OracleRegistry.staking", staking, wired);
        _isAt("OracleRegistry.bondAsset", _recordAddress(K.BRSR), registry, _sig(o.bondAsset.selector));
    }

    function _checkAgents(address agents) private {
        AgentRegistry a = AgentRegistry(agents);
        _isAt("AgentRegistry.settlementAsset", _settlementAsset(), agents, _sig(a.settlementAsset.selector));
        _isAt("AgentRegistry.admin", _recordAddress(K.ADMIN_TIMELOCK), agents, _sig(a.admin.selector));
        _isAt("AgentRegistry.pendingAdmin", address(0), agents, _sig(a.pendingAdmin.selector));
        // No contract can take agent collateral. The only path to it is a proposal.
        _isAt("AgentRegistry.slasher", address(0), agents, _sig(a.slasher.selector));
        _isAt("AgentRegistry.slashSink", _recordAddress(K.SLASH_SINK), agents, _sig(a.slashSink.selector));
        _isParamAt("AgentRegistry.minStake", agents, _sig(a.minStake.selector));
        _isParamAt("AgentRegistry.slashBps", agents, _sig(a.slashBps.selector));
    }

    function _checkFactory(address factory) private {
        MandateAccountFactory f = MandateAccountFactory(factory);
        _isAt("MandateAccountFactory.escrow", _recordAddress(K.ESCROW), factory, _sig(f.escrow.selector));
        _isAt("MandateAccountFactory.settlementAsset", _settlementAsset(), factory, _sig(f.settlementAsset.selector));
        (bool ok, address blueprint) =
            _askAddress("MandateAccountFactory.blueprint", factory, _sig(f.blueprint.selector));
        if (ok) _isTrue("MandateAccountFactory.blueprint holds no code", blueprint.code.length != 0);
    }

    function _sig(bytes4 selector) private pure returns (bytes memory) {
        return abi.encodePacked(selector);
    }
}

/// `forge script script/VerifyCore.s.sol --rpc-url "$RHC_RPC_URL"`, after `Deploy.s.sol` lands.
contract VerifyCore is CoreChecks {
    function run() external {
        _begin();
        _checkCore();
        _end("core");
    }
}
