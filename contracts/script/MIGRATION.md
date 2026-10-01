# Moving Bursar to the fourth contract set

This runbook brings the fourth Bursar contract set live on Robinhood Chain and moves what the third
set holds into it. It is written for the people who hold the keys. Every step is a script in this
directory that can be simulated against the live chain before it sends anything, and the whole
sequence has been rehearsed on a copy of mainnet with the same scripts and arguments.

## What changes

- **Governance and the token set stay where they are.** The timelock, BRSR, the team's vesting
  schedule, the staking pool, the buyback and the seeder that holds the BRSR/USDG position are the
  contracts in use today, at the same addresses. No stake moves, the market is not touched, and
  the signers, the guardian and the treasury are the same.
- **Every other contract is new,** rebuilt after the external audit: escrow, reputation, the
  resolver and agent registries, the mandate factory, the RWA and collateral lanes, committed
  mandates and shielded settlement.
- **Payments already open settle where they were opened.** Nothing reaches into an open payment. A
  payment whose deadline passes with no delivery is returned to its payer, as it always would be.
- **Money the third set holds moves to the fourth:** the credit pool's lending cash, the
  resolvers' bonds, the registered payee's stake and the three public example mandates.
- **The staking pool answers to the new credit pool.** One governance batch moves the credit
  pool's two roles on the staking pool, and winds the third set's shielded pool down: it takes no
  new deposit, and every note in it stays withdrawable.
- **The apps move an hour after the wiring is proposed.** The new record is marked live as soon as
  its examples exist and the batch has landed, and the third record is marked superseded. A week
  later, once nothing is open on it, the third record is marked retired. The apps read addresses
  from the live record only.

## Before you start

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`. The committed example mandate in step 3
also needs Node 22 and the SDK, built once from the repository root, with the workspace packages
it imports, by `pnpm install && pnpm --filter "@bursar/sdk..." build`.

**Keys.** Each key signs from its own encrypted keystore. None is ever typed, and no private key
appears in a command, a variable or a file. The operations key tooling (`ops/rhc-env.sh` in the
operations repository) exports `ETH_PASSWORD`, the path of a short-lived file holding the keystore
password, and Foundry reads it on its own.

| Keystore | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | every deploy script; lender of both credit pools; the payee's new stake; the previous escrow's settlement; the two records |
| `signer-1`, `signer-2` | `roles.timelockSigners` in the record | the wiring batch |
| `treasury` | `roles.treasury` | the BRSR each resolver bonds |
| `resolver-1` to `resolver-3` | `roles.resolvers` | each resolver's own bond |
| `payee` | `BURSAR_EXAMPLE_PAYEE` | the payee's registration |
| `payer` | `exampleMandate.principal` in the third record, `0x877c349EFb5926082C413833E8055F0991185c61` | the example mandates |

Every address in the table can be read from a record or the parameter file:

```sh
jq -r .deployer deployments/rhc-mainnet-v4.json                    # rh-deployer
jq -r '.roles.timelockSigners[]' deployments/rhc-mainnet-v4.json   # the three signers
jq -r .roles.treasury deployments/rhc-mainnet-v4.json              # treasury
jq -r '.roles.resolvers[]' deployments/rhc-mainnet-v4.json         # resolver-1 to resolver-3
jq -r .exampleMandate.principal deployments/rhc-mainnet-v3.json    # payer
grep BURSAR_EXAMPLE_PAYEE script/env/rhc-mainnet-v4.env            # payee
```

**Balances.** Every key above needs ETH for gas. In the rehearsal the deploy key used about 43
million gas across all its steps, the payer about 10 million, and every other key under 1 million.
At the 0.021 gwei the chain charged when this was written, that is 0.0009 ETH for the deploy key
and 0.0002 ETH for the payer. The deploy key also needs at least 1 USDG before step 1:
`Deploy.s.sol` refuses to run with less, as proof that the record's settlement asset is the USDG
the set will settle in, and spends none of it. The treasury needs 90,000 BRSR for the three new
bonds and gets 90,000 back a week later, when the old bonds mature.

The payee needs 5 USDG, the new agent registry's minimum stake, a week before its old stake comes
back. The lender bridges it out of the cash the third credit pool returns: of those 25 USDG, step 3
lends 20 to the new pool and sends 5 to the payee, and step 5 lends the last 5 once the payee has
its old stake back and has returned them. The payer funds the new examples with the 0.25 USDG the
old ones return.

**The shell.** Every command below runs in one shell set up like this. Start it fresh: a shell
where `script/env/local.env` was sourced points the scripts at a local chain.

```sh
cd contracts
source script/env/rhc-mainnet-v4.env        # the figures, BURSAR_RECORD and RHC_RPC_URL
export BURSAR_PREVIOUS_RECORD=deployments/rhc-mainnet-v3.json
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance   # the signer set is three plain keys
export KEYS="$HOME/.config/bursar/keystore"
export PAYER="$(jq -r .exampleMandate.principal "$BURSAR_PREVIOUS_RECORD")"

# Simulates against the live chain and sends nothing. Every check in the script still runs.
simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
# The same run, sent one transaction at a time.
send() { simulate "$@" --broadcast --slow; }
# Reads the chain against the record. Needs no key.
verify() { forge script "$@" --rpc-url "$RHC_RPC_URL"; }
# One value from either record, and one from the chain, for the readbacks after each step.
previous() { jq -r "$1" "$BURSAR_PREVIOUS_RECORD"; }
next() { jq -r "$1" "$BURSAR_RECORD"; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }
usdg="$(next .settlementAsset)"
```

`RHC_RPC_URL` is Robinhood Chain's public endpoint unless the shell already names another.
`BURSAR_PREVIOUS_RECORD` is the record being replaced. It has to be the one the new record names in
`supersedes`, and a script given any other stops with `PreviousRecordMismatch`. Run every `send` as
a `simulate` first, with the same arguments, and read what it prints. The deploy scripts write the
new record as they go; a simulation writes nothing.

**Check every keystore once.** The rehearsal below signs through the fork's impersonation and
never opens a keystore, so the keystores are first used by the real run. Before step 1, open each
one and sign with it, sending nothing:

```sh
key=rh-deployer                       # then each keystore in the table in turn
address="$(cast wallet address --keystore "$KEYS/$key")" && echo "$address"
signed="$(cast mktx "$address" --value 0 --keystore "$KEYS/$key" --rpc-url "$RHC_RPC_URL")"
cast to-check-sum-address "$(cast decode-transaction "$signed" | jq -r 'fromjson | .signer')"
```

The first address proves the password file opens the keystore, and has to be the one the table
gives for it. The second is who signed a transaction built for Robinhood Chain and never sent, and
has to be the same.

**The third set's own move has a tail.** Its Vesting handover is proposed on both timelocks and
lands from that move's runbook, 48 hours after it was proposed. Nothing here depends on it, and
steps 1 to 3 can run while it waits. Until it lands, `VerifyToken.s.sol` lists `Vesting.admin` as
owed, and the strict checks in steps 4 and 5 fail on it. That move's last step writes `live` into
its own copy of the third record: when both land in the repository, the third record keeps the
status this runbook gave it.

## Rehearse first

```sh
script/local/rehearse-mainnet.sh
```

It forks mainnet as it stands and runs the steps below in order, with the same scripts and
arguments. Each key signs as itself through the fork's impersonation, with forge's
`--unlocked --sender` in place of `--keystore`, so no keystore is opened and no key is read, which
is why each keystore is checked on its own above. The delays are skipped on the fork's clock, the
Vesting handover still in flight is landed on the fork the way its own runbook lands it, and the
committed example mandate is left out, because the fork cannot sign as the payer. It writes copies
of the two records under `cache/bursar/fork`, and builds and logs its transactions there too,
never in `out/`, `broadcast/` or `cache/`, where the real run keeps the logs `--resume` reads. It
ends by printing the gas each key used, the records' status and one line saying it passed. Start
only when it ends with the previous record `retired` and the new one `live`. If the chain has
moved since, run it again.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the new set | deploy key | |
| 2. Propose the wiring | signer 1, signer 2 | |
| 3. Move what needs no governance | deploy key, payer, payee, treasury, resolvers | |
| 4. The wiring lands; the new record goes live | any signer, deploy key | one hour after step 2 |
| 5. Old bonds and stake come back; the previous record retires | resolvers, payee, deploy key, payer | seven days after step 3 |
| 6. Publish the records and the sources | nobody | after steps 4 and 5 |

### 1. Deploy the new set

From the deploy key, each script followed by its check. Each one reads what the scripts before it
wrote into `deployments/rhc-mainnet-v4.json`, and refuses to run twice.

```sh
send script/Deploy.s.sol rh-deployer
verify script/VerifyCore.s.sol
verify script/VerifyToken.s.sol
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

`Deploy.s.sol` joins the timelock the record names and deploys no second one. It finds the staking
pool in the record too, and names it on the new resolver registry, so resolver bonds are in BRSR
from the first block. `DeployToken.s.sol` is not run: the record already names BRSR and its vesting
contract, and the script refuses to mint a second supply.

`DeployStaking.s.sol` deploys nothing and sends nothing. The record carries the staking pool, the
buyback and the seeder over, so the run checks they are the contracts the record implies and writes
the figures they hold into the record's `parameters`, read off the chain. It still takes
`--broadcast`: a simulation writes no file.

A check that lists something as **owed** is expected at this point, and says which later step
settles it: the staking pool's credit manager and slasher still name the third set's credit pool
until step 4, and the new credit pool holds no cash until step 3. A **mismatch** is not expected:
stop and read it.

### 2. Propose the wiring

One batch, proposed by one signer and approved by a second. Both runs can be repeated: a call
already proposed, approved or applied is skipped.

```sh
send script/ProposeWiring.s.sol signer-1 --sig "propose()"
send script/ProposeWiring.s.sol signer-2 --sig "approve()"
verify script/ProposeWiring.s.sol --sig "status()"
```

The batch is three calls: `Staking.setCreditManager` and `Staking.setSlasher`, both to the new
credit pool, and `Entrypoint.windDownPool` on the third set's Entrypoint, whose owner role the
timelock holds. `status()` shows the buyback's keeper, the three bond floors and the rebate table
as done. They were set on the staking pool when the third set went live and carry over with it.

For the hour the batch waits, the new credit pool's spread cannot reach stakers and a write-off on
it would not reach their stake. The examples created in step 3 draw nothing, so nothing is lent in
that hour.

### 3. Move what needs no governance

```sh
# Closes what anyone may close on the previous escrow: every payment past its deadline back to its
# payer, and the fees it booked to its treasury.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"

# The three examples: collateral out of the previous vault, every balance back to the principal.
send script/MigrateExamples.s.sol payer --sig "drain()"

# The credit pool's cash back to the lender. 20 USDG of it is lent to the new pool now, and 5 go
# to the payee for its new stake.
send script/MigrateCredit.s.sol rh-deployer
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" 20000000
cast send "$usdg" "transfer(address,uint256)" "$BURSAR_EXAMPLE_PAYEE" 5000000 \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
send script/MigratePayee.s.sol payee

# Each resolver's new bond, from the treasury, then bonded by the resolver itself. Bonding also
# asks the previous registry for the old bond back.
send script/MigrateResolvers.s.sol treasury --sig "fund()"
send script/MigrateResolvers.s.sol resolver-1 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-2 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-3 --sig "bond()"

# New example mandates: one that pays the payee and may buy stocks, one on the collateral lane
# with the stock the old one held posted as collateral, and a committed one, whose terms the payer
# first seals to its own viewing key.
signature="$(cast wallet sign --keystore "$KEYS/payer" "$(node script/committed-example.mjs message "$PAYER")")"
eval "$(node script/committed-example.mjs terms "$PAYER" "$signature")"
send script/MigrateExamples.s.sol payer --sig "create()"
```

Then read each move back. The comment on each line says what it has to print.

```sh
readback "$(previous .contracts.Escrow)" "feesAccrued()(uint128)"                                     # 0
readback "$usdg" "balanceOf(address)(uint256)" "$(previous .exampleMandate.address)"                  # 0
readback "$usdg" "balanceOf(address)(uint256)" "$(previous .exampleCommittedMandate.address)"         # 0
readback "$(previous .rwa.collateral.CollateralVault)" "collateralOf(address,address)(uint256)" \
  "$(previous .exampleCollateralMandate.address)" "$(previous .rwa.assets.SPY.address)"               # 0
readback "$(previous .rwa.collateral.CreditPool)" "cash()(uint256)"                                   # 0
readback "$(next .rwa.collateral.CreditPool)" "cash()(uint256)"                                       # 20000000
readback "$(next .contracts.AgentRegistry)" "isActive(address)(bool)" "$BURSAR_EXAMPLE_PAYEE"         # true
readback "$(previous .contracts.AgentRegistry)" "withdrawals(address)(uint128,uint64)" "$BURSAR_EXAMPLE_PAYEE"   # 5000000, and when it was asked
readback "$(next .contracts.OracleRegistry)" "totalBonded()(uint128)"                                 # 90000000000000000000000
readback "$(previous .contracts.OracleRegistry)" "getResolver(address)((uint128,uint64,uint32,uint32,uint8))" \
  "$(next '.roles.resolvers[0]')"                                                                     # status 2, unbonding, with the time it began
readback "$usdg" "balanceOf(address)(uint256)" "$(next .exampleMandate.address)"                      # 200000
```

`drain()` withdraws only what the key is the principal of, and names any example it skips. A
collateral example that still owed the previous pool would have to repay before its stock comes
out; the live one owes nothing.

`MigratePayee.s.sol` registers the payee under the name it carries on the previous registry, or
under `BURSAR_PAYEE_NAME` when that is set. The registry takes 3 to 32 characters from `A-Z`,
`a-z`, `0-9` and `_`, and the script refuses any other name before it sends. It also asks the
previous registry for the payee's stake back.

Resolvers bond without waiting for step 4. The floor each one bonds at lives on the staking pool,
which is carried over with the floors governance already named.

The committed example keeps its terms behind a commitment, so they are written and sealed before
`create()` sees them. `script/committed-example.mjs` does it with the SDK, the way the console does
it for a private mandate: `message` prints the text the payer signs for its viewing key, and
`terms` writes the terms, commits to them, seals them to that key for the account `create()` will
make, and prints `BURSAR_COMMITTED_TERMS`, `BURSAR_COMMITTED_COUNTER` and
`BURSAR_COMMITTED_CIPHERTEXT` as export lines. The terms are the public example's: 0.10 USDG a
call, 0.50 a day and 1.00 in all, to the registered payee, for a year. The payer reopens them with
the same signature, in the console or with the SDK's `openTerms`. Without the three variables
`create()` says so and skips the committed example.

### 4. The wiring lands; the new record goes live

One hour after step 2:

```sh
send script/ProposeWiring.s.sol signer-1 --sig "execute()"
verify script/VerifyWiring.s.sol

# Marks the new record live and the third one superseded. Sends nothing.
send script/RetireRecords.s.sol rh-deployer --sig "goLive()"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

```sh
readback "$(next .token.Staking)" "creditManager()(address)"               # the new CreditPool
readback "$(next .token.Staking)" "slasher()(address)"                     # the same
readback "$(previous .privacy.shielded.ShieldedPool)" "dead()(bool)"       # true
jq -r .status "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"                   # live, superseded
```

`goLive()` refuses with `NotReadyForLive` until the new set has its examples and the batch has
landed. It writes the two records and sends no transaction, which is why it runs with
`--broadcast`: a simulation writes nothing. The strict check must end `0 mismatched, 0 owed`. Then
publish the two records as step 6 describes, which is what moves the apps.

The timelock keeps a proposal open for 14 days after its delay ends, its grace period, and refuses
it after that. Past it, `propose()` and `approve()` from step 2 put the batch up again, and it
waits out its hour afresh.

### 5. Old bonds and stake come back; the previous record retires

Seven days after step 3:

```sh
send script/MigrateResolvers.s.sol resolver-1 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-2 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-3 --sig "reclaim()"
send script/MigratePayee.s.sol payee --sig "reclaim()"

# The payee returns the 5 USDG the lender advanced, and the lender lends them.
cast send "$usdg" "transfer(address,uint256)" "$(next .deployer)" 5000000 \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/payee"
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" 5000000

# Anything that expired on the previous escrow since step 3, and whatever it returned to the
# examples.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"
send script/MigrateExamples.s.sol payer --sig "drain()"

# Checks that nothing is left open, then marks the third record retired.
send script/RetireRecords.s.sol rh-deployer
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

```sh
readback "$(previous .contracts.OracleRegistry)" "totalBonded()(uint128)"   # 0
readback "$(previous .contracts.AgentRegistry)" "totalStaked()(uint128)"    # 0
readback "$(next .rwa.collateral.CreditPool)" "cash()(uint256)"             # 25000000
jq -r .status "$BURSAR_RECORD" "$BURSAR_PREVIOUS_RECORD"                    # live, retired
```

Each resolver's `reclaim()` returns its old bond to the treasury, which paid for the new one.

`RetireRecords.s.sol` sends no transaction. It stops, naming each item, while anything is still
open on the third set: a payment on its escrow that is locked, disputed or still inside its
dispute window, USDG left in its escrow, cash or debt in its credit pool, any balance in its
collateral vault, notes in its shielded pool, a stake on its agent registry, or a bond or an
unclaimed reward on its resolver registry. `BURSAR_FORCE=1` retires the record anyway and lists
what was left, which is the way past a balance nobody can move: tokens sent straight to the old
escrow or vault belong to no payment and no line, and stay there.

The buyback's price ceiling is trusted for seven days after it is set, and it was last set on
2026-09-29. Once it has aged out, the strict check lists it as owed. Restate it through the timelock
with the figures the buyback holds now, which starts its seven days again: one signer proposes
`Buyback.setParams`, a second approves, and once the delay has passed a signer executes it. Then run
the strict check again.

```sh
timelock="$(next .contracts.AdminTimelock)"
buyback="$(next .token.Buyback)"
PARAMS="(uint128,uint128,uint128,uint128,uint64,uint64)"
params="$(cast call "$buyback" "params()($PARAMS)" --json --rpc-url "$RHC_RPC_URL" | jq -r '.[0] | map(tostring) | "(" + join(",") + ")"')"
cast send "$timelock" "propose(address,bytes)" "$buyback" "$(cast calldata "setParams($PARAMS)" "$params")" \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
id="$(( $(cast call "$timelock" "proposalCount()(uint256)" --rpc-url "$RHC_RPC_URL" | cut -d' ' -f1) - 1 ))"
cast send "$timelock" "approve(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2"

# An hour later, once the timelock's delay has passed:
cast send "$timelock" "execute(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

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
node script/verification-inputs.mjs --record deployments/rhc-mainnet-v4.json --prefix v4
node script/verify.mjs --only "$(jq -r 'keys | map(select(startswith("v4-"))) | join(",")' verification/manifest.json)"
```

The contracts carried over keep the entries the third set wrote for them. Then check the live
record the way anyone can, with no key:

```sh
script/check-live.sh
```

## If a step stops

A refusal stops a step before it sends anything: every check runs in the simulation Forge makes
before it broadcasts. Fix what it names and run the same command again. A step that already landed
says so and sends nothing.

A broadcast that stops partway, on a dropped connection or a key that ran out of gas, is finished
with the same command and `--resume`: Forge sends the transactions that did not land, from its log
in `broadcast/<script>/4663/`, to the endpoint it saved in `cache/<script>/4663/`, and to the
addresses the record already names. The rehearsals and local runs keep their logs under
`cache/bursar`, so neither can replace what a resume reads.

| It says | What to do |
|---|---|
| `AlreadyRecorded` | The record already names that contract. The step ran before; go on to the next one. |
| `WrongDeployer` | The run is signing with a key other than the record's deploy key. |
| `RecordMismatch` | The shell names an address the record disagrees with. Unset the variable, or correct whichever of the two is wrong. |
| `MissingEnv` naming `BURSAR_PREVIOUS_RECORD` | The shell does not name the record being replaced. Export it as "The shell" above shows. |
| `PreviousRecordMismatch` | `BURSAR_PREVIOUS_RECORD` is a record other than the one the new record names in `supersedes`. |
| `WiringFailed`, `BondFloorNotSet`, `BondFloorsDiffer`, `PoolIdMismatch` | A contract the record carries over is not what the record implies. The error names the read, the value expected and the value found. Nothing was sent. |
| `OracleRegistryNotReady` | The new resolver registry was deployed by another key, settles in another asset, or already names a staking pool other than the record's. |
| `EntrypointNotGoverned` | The timelock does not hold the owner role on the previous Entrypoint, so it cannot wind that pool down. |
| `NotSigner` | The keystore is not one of the timelock's signers. |
| `NotTheKey` | The step has to be signed by the key it names: the lender, or the treasury. |
| `not executable yet`, `DelayNotPassed` | The call cannot run yet. The line says why: the delay, with the UTC date it ends and the time left, or an approval still missing. When the delay held every call back, `execute()` sent nothing and fails with `DelayNotPassed`, which names when the delay ends. Run `execute()` again then. |
| `not matured yet` | An old bond or stake is still unbonding. Run the same step again on the date it prints. |
| `MissingEnv`, `InvalidEnv` | A variable is unset, or holds something that does not read as its type. The error names the variable, and `InvalidEnv` the value. |
| `NotReadyForLive` | The new set cannot take the apps yet. The error names what is missing: an example, or the wiring. |
| `StillOpen` | Something on the third set is still open. The run lists each item above the error. |
| `VerificationFailed` | A check found a mismatch, or, under `BURSAR_VERIFY_STRICT=1`, something still owed. Each one is listed above the error. |
