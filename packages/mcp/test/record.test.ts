import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COLLATERAL_LANE,
  collateralVaultAbi,
  creditPoolAbi,
  deploymentsForChain,
  isBursarError,
  mandateAccountAbi,
  priceGuardAbi,
  privacyDeployment,
  rwaDeployment,
  stockSpendRouterAbi,
} from '@bursar/core';
import { decodeFunctionData, erc20Abi, getAddress, isAddressEqual } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createContext } from '../src/server.js';
import { callTool, toolsFor } from '../src/tools.js';
import { LOCAL_RECORD } from './local-record.js';
import { ACCOUNT, ASSET, answer, createFakeNode, defaultState } from './node.js';
import type { Answer, Contracts, FakeNode } from './node.js';

const LOCAL = LOCAL_RECORD.rwa;
const SPY = LOCAL.assets.SPY.address;
const VAULT = LOCAL.collateral.CollateralVault;
const POOL = LOCAL.collateral.CreditPool;
const MANDATE = getAddress(ACCOUNT);

const PRICE_E8 = 77_121_000_000n;
const MIN_OUT = 6_473_574_322_038_947n;

const dir = mkdtempSync(join(tmpdir(), 'bursar-mcp-record-'));

function fileWith(content: unknown): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    return { code: isBursarError(error) ? error.code : 'not_a_bursar_error', message: error instanceof Error ? error.message : '' };
  }
  return { code: 'no_error', message: '' };
}

function token(): ReadonlyMap<Hex, Answer> {
  return new Map([
    answer(erc20Abi, 'balanceOf', (_args, state) => state.balance),
    answer(erc20Abi, 'allowance', () => 0n),
    answer(erc20Abi, 'approve', () => true),
  ]);
}

/** The local record's lane where the record puts it, with its SPY and USDG. */
const LANE: Contracts = new Map([
  [LOCAL.PriceGuard.toLowerCase(), new Map([answer(priceGuardAbi, 'tradePrice', () => PRICE_E8)])],
  [LOCAL.StockSpendRouter.toLowerCase(), new Map([answer(stockSpendRouterAbi, 'minOutFor', () => MIN_OUT)])],
  [
    VAULT.toLowerCase(),
    new Map([
      answer(collateralVaultAbi, 'account', () => [49_808n, 39_846n, 20_001n, 11_875n, 1_992_200_389_980_500_974n]),
      answer(collateralVaultAbi, 'positions', () => [
        {
          asset: SPY,
          tier: 2,
          raw: 64_961_527_959_563n,
          priceE8: PRICE_E8,
          updatedAt: 1_799_990_000n,
          fresh: true,
          haircutBps: 2000,
          value: 49_808n,
          adjusted: 39_846n,
        },
      ]),
      answer(collateralVaultAbi, 'isLine', () => true),
      answer(collateralVaultAbi, 'tiers', () => [
        { name: 'Index fund', sessionHaircutBps: 2000, afterHoursHaircutBps: 3500, sessionStaleness: 93_600, valuationStaleness: 360_000 },
      ]),
      answer(collateralVaultAbi, 'inSession', () => true),
      answer(collateralVaultAbi, 'deposit', () => undefined),
    ]),
  ],
  [POOL.toLowerCase(), new Map([answer(creditPoolAbi, 'repay', (args) => args[1])])],
  [SPY.toLowerCase(), token()],
  [ASSET.toLowerCase(), token()],
]);

const ENV = {
  RHC_RPC_PRIMARY: 'http://primary.test',
  RHC_RPC_FALLBACK: 'http://fallback.test',
  MANDATE_ACCOUNT: ACCOUNT,
  BURSAR_SIGNER: 'local',
  BURSAR_SIGNER_KEY: `0x${'7f'.repeat(32)}`,
  BURSAR_RECORD: fileWith(LOCAL_RECORD),
};

/**
 * A server reading `record` and signing with its own key, against a node that holds the local
 * record's lane and none of mainnet's: a read or a write aimed at mainnet's fails the call. The
 * mandate settles through the local escrow and may borrow.
 */
function serve(record: unknown = LOCAL_RECORD) {
  const state = defaultState();
  state.escrow = LOCAL_RECORD.contracts.Escrow;
  state.limits.lane = COLLATERAL_LANE;
  const node = createFakeNode(state, LANE);
  const config = loadConfig({ ...ENV, BURSAR_RECORD: fileWith(record) });

  return { node, config, context: createContext(config, { fetchFn: node.fetchFn, onDiagnostic: () => undefined }) };
}

/** The reads that went to one contract, decoded against its ABI. */
function readsAt(node: FakeNode, to: Address, abi: Abi) {
  return node.calls
    .filter((entry) => entry.method === 'eth_call')
    .map((entry) => entry.params[0] as { to: Address; data: Hex })
    .filter((request) => isAddressEqual(request.to, to))
    .map((request) => decodeFunctionData({ abi, data: request.data }));
}

/** The transactions signed to one contract, decoded against its ABI. */
function sentTo(node: FakeNode, to: Address, abi: Abi) {
  return node.transactions
    .filter((transaction) => isAddressEqual(transaction.to, to))
    .map((transaction) => decodeFunctionData({ abi, data: transaction.data }));
}

describe('a server configured with a deployment record', () => {
  it('takes the escrow, the registries and every lane address from BURSAR_RECORD', () => {
    const config = loadConfig({ ...ENV, BURSAR_RESOLVER_ACCOUNT: '0x4444444444444444444444444444444444444444' });

    expect(config.escrows).toEqual([LOCAL_RECORD.contracts.Escrow]);
    expect(config.resolver?.registry).toBe(LOCAL_RECORD.contracts.OracleRegistry);
    expect(config.settlementAsset).toBe(LOCAL_RECORD.settlementAsset);
    expect(config.rwa).toMatchObject({
      PriceGuard: LOCAL.PriceGuard,
      StockSpendRouter: LOCAL.StockSpendRouter,
      collateral: { CollateralVault: VAULT, CreditPool: POOL },
    });
    expect(config.rwa?.assets.map((asset) => [asset.symbol, asset.address])).toEqual([
      ['SGOV', LOCAL.assets.SGOV.address],
      ['SPY', SPY],
      ['NVDA', LOCAL.assets.NVDA.address],
    ]);
    // The record deploys no shielded pool, and mainnet's does not stand in for one.
    expect(config.shielded).toBeNull();
  });

  it('quotes a purchase on the record’s guard and router, and buys the token the record lists', async () => {
    const { node, context } = serve();

    const result = await callTool(context, 'mandate_buy_stock', { asset: 'spy', amount: '5000000' });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ asset: SPY, symbol: 'SPY', received: MIN_OUT.toString() });
    expect(readsAt(node, LOCAL.PriceGuard, priceGuardAbi)).toEqual([{ functionName: 'tradePrice', args: [SPY, MANDATE] }]);
    expect(readsAt(node, LOCAL.StockSpendRouter, stockSpendRouterAbi)).toEqual([
      { functionName: 'minOutFor', args: [MANDATE, SPY, 5_000_000n] },
    ]);
    expect(node.transactions).toHaveLength(1);
    expect(sentTo(node, MANDATE, mandateAccountAbi)).toEqual([
      { functionName: 'buy', args: [SPY, 5_000_000n, MIN_OUT, PRICE_E8] },
    ]);
  });

  it('refuses a stock the record does not list, though mainnet lists it', async () => {
    const { node, context } = serve();

    const body = JSON.parse((await callTool(context, 'mandate_buy_stock', { asset: 'AAPL', amount: '5000000' })).text);

    expect(body).toMatchObject({ error: 'invalid_arguments', message: 'AAPL is not an eligible stock. Eligible: SPY, NVDA.' });
    expect(node.transactions).toHaveLength(0);
  });

  it('reads the collateral line from the record’s vault and names positions by the record’s symbols', async () => {
    const { node, context } = serve();

    const result = await callTool(context, 'mandate_collateral', {});

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).positions).toMatchObject([{ symbol: 'SPY', asset: SPY }]);
    expect(readsAt(node, VAULT, collateralVaultAbi).map((read) => read.functionName).sort()).toEqual([
      'account',
      'inSession',
      'isLine',
      'positions',
      'tiers',
    ]);
  });

  it('posts collateral to the record’s vault and repays the record’s credit pool', async () => {
    const { node, context } = serve();

    const deposit = await callTool(context, 'mandate_collateral_deposit', { asset: 'SPY', raw: '1000' });
    const repay = await callTool(context, 'mandate_collateral_repay', { amount: '20001' });

    expect(deposit.isError).toBe(false);
    expect(repay.isError).toBe(false);
    expect(node.transactions).toHaveLength(4);
    expect(sentTo(node, SPY, erc20Abi)).toEqual([{ functionName: 'approve', args: [VAULT, 1_000n] }]);
    expect(sentTo(node, VAULT, collateralVaultAbi)).toEqual([{ functionName: 'deposit', args: [MANDATE, SPY, 1_000n] }]);
    expect(sentTo(node, ASSET, erc20Abi)).toEqual([{ functionName: 'approve', args: [POOL, 20_001n] }]);
    expect(sentTo(node, POOL, creditPoolAbi)).toEqual([{ functionName: 'repay', args: [MANDATE, 20_001n] }]);
  });

  it('buys nothing and offers no collateral line when the record deploys no lane', async () => {
    const { rwa: _lane, ...core } = LOCAL_RECORD;
    const { node, config, context } = serve(core);

    const body = JSON.parse((await callTool(context, 'mandate_buy_stock', { asset: 'SPY', amount: '5000000' })).text);

    expect(config.rwa).toBeNull();
    expect(toolsFor(context).map((tool) => tool.name)).not.toContain('mandate_collateral');
    expect(body.error).toBe('rwa_unavailable');
    expect(node.transactions).toHaveLength(0);
  });

  it('reads the record that answers for the chain, as before, when BURSAR_RECORD is unset', () => {
    const { BURSAR_RECORD: _record, ...unset } = ENV;
    const config = loadConfig(unset);

    expect(config.rwa).toEqual(rwaDeployment(4663) ?? null);
    expect(config.escrows).toEqual(deploymentsForChain(4663).map((record) => record.contracts.Escrow));
    expect(config.shielded?.deployment).toEqual(privacyDeployment(4663)?.shielded);
  });

  it('refuses a record it cannot read or use, and one for another chain', () => {
    const { deployer: _dropped, ...broken } = LOCAL_RECORD;

    expect(failure(() => loadConfig({ ...ENV, BURSAR_RECORD: join(dir, 'absent.json') })).message).toMatch(
      /BURSAR_RECORD names .*absent\.json, and it could not be read/u,
    );
    expect(failure(() => loadConfig({ ...ENV, BURSAR_RECORD: fileWith('{') })).message).toMatch(/It is not JSON/u);
    expect(failure(() => loadConfig({ ...ENV, BURSAR_RECORD: fileWith(broken) }))).toMatchObject({
      code: 'env_invalid',
      message: expect.stringMatching(/"deployer"/u),
    });
    expect(failure(() => loadConfig({ ...ENV, BURSAR_RECORD: fileWith({ ...LOCAL_RECORD, chainId: 4664 }) }))).toEqual({
      code: 'config_mismatch',
      message: 'BURSAR_RECORD holds local-4663, a deployment on chain 4664, and this server is on chain 4663.',
    });
  });
});
