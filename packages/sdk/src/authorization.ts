import { domainSeparator } from 'viem';
import type { Address, Hex, TypedDataDomain } from 'viem';
import { BursarError, mandateAccountAbi } from '@bursar/core';
import type { ContractSet } from '@bursar/core';

import { requireSigner, type Connection } from './connection.js';
import type { MandateLimits, SpendApproval } from './types.js';

/** Fixed by `MandateAccount`'s EIP712 constructor. Changing either breaks every signature. */
export const MANDATE_ACCOUNT_DOMAIN_NAME = 'MandateAccount';
export const MANDATE_ACCOUNT_DOMAIN_VERSION = '1';

export const SPEND_APPROVAL_TYPES = {
  SpendApproval: [
    { name: 'approvalId', type: 'bytes32' },
    { name: 'merchant', type: 'address' },
    { name: 'capabilityId', type: 'bytes32' },
    { name: 'amount', type: 'uint128' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export const SET_LIMITS_TYPES = {
  SetLimits: [
    { name: 'limits', type: 'Limits' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Limits: [
    { name: 'perCallCap', type: 'uint128' },
    { name: 'dailyCap', type: 'uint128' },
    { name: 'monthlyCap', type: 'uint128' },
    { name: 'dailyWindow', type: 'uint64' },
    { name: 'monthlyWindow', type: 'uint64' },
    { name: 'approvalThreshold', type: 'uint128' },
    { name: 'validFrom', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'classMask', type: 'uint32' },
    { name: 'totalCap', type: 'uint128' },
    { name: 'lane', type: 'uint8' },
  ],
} as const;

/** The eight-field Limits a v1 account signs over. */
export const SET_LIMITS_TYPES_V1 = {
  SetLimits: SET_LIMITS_TYPES.SetLimits,
  Limits: SET_LIMITS_TYPES.Limits.slice(0, 8) as unknown as readonly [
    (typeof SET_LIMITS_TYPES.Limits)[0],
    (typeof SET_LIMITS_TYPES.Limits)[1],
    (typeof SET_LIMITS_TYPES.Limits)[2],
    (typeof SET_LIMITS_TYPES.Limits)[3],
    (typeof SET_LIMITS_TYPES.Limits)[4],
    (typeof SET_LIMITS_TYPES.Limits)[5],
    (typeof SET_LIMITS_TYPES.Limits)[6],
    (typeof SET_LIMITS_TYPES.Limits)[7],
  ],
} as const;

/** The eight fields a v1 account holds. The v2 fields are dropped, never sent. */
export function limitsV1(limits: MandateLimits) {
  const { classMask: _mask, totalCap: _total, lane: _lane, ...v1 } = limits;
  return v1;
}

/** The domain a mandate account signs under: the chain and the account, and nothing reusable. */
export function mandateDomain(mandate: Address, chainId: number): TypedDataDomain {
  return {
    name: MANDATE_ACCOUNT_DOMAIN_NAME,
    version: MANDATE_ACCOUNT_DOMAIN_VERSION,
    chainId,
    verifyingContract: mandate,
  };
}

/**
 * Checks the domain this package builds against the one the account computes for itself.
 *
 * A guessed EIP-712 domain does not fail loudly. It produces a well-formed signature that
 * recovers to the wrong address, and the only symptom is a refusal that names the signature,
 * never the domain. Reading `DOMAIN_SEPARATOR()` and comparing costs one call and moves the
 * error to the moment of signing.
 */
export async function assertMandateDomain(
  connection: Connection,
  mandate: Address,
): Promise<TypedDataDomain> {
  const domain = mandateDomain(mandate, connection.chain.chainId);

  const onChain = await connection.publicClient.readContract({
    address: mandate,
    abi: mandateAccountAbi,
    functionName: 'DOMAIN_SEPARATOR',
  });

  const local = domainSeparator({ domain });
  if (onChain.toLowerCase() !== local.toLowerCase()) {
    throw new BursarError(
      'domain_mismatch',
      `Mandate ${mandate} reports an EIP-712 domain separator this package did not expect. ` +
        'A signature made against the wrong domain is accepted by nobody and reports as a bad ' +
        'signature, so nothing is signed here. Check that the account is a MandateAccount on ' +
        `chain ${connection.chain.chainId}.`,
      { mandate, chainId: connection.chain.chainId, onChain, expected: local },
    );
  }

  return domain;
}

/**
 * Signs a principal's consent to one spend at or above the approval threshold.
 *
 * The signature is the whole artefact: it can be handed to the agent out of band, and the agent
 * carries it into `spendApproved`. The principal never sends a transaction, which is what lets a
 * cold wallet or a Safe hold the authority without being online for every payment.
 */
export async function signSpendApproval(
  connection: Connection,
  mandate: Address,
  approval: SpendApproval,
): Promise<Hex> {
  const { walletClient, account } = requireSigner(connection, 'signApproval');
  const domain = await assertMandateDomain(connection, mandate);

  return walletClient.signTypedData({
    account,
    domain,
    types: SPEND_APPROVAL_TYPES,
    primaryType: 'SpendApproval',
    message: {
      approvalId: approval.approvalId,
      merchant: approval.merchant,
      capabilityId: approval.capabilityId,
      amount: approval.amount,
      expiry: approval.expiry,
    },
  });
}

export type LimitsAuthorization = {
  readonly limits: MandateLimits;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly signature: Hex;
};

/**
 * Signs a limit change for someone else to relay. The nonce is strictly sequential, so an
 * authorization signed earlier and held back cannot overtake a later one.
 */
export async function signLimitsAuthorization(
  connection: Connection,
  mandate: Address,
  limits: MandateLimits,
  nonce: bigint,
  deadline: bigint,
  contractSet: ContractSet = 'v2',
): Promise<LimitsAuthorization> {
  const { walletClient, account } = requireSigner(connection, 'signLimits');
  const domain = await assertMandateDomain(connection, mandate);

  const signature =
    contractSet === 'v1'
      ? await walletClient.signTypedData({
          account,
          domain,
          types: SET_LIMITS_TYPES_V1,
          primaryType: 'SetLimits',
          message: { limits: limitsV1(limits), nonce, deadline },
        })
      : await walletClient.signTypedData({
          account,
          domain,
          types: SET_LIMITS_TYPES,
          primaryType: 'SetLimits',
          message: { limits, nonce, deadline },
        });

  return { limits, nonce, deadline, signature };
}
