/**
 * A refusal an agent can act on. Every error this server raises itself carries one of these
 * codes; anything else is reduced to `call_failed` on the way out so a stack trace or a
 * request body never reaches the model.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export function invalidArguments(message: string, detail?: Record<string, unknown>): ToolError {
  return new ToolError('invalid_arguments', message, detail);
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}
