/**
 * The exact bytes an escrow commitment covers.
 *
 * The payer commits to its input in one process and this service commits to its output in
 * another. The serialiser has to be the same object on both sides, not the same idea implemented
 * twice. It lives in `@bursar/core` for that reason. RFC 8785 (JCS): keys sort by
 * UTF-16 code unit, numbers take their ECMAScript form, no whitespace survives.
 */
export { canonicalStringify, capabilityId, commitCanonical } from '@bursar/core';
