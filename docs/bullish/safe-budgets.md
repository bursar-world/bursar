# Budgets from a Safe

**The sentence:** a treasury gives its agents budgets from a Safe, and the Safe signs the approvals.

Branch `bullish/safe-budgets`. Built and walked on Robinhood Chain mainnet on 2026-10-10.

## What is live

- **Safe on Robinhood Chain.** Safe's canonical contracts are deployed on chain 4663 and the Safe app lists the
  chain, so a Safe there needs no custom network. Verified by reading code at every address and by Safe's own
  config service (chain 4663, "Robinhood Chain", short name `robinhood`, recommended master copy 1.5.0,
  transaction service `https://api.safe.global/tx-service/robinhood`). The transaction service indexes the chain:
  the example Safe's history and its signed messages appear in the Safe app.

  | Contract | Version | Address |
  |---|---|---|
  | Safe singleton | 1.4.1 | `0x41675C099F32341bf84BFc5382aF534df5C7461a` |
  | SafeL2 singleton | 1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
  | SafeProxyFactory | 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
  | CompatibilityFallbackHandler | 1.4.1 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |
  | MultiSend / MultiSendCallOnly | 1.4.1 | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` / `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
  | SignMessageLib | 1.4.1 | `0xd53cd0aB83D845Ac265BE939c57F53AD838012c9` |
  | SafeL2 singleton | 1.5.0 | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` (the version the Safe app creates by default) |
  | 1.3.0 canonical and eip155 sets | 1.3.0 | both present, at Safe's standard addresses |

- **The contracts need no change.** A mandate's owner signs in two places, the approval that clears a payment at or
  above the threshold (`spendApproved`) and a relayed limit change (`setLimitsWithAuthorization`). Both go through
  OpenZeppelin's `SignatureChecker`: a key is recovered, a contract is asked through ERC-1271. The forge suite
  already covers a Safe-style contract owner for both (`MandateAccountAuth.t.sol`,
  `test_contractPrincipalAuthorizesLimitsThroughErc1271`,
  `test_contractPrincipalClearsAnAboveThresholdSpendThroughErc1271`). Every other owner action is a plain
  transaction keyed by `msg.sender`, which a Safe sends like any wallet. No new factory, no deployment, no
  governance proposal. The live mandate below consumed a two-signature Safe approval on mainnet, which is the
  proof the tests predicted.

- **Nothing off chain checks an owner's signature with a key alone.** The audit of every `recover*` and
  `verify*` call in `apps/web`, `packages` and `services`: the resolver verifies delivery evidence and payer
  statements (`packages/sdk/src/evidence.ts`), signed by the payee on a lock and by the lock's payer, which is the
  mandate contract's agent side, never the owner; the facilitator verifies an x402 payer binding
  (`packages/core/src/binding.ts`), signed by the paying wallet. An owner's consent is verified on chain only, so a
  Safe owner is covered everywhere a key owner is.

- **The console signs through a Safe.** The approvals screen (`Sign it`) now understands a contract owner:
  inside the Safe app, a Safe with one owner signs and the approval appears at once; a Safe with more owners
  hands back nothing until the others confirm, so the console computes the Safe message hash the owners are
  confirming and reads Safe's transaction service for Robinhood Chain until the threshold is met, then shows the
  finished approval ready for the agent. `Register it on chain` is explained as the path for a Safe connected any
  other way. Verified end to end against the live service: a message posted by one owner is found under the hash
  the console computes, the second owner's confirmation completes it, and the prepared signature the service
  returns is accepted by the Safe on chain. Below the threshold the service already returns a partial signature,
  which the console refuses until the count reaches the Safe's threshold.

- **The console can be opened inside the Safe app.** The console sent `frame-ancestors 'none'` on every route,
  which blocked the Safe app from framing it, so the Safe connector in the wallet picker could never connect.
  The policy now allows `https://app.safe.global` and nothing else, and `/manifest.json` is served with the
  CORS header Safe requires of a custom app.

- **A demo page**, `/demo/safe-budgets`, walks a Safe owner through both routes and lists the live example with
  every transaction.

- **A script**, `packages/sdk/scripts/safe-budgets.ts`, runs the whole thing from Safe's protocol kit with no app
  and no transaction service: deploys a 2-of-3 Safe, then from it creates a mandate, funds it, raises a limit,
  seats an agent, registers an approval, signs one off chain, lets the agent pay with it, pauses, withdraws and
  resumes. Two owners sign each Safe transaction; the Safe refunds the sender's gas, so the treasury pays its own
  way. Idempotent: every transaction lands in `docs/bullish/safe-budgets/record.json` and a rerun skips what is
  done.

## The live example

Safe `0x053C8E803fBB862d6465399f69001A9b58Cdf4fe` (Safe 1.4.1, owners payer, payee and film owner, threshold 2),
mandate `0x98B59693751d14f9067A7C321276b0F27Fb03bAc`, agent `0xd140FA73F66b3F51250906b259E6FaaF8f7469b3`.

| Step | Sent by | Signed by | Transaction |
|---|---|---|---|
| Deploy the Safe | payer | payer | [0xe6ebf1c2…9da0](https://robinhoodchain.blockscout.com/tx/0xe6ebf1c2a0b9e29d283ea07228aa86d06a18768bf14307e2e833ac04ee9c9da0) |
| 0.0002 ETH to the Safe for gas | payer | payer | [0x2baf272e…77c1b](https://robinhoodchain.blockscout.com/tx/0x2baf272ee573c6155be6f97f329a2242bb590f06bb986e128260e11268d77c1b) |
| $0.50 USDG to the Safe | payer | payer | [0x1d83d8ac…5ac7a6](https://robinhoodchain.blockscout.com/tx/0x1d83d8ac181c82d326b1a892dfa56d6290820911525b8dd74fd21c9a095ac7a6) |
| Create the mandate | the Safe | payer, payee | [0xc89eba3f…bc0f5](https://robinhoodchain.blockscout.com/tx/0xc89eba3f5c98b7df44c6a7eb67344293f5fd0a4d8aaa868fba28d96be16bc0f5) |
| Fund it with $0.50 (approve and deposit, one batch) | the Safe | payer, payee | [0x55ecb7b8…e5fb1](https://robinhoodchain.blockscout.com/tx/0x55ecb7b81a6d20d7b054616ba360e622b0dadc027bcb71415dc2c909f29e5fb1) |
| Raise the per-payment cap from $0.20 to $0.25 | the Safe | payer, payee | [0xd435c4b1…dfd98b6](https://robinhoodchain.blockscout.com/tx/0xd435c4b19aadca4f541a67bc8da038f678566bed27f37af6c812586f2dfd98b6) |
| Seat the agent, allow the payee and the capability (one batch) | the Safe | payer, payee | [0x749fa6e9…27cff1](https://robinhoodchain.blockscout.com/tx/0x749fa6e9486bb9cbabc061a867237488ecb9f02e929b112af1a7063c1627cff1) |
| Allow the capability under its service class | the Safe | payer, payee | [0x739ccb27…ed3967](https://robinhoodchain.blockscout.com/tx/0x739ccb27f53cac06a85bfa38ba50e8a80c24f9945ac8fe4a4d4a239316ed3967) |
| Register an approval for $0.10 | the Safe | payer, payee | [0xaab3a9ee…f3c6ef7](https://robinhoodchain.blockscout.com/tx/0xaab3a9eedea09d8a811aa6bdc553a3a42ea50f53e83ae1608dbf587a8f3c6ef7) |
| The agent pays the payee $0.10 with a Safe-signed approval (escrow 33) | agent | payer, payee signed the message | [0xba03af06…dd7d1d8](https://robinhoodchain.blockscout.com/tx/0xba03af06bffd9c7d75616653d73686a350ef8921f89933e516dbad490dd7d1d8) |
| Pause the mandate | the Safe | payer, payee | [0x4cbcf4a2…cbb5c8e](https://robinhoodchain.blockscout.com/tx/0x4cbcf4a2e4f20c860f62c99d01fdd2a82ca3e04dd0df4410db034f0adcbb5c8e) |
| Withdraw $0.05 to the Safe | the Safe | payer, payee | [0x0aa2683c…4af9688](https://robinhoodchain.blockscout.com/tx/0x0aa2683c696a53c8f90e636db72dfced06cc771be9486b61acb106cae4af9688) |
| Resume the mandate | the Safe | payer, payee | [0x677d95f9…f4a7df6](https://robinhoodchain.blockscout.com/tx/0x677d95f9e4c0e1310a3dbbceaea2086df89810ac051f8393b0e89a3a7f4a7df6) |

Two more transactions belong to the walk and are kept in the record: the first creation attempt reverted inside
the Safe because the gas forwarded to the factory was estimated for the call alone and not for the Safe's own
64/63 check ([0x7dc5b351…f0080](https://robinhoodchain.blockscout.com/tx/0x7dc5b35156c749381cd9cef8fbd2b4e50813c7402944926dd159c7b7d15f0080),
fixed in the script), and an approval was first registered under the bare capability label rather than the
service-class id a payment carries ([0x0312c725…cd853c](https://robinhoodchain.blockscout.com/tx/0x0312c725b7ce2ca0c1741878a41b0f92b02c3654b0f5ad1184f11588f5cd853c),
superseded by the one above). The signed approval that cleared the payment is in the record as `signedApproval`
with both owners' signatures and the Safe's ERC-1271 answer; a second signed approval, posted to Safe's
transaction service to verify the console's collection path, shows in the Safe app under Messages as
`SpendApproval`, confirmed 2 of 2.

Spend for the build: 0.000134 ETH in gas across every transaction (the payer's net gas after the Safe's refunds
was 0.0000082 ETH), 0.0002 ETH moved to the Safe of which 0.000085 ETH remains there, 0.00002 ETH to the agent,
and $0.50 USDG, of which $0.35 sits in the mandate, $0.05 is back in the Safe and $0.10 went to the payee.

## The demo

Watch: `/demo/safe-budgets` on the console lists the example and both routes. Run:

```
source ops/rhc-env.sh
pnpm --filter @bursar/sdk exec tsx scripts/safe-budgets.ts
```

The script reads `~/.config/bursar/keystore/{payer,payee,film-owner,film-agent-2}` with the password file
`ETH_PASSWORD` names. A rerun against the committed record does nothing on chain and prints every link. A fresh
walk needs `SAFE_BUDGETS_SALT=<new name>` and an empty `SAFE_BUDGETS_RECORD` path, and costs about what the table
above shows. `SAFE_BUDGETS_STOP_AFTER=<step>` runs up to one named Safe transaction and stops, which is how the
recording was made.

In the Safe app: open `https://app.safe.global/apps/open?safe=robinhood:<your safe>&appUrl=https://app.bursar.world`
once the console deploys with this branch (the custom app needs the manifest and the frame policy from here), then
use the console exactly as a key owner would.

## Post assets

- `docs/bullish/safe-budgets/01-budgets-from-a-safe.png`: the demo page.
- `02-safe-owned-mandate.png`: the Safe-owned mandate in the console, limits raised to $0.25 per payment.
- `03-paused-by-the-safe.png`: the same mandate after the Safe's two-signature pause landed.
- `04-approvals-registered-by-the-safe.png`: the approvals screen with the $0.10 approval the Safe registered.
- `05-safe-app-history.png`: the Safe app's history for the Safe on Robinhood Chain, the pause expanded, signed 1/2
  and 2/2, executed.
- `06-safe-app-home.png`: the Safe app's dashboard for the Safe, 2/3 owners.
- `07-safe-app-signed-approval.png`: the Safe app's Messages tab, a `SpendApproval` for the mandate confirmed 2/2.
- `demo.webm` (27 s, 1440×900): the mandate page, the Safe's pause going through with two signatures, the page
  reading "Spending is paused".
- `record.json`: every transaction, signer set and the signed approval.

## Links

- Branch diff: https://github.com/bursar-world/bursar/compare/main...bullish/safe-budgets
- Script: https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/packages/sdk/scripts/safe-budgets.ts
- Console, Safe signing: https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/apps/web/src/app/(app)/console/lib/safe-signing.ts
  and https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/apps/web/src/app/(app)/console/%5Bmandate%5D/approvals/approvals-view.tsx
- Console, demo page: https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/apps/web/src/app/(app)/demo/safe-budgets/page.tsx
- Console, frame policy and manifest: https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/apps/web/next.config.ts
  and https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/apps/web/public/manifest.json
- Record: https://github.com/bursar-world/bursar/blob/bullish/safe-budgets/docs/bullish/safe-budgets/record.json
- The Safe on the explorer: https://robinhoodchain.blockscout.com/address/0x053C8E803fBB862d6465399f69001A9b58Cdf4fe
- The Safe in the Safe app: https://app.safe.global/home?safe=robinhood:0x053C8E803fBB862d6465399f69001A9b58Cdf4fe
- The mandate: https://robinhoodchain.blockscout.com/address/0x98B59693751d14f9067A7C321276b0F27Fb03bAc and
  `/console/0x98B59693751d14f9067A7C321276b0F27Fb03bAc`
- Transactions: in the table above, one per Safe-signed step.

## What the operator must do

1. Push `bullish/safe-budgets` and open the pull request to `main`. No governance action, no new contract, no
   Render change: the console change ships with the next web deploy.
2. After the deploy, open the console once inside a Safe on Robinhood Chain
   (`https://app.safe.global/apps/open?safe=robinhood:<safe>&appUrl=https://app.bursar.world`) with an owner's
   wallet and confirm it connects; Safe will show the manifest's name and mark. This is the one step this build
   could not perform: it needs an owner's key inside a browser wallet in the Safe app.
3. Optional, for discovery: submit the console to Safe's app list (`safe-global/safe-apps-list`), which wants the
   manifest, the icon and a short description; until then owners add it as a custom app by URL.
4. The example Safe's three owners are the demo keys; nothing more to fund.

## Limits

- A Safe signs approvals only from inside the Safe app. Connected through a browser wallet or WalletConnect, a
  Safe sends transactions but cannot sign messages, and the console says so and offers `Register it on chain`.
- Collecting a multi-owner signature in the console depends on Safe's transaction service for Robinhood Chain.
  If it is unreachable the console keeps checking and says so; registering on chain needs no service.
- The in-app flow is verified at the protocol level (the message hash, the service's answers and the Safe's
  on-chain acceptance) and not by a click-through in the Safe app with a browser wallet; see operator step 2.
- Hidden owners (stealth mandates) take an ordinary key by design and are not covered.
- Safe's app creates new Safes at 1.5.0 by default; the script deploys 1.4.1 through protocol-kit 8.0.7. Both
  answer ERC-1271 the same way; the mandate does not care which.

## The announcement

**One line.** A treasury can run its agents' budgets from a Safe on Robinhood Chain: the Safe creates the mandate,
funds it, sets the limits and signs the approvals.

**One paragraph.** Bursar mandates can now be owned by a Safe. A Safe on Robinhood Chain creates the mandate,
funds it, sets its limits, seats the agent and pauses or withdraws, each as one Safe transaction confirmed by the
owners the Safe requires. A payment above the threshold waits for the Safe: the owners sign the approval as a
message in the Safe app and the mandate verifies it through ERC-1271, or they register it on chain. The console
opens inside the Safe app, and the same flow runs from code with Safe's protocol kit. Every step of the live
example, a 2-of-3 Safe running a mandate end to end, is on chain.

**One post.** Treasuries hold funds in a Safe for a reason: no single key moves money. Bursar mandates now keep
that rule for agent spending. A Safe on Robinhood Chain creates a mandate, funds it with USDG, sets the per-payment
and daily limits, seats the agent, and later pauses it or takes the balance back, each as a Safe transaction the
owners confirm. When the agent needs a payment above the threshold, the owners sign the approval in the Safe app;
the mandate checks the Safe's answer through ERC-1271 and the agent pays once with it. The console runs inside the
Safe app, and a treasury run from code does the same with Safe's protocol kit. We walked a 2-of-3 Safe through all
of it on mainnet: create, fund, change a limit, seat, approve, pay, pause, withdraw, resume, two signatures every
time, with the Safe paying its own gas. The transactions are linked from the demo page.

## Progress

- 17:30 Facts verified: Safe 1.4.1, 1.3.0 (canonical and eip155) and the 1.5.0 L2 singleton have code on 4663;
  Safe's config service lists chain 4663 with a transaction service; the known 1-of-1 Safe is 1.4.1+L2. The
  contracts already verify owners through `SignatureChecker` with forge coverage for a contract owner. Off-chain
  signature checks audited: none verifies an owner.
- 17:45 Mainnet walk: Safe deployed from protocol-kit; create, fund, limits, seat, capability, approval, signed
  approval consumed by the agent's payment. Two fixes on the way, both recorded above.
- 17:50 Console: Safe-aware `Sign it`, collection through the transaction service, demo page, `/demo` route
  allowed by the middleware. Forge 1098 green after a Prague build; SDK vitest green; web typecheck green.
- 22:30 Resumed after a rate limit. Recording and screenshots made; the collection path verified against the
  live transaction service, which showed the partial-signature case; console fixed to wait for the threshold.
  Pause, withdraw and resume landed. The frame policy that blocked the Safe app found and fixed, manifest added.
