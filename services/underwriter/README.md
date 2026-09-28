# @bursar/underwriter

Decides whether an agent may spend, and records the decision.

The MandateAccount is the authority. Everything the contract enforces is read from the contract
before an answer is given, and a spend this service allows is a spend the account would allow. What
this service adds is the part the contract has no view on: the action rules in a principal's
mandate document, a lifetime ceiling, and an append-only record of every decision that can be
verified by anyone holding the file.

Every path that cannot establish that a spend is permitted refuses it. A chain that will not
answer, a revert selector this build does not recognise, a Merkle gate with no proof: all refusals.

## Running it

Build once, then run the command the build puts on your path. These three are what a first run in
the default `chain` mode will not start without:

```
pnpm --filter @bursar/underwriter build

RHC_RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com \
MANDATE_ACCOUNT=0x... \
MANDATE_SUBJECT=agent-1 \
bursar-underwriter
```

The second endpoint has a default: set `RHC_RPC_FALLBACK` to an independent provider of your own,
or leave it and take the keyless one recorded for the network. Two endpoints at the same host are
refused, because a fallback sharing a host with the primary goes down at the same moment it does.

Start it with something missing and it names the variable and the format it expected, and exits
without binding a port. `pnpm --filter @bursar/underwriter start` runs the same build output where
the command itself is not on your path.

Listens on **127.0.0.1:8403**, one port above the facilitator. `UNDERWRITER_HOST` and
`UNDERWRITER_PORT` move it. A listener on anything other than loopback requires
`UNDERWRITER_AUTH_TOKEN`, and the token guards every route including health.

| Route | What it answers |
|---|---|
| `GET /healthz` | The process is up and serving. What a supervisor restarts on. |
| `GET /readyz` | A decision can be taken now: a mandate is bound, its journal is claimed, the chain answered, and every account this process speaks for answered as a MandateAccount. 503 otherwise. |
| `GET /v1/mandates` | Every mandate this process speaks for. |
| `GET /v1/mandates/{subject}` | One, with its account, document hash and journal root. 404 if it holds none. |
| `POST /v1/underwrite` | A decision. Body: `subject`, `requestId`, `action`, `amountMicro`, `merchant`, and a capability, either as `capabilityId` or as an `action` written in the label form it is derived from. `at`, `merchantProof` and `deadline` are optional. |
| `POST /v1/settlements` | Resolves a held call: `subject`, `requestId`, `resolution` of `approve` or `deny`, and optionally `at` and `merchantProof`. An approval is underwritten again before it is granted, so an account behind a Merkle merchant gate needs the proof sent again here. |
| `POST /v1/refunds` | Records money the escrow gave back: `subject`, `requestId`, `amountMicro`, `escrowId`, and optionally `at` and `txHash`. The lock is read from the escrow first. |
| `GET /v1/journal/{subject}` | A page of the decision log with its root, for reconciling against the facilitator's `bursar_authorizations`. `from` and `limit` page it; `nextFrom` in the answer is the sequence to ask for next. |

`/readyz` reads each bound account before it reports ready. An address with no contract at it binds,
claims a journal and passes every other check, then refuses every decision with
`underwriter_chain_unavailable`, which is the one state where a readiness probe is worse than none.

Amounts cross as decimal strings of atomic micro-USD under the name `amountMicro`, the same name
the facilitator uses for the same quantity. `amountMicros` is accepted as a deprecated spelling. A
JSON number is a double and cannot carry a micro-USD amount exactly, so a number is refused rather
than rounded.

A request with more than one thing wrong with it is answered once, with all of them:

```json
{
  "error": "underwriter_request_invalid",
  "detail": "The request is not usable:\n  requestId: missing (expected a non-empty string)\n  amountMicro: missing (expected a decimal string of atomic micro-USD, for example \"1500000\")",
  "details": { "problems": [{ "field": "requestId", "reason": "missing", "expected": "a non-empty string" }] }
}
```

### The capability a spend falls under

Every decision needs one. The MandateAccount holds its capability allowlist as the keccak of a
label like `doc.summarize:1`, so there is nothing to decide against without it. Write the action as
that label and the id is derived from it; send `capabilityId` yourself if your actions are named
some other way. An action that is not a label and carries no id is refused as an invalid request
naming the field, never as a capability the mandate disallowed:

```
capabilityId is required: the account holds its allowlist as the keccak of a capability label, and
the action "summarize a document" is not one. Send capabilityId, or write the action as a label
such as doc.summarize:1 and it will be derived.
```

`at` defaults to the moment the request arrives, and a caller that sends its own is held to the
chain's clock within `UNDERWRITER_DEADLINE_DRIFT_SECONDS`. It decides the validity window and both
rolling windows, which are the limits the contract does not enforce, so a request dated a day
forward would otherwise buy itself a fresh daily allowance.

## Where mandate documents come from

`MANDATE_DOCUMENT_SOURCE` picks one, and `chain` is the default.

**`chain`** derives the terms from the live MandateAccount. No principal wrote a document, so the
account is both the authority and the description. It adds no limit the contract does not have:
the action rules admit everything, because the capability allowlist is the contract's gate, and the
lifetime ceiling is the widest amount the account can store, so it cannot bind. The merchant roster
and the capability allowlist are left undeclared, because neither mapping can be enumerated through
a read.

```
MANDATE_DOCUMENT_SOURCE=chain
MANDATE_ACCOUNT=0x…            the account this process speaks for
MANDATE_SUBJECT=agent-1        the agent id the facilitator asks about
```

**`file`** reads a JSON file holding one mandate document or an array of them. The file is re-read
on demand, so rewriting a mandate does not need a restart. A document that names no `account` is
rejected: a mandate that does not say which account it governs cannot be compared against one.

```
MANDATE_DOCUMENT_SOURCE=file
MANDATE_DOCUMENT_PATH=./mandates.json
```

**`postgres`** reads `bursar_documents`, one row per subject, created on first load. The row
repeats the subject and the account the document already carries so an operator can index on them;
a row whose columns disagree with its JSON is refused.

```
MANDATE_DOCUMENT_SOURCE=postgres
UNDERWRITER_DATABASE_URL=postgres://…
```

In every mode the contract wins a disagreement, and the disagreement is emitted as a divergence so
an operator finds out that a document being circulated no longer describes the live limits.

## The spend journal, and why only one process may hold it

Every decision is appended to a hash-chained journal, one per MandateAccount. The lifetime ceiling
is reserved by replaying that journal, which makes the journal the reservation. Two processes each
replaying their own copy would each see the whole ceiling unspent, and a principal who wrote a
10,000 USDG lifetime ceiling would have written two.

So a journal is claimed exclusively at startup, and a process that cannot claim one refuses to
start rather than reserving against a ceiling somebody else is already drawing on.

With `UNDERWRITER_DATABASE_URL` set, the journal lives in Postgres and the claim is a session
advisory lock. A process that dies drops its connection and the lock with it, so a replacement
starts without anyone clearing state by hand. Entries are keyed on `(account, seq)`, and that is
the part that makes the reservation authoritative: a second writer
appending at a sequence that already exists fails the insert, so the decision is never returned and
nothing is reserved twice. This is the only arrangement in which several hosts can be pointed at
one account safely. If the connection holding the lock fails, the claim goes with it and that
account's decisions fail until the process is restarted.

Without it, the journal is a file per account under `UNDERWRITER_JOURNAL_DIR` (`./.mandate/journal`
by default, relative to wherever the process was started) and the claim is a lock file beside it.
That covers one host. A lock naming this host and a process id nobody is running is taken over,
which is what makes a restart after a crash ordinary. A lock nobody has renewed for five minutes is taken over too, whatever host it names,
because a reboot and a container that comes back under a new name both leave one behind and neither
is a reason to wait for somebody to delete a file. The holder restates its claim every thirty
seconds for as long as it is running, and reads it again before every append. A process whose lock
has been taken over stops writing to that journal, and its decisions for the account fail until it
is restarted.

Beside each journal is a marker naming the last sequence written and that entry's hash. A journal
that does not reach its marker is refused: a volume that did not mount and a
first run present the same empty directory, and the difference between them is every micro of the
lifetime ceiling already spent. The Postgres journal keeps the same marker in a row of its own.

### Refunds

`Escrow.timeout` returns a lock's amount to the payer and credits the MandateAccount's own buckets,
and a split ruling from `Escrow.resolve` returns part of one. This service cannot see either
happen, so whoever watches the escrow reports it to `POST /v1/refunds` under the request id the
lock was opened for and the lock's `escrowId`. Nothing is recorded until the escrow confirms it:
the lock has to be `TimedOut`, `Cancelled` or `Resolved`, its payer has to be this account, and it
has to have held at least the amount claimed. Each lock is credited once. The refund is appended to
the journal as an entry of its own and credited to the window the spend was charged to, which is
the same rule a denied hold follows. Without it the
rolling windows and the lifetime ceiling applied here decay toward zero against a contract that has
already given the money back.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `UNDERWRITER_HOST` | `127.0.0.1` | |
| `UNDERWRITER_PORT` | `8403` | |
| `UNDERWRITER_AUTH_TOKEN` | | Required off loopback. At least 32 characters. |
| `RHC_NETWORK` | `mainnet` | Chain 4663, the network that carries USDG. `testnet` (chain 46630) is refused at startup: it carries no USDG, so nothing a decision authorised could settle. |
| `RHC_RPC_PRIMARY` | required | Metered endpoint. |
| `RHC_RPC_FALLBACK` | keyless endpoint for the network | Independent second endpoint. It has to be a different host from the primary. `RHC_RPC_TERTIARY` is optional. |
| `MANDATE_DOCUMENT_SOURCE` | `chain` | `chain`, `file` or `postgres`. |
| `MANDATE_ACCOUNT`, `MANDATE_SUBJECT` | | Required in `chain` mode. |
| `MANDATE_DOCUMENT_PATH` | | Required in `file` mode. |
| `UNDERWRITER_DATABASE_URL` | | Required in `postgres` mode. Also moves the journal to Postgres. |
| `UNDERWRITER_JOURNAL_DIR` | `./.mandate/journal` | Used when no database is configured. |
| `UNDERWRITER_SIMULATE` | `true` | Re-check an allow by simulating the whole `spend` call. One extra `eth_call` per decision. A request that names no deadline is simulated against the earliest one the escrow would accept. |
| `UNDERWRITER_DEADLINE_DRIFT_SECONDS` | `30` | How far the block including the lock may be ahead of the block the quote was taken against, and how far a request's `at` may sit from the chain's clock. |
| `UNDERWRITER_RELOAD_SECONDS` | `30` | How often the document store is re-read for a subject it has not seen. A read that fails is re-raised until one succeeds, never rendered as a subject with no mandate. |
| `UNDERWRITER_HOLD_EXPIRY_SECONDS` | `86400` | How long a held call may wait for its principal. Past this, approving it is refused rather than paid. |
| `UNDERWRITER_DATABASE_MAX_CONNECTIONS` | `20` | Connections the pool may open. One is pinned per mandate for its journal claim, so this has to stay above the number of mandates. |

## Reaching it from the facilitator

Set `BURSAR_UNDERWRITER_URL` on the facilitator and it calls this service over HTTP. Leave it
unset and configure `MANDATE_DOCUMENT_SOURCE` there instead, and the facilitator runs an
underwriter inside its own process against exactly these variables, claiming the same journals
without opening a second listener. Moving from one to the other is a change of address.

A facilitator configured with neither refuses to start. `POST /underwrite` answering 501 is a
correct response from a facilitator that only settles, and it is set by
`FACILITATOR_UNDERWRITER=none`, so it is a decision an operator made. Forgetting a variable cannot
produce it.

## Tests

```
pnpm --filter @bursar/underwriter test
```

The journal and document-store tests that need a server are skipped without one:

```
BURSAR_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm --filter @bursar/underwriter test
```

The suite creates its own databases inside that server and drops them afterwards.

## Clearing a journal

The journal carries a head marker: the sequence and hash of the last entry it wrote. On open, a
journal that replays fewer entries than its marker recorded is refused, because that is what a
volume which failed to mount looks like, and the lifetime ceiling is reserved inside the entries
that went missing. An empty journal would hand back everything already spent.

So clearing a journal means clearing its marker in the same breath. For a decommissioned mandate:

```sql
DELETE FROM underwriter_journal_head WHERE account = lower('0x…');
DELETE FROM underwriter_spend_log    WHERE account = lower('0x…');
```

On the file store, remove the `.head` file beside the journal along with the journal itself.
Leaving one without the other is the case the marker exists to catch, and the service will refuse
to start for that account until they agree.

## License

MIT. See [LICENSE](../../LICENSE).
