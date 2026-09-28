// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AdminTimelock} from "../src/AdminTimelock.sol";
import {Buyback} from "../src/token/Buyback.sol";
import {BRSR} from "../src/token/BRSR.sol";
import {Staking} from "../src/token/Staking.sol";
import {Vesting} from "../src/token/Vesting.sol";
import {IOracleRegistry} from "../src/interfaces/IOracleRegistry.sol";
import {IBRSR} from "../src/token/interfaces/IBRSR.sol";
import {IUsdg} from "./interfaces/IUsdg.sol";

/// Deploys the token set against the governance that is already live and reads every decision
/// back off chain before it reports success.
///
/// Vesting, Staking and Buyback each take `AdminTimelock` as admin in their constructors, so
/// no part of this set is ever administered by the deploy key. BRSR has no admin at all: the
/// supply is minted once inside its constructor and split four ways, and the deploy key never
/// holds a token.
///
/// That mint is also the reason for the order below. BRSR has to name the vesting contract as
/// the team's recipient, and the vesting contract has to name BRSR as the token it pays out,
/// and neither address exists when the other constructor runs. The script computes the
/// token's address from the deploy key's nonce, builds the vesting contract against it, then
/// deploys the token and asserts that the address it predicted is the address it got. A
/// mismatch stops the run before a grant is written.
///
/// What the deploy key keeps is one call no constructor can make: `Vesting.createGrants`,
/// which writes the team schedule and closes it. It accepts exactly one call, and a run that
/// stops between the deployments and that call leaves a funded vesting contract with no
/// schedule and no second chance. The only fix is a redeploy.
///
/// The invariants asserted here are the ones no single constructor can see. Four allocations
/// that do not add up to the supply leave tokens somewhere nobody chose; grants that do not
/// add up to the team allocation leave a remainder the timelock has to sweep; a buyback price
/// ceiling large enough to be a figure in another unit is not a price at all; a pool keyed to a
/// currency neither contract holds would spend the treasury on something else; a vesting start
/// backdated past the cliff unlocks a quarter of the team allocation in the first block.
///
/// Gas on Robinhood Chain is ETH and settlement is USDG, two different assets. Nothing here
/// reads a native balance, and every settlement amount in this script is in the six-decimal
/// USDG unit.
contract DeployToken is Script {
    /// Robinhood Chain mainnet, read from the chain itself. Testnet 46630 answers, but USDG
    /// holds no contract there, so nothing on it can settle and it is not a deploy target.
    /// There is no governance pin: the timelock this set joins is deployed per run and has no
    /// published address to check against.
    uint256 internal constant RHC_CHAIN_ID = 4663;
    /// USDG. Six decimals, a diamond proxy, verified on chain.
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// What the deploy key has to hold in the settlement asset before the run starts. The mint
    /// spends no USDG, so this is the proof that the address in the parameter file is the asset
    /// the system settles in, and that the key that just placed a billion tokens can also move
    /// a dollar.
    uint256 internal constant MIN_SETTLEMENT_BALANCE = 1_000_000;

    uint16 internal constant BPS = 10_000;
    uint8 internal constant SETTLEMENT_DECIMALS = 6;
    uint8 internal constant BRSR_DECIMALS = 18;

    /// The published split, checked against what the token actually minted.
    uint16 internal constant COMMUNITY_BPS = 8000;
    uint16 internal constant TEAM_BPS = 1000;
    uint16 internal constant TREASURY_BPS = 500;
    uint16 internal constant LIQUIDITY_BPS = 500;

    /// The published supply and the team's tenth of it. Both are constants in the token too.
    /// These two exist so the preflight can check the grant amounts before anything is sent;
    /// `_verify` reads the real ones back off the deployed token and reverts on a mismatch.
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant TEAM_ALLOCATION = 100_000_000e18;

    /// Mirrors the buyback's own bound. A number entered in the wrong unit is named here,
    /// before a constructor hits it halfway through the run.
    uint128 internal constant MAX_PRICE_MICRO_USD_PER_BRSR = 1e12;

    /// v4 caps a static fee at 100%, expressed in hundredths of a basis point, and reserves
    /// the top bit for the dynamic-fee marker.
    uint24 internal constant MAX_POOL_FEE = 1_000_000;
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant MAX_TICK_SPACING = 32_767;

    /// How far the vesting commencement date may sit from the deployment. Backdating is
    /// legitimate for a grant agreed before the contracts existed. Backdating past the cliff
    /// is a typo that vests a quarter of the team allocation immediately.
    uint64 internal constant MAX_BACKDATE = 90 days;
    uint64 internal constant MAX_POSTDATE = 90 days;

    /// No legitimate parameter reaches these, so they tell an unset variable apart from a zero
    /// someone chose. A hook address of zero is a policy; a hook address nobody set is a
    /// mistake.
    uint256 private constant UNSET = type(uint256).max;
    address private constant UNSET_ADDRESS = address(type(uint160).max);
    int256 private constant UNSET_INT = type(int256).min;

    struct Deployment {
        address brsr;
        address vesting;
        address staking;
        address buyback;
    }

    error MissingEnv(string key);
    error RetiredEnv(string key, string replacement);
    error EnvOutOfRange(string key, uint256 value, uint256 max);
    error EnvIntOutOfRange(string key, int256 value, int256 min, int256 max);
    error WrongChain(uint256 expected, uint256 actual);
    error AssetNotContract(address asset);
    error AssetDecimalsMismatch(address asset, uint8 found, uint8 expected);
    error AssetNotUsdg(address configured, address expected);
    error AssetPaused(address asset);
    error AddressFrozen(string role, address account);
    error SettlementBalanceTooLow(address account, uint256 held, uint256 floor);
    error TimelockNotContract(address timelock);
    error OracleRegistryNotContract(address oracleRegistry);
    error OracleRegistryNotReady(string what, address found, address expected);
    error TimelockPeriodZero();
    error PoolManagerNotContract(address poolManager);
    error PoolHookNotContract(address hooks);
    error DynamicFeePoolRejected();
    error PoolFeeTooLarge(uint24 fee, uint24 max);
    error TickSpacingOutOfRange(int24 tickSpacing);
    error RoleCollision(string role, string otherRole, address account);
    error PriceCeilingNotAPrice(uint128 value, uint128 max);
    error TokenAddressUnpredictable(address expected, address actual);
    error AllocationMismatch(uint256 allocated, uint256 totalSupply);
    error AllocationShareWrong(string share, uint256 allocation, uint256 expected);
    error VestingListLengthMismatch(uint256 beneficiaries, uint256 amounts);
    error VestingAmountsMismatch(uint256 sum, uint256 teamAllocation);
    error VestingStartOutOfRange(uint64 start, uint64 earliest, uint64 latest);
    error DeployerHoldsSupply(uint256 remaining);
    error WiringFailed(string what, address expected, address actual);
    error ParameterNotApplied(string what, uint256 expected, uint256 actual);
    error ScheduleNotApplied(string what, uint256 expected, uint256 actual);

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
    address private timelock;
    address private treasury;
    address private slashSink;
    address private community;
    address private liquidity;
    address private oracleRegistry;
    uint64 private unbondingPeriod;
    uint256 private stakingMinBond;

    address private poolManager;
    uint24 private poolFee;
    int24 private poolTickSpacing;
    address private poolHooks;

    Buyback.Params private buybackParams;

    address[] private beneficiaries;
    uint128[] private grantAmounts;
    uint64 private vestingStart;

    BRSR private brsr;
    Vesting private vesting;
    Staking private staking;
    Buyback private buyback;

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
            brsr: address(brsr), vesting: address(vesting), staking: address(staking), buyback: address(buyback)
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
        timelock = _envAddress("BURSAR_ADMIN_TIMELOCK");
        treasury = _envAddress("BURSAR_TREASURY");
        slashSink = _envAddress("BURSAR_SLASH_SINK");
        community = _envAddress("BURSAR_BRSR_COMMUNITY");
        liquidity = _envAddress("BURSAR_BRSR_LIQUIDITY");
        unbondingPeriod = _envUint64("BURSAR_STAKING_UNBONDING_PERIOD");
        // The BRSR a resolver has to bond before it can vote on a dispute. It lives here
        // rather than in the core deployment because the pool that holds it is part of this
        // set, and because it is denominated in the token this set mints.
        stakingMinBond = _envUint("BURSAR_STAKING_MIN_BOND");

        // The core deployment's resolver registry, which this run closes the last link on.
        // Zero says there is nothing to wire: the honest answer when the core set is not
        // deployed yet or was bonded by an earlier run. An unset variable means something
        // else, so the sentinel is separate.
        oracleRegistry = vm.envOr(_key("BURSAR_ORACLE_REGISTRY"), UNSET_ADDRESS);
        if (oracleRegistry == UNSET_ADDRESS) revert MissingEnv(_key("BURSAR_ORACLE_REGISTRY"));

        poolManager = _envAddress("BURSAR_BUYBACK_POOL_MANAGER");
        poolFee = _envUint24("BURSAR_BUYBACK_POOL_FEE");
        poolTickSpacing = _envInt24("BURSAR_BUYBACK_POOL_TICK_SPACING");
        // Zero is the ordinary case for a pool with no hook, so this one read takes the
        // sentinel and accepts the zero address.
        poolHooks = vm.envOr(_key("BURSAR_BUYBACK_POOL_HOOKS"), UNSET_ADDRESS);
        if (poolHooks == UNSET_ADDRESS) revert MissingEnv(_key("BURSAR_BUYBACK_POOL_HOOKS"));

        // The one variable in this file whose absence is a decision, not an oversight. Unset
        // means a price ceiling of zero, which blocks every buyback, and that is the right
        // state for a contract deployed before its pool has a price. Governance sets a real
        // one through `Buyback.setParams` once the pool is seeded.
        _refuseRetired("BURSAR_BUYBACK_MIN_OUT_PER_USDC", "BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR");

        buybackParams = Buyback.Params({
            spendPerCallMicroUsd: _envUint128("BURSAR_BUYBACK_SPEND_PER_CALL"),
            maxSpendPerWindowMicroUsd: _envUint128("BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW"),
            minSpendMicroUsd: _envUint128("BURSAR_BUYBACK_MIN_SPEND"),
            maxPriceMicroUsdPerBrsr: _envUint128Or("BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR", 0),
            window: _envUint64("BURSAR_BUYBACK_WINDOW"),
            minInterval: _envUint64("BURSAR_BUYBACK_MIN_INTERVAL")
        });

        vestingStart = _envUint64("BURSAR_VESTING_START");
        beneficiaries = _envAddressList("BURSAR_VESTING_BENEFICIARIES");
        grantAmounts = _envUint128List("BURSAR_VESTING_AMOUNTS");
    }

    /// Everything checkable before a single transaction is sent. A run that fails halfway
    /// leaves a live token whose whole supply is already placed and cannot be moved, so the
    /// expensive checks run first.
    function _preflight(address deployer) private view {
        if (asset.code.length == 0) revert AssetNotContract(asset);
        // Wrapped, because an address holding code that does not answer `decimals` fails with
        // a decode error that tells an operator nothing.
        try IERC20Metadata(asset).decimals() returns (uint8 decimals) {
            if (decimals != SETTLEMENT_DECIMALS) {
                revert AssetDecimalsMismatch(asset, decimals, SETTLEMENT_DECIMALS);
            }
        } catch {
            revert AssetNotContract(asset);
        }
        if (_isRobinhoodChain()) {
            if (asset != RHC_USDG) revert AssetNotUsdg(asset, RHC_USDG);
            _requireUsdgWillMove(deployer);
        }

        // Governance is already deployed and already holds the rest of the system. This set
        // joins it and brings none of its own, so the address has to be the live contract with
        // a real delay on it.
        if (timelock.code.length == 0) revert TimelockNotContract(timelock);
        if (AdminTimelock(timelock).timelockPeriod() == 0) revert TimelockPeriodZero();

        // `setStaking` takes one call and no second one, and it is the call that decides what
        // currency every future bond is posted in. Everything checkable about it is checked
        // before the mint, because a failure after it is a redeploy of the whole token set.
        if (oracleRegistry != address(0)) {
            if (oracleRegistry.code.length == 0) revert OracleRegistryNotContract(oracleRegistry);

            IOracleRegistry registry = IOracleRegistry(oracleRegistry);
            address registryDeployer = registry.deployer();
            if (registryDeployer != deployer) {
                revert OracleRegistryNotReady("deployer", registryDeployer, deployer);
            }
            address wired = address(registry.staking());
            if (wired != address(0)) revert OracleRegistryNotReady("staking", wired, address(0));
            address registryAsset = registry.settlementAsset();
            if (registryAsset != asset) revert OracleRegistryNotReady("settlementAsset", registryAsset, asset);
        }

        if (poolManager.code.length == 0) revert PoolManagerNotContract(poolManager);
        // A pool with no hook is the ordinary shape. A hook address with no code behind it is
        // a pool key that will never match a live pool, and every buyback would revert.
        if (poolHooks != address(0) && poolHooks.code.length == 0) revert PoolHookNotContract(poolHooks);
        // A dynamic-fee pool lets its hook set the fee per swap, which hands the venue a lever
        // over the price of every buyback this contract will ever make.
        if (poolFee == DYNAMIC_FEE_FLAG) revert DynamicFeePoolRejected();
        if (poolFee > MAX_POOL_FEE) revert PoolFeeTooLarge(poolFee, MAX_POOL_FEE);
        if (poolTickSpacing <= 0 || poolTickSpacing > MAX_TICK_SPACING) {
            revert TickSpacingOutOfRange(poolTickSpacing);
        }

        // The buyback validates this too. It is repeated here because the failure it prevents
        // is the expensive one, and catching it before the first transaction costs nothing.
        // Zero passes: it is the value that blocks every trade.
        if (buybackParams.maxPriceMicroUsdPerBrsr > MAX_PRICE_MICRO_USD_PER_BRSR) {
            revert PriceCeilingNotAPrice(buybackParams.maxPriceMicroUsdPerBrsr, MAX_PRICE_MICRO_USD_PER_BRSR);
        }

        // The deploy key signs from a shell with an unlocked keystore, and the token's mint is
        // final. Nothing it names as a recipient may be itself, and no two may be the same.
        if (community == deployer) revert RoleCollision("community", "deployer", community);
        if (liquidity == deployer) revert RoleCollision("liquidity", "deployer", liquidity);
        if (treasury == deployer) revert RoleCollision("treasury", "deployer", treasury);
        if (slashSink == deployer) revert RoleCollision("slashSink", "deployer", slashSink);
        if (community == liquidity) revert RoleCollision("community", "liquidity", community);
        if (community == treasury) revert RoleCollision("community", "treasury", community);
        if (liquidity == treasury) revert RoleCollision("liquidity", "treasury", liquidity);
        // Slashed stake and fee revenue answer to different people and must not pool at one
        // address.
        if (slashSink == treasury) revert RoleCollision("slashSink", "treasury", slashSink);

        if (beneficiaries.length != grantAmounts.length) {
            revert VestingListLengthMismatch(beneficiaries.length, grantAmounts.length);
        }
        if (beneficiaries.length == 0) revert MissingEnv(_key("BURSAR_VESTING_BENEFICIARIES"));
        for (uint256 i; i < beneficiaries.length; ++i) {
            address beneficiary = beneficiaries[i];
            if (beneficiary == deployer) revert RoleCollision("beneficiary", "deployer", beneficiary);
            if (beneficiary == treasury) revert RoleCollision("beneficiary", "treasury", beneficiary);
            if (beneficiary == timelock) revert RoleCollision("beneficiary", "timelock", beneficiary);
        }

        uint256 grantSum;
        for (uint256 i; i < grantAmounts.length; ++i) {
            grantSum += grantAmounts[i];
        }
        if (grantSum != TEAM_ALLOCATION) revert VestingAmountsMismatch(grantSum, TEAM_ALLOCATION);

        // forge-lint: disable-start(unsafe-typecast)
        uint64 earliest = uint64(block.timestamp) - MAX_BACKDATE;
        uint64 latest = uint64(block.timestamp) + MAX_POSTDATE;
        // forge-lint: disable-end
        if (vestingStart < earliest || vestingStart > latest) {
            revert VestingStartOutOfRange(vestingStart, earliest, latest);
        }
    }

    function _deploy(address deployer) private {
        // The token's address, computed from the nonce this key is about to spend twice. It
        // is the only way to close the loop between a token that mints into the vesting
        // contract and a vesting contract that pays out that token.
        //
        // The prediction is checked twice and the first check is the one that matters. BRSR's
        // mint is final, so a token built against a vesting address that turns out to be wrong
        // would strand the team allocation in a contract that pays out nothing. Proving the
        // nonce model on the vesting deployment, before the token is sent, means a bad
        // prediction costs one wasted deployment instead of a tenth of the supply.
        uint256 nonce = vm.getNonce(deployer);
        address predictedVesting = vm.computeCreateAddress(deployer, nonce);
        address predicted = vm.computeCreateAddress(deployer, nonce + 1);

        vesting = new Vesting(predicted, timelock, treasury);
        if (address(vesting) != predictedVesting) {
            revert TokenAddressUnpredictable(predictedVesting, address(vesting));
        }

        brsr = new BRSR(
            IBRSR.Allocation({community: community, team: address(vesting), treasury: treasury, liquidity: liquidity})
        );
        if (address(brsr) != predicted) revert TokenAddressUnpredictable(predicted, address(brsr));

        staking = new Staking(
            IERC20(address(brsr)), IERC20(asset), timelock, slashSink, treasury, unbondingPeriod, stakingMinBond
        );

        // The last wiring call in the system, and the one that puts resolver bonds in BRSR.
        // Before it the core deployment's dispute layer has no collateral it can accept.
        if (oracleRegistry != address(0)) IOracleRegistry(oracleRegistry).setStaking(address(staking));

        buyback = new Buyback(
            asset,
            address(brsr),
            poolManager,
            poolFee,
            poolTickSpacing,
            poolHooks,
            address(staking),
            timelock,
            treasury,
            buybackParams
        );

        // The team allocation was minted into the vesting contract by the constructor above,
        // so the schedule can be written against tokens that are already there.
        vesting.createGrants(beneficiaries, grantAmounts, vestingStart);
    }

    /// Reads every decision back off chain. A constructor that reverted inside the broadcast
    /// would have stopped the run; a constructor handed an address a stale variable named
    /// would not, and BRSR cannot be minted twice.
    function _verify(address deployer) private view {
        IERC20Metadata token = IERC20Metadata(address(brsr));
        uint8 decimals = token.decimals();
        if (decimals != BRSR_DECIMALS) revert AssetDecimalsMismatch(address(brsr), decimals, BRSR_DECIMALS);

        uint256 supply = brsr.TOTAL_SUPPLY();
        _expectUint("brsr.totalSupply", supply, token.totalSupply());
        _expectUint("brsr.TOTAL_SUPPLY", TOTAL_SUPPLY, supply);
        _expectUint("brsr.TEAM_ALLOCATION", TEAM_ALLOCATION, brsr.TEAM_ALLOCATION());

        // The four allocations are constants in the token. Checked against the published
        // split and against the supply they divide, because a constant that drifted would
        // deploy cleanly and be wrong forever.
        _expectShare("community", brsr.COMMUNITY_ALLOCATION(), (supply * COMMUNITY_BPS) / BPS);
        _expectShare("team", brsr.TEAM_ALLOCATION(), (supply * TEAM_BPS) / BPS);
        _expectShare("treasury", brsr.TREASURY_ALLOCATION(), (supply * TREASURY_BPS) / BPS);
        _expectShare("liquidity", brsr.LIQUIDITY_ALLOCATION(), (supply * LIQUIDITY_BPS) / BPS);

        uint256 allocated = brsr.COMMUNITY_ALLOCATION() + brsr.TEAM_ALLOCATION() + brsr.TREASURY_ALLOCATION()
            + brsr.LIQUIDITY_ALLOCATION();
        if (allocated != supply) revert AllocationMismatch(allocated, supply);

        // The invariant that catches a mint gone astray in one read. Anything the token failed
        // to place would be here, in a key that signs from a shell.
        uint256 remaining = token.balanceOf(deployer);
        if (remaining != 0) revert DeployerHoldsSupply(remaining);

        _expectUint("balance.community", brsr.COMMUNITY_ALLOCATION(), token.balanceOf(community));
        _expectUint("balance.treasury", brsr.TREASURY_ALLOCATION(), token.balanceOf(treasury));
        _expectUint("balance.liquidity", brsr.LIQUIDITY_ALLOCATION(), token.balanceOf(liquidity));
        _expectUint("balance.vesting", brsr.TEAM_ALLOCATION(), token.balanceOf(address(vesting)));

        _expect("vesting.token", address(brsr), address(vesting.token()));
        _expect("vesting.admin", timelock, vesting.admin());
        _expect("vesting.pendingAdmin", address(0), vesting.pendingAdmin());
        _expect("vesting.treasury", treasury, vesting.treasury());
        _expect("vesting.deployer", deployer, vesting.deployer());
        // The schedule is a pair of constants in the contract. Read back, because a contract
        // swapped under this script would deploy cleanly and vest on someone else's terms.
        _expectSchedule("vesting.CLIFF", 365 days, vesting.CLIFF());
        _expectSchedule("vesting.DURATION", 1460 days, vesting.DURATION());
        _expectUint("vesting.grantsWritten", 1, vesting.grantsWritten() ? 1 : 0);
        _expectUint("vesting.outstandingWei", brsr.TEAM_ALLOCATION(), vesting.outstandingWei());
        // Every minted team token is spoken for. A remainder would sit here until governance
        // noticed it.
        _expectUint("vesting.unallocatedWei", 0, vesting.unallocatedWei());

        for (uint256 i; i < beneficiaries.length; ++i) {
            Vesting.Grant memory grant = vesting.grantOf(beneficiaries[i]);
            _expectUint("vesting.grant.totalWei", grantAmounts[i], grant.totalWei);
            _expectUint("vesting.grant.start", vestingStart, grant.start);
            _expectUint("vesting.grant.claimedWei", 0, grant.claimedWei);
            _expectUint("vesting.grant.revokedAt", 0, grant.revokedAt);
            // Nothing may be claimable on the day of the deployment. A backdated start that
            // slipped past the range check would show up here as a grant already through its
            // cliff.
            _expectUint("vesting.grant.claimable", 0, vesting.claimableOf(beneficiaries[i]));
        }

        _expect("staking.stakeToken", address(brsr), address(staking.stakeToken()));
        _expect("staking.rewardToken", asset, address(staking.rewardToken()));
        _expect("staking.admin", timelock, staking.admin());
        _expect("staking.pendingAdmin", address(0), staking.pendingAdmin());
        _expect("staking.slashSink", slashSink, staking.slashSink());
        _expect("staking.treasury", treasury, staking.treasury());
        _expectUint("staking.unbondingPeriod", unbondingPeriod, staking.unbondingPeriod());
        _expectUint("staking.minBond", stakingMinBond, staking.minBond());
        _expectUint("staking.totalShares", 0, staking.totalShares());
        _expectUint("staking.paused", 0, staking.paused() ? 1 : 0);
        // Nothing can take stake until governance names the credit lane, which is a proposal
        // of its own. Asserted so the deployment cannot be mistaken for a finished one.
        _expect("staking.creditManager", address(0), staking.creditManager());

        // Read back because it decides the currency of every resolver bond from here on, and
        // `setStaking` takes no second call.
        if (oracleRegistry != address(0)) {
            IOracleRegistry registry = IOracleRegistry(oracleRegistry);
            _expect("oracleRegistry.staking", address(staking), address(registry.staking()));
            _expect("oracleRegistry.bondAsset", address(brsr), address(registry.bondAsset()));
        }

        _expect("buyback.settlementAsset", asset, address(buyback.settlementAsset()));
        _expect("buyback.brsr", address(brsr), address(buyback.brsr()));
        _expect("buyback.poolManager", poolManager, address(buyback.poolManager()));
        _expect("buyback.staking", address(staking), address(buyback.staking()));
        _expect("buyback.treasury", treasury, buyback.treasury());
        _expect("buyback.admin", timelock, buyback.admin());
        _expect("buyback.pendingAdmin", address(0), buyback.pendingAdmin());
        _expectUint("buyback.paused", 0, buyback.paused() ? 1 : 0);

        // The pool key is re-derived, not echoed. Sorting is what decides the swap direction,
        // and a direction taken from the wrong side of the comparison would sell the
        // treasury's USDG instead of buying with it.
        (address c0, address c1) = asset < address(brsr) ? (asset, address(brsr)) : (address(brsr), asset);
        _expect("buyback.currency0", c0, buyback.currency0());
        _expect("buyback.currency1", c1, buyback.currency1());
        _expectUint("buyback.poolFee", poolFee, buyback.poolFee());
        _expectInt("buyback.poolTickSpacing", poolTickSpacing, buyback.poolTickSpacing());
        _expect("buyback.poolHooks", poolHooks, buyback.poolHooks());
        _expectUint("buyback.settlementIsCurrency0", asset == c0 ? 1 : 0, buyback.settlementIsCurrency0() ? 1 : 0);

        Buyback.Params memory applied = buyback.params();
        _expectUint("buyback.spendPerCall", buybackParams.spendPerCallMicroUsd, applied.spendPerCallMicroUsd);
        _expectUint(
            "buyback.maxSpendPerWindow", buybackParams.maxSpendPerWindowMicroUsd, applied.maxSpendPerWindowMicroUsd
        );
        _expectUint("buyback.minSpend", buybackParams.minSpendMicroUsd, applied.minSpendMicroUsd);
        _expectUint("buyback.maxPrice", buybackParams.maxPriceMicroUsdPerBrsr, applied.maxPriceMicroUsdPerBrsr);
        _expectUint("buyback.window", buybackParams.window, applied.window);
        _expectUint("buyback.minInterval", buybackParams.minInterval, applied.minInterval);

        // The buyback pays USDG to the pool manager on every call. A frozen address cannot,
        // and the failure would read as a broken pool rather than a frozen address.
        if (_isRobinhoodChain()) {
            _requireNotFrozen("buyback", address(buyback));
            _requireNotFrozen("poolManager", poolManager);
        }
    }

    function _report(address deployer) private view {
        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("settlementAsset", asset);
        console2.log("AdminTimelock", timelock);
        console2.log("BRSR", address(brsr));
        console2.log("  totalSupply", brsr.TOTAL_SUPPLY());
        console2.log("  community", community);
        console2.log("  liquidity", liquidity);
        console2.log("  treasury", treasury);
        console2.log("Vesting", address(vesting));
        console2.log("  grants", beneficiaries.length);
        console2.log("  start", vestingStart);
        console2.log("Staking", address(staking));
        console2.log("  slashSink", slashSink);
        console2.log("  unbondingPeriod", unbondingPeriod);
        console2.log("  minBond, BRSR wei per resolver", stakingMinBond);
        if (oracleRegistry == address(0)) {
            console2.log("  no OracleRegistry named: resolver bonds stay closed");
        } else {
            console2.log("  resolver bonds now post to", oracleRegistry);
        }
        console2.log("Buyback", address(buyback));
        console2.log("  poolManager", poolManager);
        console2.log("  maxPriceMicroUsdPerBrsr", buybackParams.maxPriceMicroUsdPerBrsr);

        if (_isRobinhoodChain()) {
            // Every one of these answered inside the preflight or the readback, so a line here
            // is a statement of fact rather than a value that might be missing. The run would
            // have stopped on any address that came back frozen.
            console2.log("USDG freeze list: clear for deployer, treasury, buyback, poolManager");
        }

        // What the deployment cannot do for itself, in the order it has to happen. The price
        // ceiling comes before the money. A funded buyback whose ceiling is still being
        // proposed would be a pot of USDG with the refusal as its only protection, and that
        // proposal carries a forty-eight hour delay. Start it, let it land, then fund.
        console2.log("Next: seed the BRSR/USDG pool from the liquidity address");
        console2.log("Next: stake, because a buyback into an empty pool has nobody to credit");
        console2.log("Next: propose Buyback.setParams from the timelock, carrying a real price ceiling");
        console2.log("  buyback", address(buyback));
        console2.log("  micro-USD per whole BRSR, at most", MAX_PRICE_MICRO_USD_PER_BRSR);
        console2.log("  until it lands every buyback reverts with PriceCeilingUnset");
        console2.log("Next: fund the buyback by transferring USDG to it from the treasury");
        console2.log("Next: propose Staking.setCreditManager and Staking.setTiers from the timelock");
        console2.log("  staking", address(staking));
    }

    /// Robinhood Chain mainnet, the only chain this run pins an asset address on.
    function _isRobinhoodChain() private view returns (bool) {
        return block.chainid == RHC_CHAIN_ID;
    }

    /// Reverts before broadcast when USDG itself would stop the run. A paused asset stops every
    /// settlement at once, and a frozen deploy key cannot move the token it is deploying
    /// against.
    ///
    /// Read straight, with no gas stipend and no three-valued answer. Both are only needed when a
    /// block list lives behind a node precompile that publishes a single byte of code: anything
    /// running against a fetched copy of the chain executes that byte, which fails
    /// the way an invalid opcode does and consumes every unit forwarded to it. USDG is an
    /// ordinary contract whose storage a fork fetches, so the read either answers or the asset
    /// has changed under this deployment, which is a reason to stop.
    function _requireUsdgWillMove(address deployer) private view {
        if (IUsdg(asset).paused()) revert AssetPaused(asset);
        _requireNotFrozen("deployer", deployer);
        _requireNotFrozen("treasury", treasury);

        uint256 held = IERC20(asset).balanceOf(deployer);
        if (held < MIN_SETTLEMENT_BALANCE) {
            revert SettlementBalanceTooLow(deployer, held, MIN_SETTLEMENT_BALANCE);
        }
    }

    /// A frozen address reverts every transfer whatever its balance says.
    function _requireNotFrozen(string memory role, address account) private view {
        if (IUsdg(asset).isFrozen(account)) revert AddressFrozen(role, account);
    }

    function _expect(string memory what, address expected, address actual) private pure {
        if (expected != actual) revert WiringFailed(what, expected, actual);
    }

    function _expectUint(string memory what, uint256 expected, uint256 actual) private pure {
        if (expected != actual) revert ParameterNotApplied(what, expected, actual);
    }

    function _expectInt(string memory what, int256 expected, int256 actual) private pure {
        // forge-lint: disable-next-line(unsafe-typecast)
        if (expected != actual) revert ParameterNotApplied(what, uint256(expected), uint256(actual));
    }

    function _expectShare(string memory share, uint256 allocation, uint256 expected) private pure {
        if (allocation != expected) revert AllocationShareWrong(share, allocation, expected);
    }

    function _expectSchedule(string memory what, uint256 expected, uint256 actual) private pure {
        if (expected != actual) revert ScheduleNotApplied(what, expected, actual);
    }

    function _key(string memory key) private view returns (string memory) {
        return bytes(envPrefix).length == 0 ? key : string.concat(envPrefix, key);
    }

    /// A retired variable still holds a value in the unit it was retired for. Reading it under
    /// the new name would be worse than ignoring it.
    function _refuseRetired(string memory key, string memory replacement) private view {
        string memory name = _key(key);
        if (bytes(vm.envOr(name, string(""))).length != 0) revert RetiredEnv(name, _key(replacement));
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

    function _envAddressList(string memory key) private view returns (address[] memory value) {
        address[] memory empty;
        value = vm.envOr(_key(key), ",", empty);
        if (value.length == 0) revert MissingEnv(_key(key));
    }

    function _envUint128List(string memory key) private view returns (uint128[] memory value) {
        string memory name = _key(key);
        uint256[] memory empty;
        uint256[] memory raw = vm.envOr(name, ",", empty);
        if (raw.length == 0) revert MissingEnv(name);

        value = new uint128[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            if (raw[i] > type(uint128).max) revert EnvOutOfRange(name, raw[i], type(uint128).max);
            // forge-lint: disable-next-line(unsafe-typecast)
            value[i] = uint128(raw[i]);
        }
    }

    /// Each narrowing read range-checks the value on the line above the cast. A variable that
    /// does not fit its field is named in `EnvOutOfRange`, never silently wrapped into a
    /// window, a fee or a price floor nobody chose.
    // forge-lint: disable-start(unsafe-typecast)
    function _envUint24(string memory key) private view returns (uint24) {
        uint256 value = _envUint(key);
        if (value > type(uint24).max) revert EnvOutOfRange(_key(key), value, type(uint24).max);
        return uint24(value);
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

    /// For the one variable that is allowed to be absent.
    function _envUint128Or(string memory key, uint128 whenUnset) private view returns (uint128) {
        string memory name = _key(key);
        uint256 value = vm.envOr(name, uint256(whenUnset));
        if (value > type(uint128).max) revert EnvOutOfRange(name, value, type(uint128).max);
        return uint128(value);
    }

    function _envInt24(string memory key) private view returns (int24) {
        string memory name = _key(key);
        int256 value = vm.envOr(name, UNSET_INT);
        if (value == UNSET_INT) revert MissingEnv(name);
        if (value < type(int24).min || value > type(int24).max) {
            revert EnvIntOutOfRange(name, value, type(int24).min, type(int24).max);
        }
        return int24(value);
    }
    // forge-lint: disable-end
}
