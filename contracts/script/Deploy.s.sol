// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IUsdg} from "./interfaces/IUsdg.sol";
import {BursarScript} from "./lib/BursarScript.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";
import {IStaking} from "../src/token/interfaces/IStaking.sol";

/// Deploys the mandate contracts in the one order that leaves no contract half-wired, and
/// stops when the parameter set is internally inconsistent. The first script of a deployment:
/// every later one reads what this one records.
///
/// Three pairings cannot be expressed in a constructor, because each side needs the other's
/// address: reputation to escrow, escrow to resolver, resolver to escrow. Each is closed by a
/// one-shot deployer-only setter, so all three have to come from the address that deployed the
/// contracts, in the same run. Miss one and the deployment is stuck: the setters take no second
/// call and the constructors are already spent.
///
/// The fourth pairing, the registry's staking pool, closes in `DeployStaking.s.sol`, from the
/// same key, because the pool is deployed there. Until it does, no resolver can bond.
///
/// The invariants asserted here are the ones no single constructor can see. A fee plus a
/// resolver fee at or above a whole settlement would leave nothing to split; a zero base cap
/// would reject every payee that has no history, which is every payee on day one; a scored
/// minimum above the base cap is one no first lock can reach, so nobody would ever earn a point.
///
/// Gas on Robinhood Chain is ETH and settlement is USDG, two different assets held at two
/// different scales. Nothing in this script reads a native balance.
contract Deploy is BursarScript {
    /// What the deploy key has to hold in the settlement asset before the run starts. This
    /// deployment spends no USDG. The balance shows that the address in the record is the asset the
    /// system will settle in, and that the key can fund the first live mandate afterwards.
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;

    /// What `BURSAR_ALLOW_EOA_GOVERNANCE` has to say.
    string internal constant EOA_GOVERNANCE_ACK = "i-accept-eoa-governance";

    struct Deployment {
        address timelock;
        address reputation;
        address escrow;
        address oracleRegistry;
        address agentRegistry;
        address factory;
    }

    error AssetNotContract(address asset);
    error AssetDecimalsMismatch(uint8 found, uint8 expected);
    error AssetNotUsdg(address configured, address expected);
    error AssetPaused(address asset);
    error AddressFrozen(string role, address account);
    error SettlementBalanceTooLow(address account, uint256 held, uint256 floor);
    error FeeSplitTooLarge(uint16 feeBps, uint16 resolverFeeBps);
    error DisputeBondTooLarge(uint16 disputeBondBps);
    error TimelockNotContract(address timelock);
    error DeployerIsTimelockSigner(address deployer);
    error GovernanceHasNoMultisig();
    error EoaGovernanceNotAcknowledged(string given, string required);
    error RoleCollision(string role, string otherRole, address account);
    error BaseCapZero();
    error MinScoredAboveBaseCap(uint128 minScored, uint128 baseCap);

    address private asset;
    address private treasury;
    address private slashSink;
    address[3] private signers;
    address private guardian;
    uint64 private timelockPeriod;
    /// Live governance this run joins, or zero when it brings its own.
    address private existingTimelock;
    /// Live staking pool whose bond policy this run's registry reads, or zero when
    /// `DeployStaking.s.sol` names it later.
    address private existingStaking;

    uint16 private feeBps;
    uint16 private resolverFeeBps;
    uint16 private disputeBondBps;
    uint64 private minTtl;
    uint64 private maxTtl;
    uint64 private disputeWindow;
    uint128 private minLock;

    IReputation.CapCurve private curve;
    IReputation.Weights private weights;
    IOracleRegistry.Config private oracleConfig;

    bool private withAgentRegistry;
    uint128 private agentMinStake;
    uint16 private agentSlashBps;

    AdminTimelock private timelock;
    Reputation private reputation;
    Escrow private escrow;
    OracleRegistry private oracleRegistry;
    AgentRegistry private agentRegistry;
    MandateAccountFactory private factory;

    function run() external returns (Deployment memory) {
        _loadPrefix();
        _requireChain();
        address deployer = _deployer();

        _loadEnv();
        _preflight(deployer);

        vm.startBroadcast(deployer);
        _deploy();
        vm.stopBroadcast();

        _verify(deployer);
        _record(deployer);
        _report(deployer);

        return Deployment({
            timelock: address(timelock),
            reputation: address(reputation),
            escrow: address(escrow),
            oracleRegistry: address(oracleRegistry),
            agentRegistry: address(agentRegistry),
            factory: address(factory)
        });
    }

    function _loadEnv() private {
        asset = _settlementAsset();
        treasury = _role(K.TREASURY, "BURSAR_TREASURY");
        slashSink = _role(K.SLASH_SINK, "BURSAR_SLASH_SINK");
        guardian = _role(K.GUARDIAN, "BURSAR_TIMELOCK_GUARDIAN");
        _loadSigners();
        timelockPeriod = _envUint64("BURSAR_TIMELOCK_PERIOD");

        // A first deployment brings its own governance. A run that finds governance in the record,
        // or is told to join one, joins it, so one delay covers every parameter. A recorded
        // timelock with no code behind it is a broadcast that never landed, and is replaced.
        address recorded = _recordAddress(K.ADMIN_TIMELOCK);
        if (recorded.code.length == 0) recorded = address(0);
        address named = _envAddressOr("BURSAR_ADMIN_TIMELOCK", address(0));
        if (recorded != address(0) && named != address(0) && named != recorded) {
            revert RecordMismatch(K.ADMIN_TIMELOCK, recorded, named);
        }
        existingTimelock = recorded != address(0) ? recorded : named;

        // A staking pool already in the record is joined here, so the resolver registry bonds in
        // its token from the first block. The usual order records it later, and the staking
        // deployment closes the link from its side.
        address pool = _recordAddress(K.STAKING);
        existingStaking = pool.code.length == 0 ? address(0) : pool;
        _refuseRetired("BURSAR_STAKING", "the record's token.Staking");

        feeBps = _envUint16("BURSAR_FEE_BPS");
        resolverFeeBps = _envUint16("BURSAR_RESOLVER_FEE_BPS");
        disputeBondBps = _envUint16("BURSAR_DISPUTE_BOND_BPS");
        minTtl = _envUint64("BURSAR_MIN_TTL");
        maxTtl = _envUint64("BURSAR_MAX_TTL");
        disputeWindow = _envUint64("BURSAR_DISPUTE_WINDOW");
        minLock = _envUint128("BURSAR_MIN_LOCK");

        // The escrow has no dispute timeout of its own. A disputed lock leaves through the
        // resolver registry, whose two exits cannot both be closed, and a value left in an older
        // parameter file would read as a third exit.
        _refuseRetired("BURSAR_DISPUTE_TIMEOUT", "nothing: disputes exit through OracleRegistry");

        curve = IReputation.CapCurve({
            baseCap: _envUint128("BURSAR_CAP_BASE"),
            capPerScore: _envUint128("BURSAR_CAP_PER_SCORE"),
            maxCap: _envUint128("BURSAR_CAP_MAX")
        });

        // How a point on that curve is earned: a lock under the minimum counts for nothing, one
        // payer's released volume counts up to the edge cap, and full credit is what a full score
        // takes.
        weights = IReputation.Weights({
            minScored: _envUint128("BURSAR_MIN_SCORED"),
            edgeCap: _envUint128("BURSAR_EDGE_CAP"),
            fullCredit: _envUint128("BURSAR_FULL_CREDIT")
        });

        // Resolver bonds are posted in BRSR and the floor that admits one lives in `Staking`,
        // which the staking deployment brings. A core deployment carries no figure for it, and a
        // stale variable here would read as though it did.
        _refuseRetired("BURSAR_RESOLVER_MIN_BOND", "BURSAR_STAKING_MIN_BOND, in the staking deployment");

        oracleConfig = IOracleRegistry.Config({
            commitWindow: _envUint64("BURSAR_COMMIT_WINDOW"),
            revealWindow: _envUint64("BURSAR_REVEAL_WINDOW"),
            unbondingPeriod: _envUint64("BURSAR_UNBONDING_PERIOD"),
            quorum: _envUint8("BURSAR_RESOLVER_QUORUM"),
            maxVoters: _envUint8("BURSAR_MAX_VOTERS"),
            maxDeviation: _envUint8("BURSAR_MAX_DEVIATION"),
            slashBps: _envUint16("BURSAR_RESOLVER_SLASH_BPS")
        });

        withAgentRegistry = _envBool("BURSAR_DEPLOY_AGENT_REGISTRY");
        if (withAgentRegistry) {
            agentMinStake = _envUint128("BURSAR_AGENT_MIN_STAKE");
            agentSlashBps = _envUint16("BURSAR_AGENT_SLASH_BPS");
        }
    }

    /// Three signers, each from the record when it names them and from the environment when it
    /// does not. A signer set the record holds cannot be half-replaced by a shell.
    function _loadSigners() private {
        address[] memory recorded = _recordAddresses(K.SIGNERS);
        string[3] memory names = ["BURSAR_TIMELOCK_SIGNER_1", "BURSAR_TIMELOCK_SIGNER_2", "BURSAR_TIMELOCK_SIGNER_3"];
        for (uint256 i; i < 3; ++i) {
            address named = _envAddressOr(names[i], address(0));
            if (recorded.length == 3) {
                if (named != address(0) && named != recorded[i]) revert RecordMismatch(K.SIGNERS, recorded[i], named);
                signers[i] = recorded[i];
            } else {
                signers[i] = _envAddress(names[i]);
            }
        }
    }

    /// Everything checkable before a single transaction is sent. A deployment that fails halfway
    /// leaves live contracts nobody can finish wiring, so the expensive checks run first.
    function _preflight(address deployer) private view {
        // The record says what is already there, and each of these refuses a second copy. Asked
        // first, so a second run says it ran before, whatever the deploy key holds by then.
        if (existingTimelock == address(0)) _requireUnrecorded(K.ADMIN_TIMELOCK);
        _requireUnrecorded(K.REPUTATION);
        _requireUnrecorded(K.ESCROW);
        _requireUnrecorded(K.ORACLE_REGISTRY);
        if (withAgentRegistry) _requireUnrecorded(K.AGENT_REGISTRY);
        _requireUnrecorded(K.FACTORY);

        if (asset.code.length == 0) revert AssetNotContract(asset);
        // Wrapped, because an address holding code that does not answer `decimals` fails here
        // with a decode error that tells an operator nothing.
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != SETTLEMENT_DECIMALS) revert AssetDecimalsMismatch(decimals, SETTLEMENT_DECIMALS);
        } catch {
            revert AssetNotContract(asset);
        }
        // On the one chain whose settlement asset is verified, a typo in the record is caught
        // before it is deployed against, and the compliance reads below are worth making because
        // the address they run on is known.
        if (_onRobinhood() && asset != RHC_USDG) revert AssetNotUsdg(asset, RHC_USDG);
        if (block.chainid == RHC_CHAIN_ID) _requireUsdgWillMove(deployer);

        // Both fees are taken from the same locked principal. At the sum the payee receives
        // nothing from a settlement it delivered, and above it the arithmetic underflows. The
        // escrow holds tighter ceilings of its own; this is the invariant that spans the two.
        if (uint256(feeBps) + resolverFeeBps >= BPS) revert FeeSplitTooLarge(feeBps, resolverFeeBps);
        // The bond is a share of the disputed amount pulled from the disputer. A rate at or above
        // par cannot be posted at all, whatever ceiling the escrow sets below it.
        if (disputeBondBps >= BPS) revert DisputeBondTooLarge(disputeBondBps);

        if (timelockPeriod == 0) revert TimelockPeriodZero();

        // Joining live governance means this run never sets its terms, so the terms are read
        // off the contract and checked against the parameter file. A wrong address is otherwise
        // invisible until the first proposal, by which point every contract in the run answers
        // to something nobody chose.
        if (existingTimelock != address(0)) {
            if (existingTimelock.code.length == 0) revert TimelockNotContract(existingTimelock);

            AdminTimelock live = AdminTimelock(existingTimelock);
            uint64 livePeriod = live.timelockPeriod();
            if (livePeriod == 0) revert TimelockPeriodZero();
            if (livePeriod != timelockPeriod) {
                revert ParameterNotApplied("timelock.timelockPeriod", timelockPeriod, livePeriod);
            }
            if (live.guardian() != guardian) revert WiringFailed("timelock.guardian", guardian, live.guardian());

            address[3] memory liveSigners = live.getSigners();
            for (uint256 i; i < 3; ++i) {
                if (liveSigners[i] != signers[i]) revert WiringFailed("timelock.signer", signers[i], liveSigners[i]);
            }
        }

        // The registry reads the bond token off the pool, so the pool has to be one this
        // deployment settles against.
        if (existingStaking != address(0)) {
            address reward = address(IStaking(existingStaking).rewardToken());
            if (reward != asset) revert WiringFailed("staking.rewardToken", asset, reward);
        }

        // An unscored payee is capped at `baseCap`. A zero floor rejects every first lock a
        // payee would ever take, and the escrow would look broken.
        if (curve.baseCap == 0) revert BaseCapZero();
        // The same payee can take no lock above `baseCap`, so a scored minimum above it is a
        // threshold no first lock reaches and a curve nobody climbs.
        if (weights.minScored > curve.baseCap) revert MinScoredAboveBaseCap(weights.minScored, curve.baseCap);

        // The deploy key signs from a shell with an unlocked keystore. Governance weight on that
        // key would put the delay and the hot key in the same hand.
        for (uint256 i; i < 3; ++i) {
            if (signers[i] == deployer) revert DeployerIsTimelockSigner(deployer);
            // The brake has to be reachable in seconds, so that key stays warm. A warm key must
            // not also carry one of the two approvals a change needs. The timelock rejects this
            // too; catching it here costs no gas.
            if (signers[i] == guardian) revert RoleCollision("guardian", "timelockSigner", guardian);
        }

        // Gas, fee revenue and slashed collateral each sit at their own address, so an operator
        // topping up the gas float cannot accidentally spend the treasury.
        if (treasury == deployer) revert RoleCollision("treasury", "deployer", treasury);
        if (slashSink == deployer) revert RoleCollision("slashSink", "deployer", slashSink);
        if (treasury == slashSink) revert RoleCollision("treasury", "slashSink", treasury);

        // Three hot keys hold a treasury no better than one. No chain is exempt: on Robinhood
        // Chain there is no second chain to rehearse on, because testnet 46630 has no USDG and
        // cannot settle.
        bool multisig;
        for (uint256 i; i < 3; ++i) {
            if (signers[i].code.length != 0) multisig = true;
        }
        if (!multisig) _requireEoaGovernanceAccepted();
    }

    /// The one refusal an operator can lift on purpose.
    ///
    /// Governance is three plain keys until a multisig replaces them, so a deployment has to be
    /// possible with no contract in the signer set. Unset, the refusal stands and nothing
    /// deploys. What lifts it is a phrase, because `true` is a word that arrives in a shell by
    /// accident and `i-accept-eoa-governance` is not.
    function _requireEoaGovernanceAccepted() private view {
        string memory given = _envRaw(_key("BURSAR_ALLOW_EOA_GOVERNANCE"));
        if (bytes(given).length == 0) revert GovernanceHasNoMultisig();
        if (keccak256(bytes(given)) != keccak256(bytes(EOA_GOVERNANCE_ACK))) {
            revert EoaGovernanceNotAcknowledged(given, EOA_GOVERNANCE_ACK);
        }

        console2.log(
            "BURSAR_ALLOW_EOA_GOVERNANCE is set: every timelock signer is a plain key, so whoever holds those three keys can change any parameter in this deployment once the delay passes, and no contract stands between them and it."
        );
    }

    /// Reverts before broadcast when the settlement asset itself would stop the deployment
    /// working. Read straight, with no gas stipend and no try/catch: USDG is an ordinary contract
    /// whose storage a fork fetches, and a diamond that stopped routing one of these selectors
    /// would be a change to the asset this system settles in, which is a reason to stop.
    function _requireUsdgWillMove(address deployer) private view {
        if (IUsdg(asset).paused()) revert AssetPaused(asset);
        // A frozen address reverts every transfer whatever its balance says. A frozen deploy
        // key cannot fund a mandate and a frozen treasury can never be swept.
        if (IUsdg(asset).isFrozen(deployer)) revert AddressFrozen("deployer", deployer);
        if (IUsdg(asset).isFrozen(treasury)) revert AddressFrozen("treasury", treasury);

        uint256 held = IERC20(asset).balanceOf(deployer);
        if (held < MIN_SETTLEMENT_BALANCE) {
            revert SettlementBalanceTooLow(deployer, held, MIN_SETTLEMENT_BALANCE);
        }
    }

    function _deploy() private {
        // Governance first, so no contract is ever admin-controlled by the deploy key. Naming it
        // in the constructors closes the gap a handover afterwards would leave open.
        timelock = existingTimelock == address(0)
            ? new AdminTimelock(signers, guardian, timelockPeriod)
            : AdminTimelock(existingTimelock);

        reputation = new Reputation(address(timelock), curve, weights);

        escrow = new Escrow(
            asset,
            address(reputation),
            treasury,
            feeBps,
            resolverFeeBps,
            disputeBondBps,
            minTtl,
            maxTtl,
            disputeWindow,
            minLock
        );

        oracleRegistry = new OracleRegistry(asset, address(timelock), slashSink, oracleConfig);

        // The registry is optional. Deployed here, it answers to the timelock from its first
        // block: the script sets nothing on it, so the deploy key has no reason to hold it.
        if (withAgentRegistry) {
            agentRegistry = new AgentRegistry(IERC20(asset), address(timelock), slashSink, agentMinStake, agentSlashBps);
        } else {
            // Cleared, because one script instance can run more than once in a process, and a
            // readback against the previous run's registry would hold this deployment to a
            // pairing it does not have.
            agentRegistry = AgentRegistry(address(0));
        }

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(oracleRegistry));
        oracleRegistry.setEscrow(address(escrow));
        // The guardian's brake reaches the escrow through the timelock, like every other
        // administered contract.
        escrow.setPauser(address(timelock));
        if (existingStaking != address(0)) oracleRegistry.setStaking(existingStaking);

        // `setSlasher` is never called. The resolver rules on a job, not on an agent's balance
        // sheet: it produces a quality score, the escrow turns that into a refund split and the
        // reputation curve lowers the cap on the agent's next lock. Naming it here would publish
        // a capability it does not have. Collateral moves on a timelock proposal, with a person
        // naming the amount.
        if (withAgentRegistry) escrow.setRegistry(IAgentRegistry(address(agentRegistry)));

        // Last, because it bakes both addresses into every account it creates and there is
        // nothing to correct afterwards.
        factory = new MandateAccountFactory(address(escrow), asset);
    }

    /// Reads every wiring decision back. Forge runs this against its own simulation before it
    /// broadcasts anything, so a setter pointed at the wrong address stops the run with nothing
    /// sent. `VerifyCore.s.sol` asks the chain the same questions once the transactions land.
    function _verify(address deployer) private view {
        _expect("escrow.deployer", deployer, escrow.deployer());
        _expect("reputation.deployer", deployer, reputation.deployer());
        _expect("oracleRegistry.deployer", deployer, oracleRegistry.deployer());

        _expect("reputation.escrow", address(escrow), reputation.escrow());
        _expect("escrow.resolver", address(oracleRegistry), escrow.resolver());
        _expect("oracleRegistry.escrow", address(escrow), oracleRegistry.escrow());
        _expect("escrow.registry", address(agentRegistry), address(escrow.registry()));
        _expect("escrow.pauser", address(timelock), escrow.pauser());

        _expect("escrow.settlementAsset", asset, escrow.settlementAsset());
        _expect("oracleRegistry.settlementAsset", asset, oracleRegistry.settlementAsset());
        _expect("factory.settlementAsset", asset, factory.settlementAsset());
        _expect("factory.escrow", address(escrow), factory.escrow());
        _expect("escrow.reputation", address(reputation), escrow.reputation());

        // Bonds are posted in BRSR. A pool already in the record is named here; otherwise the
        // staking deployment names it, and until then it is asserted absent: no resolver can
        // bond and no dispute can be voted on.
        _expect("oracleRegistry.staking", existingStaking, address(oracleRegistry.staking()));
        if (existingStaking == address(0)) {
            _expect("oracleRegistry.bondAsset", address(0), address(oracleRegistry.bondAsset()));
        }

        _expect("reputation.admin", address(timelock), reputation.admin());
        _expect("oracleRegistry.admin", address(timelock), oracleRegistry.admin());
        _expect("escrow.treasury", treasury, escrow.treasury());
        _expect("oracleRegistry.slashSink", slashSink, oracleRegistry.slashSink());

        if (withAgentRegistry) {
            _expect("agentRegistry.settlementAsset", asset, address(agentRegistry.settlementAsset()));
            // Asserted as absent, so the deployment records that no contract can take agent
            // collateral and the only path to it is an admin call from the timelock.
            _expect("agentRegistry.slasher", address(0), agentRegistry.slasher());
            _expect("agentRegistry.slashSink", slashSink, agentRegistry.slashSink());
            _expect("agentRegistry.pendingAdmin", address(0), agentRegistry.pendingAdmin());
            _expect("agentRegistry.admin", address(timelock), agentRegistry.admin());
            _expectUint("agentRegistry.minStake", agentMinStake, agentRegistry.minStake());
            _expectUint("agentRegistry.slashBps", agentSlashBps, agentRegistry.slashBps());
        }

        // The same invariants as the preflight, re-read from the contracts that now hold them. A
        // constructor that clamped or ignored an argument is caught here.
        uint64 period = timelock.timelockPeriod();
        if (period == 0) revert TimelockPeriodZero();
        _expectUint("timelock.timelockPeriod", timelockPeriod, period);
        _expect("timelock.guardian", guardian, timelock.guardian());

        uint16 fee = escrow.feeBps();
        uint16 resolverFee = escrow.resolverFeeBps();
        if (uint256(fee) + resolverFee >= BPS) revert FeeSplitTooLarge(fee, resolverFee);
        _expectUint("escrow.feeBps", feeBps, fee);
        _expectUint("escrow.resolverFeeBps", resolverFeeBps, resolverFee);
        _expectUint("escrow.disputeBondBps", disputeBondBps, escrow.disputeBondBps());
        _expectUint("escrow.minLock", minLock, escrow.minLock());

        IReputation.CapCurve memory onChainCurve = reputation.curve();
        if (onChainCurve.baseCap == 0) revert BaseCapZero();
        _expectUint("reputation.baseCap", curve.baseCap, onChainCurve.baseCap);
        _expectUint("reputation.capPerScore", curve.capPerScore, onChainCurve.capPerScore);
        _expectUint("reputation.maxCap", curve.maxCap, onChainCurve.maxCap);

        IReputation.Weights memory onChainWeights = reputation.weights();
        _expectUint("reputation.minScored", weights.minScored, onChainWeights.minScored);
        _expectUint("reputation.edgeCap", weights.edgeCap, onChainWeights.edgeCap);
        _expectUint("reputation.fullCredit", weights.fullCredit, onChainWeights.fullCredit);
    }

    function _record(address deployer) private {
        if (_recordAddress(K.DEPLOYER) == address(0)) _write(K.DEPLOYER, deployer);
        if (!_recorded(K.FROM_BLOCK)) _write(K.FROM_BLOCK, _chainBlock());

        address[] memory signerList = new address[](3);
        for (uint256 i; i < 3; ++i) {
            signerList[i] = signers[i];
        }
        _write(K.SIGNERS, signerList);
        _write(K.GUARDIAN, guardian);
        _write(K.TREASURY, treasury);
        _write(K.SLASH_SINK, slashSink);

        _write(K.ADMIN_TIMELOCK, address(timelock));
        _write(K.REPUTATION, address(reputation));
        _write(K.ESCROW, address(escrow));
        _write(K.ORACLE_REGISTRY, address(oracleRegistry));
        if (withAgentRegistry) _write(K.AGENT_REGISTRY, address(agentRegistry));
        _write(K.FACTORY, address(factory));

        _write(".parameters.AdminTimelock.timelockPeriod", timelockPeriod);
        _write(".parameters.Escrow.feeBps", feeBps);
        _write(".parameters.Escrow.resolverFeeBps", resolverFeeBps);
        _write(".parameters.Escrow.disputeBondBps", disputeBondBps);
        _write(".parameters.Escrow.minTtl", minTtl);
        _write(".parameters.Escrow.maxTtl", maxTtl);
        _write(".parameters.Escrow.disputeWindow", disputeWindow);
        _writeAmount(".parameters.Escrow.minLock", minLock);
        _writeAmount(".parameters.Reputation.baseCap", curve.baseCap);
        _writeAmount(".parameters.Reputation.capPerScore", curve.capPerScore);
        _writeAmount(".parameters.Reputation.maxCap", curve.maxCap);
        _writeAmount(".parameters.Reputation.minScored", weights.minScored);
        _writeAmount(".parameters.Reputation.edgeCap", weights.edgeCap);
        _writeAmount(".parameters.Reputation.fullCredit", weights.fullCredit);
        _write(".parameters.OracleRegistry.commitWindow", oracleConfig.commitWindow);
        _write(".parameters.OracleRegistry.revealWindow", oracleConfig.revealWindow);
        _write(".parameters.OracleRegistry.unbondingPeriod", oracleConfig.unbondingPeriod);
        _write(".parameters.OracleRegistry.quorum", oracleConfig.quorum);
        _write(".parameters.OracleRegistry.maxVoters", oracleConfig.maxVoters);
        _write(".parameters.OracleRegistry.maxDeviation", oracleConfig.maxDeviation);
        _write(".parameters.OracleRegistry.slashBps", oracleConfig.slashBps);
        if (withAgentRegistry) {
            _writeAmount(".parameters.AgentRegistry.minStake", agentMinStake);
            _write(".parameters.AgentRegistry.slashBps", agentSlashBps);
        }
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("settlementAsset", asset);
        console2.log("AdminTimelock", address(timelock));
        console2.log(existingTimelock == address(0) ? "  deployed by this run" : "  live, joined by this run");
        console2.log("  guardian", guardian);
        console2.log("Reputation", address(reputation));
        console2.log("Escrow", address(escrow));
        console2.log("OracleRegistry", address(oracleRegistry));
        console2.log("AgentRegistry", address(agentRegistry));
        console2.log("MandateAccountFactory", address(factory));

        if (existingStaking != address(0)) {
            console2.log("Staking", existingStaking);
            console2.log("  live, joined by this run");
        } else {
            // The one wiring call this run cannot make. The pool that prices a resolver bond is
            // deployed by the staking script, and the same deploy key closes the link from there.
            console2.log("Pending: OracleRegistry.setStaking, from DeployStaking.s.sol");
            console2.log("  until it runs, register and increaseBond revert with StakingNotSet");
        }

        // Zero is the intended slasher.
        if (withAgentRegistry) console2.log("AgentRegistry.slasher is unset: collateral moves on a timelock proposal");
    }
}
