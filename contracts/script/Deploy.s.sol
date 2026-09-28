// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IUsdg} from "./interfaces/IUsdg.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {OracleRegistry} from "../src/OracleRegistry.sol";
import {Reputation} from "../src/Reputation.sol";
import {IAgentRegistry} from "../src/interfaces/IAgentRegistry.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IReputation} from "../src/interfaces/IReputation.sol";

/// Deploys the mandate contracts in the one order that leaves no contract half-wired, and
/// stops when the parameter set is internally inconsistent.
///
/// Three pairings cannot be expressed in a constructor, because each side needs the other's
/// address: reputation to escrow, escrow to resolver, resolver to escrow. Each is closed by a
/// one-shot deployer-only setter, so all three have to come from the address that deployed the
/// contracts, in the same run. Miss one and the deployment is stuck: the setters take no second
/// call and the constructors are already spent.
///
/// The invariants asserted here are the ones no single constructor can see. A dispute timeout
/// shorter than the voting windows would refund every payer before a resolver could rule; a fee
/// plus a resolver fee at or above a whole settlement would leave nothing to split; a zero base
/// cap would reject every payee that has no history, which is every payee on day one.
///
/// Gas on Robinhood Chain is ETH and settlement is USDG, two different assets held at two
/// different scales. On a chain that pays gas in the same USDC it settles in, every reader has
/// to be told not to add the eighteen-decimal view of a balance to the six-decimal one. That
/// hazard does not exist here, and nothing in this script reads a native balance.
contract Deploy is Script {
    /// Robinhood Chain mainnet, read from the chain itself and never from an announcement.
    /// Testnet 46630 answers, but USDG holds no contract there, so nothing on it can settle
    /// and it is not a deploy target.
    uint256 internal constant RHC_CHAIN_ID = 4663;
    /// USDG. Six decimals, a diamond proxy, verified on chain: `decimals()` answers 6,
    /// `symbol()` answers USDG and `name()` answers Global Dollar.
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// What the deploy key has to hold in the settlement asset before the run starts. This
    /// deployment spends no USDG, so it is not a funding check: it is the proof that the
    /// address in the parameter file is the asset the system will settle in and that the key
    /// can fund the first live mandate afterwards. One USDG is ten times what the documented
    /// example mandate carries.
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;

    /// What `BURSAR_ALLOW_EOA_GOVERNANCE` has to say. A phrase rather than a boolean, so that
    /// no shell carrying a stray `true` can switch off the refusal below.
    string internal constant EOA_GOVERNANCE_ACK = "i-accept-eoa-governance";

    uint16 internal constant BPS = 10_000;
    uint8 internal constant SETTLEMENT_DECIMALS = 6;

    /// No legitimate parameter reaches this, so it distinguishes an unset variable from a zero
    /// someone chose. A fee of zero is a policy; a fee nobody set is a mistake.
    uint256 private constant UNSET = type(uint256).max;

    struct Deployment {
        address timelock;
        address reputation;
        address escrow;
        address oracleRegistry;
        address agentRegistry;
        address factory;
    }

    error MissingEnv(string key);
    error RetiredEnv(string key, string replacement);
    error EnvOutOfRange(string key, uint256 value, uint256 max);
    error EnvNotBoolean(string key, string value);
    error WrongChain(uint256 expected, uint256 actual);
    error AssetNotContract(address asset);
    error AssetDecimalsMismatch(uint8 found, uint8 expected);
    error AssetNotUsdg(address configured, address expected);
    error AssetPaused(address asset);
    error AddressFrozen(string role, address account);
    error SettlementBalanceTooLow(address account, uint256 held, uint256 floor);
    error FeeSplitTooLarge(uint16 feeBps, uint16 resolverFeeBps);
    error DisputeBondTooLarge(uint16 disputeBondBps);
    error DisputeTimeoutTooShort(uint64 disputeTimeoutPeriod, uint64 votingWindow);
    error TimelockPeriodZero();
    error TimelockNotContract(address timelock);
    error DeployerIsTimelockSigner(address deployer);
    error GovernanceHasNoMultisig();
    error EoaGovernanceNotAcknowledged(string given, string required);
    error RoleCollision(string role, string otherRole, address account);
    error BaseCapZero();
    error WiringFailed(string what, address expected, address actual);
    error ParameterNotApplied(string what, uint256 expected, uint256 actual);

    /// Namespace every variable this script reads sits under, empty for an ordinary run.
    ///
    /// The process environment is not part of the EVM state Foundry snapshots per test, so two
    /// suites driving a deploy script in one process write the same variables and read each
    /// other's values: the second run deploys against an address from the first one's fixture
    /// and fails on something unrelated to the code. A harness pins a prefix per instance,
    /// which lives in state and is therefore isolated; an operator running two deployments
    /// from one shell sets `BURSAR_ENV_PREFIX` instead.
    string public envPrefix;

    address private asset;
    address private treasury;
    address private slashSink;
    address[3] private signers;
    address private guardian;
    uint64 private timelockPeriod;
    /// Live governance this run joins, or zero when it brings its own. See `_loadEnv`.
    address private existingTimelock;

    uint16 private feeBps;
    uint16 private resolverFeeBps;
    uint16 private disputeBondBps;
    uint64 private minTtl;
    uint64 private maxTtl;
    uint64 private disputeWindow;
    uint64 private disputeTimeoutPeriod;

    IReputation.CapCurve private curve;
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
        address deployer = msg.sender;

        _loadEnv();
        _preflight(deployer);

        vm.startBroadcast();
        _deploy(deployer);
        vm.stopBroadcast();

        _verify(deployer);
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

    function pinEnvPrefix(string calldata prefix) external {
        envPrefix = prefix;
    }

    function _loadEnv() private {
        // Read once, so every variable in one run comes from one namespace.
        if (bytes(envPrefix).length == 0) envPrefix = vm.envOr("BURSAR_ENV_PREFIX", string(""));

        uint256 expectedChain = _envUint("BURSAR_CHAIN_ID");
        if (expectedChain != block.chainid) revert WrongChain(expectedChain, block.chainid);

        asset = _envAddress("BURSAR_SETTLEMENT_ASSET");
        treasury = _envAddress("BURSAR_TREASURY");
        slashSink = _envAddress("BURSAR_SLASH_SINK");

        signers[0] = _envAddress("BURSAR_TIMELOCK_SIGNER_1");
        signers[1] = _envAddress("BURSAR_TIMELOCK_SIGNER_2");
        signers[2] = _envAddress("BURSAR_TIMELOCK_SIGNER_3");
        guardian = _envAddress("BURSAR_TIMELOCK_GUARDIAN");
        timelockPeriod = _envUint64("BURSAR_TIMELOCK_PERIOD");

        // A first deployment brings its own governance. A redeploy of the money path joins the
        // governance already holding the rest of the system, because the delay only means
        // anything if there is one of it: two timelocks over one deployment is two answers to
        // the question of who may change a parameter. The variable that names it is the same
        // one the token deployment reads, so one address describes governance for both runs.
        // Unset deploys a fresh timelock, which is the case every new chain starts from.
        existingTimelock = vm.envOr(_key("BURSAR_ADMIN_TIMELOCK"), address(0));

        feeBps = _envUint16("BURSAR_FEE_BPS");
        resolverFeeBps = _envUint16("BURSAR_RESOLVER_FEE_BPS");
        disputeBondBps = _envUint16("BURSAR_DISPUTE_BOND_BPS");
        minTtl = _envUint64("BURSAR_MIN_TTL");
        maxTtl = _envUint64("BURSAR_MAX_TTL");
        disputeWindow = _envUint64("BURSAR_DISPUTE_WINDOW");
        disputeTimeoutPeriod = _envUint64("BURSAR_DISPUTE_TIMEOUT");

        curve = IReputation.CapCurve({
            baseCap: _envUint128("BURSAR_CAP_BASE"),
            capPerScore: _envUint128("BURSAR_CAP_PER_SCORE"),
            maxCap: _envUint128("BURSAR_CAP_MAX")
        });

        // Resolver bonds are posted in BRSR and the floor that admits one lives in `Staking`,
        // which is deployed with the token set. A core deployment no longer carries a figure
        // for it, and a stale variable here would read as though it did.
        _refuseRetired("BURSAR_RESOLVER_MIN_BOND", "BURSAR_STAKING_MIN_BOND, in the token deployment");

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

    /// Everything checkable before a single transaction is sent. A deployment that fails halfway
    /// leaves live contracts nobody can finish wiring, so the expensive checks run first.
    function _preflight(address deployer) private view {
        if (asset.code.length == 0) revert AssetNotContract(asset);
        // Wrapped, because an address holding code that does not answer `decimals` fails here
        // with a decode error that tells an operator nothing.
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != SETTLEMENT_DECIMALS) revert AssetDecimalsMismatch(decimals, SETTLEMENT_DECIMALS);
        } catch {
            revert AssetNotContract(asset);
        }
        // On the one chain whose settlement asset is verified, a typo in the parameter file is
        // caught before it is deployed against, and the compliance reads below are worth
        // making because the address they run on is known.
        if (_isRobinhoodChain()) {
            if (asset != RHC_USDG) revert AssetNotUsdg(asset, RHC_USDG);
            _requireUsdgWillMove(deployer);
        }

        // Both fees are taken from the same locked principal. At the sum the payee receives
        // nothing from a settlement it delivered, and above it the arithmetic underflows. The
        // escrow holds tighter ceilings of its own; this is the invariant that spans the two.
        if (uint256(feeBps) + resolverFeeBps >= BPS) revert FeeSplitTooLarge(feeBps, resolverFeeBps);
        // The bond is a share of the disputed amount pulled from the disputer. A rate at or above
        // par cannot be posted at all, whatever ceiling the escrow sets below it.
        if (disputeBondBps >= BPS) revert DisputeBondTooLarge(disputeBondBps);

        // The escrow's own timeout is the payer's escape from a resolver that never rules. Set it
        // inside the voting windows and every dispute refunds before the votes can be counted,
        // which makes the quorum decorative and hands any payer a free clawback.
        uint64 votingWindow = oracleConfig.commitWindow + oracleConfig.revealWindow;
        if (disputeTimeoutPeriod <= votingWindow) revert DisputeTimeoutTooShort(disputeTimeoutPeriod, votingWindow);

        if (timelockPeriod == 0) revert TimelockPeriodZero();

        // Joining live governance means this run never sets its terms, so the terms are read
        // off the contract and held against the parameter file instead. A wrong address is
        // otherwise invisible until the first proposal, by which point every contract in the
        // run answers to something nobody chose.
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

        // An unscored payee is capped at `baseCap`. A zero floor rejects every first lock a
        // payee would ever take, and the escrow looks broken rather than conservative.
        if (curve.baseCap == 0) revert BaseCapZero();

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

    /// The refusal an operator can lift, on purpose, in one place, once.
    ///
    /// Release 1 governance is three plain keys until a multisig replaces them, so a deployment
    /// has to be possible with no contract in the signer set.
    ///
    /// Unset, the refusal stands and nothing deploys. What lifts it is a phrase and not a
    /// boolean, because `true` is a word that arrives in a shell by accident and
    /// `i-accept-eoa-governance` is not.
    function _requireEoaGovernanceAccepted() private view {
        string memory given = vm.envOr(_key("BURSAR_ALLOW_EOA_GOVERNANCE"), string(""));
        if (bytes(given).length == 0) revert GovernanceHasNoMultisig();
        if (keccak256(bytes(given)) != keccak256(bytes(EOA_GOVERNANCE_ACK))) {
            revert EoaGovernanceNotAcknowledged(given, EOA_GOVERNANCE_ACK);
        }

        console2.log(
            "BURSAR_ALLOW_EOA_GOVERNANCE is set: every timelock signer is a plain key, so whoever holds those three keys can change any parameter in this deployment once the delay passes, and no contract stands between them and it."
        );
    }

    /// Robinhood Chain mainnet, the only chain this deployment pins an asset address on.
    function _isRobinhoodChain() private view returns (bool) {
        return block.chainid == RHC_CHAIN_ID;
    }

    /// Reverts before broadcast when the settlement asset itself would stop the deployment
    /// working. Read straight, with no gas stipend and no try/catch: USDG is an ordinary
    /// contract whose storage a fork fetches, and a diamond that stopped routing one of these
    /// selectors would be a change to the asset this system settles in, which is a reason to
    /// stop and look rather than to carry on.
    ///
    /// A stipend and a three-valued read are only needed when a block list lives behind a node
    /// precompile that publishes one byte of code. Nothing on 4663 does that.
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

    function _deploy(address deployer) private {
        // Governance first, so no contract is ever admin-controlled by the deploy key. The plan
        // hands admin to the timelock after deployment; naming it in the constructors closes the
        // same gap without the window in between.
        timelock = existingTimelock == address(0)
            ? new AdminTimelock(signers, guardian, timelockPeriod)
            : AdminTimelock(existingTimelock);

        reputation = new Reputation(address(timelock), curve);

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
            disputeTimeoutPeriod
        );

        oracleRegistry = new OracleRegistry(asset, address(timelock), slashSink, oracleConfig);

        // The registry is optional. Deployed here, it takes the deploy key as admin only long
        // enough to name the resolver it could not know before the resolver existed, and the
        // handover to the timelock is started in the same run.
        if (withAgentRegistry) {
            agentRegistry = new AgentRegistry(IERC20(asset), deployer, slashSink, agentMinStake, agentSlashBps);
        } else {
            // Cleared, not left alone. One script instance can be run more than once in a
            // process, and a readback against the previous run's registry would hold this
            // deployment to a pairing it does not have.
            agentRegistry = AgentRegistry(address(0));
        }

        reputation.setEscrow(address(escrow));
        escrow.setResolver(address(oracleRegistry));
        oracleRegistry.setEscrow(address(escrow));

        // `setSlasher` is never called. The resolver rules on a job, not on an
        // agent's balance sheet: it produces a quality score, the escrow turns that into a
        // refund split and the reputation curve lowers the cap on the agent's next lock. It
        // holds no figure to slash by and imports nothing from this registry. Naming it here
        // would publish a capability it does not have, and the deployment would read as though
        // agent collateral were at risk from a vote. It is not. Collateral moves on a timelock
        // proposal, with a person naming the amount.
        if (withAgentRegistry) {
            escrow.setRegistry(IAgentRegistry(address(agentRegistry)));
            agentRegistry.transferAdmin(address(timelock));
        }

        // Last, because it bakes both addresses into every account it creates and there is
        // nothing to correct afterwards.
        factory = new MandateAccountFactory(address(escrow), asset);
    }

    /// Reads every wiring decision back off chain. A setter that reverted inside a broadcast
    /// would have stopped the run, but a setter pointed at the wrong address by a stale constant
    /// would not, and the cost of finding that out later is a redeploy.
    function _verify(address deployer) private view {
        _expect("escrow.deployer", deployer, escrow.deployer());
        _expect("reputation.deployer", deployer, reputation.deployer());
        _expect("oracleRegistry.deployer", deployer, oracleRegistry.deployer());

        _expect("reputation.escrow", address(escrow), reputation.escrow());
        _expect("escrow.resolver", address(oracleRegistry), escrow.resolver());
        _expect("oracleRegistry.escrow", address(escrow), oracleRegistry.escrow());
        _expect("escrow.registry", address(agentRegistry), address(escrow.registry()));

        _expect("escrow.settlementAsset", asset, escrow.settlementAsset());
        _expect("oracleRegistry.settlementAsset", asset, oracleRegistry.settlementAsset());
        _expect("factory.settlementAsset", asset, factory.settlementAsset());
        _expect("factory.escrow", address(escrow), factory.escrow());
        _expect("escrow.reputation", address(reputation), escrow.reputation());

        // Bonds are posted in BRSR and the pool that prices them is deployed with the token
        // set, which runs after this one. Asserted as absent so the state is stated and not
        // assumed: until the token deployment calls `setStaking`, no resolver can bond and no
        // dispute can be voted on.
        _expect("oracleRegistry.staking", address(0), address(oracleRegistry.staking()));
        _expect("oracleRegistry.bondAsset", address(0), address(oracleRegistry.bondAsset()));

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
            // Still the deploy key until the timelock executes `acceptAdmin`.
            _expect("agentRegistry.pendingAdmin", address(timelock), agentRegistry.pendingAdmin());
            _expect("agentRegistry.admin", deployer, agentRegistry.admin());
            _expectUint("agentRegistry.minStake", agentMinStake, agentRegistry.minStake());
            _expectUint("agentRegistry.slashBps", agentSlashBps, agentRegistry.slashBps());
        }

        // The same three invariants as the preflight, re-read from the contracts that now hold
        // them. A constructor that clamped or ignored an argument is caught here.
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

        IOracleRegistry.Config memory cfg = oracleRegistry.config();
        uint64 votingWindow = cfg.commitWindow + cfg.revealWindow;
        uint64 timeout = escrow.disputeTimeoutPeriod();
        if (timeout <= votingWindow) revert DisputeTimeoutTooShort(timeout, votingWindow);

        IReputation.CapCurve memory onChainCurve = reputation.curve();
        if (onChainCurve.baseCap == 0) revert BaseCapZero();
        _expectUint("reputation.baseCap", curve.baseCap, onChainCurve.baseCap);
        _expectUint("reputation.capPerScore", curve.capPerScore, onChainCurve.capPerScore);
        _expectUint("reputation.maxCap", curve.maxCap, onChainCurve.maxCap);
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

        // The one wiring call this run cannot make. The pool that prices a resolver bond is
        // part of the token set, and the same deploy key closes the link from there.
        console2.log("Pending: OracleRegistry.setStaking, from the token deployment");
        console2.log("  oracleRegistry", address(oracleRegistry));
        console2.log("  until it runs, register and increaseBond revert with StakingNotSet");

        if (!withAgentRegistry) return;

        // Named because a zero `slasher` is the intended state. The resolver rules on a job
        // and produces a score, not a figure to take off a balance sheet, so nothing in this
        // deployment can reach agent collateral except a proposal from the timelock.
        console2.log("AgentRegistry.slasher is unset: collateral moves on a timelock proposal");

        // One step is left over and it needs two signers. The operator gets the exact call,
        // not a sentence describing it.
        console2.log("Pending: AdminTimelock.propose on the registry, then a second approval");
        console2.log("  target", address(agentRegistry));
        console2.logBytes(abi.encodeCall(AgentRegistry.acceptAdmin, ()));
    }

    function _expect(string memory what, address expected, address actual) private pure {
        if (expected != actual) revert WiringFailed(what, expected, actual);
    }

    function _expectUint(string memory what, uint256 expected, uint256 actual) private pure {
        if (expected != actual) revert ParameterNotApplied(what, expected, actual);
    }

    function _key(string memory key) private view returns (string memory) {
        return bytes(envPrefix).length == 0 ? key : string.concat(envPrefix, key);
    }

    /// A retired variable still holds a value in the unit it was retired for. Reading it under
    /// the new name would be worse than ignoring it.
    function _refuseRetired(string memory key, string memory replacement) private view {
        string memory name = _key(key);
        if (bytes(vm.envOr(name, string(""))).length != 0) revert RetiredEnv(name, replacement);
    }

    function _envAddress(string memory key) private view returns (address value) {
        string memory name = _key(key);
        value = vm.envOr(name, address(0));
        if (value == address(0)) revert MissingEnv(name);
    }

    function _envUint(string memory key) private view returns (uint256 value) {
        string memory name = _key(key);
        value = vm.envOr(name, UNSET);
        if (value == UNSET) revert MissingEnv(name);
    }

    /// Each of the four narrowing reads range-checks the value on the line above the cast. A
    /// variable that does not fit its field is named in `EnvOutOfRange`, never silently wrapped
    /// into a fee or a window nobody chose.
    // forge-lint: disable-start(unsafe-typecast)
    function _envUint8(string memory key) private view returns (uint8) {
        uint256 value = _envUint(key);
        if (value > type(uint8).max) revert EnvOutOfRange(_key(key), value, type(uint8).max);
        return uint8(value);
    }

    function _envUint16(string memory key) private view returns (uint16) {
        uint256 value = _envUint(key);
        if (value > type(uint16).max) revert EnvOutOfRange(_key(key), value, type(uint16).max);
        return uint16(value);
    }

    function _envUint64(string memory key) private view returns (uint64) {
        uint256 value = _envUint(key);
        if (value > type(uint64).max) revert EnvOutOfRange(_key(key), value, type(uint64).max);
        return uint64(value);
    }

    function _envUint128(string memory key) private view returns (uint128) {
        uint256 value = _envUint(key);
        if (value > type(uint128).max) revert EnvOutOfRange(_key(key), value, type(uint128).max);
        return uint128(value);
    }

    // forge-lint: disable-end

    /// Spelled out, because `envOr` reads an unset variable as false and would quietly skip
    /// the registry.
    function _envBool(string memory key) private view returns (bool) {
        string memory name = _key(key);
        string memory raw = vm.envOr(name, string(""));
        bytes32 given = keccak256(bytes(raw));
        if (given == keccak256("")) revert MissingEnv(name);
        if (given == keccak256("true")) return true;
        if (given == keccak256("false")) return false;
        revert EnvNotBoolean(name, raw);
    }
}
