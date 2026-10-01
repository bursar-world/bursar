// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {LocalPoolManager} from "../../script/local/LocalPoolManager.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {MandateAccountFactory} from "../../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../../src/interfaces/IMandateAccount.sol";
import {IMandateAccountFactory} from "../../src/interfaces/IMandateAccountFactory.sol";
import {AssetRegistry} from "../../src/rwa/AssetRegistry.sol";
import {PriceGuard} from "../../src/rwa/PriceGuard.sol";
import {TreasuryPark} from "../../src/rwa/TreasuryPark.sol";
import {RobinhoodStockAdapter} from "../../src/rwa/adapters/RobinhoodStockAdapter.sol";
import {UsdgAdapter} from "../../src/rwa/adapters/UsdgAdapter.sol";
import {IAccessRegistry, IStateView} from "../../src/rwa/interfaces/IRwaExternal.sol";
import {IParkAsset} from "../../src/rwa/interfaces/IParkAsset.sol";
import {IPoolManager, PoolKey} from "../../src/token/Buyback.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FakeMandate, MockAccess, MockEscrow, MockFeed, MockStock} from "./RwaMocks.sol";

/// Everything the handler needs to drive the lane, carried as one struct because the argument
/// list is past the point where positional constructor arguments decode.
struct ParkWiring {
    TreasuryPark park;
    RobinhoodStockAdapter sgovAdapter;
    UsdgAdapter usdgAdapter;
    LocalPoolManager manager;
    MockFeed feed;
    MockAccess access;
    MockEscrow escrow;
    address admin;
    address agent;
    address merchant;
    address[] mandates;
    address[] impostors;
    address[] strangers;
}

/// Random but legal traffic through the treasury lane: principals fund mandates, move USDG to
/// their vaults and back, park into SGOV and into the USDG reserve, unpark by hand, and spend
/// so a short mandate unparks inside the spend; strangers and look-alike mandates try every
/// move; governance disables adapters, delists the asset, lowers its caps and hands the seat
/// over; the feed and the pool drift, the pool wanders out of its band, the issuer pauses the
/// token or its oracle, the access registry pauses or blocks a mandate; and hours to days pass,
/// long enough for the feed to go stale for trading and then for valuation.
///
/// Every action swallows its own revert. A park or unpark can be refused for a market reason the
/// handler does not re-derive (a stale feed, a paused token, a pool outside its band), so the
/// handler judges only the rules the park itself owns and records what happened when a move
/// landed; the drain at the end of every run proves the exits still work under whatever
/// governance switched off. Counters carry the findings out.
contract TreasuryParkHandler is CommonBase, StdUtils {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SGOV_E8 = 101_17856966;
    bytes32 internal constant CAPABILITY = keccak256("service:gpu.render:1");

    /// Why a park has to be refused by the park's own rules, or that it does not.
    enum ParkVerdict {
        Fine,
        Stranger,
        Disabled,
        VaultShort,
        Buffer,
        Cap
    }

    /// One position and the balances around it, read before a call.
    struct Snap {
        uint256 raw;
        uint256 basis;
        uint256 vault;
        uint256 total;
        uint256 held;
    }

    TreasuryPark public immutable park;
    RobinhoodStockAdapter public immutable sgovAdapter;
    UsdgAdapter public immutable usdgAdapter;
    AssetRegistry public immutable registry;
    LocalPoolManager public immutable manager;
    MockERC20 public immutable usdg;
    MockStock public immutable sgov;
    MockFeed public immutable feed;
    MockAccess public immutable access;
    MockEscrow public immutable escrow;
    address public immutable principal;
    address public immutable agent;
    address public immutable merchant;

    /// The park's seat, as the handler believes it to be; it moves by offer and acceptance. The
    /// registry's admin is the deployment's and does not move here.
    address public admin;
    address public immutable registryAdmin;
    address[] public mandates;
    /// A contract that only answers `principal()` and `agent()`, and a real account the factory
    /// never made. Neither may park.
    address[] public impostors;
    address[] public strangers;
    address[] public adapters;

    mapping(address mandate => uint256) public funded;
    mapping(address mandate => uint256) public spent;
    mapping(address mandate => uint256) public withdrawn;
    /// USDG that came back from the adapters to the mandate, by hand or inside a spend.
    mapping(address mandate => uint256) public cameBack;
    mapping(address mandate => mapping(address adapter => uint256)) public parkedIn;
    /// Whether governance ever lowered a cap under what was already parked, which leaves a
    /// position legitimately above it.
    bool public capsLowered;

    uint256 public parks;
    uint256 public unparks;

    /// A park that landed past a cap or under the buffer, a move by someone other than the
    /// mandate's own operators or from an account no factory made, an unpark that paid more than
    /// the position was worth, a move whose figures disagree with what moved, a seat taken
    /// unoffered, and a call inside every rule that was refused. All asserted to be zero.
    uint256 public capBreaks;
    uint256 public bufferBreaks;
    uint256 public authBreaks;
    uint256 public yieldBreaks;
    uint256 public bookBreaks;
    uint256 public seatBreaks;
    uint256 public refusals;

    constructor(ParkWiring memory wiring) {
        park = wiring.park;
        sgovAdapter = wiring.sgovAdapter;
        usdgAdapter = wiring.usdgAdapter;
        registry = wiring.sgovAdapter.registry();
        registryAdmin = registry.admin();
        manager = wiring.manager;
        usdg = MockERC20(address(wiring.park.usdg()));
        sgov = MockStock(wiring.sgovAdapter.asset());
        feed = wiring.feed;
        access = wiring.access;
        escrow = wiring.escrow;
        principal = MandateAccount(wiring.mandates[0]).principal();
        agent = wiring.agent;
        merchant = wiring.merchant;
        admin = wiring.admin;
        mandates = wiring.mandates;
        impostors = wiring.impostors;
        strangers = wiring.strangers;
        adapters.push(address(wiring.sgovAdapter));
        adapters.push(address(wiring.usdgAdapter));
        for (uint256 i; i < wiring.mandates.length; ++i) {
            funded[wiring.mandates[i]] = usdg.balanceOf(wiring.mandates[i]);
        }
    }

    function fund(uint256 who, uint256 amount) external {
        address mandate = _mandate(who);
        amount = bound(amount, 1e6, 100e6);
        usdg.mint(mandate, amount);
        funded[mandate] += amount;
    }

    /// The principal moves USDG from the mandate to its vault, which is how a park is paid for.
    function moveToVault(uint256 who, uint256 amount) external {
        MandateAccount mandate = MandateAccount(_mandate(who));
        uint256 held = usdg.balanceOf(address(mandate));
        if (held == 0) return;
        amount = bound(amount, 1, held);
        // Read before the prank: a prank binds to the next call the handler makes, and a view
        // call inside the argument list would spend it.
        address vault = park.vaultOf(address(mandate));

        vm.prank(principal);
        mandate.withdraw(address(usdg), vault, amount);
    }

    function withdrawFromMandate(uint256 who, uint256 amount) external {
        MandateAccount mandate = MandateAccount(_mandate(who));
        uint256 held = usdg.balanceOf(address(mandate));
        if (held == 0) return;
        amount = bound(amount, 1, held);

        vm.prank(principal);
        mandate.withdraw(address(usdg), principal, amount);
        withdrawn[address(mandate)] += amount;
    }

    /// Parks from the vault, as the principal or the agent. The park's own rules are judged
    /// here: the vault has to hold the amount, the mandate has to keep its buffer, both caps
    /// have to hold and the adapter has to be enabled. A market refusal is the adapter's to make.
    function parkFunds(uint256 who, bool intoSgov, uint256 amountSeed, bool asAgent) external {
        address mandate = _mandate(who);
        address adapter = intoSgov ? address(sgovAdapter) : address(usdgAdapter);
        uint256 amount = bound(amountSeed, 1e6, 60e6);
        _park(mandate, adapter, amount, asAgent ? agent : principal);
    }

    function parkAsStranger(uint256 who, bool intoSgov, uint256 amountSeed) external {
        _park(
            _mandate(who),
            intoSgov ? address(sgovAdapter) : address(usdgAdapter),
            bound(amountSeed, 1e6, 60e6),
            _stranger(who)
        );
    }

    /// A look-alike with USDG in the vault the park would compute for it. Anything that answers
    /// `principal()` could otherwise book against the caps every mandate shares.
    function parkAsImpostor(uint256 who, bool intoSgov, uint256 amountSeed) external {
        address impostor = impostors[who % impostors.length];
        address adapter = intoSgov ? address(sgovAdapter) : address(usdgAdapter);
        uint256 amount = bound(amountSeed, 1e6, 10e6);
        usdg.mint(park.vaultOf(impostor), amount);

        vm.prank(principal);
        try park.park(impostor, adapter, amount, 0) returns (uint256) {
            authBreaks += 1;
        } catch {}
    }

    /// Sells part or all of a position back to USDG, delivered to the mandate. One call in eight
    /// asks for more than the position holds.
    function unparkFunds(uint256 who, bool fromSgov, uint256 rawSeed, bool asAgent) external {
        address mandate = _mandate(who);
        address adapter = fromSgov ? address(sgovAdapter) : address(usdgAdapter);
        (uint256 raw,,,,,) = park.position(mandate, adapter);
        uint256 ask = raw == 0 || rawSeed % 8 == 0 ? raw + 1 : bound(rawSeed, 1, raw);
        _unpark(mandate, adapter, ask, asAgent ? agent : principal);
    }

    function unparkAsStranger(uint256 who, bool fromSgov, uint256 rawSeed) external {
        address mandate = _mandate(who);
        address adapter = fromSgov ? address(sgovAdapter) : address(usdgAdapter);
        (uint256 raw,,,,,) = park.position(mandate, adapter);
        if (raw == 0) return;
        _unpark(mandate, adapter, bound(rawSeed, 1, raw), _stranger(who));
    }

    /// The agent spends. A mandate short of USDG asks the park for the difference inside the
    /// spend, and whatever came back is held to what the positions it sold were worth.
    function spend(uint256 who, uint256 amountSeed) external {
        MandateAccount mandate = MandateAccount(_mandate(who));
        uint128 amount = uint128(bound(amountSeed, 1e6, 30e6));
        uint256 before = usdg.balanceOf(address(mandate));
        uint256[2] memory rawBefore = _raws(address(mandate));

        vm.prank(agent);
        try mandate.spend(_request(amount), new bytes32[](0)) returns (uint256) {
            spent[address(mandate)] += amount;
            uint256 returned = usdg.balanceOf(address(mandate)) + amount - before;
            cameBack[address(mandate)] += returned;
            if (returned > _worthSold(address(mandate), rawBefore)) yieldBreaks += 1;
        } catch {}
    }

    function returnIdle(uint256 who, bool asStranger, bool asAgent) external {
        address mandate = _mandate(who);
        uint256 idle = usdg.balanceOf(park.vaultOf(mandate));
        uint256 before = usdg.balanceOf(mandate);

        vm.prank(asStranger ? _stranger(who) : asAgent ? agent : principal);
        try park.returnIdle(mandate) {
            if (asStranger) authBreaks += 1;
            if (usdg.balanceOf(mandate) != before + idle || idle == 0) bookBreaks += 1;
        } catch {
            if (!asStranger && idle != 0) refusals += 1;
        }
    }

    function setBuffer(uint256 who, uint256 amount, bool asStranger) external {
        address mandate = _mandate(who);
        vm.prank(asStranger ? _stranger(who) : principal);
        try park.setBuffer(mandate, uint128(bound(amount, 0, 150e6))) {
            if (asStranger) authBreaks += 1;
        } catch {
            if (!asStranger) refusals += 1;
        }
    }

    /// Governance switches: an adapter off or on, the asset delisted or relisted, its caps
    /// lowered. None of them may close an exit. The park's seat can move during a run; the
    /// registry's stays with the deployment's admin, so each is asked as its own admin.
    function govern(uint256 which, uint256 seed, bool on) external {
        uint256 choice = which % 3;
        if (choice == 0) {
            vm.prank(admin);
            park.setAdapter(adapters[seed % adapters.length], on);
        } else if (choice == 1) {
            vm.prank(registryAdmin);
            registry.setEligible(address(sgov), on);
        } else {
            AssetRegistry.Asset memory a = registry.get(address(sgov));
            a.perMandateCap = uint128(bound(seed, 10e6, 100e6));
            a.totalCap = uint128(bound(seed >> 128, a.perMandateCap, 1_000e6));
            vm.prank(registryAdmin);
            registry.setAsset(address(sgov), a);
            capsLowered = true;
        }
    }

    function governAsStranger(uint256 who, uint256 which) external {
        address stranger = _stranger(who);
        if (stranger == admin || stranger == registryAdmin) return;
        vm.prank(stranger);
        (bool ok,) = which % 2 == 0
            ? address(park).call(abi.encodeCall(TreasuryPark.setAdapter, (address(usdgAdapter), false)))
            : address(registry).call(abi.encodeCall(AssetRegistry.setEligible, (address(sgov), false)));
        if (ok) authBreaks += 1;
    }

    /// The feed moves up to five percent either way and the pool follows it, or in one move in
    /// four wanders a full percent off it, outside the band, so trades are refused and parked
    /// value stops counting until the two agree again.
    function movePrice(uint256 seed) external {
        uint256 price = SGOV_E8 * bound(seed, 9_500, 10_500) / BPS;
        feed.set(int256(price), block.timestamp);
        uint256 poolPrice = seed % 4 == 0 ? price * 10_100 / BPS : price;
        _setPool(poolPrice);
    }

    /// The issuer's and the access registry's controls, on and off.
    function throttle(uint256 which, uint256 who, bool on) external {
        uint256 choice = which % 4;
        if (choice == 0) sgov.setOraclePaused(on);
        else if (choice == 1) sgov.setTokenPaused(on);
        else if (choice == 2) access.setPaused(on);
        else access.setBlocked(_mandate(who), on);
    }

    function offerSeat(uint256 who) external {
        vm.prank(admin);
        try park.transferAdmin(_stranger(who)) {} catch {}
        if (park.admin() != admin) seatBreaks += 1;
    }

    function takeSeat(uint256 who) external {
        address taker = _stranger(who);
        address offered = park.pendingAdmin();
        vm.prank(taker);
        try park.acceptAdmin() {
            if (taker != offered) seatBreaks += 1;
            admin = taker;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 3 days));
    }

    /// Puts the market back where a park can land and parks once into the reserve, for a run
    /// that never parked and would otherwise prove nothing about the lane. Expected to land.
    function drivePark() external {
        _restoreMarket();
        address mandate;
        for (uint256 i; i < mandates.length; ++i) {
            (, uint256 basis,,,,) = park.position(mandates[i], address(usdgAdapter));
            if (basis + 1e6 <= 100e6) {
                mandate = mandates[i];
                break;
            }
        }
        if (mandate == address(0)) return;

        if (!park.isAdapter(address(usdgAdapter))) {
            vm.prank(admin);
            park.setAdapter(address(usdgAdapter), true);
        }
        vm.prank(principal);
        park.setBuffer(mandate, 0);
        usdg.mint(mandate, 1e6);
        funded[mandate] += 1e6;
        address vault = park.vaultOf(mandate);
        vm.prank(principal);
        MandateAccount(mandate).withdraw(address(usdg), vault, 1e6);
        _park(mandate, address(usdgAdapter), 1e6, principal);
    }

    /// Puts the market back, leaves every governance switch where the run left it, and takes
    /// every position and every idle balance back to its mandate. Expected to land on every
    /// position: the money in an adapter governance disabled or an asset it delisted is still
    /// the mandate's.
    function drain() external {
        _restoreMarket();
        for (uint256 i; i < mandates.length; ++i) {
            for (uint256 j; j < adapters.length; ++j) {
                (uint256 raw,,,,,) = park.position(mandates[i], adapters[j]);
                if (raw == 0) continue;
                vm.prank(principal);
                uint256 usdgOut = park.unpark(mandates[i], adapters[j], raw, 0);
                unparks += 1;
                cameBack[mandates[i]] += usdgOut;
                if (usdgOut > _worth(adapters[j], raw)) yieldBreaks += 1;
            }
            if (usdg.balanceOf(park.vaultOf(mandates[i])) != 0) {
                vm.prank(principal);
                park.returnIdle(mandates[i]);
            }
        }
    }

    function mandateCount() external view returns (uint256) {
        return mandates.length;
    }

    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    /// Whether SGOV counts toward spending power right now, by the mocks' own state rather than
    /// the guard's answer: a fresh feed, the token and its oracle and the access registry
    /// unpaused, and the pool inside the band.
    function sgovCounts() external view returns (bool) {
        AssetRegistry.Asset memory a = registry.get(address(sgov));
        uint256 price = uint256(feed.answer());
        if (price == 0 || block.timestamp - feed.updatedAt() > a.valuationStaleness) return false;
        if (sgov.oraclePaused() || sgov.tokenPaused() || access.paused()) return false;
        uint256 pool = _poolPriceE8(a);
        uint256 gap = pool > price ? pool - price : price - pool;
        return pool != 0 && Math.mulDiv(gap, BPS, price, Math.Rounding.Ceil) <= a.bandBps;
    }

    function _park(address mandate, address adapter, uint256 amount, address caller) private {
        ParkVerdict verdict = _parkVerdict(mandate, adapter, amount, caller);
        Snap memory before = _snap(mandate, adapter);

        vm.prank(caller);
        try park.park(mandate, adapter, amount, 0) returns (uint256 rawOut) {
            parks += 1;
            parkedIn[mandate][adapter] += amount;
            _chargePark(verdict);
            Snap memory after_ = _snap(mandate, adapter);
            if (
                after_.raw != before.raw + rawOut || after_.basis != before.basis + amount
                    || after_.total != before.total + amount || after_.vault != before.vault - amount
                    || after_.held != before.held + rawOut
            ) bookBreaks += 1;
        } catch {}
    }

    /// The rules the park owns, in the order it checks them. The adapter's market rules are
    /// not re-derived here.
    function _parkVerdict(address mandate, address adapter, uint256 amount, address caller)
        private
        view
        returns (ParkVerdict)
    {
        if (caller != principal && caller != agent) return ParkVerdict.Stranger;
        if (!park.isAdapter(adapter)) return ParkVerdict.Disabled;
        if (usdg.balanceOf(park.vaultOf(mandate)) < amount) return ParkVerdict.VaultShort;
        if (usdg.balanceOf(mandate) < park.buffer(mandate)) return ParkVerdict.Buffer;
        (, uint256 basis,,,,) = park.position(mandate, adapter);
        (uint128 perMandate, uint128 total) = IParkAsset(adapter).caps();
        if (basis + amount > perMandate || park.totalBasis(adapter) + amount > total) return ParkVerdict.Cap;
        return ParkVerdict.Fine;
    }

    function _chargePark(ParkVerdict verdict) private {
        if (verdict == ParkVerdict.Stranger || verdict == ParkVerdict.Disabled) authBreaks += 1;
        else if (verdict == ParkVerdict.VaultShort) bookBreaks += 1;
        else if (verdict == ParkVerdict.Buffer) bufferBreaks += 1;
        else if (verdict == ParkVerdict.Cap) capBreaks += 1;
    }

    function _unpark(address mandate, address adapter, uint256 raw, address caller) private {
        Snap memory before = _snap(mandate, adapter);
        uint256 held = usdg.balanceOf(mandate);
        bool legal = (caller == principal || caller == agent) && raw != 0 && raw <= before.raw;

        vm.prank(caller);
        try park.unpark(mandate, adapter, raw, 0) returns (uint256 usdgOut) {
            unparks += 1;
            cameBack[mandate] += usdgOut;
            if (!legal) {
                if (caller != principal && caller != agent) authBreaks += 1;
                else bookBreaks += 1;
            }
            if (usdgOut > _worth(adapter, raw) || usdg.balanceOf(mandate) != held + usdgOut) yieldBreaks += 1;
            _checkCut(mandate, adapter, raw, before);
        } catch {
            if (legal && caller == principal && _marketOpen()) refusals += 1;
        }
    }

    /// The basis comes off in the position's own proportion, rounded against the mandate, and
    /// the adapter's total moves by the same cut.
    function _checkCut(address mandate, address adapter, uint256 raw, Snap memory before) private {
        Snap memory after_ = _snap(mandate, adapter);
        uint256 cut = Math.mulDiv(before.basis, raw, before.raw, Math.Rounding.Ceil);
        if (cut > before.basis) cut = before.basis;
        if (after_.raw != before.raw - raw || after_.basis != before.basis - cut || after_.total != before.total - cut)
        {
            bookBreaks += 1;
        }
    }

    function _snap(address mandate, address adapter) private view returns (Snap memory snap) {
        (snap.raw, snap.basis,,,,) = park.position(mandate, adapter);
        snap.vault = usdg.balanceOf(park.vaultOf(mandate));
        snap.total = park.totalBasis(adapter);
        snap.held = IERC20(IParkAsset(adapter).asset()).balanceOf(adapter);
    }

    /// The most `raw` of an adapter's asset can be worth in USDG: the feed value plus the band a
    /// fill may land inside, plus a unit for rounding. The reserve is worth exactly itself.
    function _worth(address adapter, uint256 raw) private view returns (uint256) {
        if (adapter == address(usdgAdapter)) return raw;
        AssetRegistry.Asset memory a = registry.get(address(sgov));
        uint256 atFeed = Math.mulDiv(raw, uint256(feed.answer()), 10 ** (uint256(a.decimals) + 2));
        return Math.mulDiv(atFeed, BPS + a.bandBps, BPS) + 1;
    }

    function _worthSold(address mandate, uint256[2] memory rawBefore) private view returns (uint256 worth) {
        for (uint256 j; j < adapters.length; ++j) {
            (uint256 raw,,,,,) = park.position(mandate, adapters[j]);
            if (rawBefore[j] > raw) worth += _worth(adapters[j], rawBefore[j] - raw);
        }
    }

    function _raws(address mandate) private view returns (uint256[2] memory raws) {
        for (uint256 j; j < adapters.length; ++j) {
            (raws[j],,,,,) = park.position(mandate, adapters[j]);
        }
    }

    /// Whether the drain's market, where nothing refuses a trade, is in force.
    function _marketOpen() private view returns (bool) {
        return !sgov.oraclePaused() && !sgov.tokenPaused() && !access.paused() && feed.updatedAt() == block.timestamp
            && uint256(feed.answer()) == SGOV_E8 && _poolPriceE8(registry.get(address(sgov))) == _midOf(SGOV_E8);
    }

    function _restoreMarket() private {
        sgov.setOraclePaused(false);
        sgov.setTokenPaused(false);
        access.setPaused(false);
        for (uint256 i; i < mandates.length; ++i) {
            access.setBlocked(mandates[i], false);
        }
        feed.set(int256(SGOV_E8), block.timestamp);
        _setPool(SGOV_E8);
    }

    function _setPool(uint256 priceE8) private {
        PoolKey memory key = registry.get(address(sgov)).pool;
        bool sgovIs0 = key.currency0 == address(sgov);
        uint256 ratio = sgovIs0 ? Math.mulDiv(priceE8, 1 << 192, 1e20) : Math.mulDiv(1e20, 1 << 192, priceE8);
        manager.setPrice(key, uint160(Math.sqrt(ratio)));
    }

    function _poolPriceE8(AssetRegistry.Asset memory a) private view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(keccak256(abi.encode(a.pool)));
        return sgovAdapter.guard().midE8(sqrtPriceX96, a.pool.currency0 == address(sgov), a.decimals);
    }

    /// The mid the pool reads back after `_setPool(priceE8)`, which rounds through the square root.
    function _midOf(uint256 priceE8) private view returns (uint256) {
        AssetRegistry.Asset memory a = registry.get(address(sgov));
        bool sgovIs0 = a.pool.currency0 == address(sgov);
        uint256 ratio = sgovIs0 ? Math.mulDiv(priceE8, 1 << 192, 1e20) : Math.mulDiv(1e20, 1 << 192, priceE8);
        return sgovAdapter.guard().midE8(uint160(Math.sqrt(ratio)), sgovIs0, a.decimals);
    }

    function _request(uint128 amount) private view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant,
            capabilityId: CAPABILITY,
            inputCommit: bytes32(0),
            inputURI: "",
            amount: amount,
            deadline: uint64(block.timestamp + 1 hours),
            spendClass: 0
        });
    }

    function _mandate(uint256 seed) private view returns (address) {
        return mandates[seed % mandates.length];
    }

    function _stranger(uint256 seed) private view returns (address) {
        return strangers[seed % strangers.length];
    }
}

/// The treasury lane under any sequence of the calls above: every adapter holds exactly the
/// positions it carries, every unit of a mandate's USDG is on the mandate, in its vault, parked,
/// spent or withdrawn, no park lands past a cap or under the buffer, only a mandate's own
/// operators move its money and only a factory's accounts may park, an unpark never pays more
/// than the position is worth, stale or paused positions count for nothing, and whatever
/// governance switches off, every position comes back out.
contract TreasuryParkInvariantTest is Test {
    uint256 internal constant SGOV_E8 = 101_17856966;
    uint32 internal constant H26 = 26 hours;
    uint32 internal constant H100 = 100 hours;

    MockERC20 internal usdg;
    MockStock internal sgov;
    MockFeed internal sgovFeed;
    MockAccess internal access;
    LocalPoolManager internal manager;
    MockEscrow internal escrow;
    AssetRegistry internal registry;
    PriceGuard internal guard;
    TreasuryPark internal park;
    RobinhoodStockAdapter internal sgovAdapter;
    UsdgAdapter internal usdgAdapter;
    MandateAccountFactory internal factory;
    TreasuryParkHandler internal handler;

    address internal principal = makeAddr("principal");
    address internal agent = makeAddr("agent");
    address internal admin = makeAddr("timelock");
    address internal merchant = makeAddr("merchant");
    address[] internal mandates;
    address[] internal holders;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdg = new MockERC20();
        sgov = new MockStock("SGOV");
        sgovFeed = new MockFeed();
        sgovFeed.set(int256(SGOV_E8), block.timestamp);
        access = new MockAccess();
        manager = new LocalPoolManager();
        escrow = new MockEscrow(IERC20(address(usdg)));

        (address c0, address c1) =
            address(sgov) < address(usdg) ? (address(sgov), address(usdg)) : (address(usdg), address(sgov));
        PoolKey memory pool = PoolKey({currency0: c0, currency1: c1, fee: 375, tickSpacing: 4, hooks: address(0)});
        uint256 ratio =
            c0 == address(sgov) ? Math.mulDiv(SGOV_E8, 1 << 192, 1e20) : Math.mulDiv(1e20, 1 << 192, SGOV_E8);
        manager.setPrice(pool, uint160(Math.sqrt(ratio)));
        usdg.mint(address(manager), 1_000_000_000e6);
        sgov.mint(address(manager), 1_000_000_000e18);

        address[] memory assets = new address[](1);
        AssetRegistry.Asset[] memory configs = new AssetRegistry.Asset[](1);
        assets[0] = address(sgov);
        configs[0] = AssetRegistry.Asset({
            feed: address(sgovFeed),
            tradeStaleness: H26,
            valuationStaleness: H100,
            bandBps: 50,
            haircutBps: 50,
            collateralHaircutBps: 0,
            decimals: 0,
            eligible: true,
            isStock: false,
            isTreasury: true,
            perTradeCap: 25e6,
            perMandateCap: 100e6,
            totalCap: 1_000e6,
            pool: pool
        });
        registry = new AssetRegistry(admin, address(usdg), assets, configs);
        guard = new PriceGuard(registry, IAccessRegistry(address(access)), IStateView(address(manager)));

        factory = new MandateAccountFactory(address(escrow), address(usdg));
        IMandateAccountFactory[] memory factories = new IMandateAccountFactory[](1);
        factories[0] = IMandateAccountFactory(address(factory));
        park = new TreasuryPark(address(usdg), admin, factories);
        sgovAdapter =
            new RobinhoodStockAdapter(address(park), address(sgov), registry, guard, IPoolManager(address(manager)));
        usdgAdapter = new UsdgAdapter(address(park), address(usdg), 100e6, 1_000e6);
        address[] memory adapters = new address[](2);
        adapters[0] = address(sgovAdapter);
        adapters[1] = address(usdgAdapter);
        park.initAdapters(adapters);

        for (uint256 i; i < 3; ++i) {
            vm.prank(principal);
            address account = factory.create(principal, agent, bytes32(i), _limits());
            _wire(MandateAccount(account));
            mandates.push(account);
        }

        // A look-alike and a real account the factory never made, both funded like a mandate.
        address[] memory impostors = new address[](2);
        impostors[0] = address(new FakeMandate(principal));
        MandateAccount stray = new MandateAccount(principal, agent, address(usdg), address(escrow), _limits());
        _wire(stray);
        impostors[1] = address(stray);

        address[] memory strangers = new address[](2);
        strangers[0] = makeAddr("stranger");
        strangers[1] = makeAddr("successor");

        handler = new TreasuryParkHandler(
            ParkWiring({
                park: park,
                sgovAdapter: sgovAdapter,
                usdgAdapter: usdgAdapter,
                manager: manager,
                feed: sgovFeed,
                access: access,
                escrow: escrow,
                admin: admin,
                agent: agent,
                merchant: merchant,
                mandates: mandates,
                impostors: impostors,
                strangers: strangers
            })
        );

        for (uint256 i; i < mandates.length; ++i) {
            holders.push(mandates[i]);
            holders.push(park.vaultOf(mandates[i]));
        }
        for (uint256 i; i < impostors.length; ++i) {
            holders.push(impostors[i]);
            holders.push(park.vaultOf(impostors[i]));
        }
        holders.push(address(sgovAdapter));
        holders.push(address(usdgAdapter));
        holders.push(address(manager));
        holders.push(address(escrow));
        holders.push(principal);

        bytes4[] memory selectors = new bytes4[](22);
        selectors[0] = TreasuryParkHandler.fund.selector;
        selectors[1] = TreasuryParkHandler.moveToVault.selector;
        selectors[2] = TreasuryParkHandler.moveToVault.selector;
        selectors[3] = TreasuryParkHandler.withdrawFromMandate.selector;
        selectors[4] = TreasuryParkHandler.parkFunds.selector;
        selectors[5] = TreasuryParkHandler.parkFunds.selector;
        selectors[6] = TreasuryParkHandler.parkFunds.selector;
        selectors[7] = TreasuryParkHandler.parkAsStranger.selector;
        selectors[8] = TreasuryParkHandler.parkAsImpostor.selector;
        selectors[9] = TreasuryParkHandler.unparkFunds.selector;
        selectors[10] = TreasuryParkHandler.unparkFunds.selector;
        selectors[11] = TreasuryParkHandler.unparkAsStranger.selector;
        selectors[12] = TreasuryParkHandler.spend.selector;
        selectors[13] = TreasuryParkHandler.spend.selector;
        selectors[14] = TreasuryParkHandler.returnIdle.selector;
        selectors[15] = TreasuryParkHandler.setBuffer.selector;
        selectors[16] = TreasuryParkHandler.govern.selector;
        selectors[17] = TreasuryParkHandler.governAsStranger.selector;
        selectors[18] = TreasuryParkHandler.movePrice.selector;
        selectors[19] = TreasuryParkHandler.throttle.selector;
        selectors[20] = TreasuryParkHandler.offerSeat.selector;
        selectors[21] = TreasuryParkHandler.takeSeat.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Each adapter holds exactly the raw of every position it carries, its basis total is the
    /// sum of the positions' bases, and the reserve's raw is its basis one for one.
    function invariant_everyAdapterHoldsExactlyThePositionsItCarries() public view {
        for (uint256 j; j < handler.adapterCount(); ++j) {
            address adapter = handler.adapters(j);
            uint256 raws;
            uint256 bases;
            for (uint256 i; i < handler.mandateCount(); ++i) {
                (uint256 raw, uint256 basis,,,,) = park.position(handler.mandates(i), adapter);
                raws += raw;
                bases += basis;
                if (adapter == address(usdgAdapter)) assertEq(raw, basis, "the reserve's raw drifted from its basis");
            }
            assertEq(
                IERC20(IParkAsset(adapter).asset()).balanceOf(adapter),
                raws,
                "an adapter holds other than its positions"
            );
            assertEq(park.totalBasis(adapter), bases, "an adapter's basis total drifted from its positions");
        }
    }

    /// Every unit a mandate was funded with is on the mandate, in its vault, parked at cost,
    /// spent, or withdrawn by the principal, less what came back from the adapters.
    function invariant_usdgIsConservedPerMandate() public view {
        for (uint256 i; i < handler.mandateCount(); ++i) {
            address mandate = handler.mandates(i);
            uint256 parked;
            for (uint256 j; j < handler.adapterCount(); ++j) {
                parked += handler.parkedIn(mandate, handler.adapters(j));
            }
            assertEq(
                handler.funded(mandate) + handler.cameBack(mandate),
                usdg.balanceOf(mandate) + usdg.balanceOf(park.vaultOf(mandate)) + parked + handler.spent(mandate)
                    + handler.withdrawn(mandate),
                "a mandate's USDG left by a path other than a park, a spend or a withdrawal"
            );
        }
        assertEq(handler.bookBreaks(), 0, "a park, unpark or return moved different figures than it booked");
    }

    function invariant_theSettlementAssetIsConservedAcrossEveryHolder() public view {
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += usdg.balanceOf(holders[i]);
        }
        assertEq(sum, usdg.totalSupply(), "USDG reached an address outside the lane");
    }

    /// No position sits past its cap unless governance lowered the cap under it, no park lands
    /// past a cap in force, and no park leaves a mandate under its buffer.
    function invariant_noParkPassesACapOrDipsUnderTheBuffer() public view {
        if (!handler.capsLowered()) {
            for (uint256 j; j < handler.adapterCount(); ++j) {
                address adapter = handler.adapters(j);
                (uint128 perMandate, uint128 total) = IParkAsset(adapter).caps();
                for (uint256 i; i < handler.mandateCount(); ++i) {
                    (, uint256 basis,,,,) = park.position(handler.mandates(i), adapter);
                    assertLe(basis, perMandate, "a position sits past the mandate cap");
                }
                assertLe(park.totalBasis(adapter), total, "an adapter sits past the shared cap");
            }
        }
        assertEq(handler.capBreaks(), 0, "a park landed past a cap");
        assertEq(handler.bufferBreaks(), 0, "a park left a mandate under its buffer");
    }

    /// Only a mandate's principal or agent parks, unparks or returns its idle USDG, only its
    /// principal sets its buffer, only an account one of the factories made may park at all, and
    /// only governance switches adapters and listings.
    function invariant_onlyAMandatesOwnOperatorsMoveItsFunds() public view {
        assertEq(handler.authBreaks(), 0, "a stranger or a look-alike moved money or governed");
        for (uint256 i; i < 2; ++i) {
            address impostor = handler.impostors(i);
            for (uint256 j; j < handler.adapterCount(); ++j) {
                (uint256 raw, uint256 basis,,,,) = park.position(impostor, handler.adapters(j));
                assertEq(raw + basis, 0, "an account no factory made holds a position");
            }
        }
    }

    /// An unpark delivers to the mandate exactly what it reports, and never more than the
    /// position it sold was worth at the feed plus the band a fill may land inside.
    function invariant_anUnparkReturnsNoMoreThanThePositionIsWorth() public view {
        assertEq(handler.yieldBreaks(), 0, "an unpark paid more than the position was worth, or paid the wrong address");
    }

    /// Spending power is the mandate's USDG, its idle vault balance, the reserve at par, and
    /// SGOV after the haircut only while the feed is fresh, nothing is paused and the pool agrees
    /// with the feed. Otherwise SGOV counts for nothing.
    function invariant_spendingPowerCountsOnlyFreshPositions() public view {
        bool counts = handler.sgovCounts();
        for (uint256 i; i < handler.mandateCount(); ++i) {
            address mandate = handler.mandates(i);
            (uint256 reserve,,,,,) = park.position(mandate, address(usdgAdapter));
            (uint256 raw,,,,,) = park.position(mandate, address(sgovAdapter));
            uint256 expected = usdg.balanceOf(mandate) + usdg.balanceOf(park.vaultOf(mandate)) + reserve;
            if (counts && raw != 0) {
                (uint256 value, bool fresh) = guard.valueOf(address(sgov), raw);
                assertTrue(fresh, "the guard called a countable position stale");
                expected += Math.mulDiv(value, 10_000 - 50, 10_000);
            }
            assertEq(
                park.spendingPower(mandate), expected, "spending power counted a stale position, or missed a fresh one"
            );
        }
    }

    function invariant_theAdminSeatMovesOnlyByOfferAndAcceptance() public view {
        assertEq(park.admin(), handler.admin(), "the admin seat moved without an accepted offer");
        assertEq(handler.seatBreaks(), 0, "a stranger took the seat, or an offer moved it on its own");
        assertEq(handler.refusals(), 0, "a call inside every rule was refused");
    }

    /// Every run ends with every position sold back and every vault emptied, with the governance
    /// switches left exactly where the run put them. Nothing is stranded: the adapters hold
    /// nothing, the basis totals are zero, and every mandate holds its money again.
    function afterInvariant() public {
        if (handler.parks() == 0) handler.drivePark();
        assertGt(handler.parks(), 0, "nothing was ever parked");
        handler.drain();

        for (uint256 i; i < handler.mandateCount(); ++i) {
            address mandate = handler.mandates(i);
            assertEq(usdg.balanceOf(park.vaultOf(mandate)), 0, "USDG left in a vault");
            for (uint256 j; j < handler.adapterCount(); ++j) {
                (uint256 raw, uint256 basis,,,,) = park.position(mandate, handler.adapters(j));
                assertEq(raw + basis, 0, "a position was stranded");
            }
        }
        assertEq(sgov.balanceOf(address(sgovAdapter)), 0, "SGOV stranded on its adapter");
        assertEq(usdg.balanceOf(address(usdgAdapter)), 0, "USDG stranded on the reserve adapter");
        assertEq(
            park.totalBasis(address(sgovAdapter)) + park.totalBasis(address(usdgAdapter)), 0, "basis left standing"
        );
        invariant_usdgIsConservedPerMandate();
        invariant_anUnparkReturnsNoMoreThanThePositionIsWorth();
        invariant_theSettlementAssetIsConservedAcrossEveryHolder();
    }

    function _wire(MandateAccount account) private {
        usdg.mint(address(account), 200e6);
        vm.startPrank(principal);
        account.setTreasuryPark(address(park));
        account.setCapability(keccak256("service:gpu.render:1"), true);
        account.setMerchant(merchant, true);
        vm.stopPrank();
    }

    function _limits() private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 30e6,
            dailyCap: 100e6,
            monthlyCap: 1_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 50e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 7,
            totalCap: 0,
            lane: 1
        });
    }
}
