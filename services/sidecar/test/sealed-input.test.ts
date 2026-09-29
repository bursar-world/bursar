import { deriveViewingKey, sealedURI, viewingKeyMessage } from '@bursar/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { canonicalStringify, capabilityId, commitCanonical } from '../src/commit.js';
import { executeJob, parseRoutes } from '../src/executor.js';
import type { ExecutorOptions, LockJob } from '../src/executor.js';
import { payeeViewingKey, viewingKeyRegistration } from '../src/viewing.js';
import { createFakeFetch, jsonResponse } from './fakes.js';

const payee = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const INPUT = { city: 'Paris', units: 'metric' };
const CAPABILITY = 'weather.get:1';

function options(viewingKey: `0x${string}` | undefined): { options: ExecutorOptions; bodies: string[] } {
  const bodies: string[] = [];
  const { fetch } = createFakeFetch((call) => {
    bodies.push(String(call.init.body));
    return jsonResponse('{"tempC":21}');
  });
  return {
    bodies,
    options: {
      routes: parseRoutes({ [CAPABILITY]: { method: 'POST', path: '/v1/weather' } }),
      apiBase: 'http://127.0.0.1:8787',
      allowedHosts: new Set(['127.0.0.1']),
      fetch,
      fetchTimeoutMs: 1_000,
      maxBodyBytes: 4_096,
      maxInlineOutputBytes: 4_096,
      outputBaseUrl: undefined,
      writeOutput: async () => undefined,
      viewingKey,
    },
  };
}

async function sealedJob(recipientPublicKey: `0x${string}`, input: unknown = INPUT): Promise<LockJob> {
  return {
    id: 1n,
    capabilityId: capabilityId(CAPABILITY),
    inputCommit: commitCanonical(INPUT),
    inputURI: await sealedURI(recipientPublicKey, canonicalStringify(input)),
  };
}

describe('sealed job inputs', () => {
  it('derives the same key the payee publishes', async () => {
    const derived = deriveViewingKey(await payee.signMessage({ message: viewingKeyMessage(payee.address) }));
    const key = await payeeViewingKey(payee);
    expect(key.privateKey).toBe(derived.privateKey);
    const registration = await viewingKeyRegistration(payee);
    expect(registration.meta.endsWith(key.publicKey.slice(2))).toBe(true);
    expect(registration.calldata.startsWith('0x')).toBe(true);
  });

  it('opens an input sealed to the payee and holds it to the commitment', async () => {
    const key = await payeeViewingKey(payee);
    const { options: opts, bodies } = options(key.privateKey);
    const outcome = await executeJob(await sealedJob(key.publicKey), opts);
    expect(outcome.kind).toBe('executed');
    expect(bodies).toEqual([canonicalStringify(INPUT)]);
  });

  it('refuses a sealed input whose plaintext does not match the commitment', async () => {
    const key = await payeeViewingKey(payee);
    const outcome = await executeJob(await sealedJob(key.publicKey, { city: 'Lyon' }), options(key.privateKey).options);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('commitment mismatch') });
  });

  it('refuses an input sealed to someone else', async () => {
    const mine = await payeeViewingKey(payee);
    const theirs = await payeeViewingKey(stranger);
    const outcome = await executeJob(await sealedJob(theirs.publicKey), options(mine.privateKey).options);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'sealed input does not open with this payee viewing key' });
  });

  it('refuses a sealed input when no viewing key is configured', async () => {
    const key = await payeeViewingKey(payee);
    const outcome = await executeJob(await sealedJob(key.publicKey), options(undefined).options);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('SIDECAR_VIEWING_KEY') });
  });
});
