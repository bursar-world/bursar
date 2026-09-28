# @bursar/sidecar

The provider-side worker. It watches the escrow for locks naming this payee, runs the
capability the payer asked for, and settles the payment by committing to the output it
delivered.

```
Locked(id, payer, payee) ──► fetch input ──► verify inputCommit ──► call the capability
                                                                         │
                          release(id, outputCommit, outputURI) ◄─────────┘
                                       │
                          dispute window closes
                                       │
                          finalizeRelease(id)  ──► the reputation counter that sets the cap
```

The sidecar never holds a payer's key and cannot move a payer's funds. It signs only this
payee's own `release`, `finalizeRelease` and `dispute` calls, against funds the escrow already
holds.

## Why `finalizeRelease` matters

`release` pays the payee immediately. It does not write the reputation counter while a
dispute window is open, because the same lock can still be contested and one lock is worth
one counter. A separate `finalizeRelease(id)` writes it once the window closes, and reverts
`TooEarly` before then.

That counter is what `Reputation.capOf` reads, and that cap is the ceiling on the next lock
any payer can open with this payee. A payee that never finalises holds its own ceiling down
without ever seeing why. The sidecar calls it, which is the reason to run one.

## Running it

Build once, then run the command the build puts on your path.

```
pnpm --filter @bursar/sidecar build
bursar-sidecar
```

It reads its configuration from the environment. Put it in a file the process manager loads, with
permissions that match what is in it:

```
# /etc/bursar/sidecar.env, chmod 600
PAYEE_PRIVATE_KEY=0x...
API_BASE=https://api.internal
RHC_RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com
ESCROW_ADDRESS=0x...
CAPABILITIES_PATH=/etc/bursar/capabilities.json
```

```
systemd-run --unit bursar-sidecar --property EnvironmentFile=/etc/bursar/sidecar.env bursar-sidecar
```

The key never goes on a command line. Anything in `argv` is readable by every process on the
machine through `ps`, lands in the shell history of whoever typed it, and is copied into the logs
of most process supervisors. That is true of a key on a one-off run as much as of one in a script.

It also needs a capabilities file. `CAPABILITIES_PATH` defaults to `capabilities.json` in
the working directory, so a run started anywhere else needs the variable set. Those four
variables and that file are the whole of what it will not start without. `ESCROW_ADDRESS`
drops off that list once a deployment is recorded for the chain.

The file declares the work this payee sells, keyed by `"name:version"`, the same label the
escrow hashes into `capabilityId`. `capabilities.example.json` in this package is a working
one to copy. A capability absent from the file is never executed.

```
cp node_modules/@bursar/sidecar/capabilities.example.json ./capabilities.json
```

One sidecar per payee. The first thing it does is claim `STATE_PATH`, and a second one pointed
at the same payee refuses to start rather than running every job twice, signing from the same
key at two nonces and overwriting the first one's cursor. A claim left by a process that is
gone is taken over without anybody being asked, and so is one nobody has renewed for five
minutes, which is what a reboot and a renamed container both leave behind. If another sidecar
takes the claim over while this one is running, this one logs `claim_lost`, stops before it signs
anything else, leaves the cursor alone and exits with status 1.

Everything else in the table below has a default, including the second endpoint: set
`RHC_RPC_FALLBACK` to an independent provider of your own, or leave it and take the keyless
one. Two endpoints at the same host are refused, because one name for one endpoint is one
rate meter and no second opinion.

To run from source without building, `pnpm --filter @bursar/sidecar start` takes the same
environment.

Start it with a variable missing and it names every one it could not read, one line each,
with the format that variable expected, and exits without opening a connection. Start it
with no capabilities file and it names the path it looked in and the example to copy.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAYEE_PRIVATE_KEY` | required | This payee's key. Never logged, never echoed in an error. |
| `API_BASE` | required | Where the capability implementations are served. |
| `RHC_RPC_PRIMARY` | required | Metered endpoint. |
| `RHC_RPC_FALLBACK` | keyless endpoint | Independent second endpoint. It has to be a different host from the primary. |
| `RHC_RPC_TERTIARY` | unset | Optional third endpoint. |
| `RHC_NETWORK` | `mainnet` | Chain 4663, and the only value that works. `testnet` is refused: 46630 has no USDG contract, so nothing there settles. Chain values are overridden through `RHC_MAINNET_*`, which is also how a local fork of 4663 is configured. |
| `ESCROW_ADDRESS` | deployment record | The escrow to answer. |
| `ESCROW_ADDRESSES` | unset | Several escrows to answer, comma-separated, for a payee with open locks on an earlier deployment as well as the current one: list both. Joined with `ESCROW_ADDRESS` when both are set. One process watches all of them, signing from the one payee key; each keeps its own outputs and cursor under `<OUTPUT_DIR>/<chainId>-<escrow>/`, so `STATE_PATH` must be unset. |
| `CAPABILITIES_PATH` | `capabilities.json` | Route table. The file is required; only its path has a default. |
| `ALLOWED_HOSTS` | none | Hosts an input URI may be fetched from, comma-separated. Loopback is not allowed unless it is listed. Base64 `data:` inputs need no entry. |
| `OUTPUT_DIR` | `./out` | Where delivered outputs are written, as `<chainId>-<escrow>/<id>.json`. |
| `OUTPUT_BASE_URL` | unset | Public base for outputs too large to carry in calldata. |
| `STATE_PATH` | `<OUTPUT_DIR>/<chainId>-<escrow>/cursor.json` | Scan cursor and in-flight locks. Only with a single escrow. |
| `START_BLOCK` | stored cursor, else head | Set to replay. Overrides the cursor. |
| `POLL_MS` | `2000` | Pause between passes. |
| `FETCH_TIMEOUT_MS` | `10000` | Per HTTP request. |
| `CONFIRM_TIMEOUT_MS` | `60000` | How long to wait for a write to mine. |
| `MAX_BODY_BYTES` | `1048576` | Cap on any fetched body. |
| `MAX_INLINE_OUTPUT_BYTES` | `4096` | Above this the output travels by commitment. |
| `MAX_BLOCK_RANGE` | `1000` | Widest `eth_getLogs` span. |
| `FINALIZE_RELEASES` | `true` | Turn off only if something else finalises. |
| `ESCALATE_EXPIRED` | `false` | Contest a lock whose deadline passed after delivery. |
| `ESCALATE_MAX_BOND` | required when escalating | Largest bond this payee will post, in micro-USD. |
| `MIN_GAS_WEI` | unset | Warn below this fee budget, in wei of ETH. |
| `GAS_CHECK_MS` | `300000` | How often the fee budget is read. |
| `SIDECAR_EVIDENCE_URL` | unset | Where signed delivery evidence goes when a delivered lock is disputed. For Bursar's resolvers, `https://app.bursar.world/api/evidence`. |

Amounts are six-decimal micro-USD atomic units: `250000` is 0.25 USDG.

Fees are a different asset. The payee earns USDG and pays for `release`, `finalizeRelease`
and `dispute` in ETH, so a payee can be earning steadily and still be unable to settle.
`MIN_GAS_WEI` is what makes that visible before it stops the sidecar: it is read in wei,
and a value written for a chain where gas was the settlement asset is ignored rather than
reinterpreted.

## Contesting an expired deadline

A lock whose deadline has passed can no longer be released, but the money is still held
until someone calls `timeout` and refunds the payer. With `ESCALATE_EXPIRED` on, a payee
that already produced and committed to an output contests the lock instead of losing the
work, which freezes the funds for a resolver to split.

That costs a bond of `disputeBondBps` of the locked amount, kept if the ruling goes against
the payee, and a resolver fee off the top of whatever is awarded. It is off by default, it
requires a ceiling on the bond, and the sidecar checks the settlement allowance before
spending gas on a call the escrow would revert.

## Evidence when a payer disputes

A payer can dispute a lock before the payee releases it. The release then reverts, and no output
ever reaches the chain, so to the resolvers the lock looks exactly like a job nobody did. Their
published policy rules that a full refund.

With `SIDECAR_EVIDENCE_URL` set, the sidecar answers that. When a lock it has already executed
turns `Disputed` before release, it signs a `DeliveryEvidence` statement with the payee key
(the escrow, the lock id, the input and output commitments, and where the output can be
fetched) and posts it to the resolvers' evidence inbox. It does the same after contesting an
expired deadline itself. A transient failure is retried on a backoff; a refusal is logged as
`evidence_abandoned` and the lock is let go.

The output has to be fetchable. Outputs up to `MAX_INLINE_OUTPUT_BYTES` travel inline as a
data URI; anything larger needs `OUTPUT_BASE_URL`, or there is nothing to send. Evidence has to
arrive within three hours of the dispute opening to count.

## What the log says

One JSON object per line. Only the fields a call site passes are emitted, so no key and no
raw environment reaches it. The events worth alerting on are `gas_low`,
`rpc_breaker_opened`, `rpc_all_providers_down`, `release_abandoned`, `finalize_abandoned`,
`state_write_failed`, `claim_lost`, `output_input_mismatch` and `output_unreadable`.

A revert carries the custom error the escrow raised, not only the sentence viem puts in front
of every one of them, so `TooEarly` and `BadStatus` read as different failures. A write that
failed reports `retryInMs`, and a `release` that left a transaction on the wire reports its
hash: those attempts are counted in confirmation windows, and a call that never produced a
transaction costs a retry and nothing else.

## Restarts

The cursor file records the scan position and every lock still in flight. A release waiting
out its dispute window survives a restart, which a block cursor alone would not: its
`Locked` event is already behind the cursor by the time the window closes.

A lock whose output was already delivered survives one too. The bytes under `OUTPUT_DIR` are
what the commitment on chain names, so a restart re-sends the answer it already committed to
rather than running the capability again, and an existing `<id>.json` is never overwritten.

Outputs live in a directory named for the chain and the escrow, for example
`./out/4663-0xabc…/42.json`, because a lock id is only unique within one escrow. Beside each output
is `<id>.input`, the input commitment it answered. A stored output is only re-sent for a lock with
that same input commitment. Otherwise the sidecar logs `output_input_mismatch`, sends nothing and
leaves the lock to run to its own timeout. With `OUTPUT_BASE_URL` set, serve `OUTPUT_DIR` as a whole:
published outputs are linked as `<OUTPUT_BASE_URL>/<chainId>-<escrow>/<id>.json`.

### Upgrading from unscoped outputs

Earlier versions wrote `<id>.json` and `cursor.json` directly under `OUTPUT_DIR`. Those files are
not read and not moved: nothing in them says which escrow they belong to. The sidecar logs
`unscoped_outputs_ignored` at startup when it finds them and starts a fresh cursor in the scoped
directory, from the head of the chain. To pick up where the old cursor left off, stop the old
version, confirm which escrow it was answering, and either move `cursor.json` and the `<id>.json`
files into `<chainId>-<escrow>/` yourself or set `START_BLOCK` to the old cursor's `nextBlock`. A
moved output that has no `<id>.input` beside it is not re-sent.

## Working through locks

Up to four locks are worked on at once, so one slow capability call does not hold up the rest.
Transactions are still sent one at a time, each confirmed before the next is signed. After a job
finishes, the sidecar reads the chain's clock again and does not sign a `release` for a lock whose
deadline has passed in the meantime.

The scan for new locks stays five blocks behind the head. The head and the logs can be answered by
different RPC providers, and a provider a few blocks behind would otherwise report no locks for
blocks it has not seen yet, after which the scan would never look at them again.

On `SIGTERM` the loop starts no new lock and signs no new transaction, and in-flight capability
calls are cancelled. One confirmation already in flight is waited out; past that the process exits
rather than holding a shutdown open for as many confirmation windows as it has locks. A job that
finished but was not released is re-sent from its stored output on the next start.

## License

MIT. See [LICENSE](../../LICENSE).
