# Bursar contracts

The Solidity contracts that hold and move money in Bursar. A principal's spending limits live in a
`MandateAccount`, so a payment past them reverts on chain rather than at a service. Payments to
providers go through an `Escrow` that holds each one for the life of one job, with an on-chain
dispute path. Everything that can be administered is administered by a two-of-three
`AdminTimelock` with a 48-hour delay. The set is deployed on Robinhood Chain mainnet (chain 4663)
and settles in USDG.

Read the status section of the root [README](../README.md) before funding anything on mainnet,
and [SECURITY.md](../SECURITY.md) before reporting a problem.

## Layout

| Path | What it holds |
|---|---|
| `src/MandateAccount.sol` | One principal's mandate: per-call, daily and monthly caps, allowed payees and capabilities, an approval threshold above which a human signs, and an agent key that can spend inside all of it. |
| `src/MandateAccountFactory.sol` | Creates mandate accounts at addresses a principal can compute before funding them. No admin. |
| `src/Escrow.sol` | Locks one payment per job, releases it to the payee, refunds on timeout or cancellation, and freezes it for a ruling on dispute. No admin; its fee and windows are fixed at construction. |
| `src/Reputation.sol` | Settlement history per payee, and the spending cap derived from it. |
| `src/OracleRegistry.sol` | Bonded resolvers who rule on disputes by commit-reveal vote, and their rewards and slashing. |
| `src/AgentRegistry.sol` | Optional staked directory of the counterparties a mandate may name. |
| `src/AdminTimelock.sol` | Two-of-three governance with a delay, and a guardian that can only pause. |
| `src/token/` | `BRSR` (fixed supply), `Vesting`, `Staking` (resolver bonds and fee rebates) and `Buyback`. |
| `script/` | `Deploy.s.sol` for the core set, `DeployToken.s.sol` for the token set, `SeedPool.s.sol` for the BRSR/USDG pool. |
| `deployments/` | What was deployed on 4663: addresses, transactions, parameters and the state read back from chain. `@bursar/core` generates its address book from these files. |
| `test/` | Unit, fuzz and invariant tests, plus fork tests against 4663. |

## Build and test

Requires [Foundry](https://getfoundry.sh) 1.8.1, the release pinned in
[`.foundry-version`](.foundry-version), which CI installs as well. From this directory:

```sh
foundryup --install "$(cat .foundry-version)"
```

Foundry downloads solc 0.8.24 and 0.8.28 on the first build: Bursar's own contracts use 0.8.24, and
the vendored Privacy Pools code and the shielded contracts that import it use 0.8.28, the compiler
upstream was audited with (`compilation_restrictions` in `foundry.toml`).

`lib/` is not committed and there are no git submodules. Install the dependencies once, from this
directory:

```sh
forge install --no-git --shallow \
  foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 \
  OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1
```

These are forge-std v1.9.4, OpenZeppelin Contracts v5.1.0 and OpenZeppelin Contracts Upgradeable
v5.0.2, the exact sources the deployed bytecode was built from. CI installs them with the same
command, by commit, because a tag can be moved.

`vendor/` is committed and unmodified: Privacy Pools core v1.3.0 (0xbow, Apache-2.0,
commit `c312dcd`), zk-kit `lean-imt.sol` 2.0.0 (MIT) and `poseidon-solidity` 0.0.5 (MIT). The
shielded pool (`src/shielded/`) builds on it; see [NOTICE](../NOTICE). Then:

```sh
forge build
forge test
forge fmt --check
```

Five tests fork Robinhood Chain and are skipped unless `BURSAR_RHC_FORK_RPC` names an RPC endpoint
for chain 4663. They fork at a pinned block, so the endpoint has to serve historical state, which
means an archive node. The public endpoint at `rpc.mainnet.chain.robinhood.com` is not one: it
answers a read at that block with `historical state ... is not available`, and the fork tests fail
there.

```sh
BURSAR_RHC_FORK_RPC=<archive RPC for 4663> forge test --match-path test/token/TokenRailFork.t.sol
```

`forge build` does not run the linter. Run `forge lint` for its findings.

After changing a contract's interface, regenerate the TypeScript ABIs with
`pnpm --filter @bursar/core codegen` from the repository root.

## Deploying

[`script/README.md`](script/README.md) covers the core set: every parameter, the order of
deployment, and each condition under which the script refuses to run.
[`script/TOKEN-README.md`](script/TOKEN-README.md) covers the token set and the governance calls
that follow it. Both use a Foundry encrypted keystore; no private key is ever passed on the
command line.

## License

MIT. See [LICENSE](../LICENSE). `script/lib/V4Math.sol` includes MIT-licensed arithmetic adapted
from Uniswap v4. `vendor/privacy-pools-core` and `src/shielded/ShieldedPool.sol` are Apache-2.0;
`vendor/zk-kit-lean-imt` and `vendor/poseidon-solidity` are MIT. See [NOTICE](../NOTICE).
