# @bursar/sdk

Pay providers from an agent, inside limits a contract enforces.

An enterprise sets a mandate: how much per call, how much per day, how much per month, which
providers, which capabilities, and above what amount a human has to sign. The agent spends inside
it. The limits live in the `MandateAccount` contract on Robinhood Chain, so a payment past them fails at the
contract, not at a service that could be talked around.

```ts
import { mandateAccount, usdg } from '@bursar/sdk';

const mandate = await mandateAccount(ACCOUNT, { account: AGENT_KEY });
const receipt = await mandate.pay({ to: provider, amount: usdg('2.50'), capability: 'gpu.render:1' });

console.log(receipt.escrowId, receipt.remaining.daily);
```

That is a mandate check, an escrowed settlement in USDG, and a receipt. Amounts are micro-USD held
as `bigint`, the same six decimals USDG and the ledger use. No float ever touches money.

The contracts the code above talks to are live on chain 4663 and this package ships their
addresses, so there is nothing to configure before the first call. Those addresses move real USDG.

## Install

The package is not on npm. It is built and used from this workspace:

```
pnpm install
pnpm --filter @bursar/sdk build
```

Then depend on it by workspace path, which is what the apps and services here do:

```json
{ "dependencies": { "@bursar/sdk": "workspace:*", "viem": "^2.56.0" } }
```

Outside a workspace, point at the directory:

```
pnpm add /path/to/bursar/packages/sdk viem
```

Node 22 or newer. The package is ESM only.

## Connecting

`connect()` targets Robinhood Chain mainnet, chain 4663. That is the only network BURSAR settles
on: testnet 46630 has no USDG contract, so nothing on it can be paid.

Called with nothing, it resolves the deployment recorded for 4663 and hands back a read-only
connection with all seven addresses already in it, the six contracts and USDG:

```ts
import { connect } from '@bursar/sdk';

const connection = connect();

connection.addresses.escrow;           // 0x4315F8be7C9661345710910577Ec31cb867f3c20
connection.addresses.settlementAsset;  // 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```

Give it an account and it can write. Give it two endpoints and reads fail over between them:

```ts
const connection = connect({
  account: AGENT_KEY,                      // a private key, or any viem Account
  rpc: [RPC_PRIMARY, RPC_FALLBACK],
});
```

`deployment` points the same call at contracts of your own, which is how you reach a local fork of
4663:

```ts
const connection = connect({ deployment: RECORD, account: AGENT_KEY, rpc: FORK_RPC });
```

A record it is given has to settle in USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` and
record chain 4663, or `connect()` refuses it and says which of the two disagrees.

One endpoint works. Two get failover with a circuit breaker per provider, which is what a service
that has to keep paying should run. Leave the account out and the connection is read-only: every
write path refuses before it reaches the node, and says which call it refused.

`connect({ chainId: 4663 })` is the same as `connect()`. Any other chain id throws
`UnsupportedChainError`, which lists the chains that have a deployment.

## Reading a mandate

Reads need no key. `mandateAccount(address)` with no account opens a read-only client, and
`status()` returns everything the mandate holds in one pass: limits, what is left in each window
and when it resets, the USDG balance, and whether it is paused or revoked. `preview()` answers
whether a payment would clear, also without a key and without sending anything.

The mandate below is live on Robinhood Chain. Run this as `read.mjs` after installing:

```js
import { formatUsdg, mandateAccount, usdg } from '@bursar/sdk';

const mandate = await mandateAccount('0x420BeB507F72173E7d78e0f956968f64fb508356');
const status = await mandate.status();

console.log('balance   ', formatUsdg(status.balance));
console.log('per call  ', formatUsdg(status.limits.perCallCap));
console.log('daily left', formatUsdg(status.remaining.daily), 'of', formatUsdg(status.daily.cap));
console.log('state     ', status.revoked ? 'revoked' : status.paused ? 'paused' : 'active');

const decision = await mandate.preview({
  to: '0x000000000000000000000000000000000000dEaD',
  amount: usdg('0.05'),
  capability: 'gpu.render:1',
});

console.log('preview   ', decision.allowed ? 'allowed' : decision.message);
```

```
balance    0.20 USDG
per call   0.10 USDG
daily left 0.50 USDG of 0.50 USDG
state      active
preview    Mandate 0x420BeB507F72173E7d78e0f956968f64fb508356 refused a 0.05 USDG payment to
0x000000000000000000000000000000000000dEaD: gpu.render:1 is not on its capability allowlist.
```

The figures move as the mandate is used. For one field at a time the same client has `limits()`,
`remaining()`, `window(kind)`, `balance()`, `allowsMerchant(address)` and
`allowsCapability(name)`. An address that holds no mandate throws `NotAMandateAccountError` when
the client opens, before any other call.

Calling `pay()` or `hire()` on a read-only client throws `NoSignerError`, which names the call
that opened the client. Pass `account` or `walletClient` in the same options to write:
`mandateAccount(address, { account: AGENT_KEY })`.

## Paying

```ts
const receipt = await mandate.pay({
  to: provider,
  amount: usdg('2.50'),
  capability: 'gpu.render:1',
  input: { prompt: 'a koi, ink on paper' },   // committed as canonical JSON
  inputURI: 'ipfs://…',
  ttlSeconds: 600,
});
```

The payment goes into escrow against a deadline. The provider claims it by committing to what it
delivered; a provider that never answers leaves the funds to be reclaimed with `timeout`, and the
allowance the spend consumed is credited back to the window it came from.

`receipt` carries the escrow id, the transaction hash, an explorer link, what each window now
holds, and what is left.

### When a limit refuses

```
Mandate 0x1234… refused a 2.50 USDG payment to 0x5678…: the daily limit has 1.20 USDG left of
50.00 USDG and this call asks for 2.50 USDG. The daily window resets at 2026-09-12T00:00:00.000Z
(in 4h 12m).
```

The error is a `MandateDeniedError` carrying `reason` (`daily-cap`, `per-call-cap`,
`approval-required`, `merchant-not-allowed`, and the rest), `resetsAt`, and the limit snapshot it
quoted. Nothing is sent: the call is simulated first, so a refusal costs no gas.

To ask before paying:

```ts
const decision = await mandate.preview({ to: provider, amount: usdg('2.50'), capability: 'gpu.render:1' });

if (!decision.allowed) console.warn(decision.message);
```

### Spends that need a person

Above the approval threshold the agent cannot act alone. The principal signs consent out of band,
from a Safe or a cold wallet, and the agent carries it:

```ts
const consent = await principal.signApproval({
  merchant: provider,
  capability: 'gpu.render:1',
  amount: usdg('500'),
  expiry: Math.floor(Date.now() / 1000) + 3600,
});

await mandate.pay({ to: provider, amount: usdg('480'), capability: 'gpu.render:1', approval: consent });
```

The approval is single use and expires on its own. The signed amount is a ceiling, so a quote that
settles under it still clears.

## Paying over HTTP

```ts
const paid = await mandate.fetch('https://api.provider.dev/render', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'a koi' }),
  capability: 'gpu.render:1',
  lane: 'mandate',
});
```

If the resource answers 402, this reads the offer, checks it against the mandate, pays, and
retries. Both x402 versions are handled. What the mandate refuses is never paid.

There are two lanes, and they differ in whose money moves and what the chain counts.

**`lane: 'mandate'`** pays from the mandate account. The account's `spend` locks the quoted price in
escrow for the provider, under the same checks as `pay`, and the retry names that lock. The daily
and monthly windows move by the amount paid, and a call they do not cover is refused by the
contract. The provider has to offer the `escrow` scheme; its facilitator checks the lock, and the
lock is committed to the request, so it cannot be redeemed against another one.

**The wallet lane**, the default, pays from the agent's own wallet with a single-use EIP-3009
authorization for the exact amount quoted, under the `exact` scheme. Per-call only; windows
client-enforced. Each payment is checked against the mandate's per-call cap, its merchant and
capability allowlists, and whether it is active, but the windows are read and never debited: a
payment larger than what a window has left is refused, and payments that each fit keep clearing,
however many there are. Use it only where the provider offers nothing else.

Every payment needs a bound. Pass `through` and the mandate decides, or `maxAmount` and this
client refuses anything above it. Passing neither does not compile.

`paidFetch()` returns the same thing as a drop-in `fetch`, for the HTTP client that talks to the
paid service. Give it to that client and leave the global `fetch` alone: a 402 from
any host the agent touches would otherwise become a signed transfer under the same single bound.

## Setting a mandate

```ts
import { createMandate, usdg } from '@bursar/sdk';

const mandate = await createMandate(connection, {
  principal: treasury,
  agent: agentWallet,
  limits: {
    perCallCap: usdg('5'),
    dailyCap: usdg('250'),
    monthlyCap: usdg('4000'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('100'),
  },
});

await mandate.setMerchant(provider, true);
await mandate.setCapability('gpu.render:1', true);
await mandate.deposit(usdg('1000'));
```

Limits are set in the constructor, so there is no block in which a funded account is spendable
without a bound. The address is deterministic: the same principal, agent, salt and limits always
produce the same one, and `predictMandate` reads it before anything is deployed.

Everything else the principal can do is on the same client: `setLimits`, `setPaused`, `setAgent`,
`revokeAgent`, `setMerchantGate`, `withdraw`, `transferPrincipal`, `disputeSpend`. A limit change
can also be signed for a relayer to send with `signLimits` and `relayLimits`.

## Answering a payment

The provider side of the same escrow:

```ts
import { escrow } from '@bursar/sdk';

const jobs = await escrow(connection);
const lock = await jobs.get(escrowId);

await jobs.release({ id: escrowId, output: result, outputURI: 'ipfs://…' });
```

Releasing commits to the delivered output and pays out in the same transaction. `timeout`,
`cancel`, `dispute` and `finalizeRelease` are the other exits.

## Notes

- Every write is simulated before it is sent. A call that would revert throws an error that says
  why, and spends no gas.
- `usdg()` takes a decimal string, `usdg('2.50')`, and throws `InvalidArgumentError` if handed a
  number: a JavaScript number cannot hold every cent exactly. It takes an amount to pay, so it
  refuses a negative one. Every argument bound for a contract is checked where it is given, and a
  bad one is refused with the field named.
- Deadlines are computed against the chain clock, not this machine's.
- EIP-712 domains are checked against the contract that will verify them. USDG publishes no
  version of its own, so the version in the domain comes from this side and is proved against the
  token's `DOMAIN_SEPARATOR` before anything is signed. A guessed domain produces a well-formed
  signature that recovers to nobody, so this package refuses to sign until the domain matches.
- Fees are ETH and payments settle in USDG. A signer can hold every USDG it needs and still be
  unable to send a transaction, and the gas errors say which balance to top up.
- The contracts are unaudited. Size mandates accordingly.

## License

MIT. See [LICENSE](../../LICENSE).
