# Moving Bursar to 48-hour governance

This runbook moves the fourth Bursar contract set on Robinhood Chain from the one-hour timelock it
was deployed with to a 48-hour `AdminTimelock` whose three signers are hardware wallets. It is
written for the people who hold the keys. Every step is a script in this directory that can be
simulated against the live chain before it sends anything, except the new timelock's own side, which
the hardware keys sign line by line, and the whole sequence has been rehearsed on a copy of mainnet
with the same scripts and arguments.

## What changes

- **A new timelock, and nothing else new.** One `AdminTimelock` with a 48-hour delay, three
  hardware signers and the guardian the set has today. No contract is redeployed and no money moves,
  apart from the community allocation of BRSR, which the old timelock holds and hands to the new one.
- **Every administered contract answers to the new timelock:** reputation, the resolver and agent
  registries, the staking pool, the buyback, the asset registry, the treasury park, the credit pool,
  the collateral vault, the solvency log and the vesting contract, each by its own two-step
  handover; the seeder that holds the BRSR/USDG position, by its ownership handover; and the
  shielded Entrypoint, whose owner role the new timelock takes and then takes away from the old one.
- **The escrow keeps the old timelock as its pauser.** The escrow names its pauser once, through a
  setter the deploy key spent when the set went live, and the pauser can pause and unpause the
  escrow and nothing else. The old timelock keeps that one power, its signers keep their keystores
  for it, and the guardian pauses the escrow through it. The record names it as
  `contracts.escrowPauser`.
- **The record follows the chain, last.** Only once every contract answers to the new timelock does
  the record name it, with the hardware addresses as its signers and `dev` turned off. The apps
  read governance from the live record, so they move when the record is published.

## Before you start

**Tools.** Foundry 1.8.1 and the dependencies, installed as [`../README.md`](../README.md)
describes, and `jq`. Run everything from `contracts/`. The hardware side needs the device plugged in
and unlocked, with its Ethereum app open.

**Keys.** The deploy key and the old timelock's two signers sign from their encrypted keystores, as
in [`MIGRATION.md`](MIGRATION.md): the operations key tooling exports `ETH_PASSWORD` and Foundry
reads the rest. The three new signers are hardware wallets. `cast` drives a Ledger with `--ledger`
and a Trezor with `--trezor`; a device that holds the account at a path other than the first adds
`--mnemonic-derivation-path`. Nothing in this runbook asks for a private key.

| Key | Address | Signs |
|---|---|---|
| `rh-deployer` | `0x6B6fC40Ed9652728A9B620C4e1B05fBF4F9712a4` | the new timelock's deployment, and the record |
| `signer-1`, `signer-2` | `roles.timelockSigners` in the record | the old timelock's batch |
| hardware 1, 2 and 3 | `BURSAR_SIGNERS_48H`, read off each device | the new timelock's batch: any two propose and approve, any one executes |

Read each hardware address off its device before anything else, and check it against the list the
operator supplied:

```sh
cast wallet address --ledger                                   # the first account on the device
cast wallet address --ledger --mnemonic-derivation-path "m/44'/60'/1'/0/0"   # another account
```

**Balances.** Every key needs ETH for gas. In the rehearsal the deploy key used about 1.6 million
gas, the first old signer 3.9 million, the second 0.9 million, the hardware key that proposes and
executes 2.8 million and the one that approves 0.8 million. At the 0.031 gwei the chain charged
when this was written that is under 0.0002 ETH for the busiest key. Put 0.001 ETH on each hardware
address before step 4, which covers the whole batch several times over. No USDG or BRSR is needed:
the BRSR the batch moves is the old timelock's own.

**The shell.** Every command below runs in one shell set up like this. Start it fresh.

```sh
cd contracts
source script/env/rhc-mainnet-v4.env        # the figures, BURSAR_RECORD and RHC_RPC_URL
export BURSAR_SIGNERS_48H=0x...,0x...,0x...  # the three hardware addresses, in signer order
export BURSAR_ALLOW_EOA_GOVERNANCE=i-accept-eoa-governance   # hardware keys are plain keys too
export KEYS="$HOME/.config/bursar/keystore"

# Simulates against the live chain and sends nothing. Every check in the script still runs.
simulate() { local script="$1" key="$2"; shift 2; forge script "$script" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/$key" "$@"; }
# The same run, sent one transaction at a time.
send() { simulate "$@" --broadcast --slow; }
# Reads the chain against the record. Needs no key.
verify() { forge script "$@" --rpc-url "$RHC_RPC_URL"; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }
at() { jq -r "$1" "$BURSAR_RECORD"; }
```

The guardian of the new timelock is the record's guardian unless `BURSAR_GUARDIAN_48H` names
another. The new signers may not include the guardian or the deploy key, and have to be three
distinct addresses. Run every `send` as a `simulate` first, with the same arguments, and read what
it prints.

## Rehearse first

```sh
script/local/rehearse-governance.sh
```

It forks mainnet as it stands and runs the steps below in order, with the same scripts and
arguments. The deploy key and the old signers sign as themselves through the fork's impersonation,
and three placeholder addresses stand in for the hardware keys, whose side the script
`AcceptGovernance.s.sol` runs for them; the delays are skipped on the fork's clock.
It writes a copy of the record under `cache/bursar/governance`, and builds and logs its
transactions there too, never in `out/`, `broadcast/` or `cache/`, where the real run keeps the
logs `--resume` reads. It ends by printing the gas each key used and one line saying it passed.
Start only when it does. If the chain has moved since, run it again.

## The steps

| Step | Who signs | Then wait |
|---|---|---|
| 1. Deploy the 48-hour timelock | deploy key | |
| 2. The old timelock offers everything | signer 1, signer 2 | |
| 3. The offer lands | any old signer | one hour after step 2 |
| 4. The new timelock accepts | hardware 1 proposes, hardware 2 approves | |
| 5. The acceptance lands; the record follows | any hardware key, then the deploy key | 48 hours after step 4 |
| 6. Publish the record | nobody | |

### 1. Deploy the 48-hour timelock

```sh
send script/HandoverGovernance.s.sol rh-deployer --sig "deploy()"
verify script/VerifyCore.s.sol
```

The run refuses a signer set that is not three distinct keys, one that includes the guardian or the
deploy key, and a record that already names a 48-hour timelock. It writes the new timelock under
`governance48` in the record and changes nothing under `contracts` or `roles`: the set is still
the old timelock's, and `VerifyCore.s.sol` still passes against it.

```sh
new="$(at .governance48.AdminTimelock)"
readback "$new" "timelockPeriod()(uint64)"                   # 172800
readback "$new" "getSigners()(address[3])"                   # the three hardware addresses
readback "$new" "guardian()(address)"                        # the guardian
readback "$new" "proposalCount()(uint256)"                   # 0
```

### 2. The old timelock offers everything

```sh
send script/HandoverGovernance.s.sol signer-1 --sig "propose()"
send script/HandoverGovernance.s.sol signer-2 --sig "approve()"
verify script/HandoverGovernance.s.sol --sig "status()"
```

Fourteen proposals on the old timelock: `transferAdmin` to the new timelock on each of the eleven
administered contracts, `transferOwnership` on the seeder, `grantRole(OWNER_ROLE)` to the new
timelock on the Entrypoint, and the transfer of the old timelock's whole BRSR balance, the community
allocation, read when the transfer is first proposed. Both runs can be repeated: a call already
proposed, approved or applied is skipped. `status()` shows each proposal with its approvals and
the time its delay ends.

### 3. The offer lands

One hour after step 2:

```sh
send script/HandoverGovernance.s.sol signer-1 --sig "execute()"
verify script/HandoverGovernance.s.sol --sig "status()"
```

Run early, `execute()` sends nothing, names when the delay ends and fails with `DelayNotPassed`.
Then read the offers back. Nothing has changed hands yet: each contract still answers to the old
timelock and only names the new one as pending.

```sh
old="$(at .contracts.AdminTimelock)"
readback "$(at .contracts.Reputation)" "pendingAdmin()(address)"           # the new timelock
readback "$(at .token.Vesting)" "pendingAdmin()(address)"                  # the new timelock
readback "$(at .rwa.collateral.CreditPool)" "pendingAdmin()(address)"      # the new timelock
readback "$(at .token.V4LiquiditySeeder)" "pendingOwner()(address)"        # the new timelock
readback "$(at .privacy.shielded.Entrypoint)" "hasRole(bytes32,address)(bool)" "$(cast keccak OWNER_ROLE)" "$new"   # true
readback "$(at .token.BRSR)" "balanceOf(address)(uint256)" "$new"          # the community allocation, 800000000000000000000000000
readback "$(at .token.BRSR)" "balanceOf(address)(uint256)" "$old"          # 0
```

### 4. The new timelock accepts

The new timelock's side is thirteen proposals: `acceptAdmin()` on each of the eleven contracts,
`acceptOwnership()` on the seeder, and `revokeRole(OWNER_ROLE)` of the old timelock on the
Entrypoint. Each is proposed by one hardware key, approved by a second, and executed by any once
the 48 hours have passed. Proposing counts as the proposer's approval, so each proposal takes one
approval more. The script prints every line to paste:

```sh
verify script/HandoverGovernance.s.sol --sig "handover()"
```

For each call it prints the target, the selector, the calldata, the proposal id the call gets when
the lines run in the printed order, and three commands. The first is signed by hardware key 1:

```sh
cast send "$new" "propose(address,bytes)" <target> <calldata> --rpc-url "$RHC_RPC_URL" --ledger
```

Thirteen of those, in the printed order, then thirteen approvals from hardware key 2, with the id
each proposal got:

```sh
cast send "$new" "approve(uint256)" <id> --rpc-url "$RHC_RPC_URL" --ledger
```

Each `cast send` asks the device to confirm one transaction; the device shows the timelock's
address, the function and the arguments. A Trezor takes `--trezor` in place of `--ledger`. If a
proposal went out of order, run `handover()` again: it prints the id each call actually got, and
marks the ones already applied. The same batch as a script is `AcceptGovernance.s.sol`, which
`forge script` can only run through impersonation on a fork; its `status()` reads the chain and
needs no key:

```sh
verify script/AcceptGovernance.s.sol --sig "status()"
```

The console's governance page proposes catalogue actions on the timelock the live record names,
which is the old one until step 6, and its catalogue has `acceptAdmin` for five of these contracts
and nothing for the seeder, the Entrypoint or the RWA lane. It cannot do this step. Use the lines.

### 5. The acceptance lands; the record follows

48 hours after step 4, and within 14 days of it, the execution lines, from any hardware key, in
the printed order, the revoke last:

```sh
cast send "$new" "execute(uint256)" <id> --rpc-url "$RHC_RPC_URL" --ledger
```

The revoke takes the old timelock's owner role on the Entrypoint away, and the new timelock has to
hold that role itself to do it, so its proposal is listed last and executes last. Then read the
handover back, and write the record:

```sh
readback "$(at .contracts.Reputation)" "admin()(address)"                  # the new timelock
readback "$(at .token.Staking)" "admin()(address)"                         # the new timelock
readback "$(at .token.Vesting)" "admin()(address)"                         # the new timelock
readback "$(at .token.V4LiquiditySeeder)" "owner()(address)"               # the new timelock
readback "$(at .privacy.shielded.Entrypoint)" "hasRole(bytes32,address)(bool)" "$(cast keccak OWNER_ROLE)" "$old"   # false
readback "$(at .contracts.Escrow)" "pauser()(address)"                     # the old timelock, as before

send script/HandoverGovernance.s.sol rh-deployer --sig "finish()"
BURSAR_VERIFY_STRICT=1 verify script/Verify.s.sol
```

`finish()` sends nothing. It checks on chain that every one of the thirteen handovers landed and
that the old timelock holds no BRSR, then writes `contracts.AdminTimelock`, the signers and the
guardian as the new governance's, `contracts.escrowPauser` as the old timelock, the 48-hour delay
under `parameters`, `dev: false` and a note. It takes `--broadcast` because a simulation writes no
file, and refuses with `NotHandedOver`, naming the contract, while any acceptance is missing. The
strict check must end `0 mismatched, 0 owed`.

```sh
jq -r '.contracts.AdminTimelock, .contracts.escrowPauser, .dev, .parameters.AdminTimelock.timelockPeriod' "$BURSAR_RECORD"   # new, old, false, 172800
```

### 6. Publish the record

Commit the record under `deployments/`, and regenerate the address book the apps and services
read, from the repository root:

```sh
pnpm --filter @bursar/core codegen
```

Once the apps are redeployed, the governance page shows the new timelock, its 48-hour delay and the
hardware signers, and proposes to it; the monitor watches its proposals and the new signers' gas
from the record. Then check the live record the way anyone can:

```sh
script/check-live.sh
```

Nothing else needs doing in the console. The old signers' keystores stay where they are: the
escrow's pauser is still the old timelock, so an unpause of the escrow is a proposal on it, and the
guardian's brake on the escrow runs through it too.

## If a step stops

A refusal stops a step before it sends anything: every check runs in the simulation Forge makes
before it broadcasts. Fix what it names and run the same command again. A step that already landed
says so and sends nothing. A hardware line that the device rejects sends nothing either; run the
same line again.

| It says | What to do |
|---|---|
| `SignerCountMismatch`, `DuplicateSigner` | `BURSAR_SIGNERS_48H` does not name exactly three distinct addresses. |
| `RoleCollision` | A new signer is the guardian or the deploy key. Name another. |
| `GovernanceHasNoMultisig` | The acknowledgement is missing from the shell. Export it as "The shell" above shows. |
| `AlreadyRecorded` | The record already names the 48-hour timelock. Step 1 ran before; go on to step 2. |
| `WrongDeployer` | `deploy()` or `finish()` is signing with a key other than the record's deploy key. |
| `NotSigner` | The keystore is not one of the old timelock's signers. |
| `not executable yet`, `DelayNotPassed` | The call cannot run yet. The line says why: the delay, with the UTC date it ends and the time left, or an approval still missing. Run `execute()` again then. |
| `ProposalExpired`, or `handover()` lists a call as still to propose after it was proposed | The old or the new timelock kept the proposal open for 14 days after its delay and it lapsed. Propose it again and wait out the delay afresh. |
| `TimelockNotExpired` from a `cast send` | The 48 hours since the proposal have not passed. |
| `InsufficientApprovals` from a `cast send` | The second hardware key has not approved that id. |
| `NotHandedOver` | A contract still answers to the old timelock, or the Entrypoint's owner role still sits with it. The error names which, and what was expected. Finish step 5's lines first. |
| `StillHeld` | The old timelock holds BRSR. Its signers can move it to the new timelock by proposal; `BURSAR_FORCE=1` writes the record anyway. |
| `VerificationFailed` | A check found a mismatch, or, under `BURSAR_VERIFY_STRICT=1`, something still owed. Each one is listed above the error. |
