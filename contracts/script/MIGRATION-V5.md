# Moving Bursar to the fifth contract set

This runbook brings the fifth Bursar contract set live on Robinhood Chain. The fifth set is the
fourth with its collateral lane rebuilt after the rescore: a new price guard, stock router, treasury
adapter, credit pool and collateral vault, and everything else carried over at its address. It is
written for the people who hold the keys. Every step is a script in this directory that can be
simulated against the live chain before it sends anything, and the whole sequence has been
rehearsed on a copy of mainnet with the same scripts and arguments, under both governances the
chain can be in.

## What changes

- **Five contracts are new.** `PriceGuard`, which now answers to the timelock and takes
  observations from its keeper alone; `StockSpendRouter` and `RobinhoodStockAdapter`, which hold
  the guard immutably; `CreditPool` and `CollateralVault`, which bind to each other once.
- **Everything else stays where it is.** Governance, the token set, escrow, reputation, the two
  registries, the mandate factory, the asset registry, the treasury park and its USDG adapter,
  committed mandates and shielded settlement, at the same addresses. The shielded pool is not wound
  down. The public and committed example mandates carry over untouched.
- **Governance is the 48-hour timelock.** The record is written for the fourth set as
  [`GOVERNANCE-48H.md`](GOVERNANCE-48H.md) leaves it: the 48-hour timelock administers every
  carried contract and every new one, and the one-hour timelock keeps the escrow's brake. The five
  new contracts answer to the 48-hour timelock from their constructors and never need a handover.
  The move runs either side of that handover's acceptance: after it, the wiring batch waits two
  days on the 48-hour timelock; before it, one hour on the one-hour timelock, as "Running before
  the handover lands" describes.
- **One governance batch rewires the carried contracts to the new lane.** The staking pool's
  credit manager and slasher move to the new credit pool, and the treasury park lists the new
  treasury adapter and drops the previous one. A position parked through the previous adapter can
  still be unparked afterwards; new parks go through the new adapter.
- **Money the fourth lane holds moves to the fifth:** the credit pool's lending cash, and the stock
  the collateral example posted, which comes out of the fourth vault and into the fifth under a new
  collateral example. The fourth escrow, registries and shielded pool have nothing to move.
- **The apps move two days after the wiring is proposed.** The new record is marked live as soon as
  the batch has landed and the collateral example exists, and the fourth record is marked
  superseded; it retires as soon as nothing is open on its credit pool and collateral vault, which
  can be the same day. The apps read addresses from the live record only.

## Before you start

**When.** After step 3 of [`GOVERNANCE-48H.md`](GOVERNANCE-48H.md) at the earliest: the old
timelock's offers have executed, so every carried contract names the 48-hour timelock as its
pending admin, which is the timelock the fifth record names. Before step 5 of that runbook the
carried contracts still answer to the one-hour timelock, and the move runs as "Running before the
handover lands" describes; after it, as the steps below are written. `DeployRwa.s.sol` refuses with
`WiringFailed registry.admin` in any other state.

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`.

**Keys.** The deploy key and the payer sign from their encrypted keystores, as in
[`MIGRATION.md`](MIGRATION.md): the operations key tooling exports `ETH_PASSWORD` and Foundry reads
the rest. The two signers are hardware wallets, the 48-hour timelock's. The keeper's key is the
keeper service's; its observations run from the service once it is pointed at the new guard, or from
its own keystore before that.

| Key | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | the two deploy scripts; lender of both credit pools; the two records |
| two hardware signers | `roles.timelockSigners` in the record | the wiring batch |
| `payer` | `exampleMandate.principal` in the fourth record, `0x877c349EFb5926082C413833E8055F0991185c61` | the collateral example |
| keeper | `BURSAR_GUARD_KEEPER`, `0x4c55AE3Fd264d9932A673B7CfBF80fCB112679BD` | the first observations on the new guard |

**Balances.** Every key needs ETH for gas. In the rehearsal the deploy key used about 13 million
gas across its steps, the payer about 5.3 million, the first hardware signer 1.1 million for the
batch's proposal and execution, the second 0.25 million for its approval, and the keeper 0.8
million for its eight observations. At the 0.021 gwei the chain charged when this was written, that
is 0.0003 ETH for the deploy key and under 0.0002 ETH for each of the others. The deploy key needs
no USDG of its own: the cash it lends to the new pool is the cash the fourth pool returns. The payer
needs nothing but gas: the stock it posts is the stock the fourth vault returns.

**The shell.** Every command below runs in one shell set up like this. Start it fresh: a shell where
`script/env/local.env` was sourced points the scripts at a local chain.

```sh
cd contracts
source script/env/rhc-mainnet-v5.env        # the figures, BURSAR_RECORD and RHC_RPC_URL
export BURSAR_PREVIOUS_RECORD=deployments/rhc-mainnet-v4.json
export KEYS="$HOME/.config/bursar/keystore"

# Simulates against the live chain and sends nothing. Every check in the script still runs.
simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
# The same run, sent one transaction at a time.
send() { simulate "$@" --broadcast --slow; }
# A governance step from a hardware signer: the device signs each transaction. --trezor for a Trezor,
# and --mnemonic-derivation-paths when the account is not the device's first.
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

`BURSAR_PREVIOUS_RECORD` is the record being replaced. It has to be the one the fifth record names
in `supersedes`, and a script given any other stops with `PreviousRecordMismatch`. Run every `send`
as a `simulate` first, with the same arguments, and read what it prints. The deploy scripts write
the fifth record as they go; a simulation writes nothing.

## Rehearse first

```sh
BURSAR_HANDOVER_LANDED=1 script/local/rehearse-mainnet.sh
```

It forks mainnet as it stands, lands the governance handover on the fork when the chain has not
landed it yet, and runs the steps below in order with the same scripts and arguments. Each key signs
as itself through the fork's impersonation, so no keystore is opened and no device is touched; the
delays are skipped on the fork's clock. It writes copies of the two records under `cache/bursar/fork`
and builds and logs there too, never where the real run keeps the logs `--resume` reads. It ends by
printing the gas each key used, the records' status and one line saying it passed. Start only when it
ends with the fourth record `retired` and the fifth `live`. Without `BURSAR_HANDOVER_LANDED` it runs
the same move under the one-hour timelock, as the chain stands today, which is how the scripts were
checked before the handover landed.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the lane | deploy key | |
| 2. Propose the wiring | two signers of the governing timelock | |
| 3. Move what needs no governance | deploy key, payer, keeper | |
| 4. The wiring lands; the fifth record goes live | a signer of the governing timelock, deploy key | the governing timelock's delay after step 2: 48 hours, or one hour before the handover lands |
| 5. The fourth record retires | deploy key | once nothing is open on the fourth lane, which can be at once |
| 6. Publish the records and the sources | nobody | after steps 4 and 5 |

The governing timelock is the one that administers the carried contracts today, which
`ProposeWiring.s.sol` reads off the chain: the 48-hour timelock once the handover has landed, whose
signers are the hardware keys, and the one-hour timelock before, whose signers are the `signer-1`
and `signer-2` keystores.

### 1. Deploy the lane

From the deploy key, each script followed by its check. Each one reads what the scripts before it
wrote into `deployments/rhc-mainnet-v5.json`, and refuses to run twice.

```sh
send script/DeployRwa.s.sol rh-deployer
verify script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol rh-deployer
verify script/VerifyCollateral.s.sol
```

`DeployRwa.s.sol` finds the asset registry, the treasury park and the USDG adapter in the record,
checks they are the contracts the record implies, and deploys only the price guard, with the keeper
named, the stock router and the treasury adapter, built against the carried registry and park. It
does not list the new adapter on the park: that is governance's, in step 2. `DeployCollateral.s.sol`
deploys the credit pool and the vault and binds them.

A check that lists something as **owed** is expected here, and says which step settles it: the park
still lists the fourth set's treasury adapter until step 4, the staking pool's credit manager and
slasher still name the fourth credit pool until step 4, and the new pool holds no cash until step 3.
A **mismatch** is not expected: stop and read it.

### 2. Propose the wiring

One batch, proposed by one hardware signer and approved by the second. Both runs can be repeated: a
call already proposed, approved or applied is skipped.

```sh
hw script/ProposeWiring.s.sol "$signer_1" --sig "propose()"
hw script/ProposeWiring.s.sol "$signer_2" --sig "approve()"
verify script/ProposeWiring.s.sol --sig "status()"
```

The batch is four calls on the governing timelock: `Staking.setCreditManager` and
`Staking.setSlasher`, both to the new credit pool, and `TreasuryPark.setAdapter` twice, the new
treasury adapter on and the fourth set's off. `status()` shows the buyback's keeper, the three bond
floors and the rebate table as done, and no wind-down: the shielded pool carries over. The script
reads which timelock administers each contract off the chain and puts each call to it, so a batch
proposed to the wrong governance cannot happen; `NotSigner` names the timelock whose signer the key
is not.

While the batch waits, the new credit pool's spread cannot reach stakers, a write-off on it would
not reach their stake, and the new treasury adapter cannot park. The collateral example created in
step 3 draws nothing, so nothing is lent in that time.

### 3. Move what needs no governance

```sh
# Nothing: the escrow carries over. The script says so and sends nothing.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"

# The collateral example's stock out of the fourth vault, back to the payer. The public and
# committed examples carry over and are left as they are; the script names each one it keeps.
send script/MigrateExamples.s.sol payer --sig "drain()"

# The fourth credit pool's cash back to the lender, then lent to the new pool. The first run prints
# the figure; the second takes it.
send script/MigrateCredit.s.sol rh-deployer
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" "$(readback "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)" | cut -d' ' -f1)"

# The new collateral example, with the stock the old one held posted as its collateral.
send script/MigrateExamples.s.sol payer --sig "create()"

# The first observations of each asset's pool on the new guard, from the keeper's key: no other key
# may take them. A draw needs one at least five minutes old, so the same loop runs again five
# minutes later, or the keeper service does once it is pointed at the new guard.
observe() {
  for symbol in SGOV SPY NVDA AAPL; do
    cast send "$(next .rwa.PriceGuard)" "observe(address)" "$(next ".rwa.assets.$symbol.address")" \
      --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/keeper"
  done
}
observe
```

Run the second `fund` only after the first run has printed the cash it returned: the `readback` in
the command reads the fourth pool's cash, which is the figure before the run. Then read each move
back. The comment on each line says what it has to print.

```sh
readback "$(previous .rwa.collateral.CollateralVault)" "collateralOf(address,address)(uint256)" \
  "$(previous .exampleCollateralMandate.address)" "$(previous .rwa.assets.SPY.address)"               # 0
readback "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)"                                   # 0
readback "$(next .rwa.collateral.CreditPool)" "cash()(uint256)"                                       # what the fourth pool returned
readback "$(next .rwa.collateral.CollateralVault)" "collateralOf(address,address)(uint256)" \
  "$(next .exampleCollateralMandate.address)" "$(next .rwa.assets.SPY.address)"                       # what the fourth vault returned
jq -r '.exampleMandate.address, .exampleCommittedMandate.address' "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"   # the same two addresses twice
readback "$(next .rwa.PriceGuard)" "aged(address)((uint48,uint64,uint64))" "$(next .rwa.assets.SPY.address)"   # a reading, once observe has run twice
```

`drain()` withdraws only what the key is the principal of, and names any example it skips. A
collateral example that still owed the fourth pool would have to repay before its stock comes out;
the live one owes nothing. The public example keeps the router it was created with, which prices
through the fourth set's guard; its principal can point it at the new router with `setRouter`
whenever it likes, and nothing in this move depends on it.

Nothing on the new lane can draw until the new guard holds an aged observation of each asset's pool:
a reading the keeper took at least five minutes earlier and at most an hour earlier. The keeper
service has to be pointed at the new guard before the apps move, as its own runbook describes.
`observe` refuses `NotKeeper` from any other key.

### 4. The wiring lands; the fifth record goes live

Once the governing timelock's delay has passed:

```sh
hw script/ProposeWiring.s.sol "$signer_1" --sig "execute()"
verify script/VerifyWiring.s.sol

# Marks the fifth record live and the fourth one superseded. Sends nothing.
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

### 5. The fourth record retires

As soon as step 4 is done, since nothing on the fourth set unbonds:

```sh
# Stock a write-off seized in the fourth vault, to the lender who carried the loss. Sends nothing
# when nothing was seized.
send script/MigrateCredit.s.sol rh-deployer --sig "claimSeized()"

# Checks that nothing is left open on the fourth lane, then marks the fourth record retired.
send script/RetireRecords.s.sol rh-deployer
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

```sh
readback "$(previous .rwa.collateral.CreditPool)" "totalDebt()(uint256)"                            # 0
readback "$(previous .rwa.collateral.CollateralVault)" "seized(address)(uint256)" "$(previous .rwa.assets.SPY.address)"   # 0
jq -r .status "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"                                            # live, retired
jq -r .retired "$BURSAR_PREVIOUS_RECORD"                                                            # names the lane as checked and the rest as carried over
```

`RetireRecords.s.sol` sends no transaction. It checks the fourth set's credit pool and collateral
vault alone, because its escrow, registries and shielded pool carry over, and stops, naming each
item, while anything is still open there: cash or debt in the pool, or any balance in the vault,
seized by a write-off and not yet claimed or otherwise. A line that still owes the fourth pool holds
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
node script/verification-inputs.mjs --record deployments/rhc-mainnet-v5.json --prefix v5
node script/verify.mjs --only "$(jq -r 'keys | map(select(startswith("v5-"))) | join(",")' verification/manifest.json)"
```

Six inputs come out: the five new contracts and the collateral example. Everything carried over
keeps the entry an earlier set wrote for it. Then check the live record the way anyone can, with no
key:

```sh
script/check-live.sh
```

## Running before the handover lands

The fourth set's offers have executed, and the 48-hour timelock's acceptances wait out their delay
until 2026-10-05 00:57 UTC. The move can run in that window. Everything above holds, with these
differences.

**The carried registry, park and staking pool still answer to the one-hour timelock,** with the
48-hour one pending. `DeployRwa.s.sol` and `DeployCollateral.s.sol` print one line each saying so
and go on; `WiringFailed` means some other state. The guard, the router, the adapter, the credit
pool and the vault are born under the 48-hour timelock, the record's, and never need a handover.

**The wiring batch goes to the one-hour timelock,** which administers the staking pool and the park
today, from the `signer-1` and `signer-2` keystores. A hardware key meets `NotSigner`, naming the
one-hour timelock.

```sh
# Step 2
send script/ProposeWiring.s.sol signer-1 --sig "propose()"
send script/ProposeWiring.s.sol signer-2 --sig "approve()"
verify script/ProposeWiring.s.sol --sig "status()"

# Step 4, one hour later
send script/ProposeWiring.s.sol signer-1 --sig "execute()"
verify script/VerifyWiring.s.sol
send script/RetireRecords.s.sol rh-deployer --sig "goLive()"
verify script/Verify.s.sol
```

**The checks owe the acceptances.** Each check lists the pending acceptance of every carried
contract it reads as owed, `<contract>.admin is still the previous timelock: the 48-hour timelock's
acceptance lands the handover`, and `VerifyToken.s.sol` and `VerifyStaking.s.sol` say the same of
the vesting contract and the seeder in their own words. The whole check in steps 4 and 5 therefore
runs without `BURSAR_VERIFY_STRICT`, and must end `0 mismatched, 10 owed`: Reputation,
OracleRegistry, AgentRegistry, Vesting, Staking, Buyback, the seeder's owner, AssetRegistry,
TreasuryPark and SolvencyLog, and nothing else. `check-live.sh` reports FAIL on those ten lines
until the acceptances execute, and PASS afterwards.

**Step 5 runs the same day.** Nothing on the fourth lane unbonds: its cash came back to the lender
and its collateral example's stock came out of its vault in step 3, and `RetireRecords.s.sol`
retires the fourth record as soon as that pool holds no cash or debt and that vault no balance. A
line still drawn on the fourth pool is the one thing that holds it open.

**`GOVERNANCE-48H.md` steps 5 and 6 run unchanged on 2026-10-05.** The acceptances take every
carried contract. Two of them, #7 and #8, take the fourth set's credit pool and collateral vault,
retired by then: `acceptAdmin` changes their admin and nothing else, on contracts that hold
nothing. `finish()` reads the fourth record, checks those contracts among the rest and rewrites that
record's governance; it never reads the fifth, which names the 48-hour timelock already. Run it as
that runbook says, in a shell where `script/env/rhc-mainnet-v4.env` is sourced.

## If a step stops

A refusal stops a step before it sends anything: every check runs in the simulation Forge makes
before it broadcasts. Fix what it names and run the same command again. A step that already landed
says so and sends nothing. A broadcast that stops partway is finished with the same command and
`--resume`, as [`MIGRATION.md`](MIGRATION.md) describes; its table covers every refusal the scripts
share. The ones this move meets on its own:

| It says | What to do |
|---|---|
| `WiringFailed` naming `registry.admin`, `park.admin` or `staking.admin` | The carried contract answers to a timelock the record does not name: neither the record's, nor the one it replaces with the record's pending. The offers of `GOVERNANCE-48H.md` have not executed, or the record is wrong. Nothing was sent. |
| `WiringFailed` naming `registry.<symbol>.feed`, `AssetNotRegistered`, `PoolIdMismatch` | The carried registry does not hold an asset the way the record describes it. The error names the read, the value expected and the value found. |
| `NotSigner` | The key is not a signer of the timelock the error names, which is the one administering the contract today: a hardware signer for the 48-hour timelock, never one of the old keystores. |
| `NotKeeper` | `observe` was sent from a key other than the keeper the record names. |
| `NotReadyForLive` naming `TreasuryPark.isAdapter` | The adapter switch has not landed: step 4 before `goLive()`. |
| `StillOpen` | Something on the fourth lane is still open. The run lists each item above the error. |
