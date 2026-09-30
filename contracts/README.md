# Bursar contracts

The Solidity contracts that hold and move money in Bursar. A principal's spending limits live in a
`MandateAccount`, so a payment past them reverts on chain. Payments to providers go through an
`Escrow` that holds each one for the life of one job, with an on-chain dispute path. Everything
that can be administered is administered by a two-of-three `AdminTimelock`, whose delay is one hour
today and 48 hours from launch. Agent stakes, resolver bonds and BRSR stakes take seven days to
withdraw whatever the delay, so a staked party sees a pending change but cannot leave before it
lands. The set is deployed on Robinhood Chain mainnet (chain 4663) and settles in USDG.

Read the status section of the root [README](../README.md) before funding anything on mainnet,
and [SECURITY.md](../SECURITY.md) before reporting a problem.

## Layout

| Path | What it holds |
|---|---|
| `src/MandateAccount.sol` | One principal's mandate: per-call, daily and monthly caps, allowed payees and capabilities, an approval threshold above which a human signs, and an agent key that can spend inside all of it. |
| `src/MandateAccountFactory.sol` | Creates mandate accounts at addresses a principal can compute before funding them. No admin. |
| `src/Escrow.sol` | Locks one payment per job, releases it to the payee, refunds on timeout or cancellation, and freezes it for a ruling on dispute. Its fee and windows are fixed at construction; the timelock can stop new payments and disputes, and nothing else. |
| `src/Reputation.sol` | Settlement history per payee, and the spending cap derived from it. |
| `src/OracleRegistry.sol` | Bonded resolvers who rule on disputes by commit-reveal vote, and their rewards and slashing. |
| `src/AgentRegistry.sol` | Staked directory of the payees a mandate may pay. |
| `src/AdminTimelock.sol` | Two-of-three governance with a delay, and a guardian that can only pause. |
| `src/token/` | `BRSR` (fixed supply), `Vesting`, `Staking` (resolver bonds, first-loss stake and fee rebates), `Buyback`, and `V4LiquiditySeeder`, which holds the BRSR/USDG position. |
| `src/rwa/` | Stock purchases and the treasury park, priced by feeds and checked against pinned pools, and the collateral lane: `CreditPool` lends to mandates against stock posted in `CollateralVault`. |
| `src/privacy/`, `src/zk/` | Committed mandates, whose terms are a commitment and whose spends are proven within them, disclosure grants and the solvency log. |
| `src/shielded/` | Shielded settlement on Privacy Pools: a USDG pool and a relay that screens recipients. |
| `script/` | The deploy scripts, each with a verify companion, the scripts that move one deployment into the next, and two rehearsals. Start with [`script/README.md`](script/README.md). |
| `deployments/` | One record per deployment on 4663: addresses, roles, the parameters applied, and the state read back. `schema.json` describes them. `@bursar/core` generates its address book from these files. |
| `test/` | Unit, fuzz and invariant tests. `test/script/` deploys through the real scripts and runs every lane; `test/script/fork/` does the same on a fork of Robinhood Chain. |
| `verification/` | The compiler input for each deployed contract, for source verification. |

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

The suites under `test/script/fork/` deploy the contract set through the scripts onto a fork of
Robinhood Chain and run the lanes against live state: the feeds, the pinned pools, USDG and the
BRSR/USDG market. They skip unless `BURSAR_RHC_FORK_RPC` names an endpoint for chain 4663. They
fork the latest block, so the public endpoint serves them. A stock purchase needs the equities
feeds inside their trade bound, which they are through the 24/5 session, so the lanes that buy skip
at weekends.

```sh
BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/script/fork/*'
```

`test/script/LocalChain.t.sol` runs the lanes against a local rehearsal and skips unless
`BURSAR_LOCAL_RPC` is set; `script/local/rehearse.sh` sets it. A suite that skips prints the
reason next to `SKIP` in the test output.

`forge build` does not run the linter. CI runs it over the code that deploys, at high severity:

```sh
forge lint --severity high --deny warnings src script
```

It passes, printing nothing and exiting 0, when no high-severity finding is left in `src/` or
`script/`. Any finding fails it, and names the file and line. A finding that is there by design
carries an inline `forge-lint: disable-next-line(<lint>)` comment saying why. `forge lint` on its
own lists every finding, informational ones included.

After changing a contract's interface, regenerate the TypeScript ABIs with
`pnpm --filter @bursar/core codegen` from the repository root.

## Deploying

[`script/README.md`](script/README.md) covers how a deployment is described, every script in
order, every parameter and each condition under which a script refuses to run.
[`script/TOKEN-README.md`](script/TOKEN-README.md) covers BRSR, staking, the buyback and the market.
[`script/MIGRATION.md`](script/MIGRATION.md) is the runbook for moving the current deployment on
Robinhood Chain to the new contract set. Every key signs from an encrypted keystore; no private key
is ever passed on the command line.

## Source verification

`script/verify.mjs` submits each contract in `verification/manifest.json` to Sourcify, to
Blockscout's shared verification store and to the Robinhood Chain explorer, then waits until the
explorer shows the source. It needs `BLOCKSCOUT_API_KEY`.

```sh
node script/verify.mjs --only <name,name>      # submit, then wait
node script/verify.mjs --status                # only report
```

Each entry names the contract's address, compiler, constructor arguments and linked libraries, and
its compiler input sits beside the manifest as `<name>.json`. For a newly deployed contract, write
that input with `forge verify-contract <address> <path>:<Contract> --show-standard-json-input`, and
take the constructor arguments from the run's transaction log.

## License

MIT. See [LICENSE](../LICENSE). `script/lib/V4Math.sol` includes MIT-licensed arithmetic adapted
from Uniswap v4. `vendor/privacy-pools-core` and `src/shielded/ShieldedPool.sol` are Apache-2.0;
`vendor/zk-kit-lean-imt` and `vendor/poseidon-solidity` are MIT. See [NOTICE](../NOTICE).
