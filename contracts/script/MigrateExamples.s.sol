// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {CommittedMandateFactory} from "../src/privacy/CommittedMandateFactory.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";

/// What this step calls on the example mandates of the replaced sets. The same signatures in every
/// build that went live, read from the sources they were built from.
interface IRetiringMandate {
    function principal() external view returns (address);
    function withdraw(address token, address to, uint256 amount) external;
}

interface IRetiringCommittedMandate {
    function principal() external view returns (address);
    function withdraw(address to, uint256 amount) external;
}

interface IRetiringPark {
    function position(address mandate, address adapter)
        external
        view
        returns (uint256 raw, uint256 basis, uint256 value, uint256 priceE8, uint256 updatedAt, bool fresh);
    function unpark(address mandate, address adapter, uint256 raw, uint256 minUsdg) external returns (uint256);
}

interface IRetiringVault {
    function collateralOf(address mandate, address asset) external view returns (uint256);
    function withdraw(address mandate, address asset, uint256 raw, address to) external;
}

/// The public example mandates, moved to the new set, from the key that is their principal.
///
/// `drain` returns what the old examples hold to that key: a parked treasury position is sold back
/// to USDG first, collateral comes out of the old vault, and every balance is withdrawn. Only the
/// principal can do any of it, so a mandate the key does not control is skipped and named.
///
/// `create` makes the new examples and funds them small: a mandate that pays the registered payee
/// and may buy stocks, one on the collateral lane with the drained stock posted as its collateral,
/// and, when its terms are supplied, a committed one. The committed mandate's terms are hashed and
/// sealed to the principal's viewing key by the console, so this step takes the results as
/// `BURSAR_COMMITTED_TERMS`, `BURSAR_COMMITTED_COUNTER` and `BURSAR_COMMITTED_CIPHERTEXT` and skips
/// it when they are unset. Each example is written to the record.
///
///   forge script script/MigrateExamples.s.sol --sig "drain()"  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
///   forge script script/MigrateExamples.s.sol --sig "create()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
contract MigrateExamples is Migration {
    bytes32 internal constant PUBLIC_SALT = keccak256("bursar.example-mandate.v3");
    bytes32 internal constant COLLATERAL_SALT = keccak256("bursar.collateral-mandate.v3");
    bytes32 internal constant COMMITTED_SALT = keccak256("bursar.committed-mandate.v3");

    /// What each example is funded with, in micro-USD, unless the environment says otherwise.
    uint256 internal constant PUBLIC_FUNDING = 200_000;
    uint256 internal constant COMMITTED_FUNDING = 50_000;

    string[4] internal symbols = ["SGOV", "SPY", "NVDA", "AAPL"];

    function drain() external {
        _begin();
        address usdg = _settlementAsset();

        address example = _oldOptional("BURSAR_V2_RECORD", ".exampleMandate.address");
        if (_controls(example)) {
            vm.startBroadcast(msg.sender);
            _unpark(example);
            _withdrawAll(example, usdg);
            for (uint256 i; i < symbols.length; ++i) {
                _withdrawAll(
                    example, _oldOptional("BURSAR_V2_RECORD", string.concat(".rwa.assets.", symbols[i], ".address"))
                );
            }
            vm.stopBroadcast();
        }

        address credit = _oldOptional("BURSAR_V2_RECORD", ".rwa.collateral.liveProof.mandate");
        if (_controls(credit)) {
            IRetiringVault vault = IRetiringVault(_oldOptional("BURSAR_V2_RECORD", ".rwa.collateral.CollateralVault"));
            vm.startBroadcast(msg.sender);
            for (uint256 i; i < symbols.length; ++i) {
                address asset = _oldOptional("BURSAR_V2_RECORD", string.concat(".rwa.assets.", symbols[i], ".address"));
                if (asset == address(0)) continue;
                uint256 posted = vault.collateralOf(credit, asset);
                if (posted == 0) continue;
                vault.withdraw(credit, asset, posted, msg.sender);
                console2.log(string.concat("collateral back from the old vault, ", symbols[i]), posted);
            }
            _withdrawAll(credit, usdg);
            vm.stopBroadcast();
        }

        address committed = _oldOptional("BURSAR_V2_RECORD", ".privacy.exampleCommittedMandate.address");
        if (_controls(committed)) {
            uint256 held = IERC20(usdg).balanceOf(committed);
            if (held != 0) {
                vm.startBroadcast(msg.sender);
                IRetiringCommittedMandate(committed).withdraw(msg.sender, held);
                vm.stopBroadcast();
                console2.log("USDG back from the committed example, micro", held);
            }
        }

        address first = _oldOptional("BURSAR_V1_RECORD", ".exampleMandate.address");
        if (_controls(first)) {
            vm.startBroadcast(msg.sender);
            _withdrawAll(first, usdg);
            vm.stopBroadcast();
        }
    }

    function create() external {
        _begin();
        address payee = _envAddress("BURSAR_EXAMPLE_PAYEE");
        IERC20 usdg = IERC20(_settlementAsset());
        MandateAccountFactory factory = MandateAccountFactory(_upstream(K.FACTORY));

        vm.startBroadcast(msg.sender);
        address pub = _createPublic(factory, payee, usdg);
        address credit = _createCollateral(factory, payee);
        address committed = _createCommitted(usdg);
        vm.stopBroadcast();

        _recordExample(".exampleMandate", pub, address(factory), PUBLIC_SALT);
        _recordExample(".exampleCollateralMandate", credit, address(factory), COLLATERAL_SALT);
        if (committed != address(0)) {
            _recordExample(".exampleCommittedMandate", committed, _recordAddress(K.COMMITTED_FACTORY), COMMITTED_SALT);
        }
    }

    function _createPublic(MandateAccountFactory factory, address payee, IERC20 usdg) private returns (address m) {
        // Services, agent hires and eligible stocks; 0.10 a call, 0.50 a day, 2.00 a month, 1.00
        // over its life, the terms the earlier example ran on.
        IMandateAccount.Limits memory limits = _limits(7, 0);
        m = factory.predict(msg.sender, msg.sender, PUBLIC_SALT, limits);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, PUBLIC_SALT, limits);
            IMandateAccount account = IMandateAccount(m);
            account.setCapability(keccak256("service:gpu.render:1"), true);
            account.setMerchant(payee, true);
            account.setRouter(_upstream(K.STOCK_ROUTER));
            account.setTreasuryPark(_upstream(K.TREASURY_PARK));
            address[] memory stocks = new address[](3);
            bool[] memory allowed = new bool[](3);
            for (uint256 i; i < 3; ++i) {
                stocks[i] = _upstream(string.concat(K.RWA_ASSETS, ".", symbols[i + 1], ".address"));
                allowed[i] = true;
            }
            StockSpendRouter(_upstream(K.STOCK_ROUTER)).setPolicy(m, 100, stocks, allowed);
            console2.log("public example                ", m);
        }
        uint256 funding = _envUintOr("BURSAR_EXAMPLE_FUNDING", PUBLIC_FUNDING);
        if (usdg.balanceOf(m) < funding) {
            uint256 topUp = funding - usdg.balanceOf(m);
            usdg.approve(m, topUp);
            IMandateAccount(m).deposit(topUp);
            console2.log("  funded, micro-USD           ", topUp);
        }
    }

    /// A mandate on the collateral lane holds no USDG of its own: it borrows each spend's shortfall
    /// against what it has posted. The stock drained from the earlier collateral example is posted
    /// here.
    function _createCollateral(MandateAccountFactory factory, address payee) private returns (address m) {
        IMandateAccount.Limits memory limits = _limits(3, 1);
        CollateralVault vault = CollateralVault(_upstream(K.COLLATERAL_VAULT));
        m = factory.predict(msg.sender, msg.sender, COLLATERAL_SALT, limits);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, COLLATERAL_SALT, limits);
            IMandateAccount account = IMandateAccount(m);
            account.setTreasuryPark(address(vault));
            account.setCapability(keccak256("service:demo.x402:1"), true);
            account.setMerchant(payee, true);
            vault.openLine(m);
            console2.log("collateral example            ", m);
        }
        IERC20 spy = IERC20(_upstream(string.concat(K.RWA_ASSETS, ".SPY.address")));
        uint256 held = spy.balanceOf(msg.sender);
        if (held != 0) {
            spy.approve(address(vault), held);
            vault.deposit(m, address(spy), held);
            console2.log("  SPY posted, raw             ", held);
        }
    }

    function _createCommitted(IERC20 usdg) private returns (address m) {
        uint256 terms = _envUintOr("BURSAR_COMMITTED_TERMS", 0);
        if (terms == 0) {
            _note("No committed example: set BURSAR_COMMITTED_TERMS, _COUNTER and _CIPHERTEXT from the console");
            return address(0);
        }
        uint256 counter = _envUint("BURSAR_COMMITTED_COUNTER");
        bytes memory ciphertext = vm.envBytes(_key("BURSAR_COMMITTED_CIPHERTEXT"));
        CommittedMandateFactory factory = CommittedMandateFactory(_upstream(K.COMMITTED_FACTORY));
        m = factory.predict(msg.sender, msg.sender, COMMITTED_SALT, terms, counter);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, COMMITTED_SALT, terms, counter, ciphertext);
            console2.log("committed example             ", m);
        }
        uint256 funding = _envUintOr("BURSAR_COMMITTED_FUNDING", COMMITTED_FUNDING);
        if (usdg.balanceOf(m) < funding) usdg.transfer(m, funding - usdg.balanceOf(m));
    }

    function _limits(uint32 classMask, uint8 lane) private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 100_000,
            dailyCap: 500_000,
            monthlyCap: 2_000_000,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 100_000,
            validFrom: 0,
            validUntil: 0,
            classMask: classMask,
            totalCap: 1_000_000,
            lane: lane
        });
    }

    function _controls(address mandate) private view returns (bool) {
        if (mandate == address(0) || mandate.code.length == 0) return false;
        if (IRetiringMandate(mandate).principal() == msg.sender) return true;
        console2.log("skipped, this key is not its principal:", mandate);
        return false;
    }

    /// Sells a parked treasury position back to USDG, inside the mandate, before it is withdrawn.
    function _unpark(address mandate) private {
        address park = _oldOptional("BURSAR_V2_RECORD", ".rwa.TreasuryPark");
        address adapter = _oldOptional("BURSAR_V2_RECORD", ".rwa.adapters.SGOV");
        if (park == address(0) || adapter == address(0)) return;
        (uint256 raw,, uint256 value,,, bool fresh) = IRetiringPark(park).position(mandate, adapter);
        if (raw == 0) return;
        require(fresh, "the parked position has no fresh price; unpark it in market hours");
        // Two percent under the feed value: the adapter's own band check is the tighter guard.
        uint256 back = IRetiringPark(park).unpark(mandate, adapter, raw, (value * 98) / 100);
        console2.log("unparked, USDG back, micro    ", back);
    }

    function _withdrawAll(address mandate, address token) private {
        if (token == address(0)) return;
        uint256 held = IERC20(token).balanceOf(mandate);
        if (held == 0) return;
        IRetiringMandate(mandate).withdraw(token, msg.sender, held);
        console2.log("withdrawn from", mandate);
        console2.log("  token", token);
        console2.log("  amount", held);
    }

    function _recordExample(string memory at, address mandate, address factory, bytes32 salt) private {
        _write(string.concat(at, ".address"), mandate);
        _write(string.concat(at, ".principal"), msg.sender);
        _write(string.concat(at, ".agent"), msg.sender);
        _write(string.concat(at, ".factory"), factory);
        _write(string.concat(at, ".salt"), salt);
    }
}
