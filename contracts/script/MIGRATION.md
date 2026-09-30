# Moving Bursar to the new contract set

This runbook brings the new Bursar contract set live on Robinhood Chain and moves everything the
current sets hold into it. It is written for the people who hold the keys. Every step is a script
in this directory, every script can be simulated against the live chain before it sends anything,
and the whole sequence has been rehearsed on a copy of mainnet with the same commands.

## What changes, in plain terms

- **A new contract set goes live next to the current ones.** BRSR and the team's vesting schedule
  stay exactly as they are. Every other contract is new: governance, escrow, reputation, the
  resolver and agent registries, the mandate factory, staking and the buyback, the RWA and
  collateral lanes, committed mandates and shielded settlement.
- **Payments already open settle where they were opened.** Nothing reaches into an open payment. A
  payment whose deadline passes with no delivery is returned to its payer, as it always would be.
- **The BRSR/USDG market keeps its price.** The liquidity that makes it moves, in one sequence,
  into a position governance owns.
- **Money the current sets hold moves to the new one:** the credit pool's lending cash, the
  resolvers' bonds, the registered payee's stake and the public example mandates.
- **One timelock governs everything.** The vesting contract and the community allocation move from
  the first deployment's timelock to the new one.
- **Stakers take their stake out of the current staking pool themselves.** It takes seven days, and
  the stake can go into the new pool afterwards.
- **At the end, the earlier deployment records are marked retired** and the new one is marked
  live. The apps read addresses from the live record only.

## Before you start

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`.

**Keys.** Each key signs from its own encrypted keystore. None is ever typed, and no private key
appears in a command, a variable or a file. The operations key tooling (`ops/rhc-env.sh` in the
operations repository) exports `ETH_PASSWORD`, the path of a short-lived file holding the keystore
password, and Foundry reads it on its own.

| Keystore | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | every deploy script; lender of both credit pools; the payee's new stake; the old escrows' settlement, the old shielded pool's handover and the records' retirement |
| `signer-1`, `signer-2` | `roles.timelockSigners` in the record | proposals and approvals on both timelocks |
| `brsr-liquidity` | `roles.liquidity` | the move of the BRSR/USDG position |
| `treasury` | `roles.treasury` | the BRSR each resolver bonds |
| `resolver-1` to `resolver-3` | `roles.resolvers` | each resolver's own bond |
| `payee` | `BURSAR_EXAMPLE_PAYEE` | the payee's registration |
| `payer` | principal of the example mandates | the example mandates, and its own stake |

**Balances.** Every key above needs ETH for gas. In the rehearsal the deploy key spent about 53
million gas across all its steps, the payer about 11 million, the first signer about 3 million and
every other key under 1 million. At the 0.025 gwei the chain charged when this was written, that is
0.0013 ETH for the deploy key and well under 0.001 ETH for each of the others. The treasury needs
90,000 BRSR for the three new bonds and gets 150,000 back a week later, when the six old bonds
mature. The payee needs 5 USDG, the new agent registry's minimum stake: step 3 sends it from the
credit pool's returned cash, and its two old stakes, 10 USDG, come back a week later.

**The shell.** Every command below runs in one shell set up like this:

```sh
cd contracts
source script/env/rhc-mainnet-v3.env        # the figures, and BURSAR_RECORD
export BURSAR_V1_RECORD=deployments/rhc-mainnet.json
export BURSAR_V2_RECORD=deployments/rhc-mainnet-v2.json
export BURSAR_TOKEN_RECORD=deployments/rhc-mainnet-token.json
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance   # the signer set is three plain keys
export KEYS="$HOME/.config/bursar/keystore"

# Simulates against the live chain and sends nothing. Every check in the script still runs.
simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
# The same run, sent one transaction at a time.
send() { simulate "$@" --broadcast --slow; }
# Reads the chain against the record. Needs no key.
verify() { forge script "$@" --rpc-url "$RHC_RPC_URL"; }
```

Run every `send` as a `simulate` first, with the same arguments, and read what it prints. The
deploy scripts write the new record as they go; a simulation writes nothing.

## Rehearse first

```sh
script/local/rehearse-mainnet.sh
```

It forks mainnet as it stands and runs every step below, in this order, with these commands. Each
key signs as itself through the fork's impersonation, so no key is read, and the delays are skipped
on the fork's clock. It writes copies of the four records under `cache/bursar/fork` and ends by
printing their status. Start only when it ends with the earlier records `retired` and the new one
`live`. If the chain has moved since, run it again.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the new set | deploy key | |
| 2. Propose the wiring and the handover | signer 1, signer 2 | |
| 3. Move what needs no governance | deploy key, payer, payee, liquidity key | |
| 4. The wiring lands; resolvers bond | any signer, treasury, resolvers, payer | one hour after step 2 |
| 5. The handover lands | any signer | 48 hours after step 2 |
| 6. Old bonds and stakes come back; the old records retire | payer, resolvers, payee, deploy key | seven days after step 4 |

### 1. Deploy the new set

From the deploy key, each script followed by its check. Each one reads what the scripts before it
wrote into `deployments/rhc-mainnet-v3.json`, and refuses to run twice.

```sh
send script/Deploy.s.sol rh-deployer
verify script/VerifyCore.s.sol
send script/DeployStaking.s.sol rh-deployer
verify script/VerifyStaking.s.sol
send script/DeployRwa.s.sol rh-deployer
verify script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol rh-deployer
verify script/VerifyCollateral.s.sol
send script/DeployPrivacy.s.sol rh-deployer
verify script/VerifyPrivacy.s.sol
send script/DeployShielded.s.sol rh-deployer \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
verify script/VerifyShielded.s.sol
```

`DeployToken.s.sol` is not run: the record already names BRSR and its vesting contract, and the
script refuses to mint a second supply. A check that lists something as **owed** is expected at
this point, and says which later step settles it. A **mismatch** is not: stop and read it.

### 2. Propose the wiring and the handover

Two batches, each proposed by one signer and approved by a second. Both can be run again: a call
already proposed, approved or applied is skipped.

```sh
send script/ProposeWiring.s.sol signer-1 --sig "propose()"
send script/ProposeWiring.s.sol signer-2 --sig "approve()"
send script/MigrateGovernance.s.sol signer-1 --sig "propose()"
send script/MigrateGovernance.s.sol signer-2 --sig "approve()"
```

The wiring names the buyback's keeper, each vetted resolver's bond floor, the staking rebate table,
and the credit pool's two roles on the staking pool. The handover moves the vesting contract and the
community allocation from the first deployment's timelock to the new one; its first two calls wait
out that timelock's 48 hours, and the new timelock's acceptance waits for them. To see where each
call stands:

```sh
verify script/ProposeWiring.s.sol --sig "status()"
verify script/MigrateGovernance.s.sol --sig "status()"
```

### 3. Move what needs no governance

```sh
# Closes what anyone may close on the old escrows: every payment past its deadline back to its
# payer, and the fees they booked to their treasury.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"

# The example mandates: parked treasury fund sold back to USDG, collateral out of the old vault,
# every balance back to the principal.
send script/MigrateExamples.s.sol payer --sig "drain()"

# The credit pool's cash back to the lender, then lent to the new pool.
send script/MigrateCredit.s.sol rh-deployer
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" 25000000

# The payee's stake on the new agent registry, then its registration there.
cast send "$(jq -r .settlementAsset "$BURSAR_RECORD")" "transfer(address,uint256)" "$BURSAR_EXAMPLE_PAYEE" 5000000 \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
send script/MigratePayee.s.sol payee

# The BRSR/USDG position, out of the old seeder and into governance's.
BURSAR_ALLOW_MAINNET_SEED=i-am-moving-the-market simulate script/MigrateLiquidity.s.sol brsr-liquidity --broadcast

# The payer's own stake on the old staking pool. Other stakers do this in the console.
send script/MigrateStake.s.sol payer --sig "leave()"

# The old shielded pool stops taking deposits, and its owner role goes to the new timelock.
send script/MigrateGovernance.s.sol rh-deployer --sig "retireShielded()"
```

`MigrateLiquidity.s.sol` runs without `--slow` on purpose: the removal and the add go out back to
back, so nothing can trade between them. It plans the add at the price the pool stands at and
refuses to pay more of either token than that price asks for. With `BURSAR_SEED_PRICE_MICRO_USD`
set, it also refuses a pool further than one percent from that price.

`MigratePayee.s.sol` also asks both old agent registries for the payee's stake back.
`MigrateStake.s.sol leave()` asks the old pool for the whole position back, replacing any request
already open for part of it.

`retireShielded()` refuses while the old shielded pool still holds notes. Every note can still be
withdrawn after the pool stops taking deposits.

### 4. The wiring lands; resolvers bond

One hour after step 2:

```sh
send script/ProposeWiring.s.sol signer-1 --sig "execute()"
verify script/VerifyWiring.s.sol

# Each resolver's new bond, from the treasury, then bonded by the resolver itself. Bonding also
# asks both old registries for the old bond back.
send script/MigrateResolvers.s.sol treasury --sig "fund()"
send script/MigrateResolvers.s.sol resolver-1 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-2 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-3 --sig "bond()"

# New example mandates: one that pays the payee and may buy stocks, and one on the collateral lane
# with the stock the old one held posted as collateral.
send script/MigrateExamples.s.sol payer --sig "create()"
```

Until the wiring lands no resolver can bond: the floor for anyone without one of their own is more
BRSR than exists. The committed example mandate is created only when its sealed terms are supplied
from the console as `BURSAR_COMMITTED_TERMS`, `BURSAR_COMMITTED_COUNTER` and
`BURSAR_COMMITTED_CIPHERTEXT`; without them `create()` says so and skips it.

### 5. The handover lands

48 hours after step 2:

```sh
send script/MigrateGovernance.s.sol signer-1 --sig "execute()"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

`execute()` runs the two calls on the first deployment's timelock and then the new timelock's
acceptance, in one run. The strict check must end `0 mismatched, 0 owed`. The buyback's price
ceiling is trusted for seven days after governance sets it; `DeployStaking.s.sol` set it in step 1,
so from day seven the check lists it as owed until governance restates it with `Buyback.setParams`.

### 6. Old bonds and stakes come back; the old records retire

Seven days after step 4:

```sh
send script/MigrateStake.s.sol payer --sig "complete()"
send script/MigrateResolvers.s.sol resolver-1 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-2 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-3 --sig "reclaim()"
send script/MigratePayee.s.sol payee --sig "reclaim()"

# Anything that expired on the old escrows since step 3, and whatever it returned to the examples.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"
send script/MigrateExamples.s.sol payer --sig "drain()"

# Checks that nothing is left open, then marks the earlier records retired and the new one live.
send script/RetireRecords.s.sol rh-deployer
```

`RetireRecords.s.sol` sends no transaction. It writes the four records, which is why it runs with
`--broadcast`: a simulation writes nothing. It stops, naming each item, while anything is still
open: a payment on an old escrow that is locked, disputed or still inside its dispute window, USDG
left in an old escrow, cash or debt in the old credit pool, collateral in the old vault, liquidity
in the old seeder, stake in the old staking pool, USDG in the old buyback, notes in the old
shielded pool, or a vesting contract that does not answer to the new timelock yet.
`BURSAR_FORCE=1` retires the records anyway and lists what was left.

### 7. Publish the records and the sources

Commit the four records under `deployments/`. Then regenerate the address book the apps and
services read, from the repository root:

```sh
pnpm --filter @bursar/core codegen
```

It resolves addresses from the live record only, and keeps the retired ones as history. Publish
each new contract's source on the explorer as "Source verification" in
[`../README.md`](../README.md) describes, so anyone can check the code behind every address in the
record.

## If a step stops

A refusal stops a step before it sends anything: every check runs in the simulation Forge makes
before it broadcasts. Fix what it names and run the same command again. A step that already landed
says so and sends nothing.

A broadcast that stops partway, on a dropped connection or a key that ran out of gas, is finished
with the same command and `--resume`: Forge sends the transactions that did not land, from its own
log, to the addresses the record already names.

| It says | What to do |
|---|---|
| `AlreadyRecorded` | The record already names that contract. The step ran before; go on to the next one. |
| `WrongDeployer` | The run is signing with a key other than the record's deploy key. |
| `RecordMismatch` | The shell names an address the record disagrees with. Unset the variable, or correct whichever of the two is wrong. |
| `NotSigner` | The keystore is not one of the timelock's signers. |
| `NotTheKey` | The step has to be signed by the key it names: the lender, or the owner of the old seeder. |
| `not executable yet` | The timelock's delay has not passed. Wait, and run `execute()` again. |
| `not matured yet` | An old bond, stake or withdrawal is still unbonding. Run the same step again on the date it prints. |
| `StillOpen` | Something on the old sets is still open. The run lists each item above the error. |
| `VerificationFailed` | A check found a mismatch, or, under `BURSAR_VERIFY_STRICT=1`, something still owed. Each one is listed above the error. |
