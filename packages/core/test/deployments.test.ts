import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENTS,
  BURSAR_CONTRACT_NAMES,
  deployment,
  deploymentByContract,
  deploymentForChain,
  deploymentsForChain,
  isMandateDeploymentRecord,
  isSuperseded,
  isRetiredDeploymentRecord,
  parseDeployment,
  selectDeploymentRecords,
} from '../src/deployments.js';
import type { DeploymentRecordFile } from '../src/deployments.js';
import { BursarError } from '../src/errors.js';
import { RAW_DEPLOYMENTS } from '../src/generated/deployments.js';

const DEPLOYMENTS_DIR = fileURLToPath(new URL('../../../contracts/deployments', import.meta.url));

/** The source of truth a deploy writes. The generated module is a copy and is checked against it. */
function recordsOnDisk(): DeploymentRecordFile[] {
  return readdirSync(DEPLOYMENTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      name: basename(file, '.json'),
      json: JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, file), 'utf8')) as unknown,
    }));
}

const onDisk = recordsOnDisk();

/**
 * Chain ids nobody uses. The records below are made up, so the rules they exercise do not depend
 * on which deployments happen to be checked in.
 */
const EXAMPLE_CHAIN = 990_001;
const OTHER_EXAMPLE_CHAIN = 990_002;

const fill = (digit: string): string => `0x${digit.repeat(40)}`;

/** A complete core record on a fictional chain, with every address made up. */
function exampleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'example-net',
    chainId: EXAMPLE_CHAIN,
    rpc: 'https://rpc.example.invalid',
    explorer: 'https://explorer.example.invalid',
    settlementAsset: fill('a'),
    settlementDecimals: 6,
    deployer: fill('b'),
    contracts: {
      AdminTimelock: fill('1'),
      Reputation: fill('2'),
      Escrow: fill('3'),
      OracleRegistry: fill('4'),
      AgentRegistry: fill('5'),
      MandateAccountFactory: fill('6'),
    },
    roles: {
      timelockSigners: [fill('7'), fill('8'), fill('9')],
      guardian: fill('c'),
      treasury: fill('d'),
      slashSink: fill('e'),
    },
    verifiedOnChain: { 'Escrow.timelock': fill('1') },
    ...overrides,
  };
}

const RETIRED_REASON = 'Superseded by example-net. Kept as the record of what ran.';

/** The same shape, retired, on a second fictional chain. */
function retiredRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return exampleRecord({
    network: 'example-old',
    chainId: OTHER_EXAMPLE_CHAIN,
    retired: RETIRED_REASON,
    contracts: {
      AdminTimelock: fill('f'),
      Reputation: fill('2'),
      Escrow: fill('3'),
      OracleRegistry: fill('4'),
      AgentRegistry: fill('5'),
      MandateAccountFactory: fill('6'),
    },
    ...overrides,
  });
}

/** A token record: same directory and network name, none of the core contracts. */
const tokenRecord = {
  network: 'example-old',
  chainId: OTHER_EXAMPLE_CHAIN,
  contracts: { Token: fill('a') },
};

const raw = exampleRecord();

describe('deployment records', () => {
  it('matches what a deploy wrote, field for field', () => {
    const expected = Object.fromEntries(selectDeploymentRecords(onDisk).map((f) => [f.name, f.json]));
    expect(RAW_DEPLOYMENTS).toEqual(expected);
  });

  it('holds an address for every contract a record names', () => {
    for (const record of Object.values(DEPLOYMENTS)) {
      for (const name of BURSAR_CONTRACT_NAMES) {
        expect(record.contracts[name], `${record.network}.${name}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  it('accepts a complete record', () => {
    const parsed = parseDeployment(raw);
    expect(parsed.chainId).toBe(EXAMPLE_CHAIN);
    expect(parsed.contracts.AdminTimelock).toBe(fill('1'));
    expect(parsed.retired).toBeUndefined();
  });

  it('refuses a record that is not six-decimal', () => {
    expect(() => parseDeployment({ ...raw, settlementDecimals: 18 })).toThrow(/six-decimal micro-USD/);
  });

  it('refuses a record with a missing or malformed address', () => {
    const contracts = raw['contracts'] as Record<string, string>;
    expect(() =>
      parseDeployment({ ...raw, contracts: { ...contracts, Escrow: '0xshort' } }),
    ).toThrow(/"Escrow" is not an address/);

    const { Reputation: _dropped, ...withoutReputation } = contracts;
    expect(() => parseDeployment({ ...raw, contracts: withoutReputation })).toThrow(/no "Reputation"/);
  });

  it('refuses a record with no timelock signers', () => {
    const roles = raw['roles'] as Record<string, unknown>;
    expect(() => parseDeployment({ ...raw, roles: { ...roles, timelockSigners: [] } })).toThrow(
      /timelockSigners is empty/,
    );
  });

  // Robinhood Chain testnet is the network that answers and will never hold a record: USDG has no
  // contract on 46630, so nothing deployed there could settle. It is the unknown name that stays
  // unknown, which is what this assertion needs.
  it('names an unknown network and points at the regeneration step', () => {
    expect(() => deployment('rhc-testnet' as never)).toThrow(/codegen/);
  });

  it('answers for Robinhood Chain with v2 and keeps v1 live and readable by name', () => {
    expect(deploymentForChain(4663).network).toBe('rhc-mainnet-v2');
    expect(deployment('rhc-mainnet-v2').supersedes).toBe('rhc-mainnet');
    expect(deployment('rhc-mainnet').chainId).toBe(4663);
    expect(deployment('rhc-mainnet').retired).toBeUndefined();
    expect(deploymentsForChain(4663).map((d) => d.network)).toEqual(['rhc-mainnet-v2', 'rhc-mainnet']);
    expect(isSuperseded(deployment('rhc-mainnet'))).toBe(true);
    expect(isSuperseded(deployment('rhc-mainnet-v2'))).toBe(false);
  });

  it('finds the record behind a contract address, whichever set it belongs to', () => {
    const v1 = deployment('rhc-mainnet');
    const v2 = deployment('rhc-mainnet-v2');
    expect(deploymentByContract('Escrow', v1.contracts.Escrow)?.network).toBe('rhc-mainnet');
    expect(deploymentByContract('Escrow', v2.contracts.Escrow.toLowerCase() as never)?.network).toBe(
      'rhc-mainnet-v2',
    );
    expect(deploymentByContract('Escrow', fill('0') as never)).toBeUndefined();
  });
});

/**
 * Loads the deployments module against an address book of our choosing. The module parses the
 * generated records at import, so the only way to show it a retired record is to hand it one in
 * place of the generated file.
 */
async function withAddressBook(
  records: Record<string, unknown>,
): Promise<typeof import('../src/deployments.js')> {
  vi.resetModules();
  vi.doMock('../src/generated/deployments.js', () => ({ RAW_DEPLOYMENTS: records }));
  return import('../src/deployments.js');
}

/**
 * A retired deployment is history. Its contracts are still on their chain and would still take a
 * call, which is why a lookup by chain id must not hand the record back: a service that
 * resolves by chain and gets a superseded address book reads stale state and writes to contracts
 * nobody is watching. Named explicitly it still resolves, because the account of what ran has to
 * survive.
 */
describe('retired deployments', () => {
  afterEach(() => {
    vi.doUnmock('../src/generated/deployments.js');
    vi.resetModules();
  });

  it('marks a retired record and says why', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const old = book.deployment('example-old' as never);

    expect(old.retired).toBe(RETIRED_REASON);
    expect(isRetiredDeploymentRecord(retiredRecord())).toBe(true);
    expect(isRetiredDeploymentRecord({ ...retiredRecord(), retired: undefined })).toBe(false);
  });

  it('is still readable by name, with its addresses intact', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });

    expect(book.deployment('example-old' as never).chainId).toBe(OTHER_EXAMPLE_CHAIN);
    expect(book.contractAddress('example-old' as never, 'AdminTimelock')).toBe(fill('f'));
  });

  it('is skipped when resolving a chain, and says so rather than 404ing', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const error = capture(() => book.deploymentForChain(OTHER_EXAMPLE_CHAIN)) as BursarError;

    expect(error.code).toBe('deployment_retired');
    expect(error.message).toContain('example-old');
    expect(error.message).toContain('retired');
    expect(book.deploymentForChain(EXAMPLE_CHAIN).network).toBe('example-net');
  });

  it('is not counted among the live deployments', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const live = book.liveDeployments().map((d) => d.network);

    expect(live).toContain('example-net');
    expect(live).not.toContain('example-old');
  });

  it('answers for a chain with the superseding record and keeps the older one live', async () => {
    const v2 = { ...raw, network: 'example-net-v2', supersedes: 'example-net' };
    const book = await withAddressBook({ 'example-net-v2': v2, 'example-net': raw });

    expect(book.deploymentForChain(EXAMPLE_CHAIN).network).toBe('example-net-v2');
    expect(book.deploymentsForChain(EXAMPLE_CHAIN).map((d) => d.network)).toEqual([
      'example-net-v2',
      'example-net',
    ]);
    expect(book.liveDeployments().map((d) => d.network)).toContain('example-net');
    expect(book.deployment('example-net' as never).retired).toBeUndefined();
  });

  it('reports a chain nobody has deployed to as unknown, not retired', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const error = capture(() => book.deploymentForChain(46630)) as BursarError;

    expect(error.code).toBe('deployment_unknown');
    expect(error.message).toContain('46630');
  });
});

/**
 * The address book is parsed at import, so anything it refuses takes out every service at
 * start-up. It holds whatever is in contracts/deployments, which includes the token records and
 * may include retired ones, and it has to build from a directory holding none, one or all of them.
 */
describe('selecting what the address book may hold', () => {
  it('takes only the records carrying the BURSAR contract set', () => {
    const files: DeploymentRecordFile[] = [
      { name: 'example-net', json: raw },
      { name: 'example-old', json: retiredRecord() },
      { name: 'example-old-token', json: tokenRecord },
    ];

    const selected = selectDeploymentRecords(files).map((file) => file.name);
    const rejected = files.filter((file) => !isMandateDeploymentRecord(file.json));

    // The token deployment sits in the same directory under the same network name. Parsing it as a
    // core record throws, so a stray record would take out every service at start-up.
    expect(rejected.map((file) => file.name)).toEqual(['example-old-token']);
    expect(selected).toEqual(['example-net', 'example-old']);
    for (const file of rejected) expect(() => parseDeployment(file.json, file.name)).toThrow();
  });

  it('leaves the token record on disk out of the address book', () => {
    const selected = selectDeploymentRecords(onDisk).map((file) => file.name);
    for (const file of onDisk.filter((f) => !isMandateDeploymentRecord(f.json))) {
      expect(selected).not.toContain(file.name);
    }
  });

  it('tolerates a directory with nothing in it', () => {
    expect(selectDeploymentRecords([])).toEqual([]);
  });

  it('tolerates a directory holding nothing but notes', () => {
    expect(selectDeploymentRecords([{ name: 'notes', json: { contracts: {} } }])).toEqual([]);
  });

  it('tolerates a directory holding only retired records', () => {
    const retiredOnly = [
      { name: 'example-old', json: retiredRecord() },
      { name: 'example-old-token', json: tokenRecord },
    ];
    expect(() => selectDeploymentRecords(retiredOnly)).not.toThrow();
  });

  it('stops when two live records claim one chain rather than letting directory order decide', () => {
    const twice = [
      { name: 'example-net', json: raw },
      { name: 'example-net-copy', json: { ...raw, network: 'example-net-copy' } },
    ];

    expect(() => selectDeploymentRecords(twice)).toThrow(
      new RegExp(`both claim chain ${EXAMPLE_CHAIN}`),
    );
  });

  it('lets a record share a chain with the one it names in supersedes', () => {
    const pair = [
      { name: 'example-net', json: raw },
      { name: 'example-net-v2', json: { ...raw, network: 'example-net-v2', supersedes: 'example-net' } },
    ];

    expect(selectDeploymentRecords(pair)).toHaveLength(2);
  });

  it('still stops a third live record that nothing supersedes', () => {
    const three = [
      { name: 'example-net', json: raw },
      { name: 'example-net-v2', json: { ...raw, network: 'example-net-v2', supersedes: 'example-net' } },
      { name: 'example-net-copy', json: { ...raw, network: 'example-net-copy' } },
    ];

    expect(() => selectDeploymentRecords(three)).toThrow(/both claim chain/);
  });

  it('lets two retired records share a chain, because nothing resolves them by one', () => {
    const twice = [
      { name: 'example-old', json: retiredRecord() },
      { name: 'example-older', json: retiredRecord({ network: 'example-older' }) },
    ];

    expect(selectDeploymentRecords(twice)).toHaveLength(2);
  });
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('lookups by an external name', () => {
  it('does not hand back a prototype member as a deployment', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(() => deployment(name as never)).toThrow(/No deployment named/);
    }
  });
});
