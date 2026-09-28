# @bursar/core

The shared foundation every other package, service and the console build on. It holds the
Robinhood Chain configuration, the addresses and ABIs of the deployed contracts, six-decimal money
types, the RPC pool that spreads reads across independent providers, and strict environment
loading. Nothing else in the workspace hard-codes an address or talks to an RPC endpoint directly.

## What is in it

| Module | What it gives you |
|---|---|
| `chain` | Chain 4663 as read from the chain: USDG, Permit2, Multicall3, the minimum fee cap, the USDG EIP-712 domain. Testnet 46630 is described and refused, because USDG has no contract there. |
| `deployments` | The address book, generated from `contracts/deployments/*.json`. `deploymentForChain(4663)` returns the live record; a retired record is never returned by chain id. |
| `generated/abi` | ABIs for the seven core contracts and the settlement asset, generated from the Foundry build. |
| `money` | `Micro`, a `bigint` in six-decimal micro-USD, with parsing, formatting and arithmetic. No float touches money. |
| `rpc` | `RpcPool` with per-provider rate limits, a circuit breaker and failover, and `createRhcClient`, a viem client on top of it. |
| `explorer` | Explorer links and a server-only client for the hosted Blockscout index. |
| `gas-float` | Reads the relayer's ETH balance and refuses a configuration in which two funding roles share an address. |
| `env` | `loadEnv` and typed variable parsers that fail at start with every problem listed at once. |

## Use

The package is not published to npm. Inside this workspace, depend on it with
`"@bursar/core": "workspace:*"` and build it once:

```sh
pnpm --filter @bursar/core build
```

```ts
import { createRhcClient, deploymentForChain, formatMicro, RHC_MAINNET } from '@bursar/core';

const client = createRhcClient();               // reads RHC_RPC_PRIMARY and RHC_RPC_FALLBACK
const { contracts } = deploymentForChain(RHC_MAINNET.chainId);
```

## Regenerating addresses and ABIs

`src/generated/` is committed so that nobody needs Foundry installed to typecheck a service.
After a contract change or a new deployment record:

```sh
cd contracts && forge build && cd ..
pnpm --filter @bursar/core codegen
```

A test compares the generated address book with the JSON on disk field by field, so a stale
checkout fails `pnpm test` rather than a request.

## Configuration

The package reads these only when a caller asks it to, through `createRhcClient`, `rhcChain` or
`createIndexClient`. Services list the full set they need in their own READMEs.

| Variable | Required | Meaning |
|---|---|---|
| `RHC_RPC_PRIMARY` | yes, for `createRhcClient` | The endpoint this deployment chose. |
| `RHC_RPC_FALLBACK` | no | A second provider at a different host. Defaults to `https://robinhood.drpc.org`. Two endpoints at one host are refused. |
| `RHC_RPC_TERTIARY` | no | An optional third provider. |
| `RHC_RPC_{PRIMARY,FALLBACK,TERTIARY}_MAX_RPS` | no | Request rate per provider. Defaults are measured per host. |
| `RHC_RPC_{PRIMARY,FALLBACK,TERTIARY}_MAX_CONCURRENCY` | no | Requests in flight per provider. |
| `RHC_NETWORK` | no | `mainnet` (default). `testnet` is refused because nothing can settle on 46630. |
| `RHC_MAINNET_RPC_URL`, `RHC_MAINNET_CHAIN_ID`, `RHC_MAINNET_EXPLORER`, `RHC_MAINNET_USDG`, `RHC_MAINNET_PERMIT2`, `RHC_MAINNET_MULTICALL3`, `RHC_MAINNET_MIN_FEE_CAP` | no | Per-field overrides of the recorded chain values. Point `RHC_MAINNET_RPC_URL` at a local fork of 4663 to test against one. An override that is set but empty stops the process. |
| `BLOCKSCOUT_API_KEY` | for index reads | Server-side key for the hosted Blockscout index. The index client refuses to run in a browser. |
| `BLOCKSCOUT_API_BASE` | no | A different index host. |

## Tests

```sh
pnpm --filter @bursar/core test
```

Setting `BURSAR_LIVE_RPC` to a Robinhood Chain endpoint adds the checks of the shipped ABIs and
constants against the live deployment, and `BLOCKSCOUT_API_KEY` adds two that read the index for real.

## License

MIT. See [LICENSE](../../LICENSE).
