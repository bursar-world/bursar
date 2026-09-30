/**
 * Stealth principals and agents: ERC-5564 scheme 1 (secp256k1 with view tags).
 *
 * A private mandate is controlled by an address nobody can tie to the owner's wallet. The owner's
 * meta-address is a spending key, from the funds-key signature, and a viewing key, from the
 * viewing-key signature (see `viewing-key.ts`). For each mandate the console draws two fresh
 * stealth addresses from it, one for the owner side and one for the agent, and announces both
 * through the ERC-5564 Announcer. The announcement carries an ephemeral public key and a one-byte
 * view tag; only the holder of the viewing key can tell which announcements are its own, and only
 * the holder of the spending key can compute the private key of the address.
 *
 * The derivation follows the scheme-1 reference implementation (ScopeLift stealth-address-sdk):
 * the shared secret is the compressed ECDH point, hashed with keccak256; the view tag is its first
 * byte; the stealth public key is `P_spend + h·G` and the stealth private key `p_spend + h mod n`.
 *
 * What this does not hide: money that reaches a stealth address from a public wallet links the two
 * at that transfer. Shielded funding (F17) removes that link.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { committedMandateAccountAbi, committedMandateFactoryAbi } from '@bursar/core';
import {
  bytesToHex,
  getAddress,
  hexToBytes,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import { InvalidArgumentError } from './errors.js';
import { ERC5564_SCHEME_SECP256K1, ERC6538_REGISTRY, encodeMetaAddress, erc6538Abi } from './seal.js';
import { deriveSpendingKey, deriveViewingKey, type FundsKeyContext } from './viewing-key.js';

/** The singleton ERC-5564 Announcer, at the same address on every chain that has it (4663 does). */
export const ERC5564_ANNOUNCER: Address = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';

export const erc5564AnnouncerAbi = [
  {
    type: 'function',
    name: 'announce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schemeId', type: 'uint256' },
      { name: 'stealthAddress', type: 'address' },
      { name: 'ephemeralPubKey', type: 'bytes' },
      { name: 'metadata', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Announcement',
    anonymous: false,
    inputs: [
      { name: 'schemeId', type: 'uint256', indexed: true },
      { name: 'stealthAddress', type: 'address', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'ephemeralPubKey', type: 'bytes', indexed: false },
      { name: 'metadata', type: 'bytes', indexed: false },
    ],
  },
] as const;

const N = secp256k1.CURVE.n;
const KEY_BYTES = 33;

const bytes = (value: Hex | Uint8Array): Uint8Array => (typeof value === 'string' ? hexToBytes(value) : value);
const scalarHex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;

function point(value: Hex | Uint8Array, field: string) {
  try {
    return secp256k1.ProjectivePoint.fromHex(bytes(value));
  } catch {
    throw new InvalidArgumentError(field, 'That is not a secp256k1 public key.', {});
  }
}

export type MetaAddressKeys = { readonly spendingPublicKey: Hex; readonly viewingPublicKey: Hex };

/**
 * Reads a scheme-1 stealth meta-address: `st:<chain>:0x…` or the bare hex. 66 bytes are the
 * spending key then the viewing key; 33 bytes are one key used as both, as the standard allows.
 */
export function parseMetaAddress(meta: string): MetaAddressKeys {
  const parts = meta.split(':');
  const hex = parts.length === 3 && parts[0] === 'st' ? parts[2] : parts.length === 1 ? meta : undefined;
  if (hex === undefined || !/^0x([0-9a-fA-F]{66}|[0-9a-fA-F]{132})$/.test(hex)) {
    throw new InvalidArgumentError('meta', 'A scheme-1 meta-address is st:<chain>:0x followed by 33 or 66 bytes.', { meta });
  }
  const raw = hexToBytes(hex as Hex);
  const spend = raw.slice(0, KEY_BYTES);
  const view = raw.length === 2 * KEY_BYTES ? raw.slice(KEY_BYTES) : spend;
  return {
    spendingPublicKey: bytesToHex(point(spend, 'meta').toRawBytes(true)),
    viewingPublicKey: bytesToHex(point(view, 'meta').toRawBytes(true)),
  };
}

export function metaAddressURI(meta: Hex, chain = 'eth'): string {
  return `st:${chain}:${meta}`;
}

/** keccak256 of the compressed ECDH point, as a scalar in [1, n). */
function hashedSecret(privateKey: Hex | Uint8Array, publicKey: Hex | Uint8Array): { hash: Uint8Array; scalar: bigint } {
  const shared = secp256k1.getSharedSecret(bytes(privateKey), bytes(publicKey), true);
  const hash = hexToBytes(keccak256(shared));
  const scalar = BigInt(bytesToHex(hash)) % N;
  // A keccak output of exactly 0 mod n would put the stealth key on the spending key. It is
  // 2^-256 unlikely, and refusing it costs nothing.
  if (scalar === 0n) throw new Error('Degenerate shared secret; draw a new ephemeral key.');
  return { hash, scalar };
}

function stealthPoint(spendingPublicKey: Hex | Uint8Array, scalar: bigint) {
  return point(spendingPublicKey, 'spendingPublicKey').add(secp256k1.ProjectivePoint.BASE.multiply(scalar));
}

function addressOfPoint(p: ReturnType<typeof stealthPoint>): Address {
  return publicKeyToAddress(bytesToHex(p.toRawBytes(false)));
}

export type GeneratedStealthAddress = {
  readonly stealthAddress: Address;
  /** Compressed, 33 bytes. Goes in the announcement. */
  readonly ephemeralPublicKey: Hex;
  /** First byte of the hashed shared secret, 0 to 255. */
  readonly viewTag: number;
};

/** A fresh stealth address for the owner of `meta`. Anyone holding the meta-address can do this. */
export function generateStealthAddress(meta: string, options: { ephemeralPrivateKey?: Hex } = {}): GeneratedStealthAddress {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(meta);
  const ephemeral = options.ephemeralPrivateKey ? hexToBytes(options.ephemeralPrivateKey) : secp256k1.utils.randomPrivateKey();
  if (!secp256k1.utils.isValidPrivateKey(ephemeral)) {
    throw new InvalidArgumentError('ephemeralPrivateKey', 'That is not a secp256k1 private key.', {});
  }
  const { hash, scalar } = hashedSecret(ephemeral, viewingPublicKey);
  return {
    stealthAddress: addressOfPoint(stealthPoint(spendingPublicKey, scalar)),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(ephemeral, true)),
    viewTag: hash[0] as number,
  };
}

/**
 * Whether an announcement is addressed to the holder of this viewing key. The view tag rejects
 * 255 in 256 foreign announcements after one multiplication and one hash.
 */
export function checkStealthAddress(args: {
  readonly ephemeralPublicKey: Hex;
  readonly viewTag: number;
  readonly stealthAddress: Address;
  readonly viewingPrivateKey: Hex;
  readonly spendingPublicKey: Hex;
}): boolean {
  let secret: { hash: Uint8Array; scalar: bigint };
  try {
    secret = hashedSecret(args.viewingPrivateKey, args.ephemeralPublicKey);
  } catch {
    return false;
  }
  if (secret.hash[0] !== args.viewTag) return false;
  return addressOfPoint(stealthPoint(args.spendingPublicKey, secret.scalar)).toLowerCase() === args.stealthAddress.toLowerCase();
}

/** The private key of a stealth address. Needs both the viewing and the spending private key. */
export function computeStealthKey(args: {
  readonly ephemeralPublicKey: Hex;
  readonly viewingPrivateKey: Hex;
  readonly spendingPrivateKey: Hex;
}): Hex {
  const { scalar } = hashedSecret(args.viewingPrivateKey, args.ephemeralPublicKey);
  const key = (BigInt(args.spendingPrivateKey) + scalar) % N;
  if (key === 0n) throw new Error('Degenerate stealth key.');
  return scalarHex(key);
}

/** The owner's ERC-5564 keys: the viewing half from the viewing-key signature, the spending half from the funds key. */
export type StealthKeys = {
  readonly spendingPrivateKey: Hex;
  readonly spendingPublicKey: Hex;
  readonly viewingPrivateKey: Hex;
  readonly viewingPublicKey: Hex;
  /** 66 bytes: spending key then viewing key, compressed. What ERC-6538 stores. */
  readonly metaAddress: Hex;
};

export function deriveStealthKeys(viewingSignature: Hex, fundsSignature: Hex, context: FundsKeyContext): StealthKeys {
  const viewing = deriveViewingKey(viewingSignature);
  const spending = deriveSpendingKey(fundsSignature, context);
  return {
    spendingPrivateKey: spending.privateKey,
    spendingPublicKey: spending.publicKey,
    viewingPrivateKey: viewing.privateKey,
    viewingPublicKey: viewing.publicKey,
    metaAddress: encodeMetaAddress(spending.publicKey, viewing.publicKey),
  };
}

/** `registerKeys` arguments that publish a meta-address in the ERC-6538 registry. */
export function registerKeysArgs(metaAddress: Hex): readonly [bigint, Hex] {
  parseMetaAddress(metaAddress);
  return [ERC5564_SCHEME_SECP256K1, metaAddress];
}

export { ERC6538_REGISTRY, erc6538Abi };

/**
 * Which side of a mandate an address holds. It rides in the announcement metadata after the view
 * tag, so the owner's scanner can sort what it finds; the chain already shows both roles on the
 * account itself, so the byte adds nothing an observer could not read there.
 */
export const STEALTH_ROLES = { principal: 1, agent: 2 } as const;
export type StealthRole = keyof typeof STEALTH_ROLES;

export function announcementMetadata(viewTag: number, role: StealthRole): Hex {
  return bytesToHex(Uint8Array.of(viewTag & 0xff, STEALTH_ROLES[role]));
}

/** `announce` arguments for one generated address. */
export function announceArgs(generated: GeneratedStealthAddress, role: StealthRole): readonly [bigint, Address, Hex, Hex] {
  return [ERC5564_SCHEME_SECP256K1, generated.stealthAddress, generated.ephemeralPublicKey, announcementMetadata(generated.viewTag, role)];
}

export type StealthIdentity = {
  readonly address: Address;
  readonly privateKey: Hex;
  readonly announcement: GeneratedStealthAddress;
  readonly role: StealthRole;
};

export type StealthMandatePlan = { readonly principal: StealthIdentity; readonly agent: StealthIdentity };

/**
 * Two fresh stealth addresses for one private mandate, with their private keys. The principal
 * address creates the mandate and announces both; the agent key is handed to the agent runtime.
 */
export function planStealthMandate(keys: StealthKeys): StealthMandatePlan {
  const identity = (role: StealthRole): StealthIdentity => {
    const announcement = generateStealthAddress(keys.metaAddress);
    const privateKey = computeStealthKey({
      ephemeralPublicKey: announcement.ephemeralPublicKey,
      viewingPrivateKey: keys.viewingPrivateKey,
      spendingPrivateKey: keys.spendingPrivateKey,
    });
    return { address: announcement.stealthAddress, privateKey, announcement, role };
  };
  return { principal: identity('principal'), agent: identity('agent') };
}

export type Announcement = {
  readonly schemeId: bigint;
  readonly stealthAddress: Address;
  readonly caller: Address;
  readonly ephemeralPublicKey: Hex;
  readonly metadata: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
};

const ANNOUNCEMENT_EVENT = erc5564AnnouncerAbi[1];

/**
 * Every scheme-1 announcement between two blocks. Public endpoints cap the range of one log
 * query, so this walks the range in chunks and halves a chunk the endpoint refuses.
 */
export async function fetchAnnouncements(
  client: Pick<PublicClient, 'getLogs' | 'getBlockNumber'>,
  options: { fromBlock: bigint; toBlock?: bigint; announcer?: Address; chunk?: bigint },
): Promise<readonly Announcement[]> {
  const announcer = options.announcer ?? ERC5564_ANNOUNCER;
  const last = options.toBlock ?? (await client.getBlockNumber());
  let chunk = options.chunk ?? 5_000_000n;
  const found: Announcement[] = [];
  let from = options.fromBlock;
  while (from <= last) {
    const to = from + chunk - 1n < last ? from + chunk - 1n : last;
    let logs;
    try {
      logs = await client.getLogs({
        address: announcer,
        event: ANNOUNCEMENT_EVENT,
        args: { schemeId: ERC5564_SCHEME_SECP256K1 },
        fromBlock: from,
        toBlock: to,
      });
    } catch (error) {
      if (chunk <= 1_000n) throw error;
      chunk /= 2n;
      continue;
    }
    for (const log of parseEventLogs({ abi: erc5564AnnouncerAbi, logs, eventName: 'Announcement' })) {
      found.push({
        schemeId: log.args.schemeId,
        stealthAddress: getAddress(log.args.stealthAddress),
        caller: getAddress(log.args.caller),
        ephemeralPublicKey: log.args.ephemeralPubKey,
        metadata: log.args.metadata,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    }
    from = to + 1n;
  }
  return found;
}

export type StealthMatch = Announcement & {
  readonly role: StealthRole | null;
  /** Present when the scan was given the spending key. */
  readonly privateKey?: Hex;
};

function roleOf(metadata: Hex): StealthRole | null {
  const raw = hexToBytes(metadata);
  if (raw[1] === STEALTH_ROLES.principal) return 'principal';
  if (raw[1] === STEALTH_ROLES.agent) return 'agent';
  return null;
}

/**
 * The announcements addressed to these keys. With only the viewing key and the spending public
 * key it finds them; with the spending private key it also returns each address's private key.
 */
export function scanAnnouncements(
  announcements: readonly Announcement[],
  keys: Pick<StealthKeys, 'viewingPrivateKey' | 'spendingPublicKey'> & { readonly spendingPrivateKey?: Hex },
): readonly StealthMatch[] {
  const matches: StealthMatch[] = [];
  for (const a of announcements) {
    const raw = hexToBytes(a.metadata);
    if (raw.length === 0 || hexToBytes(a.ephemeralPublicKey).length !== KEY_BYTES) continue;
    const mine = checkStealthAddress({
      ephemeralPublicKey: a.ephemeralPublicKey,
      viewTag: raw[0] as number,
      stealthAddress: a.stealthAddress,
      viewingPrivateKey: keys.viewingPrivateKey,
      spendingPublicKey: keys.spendingPublicKey,
    });
    if (!mine) continue;
    const privateKey = keys.spendingPrivateKey
      ? computeStealthKey({
          ephemeralPublicKey: a.ephemeralPublicKey,
          viewingPrivateKey: keys.viewingPrivateKey,
          spendingPrivateKey: keys.spendingPrivateKey,
        })
      : undefined;
    matches.push({ ...a, role: roleOf(a.metadata), ...(privateKey ? { privateKey } : {}) });
  }
  return matches;
}

export type RecoveredMandate = {
  readonly mandate: Address;
  readonly factory: Address;
  readonly principal: StealthMatch;
  /** The account's current agent, and its key when that agent is one of the owner's stealth addresses. */
  readonly agent: Address;
  readonly agentMatch: StealthMatch | null;
};

/**
 * Every mandate controlled by one of the owner's stealth addresses, found from announcements and
 * the factories' own lists. Needs nothing but public chain data and the owner's keys.
 */
export async function recoverStealthMandates(
  client: Pick<PublicClient, 'readContract'>,
  matches: readonly StealthMatch[],
  factories: readonly Address[],
): Promise<readonly RecoveredMandate[]> {
  const agents = new Map(matches.filter((m) => m.role !== 'principal').map((m) => [m.stealthAddress.toLowerCase(), m]));
  const principals = matches.filter((m) => m.role !== 'agent');
  const found: RecoveredMandate[] = [];
  for (const principal of principals) {
    for (const factory of factories) {
      const accounts = await client.readContract({
        address: factory,
        abi: committedMandateFactoryAbi,
        functionName: 'accountsOf',
        args: [principal.stealthAddress],
      });
      for (const mandate of accounts) {
        const agent = await client.readContract({ address: mandate, abi: committedMandateAccountAbi, functionName: 'agent' });
        found.push({
          mandate: getAddress(mandate),
          factory: getAddress(factory),
          principal,
          agent: getAddress(agent),
          agentMatch: agents.get(agent.toLowerCase()) ?? null,
        });
      }
    }
  }
  return found;
}

