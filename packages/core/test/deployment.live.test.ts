import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  adminTimelockAbi,
  agentRegistryAbi,
  escrowAbi,
  mandateAccountAbi,
  mandateAccountFactoryAbi,
  oracleRegistryAbi,
  reputationAbi,
  settlementAssetAbi,
} from '../src/generated/abi.js';
import {
  RHC_MAINNET_INFRA_HASHES,
  RHC_MAINNET_USDG_CODE_HASH,
  RHC_MAINNET_USDG_DOMAIN,
  RHC_MAINNET_USDG_DOMAIN_SEPARATOR,
  rhcMainnet,
} from '../src/chain.js';
import { liveDeployments } from '../src/deployments.js';
import type { Deployment } from '../src/deployments.js';
import { RAW_DEPLOYMENTS } from '../src/generated/deployments.js';
import { createRhcClient } from '../src/rpc/client.js';
import { RpcPool } from '../src/rpc/pool.js';

/**
 * This package's constants and ABIs against the chain they describe.
 *
 * A stale constant is the quiet one: everything compiles, every offline test passes against the
 * shape the code believes in, and the first real call decodes garbage, reverts with a selector
 * nobody recognises, or produces a signature that recovers to nobody. Nothing offline catches it,
 * so this asks the chain.
 *
 * Off by default because it needs a network. Point `BURSAR_LIVE_RPC` at a Robinhood Chain
 * endpoint or at a fork of 4663 to run it, and expect to run it after any redeploy or any
 * `pnpm codegen`.
 *
 *   BURSAR_LIVE_RPC=https://rpc.mainnet.chain.robinhood.com pnpm --filter @bursar/core test
 */

const RPC = process.env['BURSAR_LIVE_RPC'] ?? '';
const chain = rhcMainnet();

/**
 * One pool for the file, because the endpoint meters arrivals and every test here reads several
 * contracts at once. Firing those through a bare `http()` transport is what this package's limiter
 * exists to stop: it works alone and starts losing calls to 429s the moment anything else in the
 * run touches the same endpoint.
 */
const pool = new RpcPool({
  providers: [{ name: 'live', url: RPC || 'http://127.0.0.1:0' }],
  chainId: chain.chainId,
  timeoutMs: 30_000,
  retry: { maxPasses: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
});

function client() {
  return createRhcClient({ chain, pool, requireRedundancy: false }).client;
}

/** The deployment serving this chain, or nothing before the first deploy. */
const record: Deployment | undefined = liveDeployments().find((d) => d.chainId === chain.chainId);

describe.skipIf(!RPC)('the chain constants against 4663', () => {
  it('is pointed at the chain this package pins', async () => {
    expect(await client().getChainId()).toBe(chain.chainId);
  });

  it('finds the canonical infrastructure, byte for byte', async () => {
    const rhc = client();
    const [permit2, multicall3] = await Promise.all([
      rhc.getCode({ address: chain.permit2 }),
      rhc.getCode({ address: chain.multicall3 }),
    ]);

    expect(permit2, 'Permit2 has no code').toBeTruthy();
    expect(multicall3, 'Multicall3 has no code').toBeTruthy();
    // An address holding code is not the claim that it holds the code you expect.
    expect(keccak256(permit2 ?? '0x')).toBe(RHC_MAINNET_INFRA_HASHES.permit2);
    expect(keccak256(multicall3 ?? '0x')).toBe(RHC_MAINNET_INFRA_HASHES.multicall3);
  }, 60_000);

  it('reads USDG as six decimals with the domain payments are signed against', async () => {
    const rhc = client();

    const [code, decimals, name, separator] = await Promise.all([
      rhc.getCode({ address: chain.usdg }),
      rhc.readContract({ address: chain.usdg, abi: settlementAssetAbi, functionName: 'decimals' }),
      rhc.readContract({ address: chain.usdg, abi: settlementAssetAbi, functionName: 'name' }),
      rhc.readContract({ address: chain.usdg, abi: settlementAssetAbi, functionName: 'DOMAIN_SEPARATOR' }),
    ]);

    expect(decimals).toBe(6);
    expect(name).toBe(RHC_MAINNET_USDG_DOMAIN.name);
    expect(keccak256(code ?? '0x')).toBe(RHC_MAINNET_USDG_CODE_HASH);

    // A guessed domain does not fail loudly. It produces a well-formed signature that recovers to
    // nobody, and the facilitator reports an invalid signature while the fault is two constants.
    expect(separator).toBe(RHC_MAINNET_USDG_DOMAIN_SEPARATOR);
  }, 60_000);

  /**
   * USDG is a diamond proxy and routes only the selectors its facets declare. Both of these
   * revert with `FacetNotFound`, which is why the EIP-712 version is pinned rather than read and
   * why nothing here asks the settlement asset about an issuer block list.
   */
  it('has no version() and no isBlacklisted() to call', async () => {
    const rhc = client();

    await expect(
      rhc.call({ to: chain.usdg, data: '0x54fd4d50' }),
    ).rejects.toThrow();
    await expect(
      rhc.call({
        to: chain.usdg,
        data: '0xfe575a870000000000000000000000000000000000000000000000000000000000000001',
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('enforces the minimum gas price this package records', async () => {
    // ArbGasInfo.getMinimumGasPrice() on the Nitro precompile.
    const answer = await client().call({
      to: '0x000000000000000000000000000000000000006C',
      data: '0xf918379a',
    });

    expect(BigInt(answer.data ?? '0x0')).toBe(chain.minFeeCap);
  }, 60_000);
});

describe.skipIf(!RPC || !record)('the shipped ABIs against the live deployment', () => {
  const deployed = record as Deployment;

  it('finds code at every recorded address', async () => {
    const rhc = client();
    for (const [name, address] of Object.entries(deployed.contracts)) {
      const code = await rhc.getCode({ address });
      expect(code, `${name} at ${address} has no code`).toBeTruthy();
      expect(code).not.toBe('0x');
    }
    expect(await rhc.getCode({ address: deployed.settlementAsset })).not.toBe('0x');
  }, 60_000);

  it('reads the wiring back through the shipped ABIs and gets what was recorded', async () => {
    const rhc = client();
    const at = deployed.contracts;

    const [escrowAsset, escrowReputation, reputationEscrow, oracleEscrow, factoryEscrow] =
      await Promise.all([
        rhc.readContract({ address: at.Escrow, abi: escrowAbi, functionName: 'settlementAsset' }),
        rhc.readContract({ address: at.Escrow, abi: escrowAbi, functionName: 'reputation' }),
        rhc.readContract({ address: at.Reputation, abi: reputationAbi, functionName: 'escrow' }),
        rhc.readContract({ address: at.OracleRegistry, abi: oracleRegistryAbi, functionName: 'escrow' }),
        rhc.readContract({
          address: at.MandateAccountFactory,
          abi: mandateAccountFactoryAbi,
          functionName: 'escrow',
        }),
      ]);

    expect(escrowAsset).toBe(deployed.settlementAsset);
    expect(escrowReputation).toBe(at.Reputation);
    expect(reputationEscrow).toBe(at.Escrow);
    expect(oracleEscrow).toBe(at.Escrow);
    expect(factoryEscrow).toBe(at.Escrow);

    const [registryAsset, slashSink, period] = await Promise.all([
      rhc.readContract({ address: at.AgentRegistry, abi: agentRegistryAbi, functionName: 'settlementAsset' }),
      rhc.readContract({ address: at.AgentRegistry, abi: agentRegistryAbi, functionName: 'slashSink' }),
      rhc.readContract({ address: at.AdminTimelock, abi: adminTimelockAbi, functionName: 'timelockPeriod' }),
    ]);

    expect(registryAsset).toBe(deployed.settlementAsset);
    expect(slashSink).toBe(deployed.roles.slashSink);
    // Zero here is the source project's default, and it would make the timelock ornamental.
    expect(period).toBe(BigInt(deployed.verifiedOnChain['timelock.period'] ?? 0));
    expect(period).toBeGreaterThan(0n);
  }, 60_000);

  it('settles in the asset the chain record pins', async () => {
    expect(deployed.settlementAsset).toBe(chain.usdg);
    expect(deployed.settlementDecimals).toBe(6);
  });

  /**
   * The one mandate account the documentation hands a newcomer.
   *
   * A mandate holds its escrow in an immutable, so an account created by a retired factory answers
   * a retired escrow for as long as it exists and no configuration reconciles the two. The one
   * this repository used to name did that: the quickstart, followed to the letter, stopped on
   * its first tool call with config_mismatch and no way forward. The example has to be an account
   * the shipped deployment could have created.
   */
  it('documents a mandate account wired to the escrow this deployment names', async () => {
    const example = exampleMandate(deployed);
    const rhc = client();

    const [code, escrow, asset, principal, agent] = await Promise.all([
      rhc.getCode({ address: example }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'escrow' }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'settlementAsset' }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'principal' }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'agent' }),
    ]);

    expect(code, `no code at the documented mandate ${example}`).toBeTruthy();
    expect(escrow).toBe(deployed.contracts.Escrow);
    expect(asset).toBe(deployed.settlementAsset);
    expect(principal).not.toBe('0x0000000000000000000000000000000000000000');
    expect(agent).not.toBe('0x0000000000000000000000000000000000000000');
  }, 60_000);

  it('leaves it able to spend: not paused, not revoked, and funded to its own per-payment cap', async () => {
    const example = exampleMandate(deployed);
    const rhc = client();

    const [paused, revoked, balance, limits] = await Promise.all([
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'paused' }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'revoked' }),
      rhc.readContract({
        address: deployed.settlementAsset,
        abi: settlementAssetAbi,
        functionName: 'balanceOf',
        args: [example],
      }),
      rhc.readContract({ address: example, abi: mandateAccountAbi, functionName: 'limits' }),
    ]);

    expect(paused).toBe(false);
    expect(revoked).toBe(false);
    // A documented example that cannot make the largest payment its own limits allow reads as
    // broken to whoever opens it, whatever the contracts say.
    expect(balance).toBeGreaterThanOrEqual(limits.perCallCap);
    // No expiry. One that lapses breaks the quickstart on a date nobody is watching.
    expect(limits.validUntil).toBe(0n);
  }, 60_000);
});

/** The address the record documents, read from the record rather than repeated here. */
function exampleMandate(deployed: Deployment): `0x${string}` {
  const raw = Object.values(RAW_DEPLOYMENTS).find(
    (entry) => (entry as { chainId?: unknown }).chainId === deployed.chainId,
  ) as { exampleMandate?: { address?: unknown } } | undefined;
  const address = raw?.exampleMandate?.address;

  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`the deployment record for chain ${deployed.chainId} names no exampleMandate.address`);
  }
  return address as `0x${string}`;
}
