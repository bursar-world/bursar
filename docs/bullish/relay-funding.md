# Fund a mandate from Solana, Base or Arc in one step · Relay

**The sentence:** fund a Bursar mandate from Solana, Base or Arc in one step. Relay carries the transfer.

A treasurer who holds USDC on Base, Arc or Solana opens a mandate in the console, chooses the chain, types an
amount and sees Relay's quote: what the mandate receives in USDG, what it costs and how long it takes. On Base
and Arc they sign the deposit in the wallet they already have connected. On Solana they sign in their Solana
wallet on Relay's own page, with the mandate already filled in as the recipient. The panel follows the transfer
until the USDG is in the mandate and links the deposit, the landing and Relay's own record of it.

## What is live and what is prepared

Live on this branch, verified against Relay's production API on 2026-10-10:

- `apps/web/src/relay/`: the three source chains, the quote request and its parse, the status parse, the poll
  cadence and the client. Pure functions, tested against Relay's real responses.
- `apps/web/src/app/api/relay/`: two routes that forward one narrow request each to `api.relay.link`, so a Relay
  key stays on the server. Without a key the routes still work and Relay answers as it answers anyone.
- The "Fund from another chain" section at the foot of every mandate's Funding panel, and `/demo/relay-funding`,
  which mounts the live panel on the example mandate with the three steps written out above it.
- `apps/web/scripts/relay-fund.ts`: the same quote and the same steps from a terminal, signed with `cast`.
- The wallet config lists Base and Arc after Robinhood Chain, so a connected wallet can be asked to switch to one
  for the deposit. Every write to the contracts stays pinned to Robinhood Chain.

Prepared, not run for real:

- The Arc leg. Quoted and parsed against Relay (same shape as Base, chain 5042, USDC at
  `0x3600000000000000000000000000000000000000`); not sent, because the demo budget went to the Base leg.
- The Solana leg. Quoted and parsed; no Solana wallet is wired into the console, and no key this build may use
  holds anything on Solana. Relay's deposit-address path for Solana needs a Relay API key (see operator actions).

## The demo, and what ran on mainnet

`https://app.bursar.world/demo/relay-funding` once the branch is deployed. Locally:

```
pnpm --filter @bursar/web build && pnpm --filter @bursar/web start
open http://127.0.0.1:4310/demo/relay-funding
```

Type an amount to see Relay's quote. Connect a wallet that holds USDC on Base or Arc and press "Fund from Base"
(or Arc): one approval, one deposit, then the panel reports the USDG landing in the mandate.

From a terminal, with no console:

```
cd apps/web
npx tsx scripts/relay-fund.ts quote --from base --amount 0.50 --mandate 0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c --user <your address>
npx tsx scripts/relay-fund.ts send  --from base --amount 0.50 --mandate 0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c --keystore <path> --password-file <path>
npx tsx scripts/relay-fund.ts watch --request 0x… --from base
```

### What ran for real, 2026-10-10

The demo payer funded the example mandate `0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c` with 0.50 USDC from Base,
through the panel on `/demo/relay-funding` on a local build of this branch, signed by the test wallet harness:

| | |
| - | - |
| Deposit on Base | `0x2bb6879d237b7b544e0a2fd177df35435fd4801a90b474d092120f7d272ad643`, block 52437933, 53,762 gas, `https://basescan.org/tx/0x2bb6879d237b7b544e0a2fd177df35435fd4801a90b474d092120f7d272ad643` |
| Relay request | `0x17916652095885fae9c742cdabe2f36721da569be3a9633339da3775545a7ec4`, `https://relay.link/transaction/0x17916652095885fae9c742cdabe2f36721da569be3a9633339da3775545a7ec4` |
| USDG landing on Robinhood Chain | `0xc90d0220f9d2bfb8bc8919171c25e5773d2301d02db95c21a8d59cf9b8373ce8`, block 85289629, a USDG transfer of 0.475129 to the mandate from Relay's solver, `https://robinhoodchain.blockscout.com/tx/0xc90d0220f9d2bfb8bc8919171c25e5773d2301d02db95c21a8d59cf9b8373ce8` |
| Quote to landing | 34 seconds from the quote to Relay's `success`, with the signature and the Base confirmation inside it; the fill itself took about two seconds |
| The mandate | held $1.89 before and $2.37 after |

The USDC approval was signed in an earlier attempt on the same day (the payer's first transaction on Base), which is
why the recorded run shows one signature: Relay's quote drops the approval step once the allowance exists.

Funding the payer for the demo also went through Relay, from Robinhood Chain to Base: 0.00022 ETH became 0.527
USDC (`0x28111ba06724d902dd4092ad686a198a869f78f0725b02d90e60d42d1ec8a448` on Robinhood Chain) and 0.00003 ETH
became gas on Base (`0xdec3ad6ec061d95de95b73c2001f6888ed2bc1aac490cd7902abcfac0910b2ad`), each filled within
three seconds. Total spent from the demo keys: 0.00025 ETH, of which $0.475 came back as USDG in the example
mandate.

Not run for real: Arc and Solana. Both were quoted and parsed against Relay's production API and both parses
are tested; the budget went to the Base leg.

## Relay, as its API answered

Relay (`https://api.relay.link`) lists Robinhood Chain (4663, USDG `0x5fc5…d168` as a solver currency, deposits
enabled), Base (8453, USDC `0x8335…2913`), Arc (5042, USDC `0x3600…0000`, six decimals; the gas token is also
called USDC and has eighteen) and Solana (Relay id 792703809, USDC `EPjF…Dt1v`). Deposits are enabled on all four.

### The quote

`POST /quote`, no key needed:

```json
{
  "user": "0x877c349EFb5926082C413833E8055F0991185c61",
  "recipient": "0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c",
  "originChainId": 8453,
  "destinationChainId": 4663,
  "originCurrency": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "destinationCurrency": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  "amount": "500000",
  "tradeType": "EXACT_INPUT"
}
```

Arc: `originChainId: 5042`, `originCurrency: "0x3600000000000000000000000000000000000000"`. Solana:
`originChainId: 792703809`, `originCurrency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"`, `user` a Solana
address. `useDepositAddress: true` asks for an address to send to instead of transactions; Relay grants it on Base
without a key and refuses it on Solana without one (`UNAUTHORIZED`, "missing an api key and cannot use a deposit
address").

What came back for 0.50 USDC on Base (the full bodies are the fixtures under `apps/web/test/fixtures/relay/`):

| | Base | Arc | Solana |
| - | - | - | - |
| `requestId` | `0x1791…0466` | `0x1791…63af` | `0x1791…62e3` |
| arrives (`details.currencyOut.amount`) | 0.475149 USDG | 0.474845 USDG | 0.475009 USDG |
| at least (`minimumAmount`) | 0.453672 | 0.453382 | 0.453538 |
| Relay fee (`fees.relayer.amountUsd`) | $0.0248 | $0.0251 | $0.0249 |
| source gas (`fees.gas.amountUsd`) | $0.0012 | $0.0017 | $0.0221 (0.0002 SOL) |
| `timeEstimate` | 1 s | 1 s | 1 s |
| steps | `approve` then `deposit`, both `kind: transaction` on 8453 | same, on 5042 | one `deposit` carrying Solana `instructions` |

Each EVM step item carries `data: { from, to, data, value, chainId, gas, maxFeePerGas, maxPriorityFeePerGas }`:
an ERC-20 `approve` of the amount to Relay's depository `0x4cd00e387622c35bddb9b4c962c136462338bc31`, then a
call to that depository with the amount and the order id. The deposit item carries
`check: { endpoint: "/intents/status?requestId=…", method: "GET" }`. With `useDepositAddress: true` on Base the
single step is a plain USDC transfer to the returned `depositAddress` (`0x55747ed9…c30b` in the fixture).

Relay's fee is close to flat at this size, about $0.025 per transfer, so a $0.50 deposit lands as $0.475 and a
$50 deposit as $49.96. Relay quoted 0.10 USDC without refusing it (arriving as 0.075 USDG); it names no minimum,
the fee does.

### The status

`GET /intents/status/v3?requestId=…`, no key needed. Answers `{ status, inTxHashes, txHashes, updatedAt,
originChainId, destinationChainId, quoteCreatedAt, failReason }` with `status` one of `waiting`, `depositing`,
`pending`, `submitted`, `delayed`, `success`, `refund`, `failure`. A fresh quote answers
`{ "status": "waiting", "quoteCreatedAt": … }`; the v1 path answers `unknown` for the same id. `txHashes` is the
fill on Robinhood Chain on success, the refund on the source chain after a refund.

Rate limits without a key are Relay's public ones; with a key, 50 quotes a minute and 200 status checks a minute
per key, more on request.

## What the operator does

1. Push the branch and deploy as usual. No new service, no contract, no governance action.
2. Optional, recommended: create a Relay API key at `https://dashboard.relay.link` and set `RELAY_API_KEY` on the
   web service. It gives the deployment its own rate limit and turns the Solana path from "sign on Relay's page"
   into "send USDC to this address", which also works from an exchange withdrawal. The variable is server-side
   only; nothing changes in the browser.
3. Keep the budget: the demo moved $0.50. Nothing else is owed.

## Limits, stated plainly

- Relay's fee is about $0.025 per transfer regardless of size, plus the source chain's network fee. Small amounts
  are expensive in proportion: $0.50 arrives as about $0.475, $50 as $49.96.
- Relay promises a minimum (`minimumAmount`, about 4.5% under the expected amount at $0.50; 2% at $50). If the
  price moves past it before the fill, Relay refunds on the source chain and the panel says so.
- Base and Arc sign in the connected wallet. The wallet has to hold USDC there and a little of that chain's gas
  token (ETH on Base, USDC on Arc).
- Solana has no wallet in this console. Without a Relay key the reader signs on Relay's page; the panel keeps
  watching the mandate's USDG balance and reports the landing when it sees it, without Relay's request id.
- Safe wallets cannot be switched to another chain from inside the Safe app, so a treasury on a Safe funds from
  Robinhood Chain as before, or sends USDC to a Relay deposit address from the Safe on Base.
- The panel keeps the request in session storage, so a reload mid-transfer resumes it; a closed tab does not.
  The deposit is already with Relay by then and lands regardless.

## Links

- Branch diff: `https://github.com/bursar-world/bursar/compare/main...bullish/relay-funding`
- Relay module: `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/relay/quote.ts`,
  `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/relay/status.ts`,
  `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/relay/chains.ts`
- The panel: `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/app/(app)/console/[mandate]/fund-from-chain.tsx`
  and `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/app/(app)/console/[mandate]/fund-from-chain-view.tsx`
- The routes: `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/app/api/relay/upstream.ts`
- The demo page: `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/src/app/(app)/demo/relay-funding/demo.tsx`
- The terminal script: `https://github.com/bursar-world/bursar/blob/bullish/relay-funding/apps/web/scripts/relay-fund.ts`
- Live, once deployed: `https://app.bursar.world/demo/relay-funding`
- The deposit on Base: `https://basescan.org/tx/0x2bb6879d237b7b544e0a2fd177df35435fd4801a90b474d092120f7d272ad643`
- The landing on Robinhood Chain: `https://robinhoodchain.blockscout.com/tx/0xc90d0220f9d2bfb8bc8919171c25e5773d2301d02db95c21a8d59cf9b8373ce8`
- Relay's record: `https://relay.link/transaction/0x17916652095885fae9c742cdabe2f36721da569be3a9633339da3775545a7ec4`

Screenshots and the recording are beside this file under `relay-funding/`, all 1440×900 from the local build on
mainnet: `01-demo.png` (the demo page), `02-quote.png` (Relay's quote for 0.50 USDC from Base), `03-deposit.png`
(the deposit signed and Relay paying the mandate), `04-arrived.png` (the USDG in the mandate, with the three
links), and `demo.webm` (the real run, quote to landing, 17 seconds with the arrival held at the end).

The film is `film/relay-funding.ts` in the ops repository's `e2e` harness. Its wallet bridge learned to hold
Base and Arc beside Robinhood Chain for it (`wallet/bridge.ts`: a `chains` option, a chain-aware
`wallet_switchEthereumChain`, and a simulation that asks a public endpoint again before believing a refusal,
because one node can trail another by a block right after the previous receipt). Those edits are in the ops
working tree, not on this branch.

## Announcement

One line:

> Fund a Bursar mandate from Base, Arc or Solana: choose the chain, see the quote, sign once. Relay carries the USDC and USDG lands on Robinhood Chain in seconds.

One paragraph (under the screenshot):

> Treasuries hold USDC where they hold it. A Bursar mandate now takes it from Base, Arc or Solana in one step: pick the chain, type the amount, and the console shows what the mandate receives, what it costs and how long it takes before you sign. Relay carries the transfer and pays the mandate in USDG on Robinhood Chain, usually within a minute. On Base and Arc you sign in the wallet you already have connected. On Solana you sign in your Solana wallet on Relay. The panel follows the transfer until the USDG lands and links every transaction on both chains.

Post:

> A mandate is only as useful as it is easy to fund.
>
> Until now, funding a Bursar mandate meant holding USDG on Robinhood Chain. Most treasuries hold USDC on Base, on Arc or on Solana instead.
>
> From today the Funding panel on every mandate has a second way in. Choose the chain your USDC is on and type an amount. Relay quotes the transfer: what the mandate receives in USDG, what it costs, how long it takes. At $50 the fee is about three cents and the USDG is in the mandate within a minute of your deposit confirming.
>
> On Base and Arc the deposit is signed in the wallet you already have connected to the console. On Solana you sign in your Solana wallet on Relay's own page, with the mandate filled in as the recipient. Either way the panel follows the transfer until the USDG lands, and links the deposit, the landing and Relay's record of it.
>
> Relay carries the funds and pays the mandate from its own balance on Robinhood Chain. Bursar never holds them. The quote shows the least the mandate will receive; if the price moves past it, Relay refunds on the chain you sent from and the panel says so.
>
> Try it on the example mandate: app.bursar.world/demo/relay-funding

## Progress

- 17:30 UTC. Relay facts gathered against production: chains, four quotes, status shapes, docs. Base top-up of
  the demo payer sent from Robinhood Chain through Relay (0.00022 ETH → 0.527 USDC, 0.00003 ETH → 0.0000217 ETH
  on Base), both filled in under three seconds.
- 17:45 UTC. Relay module, proxy routes, panel, demo page, terminal script and 46 tests on the branch; console
  typechecks; 931 tests green. The wallet harness in ops/e2e learned to hold Base and Arc beside Robinhood Chain
  for the film.
- 20:35 UTC. Console built and run locally. First film attempt: the approval landed on Base and the deposit was
  refused by the test wallet's own simulation, because the public Base endpoint answered the simulation from a
  node a block behind the one that had reported the approval. The harness now asks again before believing a
  refusal. Second attempt: the panel's failure was replaced by a fresh quote before anyone could read it; the
  panel now keeps a failure on screen until the reader touches the form. Third attempt: the keyless dRPC Base
  endpoint refused the simulation call; the harness signs on Base through `mainnet.base.org` again.
- 20:46 UTC. Fourth attempt ran end to end: one signature on Base, Relay's fill on Robinhood Chain, the panel
  reporting the arrival. Transactions above. Screenshots and the recording saved.
- 20:50 UTC. A refused deposit now reads as one sentence with viem's short message, and a deposit that went out
  is followed even when its receipt does not come back. Console rebuilt and checked with a dry run.
