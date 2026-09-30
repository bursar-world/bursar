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

With `gasDrop: true` and a recipient that has no code and less than one drop of ETH, the relayer
sends `RELAYER_GAS_DROP_ETH` along in the same transaction, capped at
`RELAYER_GAS_DROPS_PER_HOUR`.

## Use

```sh
pnpm --filter @bursar/relayer build
bursar-relayer run
```

Key: `RELAYER_PRIVATE_KEY`, or `RELAYER_KEYSTORE` with `RELAYER_PASSWORD_FILE`. `PORT` (4321),
`RELAYER_FEE_BPS` (50, at most the pool's 500), `RELAYER_FEE_RECIPIENT` (the relayer address),
`RELAYER_GAS_DROP_ETH` (0.00015), `RELAYER_MIN_WITHDRAWAL` (the pool's minimum deposit, from the
deployment record).

HTTP: `GET /v1/quote`, `POST /v1/relay` with `{ withdrawal, proof, gasDrop? }`, `GET /health`.
The SDK's `fetchRelayQuote` and `submitRelay` speak it.
