# Moving Bursar to the seventh contract set

This runbook brings the seventh Bursar contract set live on Robinhood Chain. The seventh set moves
the protocol from BRSR to $BURSAR, the token the operator launched on Pons at
`0xE4d2422Ed4d203A0F1EC2043a4dB1eDa426fca18`. It is written for the people who hold the keys. Every
step is a script in this directory that can be simulated against the live chain before it sends
anything, and the whole sequence has been rehearsed on a copy of mainnet with the same scripts and
arguments.

## What changes

- **Everything that holds the staked token is new.** No deployed contract can be pointed at another
  token: each one binds BRSR in its constructor or through a setter that takes one call. The staking
  pool and the buyback are redeployed on $BURSAR, and with them the credit pool and collateral vault
  that hold both immutably.
- **So is the dispute layer.** The resolver registry learns its bond token once, so a new registry
  is deployed, and because the escrow, reputation and registry pair with each other through one-shot
  setters, a new escrow, reputation and mandate factory come with it. The committed-mandate
  contracts lock on the escrow, so `DeployPrivacy.s.sol` deploys them afresh too.
- **So is the treasury park.** A park admits mandates from the factories named in its constructor
  and from nothing else, and the seventh set has a new factory. `DeployRwa.s.sol` builds a park for
  it with both adapters, against the carried registry and guard. Mandates on the sixth factory keep
  the sixth park, so nothing parked there has to move.
- **Buybacks are off.** The buyback is deployed only because the credit pool converts a write-off
  into stake at its price ceiling. It gets no keeper, the wiring batch pauses it, and the treasury
  never funds it. Its pool key names a $BURSAR/USDG pool that is not open: the only $BURSAR market is
  Pons's ETH pool, whose hook takes a fee on every swap. Turning buybacks on is a later decision,
  covered at the end.
- **Everything else carries over at its address.** The 48-hour timelock, the agent registry, so
  every provider staked on it can be paid through the new escrow without staking again, the asset
  registry, price guard and stock router, which the endowments hold immutably, the shielded pool and
  the endowments themselves.
- **Mandates on the sixth escrow stay there.** A mandate account binds its escrow for good. Existing
  mandates keep paying, settling and disputing on the sixth set; new mandates open on the seventh.
  The public, collateral and committed examples are drained and recreated on the new set.
- **The sixth token set is closed in the wiring batch.** Its buyback is paused, its seeder's
  BRSR/USDG position comes out to the treasury, and the team's BRSR grant is revoked before its
  cliff. The three resolvers unbond their BRSR from the sixth registry from their own keys and
  return it to the treasury seven days later. BRSR has no admin and no burn, so the token itself is
  left as it is.
- **The figures carry over at five times.** BRSR opened at 200 micro-USD and $BURSAR traded near 43
  when this move was planned, so each resolver's floor is 150,000 BURSAR where it was 30,000 BRSR, and
  the rebate tiers are 125,000, 500,000, 2,500,000 and 12,500,000 BURSAR for the same 5, 10, 20 and 30
  percent. The buyback's ceiling is 60 micro-USD per BURSAR.

## Before you start

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`.

**Keys.**

| Key | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | the four deploy scripts; lender of both credit pools; the records |
| two signers | `roles.timelockSigners` in the record | the wiring batch |
| `payer` | `0x877c349EFb5926082C413833E8055F0991185c61` | draining and recreating the examples |
| `treasury` | `0x7f2D3be9597fb538BDBA3Dbcb9BEcECCD9056d21` | sending each resolver its $BURSAR bond |
| `resolver-1` to `resolver-3` | `roles.resolvers` in the record | bonding on the new registry; reclaiming the old bonds |
| operator wallet | `0x63C17961EfEe664A92cf0B95fcC0EBC6b4e1D83E` | the $BURSAR the bonds are paid from, sent to the treasury |

**Balances.** Every key needs ETH for gas. In the rehearsal the deploy key used 36.3 million gas, the
first signer 8.2 million (it proposes and executes both batches), the second 1.4 million, the payer 11.5
million, the treasury 0.15 million and each resolver about 0.35 million. At the 0.02 gwei the chain
charged when this was written that is 0.0007 ETH for the deploy key and 0.0002 for the payer, which
held just under that. The deploy key
needs a dollar of USDG for the core run's preflight, which step 1 returns to it from the sixth
credit pool. The treasury needs the three bonds in $BURSAR, 450,000 BURSAR, which the operator wallet
sends it in step 6; the protocol holds no $BURSAR of its own and buys none.

**The shell.** Every command below runs in one shell set up like this:

```sh
cd contracts
source script/env/rhc-mainnet-v7.env        # the figures, BURSAR_RECORD, BURSAR_TOKEN and RHC_RPC_URL
export BURSAR_PREVIOUS_RECORD=deployments/rhc-mainnet-v6.json
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance
export KEYS="$HOME/.config/bursar/keystore"

simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
send() { simulate "$@" --broadcast --slow; }
verify() { forge script "$@" --rpc-url "$RHC_RPC_URL"; }
previous() { jq -r "$1" "$BURSAR_PREVIOUS_RECORD"; }
next() { jq -r "$1" "$BURSAR_RECORD"; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }
```

Run every `send` as a `simulate` first, with the same arguments, and read what it prints. The deploy
scripts write the seventh record as they go; a simulation writes nothing.

## Rehearse first

```sh
script/local/rehearse-v7.sh
```

It forks mainnet as it stands and runs the steps below in order. Each of the deployment's keys
signs as itself through the fork's impersonation; the operator's $BURSAR comes from impersonating
the operator wallet. After the move it pays through the new escrow twice, once released and once
disputed and ruled on by the new bonded resolvers, confirms the buyback refuses to trade, then skips
the seven days the old bonds take and asks whether the sixth record can retire. Its records, build
and logs stay under `cache/bursar/fork-rhc-mainnet-v7`. Start only when it ends with the seventh
record `live`.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Take back the sixth credit pool's cash | deploy key | |
| 2. Deploy the seventh set | deploy key | |
| 3. Propose the wiring | two signers | |
| 4. Move what needs no governance | deploy key, payer | |
| 5. The wiring lands | a signer | 48 hours after step 3 |
| 6. The resolvers bond in $BURSAR | operator wallet, treasury, each resolver | after step 5 |
| 7. The seventh record goes live | deploy key | after step 6 |
| 8. The old bonds come back; the sixth record retires | each resolver, deploy key | 7 days after step 6 |
| 9. Publish the records and the sources | nobody | after steps 7 and 8 |

### 1. Take back the sixth credit pool's cash

```sh
send script/MigrateCredit.s.sol rh-deployer
```

The lender's 15.5 USDG comes back to the deploy key. Nothing is lent out of the sixth pool, so the
whole balance returns, and it is what the new pool is funded with in step 4.

### 2. Deploy the seventh set

```sh
send script/Deploy.s.sol rh-deployer
send script/DeployRwa.s.sol rh-deployer
send script/DeployStaking.s.sol rh-deployer
send script/DeployCollateral.s.sol rh-deployer
send script/DeployPrivacy.s.sol rh-deployer
verify script/VerifyCore.s.sol
verify script/VerifyRwa.s.sol
verify script/VerifyStaking.s.sol
verify script/VerifyCollateral.s.sol
verify script/VerifyPrivacy.s.sol
verify script/VerifyToken.s.sol
```

`Deploy.s.sol` joins the 48-hour timelock the record names, deploys reputation, the escrow, the
resolver registry and the mandate factory, closes their three pairings, and wires the carried agent
registry to the new escrow: `BURSAR_DEPLOY_AGENT_REGISTRY=false` with a registry in the record means
keep it. `DeployRwa.s.sol` finds the registry, guard and router in the record and no park, and builds
the park for the new factory with its treasury and USDG adapters, listed by the deploy key.
`DeployStaking.s.sol` reads the token from `.token.BURSAR`, checks its decimals and that
its supply is no more than the billion it launched with, deploys the staking pool and the buyback,
deploys no seeder because no $BURSAR/USDG pool is open, closes `OracleRegistry.setStaking`, and
records `buybacksOff`. `DeployCollateral.s.sol` deploys the credit pool and vault on the new pool and
buyback. `DeployPrivacy.s.sol` deploys the verifier, committed-mandate factory, disclosure registry
and solvency log against the new escrow.

The checks list as **owed** what the batch settles: the resolvers' floors, the rebate table, the
credit pool's two roles on the staking pool, the buyback's pause, and a collateral tier on the new
vault for each stock governance listed after launch. A **mismatch** is not expected:
stop and read it.

### 3. Propose the wiring

```sh
send script/ProposeWiring.s.sol signer-1 --sig "propose()"
send script/ProposeWiring.s.sol signer-2 --sig "approve()"
verify script/ProposeWiring.s.sol --sig "status()"
send script/ListStocks.s.sol signer-1 --sig "propose()"
send script/ListStocks.s.sol signer-2 --sig "approve()"
```

The batch is ten calls on the 48-hour timelock:

- on the seventh set: `Buyback.pause`, `Staking.setBondFloor` for each of the three resolvers at
  150,000 BURSAR, `Staking.setTiers`, and `Staking.setCreditManager` and `Staking.setSlasher`, both to
  the new credit pool;
- on the sixth: `Buyback.pause`, `V4LiquiditySeeder.removeLiquidity` of the whole BRSR/USDG position
  to the treasury, and `Vesting.revoke` for the grant `BURSAR_VESTING_REVOKE` names.

No keeper is proposed: with buybacks off nobody may call the buyback. The previous registry's bonds
are not evicted by the batch; the resolvers unbond them in step 6.

`ListStocks.s.sol` finds every stock in `StockListings` already on the carried registry and proposes
only `CollateralVault.setAssetTier` for each on the new vault: the launch four have their tiers from
`DeployCollateral.s.sol`, the thirteen listed since need them by proposal.

### 4. Move what needs no governance

```sh
# Locks on the sixth escrow whose deadline passed go back to their payers; its fees go to the treasury.
send script/RetireRecords.s.sol rh-deployer --sig "settle()"

# The examples' balances back to the payer, then recreated on the new set.
send script/MigrateExamples.s.sol payer --sig "drain()"
send script/MigrateCredit.s.sol rh-deployer --sig "fund(uint256)" 15500000
send script/MigrateExamples.s.sol payer --sig "create()"
```

`create()` makes the public example on the new factory, paying the registered payee, and the
collateral example on the new vault with the SPY the old one held. The committed example needs terms
sealed with the payer's viewing key by `script/committed-example.mjs`; without them it is skipped and
noted, and stops nothing.

### 5. The wiring lands

Once the 48 hours have passed:

```sh
send script/ProposeWiring.s.sol signer-1 --sig "execute()"
send script/ListStocks.s.sol signer-1 --sig "execute()"
verify script/VerifyWiring.s.sol
verify script/VerifyRwa.s.sol
```

```sh
readback "$(next .token.Buyback)" "paused()(bool)"                                    # true
readback "$(next .token.Buyback)" "keeper()(address)"                                 # 0x0
readback "$(next .token.Staking)" "creditManager()(address)"                          # the new CreditPool
readback "$(previous .token.Buyback)" "paused()(bool)"                                # true
readback "$(previous .token.V4LiquiditySeeder)" "liquidityOf(int24,int24)(uint128)" -887220 887220   # 0
```

### 6. The resolvers bond in $BURSAR

```sh
# From the operator wallet: three floors of 150,000 BURSAR to the treasury.
cast send "$BURSAR_TOKEN" "transfer(address,uint256)" "$(next .roles.treasury)" 450000000000000000000000 \
  --rpc-url "$RHC_RPC_URL" --ledger

send script/MigrateResolvers.s.sol treasury --sig "fund()"
send script/MigrateResolvers.s.sol resolver-1 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-2 --sig "bond()"
send script/MigrateResolvers.s.sol resolver-3 --sig "bond()"
```

`bond()` registers each resolver on the new registry at its floor, then asks the sixth registry for
its BRSR bond back, which takes seven days. The sixth registry keeps ruling on disputes already open
on it in that time.

```sh
readback "$(next .contracts.OracleRegistry)" "resolverCount()(uint256)"               # 3
readback "$(next .contracts.OracleRegistry)" "bondAsset()(address)"                   # $BURSAR
```

### 7. The seventh record goes live

```sh
send script/RetireRecords.s.sol rh-deployer --sig "goLive()"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

`goLive()` refuses with `NotReadyForLive` until the examples exist and the batch has landed. It
marks the seventh record live and the sixth superseded, which is what moves the apps once the
records are published.

### 8. The old bonds come back; the sixth record retires

Seven days after step 6:

```sh
send script/MigrateResolvers.s.sol resolver-1 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-2 --sig "reclaim()"
send script/MigrateResolvers.s.sol resolver-3 --sig "reclaim()"
send script/MigrateCredit.s.sol rh-deployer --sig "claimSeized()"
send script/RetireRecords.s.sol rh-deployer --sig "settle()"
send script/RetireRecords.s.sol rh-deployer
```

`reclaim()` takes each BRSR bond back from the sixth registry and returns it to the treasury.
`settle()` again times out any lock on the sixth escrow whose deadline passed since step 4. The
agent registry carries over, so the stakes on it are the seventh set's and are not counted.
`RetireRecords.s.sol` retires the sixth record once nothing is open on its escrow, registries,
credit pool and vault, and names each item while anything is. Mandates still using the sixth escrow
hold it open; `BURSAR_FORCE=1` retires the record anyway and lists what was left.

### 9. Publish the records and the sources

After step 7 and again after step 8, commit both records under `deployments/` and regenerate the
address book from the repository root:

```sh
pnpm --filter @bursar/core codegen
pnpm -r build
```

Then write each new contract's verification input and publish its source:

```sh
node script/verification-inputs.mjs --record deployments/rhc-mainnet-v7.json --prefix v7
node script/verify.mjs --only "$(jq -r 'keys | map(select(startswith("v7-"))) | join(",")' verification/manifest.json)"
script/check-live.sh
```

## Turning buybacks on later

The buyback is built against a $BURSAR/USDG pool at the 0.30% tier with no hook, and those five
values are fixed in it. There are two ways to give it a market:

- open exactly that pool, with a seeder `SeedPool.s.sol` deploys and offers to the timelock, then
  propose `Buyback.unpause`, `Buyback.setKeeper` and a fresh ceiling with `Buyback.setParams`; or
- build a buyback that routes USDG to ETH to $BURSAR through the Pons pool, which pays the pool's
  hook fee on every buy and needs a new credit pool, because the credit pool holds its buyback
  immutably.

Either is its own move, decided by the operator. Until then the buyback stays paused and unfunded.

## If a step stops

A refusal stops a step before it sends anything. Fix what it names and run the same command again;
a step that already landed says so and sends nothing. A broadcast that stops partway is finished with
the same command and `--resume`, as [`MIGRATION.md`](MIGRATION.md) describes. The ones this move
meets on its own:

| It says | What to do |
|---|---|
| `SettlementBalanceTooLow` naming the deploy key | Step 1 has not run: the deploy key holds less than a dollar of USDG. |
| `NotStakeToken` | The token at `.token.BURSAR` has a supply of zero or above a billion. The record is wrong. |
| `RecordMismatch` naming `.token.BURSAR` | `BURSAR_TOKEN` in the shell names another token than the record. |
| `WiringFailed agentRegistry.admin` | The carried agent registry answers to another timelock than the one this run joins. |
| `NotRecorded .token.keeper` | The record has lost `"buybacksOff": true` under `token`, which `DeployStaking.s.sol` wrote. Put it back; the batch then pauses the buyback instead of naming a keeper. |
| `governance has not named this resolver's floor yet` | Step 5 has not landed. |
| `the treasury has not sent this resolver its bond yet` | `fund()` has not run, or the operator wallet has not sent the treasury its $BURSAR. |
| `NotReadyForLive` | The examples or the batch are missing; the error names which. |
| `StillOpen` | Something on the sixth set is still open; the run lists each item above the error. |
