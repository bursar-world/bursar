# Bursar

[![CI](https://github.com/bursar-world/bursar/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bursar-world/bursar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/bursar-world/bursar/badge)](https://scorecard.dev/viewer/?uri=github.com/bursar-world/bursar)

Spending mandates for AI agents on Robinhood Chain.

A principal gives an agent a budget: how much per call, per day and per month, which providers
it may pay, for which capabilities, and above what amount a person has to approve. Those limits
live in a contract on chain, so a payment that exceeds them reverts there, whatever any service
in front of it says. The agent pays providers in USDG over [x402](https://www.x402.org), the HTTP
payment standard where a server answers `402` with a price and the client's retry carries the
payment. Each payment is held in escrow for the life of one job and can be disputed.

This repository holds all of it: the contracts, the TypeScript SDK and MCP server an agent
uses, the services that verify and settle payments, and the console at
[app.bursar.world](https://app.bursar.world). More at [bursar.world](https://bursar.world).

## Status

Bursar is live on Robinhood Chain mainnet (chain 4663) and settles in USDG. The first contracts
were deployed on 2026-09-22; the current set, the fourth, was deployed on 2026-10-01. They hold
real funds.

The caps on mainnet are deliberately low: a provider with no history can be paid at most 25 USDG
per job, and the cap rises 2.25 USDG per point of score to 250 USDG at a score of 100. The score is
the share of a provider's settled jobs that were delivered, weighed by what it has settled: a job
under 1 USDG counts for nothing, each payer counts for at most 62.5 USDG of settled work, and a
full score takes 250 USDG of it, so at least four payers. The cap applies to each payment, not to a
provider's total. Size any mandate you fund accordingly. [SECURITY.md](SECURITY.md) has the review
status and the trust assumptions behind these limits.

Packages are not yet published to npm. Build them from this repository.

## Repository layout

| Path | What it is |
|---|---|
| [`contracts/`](contracts/README.md) | Solidity contracts, Foundry tests, deploy scripts and the mainnet deployment records. |
| [`packages/core/`](packages/core/README.md) | Chain configuration, contract addresses and ABIs, money types, and the RPC pool every other package reads the chain through. |
| [`packages/sdk/`](packages/sdk/README.md) | What an agent developer imports to pay a provider inside a mandate. |
| [`packages/mcp/`](packages/mcp/README.md) | The same capability as an MCP server, for an agent without code of its own. |
| [`packages/x402/`](packages/x402/README.md) | The x402 codec and the `exact` EVM payment scheme for USDG. |
| [`services/facilitator/`](services/facilitator/README.md) | Verifies and settles x402 payments and keeps the ledger behind the funding lanes. |
| [`services/underwriter/`](services/underwriter/README.md) | Decides whether an agent may spend, against the live mandate account, and journals the decision. |
| [`services/sidecar/`](services/sidecar/README.md) | Runs on the provider's side: watches escrow for its jobs, does the work, releases payment. |
| [`apps/web/`](apps/web/README.md) | The console at app.bursar.world, for principals, providers, resolvers and governance. |
| `docs/` | The [ruling policy](docs/RULING-POLICY.md), the [invariants](docs/INVARIANTS.md) every contract holds, the [static analysis](docs/STATIC-ANALYSIS.md) each change is checked against, the [mutation score](docs/MUTATION.md) of the escrow's tests, and the [operations runbook](docs/RUNBOOK.md). |

## Architecture

```mermaid
flowchart TB
  subgraph users["People and agents"]
    direction LR
    P["Principal wallet"]
    C["Console<br/>app.bursar.world"]
    A["Agent<br/>SDK or MCP server"]
  end

  subgraph offchain["Services"]
    direction LR
    F["Facilitator<br/>x402 payments"]
    U["Underwriter<br/>spend checks"]
    R["Resolver service<br/>dispute votes"]
    S["Provider sidecar<br/>runs on the provider"]
  end

  subgraph chain["Robinhood Chain, chain 4663"]
    subgraph mandates["Mandates"]
      MF["MandateAccountFactory"]
      MA["MandateAccount"]
      CM["Committed mandates<br/>and proof verifier"]
    end
    subgraph settle["Settlement and trust"]
      E["Escrow"]
      OR["OracleRegistry"]
      AR["AgentRegistry"]
      REP["Reputation"]
    end
    subgraph rwa["Stocks, treasury and credit"]
      RG["AssetRegistry, PriceGuard<br/>and StockSpendRouter"]
      TP["TreasuryPark"]
      CV["CollateralVault<br/>and CreditPool"]
    end
    subgraph privacy["Privacy"]
      DR["DisclosureRegistry"]
      SL["SolvencyLog"]
      SP["ShieldedPool<br/>and Entrypoint"]
    end
    subgraph gov["Governance and token"]
      TL["AdminTimelock"]
      TOK["BRSR, Staking<br/>Vesting, Buyback"]
    end
    subgraph ext["Robinhood Chain assets and markets"]
      USDG[("USDG")]
      CL["Chainlink price feeds"]
      UNI["Uniswap v4"]
    end
  end

  P -->|"creates, funds, sets limits"| C
  P -.->|"approves payments above threshold"| MA
  C --> MF
  MF -->|"one account per mandate"| MA
  A -->|"pays inside its limits"| MA
  A -->|"x402 payment"| F
  F -->|"checks the spend"| U
  U -->|"reads limits"| MA
  F -->|"settles"| E
  MA -->|"locks each payment"| E
  CM -->|"locks each payment"| E
  S -->|"delivers and releases"| E
  AR -->|"provider caps"| E
  E -->|"records outcomes"| REP
  E -->|"disputed jobs"| OR
  R -->|"commits and reveals votes"| OR
  OR -->|"resolver bonds"| TOK
  MA -->|"stock, treasury, credit"| rwa
  RG --> CL
  RG --> UNI
  CV --> CL
  C -->|"private mandates, shielded funding"| privacy
  E -.->|"balances in daily root"| SL
  TL -->|"administers"| settle
  MA --- USDG
  SP --- USDG

  classDef own fill:#faf8f7,stroke:#49345f,color:#49345f
  classDef extn fill:#ffffff,stroke:#ecb29d,color:#49345f
  class P,C,A,F,U,R,S,MF,MA,CM,E,OR,AR,REP,RG,TP,CV,DR,SL,SP,TL,TOK own
  class USDG,CL,UNI extn
```

A principal sets limits in the console, and the factory deploys one mandate account for them. An
agent pays through that account, directly or as an x402 payment the facilitator checks and
settles. Each payment is locked in escrow until the provider's sidecar delivers the work and
releases it. A disputed job goes to bonded resolvers, who vote on chain. A static copy of the
diagram is at [architecture.svg](https://github.com/bursar-world/.github/blob/main/profile/assets/architecture.svg).

## Quick start

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22 or newer (`.nvmrc` pins 22) |
| pnpm | 11.20.0, pinned in `packageManager`. `corepack enable` installs it. |
| Foundry | 1.8.1, pinned in `contracts/.foundry-version` |
| Docker | Any current release, for the Postgres the facilitator uses |

### Install, build and test

```sh
git clone https://github.com/bursar-world/bursar.git
cd bursar

pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

To build only the SDK, build the workspace packages it imports along with it:
`pnpm --filter "@bursar/sdk..." build`. The package README,
[`packages/sdk/README.md`](packages/sdk/README.md), also covers running it against a local chain.

The contracts need their Solidity dependencies once. `contracts/lib/` is not committed:

```sh
cd contracts
forge install --no-git --shallow \
  foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 \
  OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1
forge build
forge test
```

Some tests need something the default run does not have, and skip without it:

| Variable | Adds |
|---|---|
| `BURSAR_TEST_DATABASE_URL` | Facilitator and underwriter tests against a real Postgres. |
| `BURSAR_LIVE_RPC` | Checks of the shipped ABIs and constants against the live deployment. |
| `BLOCKSCOUT_API_KEY` | Reads of the hosted chain index. |
| `BURSAR_RHC_FORK_RPC` | Contract tests against a fork of chain 4663. |

### Run the console

```sh
pnpm --filter @bursar/web dev
```

It serves on port 4310, or on `PORT` if set (open http://localhost:4310), and reads the live
contracts on chain 4663 through public RPC endpoints. No configuration is needed;
[`apps/web/README.md`](apps/web/README.md) lists the optional variables.

### Run the facilitator

Start Postgres:

```sh
docker run -d --name bursar-pg \
  -e POSTGRES_USER=bursar -e POSTGRES_PASSWORD=bursar -e POSTGRES_DB=bursar \
  -p 55432:5432 postgres:16
```

Create a throwaway relayer key with `cast wallet new`. Then start a facilitator that settles only
and takes no spending decisions of its own (the funding addresses below are placeholders; each
role needs its own address):

```sh
export DATABASE_URL=postgres://bursar:bursar@127.0.0.1:55432/bursar
export RHC_RPC_PRIMARY=https://rpc.mainnet.chain.robinhood.com
export FACILITATOR_RELAYER_KEY=0x...          # from cast wallet new
export FACILITATOR_GAS_FLOAT=0x...            # that key's address
export FACILITATOR_SETTLEMENT=0x0000000000000000000000000000000000000001
export FACILITATOR_COLLATERAL=0x0000000000000000000000000000000000000002
export FACILITATOR_TREASURY=0x0000000000000000000000000000000000000003
export FACILITATOR_GAS_FLOAT_MINIMUM_ETH=0.004
export FACILITATOR_FEE_BPS=100
export FACILITATOR_FEE_FLOOR_MICRO=1000
export FACILITATOR_UNDERWRITER=none

pnpm --filter @bursar/facilitator start
curl http://127.0.0.1:8402/config
```

It applies its migrations on start and listens on `127.0.0.1:8402`. `/healthz` reports
`degraded` until the relayer holds the ETH reserve, which is expected for a local run.
[`services/facilitator/README.md`](services/facilitator/README.md) documents every variable and
route, and the underwriter and sidecar READMEs do the same for those services. The same Postgres
serves the database tests:

```sh
BURSAR_TEST_DATABASE_URL=postgres://bursar:bursar@127.0.0.1:55432/bursar pnpm -r test
```

## Deployed contracts

Robinhood Chain mainnet, chain id 4663. Settlement asset: USDG at
[`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168).
The full records, including transactions, parameters and roles, are in
[`contracts/deployments/`](contracts/deployments).

### Current set (v4)

New mandates are created here. The fourth set was deployed on 2026-10-01 and is recorded in
[`rhc-mainnet-v4.json`](contracts/deployments/rhc-mainnet-v4.json). It keeps the third set's
timelock and token contracts; every other contract is new. It is a development deployment: its
timelock delay and its dispute vote windows are one hour each, so changes can be exercised within
a day. Before the public launch the delay returns to 48 hours and each vote window to six hours.

| Contract | Address |
|---|---|
| `AdminTimelock` | [`0xD91A6577828424E386900D0bB41596c6eF3BF8DF`](https://robinhoodchain.blockscout.com/address/0xD91A6577828424E386900D0bB41596c6eF3BF8DF) |
| `MandateAccountFactory` | [`0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562`](https://robinhoodchain.blockscout.com/address/0xC42dBCbd34E64e2D81B48866F673ddB7B42ba562) |
| `Escrow` | [`0x11e73B5632837355e250fC236cFC2Be03aD0845A`](https://robinhoodchain.blockscout.com/address/0x11e73B5632837355e250fC236cFC2Be03aD0845A) |
| `Reputation` | [`0x4FEa7af88C60988E80b065F6e2af071C7fB3F5E8`](https://robinhoodchain.blockscout.com/address/0x4FEa7af88C60988E80b065F6e2af071C7fB3F5E8) |
| `OracleRegistry` | [`0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3`](https://robinhoodchain.blockscout.com/address/0xbb628E362EceE9Ce16f2e48DD79f5ed4558596e3) |
| `AgentRegistry` | [`0x6501ABAb6aF58549De0Dd42040240665591c6C2a`](https://robinhoodchain.blockscout.com/address/0x6501ABAb6aF58549De0Dd42040240665591c6C2a) |

Stocks, treasury and credit:

| Contract | Address |
|---|---|
| `AssetRegistry` | [`0xbd4950505d45e53740DA4941B666B3C796818393`](https://robinhoodchain.blockscout.com/address/0xbd4950505d45e53740DA4941B666B3C796818393) |
| `PriceGuard` | [`0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36`](https://robinhoodchain.blockscout.com/address/0x1f7aaf32b34c8848784F51847dC7B23c50FA7b36) |
| `StockSpendRouter` | [`0x4061b1346bedE97DcA8D7295977B703046fA9905`](https://robinhoodchain.blockscout.com/address/0x4061b1346bedE97DcA8D7295977B703046fA9905) |
| `TreasuryPark` | [`0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f`](https://robinhoodchain.blockscout.com/address/0xfE7419caAd0181f77F850ae5D1c70bFd16Ef118f) |
| Park adapter, SGOV | [`0xFb71c36F32d42251039494761A674E24d2cc712b`](https://robinhoodchain.blockscout.com/address/0xFb71c36F32d42251039494761A674E24d2cc712b) |
| Park adapter, USDG | [`0xC92F0275717CaB35CD5A501223bCEE042b4a5506`](https://robinhoodchain.blockscout.com/address/0xC92F0275717CaB35CD5A501223bCEE042b4a5506) |
| `CreditPool` | [`0xFcE28EA7316506F3299b300C25C861F3FA071796`](https://robinhoodchain.blockscout.com/address/0xFcE28EA7316506F3299b300C25C861F3FA071796) |
| `CollateralVault` | [`0xcb2D73D7E99A5a66E2d458c05394652c04A502a7`](https://robinhoodchain.blockscout.com/address/0xcb2D73D7E99A5a66E2d458c05394652c04A502a7) |

Privacy:

| Contract | Address |
|---|---|
| `WithinMandateVerifier` | [`0xFF4b6B355c2A923fdf585BC4DaBec152D615B459`](https://robinhoodchain.blockscout.com/address/0xFF4b6B355c2A923fdf585BC4DaBec152D615B459) |
| `CommittedMandateFactory` | [`0x227259542FE9C6b1F1899A94ec13d7A824A4B4EB`](https://robinhoodchain.blockscout.com/address/0x227259542FE9C6b1F1899A94ec13d7A824A4B4EB) |
| `DisclosureRegistry` | [`0x2C7B264f596302806d945f42DCF242A757188994`](https://robinhoodchain.blockscout.com/address/0x2C7B264f596302806d945f42DCF242A757188994) |
| `SolvencyLog` | [`0x9B0131e101080A19Ef5D94b47B0a4BBD7e342020`](https://robinhoodchain.blockscout.com/address/0x9B0131e101080A19Ef5D94b47B0a4BBD7e342020) |
| `Entrypoint` | [`0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee`](https://robinhoodchain.blockscout.com/address/0x42DA6BE9eAf31A7b5051a0926ACB2e93E32991ee) |
| `EntrypointImplementation` | [`0x20989ee637c7513428f9b1ca8020BE67c1D60f1d`](https://robinhoodchain.blockscout.com/address/0x20989ee637c7513428f9b1ca8020BE67c1D60f1d) |
| `ShieldedPool` | [`0xdF48d94951d4944A15d73e33fCc695bAe6161256`](https://robinhoodchain.blockscout.com/address/0xdF48d94951d4944A15d73e33fCc695bAe6161256) |
| `ShieldedRelay` | [`0x2aC40b3A95b4B88d0Fc774E503926ad96Fbed440`](https://robinhoodchain.blockscout.com/address/0x2aC40b3A95b4B88d0Fc774E503926ad96Fbed440) |
| `WithdrawalVerifier` | [`0xE78C90A981036Db48Bd7a611974148d78417bBE0`](https://robinhoodchain.blockscout.com/address/0xE78C90A981036Db48Bd7a611974148d78417bBE0) |
| `CommitmentVerifier` | [`0x888922cc4F2C1428f04788823D36511b6062F85b`](https://robinhoodchain.blockscout.com/address/0x888922cc4F2C1428f04788823D36511b6062F85b) |

### Previous set (v3)

The third set, deployed on 2026-09-30, stays on chain and keeps serving the mandates, locks and
disputes opened through it. The console, the SDK and the MCP server still read it. Its timelock
is the current one, and its token contracts are listed below as carried over. The rest of the set
is in [`rhc-mainnet-v3.json`](contracts/deployments/rhc-mainnet-v3.json).

| Contract | Address |
|---|---|
| `AdminTimelock` | [`0xD91A6577828424E386900D0bB41596c6eF3BF8DF`](https://robinhoodchain.blockscout.com/address/0xD91A6577828424E386900D0bB41596c6eF3BF8DF) |
| `MandateAccountFactory` | [`0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07`](https://robinhoodchain.blockscout.com/address/0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07) |
| `Escrow` | [`0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919`](https://robinhoodchain.blockscout.com/address/0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919) |
| `Reputation` | [`0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238`](https://robinhoodchain.blockscout.com/address/0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238) |
| `OracleRegistry` | [`0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF`](https://robinhoodchain.blockscout.com/address/0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF) |
| `AgentRegistry` | [`0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9`](https://robinhoodchain.blockscout.com/address/0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9) |

### Earlier sets

The second set (v2, deployed on 2026-09-28) and the first set (v1, deployed on 2026-09-22) stay on
chain and keep serving the mandates, locks and disputes opened through them. The console, the SDK
and the MCP server still read them. Each has a timelock of its own. Their addresses are in
[`rhc-mainnet-v2.json`](contracts/deployments/rhc-mainnet-v2.json) and
[`rhc-mainnet.json`](contracts/deployments/rhc-mainnet.json).

### Token contracts

`BRSR` and `Vesting` are shared by every set. `Staking`, `Buyback` and the liquidity seeder were
deployed with the third set and carry over to the fourth; resolver bonds on both registries are
held in this `Staking` pool. The v2 and v1 registries keep reading the earlier pool, listed here
as previous.

| Contract | Address |
|---|---|
| `BRSR` | [`0x00e503925880c4b07E5Fb70232D83aD871F57a7d`](https://robinhoodchain.blockscout.com/address/0x00e503925880c4b07E5Fb70232D83aD871F57a7d) |
| `Vesting` | [`0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F`](https://robinhoodchain.blockscout.com/address/0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F) |
| `Staking` | [`0x31CbD06003089B00897F0d7e3c283C66a1768d9A`](https://robinhoodchain.blockscout.com/address/0x31CbD06003089B00897F0d7e3c283C66a1768d9A) |
| `Buyback` | [`0x51a88fb749738CB31ddb1F35A426ab2189F45eab`](https://robinhoodchain.blockscout.com/address/0x51a88fb749738CB31ddb1F35A426ab2189F45eab) |
| `V4LiquiditySeeder` | [`0x2cD0c0f114A4E7A20EF7967355E0986D0F82e125`](https://robinhoodchain.blockscout.com/address/0x2cD0c0f114A4E7A20EF7967355E0986D0F82e125) |
| `Staking`, previous | [`0x3f2a0E7822B30aD928488F053348b137866Cf962`](https://robinhoodchain.blockscout.com/address/0x3f2a0E7822B30aD928488F053348b137866Cf962) |
| `Buyback`, previous | [`0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0`](https://robinhoodchain.blockscout.com/address/0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0) |

Mandate accounts are created per principal by a factory and are not listed here.

### An example mandate to read

[`0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c`](https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c)
is a live mandate account created by the current factory, and it is the one to point at while you
learn the system. It settles through the current escrow, holds 0.20 USDG and has no expiry. It
allows up to 0.10 USDG per payment, 0.50 USDG a day and 2.00 USDG a month, with a lifetime total
of 1.00 USDG. Its approval threshold is also 0.10 USDG: payments below 0.10 go through on the
agent's signature, and a payment of exactly 0.10 waits for the principal to approve it. It may
pay for services, hire agents and buy SPY, NVDA or AAPL through the stock router. One address,
`0x877c349EFb5926082C413833E8055F0991185c61`, is both its principal and its agent. That suits a
demonstration; a mandate in use gives its agent a key of its own. Open it in the
[console](https://app.bursar.world/console/0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c) to see its
limits and history. The same principal also runs a collateral-lane example,
[`0x856471C6922A3ccBa6b514E316B617B5f5C4bA18`](https://app.bursar.world/console/0x856471C6922A3ccBa6b514E316B617B5f5C4bA18),
which borrows what a spend needs against the SPY it has posted.

Reading it needs no key. With the SDK, `mandateAccount('0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c')`
opens a read-only client (see [`packages/sdk/README.md`](packages/sdk/README.md)). With the MCP
server, set `MANDATE_ACCOUNT` to that address and no signer, and it serves only the tools that read
(see [`packages/mcp/README.md`](packages/mcp/README.md)). Paying through it takes its agent key,
which is not published. To spend, create a mandate of your own in the console.

The v3 example,
[`0x4a373BFCc5bb36dc6cA10C407189c45eb40058E5`](https://app.bursar.world/console/0x4a373BFCc5bb36dc6cA10C407189c45eb40058E5),
settles through the v3 escrow, and the v1 example,
[`0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b`](https://app.bursar.world/console/0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b),
through the v1 escrow. Both stay readable the same way.

## Contributing

Bug reports, fixes and improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup, coding standards, commit style and the DCO sign-off every commit needs. Questions go to
[GitHub Discussions](https://github.com/bursar-world/bursar/discussions); see
[SUPPORT.md](SUPPORT.md). Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
How decisions are made, including changes to on-chain parameters, is in
[GOVERNANCE.md](GOVERNANCE.md).

## Security

Do not open a public issue for a vulnerability. Email hello@bursar.world or use
[GitHub private vulnerability reporting](https://github.com/bursar-world/bursar/security/advisories/new).
[SECURITY.md](SECURITY.md) has the scope and what to expect.

## License

MIT. See [LICENSE](LICENSE). Third-party material is listed in [NOTICE](NOTICE).
