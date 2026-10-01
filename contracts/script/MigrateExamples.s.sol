// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Migration} from "./lib/Migration.sol";
import {RecordKeys as K} from "./lib/RecordKeys.sol";

import {MandateAccountFactory} from "../src/MandateAccountFactory.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";
import {CommittedMandateAccount} from "../src/privacy/CommittedMandateAccount.sol";
import {CommittedMandateFactory} from "../src/privacy/CommittedMandateFactory.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {StockSpendRouter} from "../src/rwa/StockSpendRouter.sol";
import {TreasuryPark} from "../src/rwa/TreasuryPark.sol";

/// The public example mandates, moved to the new set, from the key that is their principal.
///
/// `drain` returns what the previous record's three examples hold to that key: the public
/// example's parked treasury position is sold back to USDG first, the collateral example's stock
/// comes out of the previous vault, and every balance is withdrawn. Only the principal can do any
/// of it, so a mandate the key does not control is skipped and named.
///
/// `create` makes the new examples on the new set, on the same terms, and funds them small: a
/// mandate that pays the registered payee and may buy stocks, one on the collateral lane with the
/// drained stock posted as its collateral, and, when its terms are supplied, a committed one. The
/// committed mandate's terms are hashed and sealed to the principal's viewing key by
/// `script/committed-example.mjs`, so this step takes the results as `BURSAR_COMMITTED_TERMS`,
/// `BURSAR_COMMITTED_COUNTER` and `BURSAR_COMMITTED_CIPHERTEXT` and skips it when they are unset.
/// Each example is written to the record, under a salt derived from the record's name.
///
///   forge script script/MigrateExamples.s.sol --sig "drain()"  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
///   forge script script/MigrateExamples.s.sol --sig "create()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payer" [--broadcast]
contract MigrateExamples is Migration {
    using SafeERC20 for IERC20;

    /// What each example is funded with, in micro-USD, unless the environment says otherwise.
    uint256 internal constant PUBLIC_FUNDING = 200_000;
    uint256 internal constant COMMITTED_FUNDING = 50_000;

    string[4] internal symbols = ["SGOV", "SPY", "NVDA", "AAPL"];

    function drain() external {
        _begin();
        address usdg = _settlementAsset();

        address example = _previousOptional(".exampleMandate.address");
        if (_controls(example)) {
            vm.startBroadcast(msg.sender);
            _unpark(example);
            _withdrawAll(example, usdg);
            for (uint256 i; i < symbols.length; ++i) {
                _withdrawAll(example, _previousAsset(symbols[i]));
            }
            vm.stopBroadcast();
        }

        address credit = _previousOptional(".exampleCollateralMandate.address");
        if (_controls(credit)) {
            CollateralVault vault = CollateralVault(_previous(K.COLLATERAL_VAULT));
            vm.startBroadcast(msg.sender);
            for (uint256 i; i < symbols.length; ++i) {
                address asset = _previousAsset(symbols[i]);
                if (asset == address(0)) continue;
                uint256 posted = vault.collateralOf(credit, asset);
                if (posted == 0) continue;
                vault.withdraw(credit, asset, posted, msg.sender);
                console2.log(string.concat("collateral back from the previous vault, ", symbols[i]), posted);
            }
            _withdrawAll(credit, usdg);
            vm.stopBroadcast();
        }

        address committed = _previousOptional(".exampleCommittedMandate.address");
        if (_controls(committed)) {
            uint256 held = IERC20(usdg).balanceOf(committed);
            if (held != 0) {
                vm.startBroadcast(msg.sender);
                CommittedMandateAccount(committed).withdraw(msg.sender, held);
                vm.stopBroadcast();
                console2.log("USDG back from the committed example, micro", held);
            }
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

        _recordExample(".exampleMandate", pub, address(factory), _salt("example-mandate"));
        _recordExample(".exampleCollateralMandate", credit, address(factory), _salt("collateral-mandate"));
        if (committed != address(0)) {
            _recordExample(
                ".exampleCommittedMandate", committed, _recordAddress(K.COMMITTED_FACTORY), _salt("committed-mandate")
            );
        }
    }

    function _createPublic(MandateAccountFactory factory, address payee, IERC20 usdg) private returns (address m) {
        // Services, agent hires and eligible stocks; 0.10 a call, 0.50 a day, 2.00 a month, 1.00
        // over its life, the terms the earlier example ran on.
        IMandateAccount.Limits memory limits = _limits(7, 0);
        bytes32 salt = _salt("example-mandate");
        m = factory.predict(msg.sender, msg.sender, salt, limits);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, salt, limits);
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
        bytes32 salt = _salt("collateral-mandate");
        m = factory.predict(msg.sender, msg.sender, salt, limits);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, salt, limits);
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
        bytes memory ciphertext = _envBytes("BURSAR_COMMITTED_CIPHERTEXT");
        CommittedMandateFactory factory = CommittedMandateFactory(_upstream(K.COMMITTED_FACTORY));
        bytes32 salt = _salt("committed-mandate");
        m = factory.predict(msg.sender, msg.sender, salt, terms, counter);
        if (m.code.length == 0) {
            factory.create(msg.sender, msg.sender, salt, terms, counter, ciphertext);
            console2.log("committed example             ", m);
        }
        uint256 funding = _envUintOr("BURSAR_COMMITTED_FUNDING", COMMITTED_FUNDING);
        if (usdg.balanceOf(m) < funding) usdg.safeTransfer(m, funding - usdg.balanceOf(m));
    }

    /// `bursar.<kind>.<record name>`, so each record's examples sit at addresses of their own and
    /// `script/committed-example.mjs` derives the same salt from the same record.
    function _salt(string memory kind) private view returns (bytes32) {
        return keccak256(bytes(string.concat("bursar.", kind, ".", _recordString(K.NETWORK))));
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

    function _previousAsset(string memory symbol) private view returns (address) {
        return _previousOptional(string.concat(K.RWA_ASSETS, ".", symbol, ".address"));
    }

    function _controls(address mandate) private view returns (bool) {
        if (mandate == address(0) || mandate.code.length == 0) return false;
        if (IMandateAccount(mandate).principal() == msg.sender) return true;
        console2.log("skipped, this key is not its principal:", mandate);
        return false;
    }

    /// Sells a parked treasury position back to USDG, inside the mandate, before it is withdrawn.
    function _unpark(address mandate) private {
        address park = _previousOptional(K.TREASURY_PARK);
        address adapter = _previousOptional(K.SGOV_ADAPTER);
        if (park == address(0) || adapter == address(0)) return;
        (uint256 raw,, uint256 value,,, bool fresh) = TreasuryPark(park).position(mandate, adapter);
        if (raw == 0) return;
        require(fresh, "the parked position has no fresh price; unpark it in market hours");
        // Two percent under the feed value: the adapter's own band check is the tighter guard.
        uint256 back = TreasuryPark(park).unpark(mandate, adapter, raw, (value * 98) / 100);
        console2.log("unparked, USDG back, micro    ", back);
    }

    function _withdrawAll(address mandate, address token) private {
        if (token == address(0)) return;
        uint256 held = IERC20(token).balanceOf(mandate);
        if (held == 0) return;
        IMandateAccount(mandate).withdraw(token, msg.sender, held);
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
