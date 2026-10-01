# @bursar/x402

The x402 payment scheme Bursar settles with. [x402](https://www.x402.org) is the HTTP payment
standard where a server answers `402 Payment Required` with a price and the client's retry carries
a signed payment. This package encodes and decodes those messages, verifies a payment against
USDG on Robinhood Chain, and settles it through the `exact` EVM scheme. The facilitator service
uses it to verify and settle; the SDK and a provider use it to build and read payment headers.

## What is in it

| Area | What it does |
|---|---|
| Codec | `paymentRequired`, `parsePayment`, `encodePayment`, `paymentResponse`: the x402 v1 and v2 wire formats, header names and requirement objects. |
| Verification | `createExactEvm`: the verdict matrix for a payment. Checks the signature, amount, recipient, validity window, nonce state and the asset's own controls, and names the reason when it refuses. |
| Transfer methods | EIP-3009 `transferWithAuthorization`, EIP-2612 permit, and Permit2, each with its typed data. |
| Domain | Reads the token's EIP-712 domain separator and proves the domain against it before anything is signed or accepted. USDG publishes no version, so the version comes from `@bursar/core` and is checked, never guessed. |
| Request binding | `bindingMessage`, `verifyBinding`: ties a payment to the SHA-256 of the request body it pays for, so a payment seen in flight cannot be put in front of another request. |
| Escrow lane | `requestDocument`, `requestURI`, `readRequestURI`, `escrowSettlementNonce`: what a lock opened for an x402 call commits to, and the name a facilitator settles it under. See below. |
| Facilitator client | `createFacilitatorClient`: calls a facilitator's `/verify`, `/settle` and `/supported`. |
| Assembly | `createExactScheme`: turns a chain, RPC endpoints, a relayer key and an asset list into a running scheme. |

## The escrow lane

A call can also be paid by the mandate account's own `spend`, which opens an escrow lock payable to
the provider instead of signing a transfer. The payment header then carries a pointer to the lock,
and a facilitator reads the lock rather than redeeming a signature. Two derivations make that safe,
and both live in `@bursar/core` so the client, the facilitator and the dispute resolver compute them
on their own:

- **The request document** is the lock's input: `{ method, resource, requestNonce }` as canonical
  JSON (RFC 8785), published inline as the lock's `inputURI` under
  `data:application/vnd.bursar.x402-request+json;base64,`. Its `keccak256` is the lock's
  `inputCommit`. `resource` is the URL without its query or fragment. `requestNonce` is
  `deriveNonce` over the sha256 of the request body and the payer's 32-byte salt, the value the
  wallet lane signs into its authorisation. A facilitator recomputes it from the body that reached
  the provider and the salt in the payment header, so a lock cannot be redeemed against a request it
  was not opened for. The chain carries neither the digest nor the salt, so nobody reading it can
  present the lock, and a resolver reading a disputed lock still finds the job.
- **The settlement nonce** is the name a facilitator records the redemption under, derived from the
  lock alone: `keccak256(abi.encode("bursar-x402-escrow:v1", uint256 chainId, address escrow,
  uint256 lockId, bytes32 inputCommit))`. Nothing in it comes from the payload, so one lock has one
  name however it is presented. A settle whose `authorization.nonce` names anything else is refused
  as `escrow_nonce_mismatch`.

## Design

No service in this repository holds a user's key, and the only key the facilitator holds is its
own relayer key. This package never constructs an account from a user's private key. Everything
it needs from a chain or a key holder goes through the narrow ports in `src/ports.ts`: `send`
takes finished calldata, so whoever implements it owns the key. The same ports let the whole
verdict matrix run in tests without a chain.

## Use

The package is not published to npm. Inside this workspace, depend on it with
`"@bursar/x402": "workspace:*"`:

```sh
pnpm --filter @bursar/x402 build
```

```ts
import { paymentRequired, parsePayment } from '@bursar/x402';
```

It reads no environment variables of its own. RPC endpoints and the relayer key are passed in by
the caller; see `services/facilitator/README.md` for how the facilitator configures them.

## Tests

```sh
pnpm --filter @bursar/x402 test
```

## License

MIT. See [LICENSE](../../LICENSE).
