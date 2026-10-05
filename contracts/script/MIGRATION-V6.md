# Moving Bursar to the sixth contract set

This runbook brings the sixth Bursar contract set live on Robinhood Chain. The sixth set is the
fifth with its collateral lane rebuilt a second time, after the second rescore: a new price guard,
stock router, treasury adapter, credit pool and collateral vault, and everything else carried over
at its address. It is written for the people who hold the keys. Every step is a script in this
directory that can be simulated against the live chain before it sends anything, and the whole
sequence has been rehearsed on a copy of mainnet with the same scripts and arguments.

## What changes

- **Five contracts are new.** `PriceGuard`, which judges its pending reading whatever its age once
  it was taken in an earlier block, so a draw needs the pool to have agreed with the feed at two
  keeper readings and not at one held open across a keeper transaction, and whose keeper the
  timelock's guardian can remove at once; `StockSpendRouter` and `RobinhoodStockAdapter`, which
  hold the guard immutably; `CreditPool`, whose write-off slashes stakers for the loss the seized
  collateral does not cover rather than for the whole debt, and `CollateralVault`, which bind to
  each other once.
- **Everything else stays where it is.** Governance, the token set, escrow, reputation, the two
  registries, the mandate factory, the asset registry, the treasury park and its USDG adapter,
  committed mandates and shielded settlement, at the same addresses. The shielded pool is not wound
  down. The public and committed example mandates carry over untouched.
- **Governance is the 48-hour timelock, and has been since 2026-10-05.** Its acceptances of every
  carried contract executed that day, so the fifth record reads as [`GOVERNANCE-48H.md`](GOVERNANCE-48H.md)
  leaves it and the sixth is written the same way: the 48-hour timelock administers every carried
  contract and every new one, and the one-hour timelock keeps the escrow's brake. The five new
  contracts answer to the 48-hour timelock from their constructors and never need a handover. The
  wiring batch waits two days on it.
- **One governance batch rewires the carried contracts to the new lane.** The staking pool's
  credit manager and slasher move to the new credit pool, and the treasury park lists the new
  treasury adapter and drops the fifth set's. A position parked through the fifth set's adapter can
  still be unparked afterwards; new parks go through the new adapter.
- **Money the fifth lane holds moves to the sixth:** the credit pool's lending cash, and the stock
  the collateral example posted, which comes out of the fifth vault and into the sixth under a new
  collateral example. The fifth escrow, registries and shielded pool have nothing to move.
- **The apps move two days after the wiring is proposed.** The new record is marked live as soon as
  the batch has landed and the collateral example exists, and the fifth record is marked
  superseded; it retires as soon as nothing is open on its credit pool and collateral vault, which
  can be the same day. The apps read addresses from the live record only.

## Before you start

**When.** Any time. Every carried contract answers to the 48-hour timelock the sixth record names,
and `DeployRwa.s.sol` refuses with `WiringFailed registry.admin` in any other state.

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`.

**Keys.** The deploy key and the payer sign from their encrypted keystores, as in
[`MIGRATION.md`](MIGRATION.md): the operations key tooling exports `ETH_PASSWORD` and Foundry reads
the rest. The two signers are the 48-hour timelock's: the `signer-1` and `signer-2` keystores until
`updateSigner` rotates the hardware keys in, hardware wallets after that. The keeper's key is the
keeper service's; its first observations on the new guard come from the service once the record is
live, or from its own keystore before that.

| Key | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | the two deploy scripts; lender of both credit pools; the two records |
| two signers | `roles.timelockSigners` in the record | the wiring batch |
| `payer` | `exampleMandate.principal` in the fifth record, `0x877c349EFb5926082C413833E8055F0991185c61` | the collateral example |
| keeper | `BURSAR_GUARD_KEEPER`, `0x4c55AE3Fd264d9932A673B7CfBF80fCB112679BD` | the first observations on the new guard |

**Balances.** Every key needs ETH for gas. In the fifth set's rehearsal the deploy key used about
13 million gas across its steps, the payer about 5.3 million, the first signer 1.1 million for the
batch's proposal and execution, the second 0.25 million for its approval, and the keeper 0.8
million for its eight observations; the rehearsal of this move prints the figures afresh. At the
0.021 gwei the chain charged when this was written, that is 0.0003 ETH for the deploy key and under
0.0002 ETH for each of the others. The deploy key needs no USDG of its own: the cash it lends to
the new pool is the cash the fifth pool returns. The payer needs nothing but gas: the stock it posts
is the stock the fifth vault returns.

**The shell.** Every command below runs in one shell set up like this. Start it fresh: a shell where
`script/env/local.env` was sourced points the scripts at a local chain.

```sh
cd contracts
source script/env/rhc-mainnet-v6.env        # the figures, BURSAR_RECORD and RHC_RPC_URL
export BURSAR_PREVIOUS_RECORD=deployments/rhc-mainnet-v5.json
export KEYS="$HOME/.config/bursar/keystore"

# Simulates against the live chain and sends nothing. Every check in the script still runs.
simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
# The same run, sent one transaction at a time.
send() { simulate "$@" --broadcast --slow; }
# A governance step from a hardware signer, once the hardware keys have rotated in: the device
# signs each transaction. --trezor for a Trezor, and --mnemonic-derivation-paths when the account
# is not the device's first.
hw() { local script="$1" signer="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --ledger --sender "$signer" --broadcast --slow "$@"; }
# Reads the chain against the record. Needs no key.
verify() { forge script "$@" --rpc-url "$RHC_RPC_URL"; }
# One value from either record, and one from the chain, for the readbacks after each step.
previous() { jq -r "$1" "$BURSAR_PREVIOUS_RECORD"; }
next() { jq -r "$1" "$BURSAR_RECORD"; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }
signer_1="$(next '.roles.timelockSigners[0]')"
signer_2="$(next '.roles.timelockSigners[1]')"
```

`BURSAR_PREVIOUS_RECORD` is the record being replaced. It has to be the one the sixth record names
in `supersedes`, and a script given any other stops with `PreviousRecordMismatch`. Run every `send`
as a `simulate` first, with the same arguments, and read what it prints. The deploy scripts write
the sixth record as they go; a simulation writes nothing.

## Rehearse first

```sh
script/local/rehearse-mainnet.sh
```

It forks mainnet as it stands, reads which timelock administers the carried contracts, and runs
the steps below in order with the same scripts and arguments. Each key signs as itself through the
fork's impersonation, so no keystore is opened and no device is touched; the delays are skipped on
the fork's clock. It picks the one planned record under `deployments/` and the record that one
supersedes, or the pair `BURSAR_REHEARSE_PREVIOUS` and `BURSAR_REHEARSE_NEXT` name, and writes
copies of the two records under `cache/bursar/fork-rhc-mainnet-v6`, building and logging there too,
never where the real run keeps the logs `--resume` reads. It ends by printing the gas each key
used, the records' status and one line saying it passed. Start only when it ends with the fifth
record `retired` and the sixth `live`.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the lane | deploy key | |
| 2. Propose the wiring | two signers of the 48-hour timelock | |
| 3. Move what needs no governance | deploy key, payer, keeper | |
| 4. The wiring lands; the sixth record goes live | a signer of the 48-hour timelock, deploy key | 48 hours after step 2 |
| 5. The fifth record retires | deploy key | once nothing is open on the fifth lane, which can be at once |
| 6. Publish the records and the sources | nobody | after steps 4 and 5 |

Steps 1 and 2 run the same day. Step 3 can run any time before step 4, and running it the day of
step 4 keeps the fifth lane whole, cash and collateral example included, for as long as the apps
read the fifth record. `ProposeWiring.s.sol` reads which timelock administers each contract off the
chain and puts each call to it, which is the 48-hour timelock for every target; `NotSigner` names
it when a key is not one of its signers.

### 1. Deploy the lane

From the deploy key, each script followed by its check. Each one reads what the scripts before it
wrote into `deployments/rhc-mainnet-v6.json`, and refuses to run twice.

```sh
send script/DeployRwa.s.sol rh-deployer
verify script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol rh-deployer
verify script/VerifyCollateral.s.sol
```

`DeployRwa.s.sol` finds the asset registry, the treasury park and the USDG adapter in the record,
checks they are the contracts the record implies, and deploys only the price guard, with the keeper
and the guardian named, the stock router and the treasury adapter, built against the carried
registry and park. It does not list the new adapter on the park: that is governance's, in step 2.
`DeployCollateral.s.sol` deploys the credit pool and the vault and binds them.

A check that lists something as **owed** is expected here, and says which step settles it: the park
still lists the fifth set's treasury adapter until step 4, the staking pool's credit manager and
slasher still name the fifth credit pool until step 4, and the new pool holds no cash until step 3.
A **mismatch** is not expected: stop and read it.

### 2. Propose the wiring

One batch, proposed by one signer and approved by the second. Both runs can be repeated: a call
already proposed, approved or applied is skipped.

```sh
send script/ProposeWiring.s.sol signer-1 --sig "propose()"
send script/ProposeWiring.s.sol signer-2 --sig "approve()"
verify script/ProposeWiring.s.sol --sig "status()"
```

The batch is four calls on the 48-hour timelock: `Staking.setCreditManager` and
`Staking.setSlasher`, both to the new credit pool, and `TreasuryPark.setAdapter` twice, the new
treasury adapter on and the fifth set's off. `status()` shows the buyback's keeper, the three bond
floors and the rebate table as done, and no wind-down: the shielded pool carries over. Note the
time the batch becomes executable, which `status()` prints: step 4 runs from then.

While the batch waits, the new credit pool's spread cannot reach stakers, a write-off on it would
not reach their stake, and the new treasury adapter cannot park. Nothing is lent on the new lane in
that time: its collateral example does not exist until step 3, and draws wait for the guard's first
readings.

### 3. Move what needs no governance

```sh
# Nothing: the escrow carries over. The script says so and sends nothing.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"

# The collateral example's stock out of the fifth vault, back to the payer. The public and
# committed examples carry over and are left as they are; the script names each one it keeps.
send script/MigrateExamples.s.sol payer --sig "drain()"

# The fifth credit pool's cash back to the lender, then lent to the new pool. The first run prints
# the figure; the second takes it.
send script/MigrateCredit.s.sol rh-deployer
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" "$(readback "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)" | cut -d' ' -f1)"

# The new collateral example, with the stock the old one held posted as its collateral.
send script/MigrateExamples.s.sol payer --sig "create()"

# The first observations of each asset's pool on the new guard, from the keeper's key: no other key
# may take them. A draw needs one at least five minutes old, so the same loop runs again five
# minutes later, or the keeper service does once the sixth record is live.
observe() {
  for symbol in SGOV SPY NVDA AAPL; do
    cast send "$(next .rwa.PriceGuard)" "observe(address)" "$(next ".rwa.assets.$symbol.address")" \
      --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/keeper"
  done
}
observe
```

Run the second `fund` only after the first run has printed the cash it returned: the `readback` in
the command reads the fifth pool's cash, which is the figure before the run. Then read each move
back. The comment on each line says what it has to print.

```sh
readback "$(previous .rwa.collateral.CollateralVault)" "collateralOf(address,address)(uint256)" \
  "$(previous .exampleCollateralMandate.address)" "$(previous .rwa.assets.SPY.address)"               # 0
readback "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)"                                   # 0
readback "$(next .rwa.collateral.CreditPool)" "cash()(uint256)"                                       # what the fifth pool returned
readback "$(next .rwa.collateral.CollateralVault)" "collateralOf(address,address)(uint256)" \
  "$(next .exampleCollateralMandate.address)" "$(next .rwa.assets.SPY.address)"                       # what the fifth vault returned
jq -r '.exampleMandate.address, .exampleCommittedMandate.address' "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"   # the same two addresses twice
readback "$(next .rwa.PriceGuard)" "aged(address)((uint48,uint104,uint104))" "$(next .rwa.assets.SPY.address)"   # a reading, once observe has run twice
readback "$(next .rwa.PriceGuard)" "isKeeper(address)(bool)" "$(next .rwa.guardKeeper)"              # true
```

`drain()` withdraws only what the key is the principal of, and names any example it skips. A
collateral example that still owed the fifth pool would have to repay before its stock comes out;
the live one owes nothing. The public example keeps the router it was created with, which prices
through the fifth set's guard; its principal can point it at the new router with `setRouter`
whenever it likes, and nothing in this move depends on it.

Nothing on the new lane can draw until the new guard holds an aged observation of each asset's pool:
a reading the keeper took at least five minutes earlier and at most an hour earlier, and a pending
one that agrees with the feed too. The keeper service observes the guard of the live record, so its
readings on the new guard begin with its first pass after step 4; until then the keystore above
takes them. `observe` refuses `NotKeeper` from any other key.

### 4. The wiring lands; the sixth record goes live

Once the 48 hours have passed:

```sh
send script/ProposeWiring.s.sol signer-1 --sig "execute()"
verify script/VerifyWiring.s.sol

# Marks the sixth record live and the fifth one superseded. Sends nothing.
send script/RetireRecords.s.sol rh-deployer --sig "goLive()"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

```sh
readback "$(next .token.Staking)" "creditManager()(address)"                                        # the new CreditPool
readback "$(next .token.Staking)" "slasher()(address)"                                              # the same
readback "$(next .rwa.TreasuryPark)" "isAdapter(address)(bool)" "$(next .rwa.adapters.SGOV)"        # true
readback "$(next .rwa.TreasuryPark)" "isAdapter(address)(bool)" "$(previous .rwa.adapters.SGOV)"    # false
readback "$(next .privacy.shielded.ShieldedPool)" "dead()(bool)"                                    # false: it carries over
jq -r .status "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"                                            # live, superseded
```

`goLive()` refuses with `NotReadyForLive` until the collateral example exists and the batch has
landed, naming what is missing. It writes the two records and sends no transaction, which is why it
runs with `--broadcast`: a simulation writes nothing. The strict check must end `0 mismatched, 0
owed`. Then publish the two records as step 6 describes, which is what moves the apps.

The timelock keeps a proposal open for 14 days after its delay ends, its grace period, and refuses
it after that. Past it, `propose()` and `approve()` from step 2 put the batch up again, and it waits
out its delay afresh.

### 5. The fifth record retires

As soon as step 4 is done, since nothing on the fifth set unbonds:

```sh
# Stock a write-off seized in the fifth vault, to the lender who carried the loss. Sends nothing
# when nothing was seized.
send script/MigrateCredit.s.sol rh-deployer --sig "claimSeized()"

# Checks that nothing is left open on the fifth lane, then marks the fifth record retired.
send script/RetireRecords.s.sol rh-deployer
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

```sh
readback "$(previous .rwa.collateral.CreditPool)" "totalDebt()(uint256)"                            # 0
readback "$(previous .rwa.collateral.CollateralVault)" "seized(address)(uint256)" "$(previous .rwa.assets.SPY.address)"   # 0
jq -r .status "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"                                            # live, retired
jq -r .retired "$BURSAR_PREVIOUS_RECORD"                                                            # names the lane as checked and the rest as carried over
```

`RetireRecords.s.sol` sends no transaction. It checks the fifth set's credit pool and collateral
vault alone, because its escrow, registries and shielded pool carry over, and stops, naming each
item, while anything is still open there: cash or debt in the pool, or any balance in the vault,
seized by a write-off and not yet claimed or otherwise. A line that still owes the fifth pool holds
the record open until it repays. `BURSAR_FORCE=1` retires the record anyway and lists what was left,
which is the way past a balance nobody can move.

### 6. Publish the records and the sources

After step 4, and again after step 5, commit the two records under `deployments/` and regenerate
the address book the apps and services read, from the repository root:

```sh
pnpm --filter @bursar/core codegen
```

It resolves addresses from the live record only, and keeps the others as history. After step 4,
also write each new contract's verification input and publish its source, as "Source verification"
in [`../README.md`](../README.md) describes:

```sh
node script/verification-inputs.mjs --record deployments/rhc-mainnet-v6.json --prefix v6
node script/verify.mjs --only "$(jq -r 'keys | map(select(startswith("v6-"))) | join(",")' verification/manifest.json)"
```

Six inputs come out: the five new contracts and the collateral example. Everything carried over
keeps the entry an earlier set wrote for it. Then check the live record the way anyone can, with no
key, commit its report under `deployments/checks/` and copy what it read back into the record's
`verifiedOnChain`, as the fifth record carries:

```sh
script/check-live.sh
```

## If a step stops

A refusal stops a step before it sends anything: every check runs in the simulation Forge makes
before it broadcasts. Fix what it names and run the same command again. A step that already landed
says so and sends nothing. A broadcast that stops partway is finished with the same command and
`--resume`, as [`MIGRATION.md`](MIGRATION.md) describes; its table covers every refusal the scripts
share. The ones this move meets on its own:

| It says | What to do |
|---|---|
| `WiringFailed` naming `registry.admin`, `park.admin` or `staking.admin` | The carried contract answers to a timelock the record does not name. The record is wrong, or governance moved since it was written. Nothing was sent. |
| `WiringFailed` naming `registry.<symbol>.feed`, `AssetNotRegistered`, `PoolIdMismatch` | The carried registry does not hold an asset the way the record describes it. The error names the read, the value expected and the value found. |
| `NotSigner` | The key is not a signer of the 48-hour timelock, which the error names. |
| `NotKeeper` | `observe` was sent from a key other than the keeper the record names. |
| `NotReadyForLive` naming `TreasuryPark.isAdapter` | The adapter switch has not landed: step 4 before `goLive()`. |
| `StillOpen` | Something on the fifth lane is still open. The run lists each item above the error. |
