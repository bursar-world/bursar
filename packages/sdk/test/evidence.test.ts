import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, hashTypedData, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  EVIDENCE_DOMAIN_NAME,
  EVIDENCE_DOMAIN_VERSION,
  deliveryEvidenceTypedData,
  encodeEvidence,
  parseEvidence,
  recoverEvidenceSigner,
  signDeliveryEvidence,
  signPayerStatement,
  verifyEvidence,
} from '../src/evidence.js';
import type { DeliveryEvidence } from '../src/evidence.js';

const ESCROW: Address = '0x7D82Ad9Dc36734AdCF5Cf985295096b2b575C8C4';
const OTHER_ESCROW: Address = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 4663;

const payee = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);

const EVIDENCE: DeliveryEvidence = {
  escrowId: 9n,
  inputCommit: `0x${'aa'.repeat(32)}`,
  outputCommit: `0x${'bb'.repeat(32)}`,
  outputURI: 'https://outputs.example.com/9.json',
  deliveredAt: 1_790_000_000n,
};

describe('delivery evidence', () => {
  it('hashes the struct the resolver service documents, field for field', () => {
    // Transcribed from the policy rather than derived from the constant under test, so a field
    // renamed or reordered in the types object fails here instead of in production.
    const typeHash = keccak256(
      toBytes(
        'DeliveryEvidence(uint256 escrowId,bytes32 inputCommit,bytes32 outputCommit,string outputURI,uint64 deliveredAt)',
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }],
        [typeHash, EVIDENCE.escrowId, EVIDENCE.inputCommit, EVIDENCE.outputCommit, keccak256(toBytes(EVIDENCE.outputURI)), EVIDENCE.deliveredAt],
      ),
    );
    const domainHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [
          keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
          keccak256(toBytes(EVIDENCE_DOMAIN_NAME)),
          keccak256(toBytes(EVIDENCE_DOMAIN_VERSION)),
          BigInt(CHAIN_ID),
          ESCROW,
        ],
      ),
    );
    const digest = keccak256(`0x1901${domainHash.slice(2)}${structHash.slice(2)}` as Hex);

    expect(hashTypedData(deliveryEvidenceTypedData(ESCROW, CHAIN_ID, EVIDENCE))).toBe(digest);
  });

  it('recovers the payee that signed it', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);

    expect(await recoverEvidenceSigner(submission)).toBe(payee.address);
    expect(await verifyEvidence(submission, payee.address)).toBe(true);
    expect(await verifyEvidence(submission, stranger.address)).toBe(false);
  });

  it('does not verify against another escrow or another chain', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);

    expect(await verifyEvidence({ ...submission, escrow: OTHER_ESCROW }, payee.address)).toBe(false);
    expect(await verifyEvidence({ ...submission, chainId: 46630 }, payee.address)).toBe(false);
  });

  it('does not verify once any signed field is changed', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);
    if (submission.kind !== 'delivery') throw new Error('unreachable');

    const edited = { ...submission, evidence: { ...submission.evidence, outputURI: 'https://elsewhere.example.com/9.json' } };
    expect(await verifyEvidence(edited, payee.address)).toBe(false);
  });

  it('answers false for a signature that does not parse', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);
    expect(await verifyEvidence({ ...submission, signature: `0x${'00'.repeat(65)}` }, payee.address)).toBe(false);
  });

  it('survives the wire unchanged', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);
    const parsed = parseEvidence(JSON.parse(JSON.stringify(encodeEvidence(submission))));

    expect(parsed).toEqual(submission);
    expect(await verifyEvidence(parsed, payee.address)).toBe(true);
  });

  it('refuses a delivery with nowhere to fetch it', async () => {
    const submission = await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE);
    const wire = encodeEvidence(submission);
    if (wire.kind !== 'delivery') throw new Error('unreachable');

    expect(() => parseEvidence({ ...wire, evidence: { ...wire.evidence, outputURI: ' ' } })).toThrow(
      expect.objectContaining({ field: 'outputURI' }),
    );
  });

  it('refuses numbers where decimal strings belong', async () => {
    const wire = encodeEvidence(await signDeliveryEvidence(payee, ESCROW, CHAIN_ID, EVIDENCE));
    if (wire.kind !== 'delivery') throw new Error('unreachable');

    expect(() => parseEvidence({ ...wire, evidence: { ...wire.evidence, escrowId: 9 } })).toThrow(
      expect.objectContaining({ field: 'evidence.escrowId' }),
    );
  });
});

describe('payer statements', () => {
  it('round-trips and recovers the payer', async () => {
    const submission = await signPayerStatement(stranger, ESCROW, CHAIN_ID, { escrowId: 9n, reason: '  Nothing arrived.  ' });
    const parsed = parseEvidence(JSON.parse(JSON.stringify(encodeEvidence(submission))));

    expect(parsed.kind).toBe('payer-statement');
    if (parsed.kind === 'payer-statement') expect(parsed.statement.reason).toBe('Nothing arrived.');
    expect(await verifyEvidence(parsed, stranger.address)).toBe(true);
  });

  it('refuses an empty statement', async () => {
    await expect(signPayerStatement(stranger, ESCROW, CHAIN_ID, { escrowId: 9n, reason: ' ' })).rejects.toMatchObject({
      field: 'reason',
    });
  });
});
