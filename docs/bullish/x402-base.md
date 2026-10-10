# x402 on Base, paid from a Bursar mandate

**The sentence:** a Bursar mandate pays any x402 service on Base in USDC, settled through Bursar's
facilitator.

The agent calls `mandate.fetch(url, { lane: 'base' })`. The mandate locks USDG on Robinhood Chain under
its own limits, Bursar's facilitator pays the service in USDC from a float it holds on Base, and the lock
settles to the facilitator once the USDC has moved. A payment the service never takes returns to the
mandate. The owner sees every call in Settlements, in USDG, with the limits, payee rules and capability
rules the mandate already has.

## Design

### Parties

| Party | Chain | Role |
|---|---|---|
| Agent, through the SDK | | Calls the service, opens the lock, carries the payment header. Holds the agent key and nothing else. |
| Mandate account | Robinhood Chain 4663 | `spend` checks every limit and moves USDG into an escrow lock payable to the facilitator's Base lane address. |
| Escrow | Robinhood Chain 4663 | Holds the lock. The payee releases it once the Base payment is confirmed, or cancels it to return the funds. |
| Bursar facilitator | both | Quotes, verifies the lock, signs the USDC authorization from its Base float, watches Base, settles or returns the lock. |
| The Base service and its facilitator | Base 8453 | Any x402 resource that accepts the `exact` scheme in USDC. Its own facilitator (Coinbase's, for most of the Bazaar) verifies the authorization and settles `transferWithAuthorization` on Base. |

One key serves the lane on both chains. On Base its address holds the USDC float and signs the
authorizations. On Robinhood Chain the same address is the payee of every lock the lane opens, which is
what lets it release and cancel them, and it is where the released USDG lands. The operator sweeps that
USDG and refills USDC on Base; the lane keeps the two sides in one ledger so the gap is always visible.

### Message flow

1. The SDK sends the request. The service answers 402 with its offers. The SDK takes the cheapest
   `exact` offer in USDC on `eip155:8453` that fits `maxAmount`, if one was given.
2. The SDK asks the facilitator for a quote: `POST /base/quote { amount, payTo, resource }`. The
   facilitator answers the lock it needs: payee (the Base lane address), amount in USDG, the fee, and
   how long the authorization will be valid. A float that cannot cover the amount on top of what it has
   already promised refuses here, before anything is locked.
3. The SDK asks the mandate whether it would pay that lock (`assertCanPay`), then opens it with the
   mandate's own `spend`. The lock's published input is the request document the mandate lane already
   uses: method, resource and the request-bound nonce derived from the body digest and a salt the payer
   keeps. The owner sees the lock in Settlements the moment it lands.
4. The SDK sends the lock and the service's offer to the facilitator: `POST /base/pay { lock, binding,
   offer }`. The facilitator reads the lock on chain (open, opened by a mandate account from a known
   factory, payable to the lane address, for the quoted amount, bound to this request, with enough
   deadline left), records it in the lane ledger under the lock's identity so one lock yields one
   authorization, and signs an EIP-3009 `TransferWithAuthorization` from the float: to the service's
   `payTo`, for the USDC amount, nonce derived from the same binding, valid until the offer's timeout
   plus a margin. The signature travels back to the SDK.
5. The SDK retries the request with the payment header. The service's facilitator settles the
   authorization on Base: USDC moves from the float to the service. The service answers 200 and the
   settlement header, or refuses.
6. The SDK reports what it saw to the facilitator (`POST /base/payments/{id}/outcome`). The report is
   a hint, never the record.
7. The facilitator's lane worker runs with the maintenance pass. For every signed authorization it asks
   USDC on Base whether the nonce has been used. Used: it finds the Base transaction and releases the
   lock on Robinhood Chain, with the Base transaction hash as the output commitment. Unused and past
   its validity: it cancels the lock, which returns the USDG to the mandate and credits the windows
   through the escrow's callback. Either way the row closes with both hashes.

Why the facilitator never proxies the call: the agent keeps its request and the service's response to
itself, and the facilitator's exposure is exactly one authorization per lock, bounded by the lock. Why
the chain and not the SDK's report decides settlement: the authorization state on USDC is the one fact
neither party can fake.

### Where each failure is handled

| Failure | Where | What happens |
|---|---|---|
| The service offers nothing in USDC on Base | SDK | `NoAcceptablePaymentError`, nothing locked. |
| The float is short, the lane is off, the amount is over the per-payment ceiling | facilitator, at quote | A refusal in the SDK's words (`BaseLaneRefusedError`), nothing locked. |
| The mandate refuses (cap, window, merchant, capability, paused) | mandate, before `spend` | The mandate's own refusal, nothing locked. |
| The lock is not what was quoted, is not bound to the request, or was already paid | facilitator, at pay | Refused, nothing signed. The lock is the mandate's to reclaim with `timeout` after its deadline, or the facilitator cancels it on the next pass if it is payable to the lane. |
| The service refuses the payment or never settles | service | The authorization expires unused. The worker cancels the lock and the mandate's windows are credited back. The SDK throws `PaymentRejectedError` naming the lock and when it returns. |
| USDC moved and the service answered an error | service | The facilitator still releases the lock: the service was paid. The dispute is between the agent and the service, outside Bursar's rails. The SDK surfaces the response as is. |
| Base cannot be read | facilitator worker | The row stays open and is retried next pass. The lock's deadline bounds how long: past it the escrow returns the funds to the mandate on `timeout`. |
| The release or cancel on Robinhood Chain fails | facilitator worker | Retried every pass until the deadline. A row still open at the deadline is counted as stuck in health. |
| The facilitator is down | | No authorization is ever signed, so no USDC moves. A lock opened just before stays reclaimable by the mandate on `timeout`. |

### The float

- `bursar_base_payments` is the per-payment ledger: one row per lock, keyed on the lock's identity
  (chain, escrow, lock id). States: `signed` (an authorization is out and USDC may move until it
  expires), `paid` (USDC moved, release pending), `settled` (lock released), `returned` (authorization
  expired unused, lock cancelled).
- Promised = the USDC sum of `signed` rows. Available = the float's USDC balance less promised. A quote
  or a pay that would leave available under `FACILITATOR_BASE_FLOAT_MINIMUM_MICRO` is refused as
  `base_float_insufficient`.
- `FACILITATOR_BASE_MAX_PAYMENT_MICRO` caps one authorization. Health reports the float address, its
  balance, what is promised, what is available and the count of rows past their deadline.
- The float needs USDC on Base and nothing else there: the service's facilitator pays the gas to settle
  an EIP-3009 authorization. On Robinhood Chain the same address needs a little ETH for release and
  cancel transactions, a registry stake so the escrow admits it as a payee, and a place on each
  mandate's merchant list.

### The fee

One USDG buys one USDC. The lock is the USDC amount plus a fee: the larger of
`FACILITATOR_BASE_FEE_BPS` of the amount and `FACILITATOR_BASE_FEE_FLOOR_MICRO`, and never less than the
escrow's smallest lock (one cent on the live escrow). The quote states the fee as the difference between
the lock and the amount, so a 0.1 cent call shows a one cent lock with a 0.9 cent fee. The escrow takes
its own 1% from the payee's side when the lock releases, out of the facilitator's share.

### Refusals, in the SDK's words

`BaseLaneRefusedError` carries the facilitator's reason and a sentence that names the condition, whose
it is and what to do: `base_lane_off`, `base_float_insufficient`, `base_amount_too_large`,
`base_offer_unsupported`, `base_lock_not_open`, `base_lock_payee_mismatch`, `base_lock_amount_mismatch`,
`base_lock_not_bound`, `base_lock_deadline_too_close`, `base_lock_already_paid`,
`base_payer_not_a_mandate`, `base_lock_unreadable`.

## Progress

- 15:30 UTC: rules, repository, facilitator, SDK and escrow read; Base balances of every Bursar key
  checked (none hold USDC on Base); example mandate state read (agent is the payer key, `payee` is an
  allowed merchant, registered and active); candidate services on the Bazaar read (402rates, Useless
  Facts, Otto, all 0.001 USDC on `eip155:8453` with the USD Coin v2 domain). Design written.
- 20:57 UTC: the two-fork run settled lock 43 end to end; the live run opened lock 44 on mainnet, had
  the service's facilitator refuse the empty float, and the worker returned the lock on its own.
  Screenshots, the recording and both run logs are in `docs/bullish/x402-base/`.
- 17:50 UTC: core carries the Base constants; the facilitator has the lane (`services/facilitator/src/base/`),
  its migration, five public routes, health and the worker on the maintenance pass; the SDK has
  `lane: 'base'` with the refusal sentences. Unit tests with Base mocked at the chain port and the
  ledger against Postgres are green in both packages. Next: the demo against a live service, the fork
  rig for the happy path, screenshots, the recording.

## What is live and what is prepared

Prepared on this branch, tested, not yet deployed: the facilitator's Base lane, the SDK's `lane:
'base'`, the Postgres migration, the rig that runs the lane end to end. Nothing on the live
facilitator changes until the operator deploys the branch and sets the lane's variables. The live
facilitator keeps answering every route it answers today; the five Base routes answer
`base_lane_off` until the key is set.

## Operator actions

1. **Create the lane's key.** One keystore, under the facilitator's password, named `facilitator-base`:
   `cast wallet new ~/.config/bursar/keystore --unsafe-password "$(cat "$ETH_PASSWORD")"` and rename
   the file. Its address is the lane's address on both chains. Never the relayer key, never a funding
   role.
2. **Fund it on Base.** USDC only, no ETH: the settling facilitator pays the gas. 25 USDC covers a day
   of cent-sized calls with the one-USDC reserve the lane keeps. Send from the treasury's exchange
   account or bridge from Robinhood Chain through Relay.
3. **Fund it on Robinhood Chain.** 0.002 ETH for release and cancel transactions (each is well under a
   cent), and 5 USDG for the registry stake.
4. **Register it as a payee.** From the lane's address: `USDG.approve(AgentRegistry, 5 USDG)` then
   `AgentRegistry.register("bursar_base_lane", 5000000)`. The escrow admits a lock only for an active
   payee, and the reputation cap of an unscored payee is 25 USDG per lock, which is above the lane's
   5 USDC ceiling.
5. **Allow it on the example mandate**, and tell owners to allow it on theirs: the Base lane address
   goes on the mandate's merchant list like any provider. The console's Merchants screen does this.
6. **Render.** On the facilitator service, add `FACILITATOR_BASE_KEY` (secret), `FACILITATOR_BASE_FEE_BPS=100`,
   `FACILITATOR_BASE_FEE_FLOOR_MICRO=2000`, `FACILITATOR_BASE_FLOAT_MINIMUM_MICRO=1000000`,
   `FACILITATOR_BASE_MAX_PAYMENT_MICRO=5000000`. Leave `FACILITATOR_BASE_RPC_URL` at its default
   (`https://base.drpc.org`) or point it at a keyed Base endpoint; the public dRPC host rate-limits a
   fork but answers the lane's four reads per payment. Deploy the branch. `FACILITATOR_MIGRATE=on-start`
   applies `0013_base_lane.sql` before the port binds; on a `verify` deployment run
   `bursar-facilitator-migrate` first.
7. **Check.** `GET /healthz` reports `baseLane` with the float, what is promised and what is available;
   `GET /base/float` says the same without a token. `GET /config` reports `baseLane` with the address
   and the fee.
8. **Sweep.** Released locks land as USDG at the lane's address on Robinhood Chain. Once a week, move
   it to the settlement address and refill USDC on Base; the ledger's `settled` rows against the
   float's USDC balance are the reconciliation.
9. **Publish the SDK.** `@bursar/sdk` with `lane: 'base'` and `@bursar/core` with `BASE_MAINNET`, as
   0.2.0, once the lane is live. No pull request upstream: the lane uses the `exact` scheme as every
   Base service already accepts it, so nothing in `coinbase/x402` has to change.

## Links

- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/x402-base
- The lane: https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/src/base/lane.ts
- The float and the lock writer: https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/src/base/viem.ts
- The ledger and its migration: https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/src/base/ledger.ts, https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/migrations/0013_base_lane.sql
- The SDK lane: https://github.com/bursar-world/bursar/blob/bullish/x402-base/packages/sdk/src/x402/fetch.ts and its sentences: https://github.com/bursar-world/bursar/blob/bullish/x402-base/packages/sdk/src/x402/base-refusals.ts
- The rig: https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/scripts/base-lane-rig.ts
- The facilitator's routes, documented: https://github.com/bursar-world/bursar/blob/bullish/x402-base/services/facilitator/README.md#the-base-lane
- The example mandate on the console: https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c/settlements
- The service paid in the demo: https://api.402rates.com/v1/ping, listed on the Bazaar (https://x402.org) and x402scan (https://www.x402scan.com)

## The announcement

**One line.** A Bursar mandate now pays any x402 service on Base in USDC, under the budget its owner set.

**One paragraph.** The x402 ecosystem settles in USDC on Base, and Bursar mandates hold USDG on
Robinhood Chain. The Base lane joins them. An agent calls `mandate.fetch(url, { lane: 'base' })`; the
mandate locks USDG under its own limits and Bursar's facilitator pays the service in USDC from a float
it holds on Base. The lock settles once the USDC has moved and returns to the mandate if it never does.
One USDG buys one USDC plus a stated fee, and the owner sees every call in Settlements, with the same
per-call cap, daily and monthly windows, payee list and capability rules as any other payment.

**One post.** Every x402 service worth paying takes USDC on Base. Every Bursar mandate holds USDG on
Robinhood Chain. From today a mandate pays both.

`mandate.fetch(url, { lane: 'base' })` does the whole thing. The service answers 402 with its USDC
price. Bursar's facilitator quotes what the mandate has to lock: the price, plus a fee it states. The
mandate's own `spend` locks that USDG, so the per-call cap, the daily and monthly windows, the payee
list and the capability rules all apply before anything moves. The facilitator signs the USDC
authorization from a float it holds on Base, the service's facilitator settles it, and the lock
settles to Bursar once USDC confirms the transfer. A service that never takes the payment leaves
nothing behind: the authorization expires, the lock returns, the windows are credited back.

The owner sees the call in Settlements like any other, in USDG. The agent never holds USDC, never
holds a key for Base, and never sees the float. The facilitator's exposure is one authorization per
lock, bounded by the lock.

Works with any service on Coinbase's Bazaar or x402scan that accepts the `exact` scheme in USDC on
Base, which is nearly all of them. Starts with a float measured in tens of dollars and a per-payment
ceiling of five; both are stated on the facilitator's `/base/float`.

## The demo and how to run it

The rig runs the facilitator in the process that drives it, so a stranger needs the repository,
Node 22, `anvil` (Foundry), a local Postgres, and two keys: the agent of a mandate and the lane's
address. Both open from Web3 keystores under one password; nothing prints a key.

```
pnpm --filter @bursar/facilitator... build
psql postgres://localhost/postgres -c 'CREATE DATABASE bursar_base_rig'
export ETH_PASSWORD=/path/to/password-file   # source ops/rhc-env.sh writes one
export BURSAR_AGENT_KEYSTORE=~/.config/bursar/keystore/payer
export BURSAR_FLOAT_KEYSTORE=~/.config/bursar/keystore/payee
cd services/facilitator

# the whole path against a live Base service, with the Base side on a fork
BASE_FORK_URL=https://base-rpc.publicnode.com npx tsx scripts/base-lane-rig.ts mainnet https://api.402rates.com/v1/ping

# both chains forked, a local service, the full settle
RHC_FORK_URL=<keyed 4663 endpoint> BASE_FORK_URL=https://base-rpc.publicnode.com npx tsx scripts/base-lane-rig.ts local
```

What `mainnet` does, step by step: forks Base on this machine and hands the lane's address 5 USDC
there; starts the facilitator against the real Robinhood Chain and that fork; calls the service with
`mandate.fetch(url, { lane: 'base' })` from the example mandate, which opens a real lock on Robinhood
Chain for the lane's address; sends the facilitator's signed authorization to the service; the
service's facilitator (Coinbase's) verifies it against the real Base, where the address holds no USDC,
and refuses the transfer; the rig then waits for the lane's worker to see the authorization expire
unused and cancel the lock, which returns the USDG to the mandate and credits its windows. The run
writes everything it saw to `/tmp/base-lane-rig/mainnet.json`.

What `local` does: the same, with Robinhood Chain forked too and a service on this machine that
settles the authorization on the Base fork, so the worker finds the nonce used and releases the lock
to the lane's address.

## What the runs showed

**Both chains forked, the full settle** (`runs/local-forks.json`). The example mandate locked 0.01 USDG
(lock 43 on the live escrow's address, on a fork of 4663, released at fork block 85,287,244) for the lane's address;
the facilitator signed the USDC authorization; a service on this machine verified it against USDC's
own domain and settled `transferWithAuthorization` on a fork of Base carrying the live USDC contract
and state, so the signature was judged by the genuine contract; USDC reported the nonce used; the
worker released the lock with `https://basescan.org/tx/0x286da91e…` as its output. The mandate's
daily window moved by 10,000 atomic units, the lane's address received 9,900 (the escrow's 1%), the
float paid 1,000 USDC atomic units.

**Live, up to the Base transfer** (`runs/mainnet.json`). Against 402rates' `/v1/ping` on the Bazaar,
with Robinhood Chain live and only the Base side on a fork (where the lane's address was handed USDC
for the quote): the mandate opened lock 44 on the live escrow (one cent, payable to the lane); the
facilitator signed the authorization for 402rates' address; 402rates' facilitator simulated the
transfer against live Base, where the address holds nothing, and refused with `invalid_payload:
contract call failed: unable to call contract: execution reverted`; the SDK raised
`PaymentRejectedError` naming lock 44 and the minute it returns; the worker watched USDC until the
authorization had expired and cancelled the lock on the live escrow
(`0x39683913d51aa1a07746140e6833d37449a1da58d1a406b9da7a1ea5f63919b3`, block 85,294,929). The
mandate's balance and both windows read exactly as before the call. The console showed the lock
held and then "Cancelled. Called off before it settled" and "Came back $0.01".

One thing the live run also found: the rig had reused its ledger between the fork run and the live
run, and since a fork carries the chain id and the next lock id of the chain it was forked from, the
live lock 43 was refused as already paid and left open. It was returned with the operator script
that now ships beside the rig (`scripts/base-lane-return.ts`,
`0xd2f490ab85a86bc3d8cdf921d7e7def95b2eaab63d1e2eff09f7b902f064e9d7`), the rig now starts from a
fresh ledger every run, and a pay the float cannot cover now returns its lock at once instead of
leaving it to the deadline.

## The honest limits

- **No USDC has been paid to a Base service yet.** No Bursar key holds USDC on Base, and this build
  spends nothing to obtain some. The live path was run up to the Base transfer: a real lock on
  Robinhood Chain, a real authorization verified by the service's facilitator and refused only for
  the empty balance, a real return of the lock. The full settle ran on forks of both chains with the
  facilitator's own code. The first real USDC payment happens when the operator funds the float.
- **The float is the operator's.** It starts at tens of dollars and is topped up by hand from the
  USDG the lane collects. A short float refuses before anything is locked and says so.
- **One payment is capped at 5 USDC** on the facilitator this build configures, and the float keeps
  1 USDC in reserve. Both are settings.
- **The fee is 1% with a floor of 0.2 cent, and a lock is never under one cent**, so a 0.1 cent
  call locks one cent. The quote states the fee every time.
- **The lane's address has to be on the mandate's merchant list.** The example mandate already
  allows the demo address; other owners add the live address once it exists.
- **Settlement waits for the chain.** The worker runs with the facilitator's maintenance pass, every
  minute at most, so a lock settles or returns up to a minute after USDC answers, and a refused
  payment returns only once its authorization has expired: the service's own work budget plus a
  margin, five and a half minutes for a 300-second budget.
- **The facilitator sees the service's address, the amount and the resource URL** without its query,
  and nothing else of the call. It never proxies the request.
- **Services were not paid for real in this build.** The service the demo calls, 402rates
  (`/v1/ping`, 0.001 USDC), is a payment integration check on the Bazaar; it refused the empty float
  exactly as the design says it should.

## Post assets

All under `docs/bullish/x402-base/`, 1440×900, real figures, no keys in frame.

| File | What it shows |
|---|---|
| `local-01-sdk-call.png` | `mandate.fetch(url, { lane: 'base' })` on the two-fork run: the 402, the quote, lock 43, the signed authorization, the 200 with the fact, the payment record. |
| `local-02-facilitator-sign-settle.png` | The facilitator's log: the lane on, the authorization signed, the lock settled once USDC reported the nonce used; `GET /base/float` and `GET /config` after. |
| `local-03-lock-released.png` | Lock 43 on the escrow: released to the lane's address with the Base transaction as its output; the USDC settle on the Base fork; every balance before and after. |
| `mainnet-04-settlements-held.png` | The live console, Settlements of the example mandate: the lane's lock held, one cent, `demo.x402:1`. |
| `mainnet-05-settlements-returned.png` | The same page after the lock came back: "Cancelled. Called off before it settled", and "Came back $0.01". |
| `mainnet-06-live-call.png` | The live run: the real lock 44, the authorization signed for 402rates' address, the service's facilitator refusing the empty float, the SDK's sentence naming the lock and when it returns. |
| `mainnet-07-settlements-worker-returned.png` | The live console after the worker cancelled lock 44 on its own. |
| `mainnet-08-worker-return.png` | The worker's log line and the lock's state on Robinhood Chain after the return, with the mandate's windows credited back. |
| `demo.webm` | The live Settlements page, the lock held and then returned, from Playwright's recorder. |
| `runs/local-forks.json`, `runs/mainnet.json` | Everything the two runs saw, as the rig wrote it. |
