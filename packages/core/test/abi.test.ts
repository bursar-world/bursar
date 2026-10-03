import { describe, expect, it } from 'vitest';
import { getAbiItem, toFunctionSelector } from 'viem';
import { BURSAR_ABIS, mandateAccountAbi, escrowAbi, oracleRegistryAbi, settlementAssetAbi } from '../src/generated/abi.js';
import { escrowAbiV1, mandateAccountAbiV1 } from '../src/abi-v1.js';
import { escrowAbiV2, mandateAccountAbiV2, oracleRegistryAbiV2 } from '../src/abi-v2.js';
import {
  CURRENT_CONTRACT_SET,
  V1_ABIS,
  V2_ABIS,
  V3_ABIS,
  V4_ABIS,
  contractSetAtLeast,
  contractSetOf,
  contractSetOfEscrow,
  contractSetOfRegistry,
} from '../src/contract-set.js';
import { deployment, parseDeployment } from '../src/deployments.js';
import { RAW_DEPLOYMENTS } from '../src/generated/deployments.js';

describe('generated ABIs', () => {
  it('covers every deployed contract', () => {
    expect(Object.keys(BURSAR_ABIS).sort()).toEqual([
      'AdminTimelock',
      'AgentRegistry',
      'AssetRegistry',
      'CollateralVault',
      'CommittedMandateAccount',
      'CommittedMandateFactory',
      'CreditPool',
      'DisclosureRegistry',
      'Escrow',
      'MandateAccount',
      'MandateAccountFactory',
      'OracleRegistry',
      'PriceGuard',
      'Reputation',
      'RobinhoodStockAdapter',
      'SolvencyLog',
      'StockSpendRouter',
      'TreasuryPark',
      'WithinMandateVerifier',
    ]);
  });

  it('keeps the mandate surface the services spend against', () => {
    const names = new Set<string>(mandateAccountAbi.filter((e) => e.type === 'function').map((e) => e.name));
    for (const fn of ['spend', 'previewSpend', 'remaining', 'limits', 'setLimitsWithAuthorization', 'deposit']) {
      expect(names.has(fn), fn).toBe(true);
    }
    expect(getAbiItem({ abi: mandateAccountAbi, name: 'Spent' })?.type).toBe('event');
  });

  it('keeps the escrow lifecycle', () => {
    const names = new Set<string>(escrowAbi.filter((e) => e.type === 'function').map((e) => e.name));
    for (const fn of ['lock', 'release', 'timeout', 'dispute', 'resolve', 'getLock']) {
      expect(names.has(fn), fn).toBe(true);
    }
  });

  it('exposes the settlement asset as USDG answers it, including EIP-3009', () => {
    const names: string[] = settlementAssetAbi.filter((e) => e.type === 'function').map((e) => e.name);
    // Every one of these was called against 0x5fc5…d168 on chain 4663 and answered. `version` is
    // deliberately not in the list: USDG is a diamond and does not route it.
    for (const fn of [
      'transferWithAuthorization',
      'receiveWithAuthorization',
      'cancelAuthorization',
      'authorizationState',
      'permit',
      'nonces',
      'DOMAIN_SEPARATOR',
      'decimals',
      // The issuer controls that answer. A settlement can fail for an issuer reason on this
      // chain, so the ABI has to carry the reads that say so.
      'paused',
      'isFrozen',
      'owner',
    ]) {
      expect(names, fn).toContain(fn);
    }

    // The bytes-signature variant is the one the x402 exact scheme submits.
    expect(
      settlementAssetAbi.some(
        (e) =>
          e.type === 'function' &&
          e.name === 'transferWithAuthorization' &&
          e.inputs.length === 7 &&
          e.inputs[6]?.type === 'bytes',
      ),
    ).toBe(true);
  });

  it('drops everything the live token would revert or does not have', () => {
    const names: string[] = settlementAssetAbi.map((e) => ('name' in e ? e.name : ''));
    // The first three are test-only entry points on the stand-in. The last three are the ones
    // USDG's diamond does not route: shipping them gives a caller a way to reach a bare
    // `FacetNotFound` with nothing in it to explain why.
    for (const absent of [
      'mint',
      'setPaused',
      'setFrozen',
      'version',
      'eip712Domain',
      'isBlacklisted',
    ]) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('is typed well enough for viem to derive a selector', () => {
    const spend = getAbiItem({ abi: mandateAccountAbi, name: 'previewSpend' });
    expect(spend).toBeDefined();
    expect(toFunctionSelector(spend as never)).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe('the frozen v1 ABIs', () => {
  it('read v1 limits as eight fields and v2 limits as eleven', () => {
    const v1 = getAbiItem({ abi: mandateAccountAbiV1, name: 'limits' });
    const v2 = getAbiItem({ abi: mandateAccountAbi, name: 'limits' });
    expect(v1?.outputs[0]?.components).toHaveLength(8);
    expect(v2?.outputs[0]?.components).toHaveLength(11);
  });

  it('keep the v1 escrow resolve and the v2 reopen apart', () => {
    const v1 = getAbiItem({ abi: escrowAbiV1, name: 'resolve' });
    expect(v1?.inputs.length).toBeGreaterThan(0);
    const named = (abi: readonly { type: string; name?: string }[]) => abi.map((e) => e.name);
    expect(named(escrowAbiV1)).not.toContain('reopen');
    expect(named(escrowAbi)).toContain('reopen');
  });

  it('pick the set by the escrow a mandate names', () => {
    expect(contractSetOfEscrow(deployment('rhc-mainnet').contracts.Escrow)).toBe('v1');
    expect(contractSetOfEscrow(deployment('rhc-mainnet-v2').contracts.Escrow)).toBe('v2');
    expect(contractSetOfRegistry(deployment('rhc-mainnet-v2').contracts.OracleRegistry)).toBe('v2');
    expect(V1_ABIS.MandateAccount).toBe(mandateAccountAbiV1);
  });
});

const functionNames = (abi: readonly { type: string; name?: string }[]) =>
  abi.filter((e) => e.type === 'function').map((e) => e.name);

describe('the frozen v2 ABIs', () => {
  it('keep the dispute timeout the v2 escrow still answers, and nothing v3 added', () => {
    expect(functionNames(escrowAbiV2)).toContain('disputeTimeout');
    expect(functionNames(escrowAbiV2)).toContain('disputeTimeoutPeriod');
    for (const added of ['claim', 'owed', 'minLock']) expect(functionNames(escrowAbiV2)).not.toContain(added);
  });

  it('read the v2 parties as two addresses and the v3 parties as three', () => {
    expect(getAbiItem({ abi: oracleRegistryAbiV2, name: 'partiesOf' })?.outputs).toHaveLength(2);
    expect(getAbiItem({ abi: oracleRegistryAbi, name: 'partiesOf' })?.outputs).toHaveLength(3);
  });

  it('share the account shape with v3, down to the eleven-field limits', () => {
    expect(getAbiItem({ abi: mandateAccountAbiV2, name: 'limits' })?.outputs[0]?.components).toHaveLength(11);
    expect(V2_ABIS.MandateAccount).toBe(mandateAccountAbiV2);
  });
});

describe('the v3 ABIs', () => {
  it('floor the lock, book what a frozen address cannot take, and drop the dispute timeout', () => {
    for (const added of ['claim', 'owed', 'minLock']) expect(functionNames(escrowAbi)).toContain(added);
    expect(functionNames(escrowAbi)).not.toContain('disputeTimeout');
    expect(functionNames(escrowAbi)).not.toContain('disputeTimeoutPeriod');
    expect(functionNames(oracleRegistryAbi)).not.toContain('rulable');
    expect(V3_ABIS.Escrow).toBe(escrowAbi);
  });

  it('answer for the record deployed before the audit, by name', () => {
    expect(contractSetOf(deployment('rhc-mainnet-v3'))).toBe('v3');
    expect(contractSetOfEscrow(deployment('rhc-mainnet-v3').contracts.Escrow)).toBe('v3');
    expect(contractSetOf(deployment('rhc-mainnet-v2'))).toBe('v2');
  });
});

/**
 * The generated ABIs describe v4. A v3 contract answers everything it has through them, so v3 has
 * no frozen copy, and a reader has to be able to ask whether a set has what v4 added.
 */
describe('the v4 ABIs', () => {
  const named = (abi: readonly { type: string; name?: string }[], type: string) =>
    abi.filter((e) => e.type === type).map((e) => e.name);

  it('weigh reputation, observe pools and seize what a written-off line held', () => {
    for (const added of ['weights', 'creditOf', 'edgeVolume', 'setWeights']) {
      expect(named(BURSAR_ABIS.Reputation, 'function')).toContain(added);
    }
    for (const added of ['observe', 'drawValuation', 'aged', 'pending']) {
      expect(named(BURSAR_ABIS.PriceGuard, 'function')).toContain(added);
    }
    for (const added of ['drawHalt', 'seized', 'claimSeized']) {
      expect(named(BURSAR_ABIS.CollateralVault, 'function')).toContain(added);
    }
    expect(named(BURSAR_ABIS.Reputation, 'error')).toContain('BadWeights');
    expect(named(BURSAR_ABIS.PriceGuard, 'error')).toContain('NotKeeper');
    expect(named(BURSAR_ABIS.PriceGuard, 'function')).toContain('setKeeper');
    expect(named(BURSAR_ABIS.CollateralVault, 'error')).toContain('NothingSeized');
  });

  it('share the account, escrow and dispute contracts with v3', () => {
    expect(V4_ABIS).toBe(V3_ABIS);
  });

  it('answer for any record no earlier set names', () => {
    const v4 = parseDeployment({
      ...(RAW_DEPLOYMENTS['rhc-mainnet-v3'] as Record<string, unknown>),
      network: 'rhc-mainnet-v4',
      supersedes: 'rhc-mainnet-v3',
    });

    expect(contractSetOf(v4)).toBe('v4');
    expect(CURRENT_CONTRACT_SET).toBe('v4');
  });

  it('put the sets in the order they were built', () => {
    expect(contractSetAtLeast('v4', 'v4')).toBe(true);
    expect(contractSetAtLeast('v3', 'v4')).toBe(false);
    expect(contractSetAtLeast('v4', 'v3')).toBe(true);
    expect(contractSetAtLeast('v3', 'v3')).toBe(true);
    expect(contractSetAtLeast('v2', 'v3')).toBe(false);
    expect(contractSetAtLeast('v1', 'v2')).toBe(false);
    expect(contractSetAtLeast(CURRENT_CONTRACT_SET, 'v1')).toBe(true);
  });
});
