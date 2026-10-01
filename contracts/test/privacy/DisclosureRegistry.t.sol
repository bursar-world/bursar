// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IEscrow} from "../../src/interfaces/IEscrow.sol";
import {DisclosureRegistry} from "../../src/privacy/DisclosureRegistry.sol";

/// One disputed lock, which is all of an escrow the registry reads.
contract OneLockEscrow {
    IEscrow.Lock private _lock;

    constructor(address payer, address payee) {
        _lock.payer = payer;
        _lock.payee = payee;
        _lock.status = IEscrow.LockStatus.Disputed;
    }

    function getLock(uint256) external view returns (IEscrow.Lock memory) {
        return _lock;
    }
}

/// Names its principal the way a mandate account does.
contract PrincipalledAccount {
    address public immutable principal;

    constructor(address principal_) {
        principal = principal_;
    }
}

/// Answers `principal()` with a word no address fits in.
contract DirtyPayer {
    function principal() external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract DisclosureRegistryTest is Test {
    address internal constant RESOLVER = address(0x5E501);

    DisclosureRegistry internal disclosures;
    OneLockEscrow internal escrow;
    address internal payeePrincipal = makeAddr("payee principal");

    function setUp() public {
        disclosures = new DisclosureRegistry();
        address payer = address(new DirtyPayer());
        address payee = address(new PrincipalledAccount(payeePrincipal));
        escrow = new OneLockEscrow(payer, payee);
    }

    /// The registry asks the payer for its principal before it asks the payee, whoever the caller
    /// is. A payer that answers with a word that is no address has named nobody; decoded as an
    /// address the answer reverts instead, and takes the payee side's grant with it.
    function test_aPayerAnsweringNoAddressCannotBlockThePayeesPrincipal() public {
        vm.expectEmit(true, true, true, true, address(disclosures));
        emit DisclosureRegistry.DisclosureGranted(
            address(escrow), 1, RESOLVER, payeePrincipal, bytes32(uint256(7)), hex"01"
        );
        vm.prank(payeePrincipal);
        disclosures.grant(address(escrow), 1, RESOLVER, bytes32(uint256(7)), hex"01");
    }

    /// Nor is the answer cut down to its low twenty bytes and taken as a principal.
    function test_aPayerAnsweringNoAddressNamesNobody() public {
        vm.prank(address(type(uint160).max));
        vm.expectRevert(DisclosureRegistry.NotParty.selector);
        disclosures.grant(address(escrow), 1, RESOLVER, bytes32(0), hex"01");
    }
}
