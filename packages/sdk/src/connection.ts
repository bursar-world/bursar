import { createPublicClient, createWalletClient, custom, isAddressEqual } from 'viem';
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import {
  BURSAR_CONTRACT_NAMES,
  DEPLOYMENTS,
  RHC_MAINNET,
  RHC_TESTNET,
  BursarError,
  RpcPool,
  RpcResponseError,
  createRhcClient,
  deployment,
  deploymentForChain,
  liveDeployments,
  parseDeployment,
  rhcChain,
  viemChain,
} from '@bursar/core';
import type {
  RhcChain,
  Deployment,
  DeploymentName,
  RpcPoolEvent,
  RpcProvider,
} from '@bursar/core';

import {
  InvalidArgumentError,
  NoSignerError,
  NotAnvilError,
  NotDeployedError,
  UnsupportedChainError,
} from './errors.js';
import { checkAddress } from './guards.js';

/** Every contract in a BURSAR deployment an agent-side caller has reason to touch. */
export type MandateAddresses = {
  readonly mandateAccountFactory: `0x${string}`;
  readonly escrow: `0x${string}`;
  readonly reputation: `0x${string}`;
  readonly agentRegistry: `0x${string}`;
  readonly oracleRegistry: `0x${string}`;
  readonly adminTimelock: `0x${string}`;
  readonly settlementAsset: `0x${string}`;
};

/** A deployment record as a deploy script writes it, before it is parsed. */
export type DeploymentRecordJson = { readonly [key: string]: unknown };

export type ConnectOptions = {
  /**
   * Which recorded deployment to use. Defaults to the one recorded for Robinhood Chain mainnet,
   * chain 4663, which is the only network BURSAR settles on: testnet 46630 has no USDG contract.
   */
  readonly network?: DeploymentName;
  /**
   * The chain to connect to, for a caller who thinks in chain ids. 4663 is the only one with a
   * deployment today; any other id throws UnsupportedChainError rather than falling back to it.
   */
  readonly chainId?: number;
  /**
   * A deployment record supplied by the caller, for a deployment this package has not recorded.
   * Takes precedence over `network`. Useful against a local fork of 4663, where the addresses are
   * whatever that fork was given.
   *
   * Either a parsed `Deployment` or the record as a deploy script writes it, such as the one the
   * contracts' local rehearsal leaves at `contracts/cache/bursar/local/local-4663.json`, read with
   * `JSON.parse`. It is checked and normalised here, and every lane client reads its addresses
   * from it. Before the first call goes out, the node is asked for code at every contract the
   * record names, and a record marked `local` has to find a node that calls itself anvil.
   */
  readonly deployment?: Deployment | DeploymentRecordJson;
  /**
   * One endpoint, or several. A second endpoint turns on the failover pool: each provider keeps
   * its own circuit breaker, and a call that fails on one moves down the list.
   */
  readonly rpc?: string | readonly string[];
  /** A private key or an account built elsewhere, such as a remote or hardware signer. */
  readonly account?: Account | Hex;
  /** A wallet client built elsewhere, for a browser extension or an injected provider. */
  readonly walletClient?: WalletClient<Transport, Chain, Account>;
  /** A public client built elsewhere. Supplying one bypasses the pool entirely. */
  readonly publicClient?: PublicClient<Transport, Chain>;
  /** Share breaker state with other clients in the same process. */
  readonly pool?: RpcPool;
  readonly onRpcEvent?: (event: RpcPoolEvent) => void;
  /** Override individual contract addresses, for a deployment this package has not recorded. */
  readonly addresses?: Partial<MandateAddresses>;
  /** How long a write waits for its receipt before reporting the transaction as unconfirmed. */
  readonly receiptTimeoutMs?: number;
};

export type Connection = {
  readonly chain: RhcChain;
  readonly deployment: Deployment;
  readonly addresses: MandateAddresses;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account> | undefined;
  readonly account: Account | undefined;
  readonly pool: RpcPool | undefined;
  readonly receiptTimeoutMs: number;
};

export const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Chain facts for a record, chosen by the chain the record names rather than by its label.
 *
 * A fork of 4663 is mainnet as far as every address in it is concerned, and it is the chain id in
 * the record that decides which USDG address and explorer apply. Every field can still be
 * overridden through RHC_MAINNET_*. There is no testnet equivalent, because 46630 has no
 * settlement asset to configure and `rhcChain('testnet')` refuses rather than returning one.
 */
function chainFor(record: Deployment): RhcChain {
  return record.chainId === RHC_TESTNET.chainId ? rhcChain('testnet') : rhcChain('mainnet');
}

/**
 * The record a caller who named none gets.
 *
 * Mainnet, because it is the only Robinhood Chain network with a USDG contract and therefore the
 * only one a payment can settle on. Before the deploy lands this throws and names the chain,
 * which is the truth: there is nothing to connect to yet.
 */
function recordFor(options: ConnectOptions): Deployment {
  const record =
    (options.deployment === undefined ? undefined : suppliedRecord(options.deployment)) ??
    (options.network !== undefined
      ? deployment(options.network)
      : options.chainId !== undefined
        ? recordForChain(options.chainId)
        : deploymentForChain(rhcChain('mainnet').chainId));

  if (options.chainId !== undefined && record.chainId !== options.chainId) {
    throw new InvalidArgumentError(
      'chainId',
      `connect() was asked for chain ${options.chainId} and given a deployment on chain ` +
        `${record.chainId}. Drop one of the two, or make them agree.`,
      { chainId: options.chainId, deploymentChainId: record.chainId },
    );
  }

  return record;
}

/**
 * A record the caller supplied, parsed the way the address book parses its own.
 *
 * A record on disk keys its RWA assets by symbol and leaves out fields a parsed one fills in, and
 * handing it on as it is surfaces as a failure much later, in whichever lane client reads the
 * field first. A record out of this package's own address book is already parsed and is kept as it
 * is, so it still reads as that record.
 */
function suppliedRecord(given: Deployment | DeploymentRecordJson): Deployment {
  if (isShipped(given)) return given as Deployment;

  try {
    return parseDeployment(given, typeof given.network === 'string' ? given.network : 'deployment');
  } catch (error) {
    if (!(error instanceof BursarError)) throw error;
    throw new InvalidArgumentError(
      'deployment',
      `connect() cannot use the deployment record it was given. ${error.message}`,
      { ...error.details },
    );
  }
}

/** A record out of this package's own address book, which the node is never asked about. */
function isShipped(given: Deployment | DeploymentRecordJson): boolean {
  return (Object.values(DEPLOYMENTS) as unknown[]).includes(given);
}

/**
 * A rehearsal record, as the contracts' local fixtures mark one. Its addresses exist only on the
 * anvil node it was written against, and that node answers as Robinhood Chain, 4663, so a record
 * on any other chain id came from an anvil node started without `--chain-id 4663`.
 */
function localRecord(options: ConnectOptions, record: Deployment): boolean {
  if ((options.deployment as { local?: unknown } | undefined)?.local !== true) return false;
  if (record.chainId === RHC_MAINNET.chainId) return true;

  throw new InvalidArgumentError(
    'deployment',
    `Deployment ${record.network} is a local rehearsal record for chain ${record.chainId}. A rehearsal ` +
      `answers as Robinhood Chain, ${RHC_MAINNET.chainId}: start anvil with --chain-id ` +
      `${RHC_MAINNET.chainId} and run the deploy scripts again for a record on that chain.`,
    { network: record.network, chainId: record.chainId, local: true },
  );
}

type NodeRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

/**
 * What a supplied record claims about its node, asked of that node before anything else is.
 *
 * A rehearsal record has to find anvil, because the chain id the pool checks cannot tell a
 * rehearsal from Robinhood Chain. Every supplied record has to find code at each contract it
 * names: a record from another chain, or from an anvil node that has restarted, names addresses
 * that hold nothing, and each client would report the empty answer as a failure of its own read.
 */
async function checkNode(record: Deployment, local: boolean, request: NodeRequest): Promise<void> {
  if (local) {
    const node = await clientVersion(request);
    if (!/anvil/iu.test(node)) throw new NotAnvilError(record.network, node);
  }

  const contracts = recordedContracts(record);
  const code = await Promise.all(contracts.map(([, address]) => request('eth_getCode', [address, 'latest'])));
  const missing = contracts.find((_, index) => {
    const found = code[index];
    return typeof found !== 'string' || found.length <= 2;
  });
  if (missing !== undefined) throw new NotDeployedError(record.network, missing[0], missing[1]);
}

/** What the node calls itself, or nothing when it answers the question with an error. */
async function clientVersion(request: NodeRequest): Promise<string> {
  try {
    const answer = await request('web3_clientVersion', []);
    return typeof answer === 'string' ? answer : '';
  } catch (error) {
    // An error answer is the node declining to say. A node that could not be reached said nothing,
    // and the failure is the caller's to see.
    if (error instanceof RpcResponseError || typeof (error as { code?: unknown } | null)?.code === 'number') return '';
    throw error;
  }
}

/** Every contract a record names, in the order a missing one is reported in. */
function recordedContracts(record: Deployment): (readonly [string, Address])[] {
  const lane = record.rwa;
  const privacy = record.privacy;
  const named: (readonly [string, Address | undefined])[] = [
    ...BURSAR_CONTRACT_NAMES.map((name) => [name, record.contracts[name]] as const),
    ['settlement asset', record.settlementAsset],
    ['AssetRegistry', lane?.AssetRegistry],
    ['PriceGuard', lane?.PriceGuard],
    ['StockSpendRouter', lane?.StockSpendRouter],
    ['TreasuryPark', lane?.TreasuryPark],
    ...Object.entries(lane?.adapters ?? {}).map(([asset, address]) => [`${asset} park adapter`, address] as const),
    ['MandateAccountFactoryV21', lane?.MandateAccountFactoryV21],
    ['CreditPool', lane?.collateral?.CreditPool],
    ['CollateralVault', lane?.collateral?.CollateralVault],
    ['Staking', lane?.collateral?.Staking],
    ['WithinMandateVerifier', privacy?.WithinMandateVerifier],
    ['CommittedMandateFactory', privacy?.CommittedMandateFactory],
    ['CommittedMandateFactoryV1Escrow', privacy?.CommittedMandateFactoryV1Escrow],
    ['DisclosureRegistry', privacy?.DisclosureRegistry],
    ['SolvencyLog', privacy?.SolvencyLog],
    ['WithdrawalVerifier', privacy?.shielded?.WithdrawalVerifier],
    ['CommitmentVerifier', privacy?.shielded?.CommitmentVerifier],
    ['Entrypoint', privacy?.shielded?.Entrypoint],
    ['ShieldedPool', privacy?.shielded?.ShieldedPool],
    ['ShieldedRelay', privacy?.shielded?.ShieldedRelay],
    ['AccessRegistry', privacy?.shielded?.AccessRegistry],
  ];

  return named.filter((entry): entry is readonly [string, Address] => entry[1] !== undefined);
}

/** Runs `check` once. A node that answered is not asked again; one that could not be reached is. */
function once(check: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;

  return () => {
    pending ??= check().catch((error: unknown) => {
      if (!(error instanceof NotAnvilError || error instanceof NotDeployedError)) pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** The chains connect() can open: a live record, and a settlement asset on that chain. */
function supportedChains(): number[] {
  const chains = liveDeployments()
    .map((record) => record.chainId)
    .filter((chainId) => chainId !== RHC_TESTNET.chainId);
  return [...new Set(chains)];
}

function recordForChain(chainId: number): Deployment {
  const supported = supportedChains();
  if (!supported.includes(chainId)) throw new UnsupportedChainError(chainId, supported);

  return deploymentForChain(chainId);
}

function providersFor(options: ConnectOptions, record: Deployment): readonly RpcProvider[] {
  const rpc = options.rpc;
  if (rpc === undefined) return [{ name: 'deployment', url: record.rpc }];
  if (typeof rpc === 'string') return [{ name: 'primary', url: rpc }];

  if (rpc.length === 0) {
    throw new InvalidArgumentError('rpc', 'connect() was given an empty list of RPC endpoints.');
  }

  return rpc.map((url, index) => ({ name: index === 0 ? 'primary' : `fallback-${index}`, url }));
}

function accountFor(options: ConnectOptions): Account | undefined {
  if (options.account !== undefined && options.walletClient !== undefined) {
    throw new InvalidArgumentError(
      'account',
      'connect() takes either an account or a walletClient, not both.',
    );
  }

  if (options.account === undefined) return options.walletClient?.account;

  if (typeof options.account !== 'string') return options.account;

  // A local nonce manager so two writes sent from one key in the same block get consecutive
  // nonces instead of both claiming the pending one.
  try {
    return privateKeyToAccount(options.account, { nonceManager });
  } catch {
    // The key itself is never quoted back, here or anywhere else.
    throw new InvalidArgumentError(
      'account',
      'connect() was given an account that is not a 32-byte 0x private key. Pass an Account built ' +
        'elsewhere to keep the key out of this process.',
    );
  }
}

/**
 * The address book, with any override checked where it was given.
 *
 * An override that is not an address would otherwise surface much later, as a failure from
 * whichever call happened to touch that contract first, naming the contract and not the option
 * that was wrong.
 */
function addressesFor(record: Deployment, overrides: Partial<MandateAddresses> = {}): MandateAddresses {
  const pick = (field: keyof MandateAddresses, fallback: `0x${string}`): `0x${string}` => {
    const override = overrides[field];

    return override === undefined ? fallback : checkAddress(`addresses.${field}`, override);
  };

  return {
    mandateAccountFactory: pick('mandateAccountFactory', record.contracts.MandateAccountFactory),
    escrow: pick('escrow', record.contracts.Escrow),
    reputation: pick('reputation', record.contracts.Reputation),
    agentRegistry: pick('agentRegistry', record.contracts.AgentRegistry),
    oracleRegistry: pick('oracleRegistry', record.contracts.OracleRegistry),
    adminTimelock: pick('adminTimelock', record.contracts.AdminTimelock),
    settlementAsset: pick('settlementAsset', record.settlementAsset),
  };
}

/**
 * A client built elsewhere has to be on the chain the deployment records.
 *
 * Every address in the record is a contract on that chain. A public client on another one reads
 * whatever lives at those addresses there, and a wallet client on another one signs for a chain
 * the escrow is not on. Neither fails where the mistake was made, so it is refused here. A wallet
 * client with no chain of its own, which an injected provider often is, passes: every write names
 * the deployment's chain and viem compares it with the wallet's before signing.
 */
function assertClientChain(
  field: 'walletClient' | 'publicClient',
  clientChain: Chain | undefined,
  chainId: number,
): void {
  if (clientChain === undefined && field === 'walletClient') return;
  if (clientChain?.id === chainId) return;

  throw new InvalidArgumentError(
    field,
    clientChain === undefined
      ? `connect() was given a ${field} with no chain. Build it with the chain for ${chainId}.`
      : `connect() was given a ${field} on chain ${clientChain.id}, and this deployment is on chain ` +
          `${chainId}. Build the client for ${chainId}.`,
    { chainId: clientChain?.id, expected: chainId },
  );
}

/**
 * Opens a connection to a BURSAR deployment.
 *
 * Read-only with no account: every write path throws with a message naming what it needed.
 * Nothing here holds a key on the caller's behalf: an account passed as a hex string is turned
 * into a viem account in this process and is never written anywhere.
 *
 * A record the caller supplies is checked against its node before the first call goes out on the
 * connection: `NotAnvilError` for a rehearsal record on a node that is not anvil, and
 * `NotDeployedError` for a record naming a contract the node holds no code for.
 */
export function connect(options: ConnectOptions = {}): Connection {
  const record = recordFor(options);
  const name = record.network;
  const local = localRecord(options, record);
  const chain = chainFor(record);

  // The deployment record and the chain config are maintained separately, and a settlement asset
  // that differs between them means one of the two is stale. Paying against the wrong token
  // address is not a failure that shows up until funds are gone.
  if (!isAddressEqual(record.settlementAsset, chain.usdg)) {
    throw new BursarError(
      'deployment_invalid',
      `Deployment ${name} settles in ${record.settlementAsset} but the chain config names ` +
        `${chain.usdg} as USDG. One of the two is stale; do not spend against either until it is resolved.`,
      { network: name, deploymentAsset: record.settlementAsset, chainAsset: chain.usdg },
    );
  }

  if (record.chainId !== chain.chainId) {
    throw new BursarError(
      'deployment_invalid',
      `Deployment ${name} records chain ${record.chainId} but the chain config is ${chain.chainId}.`,
      { network: name, deploymentChainId: record.chainId, chainId: chain.chainId },
    );
  }

  if (options.walletClient) assertClientChain('walletClient', options.walletClient.chain, chain.chainId);
  if (options.publicClient) assertClientChain('publicClient', options.publicClient.chain, chain.chainId);

  const account = accountFor(options);
  const viem = viemChain(chain);
  const supplied = options.deployment !== undefined && !isShipped(options.deployment);

  // A caller who brings a public client owns its transport, so writes go through the wallet
  // client they bring alongside it. Building one here would guess at an endpoint they already
  // configured.
  if (options.publicClient) {
    if (account && !options.walletClient) {
      throw new InvalidArgumentError(
        'walletClient',
        'connect() was given a publicClient and an account but no walletClient. A caller that ' +
          'brings its own transport has to bring the wallet client that signs on it.',
      );
    }

    const client = options.publicClient;
    const connection: Connection = {
      chain,
      deployment: record,
      addresses: addressesFor(record, options.addresses),
      publicClient: client,
      walletClient: options.walletClient,
      account: options.walletClient?.account ?? account,
      pool: options.pool,
      receiptTimeoutMs: options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
    };
    if (supplied) {
      checks.set(
        connection,
        once(() => checkNode(record, local, (method, params) => client.request({ method, params } as never))),
      );
    }

    return connection;
  }

  const rhc = createRhcClient({
    chain,
    providers: providersFor(options, record),
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    ...(options.onRpcEvent === undefined ? {} : { onEvent: options.onRpcEvent }),
    // An agent-side library has to run against whatever endpoint the developer has. Two
    // endpoints get failover and a breaker; one gets the single endpoint it asked for. The
    // two-provider rule binds the services this project operates, not this package.
    requireRedundancy: false,
  });

  const pool = rhc.pool;
  const check = supplied
    ? once(() => checkNode(record, local, (method, params) => pool.request(method, params)))
    : undefined;
  const transport: Transport = custom(
    {
      request: async ({ method, params }) => {
        // Nothing goes out on a supplied record until its node has answered for it.
        await check?.();
        return pool.request(method, (params ?? []) as readonly unknown[]);
      },
    },
    { retryCount: 0 },
  );

  const walletClient =
    options.walletClient ?? (account ? createWalletClient({ account, chain: viem, transport }) : undefined);

  const connection: Connection = {
    chain,
    deployment: record,
    addresses: addressesFor(record, options.addresses),
    publicClient: check === undefined ? rhc.client : createPublicClient({ chain: viem, transport }),
    walletClient,
    account,
    pool,
    receiptTimeoutMs: options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
  };
  if (check !== undefined) checks.set(connection, check);

  return connection;
}

/**
 * Which public call built each connection, for the error a read-only write raises. Kept beside the
 * connection rather than on it, so a Connection a caller assembles by hand needs no extra field.
 */
const openedBy = new WeakMap<Connection, string>();

/** The node check a connection's supplied record is waiting on, kept beside it as `openedBy` is. */
const checks = new WeakMap<Connection, () => Promise<void>>();

/**
 * The connection an entry point such as mandateAccount() runs on: the one it was given, or a new
 * one built from its options and remembered as opened by that entry point.
 */
export function connectFor(options: Connection | ConnectOptions, entry: string): Connection {
  if (isConnection(options)) return options;

  const connection = connect(options);
  openedBy.set(connection, entry);

  return connection;
}

/**
 * The same connection, once its node has answered for a supplied record.
 *
 * The transport connect() builds holds every call back until then, and a refusal reaches whoever
 * made the call wrapped in that call's own error. Awaited before an entry point's first read, it
 * reaches the caller as the error that names it. A client the caller brought is asked here too.
 */
export async function openConnection(options: Connection | ConnectOptions, entry: string): Promise<Connection> {
  const connection = connectFor(options, entry);
  await checks.get(connection)?.();

  return connection;
}

/**
 * Distinguishes an open connection from the options that would build one, so every entry point
 * can take either without the caller choosing a spelling.
 */
export function isConnection(value: Connection | ConnectOptions): value is Connection {
  return 'publicClient' in value && 'deployment' in value && 'addresses' in value;
}

export type Signer = {
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly account: Account;
};

/** The signer a write needs. Missing one throws an error naming the call, never a null dereference. */
export function requireSigner(connection: Connection, action: string): Signer {
  const walletClient = connection.walletClient;
  const account = connection.account ?? walletClient?.account;

  if (!walletClient || !account) throw new NoSignerError(action, openedBy.get(connection));

  return { walletClient, account };
}

/** Write options every helper shares, so the chain guard is declared in exactly one place. */
export function writeOptions(signer: Signer, chain: RhcChain): { account: Account; chain: Chain } {
  return { account: signer.account, chain: viemChain(chain) };
}

/**
 * A link to the transaction on the explorer this deployment records, for a person to open.
 *
 * Robinhood Chain's human explorer sits behind a browser challenge, so this is a link and never
 * something to fetch. Code that needs the index reads the keyed API instead.
 */
export function explorerTx(connection: Connection, hash: Hex): string {
  return `${connection.deployment.explorer.replace(/\/$/, '')}/tx/${hash}`;
}
