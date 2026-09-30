// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// Local stand-in for USDG at 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 on chain 4663.
/// Reproduces the surface the live token answered when it was probed on 2026-09-22: six
/// decimals, the whole EIP-3009 authorisation set including the bytes-signature variant the
/// x402 `exact` scheme submits, EIP-2612 permit, and the two issuer controls.
///
/// The EIP-712 domain is built from ("Global Dollar", "1", chainId, address(this)), because a
/// guessed domain yields a signature that fails with nothing to point at. That pair is pinned
/// in `packages/core/src/chain.ts` and was confirmed by computing the separator and matching it
/// against what the live token returns. A payload signed against this mock verifies against
/// USDG once the chain id matches, which is what makes these tests worth running without a
/// network.
///
/// USDG is a diamond proxy, so a selector no facet declares does not return a default, it
/// reverts `FacetNotFound` (0x800ab12c). `version` is the one that catches callers out, because
/// most dollar tokens answer it and a signer that reads its domain version off chain gets a
/// revert with nothing in it to explain why. `isBlacklisted` and `eip712Domain` behave the same
/// way and are absent here for the same reason.
contract MockUsdg is ERC20, IERC20Permit, EIP712 {
    error InvalidSignature();
    error AuthorizationNotYetValid();
    error AuthorizationNoLongerValid();
    error AuthorizationAlreadyUsed();
    error CallerNotPayee();
    error PermitExpired();

    /// What a diamond returns for a selector none of its facets declare. Selector 0x800ab12c,
    /// read from USDG on 4663.
    error FacetNotFound();

    /// The token's own refusals. Names follow the control that produced them, so a test asserting
    /// on one is asserting on the reason and not on a generic transfer failure.
    error TokenPaused();
    error AccountFrozen(address account);

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;
    mapping(address owner => uint256 nonce) private _permitNonces;
    mapping(address account => bool frozen) private _frozen;

    bool private _paused;

    /// The address that holds both issuer controls. USDG answers `owner()` and has no separate
    /// `pauser` or `blacklister`.
    address public owner;

    constructor() ERC20("Global Dollar", "USDG") EIP712("Global Dollar", "1") {
        owner = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Reverts, the way the live diamond does. Kept declared so a caller that reaches for it
    /// fails here rather than against the network, and so the generated ABI can be checked
    /// against a source that has the selector and refuses it.
    function version() external pure returns (string memory) {
        revert FacetNotFound();
    }

    /// Stops every transfer at once. A deployment that starts into one cannot settle at all.
    function paused() external view returns (bool) {
        return _paused;
    }

    /// The per-address control. A frozen address reverts every transfer whatever its balance
    /// says, on both sides of the move.
    function isFrozen(address account) external view returns (bool) {
        return _frozen[account];
    }

    function setPaused(bool paused_) external {
        _paused = paused_;
    }

    function setFrozen(address account, bool frozen_) external {
        _frozen[account] = frozen_;
    }

    /// Open to anyone, unlike the live token's. It is how the local rehearsal and the lane tests
    /// fund an account: `cast send <USDG> "mint(address,uint256)" <account> <micro-USD>`.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// `signature` is 65 bytes from an EOA or an ERC-1271 blob from a contract wallet. Anyone may
    /// submit it. Authority comes from the signature, not from the sender, which is what makes
    /// the transfer gasless.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        _requireValidPeriod(validAfter, validBefore);
        _requireUnusedAuthorization(from, nonce);
        _requireValidSignature(
            from,
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            ),
            signature
        );

        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// Same transfer, bound to the recipient. A front-runner who lifts the signature out of the
    /// mempool cannot submit it, because the authorisation names the caller it will accept.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        if (to != msg.sender) revert CallerNotPayee();

        _requireValidPeriod(validAfter, validBefore);
        _requireUnusedAuthorization(from, nonce);
        _requireValidSignature(
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            signature
        );

        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    /// Burns a nonce the authorizer no longer wants settled. The only way back out of a signature
    /// that has been handed to a facilitator and not yet submitted.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) public {
        _requireUnusedAuthorization(authorizer, nonce);
        _requireValidSignature(
            authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature
        );

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function permit(address owner_, address spender, uint256 value, uint256 deadline, bytes memory signature) public {
        if (block.timestamp > deadline) revert PermitExpired();

        _requireValidSignature(
            owner_,
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, _permitNonces[owner_]++, deadline)),
            signature
        );

        _approve(owner_, spender, value);
    }

    function permit(address owner_, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        override
    {
        permit(owner_, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    /// EIP-2612 only. EIP-3009 nonces are caller-chosen and live in `authorizationState`, so the
    /// two schemes never share a counter.
    function nonces(address owner_) external view override returns (uint256) {
        return _permitNonces[owner_];
    }

    // forge-lint: disable-next-item(mixed-case-function)
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// Both controls sit on the movement itself, so they catch a settlement whichever path
    /// reached it: a direct transfer, an EIP-3009 authorisation or an allowance pull.
    function _update(address from, address to, uint256 value) internal override {
        if (_paused) revert TokenPaused();
        if (_frozen[from]) revert AccountFrozen(from);
        if (_frozen[to]) revert AccountFrozen(to);
        super._update(from, to, value);
    }

    function _requireValidPeriod(uint256 validAfter, uint256 validBefore) private view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationNoLongerValid();
    }

    function _requireUnusedAuthorization(address authorizer, bytes32 nonce) private view {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) private view {
        if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature();
        }
    }

    function _markAuthorizationUsed(address authorizer, bytes32 nonce) private {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
