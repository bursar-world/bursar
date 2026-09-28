/**
 * Stands in for `node:buffer`. The npm `buffer` package is the same API built for a browser, minus
 * `constants`, which is a Node-only export that nothing here reads.
 */
export { Buffer, SlowBuffer, kMaxLength, INSPECT_MAX_BYTES } from 'buffer';
export { Buffer as default } from 'buffer';
