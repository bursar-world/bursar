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
pause the v2 escrow, `OracleRegistry` and `AgentRegistry`, and the v1 `AgentRegistry`, `Staking`
and `Buyback`, in the same block. Principals can revoke an agent on their own mandate accounts at
once. An early report is what gives them the time.

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

- The contracts deployed on Robinhood Chain mainnet, chain id 4663. The current set (v2) is a
  development deployment; the previous set (v1) still holds open locks and disputes.

  | Contract | v2 (current) | v1 (previous) |
  |---|---|---|
  | `AdminTimelock` | `0x135eF562ac57845AeA1Bb650fc0E74D67A4a866B` | `0x5a32Eab02454f97a39857E85b536F83EE0f844Bf` |
  | `MandateAccountFactory` | `0xe9f8cc653fF40E346e0591f353Be58DF0533cfD0` | `0xF8Ca04BEc1D7bcf767154AC6F7Ed1DD840CCF216` |
  | `Escrow` | `0x4315F8be7C9661345710910577Ec31cb867f3c20` | `0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4` |
  | `Reputation` | `0x48BF5F8Cea580148B2A5Ee3A9c487BF1dCafd9c3` | `0x8F123EDDDC586EEaAC3B1D6A5B9dF7BC0247680d` |
  | `OracleRegistry` | `0xE38349668f0C470C814487E95C14e7652F713B17` | `0xCb7c60037eC43b9692A5dDcA42A500181Cf549FF` |
  | `AgentRegistry` | `0x552E95102aE6B9232dD6A744B8f6bd348b379D26` | `0x4a9e90F15c0FEC02f7592C6E618cd3B64076035b` |

  The token contracts, shared by both sets:

  | Contract | Address |
  |---|---|
  | `BRSR` | `0x00e503925880c4b07E5Fb70232D83aD871F57a7d` |
  | `Vesting` | `0x5aD3d29C80C1617F3B195d74D593Bc9839681b2F` |
  | `Staking` | `0x3f2a0E7822B30aD928488F053348b137866Cf962` |
  | `Buyback` | `0xE979a30564a6F15DCCdB5488d5ac0D74a1bda6F0` |

  and every `MandateAccount` created by either factory.
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
