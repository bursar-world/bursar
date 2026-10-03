# @bursar/relayer

Submits withdrawals from Bursar's shielded USDG pool for the people who own the notes. The
withdrawal transaction, its gas, and the first gas of a fresh recipient come from the relayer, so
nothing on chain connects the payout to a wallet the owner used before.

## What it checks

Before it sends anything, a request must name `ShieldedRelay` as processooor, this relayer's fee
recipient, and at least its fee; the proof's context must match the withdrawal; the recipient
must not be the relay, the pool or the Entrypoint, where a payout would sit with no note behind
it; the recipient and fee recipient must not be blocked by the Robinhood access registry; the note
must be unspent; the proof must be against the latest association-set root; and the call must
simulate. A refusal never sends a transaction, so the note stays spendable. The contract repeats
the recipient and registry checks, so a different relayer cannot pay those addresses either.

## Gas drops

With `gasDrop: true` the relayer sends the recipient `RELAYER_GAS_DROP_ETH` as a second
transaction, once the withdrawal has landed: the receipt reports success and carries the pool's
`Withdrawn` event for the note the proof spent. A withdrawal that reverts, or whose receipt shows no
such event, gets no gas.

The recipient has to be fresh: no code, no transactions sent, and less than one drop of ETH. Each
note gets gas once and each recipient gets gas once. The deposit label is a private input to the
withdrawal proof, so the relayer cannot see which deposit a withdrawal came from; the nullifier the
withdrawal spends is what one drop is tied to. Across all recipients the relayer sends at most
`RELAYER_GAS_DROPS_PER_DAY` drops in any rolling 24 hours. A request that asks for gas when the
day's budget is spent is refused with `gas_drops_exhausted` before anything is sent, so the caller
can withdraw without gas instead. A recipient that is not fresh, or a note or recipient that already
had gas, gets its withdrawal with `gasDropWei: "0"`.

A withdrawal that asks for gas pays for its drop. `GET /v1/quote` carries `gasDropFee`: what the
drop is worth in USDG at the current gas price, which is the ETH handed over at
`RELAYER_ETH_PRICE_USDG` plus the transfer that carries it. A request with `gasDrop: true` has to
carry a relay fee of at least `feeBps` of the withdrawal plus the drop's value, so a client adds
`ceil(gasDropFee × 10000 / amount)` basis points to `feeBps` when it asks for gas. One that does
not is refused with `fee_too_low` before anything is sent, naming the basis points that would do.
The relay contract caps the fee at 5% of the withdrawal, which sets the smallest withdrawal a drop
fits into: at 0.00015 ETH and 3,500 USDG per ETH, about 12 USDG. A smaller `RELAYER_GAS_DROP_ETH`
lowers it. Without this, a run of withdrawals to fresh addresses could empty the float for the
price of their fees.

While gas drops are on, `RELAYER_DATA_DIR` and `RELAYER_ETH_PRICE_USDG` are required, and the
service refuses to start without them. The ledger of drops lives in `gas-drops.jsonl` under the
data directory, so the once-per-note and once-per-recipient rules and the day's count survive a
restart; kept in memory, every restart would open a fresh daily budget. Gas drops are off with
`RELAYER_GAS_DROP_ETH=0` or `RELAYER_GAS_DROPS_PER_DAY=0`, and then neither variable is read.

## Use

```sh
pnpm --filter @bursar/relayer build
bursar-relayer run
```

Key: `RELAYER_PRIVATE_KEY`, or `RELAYER_KEYSTORE` with `RELAYER_PASSWORD_FILE`. `PORT` (4321),
`RELAYER_HOST` (every interface), `RELAYER_ALLOWED_ORIGINS` (`https://app.bursar.world`),
`RELAYER_FEE_BPS` (50, at most the pool's 500), `RELAYER_FEE_RECIPIENT` (the relayer address),
`RELAYER_GAS_DROP_ETH` (0.00015), `RELAYER_GAS_DROPS_PER_DAY` (50), `RELAYER_DATA_DIR` and
`RELAYER_ETH_PRICE_USDG` (no default; both required while gas drops are on),
`RELAYER_MIN_WITHDRAWAL` (the pool's minimum deposit, from the deployment record).
`RELAYER_GAS_DROPS_PER_HOUR` is no longer read, and the service refuses to start while it is set.

HTTP: `GET /v1/quote` answers `{ relay, feeRecipient, feeBps, gasDropWei, gasDropFee, chainId }`;
`POST /v1/relay` takes `{ withdrawal, proof, gasDrop? }`; `GET /health`. A relay answers
`{ transactionHash, gasDropWei }`, with `gasDropTransactionHash` when gas was sent. The SDK's
`fetchRelayQuote` and `submitRelay` speak it.

Browsers may call it from the origins in `RELAYER_ALLOWED_ORIGINS`, a comma-separated list that
defaults to the console. A listener on `RELAYER_HOST=127.0.0.1` also answers pages served from
this machine, such as a console on `http://localhost:4310`. Requests with no `Origin` header, from
the SDK or the MCP server, are not subject to it.

Every refusal is `{ error, detail }` with a stable `error` code. A fault inside the service answers
`internal` with one fixed sentence; what went wrong is written to the service's log and nowhere
else.
