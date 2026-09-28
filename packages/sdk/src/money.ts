import { parseMicro } from '@bursar/core';
import type { Micro } from '@bursar/core';

import { InvalidArgumentError } from './errors.js';

export { MICRO_SCALE, micro, microToAtomicString, toMicro } from '@bursar/core';
export type { Micro } from '@bursar/core';

export { usd as formatUsdg } from './format.js';

/**
 * A USD amount written the way a price is written: `usdg('2.50')`.
 *
 * A string, because a JavaScript number cannot hold a price. `0.1 + 0.2` is the reason every
 * amount in this package is an integer count of millionths, and taking a number here would put
 * the one float the system cannot survive at the front door.
 *
 * A negative stops here. This is a price, and every call that takes one pays it out: the account
 * refuses a negative, the underwriter rejects it and the console will not send it. A minus sign
 * that survives this far is a sign error upstream, not an instruction. Returning `-1000000n` for
 * `usdg('-1')` would carry it into a signed request and leave it to be found by whichever layer
 * happened to look.
 */
export function usdg(amount: string): Micro {
  // The type says string, and a caller in plain JavaScript or behind a cast still sends a number.
  // parseMicro would fail on it with a message about trim, or round 0.1 + 0.2 to 0.3 without
  // saying so if it were coerced, so the refusal names the fix.
  if (typeof amount !== 'string') {
    throw new InvalidArgumentError(
      'amount',
      `usdg() takes a decimal string such as '2.50', and was given a ${typeof amount} (${String(amount)}). ` +
        'A JavaScript number cannot hold every cent exactly (0.1 + 0.2 is 0.30000000000000004), so ' +
        'write the amount as a string.',
      { input: String(amount), type: typeof amount },
    );
  }

  const value = parseMicro(amount);

  if (value < 0n) {
    throw new InvalidArgumentError('amount', `usdg() takes an amount to pay, and ${amount} is negative.`, {
      value: value.toString(),
      input: amount,
    });
  }

  return value;
}
