# Ruling policy

Version 1. It applies to disputes heard by the Bursar dispute registries on Robinhood Chain
(chain 4663): the v3 set, which takes new payments, and the earlier v2 and v1 sets, which still
settle the disputes opened on them. The [status page](https://app.bursar.world/status) lists the
registry and escrow of each set.

The rules and scores are the same on every set. Where the registries behave differently, the
difference is stated below.

## Who rules

All three bonded resolvers on every registry are operated by Bursar:

| Resolver | Address |
|---|---|
| resolver-1 | `0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599` |
| resolver-2 | `0xC284CdA6c6982447f202830f4e969F13cBcB0b94` |
| resolver-3 | `0x7062A480732EC7B0F00a3D0c968356e1671dd356` |

Each has BRSR bonded through the `Staking` pool, at or above the floor that pool sets. Bursar is
therefore the arbiter of every dispute on every registry. On v3 every bonded resolver may vote on
every dispute; the v2 and v1 registries seat the first five resolvers to seal a score.
Every vote follows the rules below, every resolver casts the same score, and the reasons for each
ruling are published once the votes are revealed.

## What a ruling decides

A payer who disputes a job before the provider has been paid freezes the payment. On v3 that has
to happen before the payment's deadline: once the deadline has passed, the payer is owed its
refund and the escrow takes no dispute. The resolvers score the delivery from 0 to 100, and the
median score sets how much goes back to the payer:

| Score | Refund to the payer |
|---|---|
| Below 50 | 100% |
| 50 to 64 | 75% |
| 65 to 79 | 35% |
| 80 and above | None |

The resolver fee, 0.5% of the payment, comes off first. The protocol fee, 1%, is charged only on
the provider's share. This policy uses four scores: 0, 60, 72 and 90. Each sits in the middle of
its band, so no rounding can move a ruling into the next one.

On a payment of 1.00 USDG disputed by the payer:

- At a score of 90, the provider receives 0.985050 USDG. The payer's 0.05 USDG dispute bond goes
  to the resolvers with their fee.
- At a score of 0, the payer receives 0.995000 USDG and the bond back. The resolvers receive
  0.005000 USDG.

On v3, a share the token cannot deliver, because its issuer has frozen the receiving address, is
held by the escrow for that address and paid out once the address can receive. It does not hold
up the rest of the ruling.

A complaint made after the provider has been paid is recorded against the provider's history.
There is nothing left to split, so it is never ruled on.

From v2 on, a payment can be disputed once, and the payer and provider of a disputed payment
cannot vote on it, even when they are bonded resolvers. On v3 the owner of a paying mandate is
barred too, as the mandate named its owner when the dispute opened.

## When no ruling is reached

A dispute needs two revealed votes. If fewer than two resolvers seal a score before sealing
closes, or fewer than two reveal before the reveal window closes, the dispute fails:

- On v3 and v2, the payment goes back to being held, with a new deadline no earlier than the
  shortest one the escrow accepts, five minutes on v2, counted from the moment the dispute fails.
  The dispute bond is returned to whoever opened the dispute, and no resolver fee is taken. The
  provider can still deliver before the new deadline, and the payer is refunded by the ordinary
  timeout if it does not. The payment cannot be disputed again.
- On v1, the payer is refunded.

A vote does not settle itself. Once the reveal window closes, or every sealed score has been
revealed, anyone can close it: with two or more revealed votes the ruling is applied, and with
fewer the dispute fails as above. Bursar's resolvers apply each ruling as soon as the vote allows.
The v1 and v2 escrows also return a disputed payment to the payer 48 hours after the dispute opened
if the registry cannot settle it at all, and on v2 only once the registry can no longer settle it.
The v3 escrow has no such timeout: every dispute ends in a ruling or a failed vote.

## The rules

The rules are checked in order and the first that applies decides.

| Rule | When it applies | Score |
|---|---|---|
| P0 | The payment is not held in dispute when the resolvers read it | No vote |
| P6 | Bursar overrode the ruling before the evidence cutoff (see Overrides) | The override |
| P1 | The job the payer committed to cannot be read, or does not match its commitment | 0 |
| P2 | The provider sent no signed delivery evidence before the cutoff | 0 |
| P3 | The evidence is not valid (see below) | 0 |
| P4 | The evidence is valid and the capability's published validator reports a partial delivery | 60 |
| P5 | The evidence is valid and the output is complete | 90 |

P1 means no verifiable job existed, so nothing was owed. P2 gives the payer the same result the
delivery deadline would have given. Evidence is not valid when:

- it is not signed by the provider named on the payment;
- it names a different job from the one the payer committed to;
- the output cannot be fetched from the address given, or that address is not public;
- the fetched output does not match the output commitment in the evidence;
- the capability's published validator rejects it, or, where no validator is published, the output
  is empty or is not JSON.

No capability publishes a validator today, so a complete delivery is one whose output is
well-formed, non-empty JSON that matches its commitment.

When the job was delivered is not scored. The chain cannot prove it, and a payer who disputes
before the deadline has already stopped the provider from being paid.

## Evidence

Providers send a signed delivery statement. The Bursar console signs one from the provider's
wallet on the provider desk, and the provider sidecar sends one automatically when a job it
delivered is disputed. Both post to `https://app.bursar.world/api/evidence`.

The statement is EIP-712 typed data under the domain `Bursar Evidence`, version `1`, chain 4663,
with the escrow as the verifying contract:

```
DeliveryEvidence(uint256 escrowId, bytes32 inputCommit, bytes32 outputCommit, string outputURI, uint64 deliveredAt)
```

Evidence counts if it arrives within three hours of the dispute opening. Anything later is kept
and published, and does not change the score.

Payers can send a signed `PayerStatement(uint256 escrowId, string reason)`. Statements are
published with the ruling. They are not scored, because only verifiable evidence moves a score.

## Overrides

Bursar may override a ruling before the evidence cutoff, with one of the four scores and a written
reason. The override and its reason are published with the ruling.

Bursar never overrides a dispute in which an address it controls is the payer or the provider.
Those disputes are ruled by P0 to P5 alone, and the published ruling marks them as operator party.

## Timeline

Times are counted from the moment the dispute opens. The table is for sealing and reveal windows
of six hours each, the length the v1 registry uses. A registry with other windows moves every step
in proportion: the v2 registry is a development deployment with one-hour windows, so there the
evidence cutoff is at 30 minutes, sealing closes at 1 hour, and the ruling settles by 2 hours at
the latest.

| When | What happens |
|---|---|
| Within a minute | The resolvers read the payment and the job, and open the evidence window |
| 3 hours | Evidence cutoff |
| 3 hours 30 minutes | Two resolvers seal the score |
| 4 hours 30 minutes | The third resolver seals it too if either of the first two has not |
| 6 hours | Sealing closes and the scores are revealed |
| Shortly after 6 hours | The ruling is settled and the escrow pays out |
| 12 hours | The latest the ruling settles, if a resolver outside Bursar sealed a score and never revealed it |

## Publication

Each ruling is published once its votes are revealed, at
`https://app.bursar.world/api/rulings?dispute=<dispute id>`, and shown on the resolver desk and the
provider desk. It lists the policy version, the rule that applied, the score, the reasons, the hash
of every piece of evidence, the block the payment was read at, and each resolver's vote with its
transactions. Before the reveal it says only that the score is sealed, so no one can copy a vote.

## Changes

A new version of this policy is published here before it applies. A dispute is ruled under the
version in force when it opened.
