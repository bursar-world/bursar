import type { Address } from 'viem';
import { RHC_MAINNET } from './chain.js';
import { BursarError } from './errors.js';
import { MICRO_DECIMALS } from './money.js';

/**
 * What a deployment record is, kept apart from the generated address book that holds them.
 *
 * codegen imports this module to decide which records it may emit. Reading it from deployments.ts
 * instead would mean codegen could not run while the file it exists to rewrite is broken, which is
 * the one moment it is needed.
 */
export type MandateContractName =
  | 'AdminTimelock'
  | 'Reputation'
  | 'Escrow'
  | 'OracleRegistry'
  | 'AgentRegistry'
  | 'MandateAccountFactory';

export const BURSAR_CONTRACT_NAMES = [
  'AdminTimelock',
  'Reputation',
  'Escrow',
  'OracleRegistry',
  'AgentRegistry',
  'MandateAccountFactory',
] as const satisfies readonly MandateContractName[];

export type DeploymentRoles = {
  readonly timelockSigners: readonly Address[];
  readonly guardian: Address;
  readonly treasury: Address;
  readonly slashSink: Address;
  /** The resolver keys governance vetted, where the record names them. */
  readonly resolvers: readonly Address[];
};

/**
 * Where a record stands, as contracts/deployments/schema.json defines it. A planned record's
 * contracts are not all deployed yet. A live one answers for its chain. A superseded one no longer
 * does and is still read, because its contracts still hold money. A retired one is the account of
 * what ran.
 */
export type DeploymentStatus = 'planned' | 'live' | 'superseded' | 'retired';

const STATUSES: readonly DeploymentStatus[] = ['planned', 'live', 'superseded', 'retired'];

export type Deployment = {
  readonly network: string;
  readonly chainId: number;
  readonly status: DeploymentStatus;
  /** The chain's own public endpoints when the record names none, as the v3 records do. */
  readonly rpc: string;
  readonly explorer: string;
  readonly settlementAsset: Address;
  /** Always six. A record claiming anything else is a different unit system and is rejected. */
  readonly settlementDecimals: 6;
  readonly deployer: Address;
  readonly contracts: Readonly<Record<MandateContractName, Address>>;
  /**
   * The timelock that keeps the escrow's brake, pause and unpause, where the record names one apart
   * from its AdminTimelock. From v4 on it is the one-hour delay the third set was governed by.
   */
  readonly escrowPauser?: Address;
  readonly roles: DeploymentRoles;
  /**
   * Wiring read back from chain after the deploy, keyed as "contract.field". Empty for a v3 record,
   * which keeps what it applied and read back under `parameters`.
   */
  readonly verifiedOnChain: Readonly<Record<string, string | number>>;
  /**
   * The mandates the record names as its live examples, the ones a reader with no wallet is shown.
   * Each is absent until the script that creates it has run.
   */
  readonly examples: Readonly<{ mandate?: Address; committedMandate?: Address; collateralMandate?: Address }>;
  /** Anything the deploy left unfinished. Present means a human still owes an action. */
  readonly pending?: string;
  /**
   * Why this deployment takes no new work, in a sentence. Present exactly when the status is
   * retired. A retired record a newer one supersedes is still read, because its locks and disputes
   * are still on chain; one nothing supersedes is kept only as the record of what ran.
   */
  readonly retired?: string;
  /**
   * The record this one replaces on its chain. The replaced record stays readable by name and
   * through `deploymentsForChain`, because its contracts still hold locks and disputes, but it no
   * longer answers a lookup by chain id.
   */
  readonly supersedes?: string;
  /** The record that replaced this one. Present whenever the status is superseded. */
  readonly supersededBy?: string;
  /** A development deployment: live on its chain, with settings that change before launch. */
  readonly dev?: boolean;
  /** Gas cost of the deploy, in ETH. What a Robinhood Chain deploy writes. */
  readonly deployCostEth?: string;
  /** The same figure from a retired deployment on a chain where gas was paid in USDC. */
  readonly deployCostUsdc?: string;
  readonly note?: string;
  /** The RWA lane (asset registry, price guard, stock router, treasury park), where deployed. */
  readonly rwa?: RwaDeployment;
  /** Committed mandates, disclosure grants and the solvency log (M4), where deployed. */
  readonly privacy?: PrivacyDeployment;
};

export type PrivacyDeployment = {
  readonly WithinMandateVerifier: Address;
  /** Committed mandates that lock on this record's escrow. */
  readonly CommittedMandateFactory: Address;
  /** Committed mandates that lock on the previous record's escrow, where one was deployed. */
  readonly CommittedMandateFactoryV1Escrow?: Address;
  readonly DisclosureRegistry: Address;
  readonly SolvencyLog: Address;
  /** First block to scan for privacy events. */
  readonly fromBlock: number;
  readonly shielded?: ShieldedDeployment;
};

/** The F17 shielded USDG pool: Privacy Pools v1.3.0 with Bursar's caps, relay and ASP. */
export type ShieldedDeployment = {
  readonly Entrypoint: Address;
  readonly ShieldedPool: Address;
  readonly ShieldedRelay: Address;
  readonly WithdrawalVerifier: Address;
  readonly CommitmentVerifier: Address;
  readonly AccessRegistry: Address;
  readonly asset: Address;
  /** The pool's SCOPE, as a decimal string. */
  readonly scope: string;
  /** Atomic USDG, as decimal strings. */
  readonly maxDeposit: string;
  readonly maxTotal: string;
  readonly minimumDeposit: string;
  /**
   * The most one depositor may put in during one window, in atomic USDG, and the window's length in
   * seconds. Recorded together by a pool that holds each depositor to a window; a pool from before
   * v4 has neither.
   */
  readonly maxPerDepositor?: string;
  readonly depositorWindow?: number;
  readonly maxRelayFeeBps: number;
  readonly aspPostman: Address;
  readonly relayer: Address;
  /** First block to scan for pool events. */
  readonly fromBlock: number;
};

export type RwaAssetKind = 'stock' | 'treasury';

export type RwaAssetRecord = {
  readonly symbol: string;
  readonly address: Address;
  readonly feed: Address;
  readonly kind: RwaAssetKind;
};

export type RwaDeployment = {
  readonly AssetRegistry: Address;
  readonly PriceGuard: Address;
  readonly StockSpendRouter: Address;
  readonly TreasuryPark: Address;
  /** Park adapter per parked asset symbol. `USDG` parks as USDG. */
  readonly adapters: Readonly<Record<string, Address>>;
  /** Factory for accounts that unpark inside a spend. */
  readonly MandateAccountFactoryV21?: Address;
  /** What the registry held at deploy. The registry itself is the authority. */
  readonly assets: readonly RwaAssetRecord[];
  /** The collateral lane (F11), where deployed. */
  readonly collateral?: CollateralDeployment;
};

/** The collateral lane: posted stock and treasury tokens, and the USDG lent against them. */
export type CollateralDeployment = {
  readonly CreditPool: Address;
  readonly CollateralVault: Address;
  /** Where the spread is paid, once governance names the pool as its credit manager. */
  readonly Staking: Address;
  /** First block to scan for lane events. */
  readonly fromBlock: number;
};

class DeploymentError extends BursarError {
  constructor(label: string, detail: string) {
    super('deployment_invalid', `Deployment record ${label}: ${detail}`, { label, detail });
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function field(record: Record<string, unknown>, label: string, key: string): unknown {
  const value = record[key];
  if (value === undefined) throw new DeploymentError(label, `has no "${key}".`);
  return value;
}

function str(record: Record<string, unknown>, label: string, key: string): string {
  const value = field(record, label, key);
  if (typeof value !== 'string') throw new DeploymentError(label, `"${key}" is not a string.`);
  return value;
}

function address(record: Record<string, unknown>, label: string, key: string): Address {
  const value = str(record, label, key);
  if (!ADDRESS.test(value)) throw new DeploymentError(label, `"${key}" is not an address: ${value}`);
  return value as Address;
}

function object(value: unknown, label: string, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeploymentError(label, `"${key}" is not an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validates a deployment record read from contracts/deployments. Strict: a service that starts
 * with a half-populated address book will point real money at the zero address.
 */
export function parseDeployment(json: unknown, label = 'record'): Deployment {
  const record = object(json, label, 'root');
  const name = str(record, label, 'network');

  const chainId = field(record, label, 'chainId');
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    throw new DeploymentError(name, 'chainId is not a positive integer.');
  }

  const decimals = field(record, label, 'settlementDecimals');
  if (decimals !== MICRO_DECIMALS) {
    throw new DeploymentError(
      name,
      `settlementDecimals is ${String(decimals)}. BURSAR accounts in six-decimal micro-USD end to end.`,
    );
  }

  const status = field(record, name, 'status');
  if (!STATUSES.includes(status as DeploymentStatus)) {
    throw new DeploymentError(name, `status is ${String(status)}, not one of ${STATUSES.join(', ')}.`);
  }
  const reason = typeof record['retired'] === 'string';
  if (status === 'retired' && !reason) throw new DeploymentError(name, 'is retired and does not say why.');
  // A reason on a record still in service would read as retired to anything that checks for one.
  if (status !== 'retired' && reason) {
    throw new DeploymentError(name, `says why it retired, and its status is ${String(status)}.`);
  }
  if (status === 'superseded' && typeof record['supersededBy'] !== 'string') {
    throw new DeploymentError(name, 'is superseded and does not name what superseded it.');
  }

  const contractsRecord = object(field(record, name, 'contracts'), name, 'contracts');
  const contracts: Record<string, Address> = {};
  for (const contract of BURSAR_CONTRACT_NAMES) {
    contracts[contract] = address(contractsRecord, name, contract);
  }

  // A record file keeps it among its contracts; a parsed record carries it beside them.
  const escrowPauser =
    contractsRecord['escrowPauser'] !== undefined
      ? address(contractsRecord, name, 'escrowPauser')
      : record['escrowPauser'] !== undefined
        ? address(record, name, 'escrowPauser')
        : undefined;

  const rolesRecord = object(field(record, name, 'roles'), name, 'roles');
  const signers = rolesRecord['timelockSigners'];
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new DeploymentError(name, 'roles.timelockSigners is empty.');
  }
  for (const signer of signers) {
    if (typeof signer !== 'string' || !ADDRESS.test(signer)) {
      throw new DeploymentError(name, `roles.timelockSigners holds a non-address: ${String(signer)}`);
    }
  }

  const resolvers = rolesRecord['resolvers'] === undefined ? [] : rolesRecord['resolvers'];
  if (!Array.isArray(resolvers)) throw new DeploymentError(name, 'roles.resolvers is not a list.');
  for (const resolver of resolvers) {
    if (typeof resolver !== 'string' || !ADDRESS.test(resolver)) {
      throw new DeploymentError(name, `roles.resolvers holds a non-address: ${String(resolver)}`);
    }
  }

  // Records from the v3 deploy scripts keep what they read back under `parameters` instead.
  const verified =
    record['verifiedOnChain'] === undefined ? {} : object(record['verifiedOnChain'], name, 'verifiedOnChain');
  const verifiedOnChain: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(verified)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new DeploymentError(name, `verifiedOnChain.${key} is neither a string nor a number.`);
    }
    verifiedOnChain[key] = value;
  }

  // A record file names each example under its own key; a parsed record carries them under
  // `examples`, and parsing that again has to read the same addresses back.
  const examples: { mandate?: Address; committedMandate?: Address; collateralMandate?: Address } = {};
  const parsedExamples = record['examples'] === undefined ? {} : object(record['examples'], name, 'examples');
  for (const [key, section] of [
    ['exampleMandate', 'mandate'],
    ['exampleCommittedMandate', 'committedMandate'],
    ['exampleCollateralMandate', 'collateralMandate'],
  ] as const) {
    if (record[key] !== undefined) examples[section] = address(object(record[key], name, key), name, 'address');
    else if (parsedExamples[section] !== undefined) examples[section] = address(parsedExamples, name, section);
  }

  const rwa = record['rwa'] === undefined ? undefined : parseRwa(record['rwa'], `${name}.rwa`);
  const privacy = record['privacy'] === undefined ? undefined : parsePrivacy(record['privacy'], name);

  const optionalString = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  };

  // Robinhood Chain's public endpoints are fixed, and the v3 deploy scripts leave them to the chain
  // rather than write them into every record. Any other chain still has to name its own.
  const endpoint = (key: 'rpc' | 'explorer'): string =>
    record[key] === undefined && chainId === RHC_MAINNET.chainId
      ? key === 'rpc'
        ? RHC_MAINNET.rpcUrl
        : RHC_MAINNET.explorer
      : str(record, name, key);

  return Object.freeze({
    network: name,
    chainId,
    status: status as DeploymentStatus,
    rpc: endpoint('rpc'),
    explorer: endpoint('explorer'),
    settlementAsset: address(record, name, 'settlementAsset'),
    settlementDecimals: MICRO_DECIMALS,
    deployer: address(record, name, 'deployer'),
    contracts: Object.freeze(contracts) as Readonly<Record<MandateContractName, Address>>,
    ...(escrowPauser === undefined ? {} : { escrowPauser }),
    roles: Object.freeze({
      timelockSigners: Object.freeze(signers as Address[]),
      guardian: address(rolesRecord, name, 'guardian'),
      treasury: address(rolesRecord, name, 'treasury'),
      slashSink: address(rolesRecord, name, 'slashSink'),
      resolvers: Object.freeze(resolvers.map((resolver) => resolver as Address)),
    }),
    verifiedOnChain: Object.freeze(verifiedOnChain),
    examples: Object.freeze(examples),
    ...(optionalString('pending') === undefined ? {} : { pending: optionalString('pending') }),
    ...(optionalString('retired') === undefined ? {} : { retired: optionalString('retired') }),
    ...(optionalString('supersedes') === undefined ? {} : { supersedes: optionalString('supersedes') }),
    ...(optionalString('supersededBy') === undefined ? {} : { supersededBy: optionalString('supersededBy') }),
    ...(record['dev'] === true ? { dev: true } : {}),
    ...(optionalString('deployCostEth') === undefined
      ? {}
      : { deployCostEth: optionalString('deployCostEth') }),
    ...(optionalString('deployCostUsdc') === undefined
      ? {}
      : { deployCostUsdc: optionalString('deployCostUsdc') }),
    ...(optionalString('note') === undefined ? {} : { note: optionalString('note') }),
    ...(rwa === undefined ? {} : { rwa }),
    ...(privacy === undefined ? {} : { privacy }),
  }) as Deployment;
}

function parsePrivacy(json: unknown, name: string): PrivacyDeployment {
  const r = object(json, name, 'privacy');
  const label = `${name}.privacy`;
  const fromBlock = r['fromBlock'];
  if (typeof fromBlock !== 'number' || !Number.isInteger(fromBlock) || fromBlock < 0) {
    throw new DeploymentError(label, 'fromBlock is not a block number.');
  }
  return Object.freeze({
    WithinMandateVerifier: address(r, label, 'WithinMandateVerifier'),
    CommittedMandateFactory: address(r, label, 'CommittedMandateFactory'),
    ...(r['CommittedMandateFactoryV1Escrow'] === undefined
      ? {}
      : { CommittedMandateFactoryV1Escrow: address(r, label, 'CommittedMandateFactoryV1Escrow') }),
    DisclosureRegistry: address(r, label, 'DisclosureRegistry'),
    SolvencyLog: address(r, label, 'SolvencyLog'),
    fromBlock,
    ...(r['shielded'] === undefined ? {} : { shielded: parseShielded(r['shielded'], label) }),
  });
}

function parseShielded(json: unknown, parent: string): ShieldedDeployment {
  const label = `${parent}.shielded`;
  const r = object(json, parent, 'shielded');
  const block = (key: string): number => {
    const value = r[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new DeploymentError(label, `${key} is not a block number.`);
    }
    return value;
  };
  const decimal = (key: string): string => {
    const value = str(r, label, key);
    if (!/^\d+$/.test(value)) throw new DeploymentError(label, `"${key}" is not a decimal integer: ${value}`);
    return value;
  };
  const bps = r['maxRelayFeeBps'];
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new DeploymentError(label, 'maxRelayFeeBps is not a basis-point figure.');
  }
  // One without the other is a pool whose limit a reader could state and not explain.
  const windowed = r['maxPerDepositor'] !== undefined || r['depositorWindow'] !== undefined;
  const window = r['depositorWindow'];
  if (windowed && (typeof window !== 'number' || !Number.isInteger(window) || window <= 0)) {
    throw new DeploymentError(label, 'depositorWindow is not a positive number of seconds.');
  }
  return Object.freeze({
    Entrypoint: address(r, label, 'Entrypoint'),
    ShieldedPool: address(r, label, 'ShieldedPool'),
    ShieldedRelay: address(r, label, 'ShieldedRelay'),
    WithdrawalVerifier: address(r, label, 'WithdrawalVerifier'),
    CommitmentVerifier: address(r, label, 'CommitmentVerifier'),
    AccessRegistry: address(r, label, 'AccessRegistry'),
    asset: address(r, label, 'asset'),
    scope: decimal('scope'),
    maxDeposit: decimal('maxDeposit'),
    maxTotal: decimal('maxTotal'),
    minimumDeposit: decimal('minimumDeposit'),
    ...(windowed ? { maxPerDepositor: decimal('maxPerDepositor'), depositorWindow: window as number } : {}),
    maxRelayFeeBps: bps,
    aspPostman: address(r, label, 'aspPostman'),
    relayer: address(r, label, 'relayer'),
    fromBlock: block('fromBlock'),
  });
}

/**
 * The assets a lane was deployed with, as a list.
 *
 * A record on disk keys them by symbol, which is how the deploy scripts write them, and a parsed
 * record lists them with the symbol inside each entry. Both shapes are read, so a record that has
 * been parsed once parses again unchanged, and every reader gets the list.
 */
function parseAssets(json: unknown, label: string): readonly RwaAssetRecord[] {
  let entries: [string, unknown][];
  if (Array.isArray(json)) {
    entries = json.map((value, index) => {
      const symbol = (object(value, label, `assets[${index}]`) as { symbol?: unknown }).symbol;
      if (typeof symbol !== 'string' || symbol === '') {
        throw new DeploymentError(label, `assets[${index}] has no symbol.`);
      }
      return [symbol, value];
    });
  } else {
    entries = Object.entries(object(json, label, 'assets'));
  }

  // Symbols are looked up without regard to case, so two that differ only in case are one name.
  const seen = new Set<string>();
  return Object.freeze(
    entries.map(([symbol, value]) => {
      const key = symbol.toUpperCase();
      if (seen.has(key)) throw new DeploymentError(label, `lists ${symbol} twice among its assets.`);
      seen.add(key);

      const at = `${label}.assets.${symbol}`;
      const a = object(value, label, `assets.${symbol}`);
      const kind = a['kind'];
      if (kind !== 'stock' && kind !== 'treasury') throw new DeploymentError(at, `kind is ${String(kind)}.`);
      return Object.freeze({ symbol, address: address(a, at, 'address'), feed: address(a, at, 'feed'), kind });
    }),
  );
}

/**
 * Validates the RWA section of a record on its own, with its collateral lane if it has one.
 *
 * What a lane client reads when it is handed a lane rather than taking one from its connection's
 * record. The assets may be keyed by symbol, as a record on disk keys them, or listed, as a parsed
 * record lists them.
 */
export function parseRwaDeployment(json: unknown, label = 'rwa'): RwaDeployment {
  return parseRwa(json, label);
}

/** Validates the collateral section of a record's RWA lane on its own. */
export function parseCollateralDeployment(json: unknown, parent = 'rwa'): CollateralDeployment {
  return parseCollateral(json, parent);
}

function parseRwa(json: unknown, label: string): RwaDeployment {
  const r = object(json, label, 'rwa');
  const adaptersRecord = object(field(r, label, 'adapters'), label, 'adapters');
  const adapters: Record<string, Address> = {};
  for (const symbol of Object.keys(adaptersRecord)) adapters[symbol] = address(adaptersRecord, label, symbol);

  const assets = parseAssets(field(r, label, 'assets'), label);

  return Object.freeze({
    AssetRegistry: address(r, label, 'AssetRegistry'),
    PriceGuard: address(r, label, 'PriceGuard'),
    StockSpendRouter: address(r, label, 'StockSpendRouter'),
    TreasuryPark: address(r, label, 'TreasuryPark'),
    adapters: Object.freeze(adapters),
    ...(r['MandateAccountFactoryV21'] === undefined
      ? {}
      : { MandateAccountFactoryV21: address(r, label, 'MandateAccountFactoryV21') }),
    assets,
    ...(r['collateral'] === undefined ? {} : { collateral: parseCollateral(r['collateral'], label) }),
  });
}

function parseCollateral(json: unknown, parent: string): CollateralDeployment {
  const r = object(json, parent, 'collateral');
  const label = `${parent}.collateral`;
  const fromBlock = r['fromBlock'];
  if (typeof fromBlock !== 'number' || !Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw new DeploymentError(label, `fromBlock is ${String(fromBlock)}.`);
  }
  return Object.freeze({
    CreditPool: address(r, label, 'CreditPool'),
    CollateralVault: address(r, label, 'CollateralVault'),
    Staking: address(r, label, 'Staking'),
    fromBlock,
  });
}

function statusOf(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  return (json as { status?: unknown }).status;
}

/**
 * Whether a record is history. A retired deployment keeps its addresses so the account of what ran
 * survives, and stops answering a lookup by chain id: the contracts are still on that chain and
 * would still take a call.
 */
export function isRetiredDeploymentRecord(json: unknown): boolean {
  return statusOf(json) === 'retired';
}

/**
 * Whether a record describes a deployment still under way. Some of its contracts may not exist yet,
 * and the ones that do take no work until the record goes live.
 */
export function isPlannedDeploymentRecord(json: unknown): boolean {
  return statusOf(json) === 'planned';
}

export type DeploymentRecordFile = {
  /** The record's name downstream, which is the file's basename. */
  readonly name: string;
  readonly json: unknown;
};

/**
 * Whether a record in contracts/deployments is a core BURSAR deployment.
 *
 * That directory holds more than the core six. The token deployment lives there too, under the
 * same network name and chain id and with none of these addresses. A record is recognised by the
 * contract set it carries, not by the name of the file it arrived in, and a record marked `local`
 * is a rehearsal and never one.
 */
export function isMandateDeploymentRecord(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  // A rehearsal's addresses are on a throwaway chain that may carry this chain's id. Served as the
  // real thing, they would send payments to contracts that exist nowhere else.
  if ((json as { local?: unknown }).local === true) return false;
  const contracts = (json as { contracts?: unknown }).contracts;
  if (typeof contracts !== 'object' || contracts === null || Array.isArray(contracts)) return false;
  const named = contracts as Record<string, unknown>;
  return BURSAR_CONTRACT_NAMES.every((contract) => typeof named[contract] === 'string');
}

/**
 * The records this package may serve, in the order given.
 *
 * Emitting anything else is what turns a new file in contracts/deployments into an import-time
 * crash in every service, since the address book is parsed on load, so every record kept is parsed
 * here first. A planned record is left out: until it goes live it must not answer for its chain, or
 * take the chain from the record it will supersede. Superseded and retired records stay, readable
 * by name.
 *
 * Two live records answering to one chain stop here as well, unless one names the other in
 * `supersedes`: then the newer one answers for the chain and the older one stays readable by name.
 * Two records left unclaimed on one chain means a lookup by chain id would depend on directory
 * order, and that is not a lookup. Only a live record answers for a chain, so no other can clash.
 *
 * An empty result is allowed. The workspace has to build before anything is
 * deployed, and it has to build on a checkout whose only records are retired ones; a throw here
 * lands at import in every service and in the code generator whose whole job is to fix it.
 */
export function selectDeploymentRecords(
  files: readonly DeploymentRecordFile[],
): readonly DeploymentRecordFile[] {
  const selected = files.filter(
    (file) => isMandateDeploymentRecord(file.json) && !isPlannedDeploymentRecord(file.json),
  );
  const parsed = selected.map((file) => ({ name: file.name, record: parseDeployment(file.json, file.name) }));

  const heads = new Map<number, string>();
  for (const { name, record } of parsed) {
    if (record.status !== 'live') continue;
    // A retired successor still replaces what it names: retiring it later does not hand its
    // chain back to the record it took over from.
    const replaced = parsed.some(
      ({ record: other }) => other.supersedes === name && other.chainId === record.chainId,
    );
    if (replaced) continue;
    const clash = heads.get(record.chainId);
    if (clash !== undefined) {
      throw new BursarError(
        'deployment_ambiguous',
        `${name} and ${clash} both claim chain ${record.chainId}. One of them has to go, or name the ` +
          'other in "supersedes": a service asks for a chain, not for a file.',
        { chainId: record.chainId, records: [clash, name] },
      );
    }
    heads.set(record.chainId, name);
  }

  return selected;
}
