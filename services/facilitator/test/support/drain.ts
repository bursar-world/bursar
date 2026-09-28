import type { RelayPass, TrustRelay } from '../../src/trust/relay.js';

/** Runs relay passes until nothing is due, so a test can assert on what was delivered. */
export async function drain(relay: TrustRelay, maxPasses = 100): Promise<RelayPass> {
  let total: RelayPass = { claimed: 0, published: 0, retried: 0, quarantined: 0 };
  for (let i = 0; i < maxPasses; i += 1) {
    const pass = await relay.pass();
    total = {
      claimed: total.claimed + pass.claimed,
      published: total.published + pass.published,
      retried: total.retried + pass.retried,
      quarantined: total.quarantined + pass.quarantined,
    };
    if (pass.claimed === 0) break;
  }
  return total;
}
