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
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";

/// Asks the chain what `Deploy.s.sol` asked its simulation, against what the record says it
/// deployed: every one-shot pairing closed, every admin the timelock with nothing pending, the
/// deploy key holding no seat, and every figure the one recorded as applied.
abstract contract CoreChecks is Verifier {
    function _checkCore() internal {
        address timelock = _contract(K.ADMIN_TIMELOCK);
        address reputation = _contract(K.REPUTATION);
        address escrow = _contract(K.ESCROW);
        address registry = _contract(K.ORACLE_REGISTRY);
        address agents = _contract(K.AGENT_REGISTRY);
        address factory = _contract(K.FACTORY);
        if (timelock == address(0) || reputation == address(0) || escrow == address(0) || registry == address(0)) {
            return;
        }

        address asset = _settlementAsset();
        address deployer = _recordAddress(K.DEPLOYER);
        _checkTimelock(AdminTimelock(timelock), deployer);
        _checkReputation(Reputation(reputation), timelock, escrow, deployer);
        _checkEscrow(Escrow(escrow), asset, timelock, reputation, registry, agents, deployer);
        _checkRegistry(OracleRegistry(registry), asset, timelock, escrow, deployer);
        if (agents != address(0)) _checkAgents(AgentRegistry(agents), asset, timelock);
        if (factory != address(0)) {
            MandateAccountFactory f = MandateAccountFactory(factory);
            _is("MandateAccountFactory.escrow", escrow, f.escrow());
            _is("MandateAccountFactory.settlementAsset", asset, f.settlementAsset());
            _isTrue("MandateAccountFactory.blueprint holds no code", f.blueprint().code.length != 0);
        }
    }

    function _checkTimelock(AdminTimelock timelock, address deployer) private {
        _isUint("AdminTimelock.timelockPeriod", _param("AdminTimelock.timelockPeriod"), timelock.timelockPeriod());
        _is("AdminTimelock.guardian", _recordAddress(K.GUARDIAN), timelock.guardian());
        address[] memory signers = _recordAddresses(K.SIGNERS);
        address[3] memory live = timelock.getSigners();
        _isUint("roles.timelockSigners", 3, signers.length);
        for (uint256 i; i < 3 && i < signers.length; ++i) {
            _is("AdminTimelock.signer", signers[i], live[i]);
        }
        _isTrue("the deploy key holds a signer seat", !timelock.isSigner(deployer));
        _isTrue("the guardian holds a signer seat", !timelock.isSigner(timelock.guardian()));
    }

    function _checkReputation(Reputation reputation, address timelock, address escrow, address deployer) private {
        _is("Reputation.admin", timelock, reputation.admin());
        _is("Reputation.pendingAdmin", address(0), reputation.pendingAdmin());
        _is("Reputation.escrow", escrow, reputation.escrow());
        _is("Reputation.deployer", deployer, reputation.deployer());
        IReputation.CapCurve memory curve = reputation.curve();
        _isUint("Reputation.baseCap", _param("Reputation.baseCap"), curve.baseCap);
        _isUint("Reputation.capPerScore", _param("Reputation.capPerScore"), curve.capPerScore);
        _isUint("Reputation.maxCap", _param("Reputation.maxCap"), curve.maxCap);
        // The ceiling has to be one a perfect score reaches, or the top of the curve is decoration.
        _isTrue(
            "Reputation.maxCap is above what a perfect score reaches",
            uint256(curve.baseCap) + 100 * uint256(curve.capPerScore) >= curve.maxCap
        );
    }

    function _checkEscrow(
        Escrow escrow,
        address asset,
        address timelock,
        address reputation,
        address registry,
        address agents,
        address deployer
    ) private {
        _is("Escrow.settlementAsset", asset, escrow.settlementAsset());
        _is("Escrow.reputation", reputation, escrow.reputation());
        _is("Escrow.resolver", registry, escrow.resolver());
        _is("Escrow.registry", agents, address(escrow.registry()));
        _is("Escrow.pauser", timelock, escrow.pauser());
        _is("Escrow.treasury", _recordAddress(K.TREASURY), escrow.treasury());
        _is("Escrow.pendingTreasury", address(0), escrow.pendingTreasury());
        _is("Escrow.deployer", deployer, escrow.deployer());
        _isUint("Escrow.feeBps", _param("Escrow.feeBps"), escrow.feeBps());
        _isUint("Escrow.resolverFeeBps", _param("Escrow.resolverFeeBps"), escrow.resolverFeeBps());
        _isUint("Escrow.disputeBondBps", _param("Escrow.disputeBondBps"), escrow.disputeBondBps());
        _isUint("Escrow.minTtl", _param("Escrow.minTtl"), escrow.minTtl());
        _isUint("Escrow.maxTtl", _param("Escrow.maxTtl"), escrow.maxTtl());
        _isUint("Escrow.disputeWindow", _param("Escrow.disputeWindow"), escrow.disputeWindow());
        _isUint("Escrow.minLock", _param("Escrow.minLock"), escrow.minLock());
        _isTrue("Escrow is paused", !escrow.paused());
    }

    function _checkRegistry(OracleRegistry registry, address asset, address timelock, address escrow, address deployer)
        private
    {
        _is("OracleRegistry.escrow", escrow, registry.escrow());
        _is("OracleRegistry.admin", timelock, registry.admin());
        _is("OracleRegistry.pendingAdmin", address(0), registry.pendingAdmin());
        _is("OracleRegistry.slashSink", _recordAddress(K.SLASH_SINK), registry.slashSink());
        _is("OracleRegistry.settlementAsset", asset, registry.settlementAsset());
        _is("OracleRegistry.deployer", deployer, registry.deployer());
        _isTrue("OracleRegistry is paused", !registry.paused());

        IOracleRegistry.Config memory c = registry.config();
        _isUint("OracleRegistry.commitWindow", _param("OracleRegistry.commitWindow"), c.commitWindow);
        _isUint("OracleRegistry.revealWindow", _param("OracleRegistry.revealWindow"), c.revealWindow);
        _isUint("OracleRegistry.unbondingPeriod", _param("OracleRegistry.unbondingPeriod"), c.unbondingPeriod);
        _isUint("OracleRegistry.quorum", _param("OracleRegistry.quorum"), c.quorum);
        _isUint("OracleRegistry.maxVoters", _param("OracleRegistry.maxVoters"), c.maxVoters);
        _isUint("OracleRegistry.maxDeviation", _param("OracleRegistry.maxDeviation"), c.maxDeviation);
        _isUint("OracleRegistry.slashBps", _param("OracleRegistry.slashBps"), c.slashBps);

        // The one pairing the core run cannot close. Until the staking run does, no resolver can
        // bond, and that is owed rather than wrong.
        address staking = _recordAddress(K.STAKING);
        address wired = address(registry.staking());
        if (staking == address(0) || wired == address(0)) {
            if (wired == address(0)) _owe("OracleRegistry.staking is unset: DeployStaking.s.sol closes it");
            else _mismatch("OracleRegistry.staking names a pool the record does not");
            return;
        }
        _is("OracleRegistry.staking", staking, wired);
        _is("OracleRegistry.bondAsset", _recordAddress(K.BRSR), address(registry.bondAsset()));
    }

    function _checkAgents(AgentRegistry agents, address asset, address timelock) private {
        _is("AgentRegistry.settlementAsset", asset, address(agents.settlementAsset()));
        _is("AgentRegistry.admin", timelock, agents.admin());
        _is("AgentRegistry.pendingAdmin", address(0), agents.pendingAdmin());
        // No contract can take agent collateral. The only path to it is a proposal.
        _is("AgentRegistry.slasher", address(0), agents.slasher());
        _is("AgentRegistry.slashSink", _recordAddress(K.SLASH_SINK), agents.slashSink());
        _isUint("AgentRegistry.minStake", _param("AgentRegistry.minStake"), agents.minStake());
        _isUint("AgentRegistry.slashBps", _param("AgentRegistry.slashBps"), agents.slashBps());
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
