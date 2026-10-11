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

```
npm install @bursar/sdk viem
```

Node 22 or newer. The package is ESM only. Inside this repository the workspace links it instead:
`pnpm install`, then `pnpm --filter "@bursar/sdk..." build`, which builds the packages it imports first.

## Connecting

`connect()` targets Robinhood Chain mainnet, chain 4663. That is the only network Bursar settles
on: testnet 46630 has no USDG contract, so nothing on it can be paid.

Called with nothing, it resolves the deployment recorded for 4663 and hands back a read-only
connection with all seven addresses already in it, the six contracts and USDG:

```ts
import { connect } from '@bursar/sdk';

const connection = connect();

connection.addresses.escrow;           // 0x11e73B5632837355e250fC236cFC2Be03aD0845A
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
record chain 4663, or `connect()` refuses it and says which of the two disagrees. `RECORD` can be the
JSON a deploy script wrote, read as it is; [Running against a local chain](#running-against-a-local-chain)
shows one.

Before the first call on the connection goes out, a record it was given is checked against the
node. Every contract the record names has to hold code there, or the call fails with
`NotDeployedError`, which names the first one that does not. A rehearsal record, which the deploy
scripts mark `local`, also has to find a node that calls itself anvil, and anywhere else fails with
`NotAnvilError`: a rehearsal answers as chain 4663 too, and on any other node its transactions
would be real ones. A rehearsal record for any chain but 4663 is refused as soon as `connect()`
reads it.

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
balance    0.049934 USDG
per call   0.10 USDG
daily left 0.46 USDG of 0.50 USDG
state      active
preview    Mandate 0x420BeB507F72173E7d78e0f956968f64fb508356 refused a 0.05 USDG payment to
0x000000000000000000000000000000000000dEaD: the merchant is not on its allowlist. The principal adds one with setMerchant.
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
allowance the spend consumed is credited back to the window it came from. The escrow opens no lock
under its floor, `terms.minLock` on the escrow client, and `pay` refuses a smaller amount before
anything is sent.

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

At or above the approval threshold the agent cannot act alone. The principal signs consent out of
band, on a client of its own for the same account, and the agent's client carries it into `pay`:

```ts
// The principal's own client for the account. A Safe or a hardware wallet comes in as walletClient.
const principal = await mandateAccount(mandate.address, { account: PRINCIPAL_KEY });

// The account checks the expiry against the chain's clock, so the hour starts at the latest block.
const { timestamp } = await mandate.connection.publicClient.getBlock();

const consent = await principal.signApproval({
  merchant: provider,
  capability: 'gpu.render:1',
  amount: usdg('25'),
  expiry: timestamp + 3600n,
});

await mandate.pay({ to: provider, amount: usdg('24'), capability: 'gpu.render:1', approval: consent });
```

The approval is single use and expires on its own. Once used or revoked, its id stays burned for the
life of the account, even across a change of principal. The signed amount is a ceiling, so a quote
that settles under it still clears.

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

There are three lanes, and they differ in whose money moves and what the chain counts.

**`lane: 'mandate'`** pays from the mandate account. The account's `spend` locks the quoted price in
escrow for the provider, under the same checks as `pay`, and the retry names that lock. The daily
and monthly windows move by the amount paid, and a call they do not cover is refused by the
contract. The provider has to offer the `escrow` scheme. The lock publishes the call it pays for as
its input: the method, the endpoint (the URL without its query) and a commitment to the request
body. The provider's facilitator holds that commitment to the request it received, so the lock
cannot be redeemed against another one, and a resolver reading a disputed lock finds the job on
chain. The body, its digest and the URL's query are never written to the chain. `payment.nonce` is
the name the facilitator records the settlement under, derived from the lock.

**The wallet lane**, the default, pays from the agent's own wallet with a single-use EIP-3009
authorization for the exact amount quoted, under the `exact` scheme. Per-call only; windows
client-enforced. Each payment is checked against the mandate's per-call cap, its merchant and
capability allowlists, and whether it is active, but the windows are read and never debited: a
payment larger than what a window has left is refused, and payments that each fit keep clearing,
however many there are. Use it only where the provider offers nothing else.

**`lane: 'base'`** pays a service on Base in USDC, from the mandate. The x402 ecosystem settles the
`exact` scheme in USDC on Base, and a mandate holds USDG on Robinhood Chain; this lane is how the one
reaches the other. The client asks Bursar's facilitator what the lock has to hold, the account's
`spend` locks that USDG for the facilitator's Base lane address under the same checks as `pay`, and
the facilitator signs the USDC authorization from a float it holds on Base. The retry carries that
signature; the service's own facilitator settles it. Once USDC reports the transfer, the lock
settles to the facilitator. A transfer the service never takes leaves the authorization to expire,
and the facilitator returns the lock to the mandate, windows and all. One USDG buys one USDC, plus a
fee the quote states. The owner sees the lock in Settlements like any other. A refusal from the
facilitator is a `BaseLaneRefusedError` with the reason and a sentence that says whose it is;
nothing is locked when it comes at the quote. `facilitator` names the facilitator, and defaults to
`facilitator.bursar.world`.

```ts
const paid = await mandate.fetch('https://api.402rates.com/v1/ping', {
  capability: 'service:demo.x402:1',
  lane: 'base',
});
paid.payment?.base; // the facilitator's record, the lock in USDG, the fee, and when the authorization expires
```

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

A capability is allowed the way `pay` spends it. A bare label such as `gpu.render:1` is allowed as a
service, which is the class `pay` spends in, and `allowsCapability('gpu.render:1')` reads the same
entry. A hire is allowed by its class name, `setCapability('hire:research.summarize:1', true)`, and a
32-byte id is stored as given.

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

A payout the token issuer blocks, because it has frozen the receiving address, does not hold up the
rest of the settlement. The escrow keeps it as owed to that address: `jobs.owed(address)` reads it
and `jobs.claim(address)` pays it out once the address can receive. Anyone can send the claim, and
the money only ever goes to the address it is owed to.

## Running against a local chain

The contracts ship a local rehearsal that deploys the whole set onto anvil, answering as chain 4663,
with stand-ins for USDG, the stock tokens, their price feeds and their pools, and writes every
address it used to a deployment record. `contracts/script/local/rehearse.sh` runs it end to end and
stops its node when it finishes, so to keep a chain for the examples below, start the node yourself:

```sh
anvil --chain-id 4663
```

Then, in a second terminal and from `contracts/`, with the dependencies installed as
[`contracts/README.md`](../../contracts/README.md) describes, run the deploy scripts the rehearsal
runs:

```sh
source script/env/local.env
send() { script=$1 sender=$2; shift 2; forge script "$script" --rpc-url http://127.0.0.1:8545 --unlocked --sender "$sender" --broadcast "$@"; }
send script/local/LocalFixtures.s.sol 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
for step in Deploy DeployToken DeployStaking DeployRwa DeployCollateral; do send "script/$step.s.sol" "$BURSAR_DEPLOYER"; done
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"
cast rpc evm_increaseTime 3601 --rpc-url http://127.0.0.1:8545 && cast rpc evm_mine --rpc-url http://127.0.0.1:8545
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
```

Anvil signs every transaction for the account it names, so no key is read. The last four lines put
governance's wiring through the timelock, which among other things names the bond floor that lets
each recorded resolver bond. [`contracts/script/README.md`](../../contracts/script/README.md) covers
each script. The record is written where `BURSAR_RECORD` points, which with the settings in
`script/env/local.env` is `contracts/cache/bursar/local/local-4663.json`.

Hand the record to `connect()` as the scripts wrote it:

```js
import { readFileSync } from 'node:fs';
import { connect } from '@bursar/sdk';

const record = JSON.parse(readFileSync(process.env.BURSAR_RECORD, 'utf8'));
const connection = connect({ deployment: record, rpc: 'http://127.0.0.1:8545', account: KEY });
```

`connect()` checks the record and reads it the way it reads the ones it ships. Every client on the
connection then takes its addresses from that record, the stock router, the treasury park, the
collateral vault and the credit pool included, and none of them falls back to the mainnet addresses
this package carries. A lane can also be handed over directly, as `rwa(mandate, record.rwa)` or
`collateral(mandate, record.rwa)`.

The record holds only on the node it was written against. Pointed at any other node, the first call
on the connection fails with `NotAnvilError`. Once that anvil node restarts, the chain it held is
gone, and a connection opened on the record fails with `NotDeployedError` until the deploy scripts
run again and write a new one.

The examples below run on that chain, from a project that depends on the SDK (see
[Install](#install)), with the record's path in `BURSAR_RECORD`:

```sh
BURSAR_RECORD=/path/to/bursar/contracts/cache/bursar/local/local-4663.json node buy.mjs
```

They share one helper for what only a local chain allows: a fresh funded key, tokens minted from the
stand-ins, a clock moved on, and a signature from an address anvil impersonates.

```js
// local.mjs: the rehearsal's chain, and the few things only a local chain lets you do.
import { readFileSync } from 'node:fs';
import { createTestClient, createWalletClient, http, parseAbi, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { connect } from '@bursar/sdk';

export const RPC = 'http://127.0.0.1:8545';
export const record = JSON.parse(readFileSync(process.env.BURSAR_RECORD, 'utf8'));

const node = createTestClient({ mode: 'anvil', transport: http(RPC) });
const abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function fund(uint256 amount)',
]);

/** Sends as one of anvil's own accounts, or as an address it has been told to impersonate. */
function send(from, call) {
  return createWalletClient({ account: from, transport: http(RPC) }).writeContract({ ...call, abi, chain: null });
}

/** A new key with ETH for gas, connected to the rehearsal's contracts. */
export async function wallet() {
  const key = generatePrivateKey();
  const { address } = privateKeyToAccount(key);
  await node.setBalance({ address, value: parseEther('1') });
  return { address, connection: connect({ deployment: record, rpc: RPC, account: key }) };
}

/** Mints from the rehearsal's stand-ins for USDG and the stock tokens, which mint to anyone. */
export async function mint(token, to, amount) {
  await send(record.deployer, { address: token, functionName: 'mint', args: [to, amount] });
}

/** Funds the credit pool as its lender. The rehearsal leaves it empty. */
export async function lend(amount) {
  const { CreditPool, lender } = record.rwa.collateral;
  await mint(record.settlementAsset, lender, amount);
  await send(lender, { address: record.settlementAsset, functionName: 'approve', args: [CreditPool, amount] });
  await send(lender, { address: CreditPool, functionName: 'fund', args: [amount] });
}

/** BRSR from the rehearsal's community allocation, for a resolver's bond. */
export async function brsrTo(to, amount) {
  await send(record.roles.community, { address: record.token.BRSR, functionName: 'transfer', args: [to, amount] });
}

/** Moves the chain's clock on, as waiting would. */
export async function wait(seconds) {
  await node.increaseTime({ seconds: Number(seconds) });
  await node.mine({ blocks: 1 });
}

/**
 * A connection that signs as an address whose key is not on this machine. The rehearsal seats
 * three placeholder resolvers, and anvil sends for any address it is told to impersonate.
 */
export async function impersonate(address) {
  await node.impersonateAccount({ address });
  await node.setBalance({ address, value: parseEther('1') });
  const walletClient = createWalletClient({ account: address, transport: http(RPC) });
  return connect({ deployment: record, rpc: RPC, walletClient });
}
```

## Buying stock

`rwa(mandate)` buys eligible stock tokens for a mandate and parks its idle USDG. A purchase is a
spend in the `rwa` class: the mandate has to allow the class, and the purchase counts against the
same caps as a payment. Before the agent can buy, the principal points the mandate at the lane's
router with `useRouter()` and lists what it may buy with `setPolicy()`. A mandate with no list buys
nothing. A purchase carries no approval, so one at or above the approval threshold is refused.

```js
// buy.mjs
import { formatUnits } from 'viem';
import { createMandate, formatUsdg, mandateAccount, rwa, usdg } from '@bursar/sdk';
import { mint, record, wallet } from './local.mjs';

const principal = await wallet();
const agent = await wallet();
await mint(record.settlementAsset, principal.address, usdg('100'));

const mandate = await createMandate(principal.connection, {
  principal: principal.address,
  agent: agent.address,
  limits: {
    perCallCap: usdg('10'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('200'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('20'),
    classes: ['service', 'hire', 'rwa'],
  },
});
await mandate.deposit(usdg('50'));

// The principal points the mandate at the lane's router and lists what the agent may buy.
const stocks = rwa(mandate);
await stocks.useRouter();
await stocks.setPolicy({ slippageBps: 0, allow: ['SPY'] });

// The agent buys, inside the same limits it pays under.
const shopper = rwa(await mandateAccount(mandate.address, agent.connection));
const bought = await shopper.buy('SPY', usdg('5'));
const [spy] = (await shopper.holdings()).filter((holding) => holding.raw > 0n);

console.log('bought  ', formatUnits(bought.amountOut, spy.asset.decimals), 'SPY for', formatUsdg(bought.usdgIn));
console.log('worth   ', formatUsdg(spy.value), 'at the feed price');
console.log('left    ', formatUsdg(await mandate.balance()), 'in the mandate');

try {
  await shopper.buy('NVDA', usdg('5'));
} catch (error) {
  console.log('refused ', error.message);
}
```

```
bought   0.006473574322038947 SPY for 5.00 USDG
worth    4.992502 USDG at the feed price
left     45.00 USDG in the mandate
refused  NVDA is not on this mandate’s purchase list, and a mandate buys only what its principal has listed. The principal adds it with setPolicy, under allow. Nothing was bought.
```

A refusal on the lane is a `CallRefusedError`. Its `errorName` is the contract's own name for the
condition, and its message says what the condition is and who can clear it. A limit the mandate
itself enforces refuses a purchase with a `MandateDeniedError`, as it refuses a payment.

## Parking idle USDG

USDG above a buffer the principal sets can sit in a registered treasury fund, SGOV at launch.
`park(amount)` moves it from the mandate into the fund in two transactions, and checks the buffer
and the fund's caps before it sends either. `spendingPower()` counts parked value at the feed price
less the fund's haircut, and `unpark()` sells it back into the mandate.

```js
// park.mjs
import { createMandate, formatUsdg, rwa, usdg } from '@bursar/sdk';
import { mint, record, wallet } from './local.mjs';

const principal = await wallet();
const agent = await wallet();
await mint(record.settlementAsset, principal.address, usdg('100'));

const mandate = await createMandate(principal.connection, {
  principal: principal.address,
  agent: agent.address,
  limits: {
    perCallCap: usdg('10'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('200'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('20'),
  },
});
await mandate.deposit(usdg('60'));

// Keep 20 USDG liquid, and park 30 of the rest in the treasury fund.
const treasury = rwa(mandate);
await treasury.setBuffer(usdg('20'));
await treasury.park(usdg('30'));

const [sgov] = await treasury.parked();
console.log('parked    ', formatUsdg(sgov.basis), 'in', sgov.symbol, 'worth', formatUsdg(sgov.value));
console.log('liquid    ', formatUsdg(await mandate.balance()));
console.log('can spend ', formatUsdg(await treasury.spendingPower()));

try {
  await treasury.park(usdg('15'));
} catch (error) {
  console.log('refused   ', error.message);
}

await treasury.unpark('SGOV');
console.log('unparked  ', formatUsdg(await mandate.balance()), 'liquid');
```

```
parked     30.00 USDG in SGOV worth 29.958761 USDG
liquid     30.00 USDG
can spend  59.808967 USDG
refused    After this move the mandate holds 15.00 USDG, under the 20.00 USDG its principal set to keep liquid. Nothing was parked. Park less, or lower the buffer with setBuffer.
unparked   59.917578 USDG liquid
```

## Listing as a provider

The escrow pays listed providers only. `provider()` opens the registry the connection's escrow
reads. `register()` lists the signer under a display name and pulls its stake in USDG, approving the
registry for exactly that amount first when the allowance is short. A name is 3 to 32 letters,
digits and underscores, `[A-Za-z0-9_]{3,32}`, and anything else is refused before it is sent. The
stake is collateral: a ruling against a job can take part of it, and it leaves only after a
withdrawal delay.

```js
// provider.mjs
import { formatUsdg, provider, usdg } from '@bursar/sdk';
import { mint, record, wallet } from './local.mjs';

const seller = await wallet();
await mint(record.settlementAsset, seller.address, usdg('25'));

const desk = await provider(seller.connection);

try {
  await desk.register({ name: 'render farm', stake: usdg('5') });
} catch (error) {
  console.log('refused  ', error.message);
}

await desk.register({ name: 'render_farm', stake: usdg('5') });
await desk.addStake(usdg('10'));

const status = await desk.status();
console.log('listed   ', status.name, status.active ? 'and active' : 'and inactive');
console.log('stake    ', formatUsdg(status.stake), 'with', formatUsdg(status.maxSlash), 'at risk in one ruling');
console.log('ceiling  ', formatUsdg((await desk.reputationOf()).cap), 'per job');
console.log('next     ', status.next);
```

```
refused   A provider name is 3 to 32 characters of letters, digits and underscore. The registry refuses anything else rather than rendering it, because a handle carrying invisible characters can be read as another provider's.
listed    render_farm and active
stake     15.00 USDG with 1.50 USDG at risk in one ruling
ceiling   25.00 USDG per job
next      Listed and available, with 15.00 USDG of collateral posted and up to 1.50 USDG of it at risk in any single ruling.
```

### What a score is made of

The ceiling on a single job follows from the provider's score by a published curve: 25 USDG at a
score of nothing, 2.25 USDG more for every point, 250 USDG at the top. From v4 the score is paid for
in delivered work rather than counted in jobs. A job counts only at `weights.minScored` or more. Each
delivered job adds its amount to the provider's credit, with each payer counting for up to
`weights.edgeCap`, and the delivered share of counted jobs is scaled by how much of
`weights.fullCredit` that credit has reached. With the deployed weights, 1, 62.5 and 250 USDG, a full
score takes at least four payers, and one payer paying 25 USDG and then 47.5 USDG takes a clean
record to a score of 25 and a ceiling of 81.25 USDG, where that payer's work stops counting.

`reputationOf()` reports `credit` and `weights` beside the score, null on a deployment from before
v4, and its `next` says which of the two factors is holding the score down. `edgeVolume(payer)` is
what one payer has released so far, uncapped. `projectReleases()` works a list of releases through
the contract's own arithmetic, so a provider can see what finalising is worth before it pays for it:

```js
const desk = await provider(seller.connection);
const projected = await desk.projectReleases([
  { payer: buyer.address, amount: usdg('25') },
  { payer: buyer.address, amount: usdg('47.5') },
]);
console.log('score    ', projected.score, 'cap', formatUsdg(projected.cap));
console.log('credit   ', formatUsdg(projected.credit), 'uncounted', projected.uncounted);
```

```
score     25 cap 81.25 USDG
credit    62.50 USDG uncounted 0
```

A release under the scored minimum, or from the payee itself, is recorded and counts for nothing;
`uncounted` is how many of the releases given were like that. The same functions are exported on
their own as `projectReputation`, `reputationScore`, `capAtScore` and `creditFromRelease`.

## Borrowing against collateral

A mandate created with `lane: 1` in its limits can borrow. Its principal opens a credit line with
`openLine()`, which also names the collateral vault as the mandate's source for a shortfall, and
posts stock or treasury tokens with `deposit()`. From then on, a payment the mandate's USDG cannot
cover draws the difference from the credit pool in the same transaction, once the vault has checked
that the line stays above its draw floor with every position at its after-hours haircut.
`position()` reports the collateral, the debt, what can still be drawn and the health, and
`repay()` pays the debt down from the signer's USDG.

```js
// credit.mjs
import { collateral, createMandate, formatUsdg, mandateAccount, provider, usdg } from '@bursar/sdk';
import { lend, mint, record, wallet } from './local.mjs';

const SPY = record.rwa.assets.SPY.address;
const principal = await wallet();
const agent = await wallet();
const seller = await wallet();
await mint(record.settlementAsset, principal.address, usdg('100'));
await mint(record.settlementAsset, seller.address, usdg('5'));
await mint(SPY, principal.address, 50_000_000_000_000_000n); // 0.05 SPY
await lend(usdg('50'));

// The escrow pays listed providers only.
await (await provider(seller.connection)).register({ name: 'render_farm', stake: usdg('5') });

const mandate = await createMandate(principal.connection, {
  principal: principal.address,
  agent: agent.address,
  limits: {
    perCallCap: usdg('10'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('200'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('20'),
    lane: 1,
  },
});
await mandate.setMerchant(seller.address, true);
await mandate.setCapability('gpu.render:1', true);
await mandate.deposit(usdg('3'));

// The principal opens the line and posts SPY against it.
const line = collateral(mandate);
await line.openLine();
await line.deposit('SPY', 50_000_000_000_000_000n);
console.log('can draw  ', formatUsdg((await line.position()).headroom));

// The mandate holds 3 USDG. The agent pays 8, and the other 5 are drawn in the same transaction.
const agentView = await mandateAccount(mandate.address, agent.connection);
const paid = await agentView.pay({ to: seller.address, amount: usdg('8'), capability: 'gpu.render:1' });
const drawn = await line.position();
console.log('paid      ', formatUsdg(paid.amount), `into escrow ${paid.escrowId}`);
console.log('owes      ', formatUsdg(drawn.debt), 'at health', drawn.health);

try {
  await agentView.pay({ to: seller.address, amount: usdg('9'), capability: 'gpu.render:1' });
} catch (error) {
  console.log('refused   ', error.message);
}

const repaid = await line.repay();
console.log('repaid    ', formatUsdg(repaid.amount), 'and owes', formatUsdg(await line.debt()));
```

```
can draw   10.00 USDG
paid       8.00 USDG into escrow 1
owes       5.00 USDG at health 6.169701
refused    This draw would bring the mandate’s debt to 14.00 USDG, over the 10.00 USDG one mandate may owe the pool. Repay some of it, or spend less on credit.
repaid     5.000001 USDG and owes 0.00 USDG
```

### When a position counts for nothing toward a draw

From v4 the vault counts a position toward a draw only while the price guard's draw rule passes it:
the feed answered recently enough, the guard holds a reading of the asset's pool that is between
five minutes and an hour old in which the pool agreed with the feed, the feed has not moved more than
15% since that reading, and the pool agrees with the feed now. A position that fails any of these is
still valued and still counts toward health; it carries no draw. `headroom` then reads lower than the
collateral suggests, and a draw that leaned on it is refused with `HealthTooLow`.

`drawStanding()` says, per asset the vault accepts, whether a draw counts it and the first condition
it fails, each with a sentence that says what clears it. A `HealthTooLow` from `pay`, `buy` or
`withdraw` is read against the same rule before it is worded, so the error names the position the
check could not count rather than the general rule. `observationBounds()` reads the guard's three
bounds. On a lane from before v4 `drawStanding()` is empty and the bounds are undefined.

```js
for (const standing of await line.drawStanding()) {
  console.log(standing.symbol, standing.halt, standing.refusal?.message ?? '');
}
```

```
SGOV None
SPY NoObservation SPY counts for nothing toward a draw yet: the price guard holds no reading of its pool old enough to count. A draw needs the pool to have agreed with the feed at a reading taken at least 5m earlier. observe() records one, and a second call 5m later puts it in force. Anyone may send both.
```

A write-off also seizes whatever the line still held, for the credit pool's lender, who carried the
loss. `seized()` lists what is waiting per asset and `claimSeized(asset)` pays it to the lender;
anyone may send the claim and only the lender is paid. Both are refused on a lane from before v4,
which left a written-off line holding what could not be sold.

## Contesting a payment

While the escrow still holds a payment, the mandate's principal can contest it with
`disputeSpend()`. The mandate posts a bond from its own balance, and bonded resolvers rule. Each seals
a score from 0 to 100 during the commit window and publishes it afterwards, and anyone can close the
vote once every sealed score is out or the reveal window has shut. The escrow then splits the payment
on the median.

`mandate.disputeOf(escrowId)` and `disputes(connection).of(escrowId)` read the dispute and the ruling
from the payer's side. `resolver()` is the resolver's side, from bonding BRSR to claiming rewards in
USDG. `commit()` returns the salt that opens the sealed score, and nothing else opens it, so keep it
until the reveal. On the rehearsal the resolver seats belong to placeholder addresses, and the
example has anvil sign for two of them.

```js
// dispute.mjs
import { createMandate, disputes, formatUsdg, mandateAccount, parseBrsr, provider, resolver, usdg } from '@bursar/sdk';
import { brsrTo, impersonate, mint, record, wait, wallet } from './local.mjs';

const principal = await wallet();
const agent = await wallet();
const seller = await wallet();
await mint(record.settlementAsset, principal.address, usdg('100'));
await mint(record.settlementAsset, seller.address, usdg('5'));
await (await provider(seller.connection)).register({ name: 'render_farm', stake: usdg('5') });

const mandate = await createMandate(principal.connection, {
  principal: principal.address,
  agent: agent.address,
  limits: {
    perCallCap: usdg('10'),
    dailyCap: usdg('50'),
    monthlyCap: usdg('200'),
    dailyWindow: 86_400,
    monthlyWindow: 2_592_000,
    approvalThreshold: usdg('20'),
  },
});
await mandate.setMerchant(seller.address, true);
await mandate.setCapability('gpu.render:1', true);
await mandate.deposit(usdg('20'));

const agentView = await mandateAccount(mandate.address, agent.connection);
const { escrowId } = await agentView.pay({ to: seller.address, amount: usdg('10'), capability: 'gpu.render:1' });

// Nothing is delivered, and the principal contests the payment while the escrow still holds it.
await mandate.disputeSpend(escrowId);
const opened = await mandate.disputeOf(escrowId);
console.log('opened   ', `dispute ${opened.disputeId}, ${opened.phase}, bond ${formatUsdg(opened.bond)}`);

// Two of the rehearsal's three seated resolvers bond, unless an earlier run left them bonded, and
// each seals a score and publishes it.
const [first, second] = record.roles.resolvers;
const panel = [];
for (const [seat, score] of [[first, 10], [second, 20]]) {
  const judge = await resolver(await impersonate(seat));
  if ((await judge.status()).standing !== 'active') {
    await brsrTo(seat, parseBrsr('30000'));
    await judge.bond(parseBrsr('30000'));
  }
  const [open] = await judge.openDisputes();
  panel.push({ judge, sealed: await judge.commit({ disputeId: open.disputeId, score }) });
}

await wait(panel[0].judge.terms.commitWindow + 1n);
for (const { judge, sealed } of panel) await judge.reveal(sealed);
await panel[0].judge.finalize(opened.disputeId);

const { ruling, next } = await (await disputes(principal.connection)).of(escrowId);
console.log('median   ', ruling.medianScore);
console.log('refunded ', formatUsdg(ruling.refundedToPayer), 'to the mandate');
console.log('paid     ', formatUsdg(ruling.paidToProvider), 'to the provider');
console.log('bond     ', ruling.bondReturned ? 'returned' : 'forfeit');
console.log('next     ', next);
```

```
opened    dispute 1, committing, bond 0.50 USDG
median    15
refunded  9.95 USDG to the mandate
paid      0.00 USDG to the provider
bond      returned
next      The resolvers scored the delivery 15 out of 100 and the escrow has moved the money on that ruling. Nothing further to decide.
```

Run again on the same chain, it opens dispute 2, and the two seats the first run bonded vote
without bonding again.

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
- The caps on mainnet are deliberately low, and [SECURITY.md](../../SECURITY.md) has the review
  status and the trust assumptions behind them. Size mandates accordingly.

## License

MIT. See [LICENSE](../../LICENSE).
