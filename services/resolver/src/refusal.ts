import { EnvError, isBursarError } from '@bursar/core';

import { describeError } from './log.js';
import type { Logger } from './log.js';

/**
 * What a resolver service that could not start says on its way out.
 *
 * `describeError` keeps the headline of a message and whatever viem decoded, which is right for a
 * revert carrying a whole request and wrong for the one error whose value is entirely in lines two
 * onward. A configuration refusal is a list: every variable that could not be read, by name, with
 * the format it expected. Reporting only the heading leaves an operator with "Configuration is not
 * usable:" and no colon to follow.
 *
 * One line per variable. A log field is clipped at a fixed length, and a first run with eight
 * things unset is exactly when the list is worth having whole.
 */
export function reportStartupFailure(logger: Logger, error: unknown): void {
  if (error instanceof EnvError) {
    logger.error('fatal', {
      reason: 'Configuration is not usable',
      code: error.code,
      problems: error.problems.length,
    });

    for (const problem of error.problems) {
      logger.error('config_problem', {
        variable: problem.name,
        reason: problem.reason,
        expected: problem.expected,
      });
    }

    return;
  }

  if (isBursarError(error)) {
    logger.error('fatal', { reason: describeError(error), code: error.code });
    return;
  }

  logger.error('fatal', { reason: describeError(error) });
}
