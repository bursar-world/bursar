import { commitCanonical, committedMandateAccountAbi, disclosureRegistryAbi, escrowAbi } from '@bursar/core';
import { SealOpenError, deriveViewingKey, openDisclosure, viewingKeyMessage } from '@bursar/sdk';
import { isAddressEqual } from 'viem';
import type { Address, Hex } from 'viem';

import type { LockState } from './chain.js';
import type { ResolverKey } from './keys.js';
import { describeError } from './log.js';

/**
 * Scoped disclosure grants, read for one disputed lock.
 *
 * A party grants a resolver a slice of the job sealed to that resolver's viewing key, through the
 * escrow's `DisclosureGranted` or the DisclosureRegistry. This opens the grants addressed to the
 * keys this service holds and checks every part against what the chain commits to. Only parts that
 * check out reach the policy: a disclosed input stands in for an input URI the resolver cannot read
 * (one sealed to the payee), and a disclosed output stands in for an output URI that is not public,
 * when it hashes to the commitment the payee signed.
 *
 * Slices stay in memory. Nothing here logs or publishes their contents.
 */

export type DisclosureGrant = {
  readonly source: 'escrow' | 'registry';
  readonly resolver: Address;
  readonly grantor: Address;
  readonly sliceCommit: Hex;
  readonly ciphertext: Hex;
};

export type DisclosureSource = {
  grants(escrow: Address, lockId: bigint, resolvers: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<readonly DisclosureGrant[]>;
  /** The payer's `termsCommitment` when it is a committed mandate, else null. */
  termsCommitment(payer: Address, blockNumber: bigint): Promise<bigint | null>;
};

export type ViewingKeyring = ReadonlyMap<Address, Hex>;

export type DisclosureReading = {
  /** The job input from a grant whose slice and input both check out. */
  readonly input: { readonly document: unknown } | null;
  /** Outputs from checked grants, keyed by their commitment in lower case. */
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly opened: number;
  /** One line per grant that did not open or did not check out. Safe to publish. */
  readonly notes: readonly string[];
};

export const NO_DISCLOSURES: DisclosureReading = { input: null, outputs: new Map(), opened: 0, notes: [] };

/**
 * One viewing key per resolver key, derived from the key's signature over the fixed viewing-key
 * message, so it matches the key the resolver publishes through ERC-6538. `override` replaces the
 * derivation for every key (RESOLVER_VIEWING_KEY), for an operator who holds the viewing key apart.
 */
export async function viewingKeyring(keys: readonly ResolverKey[], override?: Hex): Promise<ViewingKeyring> {
  const ring = new Map<Address, Hex>();
  for (const key of keys) {
    if (override !== undefined) {
      ring.set(key.address, override);
      continue;
    }
    const signature = await key.account.signMessage({ message: viewingKeyMessage(key.address) });
    ring.set(key.address, deriveViewingKey(signature).privateKey);
  }
  return ring;
}

export async function readDisclosures(args: {
  readonly source: DisclosureSource;
  readonly keyring: ViewingKeyring;
  readonly escrow: Address;
  readonly escrowId: bigint;
  readonly lock: LockState;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}): Promise<DisclosureReading> {
  const { source, keyring, lock } = args;
  const resolvers = [...keyring.keys()];
  if (resolvers.length === 0) return NO_DISCLOSURES;

  const grants = await source.grants(args.escrow, args.escrowId, resolvers, args.fromBlock, args.toBlock);
  if (grants.length === 0) return NO_DISCLOSURES;

  const termsCommitment = await source.termsCommitment(lock.payer, args.toBlock).catch(() => null);

  let input: DisclosureReading['input'] = null;
  const outputs = new Map<string, unknown>();
  const notes: string[] = [];
  let opened = 0;

  for (const grant of grants) {
    const key = resolvers.find((address) => isAddressEqual(address, grant.resolver));
    const privateKey = key === undefined ? undefined : keyring.get(key);
    if (privateKey === undefined) continue;
    const which = `Disclosure ${grant.sliceCommit.slice(0, 10)} from ${grant.grantor}`;

    let result: Awaited<ReturnType<typeof openDisclosure>>;
    try {
      result = await openDisclosure(privateKey, grant.ciphertext, {
        sliceCommit: grant.sliceCommit,
        inputCommit: lock.inputCommit,
        outputCommit: lock.outputCommit,
        ...(termsCommitment === null ? {} : { termsCommitment }),
        payee: lock.payee,
      });
    } catch (error) {
      notes.push(
        error instanceof SealOpenError
          ? `${which} does not open with this resolver's viewing key.`
          : `${which} is not a readable slice: ${describeError(error)}`,
      );
      continue;
    }
    opened += 1;

    const { slice, checks } = result;
    const lockMatches =
      isAddressEqual(slice.escrow, args.escrow) && slice.lockId === args.escrowId.toString();
    if (!checks.sliceCommit || !lockMatches) {
      notes.push(`${which} does not match its on-chain slice commitment or names another lock, so none of it was used.`);
      continue;
    }
    if (checks.terms === false) notes.push(`${which}: the disclosed terms do not match the mandate's terms commitment.`);
    if (checks.payee === false) notes.push(`${which}: the payee is not in the disclosed counterparty set.`);

    if (checks.input) input ??= { document: slice.input };
    else notes.push(`${which}: the disclosed input does not hash to the lock's input commitment.`);

    if (slice.output !== undefined) {
      if (checks.output === false) notes.push(`${which}: the disclosed output does not match the lock's output commitment.`);
      else outputs.set(commitCanonical(slice.output).toLowerCase(), slice.output);
    }
  }

  return { input, outputs, opened, notes };
}

export type LogReader = {
  getLogs(args: Record<string, unknown>): Promise<readonly { args: Record<string, unknown> }[]>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
};

/** Reads grants from the escrow and the registry in chunks the providers accept. */
export function createDisclosureSource(client: LogReader, registry: Address | undefined, chunk = 10_000n): DisclosureSource {
  const escrowEvent = escrowAbi.find((item) => item.type === 'event' && item.name === 'DisclosureGranted');
  const registryEvent = disclosureRegistryAbi.find((item) => item.type === 'event' && item.name === 'DisclosureGranted');

  return {
    grants: async (escrow, lockId, resolvers, fromBlock, toBlock) => {
      const found: DisclosureGrant[] = [];
      for (let start = fromBlock; start <= toBlock; start += chunk) {
        const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
        const fromEscrow = await client.getLogs({
          address: escrow,
          event: escrowEvent,
          args: { id: lockId, resolver: [...resolvers] },
          fromBlock: start,
          toBlock: end,
          strict: true,
        });
        for (const log of fromEscrow) {
          found.push({
            source: 'escrow',
            resolver: log.args['resolver'] as Address,
            grantor: log.args['grantor'] as Address,
            sliceCommit: log.args['sliceCommit'] as Hex,
            ciphertext: log.args['ciphertext'] as Hex,
          });
        }
        if (registry === undefined) continue;
        const fromRegistry = await client.getLogs({
          address: registry,
          event: registryEvent,
          args: { escrow, lockId, resolver: [...resolvers] },
          fromBlock: start,
          toBlock: end,
          strict: true,
        });
        for (const log of fromRegistry) {
          found.push({
            source: 'registry',
            resolver: log.args['resolver'] as Address,
            grantor: log.args['grantor'] as Address,
            sliceCommit: log.args['sliceCommit'] as Hex,
            ciphertext: log.args['ciphertext'] as Hex,
          });
        }
      }
      return found;
    },

    termsCommitment: async (payer, blockNumber) => {
      try {
        const value = await client.readContract({
          address: payer,
          abi: committedMandateAccountAbi,
          functionName: 'termsCommitment',
          blockNumber,
        });
        // A v2 MandateAccount answers the same selector with zero: it is not a committed mandate.
        return typeof value === 'bigint' && value !== 0n ? value : null;
      } catch {
        return null;
      }
    },
  };
}
