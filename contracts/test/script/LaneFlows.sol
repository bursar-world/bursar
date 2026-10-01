// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RecordKeys as K} from "../../script/lib/RecordKeys.sol";

import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {Escrow} from "../../src/Escrow.sol";
import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {CommittedMandateAccount} from "../../src/privacy/CommittedMandateAccount.sol";
import {CollateralVault} from "../../src/rwa/CollateralVault.sol";
import {CreditPool} from "../../src/rwa/CreditPool.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {StockSpendRouter} from "../../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {MockUsdg} from "../mocks/MockUsdg.sol";
import {MockFeed, MockStock} from "../rwa/RwaMocks.sol";

/// The shielded contracts, as the lanes call them. Declared here because they are built with the
/// compiler the vendored code pins, which this file cannot import alongside the core set.
struct Withdrawal {
    address processooor;
    bytes data;
}

struct WithdrawProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[8] pubSignals;
}

struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals;
}

interface IShieldedEntrypoint {
    function deposit(address asset, uint256 value, uint256 precommitment) external returns (uint256 commitment);
    function updateRoot(uint256 root, string memory ipfsCid) external returns (uint256 index);
}

interface IShieldedRelay {
    function relay(Withdrawal calldata withdrawal, WithdrawProof calldata proof) external payable;
}

interface IShieldedPool {
    function ragequit(RagequitProof memory proof) external;
}

/// One flow per lane, against whatever deployment `lanePath` records: a public spend through the
/// escrow, a stock purchase, parking and unparking in the treasury lane, a draw and repayment on the
/// collateral lane, a proven spend from a committed mandate, and a shielded deposit, relayed
/// withdrawal and ragequit. The in-process end-to-end suite runs these after deploying through the
/// scripts; the local chain suite runs them against a rehearsal.
///
/// Every outside contract is a local stand-in anyone can mint from, which is what lets a flow fund
/// its own actors.
abstract contract LaneFlows is Test {
    using stdJson for string;

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PAYER = address(0xE2E00001);
    address internal constant PAYEE = address(0xE2E00002);
    address internal constant ALICE = address(0xE2E00003);
    address internal constant BOB = address(0xE2E00004);
    address internal constant RELAYER = address(0xE2E00005);
    bytes32 internal constant CAPABILITY = keccak256("service:gpu.render:1");

    string internal lanePath;
    string internal json;

    function _lanes(string memory path) internal {
        lanePath = path;
        json = vm.readFile(path);
        _registerPayee(PAYEE, "e2e_payee");
        address mandate = _lanePublicSpend();
        _laneStockBuy(mandate);
        _lanePark(mandate);
        _laneCollateral();
        _laneShielded();
        // Last, because its proof pins the clock to the moment it was made.
        _laneCommitted();
    }

    function _at(string memory key) internal view returns (address) {
        return json.readAddress(key);
    }

    function _asset(string memory symbol) internal view returns (address) {
        return json.readAddress(string.concat(K.RWA_ASSETS, ".", symbol, ".address"));
    }

    /// Feeds report the time they were last written. Every flow that prices something writes them
    /// again first, so a flow run after a clock change reads fresh prices.
    function _freshFeeds() internal {
        string[4] memory symbols = ["SGOV", "SPY", "NVDA", "AAPL"];
        for (uint256 i; i < 4; ++i) {
            MockFeed feed = MockFeed(json.readAddress(string.concat(K.EXTERNAL_ASSETS, ".", symbols[i], ".feed")));
            feed.set(feed.answer(), block.timestamp);
        }
    }

    function _registerPayee(address payee, string memory name) internal {
        AgentRegistry registry = AgentRegistry(_at(K.AGENT_REGISTRY));
        if (registry.isRegistered(payee)) return;
        uint128 stake = registry.minStake();
        MockUsdg(USDG).mint(payee, stake);
        vm.startPrank(payee);
        IERC20(USDG).approve(address(registry), stake);
        registry.register(name, stake);
        vm.stopPrank();
        assertTrue(registry.isActive(payee), "the payee is not active");
    }

    function _limits(uint8 lane) internal pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 10e6,
            dailyCap: 50e6,
            monthlyCap: 200e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 20e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: lane
        });
    }

    function _newMandate(bytes32 salt, uint8 lane) internal returns (IMandateAccount mandate) {
        MandateAccountFactory factory = MandateAccountFactory(_at(K.FACTORY));
        vm.startPrank(PAYER);
        mandate = IMandateAccount(factory.create(PAYER, PAYER, salt, _limits(lane)));
        mandate.setCapability(CAPABILITY, true);
        mandate.setMerchant(PAYEE, true);
        vm.stopPrank();
    }

    function _request(uint128 amount) internal view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: PAYEE,
            capabilityId: CAPABILITY,
            inputCommit: keccak256("e2e input"),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    /// A funded mandate pays the registered payee through the escrow, the payee releases, and the
    /// fee reaches the treasury.
    function _lanePublicSpend() internal returns (address) {
        IMandateAccount mandate = _newMandate(keccak256("e2e.public"), 0);
        MockUsdg(USDG).mint(PAYER, 20e6);
        vm.startPrank(PAYER);
        IERC20(USDG).approve(address(mandate), 20e6);
        mandate.deposit(20e6);
        uint256 id = mandate.spend(_request(1e6), new bytes32[](0));
        vm.stopPrank();

        Escrow escrow = Escrow(_at(K.ESCROW));
        assertEq(uint8(escrow.getLock(id).status), uint8(IEscrow.LockStatus.Locked));
        uint256 before = IERC20(USDG).balanceOf(PAYEE);
        vm.prank(PAYEE);
        escrow.release(id, keccak256("e2e output"), "");
        uint256 fee = (1e6 * uint256(escrow.feeBps())) / 10_000;
        assertEq(IERC20(USDG).balanceOf(PAYEE) - before, 1e6 - fee, "the payee was not paid the lock less the fee");

        address treasury = _at(K.TREASURY);
        uint256 held = IERC20(USDG).balanceOf(treasury);
        escrow.sweepFees();
        assertEq(IERC20(USDG).balanceOf(treasury) - held, fee, "the fee did not reach the treasury");
        return address(mandate);
    }

    /// The same mandate buys a stock through the pinned pool, at a price the guard checked
    /// against the feed.
    function _laneStockBuy(address mandate) internal {
        _freshFeeds();
        address spy = _asset("SPY");
        StockSpendRouter router = StockSpendRouter(_at(K.STOCK_ROUTER));
        address[] memory assets = new address[](1);
        assets[0] = spy;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;
        vm.startPrank(PAYER);
        IMandateAccount(mandate).setRouter(address(router));
        router.setPolicy(mandate, 100, assets, allowed);
        vm.stopPrank();

        uint256 quote = PriceGuard(_at(K.PRICE_GUARD)).tradePrice(spy, mandate);
        vm.prank(PAYER);
        uint256 out = IMandateAccount(mandate).buy(spy, 2e6, 0, quote);
        assertGt(out, 0, "the purchase delivered nothing");
        assertEq(IERC20(spy).balanceOf(mandate), out, "the stock did not reach the mandate");
    }

    /// USDG above the buffer goes into the treasury fund and comes back out to the mandate.
    function _lanePark(address mandate) internal {
        _freshFeeds();
        TreasuryPark park = TreasuryPark(_at(K.TREASURY_PARK));
        address adapter = _at(K.SGOV_ADAPTER);
        vm.startPrank(PAYER);
        IMandateAccount(mandate).setTreasuryPark(address(park));
        IMandateAccount(mandate).withdraw(USDG, park.vaultOf(mandate), 5e6);
        uint256 raw = park.park(mandate, adapter, 5e6, 0);
        vm.stopPrank();
        assertGt(raw, 0, "nothing was parked");
        (uint256 held,, uint256 value,,, bool fresh) = park.position(mandate, adapter);
        assertEq(held, raw);
        assertTrue(fresh, "the parked position reads stale");
        assertApproxEqRel(value, 5e6, 0.02e18, "the parked value is far from what went in");

        uint256 before = IERC20(USDG).balanceOf(mandate);
        vm.prank(PAYER);
        uint256 back = park.unpark(mandate, adapter, raw, 0);
        assertApproxEqRel(back, 5e6, 0.02e18, "unparking returned far less than was parked");
        assertEq(IERC20(USDG).balanceOf(mandate), before + back);
    }

    /// A draw counts a holding only against an observation of its pool that has aged, so the
    /// keeper's two calls are made first, five minutes apart.
    function _observe(address asset) internal {
        PriceGuard guard = PriceGuard(_at(K.PRICE_GUARD));
        guard.observe(asset);
        vm.warp(block.timestamp + guard.MIN_OBSERVATION_AGE());
        _freshFeeds();
        guard.observe(asset);
    }

    /// A mandate that holds no USDG spends on credit against posted stock and repays.
    function _laneCollateral() internal {
        _freshFeeds();
        _observe(_asset("SPY"));
        CollateralVault vault = CollateralVault(_at(K.COLLATERAL_VAULT));
        CreditPool pool = CreditPool(_at(K.CREDIT_POOL));
        address lender = _at(K.LENDER);
        MockUsdg(USDG).mint(lender, 50e6);
        vm.startPrank(lender);
        IERC20(USDG).approve(address(pool), 50e6);
        pool.fund(50e6);
        vm.stopPrank();

        IMandateAccount mandate = _newMandate(keccak256("e2e.collateral"), vault.COLLATERAL_LANE());
        MockStock spy = MockStock(_asset("SPY"));
        spy.mint(PAYER, 1e17);
        vm.startPrank(PAYER);
        mandate.setTreasuryPark(address(vault));
        vault.openLine(address(mandate));
        spy.approve(address(vault), 1e17);
        vault.deposit(address(mandate), address(spy), 1e17);
        uint256 id = mandate.spend(_request(2e6), new bytes32[](0));
        vm.stopPrank();

        assertEq(Escrow(_at(K.ESCROW)).getLock(id).amount, 2e6);
        uint256 debt = pool.debtOf(address(mandate));
        assertGe(debt, 2e6, "the spend was not drawn on credit");
        assertGt(vault.health(address(mandate)), 1.25e18, "the line is below its borrowing floor");

        MockUsdg(USDG).mint(PAYER, debt + 1);
        vm.startPrank(PAYER);
        IERC20(USDG).approve(address(pool), debt + 1);
        pool.repay(address(mandate), debt + 1);
        vm.stopPrank();
        assertEq(pool.debtOf(address(mandate)), 0, "the line still owes after repayment");
    }

    /// Two deposits, a root from the postman, a relayed withdrawal to a fresh recipient, and a
    /// ragequit back to the depositor, with proofs made for this pool.
    function _laneShielded() internal {
        string memory fixture = vm.readFile("test/script/fixtures/shielded-e2e.json");
        address pool = _at(K.SHIELDED_POOL);
        address relay = _at(K.SHIELDED_RELAY);
        assertEq(pool, fixture.readAddress(".pool"), "the shielded pool is not where the proofs were made for");
        assertEq(relay, fixture.readAddress(".relay"), "the relay is not where the proofs were made for");
        IShieldedEntrypoint entrypoint = IShieldedEntrypoint(_at(K.ENTRYPOINT));

        _deposit(entrypoint, ALICE, fixture, ".deposit1");
        _deposit(entrypoint, BOB, fixture, ".deposit2");

        uint256[] memory signals = fixture.readUintArray(".relayed.pubSignals");
        vm.prank(_at(K.ASP_POSTMAN));
        entrypoint.updateRoot(signals[5], "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");

        address recipient = fixture.readAddress(".recipient");
        address feeRecipient = fixture.readAddress(".feeRecipient");
        uint256 withdrawn = fixture.readUint(".withdrawn");
        uint256 fee = (withdrawn * fixture.readUint(".relayFeeBps")) / 10_000;
        vm.prank(RELAYER);
        IShieldedRelay(relay)
            .relay(Withdrawal({processooor: relay, data: fixture.readBytes(".relayData")}), _withdrawProof(fixture));
        assertEq(IERC20(USDG).balanceOf(recipient), withdrawn - fee, "the recipient was not paid");
        assertEq(IERC20(USDG).balanceOf(feeRecipient), fee, "the relayer's fee was not paid");

        uint256 before = IERC20(USDG).balanceOf(BOB);
        vm.prank(BOB);
        IShieldedPool(pool).ragequit(_ragequitProof(fixture));
        assertEq(
            IERC20(USDG).balanceOf(BOB) - before,
            fixture.readUint(".deposit2.value"),
            "ragequit did not return the note"
        );
    }

    function _deposit(IShieldedEntrypoint entrypoint, address who, string memory fixture, string memory key) internal {
        uint256 gross = fixture.readUint(string.concat(key, ".gross"));
        MockUsdg(USDG).mint(who, gross);
        vm.startPrank(who);
        IERC20(USDG).approve(address(entrypoint), gross);
        uint256 commitment = entrypoint.deposit(USDG, gross, fixture.readUint(string.concat(key, ".precommitment")));
        vm.stopPrank();
        assertEq(
            commitment, fixture.readUint(string.concat(key, ".commitment")), "the deposit committed to another note"
        );
    }

    function _withdrawProof(string memory fixture) internal pure returns (WithdrawProof memory p) {
        uint256[] memory a = fixture.readUintArray(".relayed.pA");
        uint256[] memory b0 = fixture.readUintArray(".relayed.pB[0]");
        uint256[] memory b1 = fixture.readUintArray(".relayed.pB[1]");
        uint256[] memory c = fixture.readUintArray(".relayed.pC");
        uint256[] memory s = fixture.readUintArray(".relayed.pubSignals");
        p.pA = [a[0], a[1]];
        p.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.pC = [c[0], c[1]];
        for (uint256 i; i < 8; ++i) {
            p.pubSignals[i] = s[i];
        }
    }

    function _ragequitProof(string memory fixture) internal pure returns (RagequitProof memory p) {
        uint256[] memory a = fixture.readUintArray(".ragequit.pA");
        uint256[] memory b0 = fixture.readUintArray(".ragequit.pB[0]");
        uint256[] memory b1 = fixture.readUintArray(".ragequit.pB[1]");
        uint256[] memory c = fixture.readUintArray(".ragequit.pC");
        uint256[] memory s = fixture.readUintArray(".ragequit.pubSignals");
        p.pA = [a[0], a[1]];
        p.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.pC = [c[0], c[1]];
        for (uint256 i; i < 4; ++i) {
            p.pubSignals[i] = s[i];
        }
    }

    /// A committed mandate on this deployment's escrow and verifier spends with a proof. The proof
    /// binds the account's address, so the account is placed where the fixture says, and the clock
    /// is set to the moment the proof was made.
    function _laneCommitted() internal {
        string memory fixture = vm.readFile("test/fixtures/within_mandate.json");
        address account = fixture.readAddress(".mandate");
        address payee = address(0xbeef01);
        _registerPayee(payee, "e2e_committed_payee");

        deployCodeTo(
            "CommittedMandateAccount.sol:CommittedMandateAccount",
            abi.encode(
                PAYER,
                PAYER,
                USDG,
                _at(K.ESCROW),
                _at(K.VERIFIER),
                fixture.readUint(".termsCommitment"),
                fixture.readUint(".counter"),
                json.readUint(".parameters.CommittedMandateFactory.ceiling")
            ),
            account
        );
        CommittedMandateAccount(account).sealInitial(hex"c1f3");
        MockUsdg(USDG).mint(account, 1e6);

        CommittedMandateAccount.Spend memory s = CommittedMandateAccount.Spend({
            payee: payee,
            capabilityId: fixture.readBytes32(".spend1.capabilityId"),
            inputCommit: keccak256("input"),
            inputURI: "",
            amount: uint128(fixture.readUint(".spend1.amount")),
            deadline: 0,
            provenAt: uint64(fixture.readUint(".spend1.provenAt")),
            newCounter: fixture.readUint(".spend1.newCounter"),
            nullifier: fixture.readUint(".spend1.nullifier")
        });
        vm.warp(s.provenAt - 30);
        s.deadline = uint64(block.timestamp + 1 days);
        uint256[] memory a = fixture.readUintArray(".spend1.a");
        uint256[] memory b0 = fixture.readUintArray(".spend1.b[0]");
        uint256[] memory b1 = fixture.readUintArray(".spend1.b[1]");
        uint256[] memory c = fixture.readUintArray(".spend1.c");
        CommittedMandateAccount.Proof memory proof =
            CommittedMandateAccount.Proof({a: [a[0], a[1]], b: [[b0[0], b0[1]], [b1[0], b1[1]]], c: [c[0], c[1]]});

        vm.prank(PAYER);
        uint256 id = CommittedMandateAccount(account).spend(s, proof);
        IEscrow.Lock memory lock = Escrow(_at(K.ESCROW)).getLock(id);
        assertEq(lock.payer, account);
        assertEq(lock.payee, payee);
        assertEq(lock.amount, s.amount);
        assertTrue(CommittedMandateAccount(account).nullifierUsed(s.nullifier), "the proof's nullifier is not spent");
    }
}
