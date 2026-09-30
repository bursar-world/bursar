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

Bursar is live on Robinhood Chain mainnet (chain 4663) and settles in USDG. The contracts were
deployed on 2026-09-22 and hold real funds.

**No external audit has been performed.** The caps on mainnet are deliberately low: a provider
with no history can be paid at most 25 USDG per job, rising with its settlement record to at most
125 USDG per job under the current curve. The cap applies to each payment, not to a provider's
total. Size any mandate you fund accordingly.

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

### Current set (v2)

New mandates are created here. It is a development deployment: its timelock delay and its dispute
vote windows are one hour each, so changes can be exercised within a day. Before the public
launch the delay returns to 48 hours and each vote window to six hours.

| Contract | Address |
|---|---|
| `AdminTimelock` | [`0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B`](https://robinhoodchain.blockscout.com/address/0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B) |
| `MandateAccountFactory` | [`0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0`](https://robinhoodchain.blockscout.com/address/0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0) |
| `Escrow` | [`0x4315F8be7C9661345710910577Ec31cb867f3c20`](https://robinhoodchain.blockscout.com/address/0x4315F8be7C9661345710910577Ec31cb867f3c20) |
| `Reputation` | [`0x48BF5F8Cea580148B2A5Ee3A9c487BF1dCafd9c3`](https://robinhoodchain.blockscout.com/address/0x48BF5F8Cea580148B2A5Ee3A9c487BF1dCafd9c3) |
| `OracleRegistry` | [`0xE38349668f0C470C814487E95C14e7652F713B17`](https://robinhoodchain.blockscout.com/address/0xE38349668f0C470C814487E95C14e7652F713B17) |
| `AgentRegistry` | [`0x552E95102aE6B9232dD6A744B8f6bd348b379D26`](https://robinhoodchain.blockscout.com/address/0x552E95102aE6B9232dD6A744B8f6bd348b379D26) |

### Previous set (v1)

The v1 contracts stay on chain and keep serving the mandates, locks and disputes opened through
them. The console, the SDK and the MCP server still read them.

| Contract | Address |
|---|---|
| `AdminTimelock` | [`0x5a32Eab02454f97a39857E85b536F83EE0f844Bf`](https://robinhoodchain.blockscout.com/address/0x5a32Eab02454f97a39857E85b536F83EE0f844Bf) |
| `MandateAccountFactory` | [`0xF8Ca04BEc1D7bcf767154AC6F7Ed1DD840CCF216`](https://robinhoodchain.blockscout.com/address/0xF8Ca04BEc1D7bcf767154AC6F7Ed1DD840CCF216) |
| `Escrow` | [`0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4`](https://robinhoodchain.blockscout.com/address/0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4) |
| `Reputation` | [`0x8F123EDDDC586EEaAC3B1D6A5B9dF7BC0247680d`](https://robinhoodchain.blockscout.com/address/0x8F123EDDDC586EEaAC3B1D6A5B9dF7BC0247680d) |
| `OracleRegistry` | [`0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF`](https://robinhoodchain.blockscout.com/address/0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF) |
| `AgentRegistry` | [`0x4a9e90F15c0FEC02f7592C6E618cd3B64076035b`](https://robinhoodchain.blockscout.com/address/0x4a9e90F15c0FEC02f7592C6E618cd3B64076035b) |

### Token contracts

Shared by both sets. Resolver bonds on either registry are held in the same `Staking` pool.

| Contract | Address |
|---|---|
| `BRSR` | [`0x00e503925880c4b07E5Fb70232D83aD871F57a7d`](https://robinhoodchain.blockscout.com/address/0x00e503925880c4b07E5Fb70232D83aD871F57a7d) |
| `Vesting` | [`0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F`](https://robinhoodchain.blockscout.com/address/0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F) |
| `Staking` | [`0x3f2a0E7822B30aD928488F053348b137866Cf962`](https://robinhoodchain.blockscout.com/address/0x3f2a0E7822B30aD928488F053348b137866Cf962) |
| `Buyback` | [`0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0`](https://robinhoodchain.blockscout.com/address/0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0) |

Mandate accounts are created per principal by a factory and are not listed here.

### An example mandate to read

[`0x420BeB507F72173E7d78e0f956968f64fb508356`](https://app.bursar.world/console/0x420BeB507F72173E7d78e0f956968f64fb508356)
is a live mandate account created by the current factory, and it is the one to point at while you
learn the system. It settles through the current escrow and has no expiry. It allows up to 0.10
USDG per payment, 0.50 USDG a day and 2.00 USDG a month, with a lifetime total of 1.00 USDG. Its
approval threshold is also 0.10 USDG: payments below 0.10 go through on the agent's signature, and
a payment of exactly 0.10 waits for the principal to approve it. It may pay for services and hire
agents, and it may not buy stock. One address, `0x877c349EFb5926082C413833E8055F0991185c61`, is
both its principal and its agent. That suits a demonstration; a mandate in use gives its agent a
key of its own. Open it in the
[console](https://app.bursar.world/console/0x420BeB507F72173E7d78e0f956968f64fb508356) to see its
limits and history.

Reading it needs no key. With the SDK, `mandateAccount('0x420BeB507F72173E7d78e0f956968f64fb508356')`
opens a read-only client (see [`packages/sdk/README.md`](packages/sdk/README.md)). With the MCP
server, set `MANDATE_ACCOUNT` to that address and no signer, and it serves only the tools that read
(see [`packages/mcp/README.md`](packages/mcp/README.md)). Paying through it takes its agent key,
which is not published. To spend, create a mandate of your own in the console.

The v1 example,
[`0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b`](https://app.bursar.world/console/0xB4Bd99d8604fDB876fA1B38a3f8bA024D20ccD0b),
settles through the v1 escrow and stays readable the same way.

## Contributing

Bug reports, fixes and improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup, coding standards, commit style and the DCO sign-off every commit needs. Questions go to
[GitHub Discussions](https://github.com/bursar-world/bursar/discussions); see
[SUPPORT.md](SUPPORT.md). Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
How decisions are made, including changes to on-chain parameters, is in
[GOVERNANCE.md](GOVERNANCE.md).

## Security

Do not open a public issue for a vulnerability. Email security@bursar.world or use
[GitHub private vulnerability reporting](https://github.com/bursar-world/bursar/security/advisories/new).
[SECURITY.md](SECURITY.md) has the scope and what to expect.

## License

MIT. See [LICENSE](LICENSE). Third-party material is listed in [NOTICE](NOTICE).
