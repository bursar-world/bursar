// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";

/// Directory of the counterparties a mandate may name, each backed by a stake in the
/// settlement asset.
///
/// The stake is collateral rather than a listing fee: it is what a dispute ruling takes
/// from an agent that fails a job, and it is the number a principal is really trusting
/// when it allowlists one. Exit runs through a delayed request so a stake cannot leave in
/// the window between a bad job and the ruling on it.
///
/// Every amount is denominated in the settlement asset's own units, six decimals for USDG.
/// The native 18-decimal view of the same balance is never read; it is the same money
/// counted twice.
contract AgentRegistry is IAgentRegistry, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyRegistered();
    error NotRegistered();
    error NotActive();
    error AlreadyActive();
    error InsufficientStake();
    error NotAuthorized();
    error WithdrawalPending();
    error WithdrawalNotRequested();
    error WithdrawalNotMatured();
    error InvalidName();
    error IsBlacklisted();
    error NotBlacklisted();
    error RootNotSet();
    error BadProof();
    error BadConfig();
    error TransferMismatch();
    error ZeroAddress();
    error ZeroAmount();

    struct Agent {
        string name;
        uint128 stake;
        uint64 registeredAt;
        bool active;
    }

    /// `requestedAt` is the moment the exit was asked for; maturity is derived from the
    /// live `WITHDRAWAL_DELAY` so a pending request carries no frozen parameters.
    struct Withdrawal {
        uint128 amount;
        uint64 requestedAt;
    }

    event AgentRegistered(address indexed agent, string name, uint128 stake);
    event AgentDeactivated(address indexed agent);
    event AgentReactivated(address indexed agent);
    event StakeAdded(address indexed agent, uint128 amount, uint128 stake);
    event WithdrawalRequested(address indexed agent, uint128 amount, uint64 maturesAt);
    event WithdrawalReduced(address indexed agent, uint128 amount);
    event WithdrawalCancelled(address indexed agent);
    event StakeWithdrawn(address indexed agent, uint128 amount, uint128 stake);
    event AgentSlashed(address indexed agent, uint128 amount, uint128 stake, bytes32 reason);
    event AgentBlacklisted(address indexed agent);
    event BlacklistCleared(address indexed agent);
    event BlacklistRootUpdated(bytes32 indexed root);
    event MinStakeUpdated(uint128 amount);
    event SlashBpsUpdated(uint16 bps);
    event SlasherUpdated(address indexed account);
    event SlashSinkUpdated(address indexed account);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event Swept(address indexed token, address indexed to, uint256 amount);

    uint64 public constant WITHDRAWAL_DELAY = 7 days;

    /// A single ruling can never take more than half a stake, so an admin that starts
    /// slashing without cause is visible for several rounds before the collateral is gone.
    uint16 public constant MAX_SLASH_BPS = 5000;

    uint256 private constant MIN_NAME_LENGTH = 3;
    uint256 private constant MAX_NAME_LENGTH = 32;

    /// Named to match the same getter on the escrow and the mandate account, which is the
    /// vocabulary an operator reads across the deployment.
    // forge-lint: disable-next-item(screaming-snake-case-immutable)
    IERC20 public immutable settlementAsset;

    address public admin;
    address public pendingAdmin;

    /// A second address allowed to take collateral, held apart from `admin` so that a party
    /// which rules on jobs need not also be able to reconfigure the registry.
    ///
    /// Unset in the deployed system, and that is the accurate reading, not an omission.
    /// Nothing in the protocol can size a ruling against an agent: a dispute produces a quality
    /// score, the escrow turns that into a refund split, and the reputation curve lowers the
    /// cap on the agent's next lock. Collateral is the one consequence with no automatic
    /// measure behind it. It moves on an admin call: a governance proposal with a delay on it
    /// and a person naming the figure.
    address public slasher;
    address public slashSink;

    uint128 public minStake;
    uint16 public slashBps;

    /// Root of the addresses barred from the registry. Membership is proved on chain by
    /// anyone; removal is an admin act, because a non-membership proof would require a
    /// different tree shape for no gain.
    bytes32 public blacklistRoot;

    uint128 public totalStaked;
    uint128 public totalSlashed;

    mapping(address => Agent) private _agents;
    mapping(address => bool) public isRegistered;
    mapping(address => bool) public override isBlacklisted;
    mapping(address => Withdrawal) public withdrawals;

    address[] private _agentList;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    modifier onlyRegistered() {
        if (!isRegistered[msg.sender]) revert NotRegistered();
        _;
    }

    constructor(
        IERC20 asset,
        address initialAdmin,
        address initialSlashSink,
        uint128 initialMinStake,
        uint16 initialSlashBps
    ) {
        if (address(asset) == address(0) || initialAdmin == address(0) || initialSlashSink == address(0)) {
            revert ZeroAddress();
        }
        if (initialMinStake == 0 || initialSlashBps == 0 || initialSlashBps > MAX_SLASH_BPS) revert BadConfig();

        settlementAsset = asset;
        admin = initialAdmin;
        slashSink = initialSlashSink;
        minStake = initialMinStake;
        slashBps = initialSlashBps;
    }

    /// Joins the registry with `stake` pulled from the caller. `name` is a display handle,
    /// not an identity: it is not unique and nothing in the protocol resolves it.
    function register(string calldata name, uint128 stake) external whenNotPaused nonReentrant {
        if (isRegistered[msg.sender]) revert AlreadyRegistered();
        if (isBlacklisted[msg.sender]) revert IsBlacklisted();
        if (stake < minStake) revert InsufficientStake();
        _validateName(name);

        _agents[msg.sender] = Agent({name: name, stake: stake, registeredAt: uint64(block.timestamp), active: true});
        isRegistered[msg.sender] = true;
        _agentList.push(msg.sender);
        totalStaked += stake;

        _pull(stake);

        emit AgentRegistered(msg.sender, name, stake);
    }

    /// Topping up cancels a pending exit. Asking to leave and adding collateral in the same
    /// breath is contradictory, and the alternative reading would let an agent hold a
    /// matured request open as a standing option to drain.
    function addStake(uint128 amount) external whenNotPaused onlyRegistered nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (isBlacklisted[msg.sender]) revert IsBlacklisted();

        if (withdrawals[msg.sender].amount != 0) {
            delete withdrawals[msg.sender];
            emit WithdrawalCancelled(msg.sender);
        }

        Agent storage agent = _agents[msg.sender];
        agent.stake += amount;
        totalStaked += amount;

        _pull(amount);

        emit StakeAdded(msg.sender, amount, agent.stake);
    }

    /// An active agent has to leave `minStake` behind. Dropping below the floor is a
    /// deregistration, and `deactivate` is the way to ask for one.
    function requestWithdrawal(uint128 amount) external whenNotPaused onlyRegistered {
        if (amount == 0) revert ZeroAmount();
        if (withdrawals[msg.sender].amount != 0) revert WithdrawalPending();

        Agent storage agent = _agents[msg.sender];
        if (amount > agent.stake) revert InsufficientStake();
        if (agent.active && agent.stake - amount < minStake) revert InsufficientStake();

        withdrawals[msg.sender] = Withdrawal({amount: amount, requestedAt: uint64(block.timestamp)});

        emit WithdrawalRequested(msg.sender, amount, uint64(block.timestamp) + WITHDRAWAL_DELAY);
    }

    /// Open while paused. A matured exit is the agent's own collateral, and a pause stops new
    /// exposure without stranding what is already owed.
    function executeWithdrawal() external onlyRegistered nonReentrant {
        Withdrawal memory pending = withdrawals[msg.sender];
        if (pending.amount == 0) revert WithdrawalNotRequested();
        if (block.timestamp < pending.requestedAt + WITHDRAWAL_DELAY) revert WithdrawalNotMatured();

        Agent storage agent = _agents[msg.sender];
        if (pending.amount > agent.stake) revert InsufficientStake();

        agent.stake -= pending.amount;
        totalStaked -= pending.amount;
        delete withdrawals[msg.sender];

        if (agent.active && agent.stake < minStake) {
            agent.active = false;
            emit AgentDeactivated(msg.sender);
        }

        settlementAsset.safeTransfer(msg.sender, pending.amount);

        emit StakeWithdrawn(msg.sender, pending.amount, agent.stake);
    }

    function cancelWithdrawal() external onlyRegistered {
        if (withdrawals[msg.sender].amount == 0) revert WithdrawalNotRequested();

        delete withdrawals[msg.sender];

        emit WithdrawalCancelled(msg.sender);
    }

    /// Stops the agent reading as available to principals. The stake stays put and stays
    /// slashable, so this is not an exit.
    function deactivate() external onlyRegistered {
        Agent storage agent = _agents[msg.sender];
        if (!agent.active) revert NotActive();

        agent.active = false;

        emit AgentDeactivated(msg.sender);
    }

    function reactivate() external whenNotPaused onlyRegistered {
        Agent storage agent = _agents[msg.sender];
        if (agent.active) revert AlreadyActive();
        if (isBlacklisted[msg.sender]) revert IsBlacklisted();
        if (agent.stake < minStake) revert InsufficientStake();

        agent.active = true;

        emit AgentReactivated(msg.sender);
    }

    /// Takes up to `amount` from the agent's stake and sends it to the slash sink.
    ///
    /// The caller names the figure, because a ruling is about what one job cost someone and
    /// not about a fixed share of whatever collateral happens to be posted. `slashBps` stays
    /// as the ceiling on any single ruling, and a request above the ceiling is clamped to it
    /// rather than rejected: the caller is a resolver finalising a dispute, and a revert here
    /// would leave that dispute unresolvable by anyone. `maxSlash` is the figure to size a
    /// request against.
    ///
    /// `reason` is a fixed-width tag. The slasher pays for this call, and an unbounded string
    /// is a way to make ruling against a bad agent cost more than letting it go.
    function slash(address agent, uint256 amount, bytes32 reason) external override nonReentrant {
        if (msg.sender != slasher && msg.sender != admin) revert NotAuthorized();
        if (!isRegistered[agent]) revert NotRegistered();
        if (amount == 0) revert ZeroAmount();

        Agent storage entry = _agents[agent];
        uint256 ceiling = (uint256(entry.stake) * slashBps) / 10_000;
        uint128 taken = uint128(amount < ceiling ? amount : ceiling);

        entry.stake -= taken;
        totalStaked -= taken;
        totalSlashed += taken;

        // A pending exit written against the pre-slash stake would otherwise revert at
        // execution and force the agent to restart the delay it has already served.
        Withdrawal storage pending = withdrawals[agent];
        if (pending.amount > entry.stake) {
            pending.amount = entry.stake;
            emit WithdrawalReduced(agent, entry.stake);
        }

        if (entry.active && entry.stake < minStake) {
            entry.active = false;
            emit AgentDeactivated(agent);
        }

        // An agent already stripped to nothing takes a ruling of zero. The event still fires:
        // a resolver ruled against this agent, and that is the record a principal reads, even
        // when there was no collateral left to take.
        if (taken != 0) settlementAsset.safeTransfer(slashSink, taken);

        emit AgentSlashed(agent, taken, entry.stake, reason);
    }

    /// Permissionless: the root is the admin's statement, and anyone may hold the registry
    /// to it. Unregistered addresses can be flagged too, which is what keeps a barred
    /// address from simply registering a moment later.
    function flagBlacklisted(address agent, bytes32[] calldata proof) external {
        bytes32 root = blacklistRoot;
        if (root == bytes32(0)) revert RootNotSet();
        if (isBlacklisted[agent]) revert IsBlacklisted();
        if (!MerkleProof.verifyCalldata(proof, root, agentLeaf(agent))) revert BadProof();

        isBlacklisted[agent] = true;

        Agent storage entry = _agents[agent];
        if (entry.active) {
            entry.active = false;
            emit AgentDeactivated(agent);
        }

        emit AgentBlacklisted(agent);
    }

    /// Clearing the flag does not reactivate the agent; that is the agent's own call, and
    /// it fails again while the root still carries them.
    function clearBlacklist(address agent) external onlyAdmin {
        if (!isBlacklisted[agent]) revert NotBlacklisted();

        isBlacklisted[agent] = false;

        emit BlacklistCleared(agent);
    }

    /// A zero root disables the gate; it does not bar everyone. The flag itself enforces
    /// exclusion once it is set.
    function setBlacklistRoot(bytes32 root) external onlyAdmin {
        blacklistRoot = root;
        emit BlacklistRootUpdated(root);
    }

    /// Raising the floor does not deregister anyone. It binds on the next registration and
    /// on partial withdrawals; an agent under the new floor can still deactivate and exit
    /// in full.
    function setMinStake(uint128 newMinStake) external onlyAdmin {
        if (newMinStake == 0) revert BadConfig();
        minStake = newMinStake;
        emit MinStakeUpdated(newMinStake);
    }

    function setSlashBps(uint16 newSlashBps) external onlyAdmin {
        if (newSlashBps == 0 || newSlashBps > MAX_SLASH_BPS) revert BadConfig();
        slashBps = newSlashBps;
        emit SlashBpsUpdated(newSlashBps);
    }

    /// Names a second address allowed to rule against a stake. Re-pointable, unlike the escrow
    /// pairing, because replacing a ruling authority moves custody of nothing. There is no
    /// contract in this system that can size a ruling, so nothing calls this today.
    function setSlasher(address newSlasher) external onlyAdmin {
        if (newSlasher == address(0)) revert ZeroAddress();
        slasher = newSlasher;
        emit SlasherUpdated(newSlasher);
    }

    function setSlashSink(address newSlashSink) external onlyAdmin {
        if (newSlashSink == address(0)) revert ZeroAddress();
        slashSink = newSlashSink;
        emit SlashSinkUpdated(newSlashSink);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    /// Two-step so a mistyped address cannot orphan the registry.
    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(msg.sender, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// Recovers a mistaken transfer. Staked collateral is out of reach: for the settlement
    /// asset only the balance above `totalStaked` can leave this way.
    function sweep(address token, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(settlementAsset) && amount > unaccounted()) revert InsufficientStake();

        IERC20(token).safeTransfer(to, amount);

        emit Swept(token, to, amount);
    }

    /// What a principal should read before naming a counterparty: registered, live, funded
    /// to the floor and not barred.
    function isActive(address agent) external view override returns (bool) {
        Agent storage entry = _agents[agent];
        return isRegistered[agent] && entry.active && !isBlacklisted[agent] && entry.stake >= minStake;
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    /// Widened to `uint256` for consumers, which hold amounts in the ERC-20 width even though
    /// a stake is packed into 128 bits here.
    function stakeOf(address agent) external view override returns (uint256) {
        return _agents[agent].stake;
    }

    /// The most a single ruling can take right now. A resolver sizing a slash reads this
    /// first; anything above it is clamped.
    function maxSlash(address agent) external view returns (uint256) {
        return (uint256(_agents[agent].stake) * slashBps) / 10_000;
    }

    function withdrawalMaturity(address agent) external view returns (uint64) {
        Withdrawal storage pending = withdrawals[agent];
        if (pending.amount == 0) return 0;
        return pending.requestedAt + WITHDRAWAL_DELAY;
    }

    /// `limit` is clamped against the remaining tail, never added to `offset`. The obvious way
    /// to ask for everything, `getAgents(0, type(uint256).max)`, returns the list instead of
    /// reverting on an arithmetic overflow.
    function getAgents(uint256 offset, uint256 limit) external view returns (address[] memory agents, uint256 total) {
        total = _agentList.length;
        if (offset >= total) return (new address[](0), total);

        uint256 remaining = total - offset;
        uint256 count = limit < remaining ? limit : remaining;

        agents = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            agents[i] = _agentList[offset + i];
        }
    }

    function totalAgents() external view returns (uint256) {
        return _agentList.length;
    }

    /// Settlement asset held here beyond the stake ledger, which is what a stray transfer
    /// leaves behind.
    function unaccounted() public view returns (uint256) {
        return settlementAsset.balanceOf(address(this)) - totalStaked;
    }

    /// Double-hashed so a proof for an internal node cannot be passed off as a leaf.
    function agentLeaf(address agent) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(agent))));
    }

    function _pull(uint128 amount) private {
        uint256 before = settlementAsset.balanceOf(address(this));
        settlementAsset.safeTransferFrom(msg.sender, address(this), amount);
        if (settlementAsset.balanceOf(address(this)) - before != amount) revert TransferMismatch();
    }

    /// Restricted to ASCII alphanumerics and underscore so a handle cannot carry
    /// right-to-left or zero-width characters that render as another agent's name.
    function _validateName(string calldata name) private pure {
        bytes memory raw = bytes(name);
        if (raw.length < MIN_NAME_LENGTH || raw.length > MAX_NAME_LENGTH) revert InvalidName();

        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 char = raw[i];
            bool ok = (char >= 0x30 && char <= 0x39) || (char >= 0x41 && char <= 0x5A) || (char >= 0x61 && char <= 0x7A)
                || char == 0x5F;
            if (!ok) revert InvalidName();
        }
    }
}
