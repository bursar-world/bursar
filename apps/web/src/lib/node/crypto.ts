/**
 * Stands in for `node:crypto` in the browser bundle.
 *
 * @bursar/core exports everything through one entry, and one module behind that entry binds an
 * x402 payment to the request it buys. That work happens in the facilitator. Nothing in a browser
 * signs a payment binding, so the two functions it needs are provided here. A full crypto polyfill
 * would ride into every page that will never call them.
 */
import { Buffer } from 'buffer';

export function randomBytes(size: number): Buffer {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

export function createHash(algorithm: string): never {
  throw new Error(
    `createHash("${algorithm}") was called in the browser. Request hashing belongs to the ` +
      'facilitator, which runs on a server. If a surface needs this, move the call behind an API route.',
  );
}

export default { randomBytes, createHash };
