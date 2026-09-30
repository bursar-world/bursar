import { describe, expect, it } from 'vitest';
import { decodeFunctionData, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { collateralDeployment, deployment, mandateAccountAbi, rwaDeployment, stockSpendRouterAbi } from '@bursar/core';

import { CollateralUnavailableError, collateral } from '../src/collateral.js';
import { connect } from '../src/connection.js';
import type { Connection } from '../src/connection.js';
import { InvalidArgumentError } from '../src/errors.js';
import type { MandateAccountClient } from '../src/mandate.js';
import { RwaUnavailableError, UnknownAssetError, rwa } from '../src/rwa.js';
import { fakeConnection, type ReadCall } from './helpers/fake-connection.js';
import { LOCAL_RECORD } from './helpers/local-record.js';

const MANDATE: Address = '0x1234567890123456789012345678901234567890';
const MAINNET_SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';
const LOCAL = LOCAL_RECORD.rwa;

function on(connection: Connection): MandateAccountClient {
  return { address: MANDATE, connection } as unknown as MandateAccountClient;
}

/** A connection that can send, reading and writing against the local record's addresses. */
function sending(read: (call: ReadCall) => unknown) {
  const fake = fakeConnection({ read });
  const connection = { ...fake.connection, deployment: connect({ deployment: LOCAL_RECORD }).deployment };
  return { ...fake, mandate: on(connection) };
}

describe('connecting with a record a deploy script wrote', () => {
  it('parses it, so its assets arrive as a list rather than keyed by symbol', () => {
    const { deployment: record } = connect({ deployment: LOCAL_RECORD });

    expect(record.network).toBe('local-4663');
    expect(Array.isArray(record.rwa?.assets)).toBe(true);
    expect(record.rwa?.assets.map((a) => [a.symbol, a.address])).toEqual([
      ['SGOV', LOCAL.assets.SGOV.address],
      ['SPY', LOCAL.assets.SPY.address],
      ['NVDA', LOCAL.assets.NVDA.address],
    ]);
    expect(record.rwa?.collateral?.CreditPool).toBe(LOCAL.collateral.CreditPool);
  });

  it('takes a record this package already parsed as it is', () => {
    const recorded = deployment('rhc-mainnet-v2');

    expect(connect({ deployment: recorded }).deployment).toBe(recorded);
    const parsed = connect({ deployment: LOCAL_RECORD }).deployment;
    expect(connect({ deployment: parsed }).deployment.rwa?.assets).toHaveLength(3);
  });

  it('refuses a record it cannot read, naming the option and the field', () => {
    const { deployer: _dropped, ...broken } = LOCAL_RECORD;

    expect(() => connect({ deployment: broken })).toThrow(InvalidArgumentError);
    expect(() => connect({ deployment: broken })).toThrow(/deployment record it was given.*"deployer"/u);
  });
});

describe('the stock and treasury lane', () => {
  it('takes every address from the connection’s record, never from mainnet', () => {
    const lane = rwa(on(connect({ deployment: LOCAL_RECORD })));

    expect(lane.lane.StockSpendRouter).toBe(LOCAL.StockSpendRouter);
    expect(lane.lane.TreasuryPark).toBe(LOCAL.TreasuryPark);
    expect(lane.resolve('spy')).toBe(LOCAL.assets.SPY.address);
    expect(lane.resolve('SPY')).not.toBe(MAINNET_SPY);
    expect(lane.adapter('SGOV')).toBe(LOCAL.adapters.SGOV);
  });

  it('points the mandate at the record’s router', async () => {
    const { mandate, sent } = sending((call) => (call.functionName === 'router' ? zeroAddress : undefined));

    await rwa(mandate).useRouter();

    const call = decodeFunctionData({ abi: mandateAccountAbi, data: sent[0]?.data ?? '0x' });
    expect(sent[0]?.to).toBe(MANDATE);
    expect(call.functionName).toBe('setRouter');
    expect(call.args).toEqual([LOCAL.StockSpendRouter]);
  });

  it('lists the record’s stocks on the record’s router', async () => {
    const { mandate, sent } = sending(() => undefined);

    await rwa(mandate).setPolicy({ slippageBps: 0, allow: ['SPY'] });

    expect(sent[0]?.to).toBe(LOCAL.StockSpendRouter);
    expect(decodeFunctionData({ abi: stockSpendRouterAbi, data: sent[0]?.data ?? '0x' }).args).toEqual([
      MANDATE,
      0,
      [LOCAL.assets.SPY.address],
      [true],
    ]);
  });

  it('refuses a supplied record with no lane rather than falling back to the chain’s', () => {
    const { rwa: _lane, ...core } = LOCAL_RECORD;
    const mandate = on(connect({ deployment: core }));

    expect(() => rwa(mandate)).toThrow(RwaUnavailableError);
    expect(() => rwa(mandate)).toThrow(/local-4663 on chain 4663 records no RWA lane/u);
  });

  it('takes a lane passed in, keyed by symbol as on disk or listed as parsed', () => {
    const mainnet = on(connect());

    expect(rwa(mainnet, LOCAL).resolve('NVDA')).toBe(LOCAL.assets.NVDA.address);
    expect(rwa(mainnet, LOCAL).lane.StockSpendRouter).toBe(LOCAL.StockSpendRouter);

    const parsed = connect({ deployment: LOCAL_RECORD }).deployment.rwa;
    expect(parsed).toBeDefined();
    expect(rwa(mainnet, parsed).resolve('SGOV')).toBe(LOCAL.assets.SGOV.address);
  });

  it('keeps the address book’s lane for the record that answers for mainnet', () => {
    expect(rwa(on(connect())).lane).toEqual(rwaDeployment(4663));
  });

  it('names what it records when a symbol is not among them', () => {
    const lane = rwa(on(connect({ deployment: LOCAL_RECORD })));

    expect(() => lane.resolve('TSLA')).toThrow(UnknownAssetError);
    expect(() => lane.resolve('TSLA')).toThrow(
      'TSLA is not an asset this deployment records. It records SGOV, SPY, NVDA.',
    );
  });
});

describe('the collateral lane', () => {
  it('takes the vault, the pool and the assets from the connection’s record', () => {
    const line = collateral(on(connect({ deployment: LOCAL_RECORD })));

    expect(line.lane.CreditPool).toBe(LOCAL.collateral.CreditPool);
    expect(line.lane.CollateralVault).toBe(LOCAL.collateral.CollateralVault);
    expect(line.resolve('SPY')).toBe(LOCAL.assets.SPY.address);
  });

  it('refuses a supplied record with no collateral lane rather than defaulting to mainnet’s pool', () => {
    const { collateral: _line, ...rwaOnly } = LOCAL;
    const mandate = on(connect({ deployment: { ...LOCAL_RECORD, rwa: rwaOnly } }));

    expect(() => collateral(mandate)).toThrow(CollateralUnavailableError);
  });

  it('takes a lane passed in, with its assets when the whole RWA section comes with it', () => {
    const line = collateral(on(connect()), LOCAL);

    expect(line.lane.CreditPool).toBe(LOCAL.collateral.CreditPool);
    expect(line.resolve('SPY')).toBe(LOCAL.assets.SPY.address);
  });

  it('borrows symbols for a bare collateral part only from the record whose vault it is', () => {
    const local = collateral(on(connect({ deployment: LOCAL_RECORD })), LOCAL.collateral);
    expect(local.resolve('SPY')).toBe(LOCAL.assets.SPY.address);

    const elsewhere = collateral(on(connect()), LOCAL.collateral);
    expect(elsewhere.lane.CollateralVault).toBe(LOCAL.collateral.CollateralVault);
    expect(() => elsewhere.resolve('SPY')).toThrow(UnknownAssetError);
    expect(elsewhere.resolve(LOCAL.assets.SPY.address)).toBe(LOCAL.assets.SPY.address);
  });

  it('keeps the address book’s pool for the record that answers for mainnet', () => {
    expect(collateral(on(connect())).lane).toEqual(collateralDeployment(4663));
  });
});
