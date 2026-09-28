# @bursar/mcp

Three roles work through this server, headless. An agent spends inside its mandate: it reads the
limits, quotes a spend before making it, pays or hires, follows the job to delivery or refund, and
contests the ones that come back wrong. A resolver rules on those contests: it bonds, reads the
open disputes, seals a score, publishes it and closes the vote. A provider sells capability: it
lists itself with collateral, manages that collateral, and reads the ceiling its record has earned.

One server carries whichever of the three it is configured for. No dashboard and no human in the
loop.

Twenty-nine tools exist in total. `tools/list` returns the ones for the roles this server is bound
to, and the ones that send a transaction only when it can sign for that role:

| Bound to | No signer | With a signer |
|---|---:|---:|
| A mandate account | 5 | 8 |
| A resolver | 2 | 12 |
| A provider | 2 | 9 |
| All three | 9 | 29 |

A local key signs for the mandate alone, so all three roles with `BURSAR_SIGNER=local` advertise
12. The 29 in the last row needs `BURSAR_RELAY_URL`, which is the only signer the resolver's and
the provider's writes go through. [Who signs](#who-signs) has the reasoning.

The mandate contract on Robinhood Chain enforces the limits, so this server cannot relax them. A
spend outside them does not settle, whatever an agent is told to do.

## What an agent spending a mandate gets

| Tool | What it does |
| --- | --- |
| `mandate_inspect` | The per-call cap, the daily and monthly budgets, what is left in each and when each resets, the approval threshold, the funded balance, and whether the mandate is active, paused, revoked or outside its dates. |
| `mandate_quote_spend` | What the mandate would decide about a spend, before making it. Names the limit that would stop it. |
| `mandate_pay_provider` | Locks the amount in escrow against the mandate and hands the job to the provider. |
| `mandate_hire_agent` | The same, against a brief: the task in words, the arguments it runs on, and what counts as delivered, hashed and published with the payment. |
| `mandate_list_settlements` | What the mandate has paid for, newest first, and where each payment stands. |
| `mandate_get_settlement` | One settlement in full, with the next decision and the time it has to be made by. |
| `mandate_open_dispute` | Contests a settlement and hands the split to the resolvers. |
| `mandate_get_dispute` | The phase a contest is in, the clock on each window, and the ruling once there is one: the median score, the refund share, and exactly what went where. |

Two rules run through all of them. A spend at or above the approval threshold needs an approval the
principal signed for that provider, capability and amount; without one it is refused before it
reaches the chain. And the money is what the principal has already funded the mandate with, so
there is no credit here.

## What a resolver gets

| Tool | What it does |
| --- | --- |
| `resolver_status` | The BRSR bonded against the floor it has to clear, whether the pool would accept it, disputes ruled, slashes taken, votes still holding the bond, USDG waiting to be claimed, and the voting parameters in force. |
| `resolver_list_disputes` | The disputes still open to a vote, each with the job the score is about, read straight off the chain. |
| `resolver_post_bond`, `resolver_add_bond` | Join the roster, and top the bond back up after a slash or a raised floor. |
| `resolver_commit_score` | Seal a score. The reply carries the salt that opens it. |
| `resolver_reveal_score` | Publish the sealed score, with the exact salt it was sealed under. |
| `resolver_finalize_dispute`, `resolver_fail_dispute` | Close a vote that reached quorum, or one that did not. |
| `resolver_claim_rewards` | Take the share of the resolver fee this resolver earned, in USDG. |
| `resolver_request_unbond`, `resolver_complete_unbond`, `resolver_cancel_unbond` | The three steps of leaving. |

A bond is collateral taking first loss. It pays no return, a vote that goes silent or lands far
from the room loses part of it, and the amount at risk is BRSR at eighteen decimals, which is a
different token and a different scale from the USDG every payment is in.

### The salt

`resolver_commit_score` generates a salt and returns it. That salt is the only thing that will ever
open the commitment: the registry checks a reveal against a hash covering the dispute id, the
resolver address, the score and the salt, and nothing on chain or in this server can recompute it.
A commitment still sealed when the reveal window shuts counts as silence, and part of the bond is
taken for it. The reveal window is six hours on the live deployment and the reply names both ends
of it.

The commitment is checked against the registry's own hash before the transaction is sent, and read
back off the chain after it lands. If either check fails, nothing is sealed, or the refusal carries
the salt and the score so they are not lost with the reply.

## What a provider gets

| Tool | What it does |
| --- | --- |
| `provider_status` | Whether it is listed and available, the collateral posted against the floor, the most one ruling could take, and any withdrawal on its way out. |
| `provider_reputation` | Jobs delivered, timed out and contested, and the largest single payment the escrow will hold for it right now. |
| `provider_register`, `provider_add_stake` | List with collateral, and add more. |
| `provider_request_withdrawal`, `provider_execute_withdrawal`, `provider_cancel_withdrawal` | The three steps of taking collateral back. |
| `provider_deactivate`, `provider_reactivate` | Stop and start reading as available, without moving the collateral. |

Collateral is USDG at six decimals. It is at risk from the moment it lands, and it leaves through a
delay so that a stake cannot walk out between a bad job and the ruling on it.

## Who signs

The contracts hold the funds. Transactions are signed one of two ways, and the choice is yours to
make at startup.

**A signer you run.** `BURSAR_RELAY_URL` points at an HTTP signer of your own, which this server
never has credentials for. It is the right answer when the key belongs somewhere this process
cannot reach it, and it is the only way to sign for a resolver or a provider. The routes are
[below](#the-signer-interface).

**A key in this process.** Set `BURSAR_SIGNER=local` and `BURSAR_SIGNER_KEY` and the server signs
for itself. The key stays in memory, is never written anywhere, and is scrubbed from everything
the server prints. It signs for one mandate, the account in `MANDATE_ACCOUNT`, and for three calls
on it: a payment, a payment carrying the principal's consent, and contesting a settlement. Nothing
a client sends can point it at another account or turn it into a general-purpose transaction
sender, and the limits are still the contract's, so a spend outside them does not settle.

Both at once is refused, because which key spent the money is not a question a server should
answer for you.

A key arriving under any other name is refused at startup.
`AGENT_PRIVATE_KEY`, `BURSAR_PRIVATE_KEY`, `PRINCIPAL_PRIVATE_KEY`, `PRIVATE_KEY` and `MNEMONIC`
are all set in shells and deployment environments for other reasons, and custody taken by accident
is not custody anyone chose:

```
This server does not take a key under a name something else may also be reading. Unset
AGENT_PRIVATE_KEY. To sign in this process, set BURSAR_SIGNER=local and BURSAR_SIGNER_KEY; to keep
the key out of it, point BURSAR_RELAY_URL at a signer of your own.
```

With no signer at all the server still runs and advertises only the tools that read. Every tool
that sends a transaction disappears from the list rather than failing when an agent tries it, and
so does every tool belonging to a role the server was not configured for. A local key advertises
the mandate's writes and leaves the resolver's and the provider's off, because it cannot send them.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `RHC_RPC_PRIMARY` | yes | The endpoint this deployment pays for, at `https://rpc.mainnet.chain.robinhood.com` or a provider of your own. |
| `RHC_RPC_FALLBACK` | no | An independent second endpoint. Defaults to `https://robinhood.drpc.org`, which needs no key. Reads fail over to it, and a failover is reported on stderr. Two endpoints at the same host are refused, because that is one endpoint under two names. |
| `RHC_RPC_TERTIARY` | no | A third, for a deployment that wants one. |
| `RHC_RPC_PRIMARY_MAX_RPS`, `RHC_RPC_FALLBACK_MAX_RPS`, `RHC_RPC_TERTIARY_MAX_RPS` | no | Caps requests per second at that provider. Unset leaves the pace the pool already holds for the host. |
| `RHC_RPC_PRIMARY_MAX_CONCURRENCY`, `RHC_RPC_FALLBACK_MAX_CONCURRENCY`, `RHC_RPC_TERTIARY_MAX_CONCURRENCY` | no | Caps calls in flight at that provider. |
| `RHC_NETWORK` | no | `mainnet`, which is the default and the only value that works. Naming `testnet` is refused: chain 46630 has no USDG contract, so nothing on it can settle. Chain values are overridden through `RHC_MAINNET_CHAIN_ID`, `RHC_MAINNET_RPC_URL`, `RHC_MAINNET_EXPLORER`, `RHC_MAINNET_USDG`, `RHC_MAINNET_PERMIT2`, `RHC_MAINNET_MULTICALL3` and `RHC_MAINNET_MIN_FEE_CAP`, which is also how a local fork of 4663 is configured. |
| `MANDATE_ACCOUNT` | one role required | The mandate account this server spends through. One server, one mandate. |
| `BURSAR_RESOLVER_ACCOUNT` | one role required | The address this server votes as. It has to be the address the signer holds: it sits inside every commitment a resolver seals, and a mismatch writes commitments nobody can reveal. |
| `BURSAR_PROVIDER_ACCOUNT` | one role required | The address this server is listed under in the provider registry. |
| `BURSAR_ORACLE_REGISTRY`, `BURSAR_AGENT_REGISTRY`, `BURSAR_REPUTATION` | no | Override the contracts the two roles read. They default to the committed deployment for the chain. |
| `MANDATE_ESCROW` | no | Leave it unset on 4663: the server then accepts a mandate on the current escrow or on the previous set's, and reads each through its own ABI. Name one only for an escrow this package has not recorded, such as a local fork. A value that is not the escrow the mandate settles through stops the server at startup. |
| `BURSAR_SETTLEMENT_ASSET` | no | Defaults to USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, six decimals. |
| `BURSAR_SIGNER` | for spending in this process | `local` signs here with `BURSAR_SIGNER_KEY`. Anything else, or unset, signs through `BURSAR_RELAY_URL` or not at all. |
| `BURSAR_SIGNER_KEY` | with `BURSAR_SIGNER=local` | The 32-byte key this server signs the mandate's transactions with. It never leaves the process and is scrubbed from everything it prints. Refused unless `BURSAR_SIGNER=local` says to hold it. |
| `BURSAR_RELAY_URL` | for spending through your own signer | The signer that submits transactions for this mandate, and the only way to sign for a resolver or a provider. |
| `BURSAR_RELAY_TOKEN` | no | Bearer token for the signer. Scrubbed from everything this server emits. |
| `BURSAR_RELAY_TIMEOUT_MS` | no | Defaults to 30000. |
| `BLOCKSCOUT_API_KEY` | for `mandate_list_settlements` | Authenticates the index read. Without it the index answers 402 and the listing says the key is missing; every other tool is unaffected. |
| `BLOCKSCOUT_API_BASE` | no | Points the listing at a different index. Defaults to `https://api.blockscout.com/4663/api/v2`. |

At least one of `MANDATE_ACCOUNT`, `BURSAR_RESOLVER_ACCOUNT` and `BURSAR_PROVIDER_ACCOUNT` has to
be set. A server bound to none of them serves nothing, and it says so at startup rather than
advertising an empty tool list:

```
This server is not bound to anything. Set MANDATE_ACCOUNT to work inside a spending mandate,
BURSAR_RESOLVER_ACCOUNT to rule on disputes, or BURSAR_PROVIDER_ACCOUNT to sell capability.
One server can carry more than one of them.
```

Before it serves anything, the server reads `MANDATE_ACCOUNT` and exits with a message on stderr
if the address is not a mandate account, or if the mandate settles through a different escrow or
asset than the configuration names:

```
MANDATE_ACCOUNT is 0x… on chain 4663, and nothing there answers as a mandate account. Set
MANDATE_ACCOUNT to the mandate address (not the agent or principal wallet) and start the server again.
```

If no endpoint answers at startup, the server starts anyway, says on stderr that the address is
unchecked, and every tool makes the same check on its first call.

## Where the settlement history comes from

Every tool reads the contracts, because they are the only source that can say where funds are
now. `mandate_list_settlements` also reads the network's index, for the one thing contracts do
not keep: which settlements exist. It then reads each one back from the escrow.

The node caps how many blocks one log query may cover, and Robinhood Chain produces sub-second
blocks, so a scan it will serve reaches back a short way. How far has not been measured on
4663. A settlement an agent is chasing is regularly older than that window, and a list built from a
scan would show the tail of the day and present it as the record. The index holds the whole log, so
that is what the listing reads, page by page, newest first.

The index is a paid tier and the key stays on the server: it travels in a request header, never in
a URL, and it is scrubbed from anything this server prints. The explorer people read,
`robinhoodchain.blockscout.com`, is a link target only. It answers a browser challenge rather than
JSON, and pointing the server at it is refused by name.

When the index does not answer, the listing says so and names the reads that are unaffected. It
never answers an outage with an empty history, and it tells a missing key apart from a busy index:
one is the operator's to set and the other is worth retrying.

## The signer interface

What `BURSAR_RELAY_URL` has to serve. A deployment signing with `BURSAR_SIGNER=local` needs none of
this; a resolver or a provider needs all of it.

Authenticated with the bearer token when one is configured. The mandate's two routes:

```
POST {BURSAR_RELAY_URL}/v1/spends
{
  "mandateAccount": "0x…",
  "merchant":       "0x…",
  "capabilityId":   "0x… (32 bytes)",
  "inputCommit":    "0x… (32 bytes)",
  "inputURI":       "data:application/json;base64,…",
  "amount":         "1000000",
  "deadline":       "1800000300",
  "merchantProof":  [],
  "approval":       null,
  "spendClass":     0,
  "contractSet":    "v2"
}
→ 200 { "escrowId": "42", "txHash": "0x…" }
```

`spendClass` is 0 for a service payment and 1 for a hire. A v2 mandate checks it against the classes
its principal allows. `contractSet` says which account ABI to encode against: a v1 mandate takes the
spend request without `spendClass`.

```
POST {BURSAR_RELAY_URL}/v1/spends/{escrowId}/dispute
{ "mandateAccount": "0x…" }
→ 200 { "txHash": "0x…" }
```

The two roles that act on their own behalf use one route each, named after the action:

```
POST {BURSAR_RELAY_URL}/v1/resolver/{action}
POST {BURSAR_RELAY_URL}/v1/provider/{action}
→ 200 { "txHash": "0x…" }
```

Every body carries the address the call has to be signed as, so a relay pointed at the wrong key
can refuse rather than write something the role cannot use:

```
POST /v1/resolver/commit
{ "resolver": "0x…", "disputeId": "4", "commitment": "0x… (32 bytes)" }

POST /v1/provider/register
{ "provider": "0x…", "name": "render_farm", "stake": "25000000" }
```

The resolver actions are `bond`, `add-bond`, `commit`, `reveal`, `finalize`, `fail`,
`claim-rewards`, `request-unbond`, `complete-unbond` and `cancel-unbond`. The provider actions are
`register`, `add-stake`, `request-withdrawal`, `execute-withdrawal`, `cancel-withdrawal`,
`deactivate` and `reactivate`. The set is closed on purpose: a route that took a destination and
calldata would be a blank cheque on the operator's key, and this seam exists so that key decides
what it will do.

A refusal answers with a non-2xx status and `{ "error", "message", "revert" }`. When `revert` names
a contract error, this server turns it into the sentence written for that condition in that
contract. Three contracts declare `ZeroAmount` and mean different things by it, so the reading is
scoped to the route the call went out on.

A spend is signed as the mandate's agent. Opening a dispute is a decision for the principal, and
the escrow charges a bond for it, so a signer that does not act for the principal will refuse that
route. The resolver and provider routes are signed as the addresses the two variables above name.

## Running it

The package is not on npm, so `bursar-mcp` is not a command a package manager puts on PATH for
you. Build it here and point the client at the executable in this directory:

```
pnpm install
pnpm --filter @bursar/mcp build
```

```json
{
  "mcpServers": {
    "mandate": {
      "command": "/absolute/path/to/bursar/packages/mcp/bin/bursar-mcp.mjs",
      "env": {
        "RHC_RPC_PRIMARY": "https://rpc.mainnet.chain.robinhood.com",
        "RHC_RPC_FALLBACK": "https://robinhood.drpc.org",
        "MANDATE_ACCOUNT": "0x…",
        "BURSAR_SIGNER": "local",
        "BURSAR_SIGNER_KEY": "0x…",
        "BLOCKSCOUT_API_KEY": "…"
      }
    }
  }
}
```

An absolute path, because an MCP client starts the server with its own environment rather than the
shell's. `bin/bursar-mcp.mjs` is committed rather than built, so it is there to be linked and to be
pointed at before `dist/` exists; it runs the built server and says what to build if there is none.

It speaks MCP over stdio. stdout carries the protocol and nothing else; diagnostics go to stderr.
`pnpm --filter @bursar/mcp start` runs the same server from source.

## Amounts

Every settlement amount in and out of this server is USDG in six-decimal atomic units, as a string.
`"1000000"` is 1.00 USDG. A decimal point is refused. Replies carry both
forms, `micro` for arithmetic and `usdg` for reading.

A resolver bond is BRSR in eighteen-decimal atomic units, and it travels on its own fields:
`atomic` and `brsr`. The two tokens are never added, compared or converted, and there is no price
between them here. `"25000000000000000000000"` is 25,000 BRSR; the same digits read as a USDG
amount would be twenty-five million times too large.

Gas is ETH, a different asset from settlement, and this server never reads it: an account can hold
every USDG it needs and still be unable to send a transaction, which is a condition the signer
behind `BURSAR_RELAY_URL` reports.

## License

MIT. See [LICENSE](../../LICENSE).
