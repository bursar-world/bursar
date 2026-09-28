# Deploying the BRSR token

`DeployToken.s.sol` brings up BRSR, the team vesting contract, the staking pool and the
buyback in one run, and refuses to start when the parameters you gave it do not hold together.
Read this before the first deploy on any chain. You do not need to have read the contracts.

It deploys against governance that already exists: `AdminTimelock` is live and administers the
rest of the system, and this run joins it. No second timelock is deployed.

| Contract | What it is |
|---|---|
| `BRSR` | Fixed supply of one billion, minted once in its constructor and split four ways. No minter, no owner, no upgrade path. |
| `Vesting` | The team allocation, released over four years behind a one-year cliff. Revocable by the timelock, and only forward. |
| `Staking` | The first-loss pool for the collateralized lane. Holds BRSR, pays the credit-lane spread in USDG, and sets the fee rebate. |
| `Buyback` | Spends protocol revenue on BRSR in the Uniswap v4 pool and compounds it into the staking pool. |

Two unit systems run through this deployment and the script keeps them apart. BRSR carries
eighteen decimals, so `1e18` is one token. USDG carries six, so `1_000000` is one dollar.
Every variable below says which one it is in. Durations are in seconds.

## 1. Before you start

**Keys.** Same as the core deploy: a Foundry encrypted keystore named by `ETH_KEYSTORE`, its
password in the file named by `ETH_PASSWORD`, and `RHC_RPC_URL`, `RHC_USDG` and `RHC_DEPLOYER`
exported. `README.md` §1 has the commands.

**Funding.** Gas is ETH and settlement is USDG, two different assets. The deploy key needs ETH
to send the transactions and at least 1 USDG for the preflight. It never holds BRSR at any
point in the run: the token mints straight to the four recipients, and the script stops if a
single token is left in the deploy key's hands.

```sh
cast balance "$RHC_DEPLOYER" --rpc-url "$RHC_RPC_URL"
cast call "$RHC_USDG" "balanceOf(address)(uint256)" "$RHC_DEPLOYER" --rpc-url "$RHC_RPC_URL"
```

**The pool has to exist.** The buyback trades against a Uniswap v4 pool that is already
deployed, and it is keyed to that pool permanently. Have the pool manager address, the fee, the
tick spacing and the hook address in hand before you start. The pool itself can be initialised
and seeded after the run, and it has to be seeded before the first buyback.

**Decide the recipients.** The four allocations are minted once and cannot be moved by anyone
afterwards. A typo here is permanent.

## 2. Environment

Nothing has a default. An unset variable stops the run with `MissingEnv("NAME")`, so the script
can never deploy something you did not choose.

### Chain, asset and governance

| Variable | Meaning |
|---|---|
| `BURSAR_CHAIN_ID` | The chain you intend to deploy to. Checked against the chain the RPC actually serves. |
| `BURSAR_SETTLEMENT_ASSET` | ERC-20 address of the settlement asset. Must answer `decimals() == 6`. On chain 4663 it must be USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. |
| `BURSAR_ADMIN_TIMELOCK` | The live `AdminTimelock` the core run deployed. Becomes admin of the vesting contract, the staking pool and the buyback at construction. Must hold code and report a non-zero period. There is no pinned address: governance is deployed per run. |
| `BURSAR_ORACLE_REGISTRY` | The core deployment's `OracleRegistry`, which this run wires to the staking pool so resolvers can bond. Set it to the zero address when there is nothing to wire. The zero address has to be typed out, because an unset variable stops the run. |

Every variable on this page can be namespaced. Set `BURSAR_ENV_PREFIX` and the script reads
`<prefix>BURSAR_CHAIN_ID` and so on, which is how two deployments share one shell without
reading each other's parameters.

### Supply recipients

The split is 80 / 10 / 5 / 5 and it is fixed in the token. The script checks each share against
the supply it divides, and stops on a token whose constants have drifted.

| Variable | Meaning |
|---|---|
| `BURSAR_BRSR_COMMUNITY` | Receives 80%. Staking rewards, resolver incentives and integration grants, released on a published schedule. |
| `BURSAR_BRSR_LIQUIDITY` | Receives 5%. The address that seeds the Uniswap v4 pool. |
| `BURSAR_TREASURY` | Receives 5%, and is also where the buyback returns a sweep and where the vesting contract sends a revoked remainder. |
| `BURSAR_SLASH_SINK` | Receives slashed stake from the staking pool for conversion against the shortfall it covers. Must not be the treasury. |

The team's 10% is minted to the vesting contract, whose address the script computes before it
deploys the token. No variable names it.

### Staking

| Variable | Meaning |
|---|---|
| `BURSAR_STAKING_UNBONDING_PERIOD` | Cooldown between asking to withdraw stake and collecting it. The contract accepts 7 to 90 days. It has to outlast the gap between a borrower defaulting and the shortfall being measured, or the exit queue becomes a way to read the news before the pool does. |
| `BURSAR_STAKING_MIN_BOND` | BRSR wei a resolver has to bond before it can vote on a dispute. Must be non-zero: at zero nobody can bond at all. |

`BURSAR_STAKING_MIN_BOND` is set at construction, because the dispute layer reads it from the
first block. A pool deployed at zero would ship a dispute layer no resolver could join until a
forty-eight hour proposal landed.

Governance can raise the floor afterwards, globally or for one resolver. `OracleRegistry` reads
it live on every vote, so a resolver below a new floor loses its vote in the block the change
lands and keeps its bond. That is how a bond denominated in a moving asset is kept honest
without a price oracle: no contract in this system reads a market.

The credit manager and the rebate tiers are timelock proposals, made after this run. The script
asserts that the credit manager is still unset, so a fresh deployment cannot be mistaken for a
finished one. Until that proposal lands, nothing can slash the pool and nothing can post the
credit-lane spread: `distribute` answers only to the credit manager, and the contract that would
charge the spread is not built.

### Vesting

| Variable | Meaning |
|---|---|
| `BURSAR_VESTING_START` | Vesting commencement date, as a unix timestamp. One date covers every grant. Must sit within 90 days either side of the deployment. |
| `BURSAR_VESTING_BENEFICIARIES` | Comma-separated addresses. |
| `BURSAR_VESTING_AMOUNTS` | Comma-separated BRSR wei, in the same order. Must sum to exactly 100,000,000e18. |

The four-year term and the one-year cliff are constants in the contract. Neither is a variable
and neither can be changed after deployment.

### The buyback's pool

| Variable | Meaning |
|---|---|
| `BURSAR_BUYBACK_POOL_MANAGER` | The Uniswap v4 pool manager. Must hold code. |
| `BURSAR_BUYBACK_POOL_FEE` | Pool fee in hundredths of a basis point, so `3000` is 0.30%. A dynamic-fee pool stops the run: its hook sets the fee per swap, which hands the venue a lever over the price of every buyback. |
| `BURSAR_BUYBACK_POOL_TICK_SPACING` | The pool's tick spacing. Between 1 and 32,767. |
| `BURSAR_BUYBACK_POOL_HOOKS` | The pool's hook address, or `0x0` for a pool with no hook. Must be set explicitly, because zero is a legitimate value and an unset variable is not. |

These five values are the pool identity, and the buyback holds them permanently. Governance
cannot re-point it. Moving to another pool means deploying a second buyback and funding that one
instead. A buyback that can be pointed at a new pool can be pointed at a new price, which is the
whole reason the identity is frozen.

**Uniswap v4 is live on Robinhood Chain.** `BURSAR_BUYBACK_POOL_MANAGER` is the PoolManager at
`0x8366a39CC670B4001A1121B8F6A443A643e40951`. A native ETH/USDG pool at the 0.05% tier already
has depth there, which is not the pair this buyback trades, so the BRSR/USDG pool has to be
initialised and seeded before the first call.

### The buyback's policy

| Variable | Meaning |
|---|---|
| `BURSAR_BUYBACK_SPEND_PER_CALL` | Micro-USD. What one call aims to spend. The actual spend is this, the balance, or the remaining window headroom, whichever is smallest. |
| `BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW` | Micro-USD. Ceiling on total spend within one window, whoever triggers the calls. Must be at least `SPEND_PER_CALL`. |
| `BURSAR_BUYBACK_MIN_SPEND` | Micro-USD. Below this a buyback reverts. A dust buy costs more gas than it moves and hands an observer a cheap price print. Must not exceed `SPEND_PER_CALL`. |
| `BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR` | Micro-USD the buyback will pay for one whole BRSR, at most. Five cents is `50000`. An unset variable deploys zero, and a ceiling of zero closes every trade. |
| `BURSAR_BUYBACK_WINDOW` | Seconds. How often the spend cap resets. At most 30 days. |
| `BURSAR_BUYBACK_MIN_INTERVAL` | Seconds. Cooldown between buybacks. Must not exceed the window, or the cap is out of reach. |

**Setting the price ceiling.** `MAX_PRICE_MICRO_USD_PER_BRSR` decides how much a trader
watching this contract can take off each buyback. Work it out before you type it: the price on
a screen, in micro-USD, plus the slippage you will accept.

At $0.05 per BRSR:

```
50000   the market, five cents a token
52500   5% above it
```

A ceiling set too low blocks buybacks until governance moves it. A ceiling set too high widens
the margin a front-runner can take. Only the first fails harmlessly, so err low.

**Leave it unset until the pool has a price.** A run with no ceiling deploys zero, and a
ceiling of zero closes every trade: `buyback()` reverts with `PriceCeilingUnset` and
`available()` reports nothing. That is where a contract whose venue has not been seeded belongs.
Governance sets a real ceiling through `Buyback.setParams` once there is a market to read, and
that proposal has to land before the buyback is funded. See section 6.

The variable this replaced, `BURSAR_BUYBACK_MIN_OUT_PER_USDC`, held BRSR wei per whole USDC. A
larger number meant a tighter floor, and no value in that unit stopped trading altogether. A run
that finds it still set in the shell stops with `RetiredEnv`, because a figure in the old unit
read as a price is a wrong ceiling rather than an obvious error. A ceiling above `1e12`, which
is a million dollars a token, stops the run for the same reason.

### Example, Robinhood Chain mainnet

Every value here needs a decision. None of them is a default you can accept unread.

These are the Release 1 values, from the `parameters`, `pool` and `verifiedOnChain` sections of
`deployments/rhc-mainnet-token.json`. The buyback figures are sized to the float Release 1
actually has, which is small on purpose: the buyback can only spend what has been transferred to
it, and the pool will be seeded with single-digit USDG. All six buyback figures move later on a
`Buyback.setParams` proposal; only the pool identity is frozen. The role addresses are left as
`0x...` because they belong to whoever runs the deploy; Release 1's own are under `roles` in the
same file.

```sh
export BURSAR_CHAIN_ID=4663
export BURSAR_SETTLEMENT_ASSET=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export BURSAR_ADMIN_TIMELOCK=0x...                  # the timelock the core run deployed

export BURSAR_BRSR_COMMUNITY=0x...                  # Release 1: the timelock itself
export BURSAR_BRSR_LIQUIDITY=0x...
export BURSAR_TREASURY=0x...
export BURSAR_SLASH_SINK=0x...

export BURSAR_ORACLE_REGISTRY=0x...                 # the core deployment's resolver registry

export BURSAR_STAKING_UNBONDING_PERIOD=604800      # 7d, the contract floor
export BURSAR_STAKING_MIN_BOND=25000000000000000000000   # 25,000 BRSR per resolver

export BURSAR_VESTING_START=1790035200             # 2026-09-22T00:00:00Z
export BURSAR_VESTING_BENEFICIARIES=0x...          # one grant in Release 1
export BURSAR_VESTING_AMOUNTS=100000000000000000000000000   # the whole team share, 100M BRSR

export BURSAR_BUYBACK_POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
export BURSAR_BUYBACK_POOL_FEE=3000                # 0.30%
export BURSAR_BUYBACK_POOL_TICK_SPACING=60
export BURSAR_BUYBACK_POOL_HOOKS=0x0000000000000000000000000000000000000000

export BURSAR_BUYBACK_SPEND_PER_CALL=500000        # 0.50 USDG
export BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW=5000000 # 5 USDG
export BURSAR_BUYBACK_MIN_SPEND=100000             # 0.10 USDG
# Left unset until the pool has a price. Unset deploys zero, which closes every trade.
# export BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR=52500   # $0.0525 a token
export BURSAR_BUYBACK_WINDOW=86400                 # 1d
export BURSAR_BUYBACK_MIN_INTERVAL=3600            # 1h
```

Chain `4663` is the only deploy target. Testnet `46630` answers, but USDG holds no contract
there, so nothing on it can settle.

## 3. Running it

Simulate first. Without `--broadcast` nothing is sent, and every check in the script still runs
against the live chain state.

```sh
source bursar-token.env       # the parameters from section 2
cd contracts

forge script script/DeployToken.s.sol:DeployToken \
  --rpc-url "$RHC_RPC_URL" \
  --sender "$RHC_DEPLOYER" \
  -vvv
```

Then deploy:

```sh
forge script script/DeployToken.s.sol:DeployToken \
  --rpc-url "$RHC_RPC_URL" \
  --sender "$RHC_DEPLOYER" \
  --broadcast --slow -vvv
```

`--sender` has to be the keystore address. The script computes the token's address from that
key's nonce, and it writes the vesting schedule from that key as well.

**Do not send anything else from the deploy key while the run is in flight.** A transaction
from another shell moves the nonce out from under the address the script predicted. The script
proves the nonce model on the first deployment and stops with `TokenAddressUnpredictable`
before the token is minted. That costs you a wasted deployment and no allocation is stranded,
but the run has to start again from a clean nonce.

`--slow` sends one transaction at a time and waits for each receipt. On a chain where gas is the
settlement asset, a mispriced batch is worth avoiding.

Addresses and transaction hashes land in `broadcast/DeployToken.s.sol/<chainId>/run-latest.json`.
The script also prints every address at the end of the run.

## 4. The order, and why it is that order

BRSR has to name the vesting contract as the team's recipient. The vesting contract has to name
BRSR as the token it pays out. Neither address exists when the other constructor runs, and the
token's mint happens once and cannot be repeated, so the loop is closed by computing one address
in advance and checking it.

1. **Compute two addresses** from the deploy key's next two nonces: the vesting contract and
   the token.
2. **`Vesting`**, built against the predicted token address, with the timelock as admin and the
   treasury as the destination for a revoked remainder. Its own address is checked against the
   prediction straight away, which proves the nonce model while nothing irreversible has
   happened yet.
3. **`BRSR`**, which mints the whole supply inside its constructor and sends the team's tenth to
   the contract from step 2. The script then checks that the token landed where it was expected
   to, and stops before a single grant is written if it did not.
4. **`Staking`**, holding BRSR as stake and USDG as the spread asset, with the timelock as
   admin and the resolver bond floor set at construction.
5. **`OracleRegistry.setStaking`**, from the deploy key, when `BURSAR_ORACLE_REGISTRY` names
   one. This is the fourth one-shot pairing in the system and the one the core deployment could
   not make, because the pool that prices a resolver bond is part of this set. The registry
   reads the bond token off the pool itself, so the asset a resolver posts cannot disagree
   with the floor that admits it. Everything checkable about the registry is checked before the
   mint, because this call has no second chance either.
6. **`Buyback`**, which reads the staking pool's two tokens back in its own constructor and
   reverts if it is being wired to a pool that stakes something else.
7. **`Vesting.createGrants`**, from the deploy key, writing the whole schedule in one call. It
   accepts exactly one call and there is no second chance. A run that stops between step 3 and
   this one leaves a funded vesting contract with no schedule, and it has to be redone.

Every admin is the timelock from construction, so no contract in this set is ever administered
by the deploy key. The only powers the deploy key keeps are steps 5 and 7, and both are spent in
the run.

## 5. What the script refuses to do

These are the cross-contract conditions no single constructor can see. Each one stops the run
with a named error.

| Error | What it means |
|---|---|
| `WrongChain` | `BURSAR_CHAIN_ID` does not match the chain behind `--rpc-url`. Usually an RPC pointed at the wrong network. |
| `AssetNotContract`, `AssetDecimalsMismatch` | The settlement asset holds no code, does not answer `decimals()`, or reports something other than six. |
| `AssetNotUsdg` | On chain 4663 the asset must be USDG at the verified address. |
| `AssetPaused`, `AddressFrozen` | USDG is paused, or has frozen the deploy key, the treasury, the buyback or the pool manager. A frozen address reverts every transfer whatever the balance says. |
| `SettlementBalanceTooLow` | The deploy key holds less than 1 USDG. The run spends none, so this is the check that the address in the parameter file is the asset the system settles in. |
| `TimelockNotContract`, `TimelockPeriodZero` | Governance is not there, or executes immediately. A timelock with no delay is a multisig with extra steps. |
| `PoolManagerNotContract`, `PoolHookNotContract` | The pool manager holds no code, or a hook address was given with nothing behind it. Every buyback would revert on a pool key that matches nothing. |
| `DynamicFeePoolRejected`, `PoolFeeTooLarge`, `TickSpacingOutOfRange` | The pool key describes a pool v4 would not accept, or one whose fee its hook can rewrite per swap. |
| `PriceCeilingNotAPrice` | `MAX_PRICE_MICRO_USD_PER_BRSR` is above a million dollars a token, so it is a figure in some other unit. Zero is legal and closes every trade. |
| `OracleRegistryNotContract`, `OracleRegistryNotReady` | `BURSAR_ORACLE_REGISTRY` holds no code, was deployed by a different key, already has a staking pool, or settles in a different asset. Nothing was sent. |
| `RoleCollision` | Two roles share an address. The deploy key, the treasury, the slash sink, the community address and the liquidity address each need their own, and no vesting beneficiary may be the deploy key, the treasury or the timelock. |
| `TokenAddressUnpredictable` | The token did not land at the address the vesting contract was built against. Usually a nonce spent between the simulation and the broadcast. Nothing was written; rerun. |
| `AllocationMismatch`, `AllocationShareWrong` | The token's four allocations do not add up to its supply, or one of them is not the published share of it. |
| `VestingAmountsMismatch`, `VestingListLengthMismatch` | The grant amounts do not sum to the team allocation, or the two lists are different lengths. |
| `VestingStartOutOfRange` | The commencement date is more than 90 days from the deployment. Backdating past the cliff would vest a quarter of the team allocation in the first block. |
| `DeployerHoldsSupply` | The deploy key holds BRSR after the run. Something was minted somewhere nobody chose. |
| `MissingEnv`, `EnvOutOfRange`, `EnvIntOutOfRange` | A variable is unset or too large for its field. |
| `RetiredEnv` | A variable from an older parameter set is still in the shell. Its value is in a unit nothing reads any more, so the run names it and the variable that replaced it. |
| `WiringFailed`, `ParameterNotApplied`, `ScheduleNotApplied` | A constructor argument did not take effect on chain, or the vesting term is not four years behind a one-year cliff. The run stops with the value expected and the value found. |

After the transactions land, the script reads all of it back off chain: the supply and each of
the four balances, the vesting term, every grant, the staking pool's tokens and period, the
buyback's pool key and every policy parameter, and all three admins. A deployment that reaches
the end of the run is wired.

### 5.1 What the compliance preflight reads, and what it cannot

USDG is a diamond proxy. A selector it routes returns a value; a selector it does not route
reverts `FacetNotFound`. So the surface is testable rather than guessable, and the script reads
exactly the two calls that answer:

```sh
cast call "$RHC_USDG" "paused()(bool)" --rpc-url "$RHC_RPC_URL"
cast call "$RHC_USDG" "isFrozen(address)(bool)" "$RHC_DEPLOYER" --rpc-url "$RHC_RPC_URL"
```

Both are ordinary contract storage behind a delegatecall, so a fork fetches them and
`forge script` gets the same answer as the node. There is no gas stipend on either read and no
three-valued answer, because there is no precompile in the path. A read that stops answering
means the asset this system settles in has changed, and the run stops rather than carrying on.

`isBlacklisted` is absent. It is Circle's name for the block-list read on USDC, and USDG does not
answer it, so there is no block-list check here and nothing pretends there is. `version()` is absent too; do
not call it.

A stipend and a third answer are only needed when a block list forwards to a node precompile
that publishes a single byte of code. Anything running against a fetched copy of such a chain
executes that byte as an opcode, which fails and consumes every unit forwarded to it. That
hazard does not exist on 4663.

## 6. After the deploy

The shell snippets below use these names for addresses the run printed:

```sh
TIMELOCK=$BURSAR_ADMIN_TIMELOCK   # the live AdminTimelock
BUYBACK=0x...                      # the Buyback this run deployed
STAKING=0x...                      # the Staking pool this run deployed
VESTING=0x...                      # the Vesting contract this run deployed
ME=0x...                           # the address you are calling from
CALLDATA=$(cast calldata '<sig>' <args>)   # encoded once per proposal
ID=<n>                             # the proposal id the timelock printed
```

Five things are left, and the order matters. Set the price ceiling before you send the money.
The ceiling is a timelock proposal carrying a forty-eight hour delay, and for those two days a
funded buyback with no ceiling is a pot of USDG guarded by a revert. Start the proposal, let it
land, then fund.

**Seed the pool.** From the liquidity address, initialise the Uniswap v4 pool at the fee and
tick spacing you configured and add liquidity. The buyback reverts on a pool that does not exist
and on one too thin to fill a whole `SPEND_PER_CALL` at the ceiling.

**Stake.** A buyback compounds BRSR into the staking pool, which raises what every share
outstanding is worth. With no shares outstanding there is nobody to credit, so the buyback
reverts with `NoStakeToDistributeTo()` before it trades.

**Set the price ceiling.** A timelock proposal against the buyback, carrying the whole parameter
set with a real `maxPriceMicroUsdPerBrsr` in it. A fresh deployment leaves the ceiling at zero, so
until this lands every call reverts with `PriceCeilingUnset`. Read the market now that the pool
has one. "Setting the price ceiling" in section 2 has the arithmetic.

```sh
cast call "$BUYBACK" "params()((uint128,uint128,uint128,uint128,uint64,uint64))" --rpc-url "$RHC_RPC_URL"
# from a timelock signer, with the new parameter set encoded
cast send "$TIMELOCK" "propose(address,bytes)" "$BUYBACK" "$CALLDATA" --rpc-url "$RHC_RPC_URL"
```

**Fund the buyback.** Transfer USDG to the buyback address from the treasury. It holds no
allowance on the treasury and cannot pull from it, so its balance is the hard ceiling on
everything it can ever spend. It also cannot take over the escrow's fee destination, because
that handover requires the incoming treasury to call `acceptTreasury` and this contract does not
make that call. Revenue reaches it by transfer.

```sh
cast send "$RHC_USDG" "transfer(address,uint256)" "$BUYBACK" 1000000000 --rpc-url "$RHC_RPC_URL"
cast call "$BUYBACK" "available()(uint256)" --rpc-url "$RHC_RPC_URL"
```

`available()` reports what a buyback would spend if it were called in this block, and zero when
one would revert. Read it before paying for a transaction that fails.

**Name the credit manager and the rebate tiers.** Both are timelock proposals against the
staking pool. Nothing can slash stake until `setCreditManager` lands, no staker earns a fee
rebate until `setTiers` does, and nothing can post the credit-lane spread either: `distribute`
is callable only by the credit manager. That contract does not exist yet. Leave the slot unset
until it does; an address that cannot charge a spread is worse there than nothing.

```sh
# from a timelock signer
cast send "$TIMELOCK" "propose(address,bytes)" "$STAKING" "$CALLDATA" --rpc-url "$RHC_RPC_URL"
# from a second signer
cast send "$TIMELOCK" "approve(uint256)" "$ID" --rpc-url "$RHC_RPC_URL"
# once the delay has passed
cast send "$TIMELOCK" "execute(uint256)" "$ID" --rpc-url "$RHC_RPC_URL"
```

## 7. Running a buyback

`buyback()` is open to anyone and pays the caller nothing. The caller chooses no amount, no
price, no deadline and no recipient. It spends what the caps allow, at a price no worse than the
ceiling, and compounds the result into the staking pool in the same transaction.

```sh
cast send "$BUYBACK" "buyback()" --rpc-url "$RHC_RPC_URL"
```

Four parameters bound what a trader watching the contract can take out of it. None removes the
exposure. The ceiling is the limit on how far a fill can be pushed; `SPEND_PER_CALL` is the
limit on one trade. Above those sits `MAX_SPEND_PER_WINDOW`, which caps a whole strategy inside
one window however many calls it is spread over, and `MIN_INTERVAL`, which stops that window's
budget being emptied across consecutive blocks. Robinhood Chain settles in well under a
second. That shortens the interval in which a pending call can be seen and bracketed without
closing it.

The ceiling moves on governance time, and the timelock's delay is 48 hours. A market can move
faster than that, so the fast response is the brake: the guardian pauses the buyback in one
call. Governance then sets a new ceiling, and the pause lifts on a proposal like any other
change.

```sh
# from the guardian key
cast send "$TIMELOCK" "guardianPause(address[])" "[$BUYBACK]" --rpc-url "$RHC_RPC_URL"
```

A buyback also stops on its own when the ceiling is zero, when USDG is paused, when the buyback
address or the pool manager is blocked, when the pool cannot fill the whole spend, and when the
fill would land above the ceiling. All of those leave the money where it is.

`sweep(address,uint256)` returns tokens to the treasury and is reachable only through the
timelock. The destination is fixed at construction, so it cannot be redirected.

## 8. Vesting, from the beneficiary's side

Nothing is claimable for the first year. At the cliff a quarter of the grant becomes claimable
in one step, and the rest accrues every second until the four years are up.

```sh
cast call "$VESTING" "claimableOf(address)(uint128)" "$ME" --rpc-url "$RHC_RPC_URL"
cast call "$VESTING" "scheduleOf(address)(uint64,uint64)" "$ME" --rpc-url "$RHC_RPC_URL"
cast send "$VESTING" "claim()" --rpc-url "$RHC_RPC_URL"
```

A grant is bound to the address it was written for and cannot be moved. Losing the key loses the
grant.

The timelock can revoke a grant, which stops the clock. Everything vested up to the moment of
the call stays claimable for as long as the beneficiary cares to wait, and the unvested
remainder returns to the treasury. Revocation is one-way. There is no reinstatement, and this
contract has no second `createGrants` to write a replacement with.
