# @bursar/resolver

The service that votes Bursar's three bonded resolver keys on every dispute the registry hears,
under the published [ruling policy](../../docs/RULING-POLICY.md).

A party that contests a job before it is paid out freezes the lock and opens a vote on the
`OracleRegistry`. If fewer than two resolvers commit and reveal, anyone can call `failDispute`.
On the v1 contracts that refunds the payer, less the resolver fee, whatever was delivered. From v2
on it reopens the lock with a new deadline and returns the dispute bond, and a lock can be disputed
only once. Nothing settles a vote on its own once its reveal window closes: somebody has to call
`finalize` or `failDispute`, and until then the lock stays frozen. This service makes sure two
resolvers always vote: it reads the job and any delivery evidence, rules by the policy, seals the
same score from two keys, reveals it, finalises, and checks the escrow paid out. Every step is taken
from the chain as it reads at that moment, so a restart, a lost journal or a dead RPC endpoint costs
a poll, not a vote.

## What it does per dispute

Times are from the moment the dispute opens, for six-hour windows, the length the v1 registry
uses. Each step up to the end of the reveal window scales with the registry's windows: the v2
registry runs one-hour windows, so those steps come six times sooner.

| When | Step |
|---|---|
| First poll | Reads the lock, the payer's mandate, the payee's record and the job input at one block. Alerts INFO with the provisional ruling. |
| 3h00 | Evidence cutoff. The ruling is fixed from what arrived before it. |
| 3h30 | Commits from the primary pair, `keys[id mod 3]` and `keys[(id+1) mod 3]`. A benched primary, or one that is a party to the dispute, is replaced by the standby at once. The registry bars the payer, the payee and, from v2 on, the payer's principal. |
| 4h30 | Commits from the standby if fewer than two of ours are in. WARN. |
| 5h30 | CRITICAL if the dispute is still short of quorum. |
| 6h00 | Reveals from every key that committed, then finalises as soon as every commitment is open. |
| 10h00 | CRITICAL if any of our commitments is still sealed. |
| 11h00 | Last-chance reveal at three times the estimated fee. CRITICAL: run the backup runner. |
| 12h00 | If a resolver outside Bursar committed and never revealed, finalises here. |
| After | Verifies the dispute is `Finalized` and the lock `Resolved`. A failed vote on v1 is CRITICAL: the lock was refunded, or is still frozen because the escrow never ruled. From v2 on the lock is `Locked` again with a new deadline. Still CRITICAL: the vote failed. |
| 13h00 | CRITICAL watchdog for a lock still `Disputed` an hour after the reveal window closed. The alert gives the time the vote closed and asks for `finalize`, or `failDispute` if it missed quorum. |

Every retry of a write is priced a quarter higher than the last. `finalize` is sent with at least
1.5M gas and twice the estimate, so the escrow call inside it cannot be starved.

## Salts

A key's salt is `keccak256(signMessage("bursar-resolver-salt|<chainId>|<registry>|<disputeId>"))`.
viem signs deterministically, so any process holding the keystore recomputes it, and with the salt
known the score is found by trying 0 to 100 against `committedBy`. The journal is a convenience.
Nothing in it is needed to reveal, and the backup runner does not have one.

## HTTP

| Route | Purpose |
|---|---|
| `POST /evidence` | A `DeliveryEvidence` signed by the lock's payee, or a `PayerStatement` signed by its payer (EIP-712, domain `Bursar Evidence` v1, verifying contract the escrow). Built with `@bursar/sdk` `signDeliveryEvidence`. |
| `POST /override` | `{ disputeId, score, reason }` with `Authorization: Bearer <RESOLVER_OPERATOR_TOKEN>`. Scores 0, 60, 72 or 90, before the cutoff only, and refused when an operator address is the payer or payee. |
| `GET /rulings/:disputeId` | The published ruling. Until this service's reveals land it answers `sealed` and nothing more. |
| `GET /health` | 200 while polling, 503 once three polls are missed. `served` lists each registry with its name, contract set, escrow, the last block its log scan covered and its open disputes. `lastError` is `poll_failed` or null; the reason is in the log. |

The service has no public address. The console forwards `https://app.bursar.world/api/evidence`,
`/api/rulings?dispute=<id>` and `/api/rulings/health` to it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RHC_RPC_PRIMARY` | required | Read endpoint, and the first choice for writes. |
| `RHC_RPC_FALLBACK` | keyless endpoint | Independent second host. Reads fail over to it; a write goes to the first host that answers, and a replacement goes where the original went. |
| `RESOLVER_KEYS` | one of the two | Comma-separated private keys, in the order of `RESOLVER_KEYS_ORDER`. For Render. |
| `RESOLVER_KEYSTORE_DIR` | one of the two | Directory of Foundry keystores named by `RESOLVER_KEYS_ORDER`. |
| `RESOLVER_PASSWORD_FILE` | with keystores | File holding the keystore password. |
| `RESOLVER_PASSWORD_KEYCHAIN` | with keystores | Or a macOS Keychain item as `service/account`. |
| `RESOLVER_KEYS_ORDER` | `resolver-1,resolver-2,resolver-3` | Key names, in rotation order. |
| `RESOLVER_DEPLOYMENTS` | every 4663 record in the line, newest first | Deployment record paths to serve: the set that answers for the chain and each set it supersedes. The Render setup names the same records by path, taken from the address book it was built with. |
| `BURSAR_ALERT_WEBHOOK` | unset | Slack, Discord or Telegram (`sendMessage?chat_id=`) URL. Unset means the log is the only channel. |
| `RESOLVER_HTTP_HOST` | `127.0.0.1` | `0.0.0.0` on a host that routes to it. |
| `RESOLVER_HTTP_PORT` | `10000` | |
| `RESOLVER_JOURNAL_PATH` | `./resolver-journal.json` | File journal. |
| `RESOLVER_DATABASE_URL` | unset | Postgres journal instead of the file. |
| `RESOLVER_VIEWING_KEY` | derived | Opens disclosure grants (escrow `DisclosureGranted` and the DisclosureRegistry) addressed to this service's keys. Unset derives each key's viewing key from its signature over the viewing-key message. A grant's input and output are used only when they hash to the lock's commitments; grants that do not open or do not check out are listed in the ruling's reasons. |
| `RESOLVER_OPERATOR_TOKEN` | unset | At least 32 characters. Unset turns overrides off. |
| `RESOLVER_OPERATOR_ADDRESSES` | unset | Every address the operator controls as payer or payee. Unset also turns overrides off. |
| `RESOLVER_POLL_MS` | `30000` | |
| `RESOLVER_BLOCK_RANGE` | `5000` | Widest `eth_getLogs` span. |
| `RESOLVER_START_BLOCK` | stored cursor, else head | Where the log scan starts. The reconcile pass covers every dispute id regardless. |
| `RESOLVER_CONFIRM_TIMEOUT_MS` | `60000` | How long a write waits for its receipt. |
| `RESOLVER_FETCH_TIMEOUT_MS` | `10000` | Per input or output fetch. Bodies are capped at 1 MB, redirects are refused and private addresses are never fetched. |
| `RESOLVER_MIN_GAS_WEI` | `100000000000000` | 0.0001 ETH per key. Below it the daily check warns. |
| `RESOLVER_HEARTBEAT_MS` | `86400000` | Daily key checks and heartbeat. |

Keys are never logged. A malformed key is reported by name only.

## Running it

```sh
pnpm --filter @bursar/resolver... build
RHC_RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com \
RESOLVER_KEYSTORE_DIR=$HOME/.config/bursar/keystore \
RESOLVER_PASSWORD_KEYCHAIN=bursar-rh-deployer/keystore \
node services/resolver/bin/bursar-resolver.mjs
```

Run one instance. The backup runner below is the only thing that should share its keys.

## On Render

`scripts/render.ts` creates or updates `bursar-resolver` as a private service in Frankfurt with a
1 GB disk for the journal, and sets `BURSAR_RESOLVER_URL` on `bursar-app`. A private service is
used rather than a background worker because the console has to reach it, and a worker cannot
receive private network traffic. The keys are decrypted from the local keystores in the script's
memory and sent only to Render's API.

```sh
pnpm --filter @bursar/resolver render --dry-run   # the plan, with secrets redacted
pnpm --filter @bursar/resolver render
```

The operator token is kept in `~/.config/bursar/resolver.env`. Put `BURSAR_ALERT_WEBHOOK=...`
there too, or export it, before running the script.

## Backup runner

`bursar-resolver-backup` holds the keystores and nothing else. It re-derives each salt, recovers
each score from the chain, and reveals.

```sh
bursar-resolver-backup status 3
bursar-resolver-backup reveal-now 3
bursar-resolver-backup reveal-due    # every dispute in its reveal window
```

It reads the same variables as the service and refuses `RESOLVER_KEYS`. Run `reveal-due` hourly on
the operator machine, for example from a launchd agent or cron:

```
0 * * * * cd ~/Projects/bursar && RHC_RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com RESOLVER_KEYSTORE_DIR=$HOME/.config/bursar/keystore RESOLVER_PASSWORD_KEYCHAIN=bursar-rh-deployer/keystore node services/resolver/bin/bursar-resolver-backup.mjs reveal-due >> $HOME/Library/Logs/bursar-resolver-backup.log 2>&1
```

Running it beside the live service is safe. A reveal already made fails its simulation and
nothing is sent.

## Alerts

INFO: dispute observed with the provisional ruling, ruling decided, dispute ruled, the daily
heartbeat. WARN: a key benched, the standby signing, a key under its gas floor or off its bond,
open votes disagreeing with the journal. CRITICAL: quorum at risk, a reveal still owed, the
backup runner needed, quorum missed, a dispute closed as failed (refunded on v1, reopened on v2), a lock still frozen after the
vote, the 40-hour watchdog. Each is sent once per dispute. Point an uptime check at
`https://app.bursar.world/api/rulings/health`, so a service that stops sending heartbeats is also
noticed.

## Tests

```sh
pnpm --filter @bursar/resolver test
BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com pnpm --filter @bursar/resolver drill
```

The drill forks 4663 at the latest block with anvil, bonds three drill keys into the live registry,
and runs the service against no evidence, valid evidence, invalid evidence, a third party that
commits and never reveals, a dead primary RPC, and a restart with an empty journal. A full node is
enough; no archive is needed.
