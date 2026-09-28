/**
 * The exact bytes an escrow commitment covers.
 *
 * One implementation, in `@bursar/core`, because the payer hashes the input here and the payee
 * hashes the delivered output in its own process. Two serialisers that disagree on so much as key
 * order produce a lock whose commitment the payee can never reproduce, and the money sits there
 * until the deadline passes. RFC 8785 (JCS) is the agreement: keys sort by UTF-16 code unit,
 * numbers take their ECMAScript form, no whitespace survives.
 */
export { canonicalStringify, capabilityId, commitCanonical, toCapabilityId, toDataUri } from '@bursar/core';
