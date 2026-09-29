/**
 * Scoped disclosure for one dispute and one resolver.
 *
 * The slice holds the job input, the delivered output and, for a committed mandate, the terms
 * fields with the payee's path in the counterparty tree: enough to rule on this lock and nothing
 * about any other job or any other counterparty. It is sealed to the resolver's ERC-6538 viewing
 * key and granted on chain through `DisclosureRegistry.grant` (or the escrow's `grantDisclosure`).
 * The resolver opens it and checks every part against what the chain already commits to.
 */

import { counterpartyTree, rootFromPath, termsCommitment } from '@bursar/circuits';
import { canonicalStringify, commitCanonical } from '@bursar/core';
import type { Address, Hex } from 'viem';

import { circuitTerms, type TermsDocument } from './committed.js';
import { openText, seal } from './seal.js';

export type DisclosureSlice = {
  readonly v: 1;
  readonly escrow: Address;
  readonly lockId: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly terms?: {
    readonly perCallCap: string;
    readonly periodCap: string;
    readonly periodLen: string;
    readonly totalCap: string;
    readonly classMask: string;
    readonly counterpartyRoot: string;
    readonly expiry: string;
    readonly salt: string;
    readonly payee: Address;
    readonly pathElements: readonly string[];
    readonly pathIndices: readonly number[];
  };
};

export async function disclosureSlice(args: {
  escrow: Address;
  lockId: bigint;
  input: unknown;
  output?: unknown;
  terms?: TermsDocument;
  payee?: Address;
  resolverViewingKey: Hex;
}): Promise<{ slice: DisclosureSlice; sliceCommit: Hex; ciphertext: Hex }> {
  let terms: DisclosureSlice['terms'];
  if (args.terms) {
    if (!args.payee) throw new Error('A terms slice needs the payee it is about.');
    const t = circuitTerms(args.terms);
    const path = counterpartyTree(args.terms.counterparties).proof(args.payee);
    if (!path) throw new Error('The payee is not in these terms.');
    terms = {
      perCallCap: t.perCallCap.toString(),
      periodCap: t.periodCap.toString(),
      periodLen: t.periodLen.toString(),
      totalCap: t.totalCap.toString(),
      classMask: t.classMask.toString(),
      counterpartyRoot: t.counterpartyRoot.toString(),
      expiry: t.expiry.toString(),
      salt: t.salt.toString(),
      payee: args.payee,
      pathElements: path.pathElements.map(String),
      pathIndices: path.pathIndices,
    };
  }
  const slice: DisclosureSlice = {
    v: 1,
    escrow: args.escrow,
    lockId: args.lockId.toString(),
    input: args.input,
    ...(args.output === undefined ? {} : { output: args.output }),
    ...(terms ? { terms } : {}),
  };
  const text = canonicalStringify(slice, 'slice');
  return { slice, sliceCommit: commitCanonical(slice), ciphertext: await seal(args.resolverViewingKey, text) };
}

export type OpenedDisclosure = {
  slice: DisclosureSlice;
  checks: {
    sliceCommit: boolean;
    input: boolean;
    output: boolean | null;
    terms: boolean | null;
    payee: boolean | null;
  };
};

/**
 * Opens a grant with the resolver's viewing key and checks it against the lock and, when a terms
 * slice is present, against the mandate's on-chain `termsCommitment`. A `false` anywhere means the
 * grantor disclosed something other than what the chain committed to.
 */
export async function openDisclosure(
  privateKey: Hex,
  ciphertext: Hex,
  expected: {
    sliceCommit: Hex;
    inputCommit: Hex;
    outputCommit?: Hex;
    termsCommitment?: bigint;
    payee?: Address;
  },
): Promise<OpenedDisclosure> {
  const slice = JSON.parse(await openText(privateKey, ciphertext)) as DisclosureSlice;
  const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();
  const zero = /^0x0*$/;

  let termsOk: boolean | null = null;
  let payeeOk: boolean | null = null;
  if (slice.terms && expected.termsCommitment !== undefined) {
    const t = slice.terms;
    termsOk = termsCommitment(t) === expected.termsCommitment;
    payeeOk =
      (!expected.payee || same(expected.payee, t.payee)) &&
      rootFromPath(t.payee, { pathElements: t.pathElements, pathIndices: t.pathIndices }) === BigInt(t.counterpartyRoot);
  }

  return {
    slice,
    checks: {
      sliceCommit: same(commitCanonical(slice), expected.sliceCommit),
      input: same(commitCanonical(slice.input), expected.inputCommit),
      output:
        slice.output === undefined || !expected.outputCommit || zero.test(expected.outputCommit)
          ? null
          : same(commitCanonical(slice.output), expected.outputCommit),
      terms: termsOk,
      payee: payeeOk,
    },
  };
}
