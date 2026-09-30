# Security policy

Bursar contracts hold real funds on Robinhood Chain mainnet. If you find a way to move, freeze or
misdirect those funds, or to make any part of the system act outside a mandate, please tell us
privately first.

## Audit status

No external audit has been performed on any Bursar contract or service. The caps on mainnet are
deliberately low to bound what a defect can cost: a payee with no settlement history can be paid
at most 25 USDG per job, rising with its record to at most 125 USDG per job under the current
curve. The cap applies to each payment, not to a payee's total. Treat every deployment as
unaudited code.

## Supported versions

| Version | Supported |
|---|---|
| `main` branch | Yes |
| 0.1.0, the contracts deployed on chain 4663 (listed below) | Yes |
| Anything older, including forks and redeployments not listed below | No |

Deployed contracts cannot be patched in place. A fix to one of them is a new deployment, moved to
through the on-chain governance process in [GOVERNANCE.md](GOVERNANCE.md).

## Reporting a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Use either channel:

- Email **security@bursar.world**.
- [GitHub private vulnerability reporting](https://github.com/bursar-world/bursar/security/advisories/new)
  on this repository.

If funds are at risk right now, start the email subject with `URGENT`. The timelock guardian can
pause, in the same block, the v3 escrow, `OracleRegistry`, `AgentRegistry`, `Staking` and
`Buyback`; the v2 escrow, `OracleRegistry` and `AgentRegistry`; and the v1 `AgentRegistry`,
`Staking` and `Buyback`. Principals can revoke an agent on their own mandate accounts at once. An
early report is what gives them the time.

Please include:

- the component affected: a contract and its address, a package, a service, or the console;
- a description of the issue and its impact, in particular what an attacker gains and what it
  costs them;
- steps to reproduce, ideally a Foundry test or a script against a local fork of chain 4663;
- any transaction hashes involved, if the issue has been observed on chain;
- how you would like to be credited, or that you would prefer not to be.

Never include private keys or funds you do not own in a report.

## What to expect

- We acknowledge every report within **3 business days**.
- We then confirm whether we can reproduce it, tell you how we assess its severity, and keep you
  updated as we work on a fix.
- We agree a disclosure date with you. Our default is to publish an advisory once a fix is live,
  and no later than 90 days after the report, unless we agree otherwise.
- We credit reporters in the advisory unless they ask us not to.

## Bug bounty

There is no bug bounty programme yet. We will say so here when there is one.

## Scope

In scope:

- The contracts deployed on Robinhood Chain mainnet, chain id 4663. The current set (v3) is a
  development deployment; the previous set (v2) still holds open locks and disputes.

  | Contract | v3 (current) | v2 (previous) |
  |---|---|---|
  | `AdminTimelock` | `0xD91A6577828424E386900D0bB41596c6eF3BF8DF` | `0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B` |
  | `MandateAccountFactory` | `0x946FFE695eCc8Ceb201Cf3Dd07dBd302e289Fd07` | `0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0` |
  | `Escrow` | `0x68D4aD683b5519C785Dde9F0ee0eE09dB2D40919` | `0x4315F8be7C9661345710910577Ec31cb867f3c20` |
  | `Reputation` | `0xF2510fB02BaE866fD307CE5f48BBe1B1C2E17238` | `0x48BF5F8Cea580148B2A5Ee3A9c487BF1dCafd9c3` |
  | `OracleRegistry` | `0x20E75139996fFf7B3158DF28Bf133b326DCD2BdF` | `0xE38349668f0C470C814487E95C14e7652F713B17` |
  | `AgentRegistry` | `0xCa7b01237a43a515FbFBB5BA3e0Fed7e953139c9` | `0x552E95102aE6B9232dD6A744B8f6bd348b379D26` |

  The first set (v1) stays on chain and in scope; its addresses are listed in the
  [README](README.md#first-set-v1).

  The token contracts, of which `BRSR` and `Vesting` are shared by every set. `Staking` and
  `Buyback` are the current set's; the earlier pool and buyback are listed as previous:

  | Contract | Address |
  |---|---|
  | `BRSR` | `0x00e503925880c4b07E5Fb70232D83aD871F57a7d` |
  | `Vesting` | `0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F` |
  | `Staking` | `0x31CbD06003089B00897F0d7e3c283C66a1768d9A` |
  | `Buyback` | `0x51a88fb749738CB31ddb1F35A426ab2189F45eab` |
  | `Staking`, previous | `0x3f2a0E7822B30aD928488F053348b137866Cf962` |
  | `Buyback`, previous | `0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0` |

  and every `MandateAccount` created by any of the three factories.
- The contract source, deploy scripts and packages in this repository (`contracts/`,
  `packages/*`).
- The services in this repository: the facilitator, the underwriter and the sidecar.
- The console at https://app.bursar.world and its source in `apps/web/`.

Out of scope:

- Third-party systems Bursar depends on but does not operate: USDG and its issuer, Robinhood
  Chain and its RPC endpoints, the Uniswap v4 PoolManager, the Blockscout explorer and index,
  and wallet software. Report those to their owners.
- The marketing site at https://bursar.world, which is a separate codebase.
- Denial of service by volume, spam, or exhausting a public RPC endpoint's rate limit.
- Attacks that require a compromised timelock signer, guardian or relayer key, or physical access
  to a user's device.
- Social engineering of Bursar contributors or users.
- Missing security headers, banner disclosure and similar findings without a demonstrated impact.
- Vulnerabilities in dependencies that are already public, unless Bursar uses the affected code
  in an exploitable way.

## Safe harbour

We will not pursue legal action against, or ask anyone else to pursue it against, a person who
researches and reports a vulnerability in good faith under this policy. Good faith means you:

- test only against a local fork, a testnet, or accounts and funds you own;
- do not move, lock or destroy funds that belong to anyone else, and stop as soon as you have
  shown the issue is real;
- do not access, keep or share other people's data beyond what is needed to show the issue;
- do not degrade the service for other users;
- give us a reasonable time to fix the issue before disclosing it.

If you are unsure whether something you plan to do is covered, ask us first at
security@bursar.world.
