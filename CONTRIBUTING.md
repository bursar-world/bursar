# Contributing to Bursar

Thanks for helping.

For a large change, or anything that touches a deployed contract, open an issue or a
[discussion](https://github.com/bursar-world/bursar/discussions) first so we can agree on the
approach before you spend time on it. Security problems go through [SECURITY.md](SECURITY.md),
never through a public issue.

## Development setup

You need Node.js 22 or newer, pnpm 11.20.0 (`corepack enable` installs the pinned version),
Foundry 1.8.1 (pinned in `contracts/.foundry-version`), and Docker if you want to run the database tests.

```sh
git clone https://github.com/bursar-world/bursar.git
cd bursar
pnpm install --frozen-lockfile
pnpm -r build

cd contracts
forge install --no-git --shallow \
  foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 \
  OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1
forge build
```

`contracts/lib/` is not committed and there are no submodules; the command above installs the
exact versions the deployed contracts were built from.

On a fresh checkout, `pnpm install` warns that it could not create some bins, such as
`bursar-facilitator`. Those bins point into each package's `dist/`, which does not exist until
`pnpm -r build` has run. The warning is expected and the build clears it; run `pnpm install` again
afterwards if you want the bins linked into `node_modules/.bin`.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Solidity sources in `src/`, tests in `test/`, deploy scripts in `script/`, deployment records in `deployments/`. |
| `packages/core` | Shared chain configuration, generated ABIs and addresses, money types, RPC pool. |
| `packages/sdk`, `packages/mcp`, `packages/x402` | The libraries agents and providers use. |
| `services/facilitator`, `services/underwriter`, `services/sidecar` | Long-running services, each a binary configured by environment variables. |
| `apps/web` | The Next.js console. |

Each package has its own README with its configuration and commands.

The packages are marked `"private": true` and are not published to npm yet. Use them from this
workspace through `workspace:*` dependencies.

## Running the tests

| Suite | Command |
|---|---|
| Everything in TypeScript | `pnpm -r test` |
| One package | `pnpm --filter @bursar/sdk test` (any package name works) |
| Type checks | `pnpm -r typecheck` |
| Contracts | `cd contracts && forge test` |
| Contract formatting | `cd contracts && forge fmt --check` |
| Contract lints | `cd contracts && forge lint` (`forge build` does not run them) |
| Database tests | `BURSAR_TEST_DATABASE_URL=postgres://... pnpm -r test` against any Postgres 16; the suites create and drop their own databases |
| Live chain checks | `BURSAR_LIVE_RPC=https://rpc.mainnet.chain.robinhood.com pnpm --filter @bursar/core test` |
| Contract fork tests | `BURSAR_RHC_FORK_RPC=<archive RPC for 4663> forge test`; the public endpoint does not serve the historical state they fork at |

CI runs the first five on every pull request. A change is not ready until they pass locally.

After changing a contract's interface, run `pnpm --filter @bursar/core codegen` and commit the
regenerated files in `packages/core/src/generated/`.

## Coding standards

Match the code around you. The conventions below are the ones the existing code already follows.

**TypeScript**

- The compiler runs in strict mode with `noUncheckedIndexedAccess` and no unused locals or
  parameters. Do not weaken `tsconfig.base.json` to get a change through.
- Object types are `readonly` by default, and data that crosses a module boundary is frozen.
- Money is a `bigint` in six-decimal micro-USD (`Micro` from `@bursar/core`). No floating-point
  number ever holds an amount. ETH for gas is a separate type in wei and is never added to or
  compared with USDG.
- Errors extend `BursarError` and carry a stable `code`, so callers branch on the code and not on
  message text. Messages are written for the person reading the log line, and name the variable
  or value at fault.
- Configuration is read once at start through `loadEnv`. It checks each declared variable on its
  own and throws one `EnvError` listing every variable that is missing or does not parse. Checks
  that span several variables, such as two roles sharing an address, run in each service after
  `loadEnv` returns and stop at the first failure. Either way a service refuses to start on a
  configuration it cannot run safely rather than failing later on a request.
- ES modules with explicit `.js` import suffixes, two-space indentation, single quotes.

**Solidity**

- Format with `forge fmt`. CI checks it.
- Revert with custom errors. Revert strings do not pass review.
- Anything an administrator can change goes through `AdminTimelock`. Parameters that should never
  change are constructor arguments or constants, with no setter.
- Contracts do not read native balances; value moves only in the settlement asset.

**Comments** explain why the code is the way it is. A comment that restates the next line is
removed in review.
Where the reason is a measured fact about the chain or a token, say what was measured and when.

**Tests** live next to the behaviour they cover: each package has a `test/` directory mirroring
`src/`, and each contract has a suite in `contracts/test/`. A bug fix comes with a test that fails
without it. Tests that need a network or a database skip cleanly when the variable that enables
them is unset.

## Commit messages

Write a short, lowercase subject in the imperative mood that says what the change does, without a
trailing period. Keep it under about 72 characters. Examples from the history:

```
stop the console throwing at a reader whose wallet already knows the site
read the dispute struct the shape it actually has
keep form buttons on the input's row
```

Add a body after a blank line when the reason for the change is not obvious from the subject.

## Developer Certificate of Origin

Every commit must be signed off:

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. By adding it you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org): that you wrote the change
or otherwise have the right to submit it under this project's MIT license. We use the DCO instead
of a contributor licence agreement. Pull requests with unsigned commits cannot be merged; `git
commit --amend -s` or `git rebase --signoff main` fixes them.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each pull request to one change. Refactoring mixed with a behaviour change is hard to
   review and will be asked to split.
3. Fill in the pull request template. Update the README of any package whose behaviour or
   configuration you changed, and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md)
   for anything a user would notice. We do not use changesets.
4. A maintainer reviews it. Changes to `contracts/` need a maintainer's approval, and a second one
   once the project has three or more maintainers.
5. Maintainers squash-merge once CI is green and review comments are resolved.

A merged contract change is not live until it is deployed and, where it replaces a deployed
contract, moved to through the process in [GOVERNANCE.md](GOVERNANCE.md).

## Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
