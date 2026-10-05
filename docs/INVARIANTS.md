# Invariants

An invariant is a statement about a contract that has to hold after every possible sequence of
actions: every deposit, spend, refund, pause, price move and change of hands, in any order. The
test suite checks each statement below by driving the contracts through long random sequences of
such actions and reading the statement back after every step. A statement that fails names the
exact sequence that broke it.

Every statement on this page is checked on every change to the code. Once a day the same
statements are checked again at depth, over more than a hundred thousand actions per contract.

Under each statement is the test that checks it, linked to the line of `contracts/test` that
declares it. Most are `invariant_` functions, read back after every step. Three statements about
the end of a sequence are checked by a suite's `afterInvariant` hook, which runs once the sequence
is over, and one about the deployed bytecode by a unit test. From the repository root,
`node contracts/script/check-invariant-links.mjs` confirms that every statement has its test and
every invariant test its statement.

## How to run them

From the `contracts` directory, with Foundry installed at the release pinned in
`.foundry-version` and the dependencies installed as the README describes:

```
forge test --match-test invariant_
```

runs every invariant at the default depth, 128 sequences of at least 32 actions per contract, in
a few seconds alongside the rest of the test suite.

```
FOUNDRY_PROFILE=deep forge test --match-test invariant_
```

runs the same invariants at depth: 800 sequences of up to 200 actions, never fewer than a hundred
thousand actions per contract. This is what the nightly check runs. It takes minutes rather than
seconds. A failure prints the random seed it ran with; `--fuzz-seed <seed>` replays the same
sequence.

The tests are checked in turn. [MUTATION.md](MUTATION.md) records how many small changes to the
escrow its tests catch, and which ones they miss.

## Escrow

- The escrow's balance is exactly the principal of every open lock, the bonds posted against
  open disputes, the fees not yet swept, and the payouts owed to parties the token could not pay.
  [`invariant_escrowHoldsItsLiveLocksItsBondsAndTheFeesItOwes`](../contracts/test/Invariants.t.sol#L1204),
  [`invariant_escrowHoldsOpenPrincipalPlusPostedBondsPlusFees`](../contracts/test/EscrowDisputeBonds.t.sol#L1051),
  [`invariant_escrowHoldsTheLivePrincipalAndTheUnsweptFees`](../contracts/test/Escrow.t.sol#L2061)
- A lock that has been settled never carries a dispute bond forward.
  [`invariant_aSettledLockNeverCarriesABondForward`](../contracts/test/Escrow.t.sol#L2078)
- The escrow's balance is never less than the fees it owes the treasury, so a fee sweep can never
  reach a payer's locked principal.
  [`invariant_escrowNeverOwesTheTreasuryMoreThanItHolds`](../contracts/test/Invariants.t.sol#L1215),
  [`invariant_accruedFeesRemainCoveredByTheEscrowBalance`](../contracts/test/EscrowDisputeBonds.t.sol#L1070)
- Every settlement moves exactly the lock's amount plus its bond: what is refunded, paid, kept as
  fees or returned adds back up to what was held.
  [`invariant_everySettlementPathConservesTheLockAndItsBond`](../contracts/test/Invariants.t.sol#L1288)
- Every disputed lock that still holds money has a way out that works once the vote has closed,
  whatever has been paused or frozen in the meantime.
  [`invariant_everyDisputedLockHasAnExitThatSucceeds`](../contracts/test/Invariants.t.sol#L1300)
- Each lock moves at most one counter in the payee's history, and no counter moves for a lock
  that did not settle.
  [`invariant_eachLockMovesAtMostOneReputationCounter`](../contracts/test/Invariants.t.sol#L1373)

## Mandate accounts

- The escrow holds exactly what a mandate has locked, and the mandate's balance plus what it has
  locked is exactly what it was funded with.
  [`invariant_theEscrowHoldsExactlyWhatTheMandateLocked`](../contracts/test/MandateAccount.t.sol#L1067),
  [`invariant_theMandateBalancePlusWhatItLockedIsWhatItWasFunded`](../contracts/test/MandateAccount.t.sol#L1079),
  [`invariant_theEscrowHoldsEveryLockedUnitAndNoOther`](../contracts/test/MandateAccountWindows.t.sol#L364)
- No single payment ever exceeds the account's per-call limit.
  [`invariant_noLockEverExceedsThePerCallCap`](../contracts/test/MandateAccount.t.sol#L1071)
- A paused mandate never settles a payment.
  [`invariant_aPausedMandateNeverSettles`](../contracts/test/MandateAccount.t.sol#L1075)
- A daily or monthly window never carries more spend than its cap allows, and a settled payment
  never leaves a window above its cap.
  [`invariant_mandateWindowSpendNeverExceedsItsCap`](../contracts/test/Invariants.t.sol#L1273),
  [`invariant_noSettledSpendEverLeftABucketAboveItsCap`](../contracts/test/MandateAccountWindows.t.sol#L316)
- A refund never credits a window more than that window actually spent.
  [`invariant_noRefundEverReturnedMoreThanItsEpochCommitted`](../contracts/test/MandateAccountWindows.t.sol#L320)
- Each window carries exactly what its current period committed, less what came back.
  [`invariant_eachWindowCarriesWhatItsLiveEpochCommittedLessWhatCameBack`](../contracts/test/MandateAccountWindows.t.sol#L324)
- The headroom a window reports never exceeds the cap that grants it.
  [`invariant_headroomNeverExceedsTheCapThatGrantsIt`](../contracts/test/MandateAccountWindows.t.sol#L340)
- Neither window starts in the future or lags a whole period behind the clock.
  [`invariant_neitherWindowStartsInTheFutureOrLagsAWholePeriod`](../contracts/test/MandateAccountWindows.t.sol#L348)
- A payment that fits every live limit is never refused.
  [`invariant_noSpendThatFittedBothWindowsWasEverRefused`](../contracts/test/MandateAccountWindows.t.sol#L360)
- A mandate's lifetime spend is what it can still get back from the escrow plus what it spent on
  stock, which never comes back.
  [`invariant_totalSpentIsWhatIsStillRefundablePlusWhatWasBought`](../contracts/test/Invariants.t.sol#L1352)
- The nonce counts every accepted change to the limits, one for one.
  [`invariant_nonceCountsEveryAcceptedLimitWrite`](../contracts/test/MandateAccountAuth.t.sol#L1051)
- An authorisation that was already used, or was issued for an earlier nonce, is never accepted
  again.
  [`invariant_staleAuthorizationIsNeverAccepted`](../contracts/test/MandateAccountAuth.t.sol#L1055)
- A spending approval that was used or revoked stays burned for the life of the account, through
  any number of changes of principal.
  [`invariant_burnedApprovalIdsStayBurned`](../contracts/test/MandateAccountAuth.t.sol#L1059),
  [`invariant_aBurnedApprovalNeverOpensALock`](../contracts/test/Invariants.t.sol#L1424)

## Committed mandates

- No account ever locks more than the ceiling its factory fixed, whatever its proofs say, so the
  most all accounts together can lock is the ceiling times their number.
  [`invariant_noAccountEverLocksPastItsCeiling`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L672)
- The ceiling's running count is the sum of every lock the account ever opened, and it never
  falls: refunds, rulings and amended terms leave it where it is.
  [`invariant_lockedTotalIsEveryLockEverOpenedAndNeverFalls`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L686)
- An account never pays out more than it was funded with and received back from the escrow.
  [`invariant_anAccountNeverPaysOutMoreThanItWasFunded`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L704)
- Every unit of the settlement asset is on an account, in the escrow, with a payee, with the
  principal, with the resolver or with the treasury.
  [`invariant_theSettlementAssetIsConservedAcrossEveryParty`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L717)
- A spend needs a valid proof for the account's committed terms: a proof with any input changed,
  a proof with one bit flipped, or a proof presented to another account is refused, and a valid
  proof lands once and in order.
  [`invariant_aSpendNeedsAValidProofForTheCommittedTerms`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L732)
- A nullifier spends once; a second presentation is refused.
  [`invariant_aNullifierSpendsOnce`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L747)
- The nonce never goes back, including through an amendment of the terms.
  [`invariant_theNonceNeverGoesBack`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L751)
- Only the agent or the principal spends, and only the principal pauses, revokes, amends,
  renames the agent, withdraws or opens accounts in its own name.
  [`invariant_onlyTheAgentOrPrincipalSpendsAndOnlyThePrincipalGoverns`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L759)
- A paused or revoked account never spends.
  [`invariant_aPausedOrRevokedAccountNeverSpends`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L763)
- The principal can always withdraw what the account holds, whether it is paused, revoked or
  at its ceiling, and a revocation returns the whole balance to the principal.
  [`invariant_thePrincipalCanAlwaysWithdraw`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L770)
- Every spend that lands moves the nonce by one, records its nullifier and opens exactly the
  lock it asked for, and no spend inside every rule is refused.
  [`invariant_everySpendIsBookedOnceAndNoneInsideTheRulesIsRefused`](../contracts/test/privacy/CommittedMandateInvariant.t.sol#L776)

## Dispute resolution (resolver registry)

- Resolver bonds and resolver rewards are two different tokens, and each is always fully backed
  by what the registry holds.
  [`invariant_bondsAndRewardsAreBothFullyBacked`](../contracts/test/OracleRegistry.t.sol#L2887)
- The bonds recorded for each resolver add up to the total the registry reports.
  [`invariant_perResolverBondsSumToTotalBonded`](../contracts/test/OracleRegistry.t.sol#L2892)
- Rewards set aside with no resolver to claim them never exceed the reward float.
  [`invariant_unallocatedFeesNeverExceedTheRewardFloat`](../contracts/test/OracleRegistry.t.sol#L2901)
- The open votes held against resolvers equal the commitments on disputes still open, so a bond
  is neither pinned for good nor freed while a vote still needs it.
  [`invariant_openVotesEqualTheCommitmentsOnOpenDisputes`](../contracts/test/OracleRegistry.t.sol#L2907),
  [`invariant_openVotesEqualTheCommitmentsOnOpenDisputes`](../contracts/test/Invariants.t.sol#L1331)
- The resolver count matches the resolvers that are active or unbonding.
  [`invariant_rosterCountMatchesTheBondedResolvers`](../contracts/test/OracleRegistry.t.sol#L2932)
- The settlement asset the registry holds is the reward float and nothing else; the bonds are
  on a ledger of their own.
  [`invariant_oracleRegistryHoldsOnlyBondsAndTheRewardFloat`](../contracts/test/Invariants.t.sol#L1225)
- Every reward in the float is owed to a resolver or set aside for the sink, never both and never
  neither.
  [`invariant_everyRewardInTheFloatIsOwedToSomeone`](../contracts/test/Invariants.t.sol#L1240)

## Agent registry and reputation

- The registry never records more stake than it holds.
  [`invariant_theLedgerNeverExceedsTheCollateralHeld`](../contracts/test/ReputationAndRegistry.t.sol#L1837)
- Every agent's stake adds up to the ledger total.
  [`invariant_everyStakeAddsUpToTheLedger`](../contracts/test/ReputationAndRegistry.t.sol#L1841)
- An active agent always meets the minimum stake and is never blacklisted.
  [`invariant_anActiveAgentAlwaysMeetsTheFloor`](../contracts/test/ReputationAndRegistry.t.sol#L1852)
- Slashed stake only ever lands in the designated sink.
  [`invariant_slashedCollateralOnlyEverLandsInTheSink`](../contracts/test/ReputationAndRegistry.t.sol#L1863)
- The ledger reads the six-decimal view of the settlement asset and never its eighteen-decimal
  view.
  [`invariant_theLedgerReadsTheSixDecimalViewOnly`](../contracts/test/ReputationAndRegistry.t.sol#L1869)
- A payee's cap never leaves the published curve: at least the base cap, at most the maximum.
  [`invariant_theCapNeverLeavesTheCurve`](../contracts/test/ReputationAndRegistry.t.sol#L1993)
- A payee's credit is the volume released to it, counted per payer up to the per-payer cap, and
  its score is the share of its settled jobs that were released, scaled by that credit.
  [`invariant_creditIsTheCappedSumOverEveryEdge`](../contracts/test/ReputationAndRegistry.t.sol#L2006),
  [`invariant_creditIsTheReleasedVolumeCappedPerPayer`](../contracts/test/Invariants.t.sol#L1394)
- The cap is always the published formula applied to the payee's settlement history.
  [`invariant_theCapIsAlwaysTheFormulaAppliedToTheHistory`](../contracts/test/ReputationAndRegistry.t.sol#L2039)
- A job under the smallest payment that counts, or one a payee paid itself, moves no counter;
  every other settled job moves exactly the counter its outcome names.
  [`invariant_aLockUnderTheMinimumMovesNoCounter`](../contracts/test/ReputationAndRegistry.t.sol#L2025)

## Timelock

- No proposal ever executes before its delay has passed or without enough approvals.
  [`invariant_noProposalEverExecutesEarlyOrUnderApproved`](../contracts/test/TimelockAndDeploy.t.sol#L790)
- The signer set stays three distinct keys, none of them the guardian.
  [`invariant_theSignerSetStaysThreeDistinctKeysWithoutTheGuardian`](../contracts/test/TimelockAndDeploy.t.sol#L794)
- The delay is never zero.
  [`invariant_theDelayIsNeverZero`](../contracts/test/TimelockAndDeploy.t.sol#L805)

## Whole deployment

- The settlement asset's eighteen-decimal view is always the same money as its six-decimal
  view, and no ledger figure ever crosses into the eighteen-decimal scale.
  [`invariant_theNativeViewIsAlwaysTheSameMoneyAsTheErc20View`](../contracts/test/Invariants.t.sol#L1173),
  [`invariant_noLedgerFigureEverCrossesIntoTheNativeScale`](../contracts/test/Invariants.t.sol#L1186)
- No contract in the deployment can read the native balance view at all.
  [`test_noContractInTheSystemCanReadTheNativeBalanceView`](../contracts/test/Invariants.t.sol#L1439),
  which reads the deployed bytecode for the two opcodes that could.
- The settlement asset is conserved across every address the system can reach.
  [`invariant_settlementSupplyIsConservedAcrossEveryActor`](../contracts/test/Invariants.t.sol#L1261)
- The escrow, the resolver registry and the agent registry each hold exactly what their own
  ledgers say, plus whatever was sent to them by mistake.
  [`invariant_escrowHoldsItsLiveLocksItsBondsAndTheFeesItOwes`](../contracts/test/Invariants.t.sol#L1204),
  [`invariant_oracleRegistryHoldsOnlyBondsAndTheRewardFloat`](../contracts/test/Invariants.t.sol#L1225),
  [`invariant_agentRegistryHoldsExactlyTheStakeLedger`](../contracts/test/Invariants.t.sol#L1253)

## Staking

- The pool's token balance always covers the stake it records.
  [`invariant_theBalanceCoversTheBooks`](../contracts/test/token/StakingInvariant.t.sol#L196)
- Every micro-dollar of rewards is divided across shares, carried to the next division, or parked
  for the treasury; nothing else can explain a unit of the balance.
  [`invariant_everyMicroDollarIsAccountedFor`](../contracts/test/token/StakingInvariant.t.sol#L202)
- What stakers are owed, earning and on their way out never adds up to more than the pool holds
  for them.
  [`invariant_noStakerIsOwedMoreThanThePoolHolds`](../contracts/test/token/StakingInvariant.t.sol#L211)
- The unbonding pool is part of the pool, and it is empty exactly when nobody holds a claim on it.
  [`invariant_theUnbondingPoolIsPartOfThePool`](../contracts/test/token/StakingInvariant.t.sol#L226)
- The share count stays bounded however slashes and deposits interleave.
  [`invariant_sharesStayBounded`](../contracts/test/token/StakingInvariant.t.sol#L234)

## Credit pool

- Every unit in the pool or lent out came from the lender or from spread a borrower paid, less
  what was taken back, swept to stakers or written off.
  [`invariant_cashLentAndReservesAreConserved`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L219)
- Stakers are only ever paid spread.
  [`invariant_stakersOnlyEverGetPaidSpread`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L229)
- No principal outstanding sits above the pool's cap or a mandate's cap.
  [`invariant_noPrincipalAboveCaps`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L239)
- A write-off clears the debt and the principal behind it and leaves the reserves alone.
  [`invariant_writeOffsClearDebtAndLeaveReserves`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L248)
- Every write-off takes the uncovered loss at a live price ceiling, within the slash allowance,
  nothing for the part the seized collateral covers, and nothing while the pool is not the
  slasher or the ceiling is unset or stale.
  [`invariant_slashIsTheLossAtTheCeilingInsideTheAllowance`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L256)
- What the vault says its seizure covers is booked against the debt and no further: the covered
  loss never runs past what was written off.
  [`invariant_coveredLossNeverExceedsTheWriteOff`](../contracts/test/rwa/CreditPoolInvariants.t.sol#L262)

## Treasury lane (TreasuryPark)

- Each adapter holds exactly the asset behind every position it carries, its basis total is the
  sum of the positions' bases, and the USDG reserve is held one for one.
  [`invariant_everyAdapterHoldsExactlyThePositionsItCarries`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L790)
- Every unit a mandate was funded with is on the mandate, in its vault, parked at cost, spent, or
  withdrawn by the principal, less what came back from the adapters.
  [`invariant_usdgIsConservedPerMandate`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L812)
- USDG is conserved across every address in the lane.
  [`invariant_theSettlementAssetIsConservedAcrossEveryHolder`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L829)
- No park lands past a mandate's cap or the shared cap, and no park leaves a mandate under the
  buffer its principal set.
  [`invariant_noParkPassesACapOrDipsUnderTheBuffer`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L839)
- Only a mandate's own principal or agent parks, unparks or returns its idle USDG, only its
  principal sets its buffer, only an account one of the factories created may park at all, and
  only governance switches adapters and listings.
  [`invariant_onlyAMandatesOwnOperatorsMoveItsFunds`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L858)
- An unpark delivers to the mandate exactly what it reports, and never more than the position
  it sold was worth at the price feed plus the fill band.
  [`invariant_anUnparkReturnsNoMoreThanThePositionIsWorth`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L871)
- Spending power counts the mandate's USDG, its idle vault balance and the USDG reserve, and
  counts SGOV after the haircut only while the feed is fresh, nothing is paused and the pool
  agrees with the feed. Otherwise SGOV counts for nothing.
  [`invariant_spendingPowerCountsOnlyFreshPositions`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L878)
- A move inside every rule is never refused: setting a buffer, returning idle USDG and unparking
  what a position holds all land, from the reserve at any time and from SGOV while its market
  is open.
  [`invariant_aMoveInsideEveryRuleIsNeverRefused`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L904)
- The admin seat moves only to the address the sitting admin named, and only when that address
  accepts.
  [`invariant_theAdminSeatMovesOnlyByOfferAndAcceptance`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L896)
- Whatever governance switches off, every position comes back out: at the end of every sequence
  each position is sold back to its mandate and each vault emptied. Nothing is left on the
  reserve, and no SGOV position keeps more than a remainder worth under a tenth of a cent, which
  sells with the next amount parked on top of it.
  [`afterInvariant`](../contracts/test/rwa/TreasuryParkInvariants.t.sol#L912)

## Buyback

- One call spends at most the per-call target, a window never carries more than its cap after a
  buy, and no buy lands inside the interval after the last.
  [`invariant_noBuyEverPassesItsCallOrWindowLimit`](../contracts/test/token/BuybackInvariant.t.sol#L496)
- Every fill prices BRSR at or under the ceiling governance set, wherever a trader pushed the
  pool first.
  [`invariant_noBuyEverFillsAboveTheCeiling`](../contracts/test/token/BuybackInvariant.t.sol#L502)
- Paused, without a keeper, with the ceiling unset or stale, inside the interval, with nobody
  staked or with less than the minimum to spend, a buy is refused.
  [`invariant_aShutGateBuysNothing`](../contracts/test/token/BuybackInvariant.t.sol#L508)
- Every BRSR a buy receives is compounded into the staking pool in the same transaction; the
  contract keeps none of its own beyond strays, and the keeper is paid nothing.
  [`invariant_boughtBrsrLandsInTheStakingPoolAndNowhereElse`](../contracts/test/token/BuybackInvariant.t.sol#L514)
- The USDG balance is what was given less what was spent on the pool or returned to the
  treasury; the pool holds exactly what was spent and the treasury exactly what was swept.
  [`invariant_theBalanceIsWhatWasGivenLessWhatWasSpentOrReturned`](../contracts/test/token/BuybackInvariant.t.sol#L530)
- The spend the contract quotes as available is exactly what a buy in the same block spends, and
  zero whenever a buy would be refused.
  [`invariant_availableIsWhatABuyWouldSpend`](../contracts/test/token/BuybackInvariant.t.sol#L545)
- Only the keeper buys and only governance changes the parameters, the keeper, the brake or the
  ceiling's age.
  [`invariant_onlyTheKeeperBuysAndOnlyGovernanceGoverns`](../contracts/test/token/BuybackInvariant.t.sol#L549)
- The brake stops buying and nothing else: a sweep of what is held lands, paused or not, and
  pays the treasury.
  [`invariant_pauseStopsBuysAndTrapsNothing`](../contracts/test/token/BuybackInvariant.t.sol#L556)
- A buy inside every gate whose quoted fill sits inside the ceiling lands.
  [`invariant_aBuyInsideEveryGateAndTheCeilingLands`](../contracts/test/token/BuybackInvariant.t.sol#L563)
- The admin seat moves only by offer and acceptance.
  [`invariant_theAdminSeatMovesOnlyByOfferAndAcceptance`](../contracts/test/token/BuybackInvariant.t.sol#L569)

## Liquidity seeder

- The liquidity the seeder records is the liquidity the pool holds in range, position by position.
  [`invariant_theSeedersBookIsTheManagersLiquidity`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L409)
- An adder is charged exactly what the position costs at the pool's price, is refused whole when
  it offers a unit less, and gets every unit offered beyond the cost straight back.
  [`invariant_everyAdderPaysExactlyWhatThePositionCosts`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L420)
- Nothing sits on the seeder but what was sent there by mistake and not yet swept; adds and
  removals pass through without leaving a unit behind.
  [`invariant_theSeederKeepsNothingButStrays`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L427)
- A removal pays its recipient exactly what it reports, never more than the liquidity cost to add,
  and never more liquidity than the range holds.
  [`invariant_aRemovalPaysItsRecipientAndNoMoreThanThePositionIsWorth`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L443)
- Adding is open to anyone and gives the liquidity away. Opening the pool, taking liquidity out
  and sweeping are the owner's alone, and the pool opens once.
  [`invariant_onlyTheOwnerOpensRemovesOrSweeps`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L449)
- The owner's seat moves only by offer and acceptance.
  [`invariant_theSeatMovesOnlyByOfferAndAcceptance`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L453)
- At the end of every sequence every position is taken back out, and what the pool keeps is
  rounding of at most two units per leg per add or removal.
  [`afterInvariant`](../contracts/test/token/V4LiquiditySeederInvariant.t.sol#L461)

## Vesting

- For every grant, what was paid never runs ahead of what has vested, what has vested never runs
  ahead of what was granted, and the beneficiary holds exactly what the contract says it paid.
  [`invariant_claimedNeverRunsAheadOfVestedNorVestedOfTheGrant`](../contracts/test/token/VestingInvariant.t.sol#L292)
- Vested is the schedule's line: nothing before the cliff, the whole grant after four years, the
  straight line between, or the point where a revocation froze it.
  [`invariant_vestedIsTheScheduleLineOrWhereRevocationFrozeIt`](../contracts/test/token/VestingInvariant.t.sol#L312)
- Nothing vests or pays before the cliff.
  [`invariant_nothingVestsOrPaysBeforeTheCliff`](../contracts/test/token/VestingInvariant.t.sol#L324)
- The vested figure never falls, and a revocation takes exactly the unvested remainder.
  [`invariant_vestedNeverFallsAndRevocationNeverReachesBack`](../contracts/test/token/VestingInvariant.t.sol#L335)
- The balance is what the grants are still owed plus the surplus, and nothing else.
  [`invariant_theBalanceIsWhatIsOwedPlusTheSurplus`](../contracts/test/token/VestingInvariant.t.sol#L343)
- Every token that left went to a beneficiary as a claim or to the treasury as a forfeit or a
  sweep; nobody else is ever paid.
  [`invariant_everyTokenThatLeftIsAClaimAForfeitOrASweep`](../contracts/test/token/VestingInvariant.t.sol#L358)
- The admin seat moves only by offer and acceptance.
  [`invariant_theAdminSeatMovesOnlyByOfferAndAcceptance`](../contracts/test/token/VestingInvariant.t.sol#L380)
- At the end of every sequence the schedule is run out and every grant claimed: the whole
  allocation ends up paid to its beneficiary or forfeited to the treasury, with nothing left owed
  and nothing paid twice.
  [`afterInvariant`](../contracts/test/token/VestingInvariant.t.sol#L389)

## Collateral vault

- Tokens are conserved for every asset: the vault's balance is the collateral behind its credit
  lines plus what it has seized.
  [`invariant_tokensAreConservedPerAsset`](../contracts/test/rwa/CollateralInvariants.t.sol#L675)
- The vault's view of a line's debt is the credit pool's, and a line's health reads as unlimited
  exactly when it owes nothing.
  [`invariant_poolDebtMatchesTheVaultsView`](../contracts/test/rwa/CollateralInvariants.t.sol#L688)
- A write-off leaves the line with no debt.
  [`invariant_aWriteOffLeavesNoDebt`](../contracts/test/rwa/CollateralInvariants.t.sol#L703)
- No draw lands without a valid price observation that has aged long enough to be trusted.
  [`invariant_noDrawWithoutAValidAgedObservation`](../contracts/test/rwa/CollateralInvariants.t.sol#L707)
- Only a keeper the guard's governance named can record a reading; nobody else ever plants one.
  [`invariant_aNonKeeperNeverPlantsAReading`](../contracts/test/rwa/CollateralInvariants.t.sol#L711)
- No liquidation sale completes while the price guard reports a halt for the asset being sold.
  [`invariant_noSaleCompletesWhileTheGuardHalts`](../contracts/test/rwa/CollateralInvariants.t.sol#L715)
- A write-off never seizes more than the written-off debt is worth at the feed while a feed can
  be read; what the debt does not need stays the borrower's.
  [`invariant_aWriteOffNeverSeizesMoreThanTheDebtAtTheFeed`](../contracts/test/rwa/CollateralInvariants.t.sol#L719)
- A pool pushed and held across a keeper's reading backs no draw: while the pending reading,
  taken in an earlier block, has the pool off its band, no draw counts the asset, whatever the
  reading's age.
  [`invariant_aPushedPendingReadingHaltsDraws`](../contracts/test/rwa/CollateralInvariants.t.sol#L723)
- A write-off slashes stakers for the loss the seized collateral does not cover, at a live
  ceiling and within the allowance, and for nothing when the collateral covers it: the lender is
  never covered twice.
  [`invariant_aWriteOffSlashesOnlyTheUncoveredLoss`](../contracts/test/rwa/CollateralInvariants.t.sol#L727)
- A line that owes nothing can always withdraw all of its collateral.
  [`invariant_aLineWithNoDebtCanWithdrawEverything`](../contracts/test/rwa/CollateralInvariants.t.sol#L733)
- Seized tokens only ever sit in the vault's seized balance or go to the pool's lender.
  [`invariant_seizedOnlyEverLeavesToTheLender`](../contracts/test/rwa/CollateralInvariants.t.sol#L752)

## Shielded pool

A note is a private claim on a deposit in the pool.

- What the pool owes its notes is deposits less payouts, and never exceeds the pool's cap.
  [`invariant_thePoolOwesWhatCameInLessWhatWentOut`](../contracts/test/shielded/ShieldedInvariants.t.sol#L416)
- The pool's token balance always covers what it owes, and a token sent to it outside a deposit
  never counts toward any note.
  [`invariant_theBalanceCoversTheBooks`](../contracts/test/shielded/ShieldedInvariants.t.sol#L425)
- No depositor exceeds the per-depositor limit within a window.
  [`invariant_noDepositorExceedsItsWindow`](../contracts/test/shielded/ShieldedInvariants.t.sol#L435)
- An address the access registry blocks is never paid more than it deposited, less what it was
  already paid.
  [`invariant_aBlockedAddressIsNeverPaidPastItsDeposits`](../contracts/test/shielded/ShieldedInvariants.t.sol#L453)
- A payout that is refused never spends a note.
  [`invariant_aRefusalNeverSpendsTheNote`](../contracts/test/shielded/ShieldedInvariants.t.sol#L464)
- Every live note can be withdrawn in full by its depositor without anyone's approval.
  [`invariant_aDepositorCanAlwaysRagequitALiveNote`](../contracts/test/shielded/ShieldedInvariants.t.sol#L471)
