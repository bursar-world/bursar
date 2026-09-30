# Bursar contracts

The Solidity contracts that hold and move money in Bursar. A principal's spending limits live in a
`MandateAccount`, so a payment past them reverts on chain. Payments to providers go through an
`Escrow` that holds each one for the life of one job, with an on-chain dispute path. Everything
that can be administered is administered by a two-of-three `AdminTimelock`, whose delay is one hour
today and 48 hours from launch. Agent stakes, resolver bonds and BRSR stakes take seven days to
withdraw whatever the delay, so a staked party sees a pending change but cannot leave before it
lands. The set is deployed on Robinhood Chain mainnet (chain 4663) and settles in USDG.

Read the status section of the root [README](../README.md) before funding anything on mainnet,
and [SECURITY.md](../SECURITY.md) before reporting a problem.

## Layout

| Path | What it holds |
|---|---|
| `src/MandateAccount.sol` | One principal's mandate: per-call, daily and monthly caps, allowed payees and capabilities, an approval threshold above which a human signs, and an agent key that can spend inside all of it. |
| `src/MandateAccountFactory.sol` | Creates mandate accounts at addresses a principal can compute before funding them. No admin. |
| `src/Escrow.sol` | Locks one payment per job, releases it to the payee, refunds on timeout or cancellation, and freezes it for a ruling on dispute. Its fee and windows are fixed at construction; the timelock can stop new payments and disputes, and nothing else. |
| `src/Reputation.sol` | Settlement history per payee, and the spending cap derived from it. |
| `src/OracleRegistry.sol` | Bonded resolvers who rule on disputes by commit-reveal vote, and their rewards and slashing. |
| `src/AgentRegistry.sol` | Staked directory of the payees a mandate may pay. |
| `src/AdminTimelock.sol` | Two-of-three governance with a delay, and a guardian that can only pause. |
| `src/token/` | `BRSR` (fixed supply), `Vesting`, `Staking` (resolver bonds, first-loss stake and fee rebates), `Buyback`, and `V4LiquiditySeeder`, which holds the BRSR/USDG position. |
| `src/rwa/` | Stock purchases and the treasury park, priced by feeds and checked against pinned pools, and the collateral lane: `CreditPool` lends to mandates against stock posted in `CollateralVault`. |
| `src/privacy/`, `src/zk/` | Committed mandates, whose terms are a commitment and whose spends are proven within them, disclosure grants and the solvency log. |
| `src/shielded/` | Shielded settlement on Privacy Pools: a USDG pool and a relay that screens recipients. |
| `script/` | The deploy scripts, each with a verify companion, the scripts that move one deployment into the next, and two rehearsals. Start with [`script/README.md`](script/README.md). |
| `deployments/` | One record per deployment on 4663: addresses, roles, the parameters applied, and the state read back. `schema.json` describes them. `@bursar/core` generates its address book from these files. |
| `test/` | Unit, fuzz and invariant tests. `test/script/` deploys through the real scripts and runs every lane; `test/script/fork/` does the same on a fork of Robinhood Chain. |
| `verification/` | The compiler input for each deployed contract, for source verification. |

## Build and test

Requires [Foundry](https://getfoundry.sh) 1.8.1, the release pinned in
[`.foundry-version`](.foundry-version), which CI installs as well. From this directory:

```sh
foundryup --install "$(cat .foundry-version)"
```

Foundry downloads solc 0.8.24 and 0.8.28 on the first build: Bursar's own contracts use 0.8.24, and
the vendored Privacy Pools code and the shielded contracts that import it use 0.8.28, the compiler
upstream was audited with (`compilation_restrictions` in `foundry.toml`).

`lib/` is not committed and there are no git submodules. Install the dependencies once, from this
directory:

```sh
forge install --no-git --shallow \
  foundry-rs/forge-std@1eea5bae12ae557d589f9f0f0edae2faa47cb262 \
  OpenZeppelin/openzeppelin-contracts@69c8def5f222ff96f2b5beff05dfba996368aa79 \
  OpenZeppelin/openzeppelin-contracts-upgradeable@723f8cab09cdae1aca9ec9cc1cfa040c2d4b06c1
```

These are forge-std v1.9.4, OpenZeppelin Contracts v5.1.0 and OpenZeppelin Contracts Upgradeable
v5.0.2, the exact sources the deployed bytecode was built from. CI installs them with the same
command, by commit, because a tag can be moved.

`vendor/` is committed and unmodified: Privacy Pools core v1.3.0 (0xbow, Apache-2.0,
commit `c312dcd`), zk-kit `lean-imt.sol` 2.0.0 (MIT) and `poseidon-solidity` 0.0.5 (MIT). The
shielded pool (`src/shielded/`) builds on it; see [NOTICE](../NOTICE). Then:

```sh
forge build
forge test
forge fmt --check
```

The suites under `test/script/fork/` deploy the contract set through the scripts onto a fork of
Robinhood Chain and run the lanes against live state: the feeds, the pinned pools, USDG and the
BRSR/USDG market. They skip unless `BURSAR_RHC_FORK_RPC` names an endpoint for chain 4663. They
fork the latest block, so the public endpoint serves them. A stock purchase needs the equities
feeds inside their trade bound, which they are through the 24/5 session, so the lanes that buy skip
at weekends.

```sh
BURSAR_RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/script/fork/*'
```

`test/script/LocalChain.t.sol` runs the lanes against a local rehearsal and skips unless
`BURSAR_LOCAL_RPC` is set; `script/local/rehearse.sh` sets it. A suite that skips prints the
reason next to `SKIP` in the test output.

`forge build` does not run the linter. CI runs it over the code that deploys, at high severity:

```sh
forge lint --severity high --deny warnings src script
```

It passes, printing nothing and exiting 0, when no high-severity finding is left in `src/` or
`script/`. Any finding fails it, and names the file and line. A finding that is there by design
carries an inline `forge-lint: disable-next-line(<lint>)` comment saying why. `forge lint` on its
own lists every finding, informational ones included.

CI also checks every deployable contract against the size limits a chain enforces, 24,576 bytes of
runtime code (EIP-170) and 49,152 of initcode (EIP-3860):

```sh
forge build --sizes --skip test
```

It prints each contract's two sizes and the margin left under each limit, and fails when a margin
is negative. `--skip test` leaves out the test contracts, which are never deployed.

After changing a contract's interface, regenerate the TypeScript ABIs with
`pnpm --filter @bursar/core codegen` from the repository root.

## Deploying

[`script/README.md`](script/README.md) covers how a deployment is described, every script in
order, every parameter and each condition under which a script refuses to run.
[`script/TOKEN-README.md`](script/TOKEN-README.md) covers BRSR, staking, the buyback and the market.
[`script/MIGRATION.md`](script/MIGRATION.md) is the runbook for moving the current deployment on
Robinhood Chain to the new contract set. Every key signs from an encrypted keystore; no private key
is ever passed on the command line.

## A payment and a dispute, with cast

The calls an agent, a provider, a principal and two resolvers make, one `cast` command at a time. Run
them from this directory on a local chain deployed as
[By hand on anvil](script/README.md#by-hand-on-anvil) describes, in the same shell, or in a new one
with `script/env/local.env` sourced. Anvil signs for any address once told to, so no key is read.
The addresses are fixed, so the walkthrough runs once on each chain.

```sh
rpc=http://127.0.0.1:8545
at() { jq -r "$1" "$BURSAR_RECORD"; }
tx() { local from="$1"; shift; cast send "$@" --from "$from" --unlocked --rpc-url "$rpc" >/dev/null; }
usdg="$(at .settlementAsset)" brsr="$(at .token.BRSR)" factory="$(at .contracts.MandateAccountFactory)"
escrow="$(at .contracts.Escrow)" agents="$(at .contracts.AgentRegistry)" oracle="$(at .contracts.OracleRegistry)"

# A principal, an agent and a provider, and two of the three resolvers the record seats, each with
# ETH for gas.
principal=0x0000000000000000000000000000000000003001
agent=0x0000000000000000000000000000000000003002
provider=0x0000000000000000000000000000000000003003
read -r first second _ <<<"$(at '.roles.resolvers | join(" ")')"
for who in "$principal" "$agent" "$provider" "$first" "$second"; do
  cast rpc anvil_impersonateAccount "$who" --rpc-url "$rpc" >/dev/null
  cast rpc anvil_setBalance "$who" 0xde0b6b3a7640000 --rpc-url "$rpc" >/dev/null
done

# The escrow pays listed providers only. The provider stakes 5 USDG to list; the stand-in USDG
# mints to anyone.
tx "$provider" "$usdg" "mint(address,uint256)" "$provider" 5000000
tx "$provider" "$usdg" "approve(address,uint256)" "$agents" 5000000
tx "$provider" "$agents" "register(string,uint128)" render_farm 5000000

# The mandate: 10 USDG a call, 50 a day and 200 a month, the principal's signature from 20 up,
# services and hires, no lifetime cap, lane 0. Its address is known before it exists.
LIMITS="(uint128,uint128,uint128,uint64,uint64,uint128,uint64,uint64,uint32,uint128,uint8)"
limits="(10000000,50000000,200000000,86400,2592000,20000000,0,0,3,0,0)"
salt="$(cast keccak walkthrough)"
mandate="$(cast call "$factory" "predict(address,address,bytes32,$LIMITS)(address)" "$principal" "$agent" "$salt" "$limits" --rpc-url "$rpc")"
tx "$principal" "$factory" "create(address,address,bytes32,$LIMITS)" "$principal" "$agent" "$salt" "$limits"

# The principal allows the provider and one service, and funds the mandate with 20 USDG.
capability="$(cast keccak 'service:gpu.render:1')"
tx "$principal" "$mandate" "setMerchant(address,bool)" "$provider" true
tx "$principal" "$mandate" "setCapability(bytes32,bool)" "$capability" true
tx "$principal" "$usdg" "mint(address,uint256)" "$principal" 20000000
tx "$principal" "$usdg" "approve(address,uint256)" "$mandate" 20000000
tx "$principal" "$mandate" "deposit(uint256)" 20000000

# The agent pays 5 USDG into escrow for that service, spend class 0, due in ten minutes, and the
# escrow numbers the payment.
REQUEST="(address,bytes32,bytes32,string,uint128,uint64,uint8)"
pay() {
  local due=$(( $(cast block latest --field timestamp --rpc-url "$rpc") + 600 ))
  tx "$agent" "$mandate" "spend($REQUEST,bytes32[])" "($provider,$capability,$(cast keccak brief),ipfs://brief,5000000,$due,0)" "[]"
  echo $(( $(cast call "$escrow" "nextId()(uint256)" --rpc-url "$rpc") - 1 ))
}

# The provider delivers, and releasing pays it out less the 1% settlement fee.
id="$(pay)"
tx "$provider" "$escrow" "release(uint256,bytes32,string)" "$id" "$(cast keccak delivered)" ipfs://delivered
cast call "$usdg" "balanceOf(address)(uint256)" "$provider" --rpc-url "$rpc"   # 4950000 [4.95e6]

# A second payment, which the principal contests while the escrow holds it. The mandate posts the
# bond, 5% of the payment.
id="$(pay)"
tx "$principal" "$mandate" "disputeSpend(uint256)" "$id"
dispute="$(cast call "$oracle" "disputeIdOf(uint256)(uint256)" "$id" --rpc-url "$rpc")"

# Two resolvers bond 30,000 BRSR each, from the community allocation.
for resolver in "$first" "$second"; do
  tx "$(at .roles.community)" "$brsr" "transfer(address,uint256)" "$resolver" 30000ether
  tx "$resolver" "$brsr" "approve(address,uint256)" "$oracle" 30000ether
  tx "$resolver" "$oracle" "register(uint128)" 30000ether
done

# Each seals a score out of 100 with a salt of its own, and keeps both until the reveal.
seal() { cast call "$oracle" "commitmentHash(uint256,address,uint8,bytes32)(bytes32)" "$dispute" "$@" --rpc-url "$rpc"; }
salt1="0x$(openssl rand -hex 32)" salt2="0x$(openssl rand -hex 32)"
tx "$first" "$oracle" "commitVote(uint256,bytes32)" "$dispute" "$(seal "$first" 10 "$salt1")"
tx "$second" "$oracle" "commitVote(uint256,bytes32)" "$dispute" "$(seal "$second" 20 "$salt2")"

# An hour later the commit window has closed. Both reveal, and anyone finalizes.
cast rpc evm_increaseTime 3601 --rpc-url "$rpc" >/dev/null && cast rpc evm_mine --rpc-url "$rpc" >/dev/null
tx "$first" "$oracle" "revealVote(uint256,uint8,bytes32)" "$dispute" 10 "$salt1"
tx "$second" "$oracle" "revealVote(uint256,uint8,bytes32)" "$dispute" 20 "$salt2"
tx "$provider" "$oracle" "finalize(uint256)" "$dispute"
cast call "$usdg" "balanceOf(address)(uint256)" "$mandate" --rpc-url "$rpc"   # 14975000 [1.497e7]
```

The eleven fields of the limits tuple are, in order: `perCallCap`, `dailyCap`, `monthlyCap`,
`dailyWindow`, `monthlyWindow`, `approvalThreshold`, `validFrom`, `validUntil`, `classMask`,
`totalCap` and `lane`. Amounts are USDG with six decimals and windows are seconds. A zero
`validUntil` never expires and a zero `totalCap` sets no lifetime ceiling. `classMask` sets bit 0
for services, bit 1 for agent hires and bit 2 for stock purchases, so 3 allows the first two. Lane 1
is the collateral lane, the only one that can borrow.

The spend request is `merchant`, `capabilityId`, `inputCommit`, `inputURI`, `amount`, `deadline` and
`spendClass`, where the class is 0 for a service and 1 for a hire. A mandate stores the capability
ids it allows as given, and `@bursar/sdk` derives a service's id as the keccak-256 of `service:`
and its label, as above, so a mandate set up here and one set up through the SDK agree.

The median of the two scores is 15. Below 50 the [ruling policy](../docs/RULING-POLICY.md) refunds
the payer in full, less the 0.5% resolver fee, and returns its bond. The mandate ends on 14.975
USDG: 20 in, two payments of 5 out, 4.975 refunded, and the 0.25 USDG bond back.

## Source verification

`script/verify.mjs` submits each contract in `verification/manifest.json` to Sourcify, to
Blockscout's shared verification store and to the Robinhood Chain explorer, then waits until the
explorer shows the source. It needs `BLOCKSCOUT_API_KEY`.

```sh
node script/verify.mjs --only <name,name>      # submit, then wait
node script/verify.mjs --status                # only report
```

Each entry names the contract's address, compiler, constructor arguments and linked libraries, and
its compiler input sits beside the manifest as `<name>.json`. After a deployment,
`script/verification-inputs.mjs` writes both for every contract the record names, from the logs
the deploy scripts left in `broadcast/`:

```sh
node script/verification-inputs.mjs --record deployments/rhc-mainnet-v3.json --prefix v3
```

It compiles each input with the solc that built the contract and accepts it only when the result
is the creation code in the deploy transaction, byte for byte; what follows that code in the
transaction is the constructor arguments. Contracts a run linked with `--libraries` carry those
libraries in their metadata, so their inputs and entries carry them too. `--check` reports without
writing.

## License

MIT. See [LICENSE](../LICENSE). `script/lib/V4Math.sol` includes MIT-licensed arithmetic adapted
from Uniswap v4. `vendor/privacy-pools-core` and `src/shielded/ShieldedPool.sol` are Apache-2.0;
`vendor/zk-kit-lean-imt` and `vendor/poseidon-solidity` are MIT. See [NOTICE](../NOTICE).
