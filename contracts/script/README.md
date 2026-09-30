# Deploying Bursar

The scripts in this directory deploy the Bursar contract set, check it against what was intended,
and move an earlier deployment's state into a new one. Every script stops before it sends anything
when what it was given does not hold together, and every deploy script has a companion that asks
the chain the same questions afterwards. You do not need to have read the contracts.

| Document | Covers |
|---|---|
| This page | How a deployment is described, the scripts in order, every parameter, the checks, and what each refusal means. |
| [`TOKEN-README.md`](TOKEN-README.md) | BRSR, vesting, staking, the buyback and the BRSR/USDG market. |
| [`MIGRATION.md`](MIGRATION.md) | Moving from the current deployment on Robinhood Chain to the new set, step by step. |

Amounts in USDG are micro-USD: USDG has six decimals, so `1000000` is one dollar. BRSR has
eighteen, so `1e18` is one token. Durations are seconds and rates are basis points.

## 1. How a deployment is described

**The record.** One JSON file per deployment, under `deployments/`, validated by
[`deployments/schema.json`](../deployments/schema.json). It names the chain, the settlement asset,
the contracts the deployment uses but did not deploy (`external`), who holds each role (`roles`),
and, as the scripts run, every contract they deploy and every figure they applied (`parameters`).
`BURSAR_RECORD` points the scripts at it.

**The parameter file.** The figures each script applies: fees, windows, caps, bonds, and the few
operators a script records the first time it needs them. `script/env/rhc-mainnet-v3.env` holds
the Robinhood Chain values and `script/env/local.env` the local rehearsal's.

Four rules follow from that split.

- **Addresses come from the record.** A script reads the contracts earlier scripts deployed from
  the record, never from the shell. It stops with `NotRecorded` when one is missing and with
  `NotContract` when the record names an address with no code.
- **A role is read from the shell once.** When the record does not name a role yet, the first
  script that needs it reads it from the environment and records it. After that the record
  answers, and a shell that names a different address stops the run with `RecordMismatch`.
- **Nothing is deployed twice.** A script refuses to deploy what the record already names, with
  `AlreadyRecorded`. An entry with no code behind it is a broadcast that never landed and is
  replaced without asking. `BURSAR_FORCE=1` replaces a live one.
- **A simulation writes nothing.** Without `--broadcast`, every check runs against the live chain
  and the record is left as it was, so the next script reads what is really there.

**The chain.** Every script checks that the record's `chainId` is the chain it is talking to. A
record with `"local": true` is a rehearsal. Scripts run it only with `BURSAR_LOCAL=1` set, and only
against a node whose `web3_clientVersion` says anvil: a rehearsal chain answers as 4663 too, so the
chain id alone cannot keep a rehearsal record off Robinhood Chain. A mainnet record runs only
without the flag, so a stray flag cannot rehearse against it, and its chain has to be Robinhood
Chain, 4663. Testnet 46630 answers, but USDG holds no contract there, so nothing on it can settle.

**The deploy key.** The record names the key the deployment signs with as `deployer`, or the first
script records the key it ran with, and every deploy script refuses any other key with
`WrongDeployer`. The one-shot setters that wire the contracts together answer only to the key that
deployed them.

**Records over time.** `status` is `planned` while contracts are still to deploy, `live` while the
deployment answers for its chain, and `superseded` or `retired` once another has replaced it. A
retired record keeps its history, names its successor in `supersededBy` and says why in `retired`.
The address book the apps read resolves addresses from live records only.

**Namespaces.** Every variable can carry a prefix. Set `BURSAR_ENV_PREFIX` and each script reads
`<prefix>BURSAR_RECORD` and so on, which is how two deployments share one shell.

## 2. Before you start

**Tools.** Foundry 1.8.1 and the dependencies, as [`../README.md`](../README.md) describes, and
`jq`. Run every command from `contracts/`.

**Keys.** Each key signs from a Foundry encrypted keystore. No private key appears in a command, a
variable or a file in this repository. Point Foundry at the password file with `ETH_PASSWORD` and
name the keystore with `--keystore`; Foundry reads the rest on its own.

**Funding.** Gas is ETH and settlement is USDG, two different assets held at different scales. The
deploy key needs ETH for gas and at least 1 USDG, which the core run checks as proof that the
record's settlement asset is the one the system will settle in. It spends none.

**Governance.** Three timelock signers and a guardian. The deploy key may not be a signer, the
guardian may not be one either, and at least one signer has to be a contract unless the run
acknowledges a signer set of three plain keys (section 5).

## 3. The scripts, in order

| Script | Deploys | Then |
|---|---|---|
| `Deploy.s.sol` | `AdminTimelock`, `Reputation`, `Escrow`, `OracleRegistry`, `AgentRegistry`, `MandateAccountFactory` | `VerifyCore.s.sol` |
| `DeployToken.s.sol` | `BRSR` and `Vesting`, on a chain that has neither | `VerifyToken.s.sol` |
| `DeployStaking.s.sol` | `Staking`, `Buyback`, and a `V4LiquiditySeeder` when the BRSR/USDG pool is open | `VerifyStaking.s.sol` |
| `SeedPool.s.sol` | opens the BRSR/USDG market on a chain where it is not open, or adds to it | `VerifyStaking.s.sol` |
| `DeployRwa.s.sol` | `AssetRegistry`, `PriceGuard`, `StockSpendRouter`, `TreasuryPark` and its two adapters | `VerifyRwa.s.sol` |
| `DeployCollateral.s.sol` | `CreditPool` and `CollateralVault`, bound to each other | `VerifyCollateral.s.sol` |
| `DeployPrivacy.s.sol` | `WithinMandateVerifier`, `CommittedMandateFactory`, `DisclosureRegistry`, `SolvencyLog` | `VerifyPrivacy.s.sol` |
| `DeployShielded.s.sol` | the Privacy Pools verifiers and `Entrypoint`, `ShieldedPool` and `ShieldedRelay` | `VerifyShielded.s.sol` |
| `ProposeWiring.s.sol` | nothing: puts governance's wiring to the signers | `VerifyWiring.s.sol` |

`Verify.s.sol` runs every check in one pass. The `Migrate*.s.sol` scripts and
`RetireRecords.s.sol` move an earlier deployment into this one; [`MIGRATION.md`](MIGRATION.md)
gives their order.

Every contract answers to the timelock from its constructor, so no part of the set is ever
administered by the deploy key. What the deploy key keeps is the one-shot calls no constructor can
make, and each script spends them in its own run:

- `Deploy.s.sol` closes the three pairings between reputation, escrow and resolver registry, and
  names the timelock the escrow's pauser.
- `DeployToken.s.sol` writes the team's vesting schedule and closes it.
- `DeployStaking.s.sol` names the staking pool on the resolver registry, which puts resolver bonds
  in BRSR.
- `DeployCollateral.s.sol` binds the credit pool to its vault.
- `DeployShielded.s.sol` registers the pool on the Entrypoint, then hands the Entrypoint's owner
  role to the timelock and renounces it.

What is left is governance's, and `ProposeWiring.s.sol` puts all of it to the signers in one
batch: the buyback's keeper, each vetted resolver's bond floor, the staking rebate table, the
credit pool's two roles on the staking pool, credit manager and slasher, and, where
`SeedPool.s.sol` opened the market, the seeder it offered to the timelock.

## 4. Running a script

Simulate first. Without `--broadcast` nothing is sent and nothing is written, and every check still
runs against the live chain.

```sh
source script/env/rhc-mainnet-v3.env   # the figures, BURSAR_RECORD and RHC_RPC_URL
export ETH_PASSWORD=...                # the path of the file holding the keystore password
export KEYS="$HOME/.config/bursar/keystore"

forge script script/Deploy.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
```

`RHC_RPC_URL` is Robinhood Chain's public endpoint unless the shell already names another.

Then send it, one transaction at a time, and ask the chain what landed:

```sh
forge script script/Deploy.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" --broadcast --slow
forge script script/VerifyCore.s.sol --rpc-url "$RHC_RPC_URL"
```

The shielded pool hashes with two Poseidon libraries that are already on chain. The record names
them under `external`, the command links them, and the run stops unless the pool's code names
exactly those two:

```sh
forge script script/DeployShielded.s.sol --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer" \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")" \
  --broadcast --slow
```

The governance batch is one script run per signer: propose from one, approve from a second, and
execute from any once the delay has passed. Each step can be run again; a call already proposed,
approved or applied is skipped. `--sig "status()"` shows where each call stands.

```sh
forge script script/ProposeWiring.s.sol --sig "propose()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast
forge script script/ProposeWiring.s.sol --sig "approve()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2" --broadcast
forge script script/ProposeWiring.s.sol --sig "execute()" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1" --broadcast
```

Run early, `execute()` sends nothing and says for each call when it can run:

```text
not executable yet: #0 Buyback.setKeeper. The delay ends 2026-09-28 11:53:20 UTC, in 60 minutes: run execute() again then.
```

## 5. Parameters

Every figure below is in `script/env/rhc-mainnet-v3.env`, with the value the Robinhood Chain
deployment uses. Where the value says `record`, the Robinhood Chain record already names the
address under `roles`, and the variable is read only on a chain whose record does not. A variable a
script needs and cannot find stops it with `MissingEnv`, and one it cannot read, such as `1%` for a
figure in basis points, with `InvalidEnv`, which names the variable and what it holds. Either way
nothing is deployed on a value nobody chose. Each script writes the figures it applied into the
record's `parameters`, which is what the verify scripts hold the chain to.

### `Deploy.s.sol`

| Variable | Value | Meaning |
|---|---|---|
| `BURSAR_TIMELOCK_PERIOD` | `3600` | Seconds between two signers agreeing and the change taking effect. One hour in this development deployment. Stakes and bonds take seven days to leave whatever it is. |
| `BURSAR_TIMELOCK_SIGNER_1` to `_3` | record | The three signers, recorded under `roles.timelockSigners`. |
| `BURSAR_TIMELOCK_GUARDIAN` | record | Pauses an administered contract at once and can do nothing else. |
| `BURSAR_TREASURY` | record | Receives the protocol fee, swept from the escrow by anyone and only ever to this address. |
| `BURSAR_SLASH_SINK` | record | Receives slashed resolver bonds and agent stake. |
| `BURSAR_ALLOW_EOA_GOVERNANCE` | set in the shell | Must read `i-accept-eoa-governance` for a signer set with no contract in it. A phrase rather than `true`, because `true` arrives in a shell by accident. |
| `BURSAR_ADMIN_TIMELOCK` | optional | A live timelock to join instead of deploying one. The record's, when it names one, and the two have to agree. |
| `BURSAR_FEE_BPS` | `100` | The protocol's share of a settlement, taken from the payee's side only. |
| `BURSAR_RESOLVER_FEE_BPS` | `50` | Taken from a disputed payment for the resolvers who ruled on it. |
| `BURSAR_DISPUTE_BOND_BPS` | `500` | What opening a dispute costs, as a share of the disputed amount. |
| `BURSAR_MIN_TTL`, `BURSAR_MAX_TTL` | `300`, `604800` | The shortest and longest deadline a payment may carry. |
| `BURSAR_DISPUTE_WINDOW` | `3600` | How long after a release the payer can still complain. The payee has been paid, so the complaint opens no dispute on the registry, takes no bond and is never ruled on: it goes on the payee's history, as the [ruling policy](../../docs/RULING-POLICY.md) says. |
| `BURSAR_MIN_LOCK` | `10000` | The smallest payment, one cent, so the bond on any disputed payment is at least one unit. |
| `BURSAR_CAP_BASE`, `BURSAR_CAP_PER_SCORE`, `BURSAR_CAP_MAX` | `25000000`, `2250000`, `250000000` | What one payee can be paid: 25 USDG with no history, 2.25 USDG more per point of reputation, up to 250 USDG at a perfect score of 100. |
| `BURSAR_COMMIT_WINDOW`, `BURSAR_REVEAL_WINDOW` | `3600`, `3600` | An hour to commit a sealed score and an hour to reveal it. |
| `BURSAR_UNBONDING_PERIOD` | `604800` | Seven days between a resolver asking for its bond back and collecting it. |
| `BURSAR_RESOLVER_QUORUM` | `2` | Reveals needed for a ruling to count. |
| `BURSAR_MAX_VOTERS` | `64` | Commitments admitted per dispute, so every seated resolver can vote. |
| `BURSAR_MAX_DEVIATION` | `20` | Score points from the consensus before a vote is an outlier. |
| `BURSAR_RESOLVER_SLASH_BPS` | `1000` | Share of an outlier's or a silent resolver's bond taken. |
| `BURSAR_DEPLOY_AGENT_REGISTRY` | `true` | Deploys the agent registry. With it, the escrow pays registered, active payees only. A payee registers under a name of 3 to 32 characters from `A-Z`, `a-z`, `0-9` and `_`. |
| `BURSAR_AGENT_MIN_STAKE`, `BURSAR_AGENT_SLASH_BPS` | `5000000`, `1000` | Providers stake 5 USDG to be paid through the escrow. A ruling never touches the stake: only governance can take from it, by a proposal that names the amount, and never more than a tenth at once. |

A payment that is disputed leaves through the resolver registry, which always has an exit open once
the reveal window closes, so there is no dispute timeout to set.

### `DeployStaking.s.sol`

| Variable | Value | Meaning |
|---|---|---|
| `BURSAR_STAKING_UNBONDING_PERIOD` | `604800` | Seven days to leave the staking pool. |
| `BURSAR_STAKING_MIN_BOND` | `1e27` | The bond floor for anyone governance has not named one for. More BRSR than exists, so nobody can bond until governance names a floor for a vetted resolver. |
| `BURSAR_RESOLVER_BOND_FLOOR` | `30000e18` | The floor governance names for each recorded resolver: 30,000 BRSR. |
| `BURSAR_RESOLVERS` | record | The vetted resolvers, recorded under `roles.resolvers`. |
| `BURSAR_BUYBACK_KEEPER` | first resolver | The only key that can trigger a buyback. Named by governance in the wiring batch. |
| `BURSAR_BUYBACK_POOL_FEE`, `_TICK_SPACING`, `_HOOKS` | `3000`, `60`, zero | The BRSR/USDG pool the buyback trades, fixed in the buyback for good. The manager and the StateView come from the record's `external`. |
| `BURSAR_BUYBACK_SPEND_PER_CALL` | `500000` | 0.50 USDG a buy. |
| `BURSAR_BUYBACK_MAX_SPEND_PER_WINDOW` | `5000000` | 5 USDG a window. |
| `BURSAR_BUYBACK_MIN_SPEND` | `100000` | Nothing under 0.10 USDG. |
| `BURSAR_BUYBACK_MAX_PRICE_MICRO_USD_PER_BRSR` | `240` | Never more than 240 micro-USD for one BRSR: the pool's price of 200 plus a fifth. Trusted for seven days after governance sets it. |
| `BURSAR_BUYBACK_WINDOW`, `BURSAR_BUYBACK_MIN_INTERVAL` | `86400`, `3600` | The spend cap resets daily, and buys are at least an hour apart. |

### The lanes

| Variable | Value | Meaning |
|---|---|---|
| `BURSAR_LENDER` | the deploy key | `DeployCollateral.s.sol`. The only address that can take unlent USDG out of the credit pool, and the one that carries its losses. Never inferred from the key that signs. |
| `BURSAR_SOLVENCY_POSTER` | the deploy key | `DeployPrivacy.s.sol`. The key the solvency service posts with. |
| `BURSAR_ASP_POSTMAN` | `0x731F…4bbe` | `DeployShielded.s.sol`. The key the association-set service posts roots with. Never the deploy key or the timelock. |
| `BURSAR_SHIELDED_RELAYER` | `0xc8FB…9630` | `DeployShielded.s.sol`. The relayer the apps send withdrawals through. |

The RWA assets come from the record's `external.assets`, and the terms each trades under from
`script/lib/RwaConfig.sol`: the treasury fund SGOV with a 0.5% band, and SPY, NVDA and AAPL as
stocks, each on its pinned pool. The collateral lane's caps, rates and tiers are in
`script/lib/CollateralConfig.sol`: 100 USDG of debt in total, 10 USDG per mandate. Committed
mandates share a lifetime ceiling of 25 USDG each. The shielded pool takes deposits from 1 to 100
USDG, holds at most 1,000 USDG, keeps 0.10% of each deposit, and lets a relayer charge up to 5%.

## 6. Checking a deployment

Each verify script reads the record and asks the chain what its deploy script asked its own
simulation, and sends nothing. Every question has one of three answers:

- **match**: nothing to say;
- **owed**: a value governance or a later step still has to set, found unset. Listed, and fatal
  only with `BURSAR_VERIFY_STRICT=1`, which is how the last check of a deployment runs;
- **mismatch**: anything else, including a governed value set to something other than what the
  record intends. A proposal that named the wrong address is worse than none.

A run asks every question before it fails, so one run names every problem, and ends with a line
such as `staking: 0 mismatched, 6 owed`. Any mismatch, or anything owed under strict, fails it
with `VerificationFailed(mismatches, owed)`. `VerifyCore.s.sol` asks each read so that a contract
unable to answer it is a mismatch naming the read and the address: a record that names the wrong
contract gets a list of what disagrees rather than a bare revert.

What is owed straight after a deploy script is expected, and each line names the step that
settles it. The local rehearsal settles all of it and ends on a strict check with nothing owed.

## 7. What the scripts refuse

Each refusal is a named error, raised before the first transaction is sent or in the simulation
that runs before anything is broadcast.

| Error | What it means |
|---|---|
| `MissingEnv`, `InvalidEnv`, `EnvOutOfRange`, `EnvIntOutOfRange`, `EnvNotBoolean` | A variable is unset, holds something that does not read as its type, is too large for its field, or is not spelled `true` or `false`. `InvalidEnv` and `EnvNotBoolean` carry the value they could not read. |
| `RetiredEnv` | A variable from an older parameter set is still in the shell. The error names it and what replaced it. |
| `WrongChain`, `RecordChainMismatch`, `LocalFlagMismatch` | The chain, the record and `BURSAR_LOCAL` do not agree. |
| `NotAnvil` | A rehearsal record was pointed at a node that is not anvil. The error carries what the node calls itself. |
| `NotRecorded`, `NotContract`, `NoAnswer` | Something the script builds on is missing from the record, has no code, or does not answer the read that identifies it. |
| `AlreadyRecorded` | The record already names what this script deploys. |
| `RecordMismatch` | The shell names an address the record disagrees with. |
| `WrongDeployer` | The key is not the record's deploy key. |
| `TimelockPeriodZero`, `TimelockNotContract` | Governance executes immediately, or is not there. |
| `AssetNotContract`, `AssetDecimalsMismatch`, `AssetNotUsdg` | The settlement asset is not a six-decimal token, or on 4663 is not USDG. |
| `AssetPaused`, `AddressFrozen`, `SettlementBalanceTooLow` | USDG is paused, has frozen an address the deployment pays, or the deploy key holds under 1 USDG. |
| `FeeSplitTooLarge`, `DisputeBondTooLarge`, `BaseCapZero` | The escrow's figures leave nothing to pay a payee, cannot be posted, or cap every new payee at zero. |
| `DeployerIsTimelockSigner`, `RoleCollision` | One address holds two roles that have to be apart. |
| `GovernanceHasNoMultisig`, `EoaGovernanceNotAcknowledged` | No signer is a contract and the phrase is missing or wrong. |
| `NotBrsr`, `OracleRegistryNotReady` | The recorded token is not BRSR, or the resolver registry was deployed by another key, is already wired, or settles in another asset. |
| `PoolHookNotContract`, `DynamicFeePoolRejected`, `PoolFeeTooLarge`, `TickSpacingOutOfRange` | The buyback's pool key describes a pool v4 would not accept, or one whose hook could set its fee. |
| `PriceCeilingNotAPrice`, `BondFloorZero` | The ceiling is a figure in some other unit, or the resolvers' floor is zero. |
| `AssetKindMismatch`, `PoolIdMismatch`, `PoolNotOpen`, `OneTreasuryAsset` | An RWA asset's record disagrees with its terms, its pool is not the one measured, or not open. |
| `NoTier`, `BuybackStakingMismatch` | A collateral asset has no tier, or the buyback compounds into a different staking pool than the one the credit pool slashes. |
| `WiringFailed`, `ParameterNotApplied` | A setter or constructor argument did not take effect. The error gives the value expected and the value found. |
| `NotSigner` | The governance batch was run from a key that is not a signer. |

The token script's own refusals are in [`TOKEN-README.md`](TOKEN-README.md), and the move's in
[`MIGRATION.md`](MIGRATION.md).

## 8. Rehearsing

Two rehearsals run the real scripts with the real commands, each against an anvil of its own.
Neither reads a private key: every transaction is signed by anvil for the account it names.

```sh
script/local/rehearse.sh             # a fresh local chain, on port 8546
script/local/rehearse-mainnet.sh     # a fork of Robinhood Chain as it stands, on port 8549
```

`rehearse.sh` builds the contracts, starts anvil answering as chain 4663, places stand-ins for the
outside contracts with `script/local/LocalFixtures.s.sol`, which also writes a local record, and
runs every deploy script with its check. It opens the BRSR/USDG market with `SeedPool.s.sol`, runs
the wiring batch through the timelock from the signers' own accounts, funds the credit pool, runs
the full check under `BURSAR_VERIFY_STRICT=1`, which has to find nothing owed, and runs one flow
per lane. The last line it prints says it passed, or names the step it stopped at. The build, the
record and the transaction logs live in a directory of the run's own under `cache/bursar`, and go
when it exits, with the chain they describe. `BURSAR_ANVIL_PORT` moves it off 8546.

`rehearse-mainnet.sh` forks mainnet and runs the move in [`MIGRATION.md`](MIGRATION.md), step by
step, as each real key.

### By hand on anvil

Every step of `rehearse.sh` can be run one at a time against a chain you keep, which is how to
watch one script or try a change. Start anvil in a terminal of its own. It listens on 8545 unless
told otherwise, and `rehearse.sh` uses 8546, so the two never share a node.

```sh
anvil --chain-id 4663
```

Then, from `contracts/` in a second terminal:

```sh
source script/env/local.env
rpc=http://127.0.0.1:8545
send() { local script="$1" sender="$2"; shift 2; forge script "$script" --rpc-url "$rpc" --unlocked --sender "$sender" --broadcast "$@"; }
check() { forge script "$1" --rpc-url "$rpc"; }

# The stand-ins and the local record, from anvil's account 9, so the deploy key starts at nonce 0.
send script/local/LocalFixtures.s.sol 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

send script/Deploy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCore.s.sol
send script/DeployToken.s.sol "$BURSAR_DEPLOYER"
check script/VerifyToken.s.sol
send script/DeployStaking.s.sol "$BURSAR_DEPLOYER"
check script/VerifyStaking.s.sol

# The market, from the liquidity key. The stand-in USDG lets anyone mint, which is how a local
# account is funded.
cast send "$(jq -r .settlementAsset "$BURSAR_RECORD")" "mint(address,uint256)" "$BURSAR_BRSR_LIQUIDITY" 25000000 \
  --from "$BURSAR_BRSR_LIQUIDITY" --unlocked --rpc-url "$rpc"
BURSAR_SEED_PRICE_MICRO_USD=200 BURSAR_SEED_USDG_MICRO=25000000 send script/SeedPool.s.sol "$BURSAR_BRSR_LIQUIDITY"

send script/DeployRwa.s.sol "$BURSAR_DEPLOYER"
check script/VerifyRwa.s.sol
send script/DeployCollateral.s.sol "$BURSAR_DEPLOYER"
check script/VerifyCollateral.s.sol
send script/DeployPrivacy.s.sol "$BURSAR_DEPLOYER"
check script/VerifyPrivacy.s.sol

# The shielded lane's proofs were made for a pool at the address the deploy key creates from nonce
# 10,000, 0x2710. Leave this out if you will not run the lanes; a mainnet run never needs it.
cast rpc anvil_setNonce "$BURSAR_DEPLOYER" 0x2710 --rpc-url "$rpc"
send script/DeployShielded.s.sol "$BURSAR_DEPLOYER" \
  --libraries "vendor/poseidon-solidity/PoseidonT3.sol:PoseidonT3:$(jq -r .external.PoseidonT3 "$BURSAR_RECORD")" \
  --libraries "vendor/poseidon-solidity/PoseidonT4.sol:PoseidonT4:$(jq -r .external.PoseidonT4 "$BURSAR_RECORD")"
check script/VerifyShielded.s.sol

# The wiring batch. execute() runs once the timelock's hour has passed, which anvil's clock skips.
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "propose()"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_2" --sig "approve()"
cast rpc evm_increaseTime 3601 --rpc-url "$rpc"
cast rpc evm_mine --rpc-url "$rpc"
send script/ProposeWiring.s.sol "$BURSAR_TIMELOCK_SIGNER_1" --sig "execute()"
check script/VerifyWiring.s.sol

# The lender's first cash, then the whole set held to done, then every lane.
send script/MigrateCredit.s.sol "$BURSAR_LENDER" --sig "fund(uint256)" 10000000
BURSAR_VERIFY_STRICT=1 check script/Verify.s.sol
BURSAR_LOCAL_RPC="$rpc" forge test --match-path test/script/LocalChain.t.sol -vv
```

`local.env` sends forge's build to `cache/bursar/local/out`, its transaction logs to
`cache/bursar/local/broadcast` through `FOUNDRY_BROADCAST`, and the endpoints it keeps for
`--resume` to `cache/bursar/local/cache`. By default those are `out/`, `broadcast/<script>/4663/`
and `cache/<script>/4663/`, where a real run keeps its own, and anvil answers as 4663 too: a local
run writing there would replace the log a stopped mainnet step resumes from. The first command in a
new shell builds from scratch. `local.env` also clears `ETH_PASSWORD`, because while it is set forge
expects a keystore and refuses `--unlocked`. The record is `cache/bursar/local/local-4663.json`, and
`LocalFixtures.s.sol` writes it afresh, so against a new anvil start again from that line.

The same deployment runs in process in `forge test`: `test/script/EndToEnd.t.sol` takes it through
the same steps, each deploy script has a suite of its own, and the suites under `test/script/fork`
deploy onto a fork of Robinhood Chain when `BURSAR_RHC_FORK_RPC` is set. A suite that skips says
why, as in `[SKIP: skipped: BURSAR_RHC_FORK_RPC is unset; ...]`.
