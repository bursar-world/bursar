# Invariants

An invariant is a statement about a contract that has to hold after every possible sequence of
actions: every deposit, spend, refund, pause, price move and change of hands, in any order. The
test suite checks each statement below by driving the contracts through long random sequences of
such actions and reading the statement back after every step. A statement that fails names the
exact sequence that broke it.

Every statement on this page is checked on every change to the code. Once a day the same
statements are checked again at depth, over more than a hundred thousand actions per contract.

## How to run them

From the `contracts` directory, with Foundry installed at the release pinned in
`.foundry-version` and the dependencies installed as the README describes:

```
forge test --match-test invariant_
```

runs every invariant at the default depth, 128 sequences of 32 actions per contract, in a few
seconds alongside the rest of the test suite.

```
FOUNDRY_PROFILE=deep forge test --match-test invariant_
```

runs the same invariants at depth: 512 sequences of 200 actions, over a hundred thousand actions
per contract. This is what the nightly check runs. It takes minutes rather than seconds. A failure
prints the random seed it ran with; `--fuzz-seed <seed>` replays the same sequence.

## Escrow

- The escrow's balance is exactly the principal of every open lock, the bonds posted against
  open disputes, the fees not yet swept, and the payouts owed to parties the token could not pay.
- A lock that has been settled never carries a dispute bond forward.
- The escrow's balance is never less than the fees it owes the treasury, so a fee sweep can never
  reach a payer's locked principal.
- Every settlement moves exactly the lock's amount plus its bond: what is refunded, paid, kept as
  fees or returned adds back up to what was held.
- Every disputed lock that still holds money has a way out that works once the vote has closed,
  whatever has been paused or frozen in the meantime.
- Each lock moves at most one counter in the payee's history, and no counter moves for a lock
  that did not settle.

## Mandate accounts

- The escrow holds exactly what a mandate has locked, and the mandate's balance plus what it has
  locked is exactly what it was funded with.
- No single payment ever exceeds the account's per-call limit.
- A paused mandate never settles a payment.
- A daily or monthly window never carries more spend than its cap allows, and a settled payment
  never leaves a window above its cap.
- A refund never credits a window more than that window actually spent.
- Each window carries exactly what its current period committed, less what came back.
- The headroom a window reports never exceeds the cap that grants it.
- Neither window starts in the future or lags a whole period behind the clock.
- A payment that fits every live limit is never refused.
- A mandate's lifetime spend is what it can still get back from the escrow plus what it spent on
  stock, which never comes back.
- The nonce counts every accepted change to the limits, one for one.
- An authorisation that was already used, or was issued for an earlier nonce, is never accepted
  again.
- A spending approval that was used or revoked stays burned for the life of the account, through
  any number of changes of principal.

## Committed mandates

- No account ever locks more than the ceiling its factory fixed, whatever its proofs say, so the
  most all accounts together can lock is the ceiling times their number.
- The ceiling's running count is the sum of every lock the account ever opened, and it never
  falls: refunds, rulings and amended terms leave it where it is.
- An account never pays out more than it was funded with and received back from the escrow.
- Every unit of the settlement asset is on an account, in the escrow, with a payee, with the
  principal, with the resolver or with the treasury.
- A spend needs a valid proof for the account's committed terms: a proof with any input changed,
  a proof with one bit flipped, or a proof presented to another account is refused, and a valid
  proof lands once and in order.
- A nullifier spends once; a second presentation is refused.
- The nonce never goes back, including through an amendment of the terms.
- Only the agent or the principal spends, and only the principal pauses, revokes, amends,
  renames the agent, withdraws or opens accounts in its own name.
- A paused or revoked account never spends.
- The principal can always withdraw what the account holds, whether it is paused, revoked or
  at its ceiling, and a revocation returns the whole balance to the principal.
- Every spend that lands moves the nonce by one, records its nullifier and opens exactly the
  lock it asked for, and no spend inside every rule is refused.

## Dispute resolution (resolver registry)

- Resolver bonds and resolver rewards are two different tokens, and each is always fully backed
  by what the registry holds.
- The bonds recorded for each resolver add up to the total the registry reports.
- Rewards set aside with no resolver to claim them never exceed the reward float.
- The open votes held against resolvers equal the commitments on disputes still open, so a bond
  is neither pinned for good nor freed while a vote still needs it.
- The resolver count matches the resolvers that are active or unbonding.
- The settlement asset the registry holds is the reward float and nothing else; the bonds are
  on a ledger of their own.
- Every reward in the float is owed to a resolver or set aside for the sink, never both and never
  neither.

## Agent registry and reputation

- The registry never records more stake than it holds.
- Every agent's stake adds up to the ledger total.
- An active agent always meets the minimum stake and is never blacklisted.
- Slashed stake only ever lands in the designated sink.
- The ledger reads the six-decimal view of the settlement asset and never its eighteen-decimal
  view.
- A payee's cap never leaves the published curve: at least the base cap, at most the maximum.
- The cap is always the published formula applied to the payee's settlement history.

## Timelock

- No proposal ever executes before its delay has passed or without enough approvals.
- The signer set stays three distinct keys, none of them the guardian.
- The delay is never zero.

## Whole deployment

- The settlement asset's eighteen-decimal view is always the same money as its six-decimal
  view, and no ledger figure ever crosses into the eighteen-decimal scale.
- No contract in the deployment can read the native balance view at all.
- The settlement asset is conserved across every address the system can reach.
- The escrow, the resolver registry and the agent registry each hold exactly what their own
  ledgers say, plus whatever was sent to them by mistake.

## Staking

- The pool's token balance always covers the stake it records.
- Every micro-dollar of rewards is divided across shares, carried to the next division, or parked
  for the treasury; nothing else can explain a unit of the balance.
- What stakers are owed, earning and on their way out never adds up to more than the pool holds
  for them.
- The unbonding pool is part of the pool, and it is empty exactly when nobody holds a claim on it.
- The share count stays bounded however slashes and deposits interleave.

## Credit pool

- Every unit in the pool or lent out came from the lender or from spread a borrower paid, less
  what was taken back, swept to stakers or written off.
- Stakers are only ever paid spread.
- No principal outstanding sits above the pool's cap or a mandate's cap.
- A write-off clears the debt and the principal behind it and leaves the reserves alone.
- Every write-off takes the loss at a live price ceiling, within the slash allowance, and nothing
  while the pool is not the slasher or the ceiling is unset or stale.

## Treasury lane (TreasuryPark)

- Each adapter holds exactly the asset behind every position it carries, its basis total is the
  sum of the positions' bases, and the USDG reserve is held one for one.
- Every unit a mandate was funded with is on the mandate, in its vault, parked at cost, spent, or
  withdrawn by the principal, less what came back from the adapters.
- USDG is conserved across every address in the lane.
- No park lands past a mandate's cap or the shared cap, and no park leaves a mandate under the
  buffer its principal set.
- Only a mandate's own principal or agent parks, unparks or returns its idle USDG, only its
  principal sets its buffer, only an account one of the factories created may park at all, and
  only governance switches adapters and listings.
- An unpark delivers to the mandate exactly what it reports, and never more than the position
  it sold was worth at the price feed plus the fill band.
- Spending power counts the mandate's USDG, its idle vault balance and the USDG reserve, and
  counts SGOV after the haircut only while the feed is fresh, nothing is paused and the pool
  agrees with the feed. Otherwise SGOV counts for nothing.
- The admin seat moves only to the address the sitting admin named, and only when that address
  accepts.
- Whatever governance switches off, every position comes back out: at the end of every sequence
  each position is sold back to its mandate and each vault emptied, with nothing left on an
  adapter.

## Buyback

- One call spends at most the per-call target, a window never carries more than its cap after a
  buy, and no buy lands inside the interval after the last.
- Every fill prices BRSR at or under the ceiling governance set, wherever a trader pushed the
  pool first.
- Paused, without a keeper, with the ceiling unset or stale, inside the interval, with nobody
  staked or with less than the minimum to spend, a buy is refused.
- Every BRSR a buy receives is compounded into the staking pool in the same transaction; the
  contract keeps none of its own beyond strays, and the keeper is paid nothing.
- The USDG balance is what was given less what was spent on the pool or returned to the
  treasury; the pool holds exactly what was spent and the treasury exactly what was swept.
- The spend the contract quotes as available is exactly what a buy in the same block spends, and
  zero whenever a buy would be refused.
- Only the keeper buys and only governance changes the parameters, the keeper, the brake or the
  ceiling's age.
- The brake stops buying and nothing else: a sweep of what is held lands, paused or not, and
  pays the treasury.
- A buy inside every gate whose quoted fill sits inside the ceiling lands.
- The admin seat moves only by offer and acceptance.

## Liquidity seeder

- The liquidity the seeder records is the liquidity the pool holds in range, position by position.
- An adder is charged exactly what the position costs at the pool's price, is refused whole when
  it offers a unit less, and gets every unit offered beyond the cost straight back.
- Nothing sits on the seeder but what was sent there by mistake and not yet swept; adds and
  removals pass through without leaving a unit behind.
- A removal pays its recipient exactly what it reports, never more than the liquidity cost to add,
  and never more liquidity than the range holds.
- Adding is open to anyone and gives the liquidity away. Opening the pool, taking liquidity out
  and sweeping are the owner's alone, and the pool opens once.
- The owner's seat moves only by offer and acceptance.
- At the end of every sequence every position is taken back out, and what the pool keeps is
  rounding of at most two units per leg per add or removal.

## Vesting

- For every grant, what was paid never runs ahead of what has vested, what has vested never runs
  ahead of what was granted, and the beneficiary holds exactly what the contract says it paid.
- Vested is the schedule's line: nothing before the cliff, the whole grant after four years, the
  straight line between, or the point where a revocation froze it.
- Nothing vests or pays before the cliff.
- The vested figure never falls, and a revocation takes exactly the unvested remainder.
- The balance is what the grants are still owed plus the surplus, and nothing else.
- Every token that left went to a beneficiary as a claim or to the treasury as a forfeit or a
  sweep; nobody else is ever paid.
- The admin seat moves only by offer and acceptance.
- At the end of every sequence the schedule is run out and every grant claimed: the whole
  allocation ends up paid to its beneficiary or forfeited to the treasury, with nothing left owed
  and nothing paid twice.

## Collateral vault

This section is reserved. The collateral vault's invariants are being written alongside changes
to the contract and will be listed here when they land.

## Shielded pool

This section is reserved. The shielded pool's invariants are being written alongside changes to
the contract and will be listed here when they land.
