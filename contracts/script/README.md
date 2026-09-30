# Deploying Bursar

`Deploy.s.sol` brings up the whole contract set in one run and refuses to start when the
parameters you gave it do not hold together. Read this before the first deploy on any chain.
You do not need to have read the contracts.

What gets deployed:

| Contract | What it is |
|---|---|
| `AdminTimelock` | Two-of-three governance with a mandatory waiting period. Admin of `Reputation`, `OracleRegistry` and `AgentRegistry`. |
| `Reputation` | Settlement history per payee, and the spending cap derived from it. |
| `Escrow` | Holds one payment for the life of one job. Locks, releases, refunds, disputes. No admin role: its fee, TTL bounds and dispute windows are fixed at construction. |
| `OracleRegistry` | Bonded resolvers who rule on disputes by commit-reveal vote, and their rewards. |
| `AgentRegistry` | Optional. Staked directory of the counterparties a mandate may name. |
| `MandateAccountFactory` | Creates mandate accounts at addresses a principal can compute before funding them. No admin role: everything it holds is immutable. |

`deployments/rhc-mainnet.json` records who administers each contract in Release 1 under
`governance.adminOf`, including the token contracts the second deploy adds.

Every amount below is in settlement-asset units. On Robinhood Chain that is USDG at six
decimals, so `1_000000` is one dollar. Every duration is in seconds.

## 1. Before you start

**Dependencies.** `contracts/lib/` is not committed and there are no submodules, so a fresh
checkout has no `forge-std` and no OpenZeppelin, and every command below fails to resolve its
imports. Install them once, from `contracts/`:

```sh
forge install --no-git --shallow \
  foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 \
  OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1
```

`--no-git` keeps them out of the git index, which is how this repository is arranged. The three
commits are forge-std v1.9.4, OpenZeppelin Contracts v5.1.0 and OpenZeppelin Contracts
Upgradeable v5.0.2, the exact sources the deployed bytecode was built from, and CI installs the
same ones. Then `forge build` and `forge test` work. The rest of the prerequisites are in the root
`README.md`.

**Keys.** The deploy key signs from a Foundry encrypted keystore. A private key never appears
in a command, an environment variable, or a file in this repository.

Import the key once. `cast` prompts for the private key and for a password, and writes an
encrypted keystore to `~/.foundry/keystores/bursar-deployer`:

```sh
cast wallet import bursar-deployer --interactive
```

For each run, point Foundry at the keystore and at a file holding its password. Keep the
password file outside the repository, readable only by you, and delete it when you are done.
Foundry reads both variables on its own, so no key or password is passed on the command line.

```sh
export ETH_KEYSTORE="$HOME/.foundry/keystores/bursar-deployer"
export ETH_PASSWORD="$HOME/.bursar-deployer.pass"      # chmod 600

export RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export RHC_USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export RHC_DEPLOYER="$(cast wallet address --keystore "$ETH_KEYSTORE" --password-file "$ETH_PASSWORD")"
```

A hardware wallet works the same way with `--ledger` or `--trezor` in place of the keystore.

**Funding.** Gas is ETH and settlement is USDG. Two different assets, so topping up the gas
float never touches the settlement balance and neither figure tells you anything about the
other. The deploy key needs both: ETH to send the transactions, and enough USDG that the
preflight can see the asset is real and the first mandate can be funded.

```sh
cast balance "$RHC_DEPLOYER" --rpc-url "$RHC_RPC_URL"                                  # gas, wei
cast call "$RHC_USDG" "balanceOf(address)(uint256)" "$RHC_DEPLOYER" --rpc-url "$RHC_RPC_URL"
```

The treasury, the slash sink and the deploy key are three separate addresses, and the script
stops if any two of them are the same.

**Governance.** Decide the three timelock signers before you deploy. They cannot be changed
without a timelocked proposal, and the deploy key is not allowed to be one of them. At least
one signer has to be a contract, in practice a multisig, unless the run explicitly
acknowledges an all-EOA signer set. See section 2.

## 2. Environment

Nothing has a default. An unset variable stops the run with `MissingEnv("NAME")`, so the script
can never deploy something you did not choose.

### Chain and asset

| Variable | Meaning |
|---|---|
| `BURSAR_CHAIN_ID` | The chain you intend to deploy to. Checked against the chain the RPC actually serves. |
| `BURSAR_SETTLEMENT_ASSET` | ERC-20 address of the settlement asset. Must answer `decimals() == 6`. On chain 4663 it must be USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. |

Chain `4663` is the only deploy target. Testnet `46630` answers, but USDG holds no contract
there, so nothing on it can settle.

On 4663 the run also reads the part of USDG's compliance surface that answers. USDG is a
diamond proxy: it routes `paused()` and `isFrozen(address)`, and it reverts `FacetNotFound` on
anything it does not route, `isBlacklisted` and `version` included. So the preflight checks that
the asset is not paused, that neither the deploy key nor the treasury is frozen, and that the
deploy key holds at least 1 USDG. All three are read straight, with no gas stipend and no
try/catch, because there is no precompile in the path.

Every variable on this page can be namespaced. Set `BURSAR_ENV_PREFIX` and the script reads
`<prefix>BURSAR_CHAIN_ID` and so on, which is how two deployments share one shell without
reading each other's parameters.

### Governance

| Variable | Meaning |
|---|---|
| `BURSAR_TIMELOCK_SIGNER_1` | First timelock signer. |
| `BURSAR_TIMELOCK_SIGNER_2` | Second timelock signer. |
| `BURSAR_TIMELOCK_SIGNER_3` | Third timelock signer. |
| `BURSAR_TIMELOCK_GUARDIAN` | Holds the brake. Can pause an administered contract immediately, and can do nothing else. Must not be one of the three signers. |
| `BURSAR_TIMELOCK_PERIOD` | Seconds between a proposal reaching two approvals and becoming executable. The contract accepts one hour to 30 days in this development deployment; the floor is 48 hours at launch. Staked parties need seven days to withdraw whatever the delay. |
| `BURSAR_ADMIN_TIMELOCK` | Optional. A live `AdminTimelock` for this run to join instead of deploying one. Leave it unset, or set it to the zero address, on a chain with no governance yet. |
| `BURSAR_ALLOW_EOA_GOVERNANCE` | Optional, and the only way to deploy with three plain keys. Must read exactly `i-accept-eoa-governance`. Anything else, `true` included, stops the run. |

**Deploying without a multisig.** The script refuses a signer set in which no signer is a
contract, because three hot keys hold a treasury no better than one. Release 1 governance is
three plain keys until a multisig replaces them, so that refusal has to be liftable. It lifts on
a phrase rather than a boolean, because `true` is a word that ends up in a shell by accident and
`i-accept-eoa-governance` is not. A run that
lifts it prints what it means before it deploys anything.

Two of the three signers authorise a change; any one of them can cancel a pending one. A
proposal that sits unexecuted for 14 days after its delay expires has to be proposed again.

**Joining governance that is already live.** A first deployment brings its own timelock. A
redeploy of the money path, which is what a change to `Escrow` or `OracleRegistry` forces,
should join the one already holding the rest of the system: the delay only means anything if
there is one of it, and two timelocks over one deployment are two answers to the question of
who may change a parameter. `BURSAR_ADMIN_TIMELOCK` names it, and it is the same variable the
token deployment reads, so one address describes governance for both runs.

The run never sets the terms of governance it joins, so it reads them off the contract and
holds them against the four variables above. A period, a guardian or a signer that disagrees
stops the run. Fix whichever of the two is wrong before continuing.

The guardian is the one exception to the delay: its `pause` call lands in the same block,
skipping the queue. Restarting a paused contract goes through the full delay, so a stolen
guardian key costs an outage and nothing more. Keep it off the signer set. A key that has to be
reachable in seconds is the one most likely to be sitting warm, and the script stops on the
overlap with `RoleCollision("guardian", "timelockSigner", ...)`. `GOVERNANCE.md` at the
repository root describes the brake and the rest of the timelock.

### Money sinks

| Variable | Meaning |
|---|---|
| `BURSAR_TREASURY` | Receives the protocol fee. Swept from the escrow by anyone willing to pay the gas, and only ever to this address. |
| `BURSAR_SLASH_SINK` | Receives slashed resolver bonds, which are BRSR, and slashed agent stake, which is the settlement asset. |

The treasury can hand itself over later in two steps, from its own key. The deploy script does
not do that for you.

### Escrow economics

| Variable | Meaning |
|---|---|
| `BURSAR_FEE_BPS` | Protocol fee in basis points, charged against the payee's side of a settlement only. A refund, a timeout and a cancellation return the payer whole. Ceiling 1000. |
| `BURSAR_RESOLVER_FEE_BPS` | Taken off a disputed lock before the split and paid to the resolvers who ruled on it. Ceiling 1000. |
| `BURSAR_DISPUTE_BOND_BPS` | What opening a dispute costs, as a share of the locked amount, pulled from whoever opens it. Returned when the ruling lands on their side, or when no resolver ever ruled. Ceiling 2000. |
| `BURSAR_MIN_TTL` | Shortest job deadline a lock may carry. |
| `BURSAR_MAX_TTL` | Longest job deadline a lock may carry. Must exceed `MIN_TTL` by more than one second. |
| `BURSAR_DISPUTE_WINDOW` | How long after a release the payer may still dispute. The money is gone by then, so a late dispute records against the payee's history and settles nothing. |
| `BURSAR_DISPUTE_TIMEOUT` | How long a disputed lock waits for a ruling before anyone may refund the payer. Must be longer than the commit and reveal windows combined. |

Both fees come out of the same locked principal, so their sum has to stay below 100%.

### Reputation cap curve

A payee's cap is `baseCap + capPerScore * score`, capped at `maxCap`, with the score running
from 0 to 100. A payee with no history scores zero and gets `baseCap`, so a zero base cap
rejects every first job on the network. The script stops if you set one.

| Variable | Meaning |
|---|---|
| `BURSAR_CAP_BASE` | Cap for a payee with no settlement history. Must be non-zero. |
| `BURSAR_CAP_PER_SCORE` | Extra cap per score point earned. |
| `BURSAR_CAP_MAX` | Ceiling the curve never exceeds. Must be at least `BURSAR_CAP_BASE`. |

### Resolvers

Resolver bonds are posted in BRSR, not in the settlement asset. The floor that admits one lives
in `Staking`, so this deployment sets no figure for it; the token deployment sets it from
`BURSAR_STAKING_MIN_BOND`. Governance can raise it later, per resolver or for everyone. A
resolver below the new floor loses its vote in the block the change lands, and keeps its bond. A
bond denominated in a moving asset needs that lever.

`BURSAR_RESOLVER_MIN_BOND` is retired. A run that finds it still set in the shell stops with
`RetiredEnv`.

Until the token deployment runs and calls `OracleRegistry.setStaking`, nobody can bond and no
dispute can be voted on. The core run prints the pending call and leaves it to that second run.

| Variable | Meaning |
|---|---|
| `BURSAR_COMMIT_WINDOW` | How long resolvers have to commit to a sealed score. |
| `BURSAR_REVEAL_WINDOW` | How long they then have to reveal it. |
| `BURSAR_UNBONDING_PERIOD` | Cooldown between asking to withdraw a bond and collecting it. Must be at least the commit and reveal windows combined, so a bond cannot mature before the dispute it voted on settles. |
| `BURSAR_RESOLVER_QUORUM` | Reveals needed for a vote to count. Below it the dispute fails and the payer is refunded. |
| `BURSAR_MAX_VOTERS` | Commitments admitted per dispute. At most 64. |
| `BURSAR_MAX_DEVIATION` | How far a revealed score may sit from the median, in score points, before it is treated as an outlier. Outliers are slashed and earn no reward. |
| `BURSAR_RESOLVER_SLASH_BPS` | Share of a resolver's bond taken for staying silent after committing, or for ruling outside the deviation band. Must be non-zero: a slash of zero still emits a slashing event, which reads as enforcement to anyone watching the logs. |

### Agent registry (optional)

| Variable | Meaning |
|---|---|
| `BURSAR_DEPLOY_AGENT_REGISTRY` | `true` or `false`, spelled out. Anything else, including an empty value, stops the run. |
| `BURSAR_AGENT_MIN_STAKE` | Stake required to register and to stay active. Required when the registry is deployed. |
| `BURSAR_AGENT_SLASH_BPS` | Share of an agent's stake taken by one ruling. Ceiling 5000. |

With the registry deployed, the escrow gates every lock on the payee: a payee that is barred
or not active cannot be paid. Without it the escrow admits any payee, which is the right shape
for a minimal deployment. The choice is one-way. The escrow accepts the registry once and
cannot be re-pointed at another.

### Example, Robinhood Chain mainnet

These are the Release 1 values, as read back from chain after the deploy and recorded under
`verifiedOnChain` in `deployments/rhc-mainnet.json`. The role addresses are left as `0x...`
because they belong to whoever runs the deploy; Release 1's own are under `roles` in the same
file. Save the block to a file outside the repository, `bursar-mainnet.env` below, fill in the
roles, and source it rather than retyping the values.

```sh
export BURSAR_CHAIN_ID=4663
export BURSAR_SETTLEMENT_ASSET=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

export BURSAR_TIMELOCK_SIGNER_1=0x...
export BURSAR_TIMELOCK_SIGNER_2=0x...
export BURSAR_TIMELOCK_SIGNER_3=0x...
export BURSAR_TIMELOCK_GUARDIAN=0x...       # pause-only key, not a signer
export BURSAR_TIMELOCK_PERIOD=172800        # 48h, the floor at launch (1h in development)
# Unset on a first deploy. On a redeploy, the live timelock this run joins.
# export BURSAR_ADMIN_TIMELOCK=0x...

export BURSAR_TREASURY=0x...
export BURSAR_SLASH_SINK=0x...

export BURSAR_FEE_BPS=100                   # 1.00%
export BURSAR_RESOLVER_FEE_BPS=50           # 0.50%
export BURSAR_DISPUTE_BOND_BPS=500          # 5% of the locked amount
export BURSAR_MIN_TTL=300                   # 5m
export BURSAR_MAX_TTL=604800                # 7d
export BURSAR_DISPUTE_WINDOW=3600           # 1h after release
export BURSAR_DISPUTE_TIMEOUT=172800        # 48h, well clear of 12h of voting

export BURSAR_CAP_BASE=25000000             # 25 USDG for an unproven payee
export BURSAR_CAP_PER_SCORE=1000000         # +1 USDG per score point
export BURSAR_CAP_MAX=250000000             # 250 USDG

export BURSAR_COMMIT_WINDOW=21600           # 6h
export BURSAR_REVEAL_WINDOW=21600           # 6h
export BURSAR_UNBONDING_PERIOD=604800       # 7d
export BURSAR_RESOLVER_QUORUM=2
export BURSAR_MAX_VOTERS=5
export BURSAR_MAX_DEVIATION=20
export BURSAR_RESOLVER_SLASH_BPS=1000       # 10% of the bond

export BURSAR_DEPLOY_AGENT_REGISTRY=true
export BURSAR_AGENT_MIN_STAKE=5000000       # 5 USDG
export BURSAR_AGENT_SLASH_BPS=1000          # 10% of the stake

# Release 1 only. Unset, the run refuses a signer set of three plain keys.
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance
```

## 3. Running it

Simulate first. Without `--broadcast` nothing is sent, and every check in the script still
runs against the live chain state.

```sh
source bursar-mainnet.env     # the parameters from section 2
cd contracts

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RHC_RPC_URL" \
  --sender "$RHC_DEPLOYER" \
  -vvv
```

Then deploy:

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RHC_RPC_URL" \
  --sender "$RHC_DEPLOYER" \
  --broadcast --slow -vvv
```

`--sender` has to be the keystore address. The script reads back on chain that the contracts
were in fact deployed by it, because three pairings can only ever be closed by that address.

`--slow` sends one transaction at a time and waits for each receipt, which keeps a mispriced
batch from spending the gas float on transactions that then fail.

Simulated against live 4663 on 2026-09-22: eleven transactions, about 16.3M gas, which is
0.00088 ETH at the 0.054 gwei the chain has held at. Foundry's own estimate carries a 1.3x
buffer on top and reports 21.2M gas and 0.00223 ETH.

Addresses and transaction hashes land in `broadcast/Deploy.s.sol/<chainId>/run-latest.json`.
The script also prints every address at the end of the run.

## 4. The order, and why it is that order

1. **`AdminTimelock`** first, so no contract is ever admin-controlled by the deploy key. Each
   constructor below names the timelock directly, which leaves no window in which the deploy
   key could act as admin. With `BURSAR_ADMIN_TIMELOCK` set, this step reads the live
   contract instead of deploying one, and everything below is unchanged.
2. **`Reputation`**, with the timelock as admin and the cap curve fixed at construction.
3. **`Escrow`**, which needs the reputation address.
4. **`OracleRegistry`**, with the timelock as admin and the slash sink as the destination for
   slashed bonds.
5. **`AgentRegistry`**, if enabled. It takes the deploy key as admin for the length of this
   run only, because it has to name a resolver that does not exist until step 4.
6. **The three one-shot pairings**, all from the deploy key, all in this run:
   `Reputation.setEscrow`, `Escrow.setResolver`, `OracleRegistry.setEscrow`. Each accepts one
   call and there is no second chance. A deployment that stops before this point cannot be
   finished and has to be redone.
7. **`Escrow.setRegistry`**, when the registry is deployed, then `transferAdmin` to the
   timelock. Also one shot.
8. **`MandateAccountFactory`**, last, because it bakes the escrow and the asset into every
   account it creates.

`AgentRegistry.setSlasher` is left uncalled, and the run asserts that `slasher` is the zero
address. A resolver rules on a job and produces a quality score. The escrow turns that score
into a refund split, and the reputation curve lowers the cap on the agent's next lock. Nothing
in that path reaches an agent's balance, so naming a slasher here would advertise a capability
the system does not have. Agent collateral moves on a timelock proposal, with a person naming
the amount.

`OracleRegistry.setStaking` is the fourth pairing and the one this run cannot make, because the
pool that prices a resolver bond is deployed with the token set. The same deploy key closes it
from there. See `TOKEN-README.md`.

## 5. What the script refuses to do

These are the cross-contract conditions no single constructor can see. Each one stops the run
with a named error.

| Error | What it means |
|---|---|
| `WrongChain` | `BURSAR_CHAIN_ID` does not match the chain behind `--rpc-url`. Usually an RPC pointed at the wrong network. |
| `AssetNotContract` | The settlement asset holds no code, or does not answer `decimals()`. |
| `AssetDecimalsMismatch` | The settlement asset reports something other than six decimals. |
| `AssetNotUsdg` | On chain 4663 the asset must be USDG at the verified address. |
| `AssetPaused` | USDG is paused. Every transfer would revert, so a run that started would strand a half-wired deployment. |
| `AddressFrozen` | USDG has frozen the deploy key or the treasury. A frozen treasury can never be swept, and the escrow names it immutably. |
| `SettlementBalanceTooLow` | The deploy key holds less than 1 USDG. The run spends none, so this is the check that the address in the parameter file is the asset the system settles in. |
| `FeeSplitTooLarge` | Protocol fee plus resolver fee reaches 100%. There would be nothing left to pay the payee from. |
| `DisputeBondTooLarge` | A bond at or above the locked amount cannot be posted. |
| `DisputeTimeoutTooShort` | The escrow would refund every dispute before the resolvers finished voting, which makes the quorum decorative and hands any payer a free clawback. |
| `TimelockPeriodZero` | A timelock that executes immediately is a multisig with extra steps. |
| `TimelockNotContract` | `BURSAR_ADMIN_TIMELOCK` names an address with no code. Every admin call in the deployment would revert. |
| `BaseCapZero` | Every payee with no history would be capped at zero, so no first job could ever be locked. |
| `DeployerIsTimelockSigner` | The deploy key signs from a shell with an unlocked keystore. Governance weight on that key puts the delay and the hot key in one hand. |
| `RoleCollision` | Two roles share an address: the deploy key, the treasury and the slash sink each need their own, and the guardian cannot also be a timelock signer. |
| `GovernanceHasNoMultisig` | None of the three signers is a contract, and `BURSAR_ALLOW_EOA_GOVERNANCE` is unset. Three hot keys hold a treasury no better than one. |
| `EoaGovernanceNotAcknowledged` | `BURSAR_ALLOW_EOA_GOVERNANCE` is set to something other than `i-accept-eoa-governance`. The error prints what was given and what is required. |
| `MissingEnv`, `EnvOutOfRange`, `EnvNotBoolean` | A variable is unset, too large for its field, or not spelled `true` or `false`. |
| `RetiredEnv` | A variable from an older parameter set is still in the shell. Its value is in a unit nothing reads any more, so the run names it and the variable that replaced it. |
| `WiringFailed`, `ParameterNotApplied` | A setter or constructor argument did not take effect on chain. The run stops with the value expected and the value found. |

After the transactions land, the script reads all of it back off chain: the three pairings,
the registry gate, the asset on every contract, both admins, the treasury, the slash sink, the
fee rates, the bond rate, the cap curve, and the timelock period. A deployment that reaches
the end of the run is wired.

## 6. After the deploy

**One step is left, and only if the agent registry was deployed.** Its admin is still the
deploy key until the timelock accepts the handover, which takes a proposal and a second
approval. The script prints the target and the calldata. Do this first, before anything is
staked.

`$TIMELOCK` and `$AGENT_REGISTRY` below are the two addresses the run printed, `$CALLDATA` is
the encoded call it printed with them, and `$ID` is the proposal id the timelock returns.

```sh
# from a timelock signer
cast send "$TIMELOCK" "propose(address,bytes)" "$AGENT_REGISTRY" "$CALLDATA" --rpc-url "$RHC_RPC_URL"
# from a second signer
cast send "$TIMELOCK" "approve(uint256)" "$ID" --rpc-url "$RHC_RPC_URL"
# once the delay has passed
cast send "$TIMELOCK" "execute(uint256)" "$ID" --rpc-url "$RHC_RPC_URL"
```

Confirm it landed:

```sh
cast call "$AGENT_REGISTRY" "admin()(address)" --rpc-url "$RHC_RPC_URL"    # the timelock
cast call "$AGENT_REGISTRY" "pendingAdmin()(address)" --rpc-url "$RHC_RPC_URL"  # zero
```

**Resolvers.** Disputes cannot be heard until the token set is deployed and resolvers bond.
Each posts at least `Staking.minBondOf(resolver)` in BRSR through `OracleRegistry.register`, and
until `BURSAR_RESOLVER_QUORUM` of them are live every dispute fails and the payer is refunded,
less the resolver fee. For a payee that has not released a lock yet, that means a dispute nobody
can hear returns the payment to the payer. Have the full roster bonded before any lock is taken,
and keep it above quorum.

**Where the money goes on a disputed lock.** The resolver fee leaves the escrow for the
oracle registry, which splits it evenly between the resolvers who ruled within the deviation
band; they collect it with `claimRewards`. The dispute bond goes back to whoever opened the
dispute if the ruling moved materially their way, and otherwise joins that reward. When no
resolver rules, a bond posted by the payer is returned; a bond posted by the payee is not.

**Records.** Keep `broadcast/Deploy.s.sol/<chainId>/run-latest.json`. It carries every address
and transaction hash, and it is what a later bytecode check compares against.
