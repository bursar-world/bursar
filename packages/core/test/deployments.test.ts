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
  isPlannedDeploymentRecord,
  isSuperseded,
  isRetiredDeploymentRecord,
  parseCollateralDeployment,
  parseDeployment,
  parseRwaDeployment,
  selectDeploymentRecords,
} from '../src/deployments.js';
import type { DeploymentRecordFile } from '../src/deployments.js';
import { RHC_MAINNET } from '../src/chain.js';
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
    status: 'live',
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
    status: 'retired',
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

/** `raw` once `by` has replaced it on its chain: still read, no longer answering for the chain. */
function supersededBy(by: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...raw, status: 'superseded', supersededBy: by, ...overrides };
}

/**
 * A record as the v3 deploy scripts write it: the chain's endpoints left to the chain, what was
 * applied under `parameters` rather than `verifiedOnChain`, a token section, and the flags a run
 * reads before it starts. Addresses are made up.
 */
function scriptedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { rpc: _rpc, explorer: _explorer, verifiedOnChain: _verified, ...rest } = exampleRecord();
  return {
    ...rest,
    network: 'rhc-mainnet-v3',
    chainId: 4663,
    status: 'live',
    local: false,
    fromBlock: 1,
    supersedes: 'rhc-mainnet-v2',
    token: { Staking: fill('f'), Buyback: fill('0'), keeper: fill('9') },
    parameters: { 'Escrow.minLock': '10000' },
    ...overrides,
  };
}

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
    expect(parsed.status).toBe('live');
    expect(parsed.contracts.AdminTimelock).toBe(fill('1'));
    expect(parsed.retired).toBeUndefined();
  });

  it('reads what superseded a record', () => {
    const parsed = parseDeployment(supersededBy('example-net-v2'));
    expect(parsed.status).toBe('superseded');
    expect(parsed.supersededBy).toBe('example-net-v2');
  });

  it('refuses a record with no status, or one the schema does not list', () => {
    const { status: _dropped, ...unmarked } = raw;
    expect(() => parseDeployment(unmarked)).toThrow(/no "status"/);
    expect(() => parseDeployment({ ...raw, status: 'deployed' })).toThrow(/status is deployed/);
  });

  it('refuses a status its other fields contradict', () => {
    expect(() => parseDeployment({ ...raw, status: 'retired' })).toThrow(/does not say why/);
    expect(() => parseDeployment({ ...raw, retired: RETIRED_REASON })).toThrow(/its status is live/);
    expect(() => parseDeployment({ ...raw, status: 'superseded' })).toThrow(/does not name what superseded it/);
  });

  it('reads a record the v3 deploy scripts write, with the chain its own endpoints', () => {
    const parsed = parseDeployment(scriptedRecord());

    expect(parsed.rpc).toBe(RHC_MAINNET.rpcUrl);
    expect(parsed.explorer).toBe(RHC_MAINNET.explorer);
    expect(parsed.verifiedOnChain).toEqual({});
    expect(parsed.supersedes).toBe('rhc-mainnet-v2');
  });

  it('still asks a record on any other chain for its endpoints', () => {
    expect(() => parseDeployment(scriptedRecord({ chainId: EXAMPLE_CHAIN }))).toThrow(/has no "rpc"/);
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

  // Written to hold before and after the v3 record lands: whichever set is newest answers, and the
  // two before it stay readable behind it.
  it('answers for Robinhood Chain with the newest set and keeps v2 and v1 readable behind it', () => {
    const line = deploymentsForChain(4663).map((d) => d.network);
    expect(line.slice(-2)).toEqual(['rhc-mainnet-v2', 'rhc-mainnet']);
    expect(deploymentForChain(4663).network).toBe(line[0]);
    expect(deployment('rhc-mainnet-v2').supersedes).toBe('rhc-mainnet');
    expect(deployment('rhc-mainnet').chainId).toBe(4663);
    expect(isSuperseded(deployment('rhc-mainnet'))).toBe(true);
    expect(isSuperseded(deployment('rhc-mainnet-v2'))).toBe(line[0] !== 'rhc-mainnet-v2');
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

/** Assets as a deploy script writes them, keyed by symbol, with fields the SDK does not read. */
const KEYED_ASSETS = {
  SGOV: { address: fill('1'), feed: fill('b'), kind: 'treasury', poolId: `0x${'00'.repeat(32)}` },
  SPY: { address: fill('c'), feed: fill('d'), kind: 'stock' },
};

/** An RWA section as a deploy script writes it, with its collateral part. Addresses are made up. */
function rwaSection(assets: unknown = KEYED_ASSETS): Record<string, unknown> {
  return {
    AssetRegistry: fill('1'),
    PriceGuard: fill('2'),
    StockSpendRouter: fill('3'),
    TreasuryPark: fill('4'),
    adapters: { SGOV: fill('5'), USDG: fill('6') },
    assets,
    fromBlock: 43,
    collateral: {
      CreditPool: fill('7'),
      CollateralVault: fill('8'),
      Staking: fill('9'),
      lender: fill('e'),
      fromBlock: 50,
    },
  };
}

/**
 * The deploy scripts key a lane's assets by symbol, and every reader walks a list. A record that
 * reached a reader unparsed, such as a local rehearsal's handed to the SDK, failed as
 * `assets.find is not a function` far from the record, so both shapes are read and one is exposed.
 */
describe('a lane’s assets', () => {
  const LISTED = [
    { symbol: 'SGOV', address: fill('1'), feed: fill('b'), kind: 'treasury' },
    { symbol: 'SPY', address: fill('c'), feed: fill('d'), kind: 'stock' },
  ];

  it('lists assets a record keys by symbol, each carrying its symbol', () => {
    const parsed = parseDeployment(exampleRecord({ rwa: rwaSection() }));

    expect(parsed.rwa?.assets).toEqual(LISTED);
    expect(parsed.rwa?.collateral).toEqual({
      CreditPool: fill('7'),
      CollateralVault: fill('8'),
      Staking: fill('9'),
      fromBlock: 50,
    });
  });

  it('reads assets already listed the same way', () => {
    expect(parseDeployment(exampleRecord({ rwa: rwaSection(LISTED) })).rwa?.assets).toEqual(LISTED);
  });

  it('parses a parsed record again unchanged', () => {
    const once = parseDeployment(exampleRecord({ rwa: rwaSection() }));
    expect(parseDeployment(once)).toEqual(once);

    const shipped = DEPLOYMENTS['rhc-mainnet-v2'];
    expect(parseDeployment(shipped, 'rhc-mainnet-v2')).toEqual(shipped);
  });

  it('reads a record the local rehearsal writes: planned, marked local, with no explorer', () => {
    const parsed = parseDeployment(
      exampleRecord({
        network: 'local-4663',
        chainId: 4663,
        status: 'planned',
        local: true,
        explorer: '',
        rwa: rwaSection(),
      }),
    );

    expect(parsed.status).toBe('planned');
    expect(parsed.explorer).toBe('');
    expect(parsed.rwa?.assets.map((a) => a.symbol)).toEqual(['SGOV', 'SPY']);
  });

  it('refuses a listed asset with no symbol, a symbol listed twice, and a kind it does not know', () => {
    const [sgov, spy] = LISTED;
    const record = (assets: unknown): Record<string, unknown> => exampleRecord({ rwa: rwaSection(assets) });

    expect(() => parseDeployment(record([{ ...sgov, symbol: undefined }]))).toThrow(/assets\[0\] has no symbol/);
    expect(() => parseDeployment(record([spy, { ...spy, symbol: 'spy' }]))).toThrow(/lists spy twice/);
    expect(() => parseDeployment(record({ SPY: { ...spy, kind: 'bond' } }))).toThrow(/assets\.SPY: kind is bond/);
    expect(() => parseDeployment(record({ SPY: { ...spy, feed: '0xshort' } }))).toThrow(
      /assets\.SPY: "feed" is not an address/,
    );
    expect(() => parseDeployment(record('SPY'))).toThrow(/"assets" is not an object/);
  });

  it('reads an RWA section or its collateral part on its own', () => {
    expect(parseRwaDeployment(rwaSection()).assets).toEqual(LISTED);
    expect(parseCollateralDeployment(rwaSection()['collateral']).CreditPool).toBe(fill('7'));
    expect(() => parseRwaDeployment({ ...rwaSection(), StockSpendRouter: undefined })).toThrow(
      /Deployment record rwa: has no "StockSpendRouter"/,
    );
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
/**
 * From v4 the shielded pool holds each depositor to a window, and the deploy records the cap and
 * the window's length beside the pool's other limits. Both or neither: the console states the cap
 * and explains it with the window.
 */
describe('a shielded pool’s depositor window', () => {
  const live = RAW_DEPLOYMENTS['rhc-mainnet-v3'] as { privacy: { shielded: Record<string, unknown> } };
  const shieldedWith = (extra: Record<string, unknown>): Record<string, unknown> =>
    exampleRecord({ privacy: { ...live.privacy, shielded: { ...live.privacy.shielded, ...extra } } });

  it('is absent from a record written before the pool had one', () => {
    const shielded = parseDeployment(shieldedWith({})).privacy?.shielded;

    expect(shielded?.maxDeposit).toBe('100000000');
    expect(shielded?.maxPerDepositor).toBeUndefined();
    expect(shielded?.depositorWindow).toBeUndefined();
  });

  it('is read as the cap in atomic USDG and the window in seconds', () => {
    const shielded = parseDeployment(shieldedWith({ maxPerDepositor: '250000000', depositorWindow: 604_800 })).privacy
      ?.shielded;

    expect(shielded?.maxPerDepositor).toBe('250000000');
    expect(shielded?.depositorWindow).toBe(604_800);
  });

  it('is refused when the record carries one half of it', () => {
    expect(() => parseDeployment(shieldedWith({ maxPerDepositor: '250000000' }))).toThrow(/depositorWindow/);
    expect(() => parseDeployment(shieldedWith({ depositorWindow: 604_800 }))).toThrow(/maxPerDepositor/);
    expect(() => parseDeployment(shieldedWith({ maxPerDepositor: '250000000', depositorWindow: 0 }))).toThrow(
      /depositorWindow/,
    );
  });
});

describe('retired deployments', () => {
  afterEach(() => {
    vi.doUnmock('../src/generated/deployments.js');
    vi.resetModules();
  });

  it('marks a retired record and says why', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const old = book.deployment('example-old' as never);

    expect(old.status).toBe('retired');
    expect(old.retired).toBe(RETIRED_REASON);
    expect(isRetiredDeploymentRecord(retiredRecord())).toBe(true);
    expect(isRetiredDeploymentRecord(supersededBy('example-net-v2'))).toBe(false);
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

  it('names the newest record on a chain whose records are all retired, with its reason once', async () => {
    const retired = { status: 'retired', retired: RETIRED_REASON };
    const v1 = { ...raw, ...retired };
    const v2 = { ...raw, ...retired, network: 'example-net-v2', supersedes: 'example-net' };
    const book = await withAddressBook({ 'example-net': v1, 'example-net-v2': v2 });
    const error = capture(() => book.deploymentForChain(EXAMPLE_CHAIN)) as BursarError;

    expect(error.code).toBe('deployment_retired');
    expect(error.message.startsWith(`No live record for chain ${EXAMPLE_CHAIN}. "example-net-v2" is retired. ${RETIRED_REASON} `)).toBe(true);
    expect(error.message.split(RETIRED_REASON)).toHaveLength(2);
  });

  it('is not counted among the live deployments', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });
    const live = book.liveDeployments().map((d) => d.network);

    expect(live).toContain('example-net');
    expect(live).not.toContain('example-old');
  });

  it('answers for a chain with the superseding record and keeps the older one in service', async () => {
    const v2 = { ...raw, network: 'example-net-v2', supersedes: 'example-net' };
    const book = await withAddressBook({ 'example-net-v2': v2, 'example-net': supersededBy('example-net-v2') });

    expect(book.deploymentForChain(EXAMPLE_CHAIN).network).toBe('example-net-v2');
    expect(book.deploymentsForChain(EXAMPLE_CHAIN).map((d) => d.network)).toEqual([
      'example-net-v2',
      'example-net',
    ]);
    expect(book.liveDeployments().map((d) => d.network)).toContain('example-net');
    expect(book.deployment('example-net' as never).retired).toBeUndefined();
  });

  it('reads a third set on top of two, newest first, and lets only the newest answer', async () => {
    const v2 = supersededBy('example-net-v3', { network: 'example-net-v2', supersedes: 'example-net' });
    const v3 = { ...raw, network: 'example-net-v3', supersedes: 'example-net-v2' };
    const book = await withAddressBook({
      'example-net': supersededBy('example-net-v2'),
      'example-net-v2': v2,
      'example-net-v3': v3,
    });

    expect(book.deploymentForChain(EXAMPLE_CHAIN).network).toBe('example-net-v3');
    expect(book.deploymentsForChain(EXAMPLE_CHAIN).map((d) => d.network)).toEqual([
      'example-net-v3',
      'example-net-v2',
      'example-net',
    ]);
  });

  // Retiring a set stops new work on it. Its open locks and disputes are still on chain, so the
  // services that settle them keep reading it for as long as a newer set names it.
  it('keeps retired sets readable behind the one that superseded them', async () => {
    const retired = { status: 'retired', retired: RETIRED_REASON };
    const v1 = { ...raw, ...retired };
    const v2 = { ...raw, ...retired, network: 'example-net-v2', supersedes: 'example-net' };
    const v3 = { ...raw, network: 'example-net-v3', supersedes: 'example-net-v2' };
    const book = await withAddressBook({ 'example-net': v1, 'example-net-v2': v2, 'example-net-v3': v3 });

    expect(book.deploymentForChain(EXAMPLE_CHAIN).network).toBe('example-net-v3');
    expect(book.deploymentsForChain(EXAMPLE_CHAIN).map((d) => d.network)).toEqual([
      'example-net-v3',
      'example-net-v2',
      'example-net',
    ]);
    expect(book.liveDeployments().map((d) => d.network)).toEqual(['example-net-v3']);
  });

  // Marked superseded, it has handed the chain on, whether or not its successor is in the book.
  it('never answers for a chain with a superseded record', async () => {
    const book = await withAddressBook({ 'example-net': supersededBy('example-net-v2') });

    expect(book.deploymentsForChain(EXAMPLE_CHAIN).map((d) => d.network)).toEqual(['example-net']);
    expect((capture(() => book.deploymentForChain(EXAMPLE_CHAIN)) as BursarError).code).toBe('deployment_retired');
  });

  it('leaves out a retired record nothing supersedes', async () => {
    const book = await withAddressBook({ 'example-net': raw, 'example-old': retiredRecord() });

    expect(book.deploymentsForChain(OTHER_EXAMPLE_CHAIN)).toEqual([]);
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

  it('leaves the token record and any planned record on disk out of the address book', () => {
    const selected = selectDeploymentRecords(onDisk).map((file) => file.name);
    const left = onDisk.filter((f) => !isMandateDeploymentRecord(f.json) || isPlannedDeploymentRecord(f.json));
    for (const file of left) expect(selected).not.toContain(file.name);
  });

  // Its contracts can be deployed and recorded while the old set still holds money. Until it goes
  // live, it must not take the chain from the record it will supersede, or clash with it.
  it('keeps a planned record out, whatever it has recorded so far', () => {
    const files = [
      { name: 'example-net', json: raw },
      {
        name: 'example-net-v2',
        json: { ...raw, network: 'example-net-v2', status: 'planned', supersedes: 'example-net' },
      },
      { name: 'example-net-v3', json: { network: 'example-net-v3', status: 'planned', contracts: {} } },
    ];

    expect(isPlannedDeploymentRecord(files[1]?.json)).toBe(true);
    expect(selectDeploymentRecords(files).map((file) => file.name)).toEqual(['example-net']);
  });

  it('keeps a rehearsal record out of the address book, whatever chain it names', () => {
    const rehearsal = [{ name: 'rhc-mainnet-v3', json: scriptedRecord({ local: true }) }];

    expect(isMandateDeploymentRecord(rehearsal[0]?.json)).toBe(false);
    expect(selectDeploymentRecords(rehearsal)).toEqual([]);
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

  it('lets a superseded record share a chain with the live one', () => {
    const pair = [
      { name: 'example-net', json: supersededBy('example-net-v2') },
      { name: 'example-net-v2', json: { ...raw, network: 'example-net-v2', supersedes: 'example-net' } },
    ];

    expect(selectDeploymentRecords(pair)).toHaveLength(2);
  });

  it('parses every record it keeps, so a malformed one stops the generator rather than every service', () => {
    const files = [
      { name: 'example-net', json: raw },
      { name: 'example-old', json: { ...retiredRecord(), retired: undefined } },
    ];

    expect(() => selectDeploymentRecords(files)).toThrow(/does not say why/);
  });

  it('still stops a third live record that nothing supersedes', () => {
    const three = [
      { name: 'example-net', json: raw },
      { name: 'example-net-v2', json: { ...raw, network: 'example-net-v2', supersedes: 'example-net' } },
      { name: 'example-net-copy', json: { ...raw, network: 'example-net-copy' } },
    ];

    expect(() => selectDeploymentRecords(three)).toThrow(/both claim chain/);
  });

  it('keeps a record a retired successor took over from off its chain', () => {
    const line = [
      { name: 'example-net', json: raw },
      {
        name: 'example-net-v2',
        json: {
          ...raw,
          network: 'example-net-v2',
          supersedes: 'example-net',
          status: 'retired',
          retired: RETIRED_REASON,
        },
      },
      { name: 'example-net-v3', json: { ...raw, network: 'example-net-v3', supersedes: 'example-net-v2' } },
    ];

    expect(selectDeploymentRecords(line)).toHaveLength(3);
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
