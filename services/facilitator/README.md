# @bursar/facilitator

An x402 facilitator for Robinhood Chain. It verifies payments, settles them in USDG, and keeps
the ledger behind the funding lanes.

## What it does

A provider that wants to charge for a call sends the payment it received to `POST /verify` and
`POST /settle`. Verification is read-only and free. Settlement records the payment against a nonce
claim that makes a replay cost nothing.

Two x402 schemes are accepted.

- **`escrow`**, the mandate lane. The mandate account paid through its own `spend`, which debits
  the daily and monthly windows and locks the price in escrow for the provider. The payment names
  that lock. Verification reads it: open, paid by an account this deployment's factory created,
  payable to `payTo`, for the price, under the offer's `extra.capability` when one is named, with
  time left before its deadline, and committed to the request-bound nonce. Settlement broadcasts
  nothing and charges no relay fee; the provider collects by calling `release` on the escrow once
  it has served the call.
- **`exact`**, the wallet lane. The agent's wallet signed an EIP-3009 USDG authorisation, and
  settlement broadcasts it. The relayer pays the gas, so it is metered against a budget that
  refuses once spent. Per-call only; windows client-enforced: nothing on chain counts these
  payments against the mandate's windows.

Three lanes decide where the money comes from.

**Prefund.** A principal funds a mandate account once. The facilitator holds against that balance
for each call, releases the hold if the call never happens, and pays merchants net. It carries the
least risk and costs the least gas: it broadcasts once per batch where the direct lane broadcasts
once per call, and every broadcast costs the relayer ETH that the payment never reimburses.

**Collateral.** A call is funded against posted collateral and opens a debt, repaid oldest first.
This is the only lane that lends. Nothing else in this service extends credit, and the debts table
carries a constraint that refuses any row saying otherwise. A draw is refused unless the posted
collateral carries it at the pool's borrowing cap and leaves the position above the pool's minimum
health factor, counting holds that have not reported back yet. Opening the debt locks the posted
amount behind it, grossed up by the asset's haircut, so collateral cannot be withdrawn from under
money that is still owed. Meeting the debt releases the lock.

**Direct.** The payer's own signed authorisation settles the call in one transaction. Nothing is
held and nothing is owed. A direct call worth less than its own gas is refused rather than served
at a loss.

`prefund`, `collateral` and `direct` are the three names a request may carry in its `lane` field,
and the three `GET /config` publishes. The schema spelled the direct lane `none` until migration
0006; that spelling is still accepted on input and is stored and returned as `direct`.

Every outcome that matters to reputation is written to a trust journal in the same transaction as
the ledger change that produced it, then delivered at least once from an outbox. A consumer that
keeps failing a message gets it quarantined rather than dropped, and an operator can redrive or
replay from any offset.

## Running it

```
pnpm --filter @bursar/facilitator build
pnpm --filter @bursar/facilitator migrate:dry-run   # names what is pending, changes nothing
pnpm --filter @bursar/facilitator migrate           # applies it, then exits
pnpm --filter @bursar/facilitator start
```

### What a start does to your schema

`FACILITATOR_MIGRATE` decides, and the process says which one it is doing before it does it.

| Value | What a start does |
|---|---|
| `on-start` (default) | Applies what is pending, naming each migration and the database first, then binds a port. |
| `verify` | Applies nothing. Refuses to start while anything is pending, naming the migrations that are missing. |
| `off` | Applies nothing and checks nothing, for a schema managed elsewhere. `/readyz` still reports whether it is current. |

Point this at a database somebody else owns and set `verify`, then apply the schema yourself with
`bursar-facilitator-migrate`. Neither `verify` nor `off` writes anything, including the migration
journal table.

### One instance per relayer key

Run exactly one facilitator process for each `FACILITATOR_RELAYER_KEY`. Do not scale it
horizontally, and do not let a deploy overlap the old process with the new one.

The relayer's transaction nonces are allocated in memory, by the process that signs. A second
process with the same key allocates the same nonces: one transaction replaces the other or is
refused, and a settle can report a transfer that never mined. The same process also runs
reservation expiry and settle reconciliation on a timer, and both assume nobody else is
broadcasting for this key.

Give the process a stop grace period of at least 160 seconds. A settle waits up to a minute per
transaction for its receipt, and shutdown lets in-flight settles finish before it exits.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | TLS is decided by `sslmode` in the URL, not by an ambient guess. |
| `FACILITATOR_MIGRATE` | no | `on-start` (default), `verify` or `off`. See above. |
| `RHC_RPC_PRIMARY` | yes | |
| `RHC_RPC_FALLBACK` | no | Defaults to a keyless endpoint for the network. Name your own in production: a fallback sharing a host with the primary goes down at the same moment it does, and the service refuses that pairing at startup. `RHC_RPC_TERTIARY` is optional. |
| `RHC_NETWORK` | no | `mainnet` (default), chain 4663. `testnet` is refused at startup: chain 46630 has no USDG contract, so nothing can settle there. Chain values are overridden per field through `RHC_MAINNET_*`. |
| `BLOCKSCOUT_API_KEY` | no | Server-side key for the chain index at `api.blockscout.com`, which answers 402 without one. Nothing this service settles or decides reads history, so it runs without a key; `GET /config` reports `index` as `keyed` or `unkeyed`. |
| `FACILITATOR_GAS_FLOAT` | yes | The relayer's address. Must differ from settlement, collateral and treasury. |
| `FACILITATOR_SETTLEMENT` | yes | |
| `FACILITATOR_COLLATERAL` | yes | |
| `FACILITATOR_TREASURY` | yes | Where fees accrue. |
| `FACILITATOR_RELAYER_KEY` | yes | The only key this service holds. Must sign for the gas float. |
| `FACILITATOR_GAS_FLOAT_MINIMUM_ETH` | yes | The relayer's ETH reserve, written as ETH: `0.004`, not a count of wei. ETH is the gas asset here and is not the settlement asset. Health reports degraded below it. |
| `FACILITATOR_FEE_BPS` | yes | 0 to 10000. |
| `FACILITATOR_FEE_FLOOR_MICRO` | yes | Atomic micro-USD. The smallest fee this deployment will spend a direct-lane broadcast on. |
| `FACILITATOR_HOST`, `FACILITATOR_PORT` | no | `127.0.0.1:8402`. |
| `FACILITATOR_AUTH_TOKEN` | off loopback | Required on every route, health included, when the host is not loopback. |
| `FACILITATOR_REQUIRE_BINDING` | no | Default true. See below. |
| `FACILITATOR_DAILY_SETTLEMENTS`, `FACILITATOR_PER_PAYER_HOURLY` | no | Gas budget. |
| `FACILITATOR_RESERVATION_TTL_SECONDS` | no | Default 120, minimum 90. A settle claims a hold only while it has at least 60 seconds left. |
| `BURSAR_UNDERWRITER_URL`, `BURSAR_UNDERWRITER_TOKEN` | see below | Reach the underwriter over HTTP. |
| `FACILITATOR_UNDERWRITER` | no | `remote`, `in-process` or `none`. Derived when unset. |
| `TRUST_SINK_URL`, `TRUST_SINK_TOKEN` | no | Without a URL, events are recorded and held rather than delivered. |
| `TRUST_TOPIC`, `TRUST_BATCH_SIZE`, `TRUST_POLL_SECONDS`, `TRUST_MAX_ATTEMPTS`, `TRUST_LEASE_SECONDS` | no | Delivery tuning. |

Amounts are always atomic micro-USD written as an integer string. The loader refuses a decimal, and
a default is not allowed for any variable that carries money.

Amounts in micro-USD are the settlement asset. The gas float is ETH, a different asset in different
units. Its reserve is configured in ETH (`FACILITATOR_GAS_FLOAT_MINIMUM_ETH=0.004`), converted to wei
on load, and reported by `/healthz` in wei as `balanceWei` and `minimumWei`. A reserve above 1,000
ETH is refused at start, because that is what a wei count written into the ETH variable looks like.

Three rules are enforced at start. The network has to be one that
can settle, which here means chain 4663. Each funding role gets its own address, because this
service holds the gas float's key and signs every broadcast with it, so any balance standing at
that address is spendable by the relayer. And the relayer key has to be the gas float's key: a
relayer that can sign for settlement or collateral is custody by another name.

## Where decisions come from

This service settles. Deciding whether an agent may spend is `@bursar/underwriter`'s job, and the
binary has to be told how to reach one.

Set `BURSAR_UNDERWRITER_URL` and `POST /underwrite` is answered by an underwriter over HTTP. Leave
it unset and set `MANDATE_DOCUMENT_SOURCE` instead, and one runs inside this process against the
same variables its own binary reads, claiming the same spend journals without opening a second
listener. `FACILITATOR_UNDERWRITER` names the mode explicitly where a deployment would rather not
leave it derived.

A deployment that configures neither is refused at startup, with a message naming all three
options. `FACILITATOR_UNDERWRITER=none` is the third: a facilitator that only settles, takes its
decisions from whoever posts them to `/authorizations`, and answers 501 on `/underwrite`. That is a
correct answer for that deployment and a wrong one for a facilitator that was meant to decide, so
the process refuses to start instead of failing a request an agent is waiting on.

The lifetime ceiling is reserved in the underwriter's spend journal, never here. `bursar_authorizations`
mirrors a decision for the lane ledger; the journal is the record it was taken on, and
`GET /v1/journal/{subject}` on the underwriter is how the two are reconciled.

## Payment binding

An authorisation proves who is paying and how much. It does not prove what they are paying for, so
anyone who sees a payment header in flight can put their own request in front of it. The payer
therefore signs four lines alongside the authorisation:

```
mandate-x402:v1
<network>
<authorisation nonce>
<sha256 of the request body>
```

The facilitator recomputes that digest from the bytes that arrived, not from a field parsed out of
them. `FACILITATOR_REQUIRE_BINDING=false` accepts unbound payments while a client is being moved
onto binding. It is not safe to leave off.

## Money in the database

Money columns are `NUMERIC(20, 6)` holding atomic micro-USD, the same six-decimal units the
contracts and x402 payloads use. The declared scale is never populated: every value is an integer
and every money column carries a `CHECK` that says so, because a fraction of one micro-USD in this
ledger would mean something other than this service wrote to it. One column holds a shade under
100,000,000 USDG.

The driver's `NUMERIC` parser is replaced process-wide before a pool opens, because its default
returns a JavaScript number and silently destroys any amount above 2^53 micro-USD.

## Routes

Thirty of them, in the order a newcomer meets them. Every route answers JSON. Amounts are decimal
strings of atomic micro-USD in both directions, and `amountMicro` is the name for that quantity
here and on the underwriter.

### Before anything else

An agent and a pool have to exist before a spend can be decided against them. `POST /underwrite`
answers `account_not_found` or `pool_not_found` until they do.

| Route | What it does |
|---|---|
| `GET /config` | Network, settlement asset, fee, and the lanes a request may name. |
| `GET /supported` | What the payment scheme settles, plus the budget left today. |
| `POST /accounts` | Create or update an agent: its wallets, its networks, and the mandate limits mirrored from its account. |
| `POST /pools` | Create or update a pool: its lane, its status, and the largest single call it funds. |

### Funding a pool

| Route | What it does |
|---|---|
| `POST /lanes/:agentId/prefund` | Record a confirmed deposit or withdrawal in the prefund lane. |
| `GET /lanes/:agentId/prefund` | The funding events behind that balance. |
| `POST /lanes/:agentId/collateral` | Record collateral posted or withdrawn in the collateral lane. |
| `GET /lanes/:agentId/:poolId` | Balance, outstanding debt and collateral in one statement. |
| `GET /accounts/:agentId` | One agent record. |
| `GET /accounts/:agentId/transactions` | Funding, debts, repayments and settlements, newest first. |
| `GET /pools/:poolId` | One pool and its reserves. |

### Spending

| Route | What it does |
|---|---|
| `POST /underwrite` | Take a decision against the mandate account and record it. 501 only where `FACILITATOR_UNDERWRITER=none`. |
| `POST /authorizations` | Record a decision taken somewhere else, for a deployment that does not call `/underwrite`. |
| `POST /reservations` | Hold funding against an authorisation. |
| `GET /reservations/:id` | One hold and its state. |
| `POST /reservations/:id/consume` | Turn a hold into a settlement. |
| `POST /reservations/:id/release` | Give a hold back unspent. |
| `POST /reservations/expire` | Sweep holds past their window. The service also does this on its own timer. |
| `POST /verify` | Check a payment without broadcasting anything. Free. |
| `POST /settle` | Record a payment, broadcasting it on the `exact` scheme. 429 when the daily or per-payer budget is spent. |

### Paying out and repaying

| Route | What it does |
|---|---|
| `GET /settlements/pending/:merchant` | What is owed to one merchant address and not yet paid. Anything that is not a 20-byte hex address is a 400. |
| `POST /settlements/net` | Mark a batch settled against one transaction. |
| `POST /lanes/:agentId/repay` | Apply a repayment, oldest debt first. |
| `POST /accounts/:agentId/status` | Suspend an agent, or lift it. A suspended agent opens no calls. |

### Operating it

| Route | What it does |
|---|---|
| `GET /healthz` | Gas float, RPC providers, trust queue and applied migrations, reported separately. 200 while degraded. |
| `GET /readyz` | Whether this process can serve a request now, over its database, its underwriter and the chain. 503 otherwise. |
| `GET /trust/events` | The trust journal, from any offset. |
| `GET /trust/outbox` | Delivery counts and the quarantine. |
| `POST /trust/outbox/redrive` | Put quarantined events back in the queue. |
| `POST /trust/outbox/replay` | Re-deliver from an offset. |

### What `GET /config` publishes

| Field | Meaning |
|---|---|
| `chain`, `network`, `chainId` | `Robinhood Chain`, `eip155:4663`, `4663`. |
| `settlementAsset` | The USDG contract every amount on this service is denominated in. |
| `index` | `keyed` or `unkeyed`: whether `BLOCKSCOUT_API_KEY` is set. Never the key. |
| `lanes` | The three names a request may put in `lane`. |
| `feeBps`, `feeFloorMicro` | The fee rate, and the smallest fee a direct-lane broadcast is spent on. |
| `gasFloat` | The relayer's address, which pays for every broadcast. |
| `requireBinding` | Whether `/verify` and `/settle` refuse a payment not bound to its request. |
| `underwriter` | `remote`, `in-process` or `none`. |
| `trustTopic`, `trustSinkConfigured` | Where trust events are published, and whether a sink URL is set. |

### Errors

Every refusal outside `/verify` and `/settle` has one shape: `error` is a stable code to branch on,
`detail` is a sentence for a person, and `details` appears when there is structured context.

```json
{ "error": "pool_not_found", "detail": "No pool by the id nope. Create one with POST /pools before spending against it." }
```

`/verify` answers a refusal as `{ "isValid": false, "invalidReason": "...", "payer": "0x..." }` and
`/settle` as `{ "success": false, "errorReason": "...", ... }`, the x402 shapes clients already read.

### Request bodies

Every body below was sent to a local facilitator on the Postgres from the quick start, with the
in-process underwriter reading the example mandate account
`0x420BeB507F72173E7d78e0f956968f64fb508356` on chain 4663. Responses are trimmed to their fields;
ids and timestamps will differ. Money is always a string.

**`POST /accounts`** creates or updates an agent. `agentId`, `payerWallet` and `repayWallet` are
required; the rest mirror the mandate account's limits and are optional. Answers 201 with the
record, including `status`.

```json
{
  "agentId": "agent-1",
  "payerWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "repayWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "mandateAccount": "0x420BeB507F72173E7d78e0f956968f64fb508356",
  "networks": ["eip155:4663"],
  "perCallCapMicro": "100000",
  "dailyCapMicro": "500000",
  "monthlyCapMicro": "2000000",
  "approvalThresholdMicro": "100000"
}
```

**`POST /pools`** creates or updates a pool. `status` defaults to `active`, `ltvCapBps` to 0 and
`minHealthFactor` to 1.5; the last two matter only in the collateral lane. Answers 201 with the pool.

```json
{ "poolId": "prefund-main", "lane": "prefund", "maxSingleMicro": "100000" }
```

```json
{ "poolId": "collateral-main", "lane": "collateral", "ltvCapBps": 8000, "minHealthFactor": 1.5, "maxSingleMicro": "100000" }
```

**`POST /lanes/:agentId/prefund`** records a confirmed deposit or withdrawal. `eventType` is
`deposit` or `withdraw`; `referenceId` makes a repeat idempotent; `txHash` is optional. Answers
`{ idempotent, event, balance }`, where `balance` has `availableMicro`, `reservedMicro` and
`spentMicro`.

```json
{ "poolId": "prefund-main", "referenceId": "deposit-0001", "eventType": "deposit", "amountMicro": "500000" }
```

**`POST /lanes/:agentId/collateral`** records collateral posted or withdrawn. `assetId` is
`usdg-rhc`, the one collateral asset. Answers `{ idempotent, position, summary }`, where `summary`
carries `effectiveCollateralMicro`, `outstandingMicro`, `ltvBps` and `healthFactor`.

```json
{
  "poolId": "collateral-main",
  "collateralAccount": "0x877c349EFb5926082C413833E8055F0991185c61",
  "assetId": "usdg-rhc",
  "referenceId": "collateral-0001",
  "eventType": "deposit",
  "amountMicro": "1000000"
}
```

**`POST /underwrite`** takes a decision against the mandate account. `action` is a capability label
such as `doc.summarize:1`, from which `capabilityId` is derived; send `capabilityId` (32-byte hex)
instead for any other form. `merchant` has to be on the account's allowlist when it keeps one, and
`merchantProof` carries the Merkle path when it keeps a root. Answers 201 with
`{ authorization, decision, mandateAccount, idempotent }`; a refusal is still 201, with
`decision: { "decision": "refuse", "reason": "merchant_not_allowed" }` and `approved: false`.

The quick start in the root README sets `FACILITATOR_UNDERWRITER=none`, which answers this route
with 501. To take decisions in this process against the example mandate, start the facilitator with
these instead, and leave `FACILITATOR_UNDERWRITER` unset so they choose the in-process underwriter:

```sh
unset FACILITATOR_UNDERWRITER
export MANDATE_DOCUMENT_SOURCE=chain
export MANDATE_ACCOUNT=0x420BeB507F72173E7d78e0f956968f64fb508356
export MANDATE_SUBJECT=agent-1
```

`MANDATE_SUBJECT` has to match the `subject` in the request. The spend journal is kept in
`./.mandate/journal` unless `UNDERWRITER_DATABASE_URL` is set.

```json
{
  "agentId": "agent-1",
  "payerWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "repayWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "requestNonce": "call-0003",
  "network": "eip155:4663",
  "lane": "prefund",
  "poolId": "prefund-main",
  "subject": "agent-1",
  "action": "doc.summarize:1",
  "amountMicro": "50000",
  "merchant": "0x5210D8df060A9D5ce4c1305045ED5c9548fca374"
}
```

**`POST /authorizations`** records a decision taken elsewhere. All of the fields below except
`reasonCodes`, `policyId` and `policyVersion` are required; `requestHash` and `documentHash` are
also accepted. Answers 201 with the stored record and its `id`.

```json
{
  "agentId": "agent-1",
  "payerWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "repayWallet": "0x877c349EFb5926082C413833E8055F0991185c61",
  "requestNonce": "call-0002",
  "network": "eip155:4663",
  "lane": "prefund",
  "poolId": "prefund-main",
  "requestedMicro": "50000",
  "approved": true,
  "approvedMicro": "50000",
  "availableMicro": "500000",
  "outstandingMicro": "0",
  "reasonCodes": ["allow"],
  "policyId": "external-policy",
  "policyVersion": "1"
}
```

**`POST /reservations`** holds funding against an approved authorisation, by its `id`.
`ttlSeconds` is optional and defaults to `FACILITATOR_RESERVATION_TTL_SECONDS`. Answers 201 with
the hold: `id`, `status: "reserved"`, `lockedMicro` and `expiresAt`. A refused authorisation
answers 409 `authorization_refused`.

```json
{
  "authorizationId": "04f17fd3-bd29-4d10-b27b-5a96dc5fecd0",
  "merchantWallet": "0x5210D8df060A9D5ce4c1305045ED5c9548fca374",
  "amountMicro": "50000",
  "ttlSeconds": 120
}
```

**`POST /reservations/:id/consume`** turns a hold into a settlement owed to the merchant. `asset`
is required, `feeMicro` defaults to 0. Answers `{ reservation, settlement, debt }`, with
`settlement.status` of `authorized` until it is netted.

```json
{ "asset": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "feeMicro": "500" }
```

**`POST /reservations/:id/release`** takes no body and answers `{ "released": true }`, or 409
`reservation_not_open`.

**`POST /reservations/expire`** takes no body; `?limit=` caps the sweep at 200 by default. Answers
`{ "expired": 0 }`.

**`POST /settlements/net`** marks authorised settlements paid by one transaction. The ids come from
`GET /settlements/pending/:merchant`. Answers `{ settled: [...] }` with each settlement's `status`
now `settled` and its `txHash` set.

```json
{
  "settlementIds": ["fcee7589-6d4c-4ac4-91e8-bedf185afe9d"],
  "txHash": "0x9aa58deac37a9b2f498431cdf9afe1aa8ffb194976ccdef7e1620b2405843b9f"
}
```

**`POST /lanes/:agentId/repay`** applies a repayment to open debts, oldest first. `source` is
`settlement`, `transfer` or `collateral`; `poolId` and `txHash` are optional. Answers
`{ repayment, idempotent, outstandingMicro }`, where `repayment.appliedMicro` is how much met a debt.
Money that arrives with nothing owed is still recorded, with `appliedMicro` of 0, under the `poolId`
it was sent with.

```json
{ "referenceId": "repay-0001", "amountMicro": "10000", "source": "transfer", "poolId": "collateral-main" }
```

**`POST /accounts/:agentId/status`** suspends or reinstates an agent. Answers the account record.

```json
{ "status": "suspended" }
```

**`POST /trust/outbox/redrive`** moves quarantined events back into the queue; `eventId` picks one.
Answers `{ selected, redriven, skipped }`.

```json
{ "limit": 50 }
```

**`POST /trust/outbox/replay`** re-delivers the journal from an offset, optionally for one
`subject`. Answers `{ scanned, enqueued, nextOffset }`.

```json
{ "fromOffset": 0, "limit": 500 }
```

**`POST /verify`** and **`POST /settle`** take the same body: the x402 payment, the requirements it
answers, and `requestHash`, the SHA-256 in hex of the request body the payment buys. With binding
on, the payer folds that digest and a random `salt` into the EIP-3009 nonce (`deriveNonce` in
`@bursar/core`) and repeats both under `payload.binding`. `reservationId` is optional and names the
hold a settle redeems. The authorisation is good only between `validAfter` and `validBefore`, so
this exact body now answers `invalid_exact_evm_payload_authorization_valid_before`. Sign a fresh one
to try it.

On the `escrow` scheme `payload.lock` replaces the authorisation: `{ escrow, id, mandate,
transaction, inputCommit }`, where `id` is a decimal string, `transaction` opened the lock, and
`inputCommit` is the same derived nonce, which the lock carries on chain.

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "accepted": {
      "scheme": "exact",
      "network": "eip155:4663",
      "amount": "50000",
      "asset": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "payTo": "0x5210D8df060A9D5ce4c1305045ED5c9548fca374",
      "maxTimeoutSeconds": 60
    },
    "payload": {
      "signature": "0xd53a9d807ace77661872e81f4dc1f7a9f942193fe55f57089727c30d9f56702d315a2a58288dd1ab93931fae4ddcb4c55df60d461c96c832db7a0d15ff30a37c1b",
      "authorization": {
        "from": "0x1563915e194D8CfBA1943570603F7606A3115508",
        "to": "0x5210D8df060A9D5ce4c1305045ED5c9548fca374",
        "value": "50000",
        "validAfter": "1790525798",
        "validBefore": "1790526458",
        "nonce": "0xf0b7c4ac7a4302e4800aff812517f0c236ff42b90abbae833dec9e46e28bce3f"
      },
      "binding": {
        "requestHash": "dc3a42f83f87315d790801e455d9e56e133791c7c47600292ec7babcd27599c7",
        "salt": "0x3333333333333333333333333333333333333333333333333333333333333333"
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:4663",
    "amount": "50000",
    "asset": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "payTo": "0x5210D8df060A9D5ce4c1305045ED5c9548fca374",
    "maxTimeoutSeconds": 60
  },
  "requestHash": "dc3a42f83f87315d790801e455d9e56e133791c7c47600292ec7babcd27599c7"
}
```

A valid payment verifies as `{ "isValid": true, "payer": "0x…", "method": "eip3009", "amount": "50000" }`.
The payer above holds no USDG, so this body verifies as
`{ "isValid": false, "invalidReason": "insufficient_funds", "payer": "0x1563915e194D8CfBA1943570603F7606A3115508" }` and settles as
`{ "success": false, "settled": false, "broadcast": false, "errorReason": "insufficient_funds", "payer": "0x1563915e194D8CfBA1943570603F7606A3115508", "transaction": "", "network": "eip155:4663" }`.
A settle that lands answers `success: true`, `settled: true` and the transaction hash. Both routes
answer 200 for a refusal; `/settle` answers 429 when a budget is spent.

Health and readiness answer different questions. `/healthz` is what a supervisor restarts on and
stays 200 while the deployment is degraded. `/readyz` is what an orchestrator routes on, and it is
503 while the schema is behind this build, the chain cannot be read, or the underwriter cannot take
a decision. A gas float below its minimum is reported in both and decides neither: a relayer that
cannot broadcast can still verify payments, take decisions and answer every ledger route.

The underwriter answers the same two paths with the same two shapes.

## Tests

```
pnpm --filter @bursar/facilitator test
```

The suites ending in `.pg.test.ts` need a Postgres and skip without one. Every statement in the
ledger is hand-written SQL, and a double that returns canned rows proves nothing about `FOR UPDATE`,
a guard in a `WHERE` clause, or a `CHECK` constraint, which are the parts that decide whether money
is conserved.

```
BURSAR_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm --filter @bursar/facilitator test
```

The suite creates its own database inside that server and drops it afterwards, so it never touches
the one in the URL.

## The payment scheme

The verifier lives in `@bursar/x402`: the EIP-712 domain read from the token, the authorisation
methods, and the refusal matrix. This service takes it by injection, loaded at run time by
`loadScheme`, so the refusal ordering here stays testable without a chain.

This service settles EIP-3009 only, and `GET /supported` lists `eip3009` alone. It is the one
method that signs the payee into the authorisation. USDG also accepts EIP-2612 and Permit2, which
authorise the relayer for an amount and trust it to forward the funds. `@bursar/x402` can serve
them through the `methods` option of `createExactScheme`; this service passes no `methods`, and no
variable changes that, so serving them means adding the option to the `loadScheme` call in
`src/main.ts`.

## License

MIT. See [LICENSE](../../LICENSE).
