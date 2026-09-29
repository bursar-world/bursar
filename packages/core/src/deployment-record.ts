import type { Address } from 'viem';
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
};

export type Deployment = {
  readonly network: string;
  readonly chainId: number;
  readonly rpc: string;
  readonly explorer: string;
  readonly settlementAsset: Address;
  /** Always six. A record claiming anything else is a different unit system and is rejected. */
  readonly settlementDecimals: 6;
  readonly deployer: Address;
  readonly contracts: Readonly<Record<MandateContractName, Address>>;
  readonly roles: DeploymentRoles;
  /** Wiring read back from chain after the deploy, keyed as "contract.field". */
  readonly verifiedOnChain: Readonly<Record<string, string | number>>;
  /** Anything the deploy left unfinished. Present means a human still owes an action. */
  readonly pending?: string;
  /**
   * Why this deployment is history, in a sentence. Present means it is kept as the record of what
   * ran and is never resolved by chain id again.
   */
  readonly retired?: string;
  /**
   * The record this one replaces on its chain. The replaced record stays live and readable by
   * name, because its contracts still hold locks and disputes, but it no longer answers a lookup
   * by chain id.
   */
  readonly supersedes?: string;
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

  const contractsRecord = object(field(record, name, 'contracts'), name, 'contracts');
  const contracts: Record<string, Address> = {};
  for (const contract of BURSAR_CONTRACT_NAMES) {
    contracts[contract] = address(contractsRecord, name, contract);
  }

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

  const verified = object(field(record, name, 'verifiedOnChain'), name, 'verifiedOnChain');
  const verifiedOnChain: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(verified)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new DeploymentError(name, `verifiedOnChain.${key} is neither a string nor a number.`);
    }
    verifiedOnChain[key] = value;
  }

  const rwa = record['rwa'] === undefined ? undefined : parseRwa(record['rwa'], name);
  const privacy = record['privacy'] === undefined ? undefined : parsePrivacy(record['privacy'], name);

  const optionalString = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  };

  return Object.freeze({
    network: name,
    chainId,
    rpc: str(record, name, 'rpc'),
    explorer: str(record, name, 'explorer'),
    settlementAsset: address(record, name, 'settlementAsset'),
    settlementDecimals: MICRO_DECIMALS,
    deployer: address(record, name, 'deployer'),
    contracts: Object.freeze(contracts) as Readonly<Record<MandateContractName, Address>>,
    roles: Object.freeze({
      timelockSigners: Object.freeze(signers as Address[]),
      guardian: address(rolesRecord, name, 'guardian'),
      treasury: address(rolesRecord, name, 'treasury'),
      slashSink: address(rolesRecord, name, 'slashSink'),
    }),
    verifiedOnChain: Object.freeze(verifiedOnChain),
    ...(optionalString('pending') === undefined ? {} : { pending: optionalString('pending') }),
    ...(optionalString('retired') === undefined ? {} : { retired: optionalString('retired') }),
    ...(optionalString('supersedes') === undefined ? {} : { supersedes: optionalString('supersedes') }),
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
    maxRelayFeeBps: bps,
    aspPostman: address(r, label, 'aspPostman'),
    relayer: address(r, label, 'relayer'),
    fromBlock: block('fromBlock'),
  });
}

function parseRwa(json: unknown, name: string): RwaDeployment {
  const r = object(json, name, 'rwa');
  const label = `${name}.rwa`;
  const adaptersRecord = object(field(r, label, 'adapters'), label, 'adapters');
  const adapters: Record<string, Address> = {};
  for (const symbol of Object.keys(adaptersRecord)) adapters[symbol] = address(adaptersRecord, label, symbol);

  const assetsRecord = object(field(r, label, 'assets'), label, 'assets');
  const assets = Object.entries(assetsRecord).map(([symbol, value]) => {
    const a = object(value, label, symbol);
    const kind = a['kind'];
    if (kind !== 'stock' && kind !== 'treasury') throw new DeploymentError(label, `${symbol}.kind is ${String(kind)}.`);
    return Object.freeze({ symbol, address: address(a, label, 'address'), feed: address(a, label, 'feed'), kind });
  });

  return Object.freeze({
    AssetRegistry: address(r, label, 'AssetRegistry'),
    PriceGuard: address(r, label, 'PriceGuard'),
    StockSpendRouter: address(r, label, 'StockSpendRouter'),
    TreasuryPark: address(r, label, 'TreasuryPark'),
    adapters: Object.freeze(adapters),
    ...(r['MandateAccountFactoryV21'] === undefined
      ? {}
      : { MandateAccountFactoryV21: address(r, label, 'MandateAccountFactoryV21') }),
    assets: Object.freeze(assets),
  });
}

/**
 * Whether a record is history. A retired deployment keeps its addresses so the account of what ran
 * survives, and stops answering a lookup by chain id: the contracts are still on that chain and
 * would still take a call.
 */
export function isRetiredDeploymentRecord(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  return typeof (json as { retired?: unknown }).retired === 'string';
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
 * contract set it carries, not by the name of the file it arrived in.
 */
export function isMandateDeploymentRecord(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return false;
  const contracts = (json as { contracts?: unknown }).contracts;
  if (typeof contracts !== 'object' || contracts === null || Array.isArray(contracts)) return false;
  const named = contracts as Record<string, unknown>;
  return BURSAR_CONTRACT_NAMES.every((contract) => typeof named[contract] === 'string');
}

/**
 * The name of the record a live record replaces, if any.
 */
function supersededName(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const value = (json as { supersedes?: unknown }).supersedes;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The records this package may serve, in the order given.
 *
 * Emitting anything else is what turns a new file in contracts/deployments into an import-time
 * crash in every service, since the address book is parsed on load. Two live records answering to
 * one chain stop here as well, unless one names the other in `supersedes`: then the newer one
 * answers for the chain and the older one stays readable by name. Two records left unclaimed on
 * one chain means a lookup by chain id would depend on directory order, and that is not a lookup.
 * Retired records are exempt because nothing resolves them by chain.
 *
 * An empty result is allowed. The workspace has to build before anything is
 * deployed, and it has to build on a checkout whose only records are retired ones; a throw here
 * lands at import in every service and in the code generator whose whole job is to fix it.
 */
export function selectDeploymentRecords(
  files: readonly DeploymentRecordFile[],
): readonly DeploymentRecordFile[] {
  const selected = files.filter((file) => isMandateDeploymentRecord(file.json));
  const live = selected.filter((file) => !isRetiredDeploymentRecord(file.json));

  const heads = new Map<number, string>();
  for (const file of live) {
    const { chainId } = parseDeployment(file.json, file.name);
    const replaced = live.some(
      (other) =>
        supersededName(other.json) === file.name &&
        parseDeployment(other.json, other.name).chainId === chainId,
    );
    if (replaced) continue;
    const clash = heads.get(chainId);
    if (clash !== undefined) {
      throw new BursarError(
        'deployment_ambiguous',
        `${file.name} and ${clash} both claim chain ${chainId}. One of them has to go, or name the ` +
          'other in "supersedes": a service asks for a chain, not for a file.',
        { chainId, records: [clash, file.name] },
      );
    }
    heads.set(chainId, file.name);
  }

  return selected;
}
