/** A variable the worker needs is missing or malformed. Named so the response can say which. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
