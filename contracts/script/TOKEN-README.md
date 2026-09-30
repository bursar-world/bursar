# BRSR, staking and the market

BRSR is Bursar's token. Resolvers bond it to rule on disputes, stakers put it at risk as the first
loss on the collateral lane and earn the lane's spread for it, and a buyback turns USDG the treasury
sends it into staked BRSR at a price governance caps. This page covers the scripts that bring that
up and what is left to governance afterwards. [`README.md`](README.md) covers how every script
reads the deployment record, and the parameters and checks they share.

| Script | What it does |
|---|---|
| `DeployToken.s.sol` | Mints BRSR and writes the team's vesting schedule. Once per chain. |
| `DeployStaking.s.sol` | Deploys the staking pool and the buyback, and a seeder for the BRSR/USDG position when the pool is open. |
| `SeedPool.s.sol` | Opens the BRSR/USDG market at a price you name, or adds to it at the price it stands at. |
| `ProposeWiring.s.sol` | Puts the keeper, the resolvers' bond floors, the rebate table and the credit pool's roles to the signers. |

On Robinhood Chain BRSR, its vesting contract and the open BRSR/USDG pool already exist. The record
names BRSR and `Vesting` under `token`, `DeployToken.s.sol` refuses to mint a second supply, and
the new staking pool and buyback are built on the token and the pool that are there.

## 1. The token: `DeployToken.s.sol`

BRSR has a fixed supply of one billion, minted once in its constructor and split four ways. It has
no admin, no minter, no owner and no upgrade path, and the deploy key never holds a token.

| Share | Goes to | Variable |
|---|---|---|
| 80% | the community allocation: staking rewards, resolver incentives and grants | `BURSAR_BRSR_COMMUNITY` |
| 10% | the vesting contract, for the team | none: its address is computed before the token is deployed |
| 5% | the treasury | the record's `roles.treasury` |
| 5% | the liquidity key, which seeds the market | `BURSAR_BRSR_LIQUIDITY` |

The team's share vests over four years behind a one-year cliff. Both terms are constants in the
contract.

| Variable | Meaning |
|---|---|
| `BURSAR_VESTING_START` | The vesting start date, as a unix timestamp, within 90 days either side of the deployment. |
| `BURSAR_VESTING_BENEFICIARIES` | Comma-separated addresses. |
| `BURSAR_VESTING_AMOUNTS` | Comma-separated BRSR wei, in the same order, summing to exactly 100,000,000e18. |

BRSR has to name the vesting contract as the team's recipient and the vesting contract has to name
BRSR as the token it pays out, so the script computes the token's address from the deploy key's
nonce, builds the vesting contract against it, deploys the token and checks the token landed
there before a single grant is written. Do not send anything else from the deploy key while it
runs. Then it writes the whole schedule in one call, which the vesting contract accepts once.

It refuses, with nothing sent, when:

| Error | What it means |
|---|---|
| `AlreadyRecorded` | The record already names BRSR. |
| `RoleCollision` | Two recipients share an address, one of them is the deploy key, or a beneficiary is the treasury or the timelock. |
| `VestingAmountsMismatch`, `VestingListLengthMismatch` | The grants do not add up to the team's share, or the lists differ in length. |
| `VestingStartOutOfRange` | The start date is more than 90 days from today. Backdating past the cliff would vest a quarter of the team's share in the first block. |
| `TokenAddressUnpredictable` | The token did not land where the vesting contract was built to expect it: a transaction from the deploy key moved its nonce. Nothing was written. |
| `AllocationMismatch`, `AllocationShareWrong`, `DeployerHoldsSupply`, `ScheduleNotApplied` | The mint or the schedule is not what was published. |

## 2. Staking and the buyback: `DeployStaking.s.sol`

| Contract | What it is |
|---|---|
| `Staking` | Holds BRSR. Resolvers bond in it, stakers take the collateral lane's first loss in it and earn the lane's spread, paid in USDG, and a staked balance earns a fee rebate. Seven days to leave. |
| `Buyback` | Spends USDG sent to it on BRSR in the BRSR/USDG pool, no more than the price ceiling per token, and stakes what it buys for every staker. |
| `V4LiquiditySeeder` | Holds a full-range position in that pool. Owned by governance from its first block: anyone may add to it, and only the timelock can take liquidity out. |

All three answer to the timelock from their constructors. The same run names the staking pool on
the resolver registry, the last one-shot call of the core set, which puts every resolver bond in
BRSR.

**Nobody can bond until governance says who.** The bond floor for everyone is
`BURSAR_STAKING_MIN_BOND`, 1e27 wei, which is more BRSR than exists. The wiring batch then names a
floor of 30,000 BRSR for each resolver the record lists. That is the allowlist, closed from the
first block rather than open until a proposal lands.

**The pool is fixed for good.** `BURSAR_BUYBACK_POOL_FEE`, `_TICK_SPACING` and `_HOOKS`, with the
record's two tokens and pool manager, name the pool the buyback trades. It cannot be pointed at
another: a buyback that can move to a new pool can move to a new price. The run refuses a pool key
v4 would not accept, a hook with no code behind it, and a dynamic-fee pool, whose hook could set the
fee of every buyback.

**Only the keeper triggers a buyback.** The keeper is the recorded `token.keeper`:
`BURSAR_BUYBACK_KEEPER` when it is set, and the first recorded resolver's key until a keeper service
runs with a key of its own. Governance names it in the wiring batch, and until then nobody can
trigger a buyback. Anyone else calling it gets `NotKeeper`, which is what stops a trader buying
ahead of a buyback, triggering it into the price they pushed, and selling back, all in one
transaction.

**The ceiling.** `BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR` is the most the buyback pays for one
whole BRSR, in micro-USD. Work it out from the pool's price plus the premium you will pay: with
BRSR at 200 micro-USD, a fifth above that is `240`. A ceiling set too low blocks buybacks until
governance moves it, and one set too high widens what a trader can take from each fill, so err low.
Unset, the buyback deploys a ceiling of zero, which refuses every trade: the right state before the
market has a price. A figure above `1e12`, a million dollars a token, is in some other unit and
stops the run.

A ceiling is trusted for seven days after governance sets it. After that every buyback refuses with
`PriceCeilingStale` until governance restates it with `Buyback.setParams`, so a price nobody has
looked at in a week never fills.

**When the pool is open,** as it is on Robinhood Chain, the run deploys the seeder, and the move to
the new set shifts the existing position into it. When it is not, there is no position yet:
`SeedPool.s.sol` opens the market.

| Error | What it means |
|---|---|
| `NotBrsr`, `AssetDecimalsMismatch` | The recorded token is not BRSR, or a token reports the wrong decimals. |
| `OracleRegistryNotReady` | The resolver registry was deployed by another key, already has a staking pool, or settles in another asset. |
| `PoolHookNotContract`, `DynamicFeePoolRejected`, `PoolFeeTooLarge`, `TickSpacingOutOfRange` | The pool key is not one v4 would accept, or its fee could move per swap. |
| `PriceCeilingNotAPrice`, `BondFloorZero` | The ceiling is in the wrong unit, or the resolvers' floor is zero. |
| `RoleCollision` | The treasury, the slash sink, the keeper and the deploy key are not four different addresses. |
| `AddressFrozen` | USDG has frozen the pool manager or the treasury. Every buyback pays the manager. |

## 3. The market: `SeedPool.s.sol`

`run()` opens the BRSR/USDG pool at a price you name and puts the first position in it, from a
seeder it deploys and offers to the timelock, which takes it in the next wiring batch.
`seedExisting()` adds to an open pool at the price it stands at, through the recorded seeder,
which is governance's. Anyone may add; what is added is governance's to take out.

v4 orders a pool's two tokens by address. On Robinhood Chain BRSR sorts below USDG, so the pool
prices USDG per BRSR. On a local chain the deploy key may put BRSR above USDG, and the pool prices
BRSR per USDG. You name the price the same way either way, in micro-USD for one BRSR: the script
works every figure out for the side BRSR is on and prints which side that is.

| Variable | Meaning |
|---|---|
| `BURSAR_SEED_USDG_MICRO` | The USDG side of the position, in micro-USD. The BRSR side is what that is worth at the price. |
| `BURSAR_SEED_PRICE_MICRO_USD` | `run()`: the opening price of one whole BRSR. `seedExisting()`: optional, the price you expect the pool to be at. |
| `BURSAR_SEED_MAX_DEVIATION_BPS` | `seedExisting()`: how far from that price the pool may be, 100 unless set. |
| `BURSAR_ALLOW_MAINNET_SEED` | Required on Robinhood Chain, and a different phrase for each way of changing the market: `i-am-opening-the-market` for `run()`, `i-am-adding-to-the-market` for `seedExisting()`, and `i-am-moving-the-market` for `MigrateLiquidity.s.sol`, which moves the existing position into governance's seeder in the move to the new set. Without it the run prints the plan and sends nothing. |

The script never takes a raw `sqrtPriceX96`. It derives the opening price twice, by two routes,
and refuses when they disagree by more than a fifth of a tick. Before anything is sent it prints
the position, the exact amounts the pool will take, and what one buyback at governance's
parameters then does to the pool. After, it reads the pool back and fails unless the pool holds
exactly what was sent, at exactly the planned price.

```sh
BURSAR_SEED_USDG_MICRO=5000000 BURSAR_ALLOW_MAINNET_SEED=i-am-adding-to-the-market \
  forge script script/SeedPool.s.sol --sig "seedExisting()" \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/brsr-liquidity" --broadcast
```

## 4. What governance does next

`ProposeWiring.s.sol` puts these decisions to the signers in one batch, and `VerifyWiring.s.sol`
holds them all to done:

- `Buyback.setKeeper`, to the recorded keeper;
- `Staking.setBondFloor`, 30,000 BRSR for each recorded resolver;
- `Staking.setTiers`, the rebate table in `script/lib/TokenConfig.sol`: 25,000 BRSR staked takes 5%
  off the facilitator fee, 100,000 takes 10%, 500,000 takes 20% and 2,500,000 takes 30%;
- `Staking.setCreditManager` and `Staking.setSlasher`, both to the credit pool, so the lane's spread
  reaches stakers and a written-off line reaches their stake;
- `V4LiquiditySeeder.acceptOwnership`, where `SeedPool.s.sol` opened the market and offered its
  seeder to the timelock.

Then, before the buyback does anything:

- **Stake.** A buyback stakes what it buys for everyone already staked. With nobody staked it
  refuses with `NoStakeToDistributeTo`.
- **Fund it.** Send USDG to the buyback. It holds no allowance on the treasury and cannot pull from
  it, so its balance is the hard limit on what it can ever spend. `available()` says what a buyback
  would spend in the current block, and zero when one would refuse.
- **Keep the ceiling current.** Restate it with `Buyback.setParams` at least once a week.

The keeper then calls `buyback()`. It chooses no amount, price or recipient: it spends the smallest
of the per-call target, the balance and what is left of the window, at a fill no worse than the
ceiling, and stakes the BRSR in the same transaction. A buyback also refuses when the ceiling is
zero or stale, when USDG is paused or has frozen the buyback or the pool manager, and when the pool
cannot fill the whole spend under the ceiling. Each leaves the money where it was.

The guardian can pause the buyback in the same block, which is the fast answer to a market moving
faster than the timelock. Restarting it is a proposal like any other change. `sweep` returns tokens
to the treasury fixed at construction, and only the timelock can call it.

## 5. Vesting, from the beneficiary's side

Nothing is claimable in the first year. At the cliff a quarter of the grant becomes claimable at
once, and the rest accrues every second until the fourth year ends.

```sh
source script/env/rhc-mainnet-v3.env
VESTING="$(jq -r .token.Vesting "$BURSAR_RECORD")"
ME="$(jq -r '.roles.vestingBeneficiaries[0]' deployments/rhc-mainnet-token.json)"   # the team grant's beneficiary

cast call "$VESTING" "claimableOf(address)(uint128)" "$ME" --rpc-url "$RHC_RPC_URL"     # BRSR wei claimable now
cast call "$VESTING" "scheduleOf(address)(uint64,uint64)" "$ME" --rpc-url "$RHC_RPC_URL" # the cliff and the end, unix times
cast send "$VESTING" "claim()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/brsr-team-1"    # the beneficiary's own key
```

A grant belongs to the address it was written for and cannot be moved: losing the key loses the
grant. The timelock can revoke a grant, which stops its clock. Everything vested up to then stays
claimable for as long as the beneficiary likes, and the unvested remainder goes to the treasury.
A revoked grant is not reinstated.
