# Operations runbook

How Bursar on Robinhood Chain (chain 4663) is watched, and what to do when a check fails. Written
for whoever is on call. Every address comes from the live record,
`contracts/deployments/rhc-mainnet-v4.json`; every command below is exact and sends nothing unless
it says `cast send`. The roles the commands exercise are listed in
[GOVERNANCE.md](../GOVERNANCE.md#privileged-roles), and the conditions the checks defend are in
[INVARIANTS.md](INVARIANTS.md).

## If funds are at immediate risk

Who to reach, in this order:

1. **The guardian key.** One transaction, with no approvals and no delay, pauses the escrows, the
   resolver and agent registries, the staking pool and the buyback ([Pause](#pause)). Pause first
   and establish the cause afterwards; an unpause is a proposal with the full delay.
2. **Two timelock signers.** Everything beyond a pause, from an unpause to rotating a key, is a
   proposal that needs two of the three signers and waits out the delay
   ([A parameter change through the timelock](#a-parameter-change-through-the-timelock)).
3. **The reporter.** Reports come to hello@bursar.world, with `URGENT` in the subject when funds
   are at risk, and through the repository's GitHub security advisories. A reporter who could not
   reach us may come through the SEAL 911 war room (https://securityalliance.org/seal-911);
   answer there, then move to email.

A pause never stops an exit: money already held in a lock can still be released, refunded, ruled
on and claimed, a principal can withdraw from or revoke its own mandate, and a shielded pool
depositor can always ragequit. Matured staking exits are the one hold, for at most seven days.
Mandate accounts, the factories, the credit pool, the collateral vault, the treasury park, the
shielded pool and the relay have no pause.

## Set up a shell

Everything runs from `contracts/`. Keys sign from the Foundry keystores under `$KEYS`, named as
the records name them (`signer-1` to `signer-3`, `guardian`, `rh-deployer`, `resolver-1` to
`resolver-3`); set `ETH_PASSWORD` as [`script/README.md`](../contracts/script/README.md) describes.
No private key is ever typed.

```sh
cd contracts
source script/env/rhc-mainnet-v4.env            # BURSAR_RECORD and RHC_RPC_URL
export KEYS="$HOME/.config/bursar/keystore"
at() { jq -r "$1" "$BURSAR_RECORD"; }
readback() { cast call --rpc-url "$RHC_RPC_URL" "$@"; }

timelock="$(at .contracts.AdminTimelock)"   escrow="$(at .contracts.Escrow)"
oracle="$(at .contracts.OracleRegistry)"    agents="$(at .contracts.AgentRegistry)"
staking="$(at .token.Staking)"              buyback="$(at .token.Buyback)"
pool="$(at .rwa.collateral.CreditPool)"     vault="$(at .rwa.collateral.CollateralVault)"
entrypoint="$(at .privacy.shielded.Entrypoint)"
```

If `https://rpc.mainnet.chain.robinhood.com` does not answer, `https://robinhood.drpc.org` serves
the same chain; it refuses log queries over 10,000 blocks.

## What is monitored and why

`contracts/script/monitor.mjs` reads the live record and the chain, prints one line per check,
exits non-zero on any `alert`, and posts the warnings and alerts to `BURSAR_ALERT_WEBHOOK` when
that is set. `.github/workflows/monitor.yml` runs it every hour; a failed run is the alert when no
webhook is configured. Run it by hand from the repository root:

```sh
pnpm install --frozen-lockfile --filter @bursar/core
node contracts/script/monitor.mjs
```

| Check | Why |
|---|---|
| Timelock proposals: created in the last two hours, pending, executable, near expiry | A proposal is the only way any parameter changes. One nobody on the team made is an incident. |
| Guardian pauses and executions in the last two hours, and the pause flag on every pausable contract | A pause stops new payments; a pause nobody knows about is an outage. |
| Facilitator gas float, shielded relayer, postman, resolvers, the price guard's keeper, signers and guardian: ETH balances | Each key pays gas in ETH. An empty key cannot settle, relay, post, observe, vote or pause. |
| Shielded pool fill against its 1,000 USDG cap, and whether a root has been posted since the last deposit | At the cap, deposits refuse, as does a deposit that would take one address past 250 USDG in seven days. Without a current root, no note can be withdrawn. |
| Each price feed's age against the 26-hour trade bound and the 100-hour collateral bound | Past 26 hours trades refuse; past 100 hours collateral counts as zero and liquidation defers. |
| Credit pool: cash, debt, utilisation, bad debt | Debt above cash means draws refuse; bad debt means a line was written off and the lender carries it. |
| The price guard's reading of each collateral asset's pool: the age of the sample in force against the one-hour bound | A draw and a liquidation sale both count a position only against a reading between five minutes and an hour old, and only the keeper writes one. No reading in force means the keeper has stopped, and every draw and sale on the lane halts with it. |
| The balance of every contract that holds funds (escrow USDG, credit pool cash, shielded pool, buyback USDG, staking and timelock BRSR, each asset in the vault), against the previous run's | A balance that fell by more than a quarter and more than one unit in an hour is an outflow to account for. |
| Open disputes on the escrow and their reveal window | A dispute nobody finalises leaves a payment frozen. |
| Buyback price ceiling age, and solvency log age | A stale ceiling stops buybacks; a missed day on the solvency log means the poster is down. |

Thresholds are constants at the top of the script and of `monitor-state.mjs` beside it, each with a
comment. `BURSAR_MONITOR_STATE` names the file where a run keeps the balances the next run compares
against, one in the OS temp directory by default; the workflow carries it from one hourly run to the
next in the actions cache. A first run with no file reports `ok` and records the figures.

The collateral keeper is a separate job, run every five minutes, that takes the price guard's
reading of each asset's pool. A draw, and a liquidation sale, count a position only against a reading
between five minutes and an hour old, so if the keeper stops for an hour every draw and every sale
halts until it runs again; repayments, and withdrawals from a line with no debt, go on. The monitor
reports the reading's age under `reading <asset>`, and the keeper's gas under `price guard keeper`. Its report, and how it is scheduled,
are in [`services/facilitator/README.md`](../services/facilitator/README.md#the-collateral-keeper).

## Alerts and the first response

| Alert | Threshold | First response |
|---|---|---|
| New proposal | Any `ProposalCreated` in the last two hours | Read its target and calldata (`readback "$timelock" "getProposal(uint256)((address,bytes,uint64,uint64,bool,bool))" "$id"`). If nobody on the team made it, veto it: `cancel(id)` from two signers, below. |
| Proposal executable | `canExecute` is true | Execute it or let it lapse. It expires 14 days after its delay ends. |
| Pause in effect | `paused()` true on any pausable contract | Find out who paused and why. Unpause by proposal once the cause is settled, below. |
| Facilitator gas float low | Below `FACILITATOR_GAS_FLOAT_MINIMUM_ETH` (0.004 ETH by default) | Top up, below. Settlements on the wallet lane stop when it empties; verification and the mandate lane continue. |
| Relayer low | Below 0.0005 ETH, the relayer's own health floor; warn below 0.002 ETH | Top up. Relayed withdrawals and gas drops stop when it empties; deposits and ragequits are unaffected. |
| Postman, resolver or keeper low | Below 0.0001 ETH (the resolver service's own floor); signers and guardian below 0.0002 ETH | Top up. A guardian with no gas cannot pause, and a price guard keeper with none takes no reading, which halts the lane within the hour. |
| Pool near cap | Above 80% of 1,000 USDG | Nothing to fix. Deposits refuse at the cap by design, and one address is held to 250 USDG in any seven days whatever the fill. |
| Root behind deposits | A deposit after the last posted root for longer than the ten-minute posting cadence, or deposits with no root at all | Association-set root, below. |
| Feed stale | Age over 26 hours inside the equities session (Monday 01:00 UTC to Saturday 00:00 UTC); over 100 hours at any time | Stale feed, below. Over 26 hours at a weekend is expected and reported `ok`. |
| Credit pool | Utilisation over 90%, cash under one full line (10 USDG), or bad debt above zero | Liquidation, below. Bad debt is the lender's loss and never a staker's or a mandate's. |
| Reading expired | No aged sample on the price guard for a collateral asset, or one older than an hour | Every draw and liquidation sale on that asset halts until the keeper observes twice, five minutes apart. Check the `bursar-keeper` cron's last runs on Render and the keeper's gas; run a pass by hand with `BURSAR_KEEPER_EXECUTE=1` as [`services/facilitator/README.md`](../services/facilitator/README.md#the-collateral-keeper) shows. |
| Reading near expiry | The aged sample is older than 50 minutes: the keeper has missed a pass | The same checks. Draws still count while the sample is under an hour old. |
| Large outflow | A fund-holding balance fell by more than 25% of the previous run's figure and by more than one unit (USDG, BRSR or shares) since that run | Find the transaction that moved it on the explorer. A withdrawal, release, buyback or liquidation the team knows about ends it. Anything else is an incident: pause what still holds funds with the guardian, below, and read the timelock's proposals. |
| Dispute window | Reveal window ends within 20 minutes with fewer than two reveals, or closed over an hour ago with the dispute still open | Resolver, below. |
| Buyback ceiling stale | Now past `ceilingSetAt + maxCeilingAge` (seven days) | Restate it with `Buyback.setParams`, as [`MIGRATION.md`](../contracts/script/MIGRATION.md#5-the-handover-lands) shows. Buybacks refuse until it lands. |
| Solvency log stale | Latest epoch older than two days, or none | Check the solvency service; `bursar-solvency post --dry-run` shows what it would post. |

## Where to look

- The console's status page, [app.bursar.world/status](https://app.bursar.world/status), reports
  each condition a payment depends on from the chain. The governance page,
  [app.bursar.world/governance](https://app.bursar.world/governance), lists proposals and lets a
  signer or the guardian act.
- Service health, each on its own host and port (defaults in brackets; every route off loopback
  needs the service's auth token):

  | Service | Route | Answers |
  |---|---|---|
  | Facilitator (127.0.0.1:8402) | `GET /healthz`, `GET /readyz` | Gas float as `balanceWei` and `minimumWei`, RPC providers, trust queue and migrations; readiness is 503 when it cannot serve a request. |
  | Underwriter (127.0.0.1:8403) | `GET /healthz`, `GET /readyz` | Up; and ready when a mandate is bound, its journal claimed and the chain answered. |
  | Resolver (private, port 10000) | `GET /health`, forwarded as `https://app.bursar.world/api/rulings/health` | 200 while polling, 503 after three missed polls, with each registry served and its open disputes. |
  | Relayer (port 4321) | `GET /health` | `ok` (balance above 0.0005 ETH), `relayer`, `relay`, `balanceEth`. |
  | Association-set provider (port 4320) | `GET /health` | `ok`, `postman`, `lastRunAt`, `lastError`. |
  | Solvency | none | `bursar-solvency verify [epoch]` recomputes a posted root. |
  | Sidecar | none | JSON log lines. Alert on `gas_low`, `rpc_breaker_opened`, `rpc_all_providers_down`, `release_abandoned`, `finalize_abandoned`, `state_write_failed`, `claim_lost`, `output_input_mismatch`, `output_unreadable`. |

- Logs: every service writes one JSON object per line to stdout, kept by whatever runs the
  process. The resolver runs on Render as the private service `bursar-resolver` and pages through
  `BURSAR_ALERT_WEBHOOK`; its backup runner on the operator machine logs to
  `$HOME/Library/Logs/bursar-resolver-backup.log`. Keys are never logged.

## Pause

The guardian key pauses in one transaction, with no approvals and no delay. Pause everything the
incident touches in one call; a target that is already paused or has no `pause()` is skipped with
a `GuardianPauseSkipped` event and the rest still stop.

```sh
cast send "$timelock" "guardianPause(address[])" "[$escrow,$oracle,$agents,$staking,$buyback]" \
  --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/guardian"
for c in "$escrow" "$oracle" "$agents" "$staking" "$buyback"; do echo "$c $(readback "$c" "paused()(bool)")"; done
```

What a pause stops, and what it never stops:

| Contract | Paused: refused | Paused: still works |
|---|---|---|
| `Escrow` | New locks and new disputes. | Release, timeout refund, cancel, finalise, rulings landing, claims of owed payouts, fee sweeps. Money already held always has its exit. |
| `OracleRegistry` | New resolver registrations and bond top-ups, opening a dispute, committing a vote. | Reveals, `finalize`, `failDispute`, unbonding, reward claims. A vote already open still closes. |
| `AgentRegistry` | Registering, adding stake, requesting a withdrawal, reactivating. | Executing a matured withdrawal, deactivating, slashing by governance. |
| `Staking` | New stakes. Matured exits are held for at most `maxExitHold`, seven days into the pause, then reopen whether or not the pause has lifted. | Exit requests, reward claims, the credit pool's spread distribution, slashing. |
| `Buyback` | `buyback()`. | Governance sweeps. |

Nothing here reaches a mandate: a principal can pause, withdraw from or revoke its own mandate at
any time, and `MandateAccountFactory`, `CreditPool`, `CollateralVault`, `TreasuryPark`, the
shielded pool and the relay have no pause. The third set's escrow, `OracleRegistry` and
`AgentRegistry` answer to the same timelock; add their addresses from `rhc-mainnet-v3.json` to the
same call. The first and second sets have their own timelocks with the same guardian; pause them
the same way with their addresses from `rhc-mainnet.json` and `rhc-mainnet-v2.json`.

Unpausing is a proposal per contract, with the full delay:

```sh
data="$(cast calldata "unpause()")"
cast send "$timelock" "propose(address,bytes)" "$escrow" "$data" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
```

Then approve, wait and execute as in the next section. Repeat for each paused contract.

## A parameter change through the timelock

Four steps: one signer proposes, a second approves, the delay passes, any signer executes. The
delay is one hour on the current timelock and 48 hours on the first set's. An approved proposal
can run for 14 days after its delay ends, then has to be proposed again.

```sh
# 1. Propose. The calldata is the setter and its arguments; the target is the administered contract.
data="$(cast calldata "setKeeper(address)" 0xNEW_KEEPER)"
cast send "$timelock" "propose(address,bytes)" "$buyback" "$data" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
id="$(( $(readback "$timelock" "proposalCount()(uint256)") - 1 ))"

# 2. Approve from a second signer. Proposing already counted as the first approval.
cast send "$timelock" "approve(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2"

# 3. Wait. canExecute answers (true, 0x00000000) once it can run; otherwise the second word is the
#    error execute() would raise, 0x621e25c3 being TimelockNotExpired.
readback "$timelock" "canExecute(uint256)(bool,bytes4)" "$id"
readback "$timelock" "getProposal(uint256)((address,bytes,uint64,uint64,bool,bool))" "$id"   # executeAfter is the fourth field

# 4. Execute from any signer. A refusal carries the target's own error.
cast send "$timelock" "execute(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
```

Then run the post-deploy check, below. The same four steps run from the console's governance page
with a connected signer. The batches the deployment needs are scripts: `ProposeWiring.s.sol` and
`MigrateGovernance.s.sol` under `contracts/script/` take `--sig "status()"`, `"propose()"`,
`"approve()"` and `"execute()"`, skip what is already done, and say when a waiting call can run
([`script/README.md`](../contracts/script/README.md#4-running-a-script)).

To stop a proposal: its proposer calls `cancel(id)` alone; anyone else's needs `cancel(id)` from
two signers, the second of which cancels it.

```sh
cast send "$timelock" "cancel(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-2"
cast send "$timelock" "cancel(uint256)" "$id" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-3"
```

## Top up a float

Gas is ETH, a different asset from USDG at a different address. Read the balance, send ETH from a
funded team key, read it back.

```sh
relayer="$(at .privacy.shielded.relayer)"
cast balance "$relayer" --ether --rpc-url "$RHC_RPC_URL"
cast send "$relayer" --value 0.005ether --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
```

| Float | Floor | Top up to | Notes |
|---|---|---|---|
| Facilitator gas float (`FACILITATOR_GAS_FLOAT` in the facilitator's environment; `/healthz` reports `balanceWei` and `minimumWei`) | `FACILITATOR_GAS_FLOAT_MINIMUM_ETH`, 0.004 ETH by default | Twice the floor | Below the floor `/healthz` reports degraded and keeps answering; settles that broadcast stop when the key is empty. |
| Shielded relayer (`privacy.shielded.relayer`) | 0.0005 ETH (`/health` turns `ok` false) | 0.005 ETH | One gas drop is 0.00015 ETH, at most 20 an hour. |
| Association-set postman (`privacy.shielded.aspPostman`) | 0.0001 ETH | 0.001 ETH | One root post a day in normal use, at most one every ten minutes. |
| Resolvers (`roles.resolvers`) and the buyback keeper (`token.keeper`) | 0.0001 ETH per key (`RESOLVER_MIN_GAS_WEI`) | 0.001 ETH | A reveal at the last-chance mark is priced at three times the estimate; `finalize` carries at least 1.5M gas. |
| Timelock signers and guardian (`roles.timelockSigners`, `roles.guardian`) | 0.0002 ETH | 0.001 ETH | A pause or an unpause needs gas on the key that sends it. |

## A stale or halted price feed

Trades read the feed through `PriceGuard`. A feed older than 26 hours refuses stock purchases and
SGOV parks and unparks with `StalePrice`; a feed answering while the token's oracle, the token or
the access registry is paused refuses with `OraclePaused`, `TokenPaused` or `AccessPaused`; a pool
further from the feed than the asset's band refuses with `PoolPriceDeviation`. Collateral counts at
the feed while it is younger than 100 hours and the pool agrees; past that it counts as zero, and a
liquidation needs a fresh price to sell. The escrow lane is untouched by any of this.

1. Read the feed and the clock. SGOV posts once a day at 00:01 UTC and skips Sunday; stocks post
   through the equities session and pause over the weekend, so an age over 26 hours between
   Saturday 00:00 UTC and Monday 01:00 UTC is normal.

   ```sh
   for a in SGOV SPY NVDA AAPL; do
     feed="$(at ".rwa.assets.$a.feed")"
     echo "$a $(readback "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" | sed -n 2p) updated $(readback "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" | sed -n 4p)"
   done
   date -u +%s
   ```

2. Inside the session and past 26 hours: nothing to send. Trades refuse on their own and a parked
   position whose price has gone stale is passed over, so a spend falls back to the mandate's USDG.
   Watch the age; an SGOV feed silent past 100 hours zeroes parked and posted value.

3. A feed that has stopped for good, or has been replaced: by proposal, `AssetRegistry.setEligible`
   with `false` stops new trades in the asset while positions can still be sold out, and
   `CollateralVault.setAssetTier(asset, 0)` takes it out of collateral (positions still open count
   at a 100% haircut and can be sold from a line under 1.0). A new feed goes in with `setAsset`,
   carrying the asset's full configuration. Both are ordinary proposals with the one-hour delay.

## A resolver stops voting

The resolver service votes two of the three keys on every dispute and alerts at each step;
`https://app.bursar.world/api/rulings/health` is 503 once it has missed three polls. On the current
set a dispute has a one-hour commit window and a one-hour reveal window.

1. Read the dispute.

   ```sh
   lockId=…
   disputeId="$(readback "$oracle" "disputeIdOf(uint256)(uint256)" "$lockId")"
   readback "$oracle" "getDispute(uint256)((uint256,uint64,uint64,uint64,uint8,uint8,uint8,uint16,uint8,uint8))" "$disputeId"
   # escrowId, openedAt, commitEndsAt, revealEndsAt, commits, reveals, median, refundBps, shares, status (1 committing, 2 revealing, 3 finalized, 4 failed)
   ```

2. Inside the commit window with fewer than two commitments: restart the service (the Render
   service `bursar-resolver`; `RESOLVER_KEYS` or the keystores and `RESOLVER_PASSWORD_FILE` have
   to be in place). Only the service commits. A resolver that is a party to the lock is barred,
   and the service replaces it with the standby key.

3. Inside the reveal window with a commitment still sealed: reveal from the keystores with the
   backup runner, which needs no journal.

   ```sh
   RESOLVER_KEYSTORE_DIR="$KEYS" RESOLVER_PASSWORD_FILE=… \
   node services/resolver/bin/bursar-resolver-backup.mjs status "$disputeId"
   node services/resolver/bin/bursar-resolver-backup.mjs reveal-now "$disputeId"
   node services/resolver/bin/bursar-resolver-backup.mjs reveal-due     # every dispute in its reveal window
   ```

   It can run beside the live service: a reveal already made fails its simulation and nothing is
   sent twice.

4. After the reveal window: anyone closes the dispute. With two or more reveals, `finalize`
   rules; with fewer, `failDispute` reopens the lock with a fresh deadline and returns the bond.
   Both carry enough gas for the escrow call inside them.

   ```sh
   cast send "$oracle" "finalize(uint256)" "$disputeId" --gas-limit 1500000 --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
   cast send "$oracle" "failDispute(uint256)" "$disputeId" --gas-limit 1500000 --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
   ```

5. If a key is benched for gas or bond, top it up (above) or raise its bond from the resolver
   desk in the console. The floor is 30,000 BRSR; a silent or outlying vote costs 10% of it.

## The association-set root is not posted

The shielded pool takes a withdrawal proof only against the latest posted root. The provider
recomputes the set every 30 seconds and posts at most once every ten minutes, from the postman
key. Deposits never depend on it, and a depositor can always leave through ragequit.

```sh
readback "$entrypoint" "latestRoot()(uint256)"        # reverts NoRootsAvailable while nothing is posted
curl -s "$NEXT_PUBLIC_BURSAR_ASP_URL/health"          # the provider's URL as the console has it: ok, postman, lastRunAt, lastError
cast balance "$(at .privacy.shielded.aspPostman)" --ether --rpc-url "$RHC_RPC_URL"
node services/asp/bin/bursar-asp.mjs verify           # recomputes the set and compares it with the posted root
ASP_KEYSTORE=… ASP_PASSWORD_FILE=… node services/asp/bin/bursar-asp.mjs post --dry-run
```

1. `lastError` names the cause: an RPC that stopped answering, or a postman with no gas. Fix that,
   then `bursar-asp post` sends the root if it changed and the window is open; `bursar-asp run`
   keeps it going.
2. A proof made against the previous root fails with `IncorrectASPRoot`. The console proves again
   against the new root on its own; a wallet using the SDK calls `relayWithFreshProof`.
3. A lost postman key is rotated by proposal, below. Until it lands nothing new can be withdrawn,
   and nothing is at risk: the pool holds the notes, and ragequit returns a deposit to the wallet
   that made it.

## A credit-lane liquidation that does not clear

A line is liquidatable when `health(mandate)` reads below 1.0 (1e18). Anyone can call
`liquidate(mandate, asset)`; it sells only the slice that restores health to 1.05, repays the pool
and pays the caller 5% of the proceeds. The monitor reports the pool; the console shows each line.

```sh
mandate=…
readback "$vault" "account(address)(uint256,uint256,uint256,uint256,uint256)" "$mandate"   # value, adjusted, debt, headroom, health
readback "$pool" "debtOf(address)(uint256)" "$mandate"
cast send "$vault" "liquidate(address,address)" "$mandate" "$(at .rwa.assets.SPY.address)" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/rh-deployer"
```

| It reverts with | Meaning | Do |
|---|---|---|
| `Healthy` | Health is back at or above 1.0. | Nothing. |
| `StalePrice`, `OraclePaused`, `TokenPaused`, `AccessPaused`, `PoolPriceDeviation` | The price guard will not sell on this price. | Wait for the session or a fresh feed. The debt keeps accruing; the position is not sold blind. |
| `PositionEmpty` | The line holds none of that asset. | Pick another asset from `positions(mandate)`. |
| `NothingToSell` | The slice that would restore health rounds to nothing. | Try the asset with the largest position. |
| `SwapShort` | The pinned pool could not fill the slice inside the band. | Wait for depth, or sell a smaller line first; the next call recomputes the slice. |

Once nothing left on the line can be sold for anything, `liquidate` writes the remaining debt off:
`CreditPool.badDebt` rises, the lender carries it in USDG, and stakers are slashed for it only
through the pool's slash allowance. Debt can also be met directly by anyone with
`CreditPool.repay(mandate, amount)`, which pulls USDG from the caller; that is the lender's decision.

## Rotate a key

Each rotation on the timelock is itself a proposal with the full delay, so a lost key costs the
delay and nothing more. Fund the new key before the proposal executes.

```sh
# A signer: the index is its position in getSigners(). The new key may not be a signer or the guardian.
readback "$timelock" "getSigners()(address[3])"
data="$(cast calldata "updateSigner(uint256,address)" 2 0xNEW_SIGNER)"
cast send "$timelock" "propose(address,bytes)" "$timelock" "$data" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"

# The guardian. The new key may not be a signer.
data="$(cast calldata "setGuardian(address)" 0xNEW_GUARDIAN)"
cast send "$timelock" "propose(address,bytes)" "$timelock" "$data" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"

# The postman: grant the role to the new key, then revoke the old one. Two proposals on the Entrypoint.
role="$(cast keccak ASP_POSTMAN)"
cast send "$timelock" "propose(address,bytes)" "$entrypoint" "$(cast calldata "grantRole(bytes32,address)" "$role" 0xNEW_POSTMAN)" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
cast send "$timelock" "propose(address,bytes)" "$entrypoint" "$(cast calldata "revokeRole(bytes32,address)" "$role" "$(at .privacy.shielded.aspPostman)")" --rpc-url "$RHC_RPC_URL" --keystore "$KEYS/signer-1"
```

Approve, wait and execute each as above. Then restart the provider with the new key
(`ASP_KEYSTORE` or `ASP_PRIVATE_KEY`), read the roles back, and update `aspPostman` in the record.

```sh
readback "$entrypoint" "hasRole(bytes32,address)(bool)" "$role" 0xNEW_POSTMAN
readback "$timelock" "guardian()(address)"
```

The other service keys rotate the same way through their setters: `Buyback.setKeeper`,
`SolvencyLog.setPoster`, `CreditPool.setLender`, and for a resolver `Staking.setBondFloor` for the
new address (the old bond unbonds over seven days). The relayer needs no proposal: any key can
relay, so start the service on the new key and point the console's `NEXT_PUBLIC_BURSAR_RELAYER_URL`
at it. While a signer rotation is pending, the remaining two signers can still pass any proposal.

## After any deployment or parameter change

1. Run the post-deploy check, [`contracts/script/check-live.sh`](../contracts/script/check-live.sh).
2. Run the strict record check. It has to end `0 mismatched, 0 owed`:

   ```sh
   BURSAR_VERIFY_STRICT=1 forge script script/Verify.s.sol --rpc-url "$RHC_RPC_URL"
   ```

3. Run the monitor once and read every line.
4. If a record changed, regenerate the address book from the repository root with
   `pnpm --filter @bursar/core codegen`, commit it with the record, and add the change to
   [CHANGELOG.md](../CHANGELOG.md).
