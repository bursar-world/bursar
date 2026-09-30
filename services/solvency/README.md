# @bursar/solvency

Once a day this service posts one root to `SolvencyLog` on Robinhood Chain. The root covers what
the protocol owes in USDG and the USDG it holds to pay it, contract by contract, read at a fixed
block. Anyone can rebuild the root from public chain data and check it.

## What a root covers

Each leaf is one contract in a deployment record the chain still reads, the newest set and every
set it supersedes:

- **Escrow.** Owes the amount and dispute bond of every open or disputed lock, plus fees booked
  and not yet swept. From v3 it also owes every payout a settlement could not deliver, held for its
  recipient until claimed; the escrow keeps no total of those, so each party to a lock, and the
  registry its resolver fees go to, is read once. Holds its USDG balance.
- **OracleRegistry.** Owes the reward float due to resolvers. Holds its USDG balance.

Leaves are sorted by id (`rhc-mainnet-v2:Escrow`, …) and hashed as
`keccak256(abi.encode(keccak256(id), liabilities, assets))`. Each parent is
`keccak256(abi.encode(left, right, sumLiabilities, sumAssets))`, and an odd level is padded with a
zero node. The root therefore commits to every leaf and to both totals.

Not covered: treasury-lane and stock positions (they sit in per-mandate vaults as tokens the
mandate owns, and valuing them needs a feed price), and BRSR bonds on the staking pool (a different
token).

## What it proves, and what it does not

This is phase A. Every input is public state, so the root needs no proof: it shows that public
obligations were covered by balances at that block. It says nothing about private notes. That
needs a zero-knowledge proof over committed balances, which is phase B and depends on shielded
settlement.

## Use

```sh
pnpm --filter @bursar/solvency build
bursar-solvency post --dry-run     # print today's root, send nothing
bursar-solvency post               # post today's epoch (skips if already posted)
bursar-solvency run                # post now, then daily at 00:10 UTC
bursar-solvency verify [epoch]     # rebuild a posted epoch and compare
```

`RHC_RPC_URL` picks the endpoint. `SOLVENCY_LOG` overrides the log address from the deployment
record. `SOLVENCY_KEYSTORE` and `SOLVENCY_PASSWORD_FILE` name the poster key, a v3 keystore as
`cast wallet import` writes it. Verifying an old epoch reads state at its block, so it needs an RPC
that serves historical state.
