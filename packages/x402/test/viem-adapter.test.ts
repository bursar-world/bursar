import { describe, expect, test } from 'vitest';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';
import { RHC_MAINNET, settlementAssetAbi } from '@bursar/core';
import type { RhcPublicClient } from '@bursar/core';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import { isNotSent } from '../src/errors.js';
import { createPaymentChain, createWalletSigner } from '../src/viem.js';
import { PAY_TO, PAYER, USDG } from './support.js';

/**
 * The adapter holds no decisions, so what is worth testing is the wiring: that each port reads the
 * function it claims to read. A `permitNonce` that called `authorizationState` would pass every
 * other test in this package and fail only against a real chain.
 */
type ReadCall = { address: string; functionName: string; args?: readonly unknown[] };

function stubClient(answers: Record<string, unknown>, calls: ReadCall[]): RhcPublicClient {
  return {
    chain: { id: RHC_MAINNET.chainId },
    async readContract(args: ReadCall) {
      calls.push(args);
      return answers[args.functionName];
    },
    async getCode({ address }: { address: string }) {
      return answers[`code:${address.toLowerCase()}`];
    },
    async call(args: { account: string; to: string; data: string }) {
      calls.push({ address: args.to, functionName: 'call', args: [args.account, args.data] });
      return { data: '0x' };
    },
    async waitForTransactionReceipt() {
      return { status: 'success', gasUsed: 87_363n };
    },
  } as unknown as RhcPublicClient;
}

describe('the viem adapter', () => {
  test('token identity is four reads of the token itself', async () => {
    const calls: ReadCall[] = [];
    const chain = createPaymentChain(
      stubClient(
        { name: 'Global Dollar', version: '1', decimals: 6, DOMAIN_SEPARATOR: `0x${'36'.repeat(32)}` },
        calls,
      ),
    );
    const identity = await chain.tokenIdentity(USDG);
    expect(identity).toMatchObject({ name: 'Global Dollar', version: '1', decimals: 6 });
    expect(calls.map((call) => call.functionName).sort()).toEqual([
      'DOMAIN_SEPARATOR',
      'decimals',
      'name',
      'version',
    ]);
    expect(calls.every((call) => call.address === USDG)).toBe(true);
  });

  test('a token whose version() reverts still reports the three reads that answered', async () => {
    // USDG is a diamond proxy: a call it has no facet for reverts with FacetNotFound. Letting
    // that one read take the whole identity down would leave the settlement asset unresolvable.
    const calls: ReadCall[] = [];
    const answers: Record<string, unknown> = {
      name: 'Global Dollar',
      decimals: 6,
      DOMAIN_SEPARATOR: `0x${'7a'.repeat(32)}`,
    };
    const facetless = {
      chain: { id: RHC_MAINNET.chainId },
      async readContract(args: ReadCall) {
        calls.push(args);
        if (args.functionName === 'version') throw new Error('execution reverted: 0x800ab12c');
        return answers[args.functionName];
      },
    } as unknown as RhcPublicClient;

    const identity = await createPaymentChain(facetless).tokenIdentity(USDG);

    expect(identity.version).toBeUndefined();
    expect(identity).toMatchObject({
      name: 'Global Dollar',
      decimals: 6,
      domainSeparator: `0x${'7a'.repeat(32)}`,
    });
    expect('version' in identity).toBe(false);
  });

  test('each port reads the function it says it does', async () => {
    const calls: ReadCall[] = [];
    const chain = createPaymentChain(
      stubClient(
        { balanceOf: 5_000_000n, allowance: 1n, authorizationState: true, nonces: 3n },
        calls,
      ),
    );

    expect(chain.chainId).toBe(RHC_MAINNET.chainId);
    expect(await chain.balanceOf(USDG, PAYER.address)).toBe(5_000_000n);
    expect(await chain.allowance(USDG, PAYER.address, PAY_TO)).toBe(1n);
    expect(await chain.authorizationState(USDG, PAYER.address, `0x${'11'.repeat(32)}`)).toBe(true);
    // EIP-2612 exposes its counter as `nonces`. Nothing in the interface is named permit.
    expect(await chain.permitNonce(USDG, PAYER.address)).toBe(3n);

    expect(calls.map((call) => call.functionName)).toEqual([
      'balanceOf',
      'allowance',
      'authorizationState',
      'nonces',
    ]);
  });

  test('the issuer controls are one batch: the asset once, each party once', async () => {
    const calls: ReadCall[] = [];
    const chain = createPaymentChain(stubClient({ paused: false, isFrozen: false }, calls));

    const controls = await chain.issuerControls(USDG, [PAYER.address, PAY_TO]);

    expect(controls.paused).toEqual({ state: 'read', value: false });
    expect(controls.parties.map((party) => party.address)).toEqual([PAYER.address, PAY_TO]);
    expect(calls.map((call) => call.functionName)).toEqual(['paused', 'isFrozen', 'isFrozen']);
    expect(calls.map((call) => call.args?.[0])).toEqual([undefined, PAYER.address, PAY_TO]);
  });

  test('a control the diamond no longer routes reads as absent, not as a chain that is down', async () => {
    // USDG is a diamond and a facet can be removed. `FacetNotFound` says the control has left the
    // token, which is a different problem, with a different owner, from a read that never landed.
    const facetless = {
      chain: { id: RHC_MAINNET.chainId },
      async readContract(args: ReadCall) {
        if (args.functionName === 'paused') throw new Error('execution reverted: 0x800ab12c');
        return false;
      },
    } as unknown as RhcPublicClient;

    const controls = await createPaymentChain(facetless).issuerControls(USDG, [PAYER.address]);

    expect(controls.paused.state).toBe('absent');
    expect(controls.parties[0]?.frozen).toEqual({ state: 'read', value: false });
  });

  test('a control that does not answer reads as unreadable, and keeps what the chain said', async () => {
    const down = {
      chain: { id: RHC_MAINNET.chainId },
      async readContract() {
        throw new Error('the request timed out after 10000 ms');
      },
    } as unknown as RhcPublicClient;

    const controls = await createPaymentChain(down).issuerControls(USDG, [PAYER.address]);

    expect(controls.paused.state).toBe('unreadable');
    if (controls.paused.state !== 'read') expect(controls.paused.detail).toContain('timed out');
  });

  test('an address with no code is not a contract', async () => {
    const chain = createPaymentChain(stubClient({ [`code:${USDG.toLowerCase()}`]: '0x' }, []));
    expect(await chain.hasCode(USDG)).toBe(false);
  });

  test('an address with code is a contract', async () => {
    const chain = createPaymentChain(stubClient({ [`code:${USDG.toLowerCase()}`]: '0x6080' }, []));
    expect(await chain.hasCode(USDG)).toBe(true);
  });

  test('simulation runs as the relayer, because it is the relayer that pays for a revert', async () => {
    const calls: ReadCall[] = [];
    const chain = createPaymentChain(stubClient({}, calls));
    await chain.simulate({ to: USDG, data: '0xdeadbeef' }, PAYER.address);
    expect(calls[0]).toMatchObject({ address: USDG, args: [PAYER.address, '0xdeadbeef'] });
  });
});

describe('settlement calldata', () => {
  const args = [
    PAYER.address,
    PAY_TO,
    300_000n,
    1n,
    2n,
    `0x${'11'.repeat(32)}`,
    `0x${'ab'.repeat(65)}`,
  ] as const;

  test('seven arguments select the bytes-signature overload USDG takes', () => {
    const data = encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'transferWithAuthorization',
      args,
    });
    // The v/r/s overload is also in the ABI, and the token does not want it.
    const bytesVariant = toFunctionSelector(
      'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)',
    );
    const vrsVariant = toFunctionSelector(
      'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
    );
    expect(data.slice(0, 10)).toBe(bytesVariant);
    expect(data.slice(0, 10)).not.toBe(vrsVariant);
  });

  test('the encoded call decodes back to what the payer signed', () => {
    const data = encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'transferWithAuthorization',
      args,
    });
    const decoded = decodeFunctionData({ abi: settlementAssetAbi, data });
    expect(decoded.functionName).toBe('transferWithAuthorization');
    expect(decoded.args).toEqual(args);
  });

  test('the permit overload is the five-argument one, for the same reason', () => {
    const data = encodeFunctionData({
      abi: settlementAssetAbi,
      functionName: 'permit',
      args: [PAYER.address, PAY_TO, 300_000n, 99n, `0x${'ab'.repeat(65)}`],
    });
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector('permit(address,address,uint256,uint256,bytes)'),
    );
  });
});

describe('the wallet signer', () => {
  test('a fee estimate that fails says nothing was sent, and nothing was', async () => {
    const sent: unknown[] = [];
    const wallet = {
      account: { address: PAYER.address },
      chain: { id: RHC_MAINNET.chainId },
      async sendTransaction(args: unknown) {
        sent.push(args);
        return `0x${'ab'.repeat(32)}`;
      },
    } as unknown as WalletClient<Transport, Chain, Account>;
    const client = {
      async estimateFeesPerGas() {
        throw new Error('fetch failed');
      },
    } as unknown as RhcPublicClient;

    const signer = createWalletSigner(wallet, { client, minFeePerGas: RHC_MAINNET.minFeeCap });
    const failure = await signer.send({ to: USDG, data: '0x' }).catch((error: unknown) => error);

    // Reported as a possible broadcast, this would strand the payer's nonce claim.
    expect(isNotSent(failure)).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe('the version probe', () => {
  test('a version() read the chain did not answer is not taken as "no version"', async () => {
    const flaky = {
      chain: { id: RHC_MAINNET.chainId },
      async readContract(args: ReadCall) {
        if (args.functionName === 'version') throw new Error('the request timed out after 10000 ms');
        return { name: 'Global Dollar', decimals: 6, DOMAIN_SEPARATOR: `0x${'7a'.repeat(32)}` }[args.functionName];
      },
    } as unknown as RhcPublicClient;
    await expect(createPaymentChain(flaky).tokenIdentity(USDG)).rejects.toThrow(/timed out/);
  });
});
