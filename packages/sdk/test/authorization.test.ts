import { describe, expect, it } from 'vitest';
import {
  concat,
  domainSeparator,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toBytes,
  verifyTypedData,
} from 'viem';
import type { Address, Hex } from 'viem';
import { RHC_MAINNET } from '@bursar/core';

import {
  SET_LIMITS_TYPES,
  SET_LIMITS_TYPES_V1,
  limitsV1,
  SPEND_APPROVAL_TYPES,
  assertMandateDomain,
  mandateDomain,
  signLimitsAuthorization,
  signSpendApproval,
} from '../src/authorization.js';
import { usdg } from '../src/money.js';
import type { MandateLimits, SpendApproval } from '../src/types.js';
import { fakeConnection, type ReadCall } from './helpers/fake-connection.js';

const MANDATE: Address = '0x1234567890123456789012345678901234567890';
const MERCHANT: Address = '0x2222222222222222222222222222222222222222';

/** The type strings `MandateAccount` hashes into its own typehashes, transcribed from the source. */
const LIMITS_TYPE_V1 =
  'Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,' +
  'uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil)';
const LIMITS_TYPE =
  'Limits(uint128 perCallCap,uint128 dailyCap,uint128 monthlyCap,uint64 dailyWindow,' +
  'uint64 monthlyWindow,uint128 approvalThreshold,uint64 validFrom,uint64 validUntil,' +
  'uint32 classMask,uint128 totalCap,uint8 lane)';
const SET_LIMITS_TYPE = `SetLimits(Limits limits,uint256 nonce,uint64 deadline)${LIMITS_TYPE}`;
const SET_LIMITS_TYPE_V1 = `SetLimits(Limits limits,uint256 nonce,uint64 deadline)${LIMITS_TYPE_V1}`;
const SPEND_APPROVAL_TYPE =
  'SpendApproval(bytes32 approvalId,address merchant,bytes32 capabilityId,uint128 amount,uint64 expiry)';

const DOMAIN = mandateDomain(MANDATE, RHC_MAINNET.chainId);
const SEPARATOR = domainSeparator({ domain: DOMAIN });

const LIMITS: MandateLimits = {
  perCallCap: usdg('5'),
  dailyCap: usdg('50'),
  monthlyCap: usdg('500'),
  dailyWindow: 86_400n,
  monthlyWindow: 2_592_000n,
  approvalThreshold: usdg('25'),
  validFrom: 0n,
  validUntil: 0n,
  classMask: 0b011,
  totalCap: usdg('1000'),
  lane: 0,
};

const APPROVAL: SpendApproval = {
  approvalId: `0x${'aa'.repeat(32)}`,
  merchant: MERCHANT,
  capabilityId: `0x${'11'.repeat(32)}`,
  amount: usdg('30'),
  expiry: 1_800_003_600n,
};

const reads =
  (separator: Hex) =>
  (call: ReadCall): unknown =>
    call.functionName === 'DOMAIN_SEPARATOR' ? separator : undefined;

/** The digest the account computes, built the way the Solidity builds it. */
function accountDigest(structHash: Hex): Hex {
  return keccak256(concat(['0x1901', SEPARATOR, structHash]));
}

const V1_FIELDS = [
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'uint64' },
  { type: 'uint64' },
  { type: 'uint128' },
  { type: 'uint64' },
  { type: 'uint64' },
] as const;

function v1Values() {
  return [
    LIMITS.perCallCap,
    LIMITS.dailyCap,
    LIMITS.monthlyCap,
    LIMITS.dailyWindow,
    LIMITS.monthlyWindow,
    LIMITS.approvalThreshold,
    LIMITS.validFrom,
    LIMITS.validUntil,
  ] as const;
}

function limitsStructHash(): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, ...V1_FIELDS, { type: 'uint32' }, { type: 'uint128' }, { type: 'uint8' }],
      [keccak256(toBytes(LIMITS_TYPE)), ...v1Values(), LIMITS.classMask, LIMITS.totalCap, LIMITS.lane],
    ),
  );
}

function limitsStructHashV1(): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, ...V1_FIELDS], [keccak256(toBytes(LIMITS_TYPE_V1)), ...v1Values()]),
  );
}

describe('the typed data this package signs', () => {
  it('produces the SetLimits digest the account verifies', () => {
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
        [keccak256(toBytes(SET_LIMITS_TYPE)), limitsStructHash(), 7n, 1_800_003_600n],
      ),
    );

    expect(
      hashTypedData({
        domain: DOMAIN,
        types: SET_LIMITS_TYPES,
        primaryType: 'SetLimits',
        message: { limits: LIMITS, nonce: 7n, deadline: 1_800_003_600n },
      }),
    ).toBe(accountDigest(structHash));
  });

  it('produces the eight-field SetLimits digest a v1 account verifies', () => {
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
        [keccak256(toBytes(SET_LIMITS_TYPE_V1)), limitsStructHashV1(), 7n, 1_800_003_600n],
      ),
    );

    expect(
      hashTypedData({
        domain: DOMAIN,
        types: SET_LIMITS_TYPES_V1,
        primaryType: 'SetLimits',
        message: { limits: limitsV1(LIMITS), nonce: 7n, deadline: 1_800_003_600n },
      }),
    ).toBe(accountDigest(structHash));
  });

  it('produces the SpendApproval digest the account verifies', () => {
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'bytes32' },
          { type: 'uint128' },
          { type: 'uint64' },
        ],
        [
          keccak256(toBytes(SPEND_APPROVAL_TYPE)),
          APPROVAL.approvalId,
          APPROVAL.merchant,
          APPROVAL.capabilityId,
          APPROVAL.amount,
          APPROVAL.expiry,
        ],
      ),
    );

    expect(
      hashTypedData({
        domain: DOMAIN,
        types: SPEND_APPROVAL_TYPES,
        primaryType: 'SpendApproval',
        message: APPROVAL,
      }),
    ).toBe(accountDigest(structHash));
  });
});

describe('assertMandateDomain', () => {
  it('accepts the domain the account computes for itself', async () => {
    const { connection } = fakeConnection({ read: reads(SEPARATOR) });

    expect(await assertMandateDomain(connection, MANDATE)).toEqual(DOMAIN);
  });

  it('refuses to sign against a domain the account does not agree with', async () => {
    const { connection } = fakeConnection({ read: reads(`0x${'99'.repeat(32)}`) });

    await expect(assertMandateDomain(connection, MANDATE)).rejects.toThrow(
      /reports an EIP-712 domain separator this package did not expect/,
    );
  });
});

describe('signSpendApproval', () => {
  it('signs consent that recovers to the principal', async () => {
    const { connection, account } = fakeConnection({ read: reads(SEPARATOR) });

    const signature = await signSpendApproval(connection, MANDATE, APPROVAL);

    expect(
      await verifyTypedData({
        address: account.address,
        domain: DOMAIN,
        types: SPEND_APPROVAL_TYPES,
        primaryType: 'SpendApproval',
        message: APPROVAL,
        signature,
      }),
    ).toBe(true);
  });

  it('signs nothing when the account does not agree on the domain', async () => {
    const { connection, signed } = fakeConnection({ read: reads(`0x${'99'.repeat(32)}`) });

    await expect(signSpendApproval(connection, MANDATE, APPROVAL)).rejects.toThrow();
    expect(signed).toHaveLength(0);
  });
});

describe('signLimitsAuthorization', () => {
  it('returns the limits, nonce and deadline alongside the signature a relayer needs', async () => {
    const { connection, account } = fakeConnection({ read: reads(SEPARATOR) });

    const authorization = await signLimitsAuthorization(
      connection,
      MANDATE,
      LIMITS,
      7n,
      1_800_003_600n,
    );

    expect(authorization).toMatchObject({ limits: LIMITS, nonce: 7n, deadline: 1_800_003_600n });
    expect(
      await verifyTypedData({
        address: account.address,
        domain: DOMAIN,
        types: SET_LIMITS_TYPES,
        primaryType: 'SetLimits',
        message: { limits: LIMITS, nonce: 7n, deadline: 1_800_003_600n },
        signature: authorization.signature,
      }),
    ).toBe(true);
  });
});
