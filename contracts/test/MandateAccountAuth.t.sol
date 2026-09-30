// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {Escrow} from "../src/Escrow.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {IMandateAccount} from "../src/interfaces/IMandateAccount.sol";

import {MockUsdg} from "./mocks/MockUsdg.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// Rig for the authorisation surface: a live escrow behind the mandate, so an approval that
/// clears settles for real and not against a stub, and a principal whose key the test
/// holds. The settlement asset is the USDG stand-in, whose domain is pinned from chain, and the
/// account's own domain has to be visibly different from it.
abstract contract MandateAccountAuthFixture is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant CAPABILITY = keccak256("mandate.capability.inference");

    /// Order of the secp256k1 group. Used to flip a signature to its malleable twin.
    uint256 internal constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint128 internal constant PER_CALL_CAP = 1_000e6;
    uint128 internal constant DAILY_CAP = 5_000e6;
    uint128 internal constant MONTHLY_CAP = 50_000e6;
    uint128 internal constant THRESHOLD = 100e6;

    MockUsdg internal asset;
    MockReputation internal reputation;
    Escrow internal escrow;
    MandateAccount internal account;

    address internal principal;
    uint256 internal principalKey;
    address internal agent;
    address internal merchant;

    /// An allowlist gate reads no proof, and a non-empty one is refused, so every spend in
    /// this file carries the empty array.
    bytes32[] internal noProof;

    function setUp() public virtual {
        vm.warp(1_700_000_000);

        (principal, principalKey) = makeAddrAndKey("principal");
        agent = makeAddr("agent");
        merchant = makeAddr("merchant");

        asset = new MockUsdg();
        reputation = new MockReputation();
        escrow = new Escrow(
            address(asset), address(reputation), makeAddr("treasury"), 100, 50, 500, 1 hours, 30 days, 1 days, 3 days
        );
        reputation.setEscrow(address(escrow));

        account = _newAccount(principal);
    }

    function _newAccount(address principal_) internal returns (MandateAccount created) {
        created = new MandateAccount(principal_, agent, address(asset), address(escrow), _limits(DAILY_CAP));
        asset.mint(address(created), 1_000_000e6);

        vm.startPrank(principal_);
        created.setCapability(CAPABILITY, true);
        created.setMerchant(merchant, true);
        vm.stopPrank();
    }

    function _limits(uint128 dailyCap) internal pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: PER_CALL_CAP,
            dailyCap: dailyCap,
            monthlyCap: MONTHLY_CAP,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: THRESHOLD,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });
    }

    /// Built at call time, since the escrow wants a deadline inside its TTL bounds and the
    /// expiry tests move the clock between construction and submission.
    function _request(address merchant_, uint128 amount) internal view returns (IMandateAccount.SpendRequest memory) {
        return IMandateAccount.SpendRequest({
            merchant: merchant_,
            capabilityId: CAPABILITY,
            inputCommit: keccak256("input"),
            inputURI: "ipfs://input",
            amount: amount,
            deadline: uint64(block.timestamp + 1 days),
            spendClass: 0
        });
    }

    function _approval(bytes32 approvalId, address merchant_, uint128 amount, uint64 expiry)
        internal
        pure
        returns (IMandateAccount.SpendApproval memory)
    {
        return IMandateAccount.SpendApproval({
            approvalId: approvalId, merchant: merchant_, capabilityId: CAPABILITY, amount: amount, expiry: expiry
        });
    }

    function _domainSeparator(string memory name, string memory version, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract)
        );
    }

    function _limitsStructHash(IMandateAccount.Limits memory limits_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                account.LIMITS_TYPEHASH(),
                limits_.perCallCap,
                limits_.dailyCap,
                limits_.monthlyCap,
                limits_.dailyWindow,
                limits_.monthlyWindow,
                limits_.approvalThreshold,
                limits_.validFrom,
                limits_.validUntil,
                limits_.classMask,
                limits_.totalCap,
                limits_.lane
            )
        );
    }

    function _setLimitsDigest(
        bytes32 domainSeparator,
        IMandateAccount.Limits memory limits_,
        uint256 nonce_,
        uint64 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(account.SET_LIMITS_TYPEHASH(), _limitsStructHash(limits_), nonce_, deadline)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    function _approvalDigest(bytes32 domainSeparator, IMandateAccount.SpendApproval memory approval)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                account.SPEND_APPROVAL_TYPEHASH(),
                approval.approvalId,
                approval.merchant,
                approval.capabilityId,
                approval.amount,
                approval.expiry
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract MandateAccountAuthTest is MandateAccountAuthFixture {
    function test_domainSeparatorBindsTheAccountsOwnNameVersionChainAndAddress() public view {
        assertEq(
            account.DOMAIN_SEPARATOR(),
            _domainSeparator("MandateAccount", "1", block.chainid, address(account)),
            "domain separator drifted from the account's own name, version, chain and address"
        );
    }

    /// The probe's lesson, asserted instead of remembered. The token publishes its own domain
    /// and the account publishes another, so a payment signature and a mandate signature are
    /// never interchangeable.
    function test_domainSeparatorIsNotTheSettlementAssetsDomain() public view {
        assertTrue(
            account.DOMAIN_SEPARATOR() != asset.DOMAIN_SEPARATOR(),
            "account and settlement asset answer the same domain separator"
        );
        assertEq(asset.DOMAIN_SEPARATOR(), _domainSeparator("Global Dollar", "1", block.chainid, address(asset)));
    }

    function test_eip712DomainReportsTheAccountAsTheVerifyingContract() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            account.eip712Domain();

        assertEq(name, "MandateAccount");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(account));
    }

    function test_typehashesMatchTheEncodedTypeStringsTheyClaim() public view {
        string memory limitsType = "Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,"
            "uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil,uint32 classMask,"
            "uint128 totalCap,uint8 lane)";

        assertEq(account.LIMITS_TYPEHASH(), keccak256(bytes(limitsType)));
        assertEq(
            account.SET_LIMITS_TYPEHASH(),
            keccak256(abi.encodePacked("SetLimits(Limits limits,uint256 nonce,uint64 deadline)", limitsType)),
            "referenced struct must follow the primary type"
        );
        assertEq(
            account.SPEND_APPROVAL_TYPEHASH(),
            keccak256(
                bytes(
                    "SpendApproval(bytes32 approvalId,address merchant,bytes32 capabilityId,uint128 amount,uint64 expiry)"
                )
            )
        );
    }

    function test_authorizedLimitsApplyAndAdvanceTheNonce() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        uint64 versionBefore = account.version();

        vm.expectEmit(true, false, false, true, address(account));
        emit IMandateAccount.LimitsUpdated(versionBefore + 1, next);

        // Relayed by an address with no standing of its own: authority comes from the
        // signature, which is what the entry point is for.
        vm.prank(makeAddr("relayer"));
        account.setLimitsWithAuthorization(next, 0, deadline, signature);

        assertEq(account.nonce(), 1);
        assertEq(account.version(), versionBefore + 1);
        assertEq(account.limits().dailyCap, DAILY_CAP * 2);
    }

    function test_authorizationsAreAcceptedOnlyInNonceOrder() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);

        bytes memory ahead = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 1, deadline));
        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(next, 1, deadline, ahead);

        bytes memory live = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));
        account.setLimitsWithAuthorization(next, 0, deadline, live);

        // The one held back is now the live one, and the same bytes clear.
        account.setLimitsWithAuthorization(next, 1, deadline, ahead);
        assertEq(account.nonce(), 2);
    }

    function test_replayingAnAcceptedAuthorizationRevertsOnTheNonce() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        account.setLimitsWithAuthorization(next, 0, deadline, signature);

        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_principalWritingLimitsDirectlyStrandsASignedAuthorization() public {
        IMandateAccount.Limits memory signed = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), signed, 0, deadline));

        vm.prank(principal);
        account.setLimits(_limits(DAILY_CAP / 2));

        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(signed, 0, deadline, signature);

        assertEq(account.limits().dailyCap, DAILY_CAP / 2, "the stranded authorization must not have landed");
    }

    function test_authorizationSurvivesItsDeadlineAndNotOneSecondPast() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        vm.warp(deadline + 1);
        vm.expectRevert(IMandateAccount.AuthorizationExpired.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);

        vm.warp(deadline);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
        assertEq(account.nonce(), 1);
    }

    /// The deadline is read before the nonce, so an expired authorization reports as expired
    /// even when its nonce is also wrong. A relayer needs to know which one to fix.
    function test_expiredAuthorizationReportsTheDeadlineRatherThanTheNonce() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 7, deadline));

        vm.warp(deadline + 1);
        vm.expectRevert(IMandateAccount.AuthorizationExpired.selector);
        account.setLimitsWithAuthorization(next, 7, deadline, signature);
    }

    function test_authorizationSignedForAnotherChainIsRejected() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 foreign = _domainSeparator("MandateAccount", "1", block.chainid + 1, address(account));
        bytes memory signature = _sign(principalKey, _setLimitsDigest(foreign, next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    /// A mandate signed before a chain split is not a mandate on the fork.
    function test_authorizationStopsWorkingOnceTheChainIdMoves() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        vm.chainId(block.chainid + 1);

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_authorizationSignedForAnotherAccountIsRejected() public {
        MandateAccount sibling = _newAccount(principal);
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 siblingDomain = _domainSeparator("MandateAccount", "1", block.chainid, address(sibling));
        bytes memory signature = _sign(principalKey, _setLimitsDigest(siblingDomain, next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);

        // Same principal, same nonce, same bytes: it lands on the account it named.
        sibling.setLimitsWithAuthorization(next, 0, deadline, signature);
        assertEq(sibling.nonce(), 1);
        assertEq(account.nonce(), 0);
    }

    /// Signing under the settlement asset's own domain is the failure the probes warned about.
    /// It has to revert, never pass silently.
    function test_authorizationSignedUnderTheTokenDomainNameIsRejected() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 wrongName = _domainSeparator("Global Dollar", "1", block.chainid, address(account));
        bytes memory signature = _sign(principalKey, _setLimitsDigest(wrongName, next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_authorizationSignedUnderAnotherDomainVersionIsRejected() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 wrongVersion = _domainSeparator("MandateAccount", "2", block.chainid, address(account));
        bytes memory signature = _sign(principalKey, _setLimitsDigest(wrongVersion, next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_authorizationOverADifferentLimitSetIsRejected() public {
        IMandateAccount.Limits memory signed = _limits(DAILY_CAP * 2);
        IMandateAccount.Limits memory submitted = _limits(DAILY_CAP * 20);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), signed, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(submitted, 0, deadline, signature);
    }

    function test_authorizationWithAMalleableSignatureIsRejected() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        // The twin recovers to the same address on raw ecrecover, so a checker that skipped
        // the upper-half-order test would accept a second distinct authorization for one
        // signed intent.
        bytes32 flipped = bytes32(SECP256K1N - uint256(s));
        bytes memory malleable = abi.encodePacked(r, flipped, v == 27 ? uint8(28) : uint8(27));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, malleable);
    }

    function test_authorizationWithAMalformedSignatureIsRejected() public {
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, "");

        bytes memory truncated = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            truncated[i] = signature[i];
        }
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, truncated);
    }

    /// A signed authorization cannot be relayed into a mandate whose principal has changed
    /// hands, because the check reads the live principal and not the one at signing.
    function test_authorizationFromTheFormerPrincipalIsRejectedAfterHandover() public {
        (address successor,) = makeAddrAndKey("successor");
        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        vm.prank(principal);
        account.transferPrincipal(successor);
        vm.prank(successor);
        account.acceptPrincipal();

        // The handover moves the nonce, so the held-back authorization is stale twice over:
        // on its nonce, and on its signer once re-signed at the live nonce.
        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);

        bytes memory resigned = _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 1, deadline));
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 1, deadline, resigned);
    }

    function testFuzz_authorizationIsRejectedOnEveryNonceButTheLiveOne(uint256 nonce_) public {
        vm.assume(nonce_ != 0);

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature =
            _sign(principalKey, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, nonce_, deadline));

        vm.expectRevert(IMandateAccount.BadNonce.selector);
        account.setLimitsWithAuthorization(next, nonce_, deadline, signature);
    }

    function testFuzz_authorizationSignedByAnyoneButThePrincipalIsRejected(uint256 key) public {
        key = bound(key, 1, SECP256K1N - 1);
        vm.assume(vm.addr(key) != principal);

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(key, _setLimitsDigest(account.DOMAIN_SEPARATOR(), next, 0, deadline));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_contractPrincipalAuthorizesLimitsThroughErc1271() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("safeOwner");
        AuthSafeSigner safe = new AuthSafeSigner(owner);
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        bytes memory signature = _sign(ownerKey, _setLimitsDigest(domain, next, 0, deadline));

        held.setLimitsWithAuthorization(next, 0, deadline, signature);

        assertEq(held.nonce(), 1);
        assertEq(held.limits().dailyCap, DAILY_CAP * 2);
    }

    function test_contractPrincipalRevokingAnApprovedHashMidFlightRejectsTheAuthorization() public {
        AuthSafeSigner safe = new AuthSafeSigner(makeAddr("safeOwner"));
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        bytes memory marker = hex"01";

        safe.approveHash(_setLimitsDigest(domain, next, 0, deadline));
        held.setLimitsWithAuthorization(next, 0, deadline, marker);
        assertEq(held.nonce(), 1);

        // Second authorization, approved and then withdrawn before the relayer lands it.
        // Contract signatures are revocable, and the account has to honour the withdrawal.
        bytes32 second = _setLimitsDigest(domain, next, 1, deadline);
        safe.approveHash(second);
        safe.revokeHash(second);

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        held.setLimitsWithAuthorization(next, 1, deadline, marker);
        assertEq(held.nonce(), 1);
    }

    function test_rotatingTheContractSignersOwnerRejectsASignatureItAlreadyIssued() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("safeOwner");
        AuthSafeSigner safe = new AuthSafeSigner(owner);
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        bytes memory signature = _sign(ownerKey, _setLimitsDigest(domain, next, 0, deadline));

        safe.setOwner(makeAddr("replacementOwner"));

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        held.setLimitsWithAuthorization(next, 0, deadline, signature);
    }

    function test_signerReturningTheWrongMagicValueIsRejected() public {
        MandateAccount held = _newAccount(address(new AuthRogueSigner()));

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        held.setLimitsWithAuthorization(next, 0, deadline, hex"01");
    }

    function test_signerThatRevertsOnValidationIsRejectedRatherThanBubbled() public {
        MandateAccount held = _newAccount(address(new AuthHostileSigner()));

        IMandateAccount.Limits memory next = _limits(DAILY_CAP * 2);
        uint64 deadline = uint64(block.timestamp + 1 hours);

        vm.expectRevert(IMandateAccount.BadSignature.selector);
        held.setLimitsWithAuthorization(next, 0, deadline, hex"01");
    }

    function test_contractPrincipalClearsAnAboveThresholdSpendThroughErc1271() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("safeOwner");
        AuthSafeSigner safe = new AuthSafeSigner(owner);
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        bytes memory signature = _sign(ownerKey, _approvalDigest(domain, approval));

        vm.prank(agent);
        uint256 escrowId = held.spendApproved(_request(merchant, 500e6), noProof, approval, signature);

        assertEq(escrow.getLock(escrowId).amount, 500e6);
        (, bool spent) = held.approvals(approval.approvalId);
        assertTrue(spent, "a consumed approval stays burned");
    }

    function test_contractPrincipalFreezingMidFlightRejectsTheSpendApproval() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("safeOwner");
        AuthSafeSigner safe = new AuthSafeSigner(owner);
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        bytes memory signature = _sign(ownerKey, _approvalDigest(domain, approval));

        safe.freeze();

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        held.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    /// An empty signature routes to the on-chain registry, never to the signer, so a Safe
    /// that pre-approved the digest off the registry path still does not clear the spend.
    function test_emptySignatureNeverReachesTheContractSignerOnASpendApproval() public {
        AuthSafeSigner safe = new AuthSafeSigner(makeAddr("safeOwner"));
        MandateAccount held = _newAccount(address(safe));

        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes32 domain = _domainSeparator("MandateAccount", "1", block.chainid, address(held));
        safe.approveHash(_approvalDigest(domain, approval));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        held.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function test_registeredApprovalClearsAnAboveThresholdSpend() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        (bool registered, bool spentBefore) = account.approvals(approval.approvalId);
        assertTrue(registered);
        assertFalse(spentBefore);

        vm.expectEmit(true, true, false, false, address(account));
        emit IMandateAccount.ApprovalConsumed(approval.approvalId, 1);

        vm.prank(agent);
        uint256 escrowId = account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        assertEq(escrowId, 1);
        assertEq(escrow.getLock(escrowId).payee, merchant);
        (, bool spentAfter) = account.approvals(approval.approvalId);
        assertTrue(spentAfter);
    }

    /// Ids are chosen by the principal and burned on use, so nothing about the order they
    /// were issued in constrains the order they settle in.
    function test_registeredApprovalsBurnInWhateverOrderTheyAreUsed() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32[3] memory ids = [keccak256("job-a"), keccak256("job-b"), keccak256("job-c")];

        vm.startPrank(principal);
        for (uint256 i = 0; i < ids.length; ++i) {
            account.approveSpend(_approval(ids[i], merchant, 500e6, expiry));
        }
        vm.stopPrank();

        uint8[3] memory order = [2, 0, 1];
        for (uint256 i = 0; i < order.length; ++i) {
            vm.prank(agent);
            account.spendApproved(
                _request(merchant, 500e6), noProof, _approval(ids[order[i]], merchant, 500e6, expiry), ""
            );

            (, bool spent) = account.approvals(ids[order[i]]);
            assertTrue(spent);
        }

        assertEq(escrow.nextId(), 4, "three approvals, three locks");
    }

    function test_consumedApprovalCannotBeReplayed() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function test_registeringOverAConsumedApprovalIdIsRefused() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.approveSpend(approval);
    }

    function test_revokedApprovalCannotBeSpent() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.startPrank(principal);
        account.approveSpend(approval);
        account.revokeApproval(approval.approvalId);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    /// Burning the id is the only handle a principal has on consent that was issued as a
    /// signature and never written on chain.
    function test_revokingAnApprovalThatOnlyEverExistedAsASignatureBurnsIt() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        vm.prank(principal);
        account.revokeApproval(approval.approvalId);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    function test_revokingAConsumedApprovalReverts() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);
        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.revokeApproval(approval.approvalId);
    }

    function test_registeredApprovalCannotBeInflatedByReusingItsId() public {
        bytes32 approvalId = keccak256("job-1");
        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.prank(principal);
        account.approveSpend(_approval(approvalId, merchant, 200e6, expiry));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(_request(merchant, 900e6), noProof, _approval(approvalId, merchant, 900e6, expiry), "");
    }

    function test_unregisteredApprovalWithNoSignatureIsRejected() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function test_approvalCoversASpendUpToItsAmountAndNotOneUnitMore() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(_request(merchant, 500e6 + 1), noProof, approval, "");

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function test_approvalIsBoundToItsMerchantAndItsCapability() public {
        address other = makeAddr("otherMerchant");
        vm.startPrank(principal);
        account.setMerchant(other, true);
        account.approveSpend(_approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours)));
        vm.stopPrank();

        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        // The other merchant is on the allowlist, so only the approval stands between it and
        // the money.
        IMandateAccount.SpendRequest memory request = _request(other, 500e6);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(request, noProof, approval, "");

        request = _request(merchant, 500e6);
        request.capabilityId = keccak256("mandate.capability.other");
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalMismatch.selector);
        account.spendApproved(request, noProof, approval, "");
    }

    function test_approvalIsLiveAtItsExpiryAndDeadOneSecondLater() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        IMandateAccount.SpendApproval memory approval = _approval(keccak256("job-1"), merchant, 500e6, expiry);

        vm.prank(principal);
        account.approveSpend(approval);

        vm.warp(expiry + 1);
        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalExpired.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        vm.warp(expiry);
        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function test_approveSpendRefusesAnExpiryAlreadyBehindTheClock() public {
        bytes32 approvalId = keccak256("job-1");

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ApprovalExpired.selector);
        account.approveSpend(_approval(approvalId, merchant, 500e6, uint64(block.timestamp - 1)));

        // The boundary itself still registers: an approval issued and consumed in the same
        // block is a legitimate flow for an agent that quotes and settles in one transaction.
        vm.prank(principal);
        account.approveSpend(_approval(approvalId, merchant, 500e6, uint64(block.timestamp)));

        (bool registered,) = account.approvals(approvalId);
        assertTrue(registered);
    }

    function test_approveSpendRefusesAZeroMerchantOrAZeroAmount() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ZeroAddress.selector);
        account.approveSpend(_approval(keccak256("job-1"), address(0), 500e6, expiry));

        vm.prank(principal);
        vm.expectRevert(IMandateAccount.ZeroAmount.selector);
        account.approveSpend(_approval(keccak256("job-1"), merchant, 0, expiry));
    }

    function test_onlyThePrincipalRegistersOrRevokesApprovals() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotPrincipal.selector);
        account.approveSpend(approval);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotPrincipal.selector);
        account.revokeApproval(approval.approvalId);
    }

    function test_signedApprovalClearsASpendWithoutBeingRegistered() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        (bool registered,) = account.approvals(approval.approvalId);
        assertFalse(registered, "nothing was written on chain");

        vm.prank(agent);
        uint256 escrowId = account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);

        assertEq(escrow.getLock(escrowId).amount, 500e6);
    }

    function test_signedApprovalIsBurnedByItsIdAndCannotBeReplayed() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    /// A signature carries no principal period, so a burn that reset with the principal let a
    /// principal who handed the account away and took it back spend everything it had already
    /// signed, a second time. Spent and revoked ids now stay burned for the account's life.
    function test_aSpentOrRevokedSignatureStaysBurnedAcrossAHandoverAndBack() public {
        (address successor,) = makeAddrAndKey("successor");
        IMandateAccount.SpendApproval memory spent =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 30 days));
        IMandateAccount.SpendApproval memory revoked =
            _approval(keccak256("job-2"), merchant, 500e6, uint64(block.timestamp + 30 days));
        bytes memory spentSignature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), spent));
        bytes memory revokedSignature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), revoked));

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, spent, spentSignature);
        vm.prank(principal);
        account.revokeApproval(revoked.approvalId);

        vm.prank(principal);
        account.transferPrincipal(successor);
        vm.prank(successor);
        account.acceptPrincipal();
        vm.prank(successor);
        account.transferPrincipal(principal);
        vm.prank(principal);
        account.acceptPrincipal();
        assertEq(account.principal(), principal);
        assertEq(account.approvalEpoch(), 2);

        (, bool burned) = account.approvals(spent.approvalId);
        assertTrue(burned, "the round trip unburned a spent id");

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, spent, spentSignature);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, revoked, revokedSignature);
    }

    /// A handover to itself only moved the epoch, which revoked nothing the principal had signed
    /// and read as though it had.
    function test_aPrincipalCannotHandTheAccountToItself() public {
        vm.prank(principal);
        vm.expectRevert(IMandateAccount.AlreadyPrincipal.selector);
        account.transferPrincipal(principal);

        assertEq(account.pendingPrincipal(), address(0));
        assertEq(account.approvalEpoch(), 0);
    }

    function test_signedApprovalForAnotherAccountIsRejected() public {
        MandateAccount sibling = _newAccount(principal);
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes32 siblingDomain = _domainSeparator("MandateAccount", "1", block.chainid, address(sibling));
        bytes memory signature = _sign(principalKey, _approvalDigest(siblingDomain, approval));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);

        vm.prank(agent);
        sibling.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
        (, bool spent) = sibling.approvals(approval.approvalId);
        assertTrue(spent);
    }

    function test_signedApprovalWithATamperedExpiryIsRejected() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        IMandateAccount.SpendApproval memory approval = _approval(keccak256("job-1"), merchant, 500e6, expiry);
        bytes memory signature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        approval.expiry = expiry + 30 days;

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    function test_spendBelowTheThresholdStillBurnsAnApprovalItCarried() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        account.spendApproved(_request(merchant, THRESHOLD - 1), noProof, approval, "");

        (, bool spent) = account.approvals(approval.approvalId);
        assertTrue(spent, "consent is consumed whether or not the amount needed it");
    }

    function test_consentIsRequiredAtTheThresholdAndNotOneUnitBelow() public {
        vm.prank(agent);
        account.spend(_request(merchant, THRESHOLD - 1), noProof);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalRequired.selector);
        account.spend(_request(merchant, THRESHOLD), noProof);
    }

    function test_onlyTheAgentCanConsumeAnApproval() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        // The principal's own consent does not make the principal the spender.
        vm.prank(principal);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    /// A revoked agent is refused even when carrying the principal's signature, since consent
    /// to a spend is not consent to the party making it.
    function test_revokedAgentCannotSpendAnApprovalItHolds() public {
        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(principalKey, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        vm.prank(principal);
        account.revokeAgent();

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.NotAgent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    function testFuzz_anyApprovalIdRegistersAndBurnsExactlyOnce(bytes32 approvalId) public {
        IMandateAccount.SpendApproval memory approval =
            _approval(approvalId, merchant, 500e6, uint64(block.timestamp + 1 hours));

        vm.prank(principal);
        account.approveSpend(approval);

        vm.prank(agent);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");

        (bool registered, bool spent) = account.approvals(approvalId);
        assertTrue(registered);
        assertTrue(spent);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalSpent.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }

    function testFuzz_approvalSignedByAnyoneButThePrincipalIsRejected(uint256 key) public {
        key = bound(key, 1, SECP256K1N - 1);
        vm.assume(vm.addr(key) != principal);

        IMandateAccount.SpendApproval memory approval =
            _approval(keccak256("job-1"), merchant, 500e6, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(key, _approvalDigest(account.DOMAIN_SEPARATOR(), approval));

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.BadSignature.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, signature);
    }

    function testFuzz_approvalExpiresStrictlyAfterItsExpiry(uint64 skew) public {
        skew = uint64(bound(skew, 1, 365 days));
        uint64 expiry = uint64(block.timestamp + 1 hours);
        IMandateAccount.SpendApproval memory approval = _approval(keccak256("job-1"), merchant, 500e6, expiry);

        vm.prank(principal);
        account.approveSpend(approval);

        vm.warp(uint256(expiry) + skew);

        vm.prank(agent);
        vm.expectRevert(IMandateAccount.ApprovalExpired.selector);
        account.spendApproved(_request(merchant, 500e6), noProof, approval, "");
    }
}

/// Stateful pass over the two authorisation counters. The properties are universal: a nonce
/// tracks accepted limit writes one for one, a burned approval id never comes back, and a
/// signature that was already accepted is never accepted twice.
contract MandateAccountAuthInvariants is MandateAccountAuthFixture {
    AuthActor internal actor;

    function setUp() public override {
        super.setUp();

        actor = new AuthActor(account, escrow, principal, principalKey, agent, merchant, CAPABILITY);
        targetContract(address(actor));
    }

    function invariant_nonceCountsEveryAcceptedLimitWrite() public view {
        assertEq(account.nonce(), actor.limitWrites());
    }

    function invariant_staleAuthorizationIsNeverAccepted() public view {
        assertFalse(actor.staleAuthorizationAccepted());
    }

    function invariant_burnedApprovalIdsStayBurned() public view {
        uint256 burned = actor.burnedCount();
        for (uint256 i = 0; i < burned; ++i) {
            (, bool spent) = account.approvals(actor.burnedAt(i));
            assertTrue(spent);
        }
    }
}

/// Drives the authorisation surface the way a relayer and an agent would, and records what
/// the invariants read back. Failures are swallowed here: the fuzzer is allowed to hand it
/// nonsense, and only the successes are supposed to move the counters.
contract AuthActor is Test {
    /// One size for every approval in the run, above the mandate's threshold so the consent
    /// path is the one being exercised, and constant so a registered id and a consumed id
    /// hash to the same digest.
    uint128 private constant APPROVAL_AMOUNT = 200e6;

    MandateAccount private account;
    Escrow private escrow;
    address private principal;
    uint256 private principalKey;
    address private agent;
    address private merchant;
    bytes32 private capabilityId;

    /// Fixed at construction, never read off the clock, so an approval registered in one call
    /// and consumed in another hashes to the same digest. A moving expiry would make every
    /// consume miss and the run would never reach the burn path.
    uint64 private expiry;

    uint256 public limitWrites;
    bool public staleAuthorizationAccepted;

    bytes32[] private _burned;
    bytes32[] private _noProof;

    IMandateAccount.Limits private _staleLimits;
    uint256 private _staleNonce;
    uint64 private _staleDeadline;
    bytes private _staleSignature;
    bool private _hasStale;

    constructor(
        MandateAccount account_,
        Escrow escrow_,
        address principal_,
        uint256 principalKey_,
        address agent_,
        address merchant_,
        bytes32 capabilityId_
    ) {
        account = account_;
        escrow = escrow_;
        principal = principal_;
        principalKey = principalKey_;
        agent = agent_;
        merchant = merchant_;
        capabilityId = capabilityId_;
        expiry = uint64(block.timestamp + 365 days);
    }

    function burnedCount() external view returns (uint256) {
        return _burned.length;
    }

    function burnedAt(uint256 index) external view returns (bytes32) {
        return _burned[index];
    }

    function authorizeLimits(uint128 dailyCap) external {
        IMandateAccount.Limits memory next = _limits(uint128(bound(dailyCap, 1e6, 1_000_000e6)));
        uint256 nonce_ = account.nonce();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(_setLimitsDigest(next, nonce_, deadline));

        account.setLimitsWithAuthorization(next, nonce_, deadline, signature);
        ++limitWrites;

        _staleLimits = next;
        _staleNonce = nonce_;
        _staleDeadline = deadline;
        _staleSignature = signature;
        _hasStale = true;
    }

    function writeLimits(uint128 dailyCap) external {
        vm.prank(principal);
        account.setLimits(_limits(uint128(bound(dailyCap, 1e6, 1_000_000e6))));
        ++limitWrites;
    }

    function replayStaleAuthorization() external {
        if (!_hasStale) return;

        try account.setLimitsWithAuthorization(_staleLimits, _staleNonce, _staleDeadline, _staleSignature) {
            staleAuthorizationAccepted = true;
            ++limitWrites;
        } catch {}
    }

    function registerApproval(uint256 seed) external {
        vm.prank(principal);
        account.approveSpend(_approval(_id(seed)));
    }

    function revokeApproval(uint256 seed) external {
        bytes32 approvalId = _id(seed);

        vm.prank(principal);
        account.revokeApproval(approvalId);
        _burned.push(approvalId);
    }

    function consumeApproval(uint256 seed) external {
        bytes32 approvalId = _id(seed);

        vm.prank(agent);
        account.spendApproved(
            IMandateAccount.SpendRequest({
                merchant: merchant,
                capabilityId: capabilityId,
                inputCommit: bytes32(0),
                inputURI: "",
                amount: APPROVAL_AMOUNT,
                deadline: uint64(block.timestamp + 1 days),
                spendClass: 0
            }),
            _noProof,
            _approval(approvalId),
            ""
        );
        _burned.push(approvalId);
    }

    /// Keeps the escrow from filling with live locks, which would otherwise cap how far the
    /// run can go before every spend fails on the daily bucket.
    function timeoutLock(uint256 id) external {
        uint256 bounded = bound(id, 1, escrow.nextId());
        vm.warp(block.timestamp + 2 days);
        escrow.timeout(bounded);
    }

    function _limits(uint128 dailyCap) private pure returns (IMandateAccount.Limits memory) {
        return IMandateAccount.Limits({
            perCallCap: 1_000e6,
            dailyCap: dailyCap,
            monthlyCap: 1_000_000e6,
            dailyWindow: 1 days,
            monthlyWindow: 30 days,
            approvalThreshold: 100e6,
            validFrom: 0,
            validUntil: 0,
            classMask: 3,
            totalCap: 0,
            lane: 0
        });
    }

    /// A small pool, not the raw fuzz word. A registration and a consume then land on the same
    /// id often enough for the burn path to be reached at all.
    function _id(uint256 seed) private pure returns (bytes32) {
        return keccak256(abi.encode(seed % 8));
    }

    function _approval(bytes32 approvalId) private view returns (IMandateAccount.SpendApproval memory) {
        return IMandateAccount.SpendApproval({
            approvalId: approvalId,
            merchant: merchant,
            capabilityId: capabilityId,
            amount: APPROVAL_AMOUNT,
            expiry: expiry
        });
    }

    function _setLimitsDigest(IMandateAccount.Limits memory limits_, uint256 nonce_, uint64 deadline)
        private
        view
        returns (bytes32)
    {
        bytes32 limitsHash = keccak256(
            abi.encode(
                account.LIMITS_TYPEHASH(),
                limits_.perCallCap,
                limits_.dailyCap,
                limits_.monthlyCap,
                limits_.dailyWindow,
                limits_.monthlyWindow,
                limits_.approvalThreshold,
                limits_.validFrom,
                limits_.validUntil,
                limits_.classMask,
                limits_.totalCap,
                limits_.lane
            )
        );
        bytes32 structHash = keccak256(abi.encode(account.SET_LIMITS_TYPEHASH(), limitsHash, nonce_, deadline));
        return keccak256(abi.encodePacked(hex"1901", account.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(principalKey, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// Safe-style contract signer: an owner key signs, and a hash the wallet approved on chain
/// clears against any marker the relayer carries. Both halves are revocable mid-flight,
/// which is the property a contract principal has and an EOA does not.
contract AuthSafeSigner is IERC1271 {
    bytes4 private constant MAGIC = IERC1271.isValidSignature.selector;
    bytes4 private constant REFUSED = 0xffffffff;

    address public owner;
    bool public frozen;
    mapping(bytes32 digest => bool) public approved;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address owner_) external {
        owner = owner_;
    }

    function approveHash(bytes32 digest) external {
        approved[digest] = true;
    }

    function revokeHash(bytes32 digest) external {
        approved[digest] = false;
    }

    function freeze() external {
        frozen = true;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) public view override returns (bytes4) {
        if (frozen) return REFUSED;

        if (signature.length == 65) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            if (err != ECDSA.RecoverError.NoError || recovered != owner) return REFUSED;
            return MAGIC;
        }

        return approved[digest] ? MAGIC : REFUSED;
    }
}

/// Answers every signature, and answers with the wrong word. A checker that only tested for
/// a successful call would read this as consent.
contract AuthRogueSigner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract AuthHostileSigner {
    error NoSignatureHere();

    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        revert NoSignatureHere();
    }
}
