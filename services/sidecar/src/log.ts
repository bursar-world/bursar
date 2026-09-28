export type LogValue = string | number | bigint | boolean;

export type LogFields = Readonly<Record<string, LogValue>>;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

export type LogSink = (line: string) => void;

type Level = 'info' | 'warn' | 'error';

/**
 * Long enough for a revert reason and the selector that produced it, short enough that one bad
 * RPC response cannot push a megabyte of decoded calldata through the log pipeline.
 */
const MAX_FIELD_LENGTH = 512;

function clip(value: string): string {
  return value.length <= MAX_FIELD_LENGTH ? value : `${value.slice(0, MAX_FIELD_LENGTH)}…`;
}

function write(sink: LogSink, level: Level, event: string, fields: LogFields | undefined): void {
  const record: Record<string, string | number | boolean> = {
    level,
    event,
    time: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === 'bigint') {
      record[key] = value.toString();
    } else if (typeof value === 'string') {
      record[key] = clip(value);
    } else {
      record[key] = value;
    }
  }

  sink(JSON.stringify(record));
}

/**
 * One JSON object per line. Only the fields a call site passes are emitted, so the signing key
 * and the raw environment stay out of the log by construction, with no redaction pass to keep up.
 */
export function createLogger(sink: LogSink = defaultSink): Logger {
  return {
    info: (event, fields) => write(sink, 'info', event, fields),
    warn: (event, fields) => write(sink, 'warn', event, fields),
    error: (event, fields) => write(sink, 'error', event, fields),
  };
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The lines of a viem message worth keeping. Everything else in one is the request restated: the
 * address, the arguments, a documentation link and a version.
 */
const DECODED = /^(Error|Details|Reason):\s*\S/;

/** Two is a revert and its cause. A third is a message this log is not the place to read. */
const MAX_DECODED_LINES = 2;

/**
 * Error text safe to put in a log field or an outcome reason: the message only, never the stack
 * and never the cause chain.
 *
 * The headline of a viem revert is "The contract function X reverted", which is the same sentence
 * for every revert the escrow raises: `BadStatus`, `TooEarly`, `NotPayee`, `AlreadyCounted`. The
 * decoded custom error is on a later line, and keeping only the first made every one of them read
 * the same in the log. So the headline is kept and so is anything viem decoded, and the rest of
 * the message, which is the whole request written out again, is not.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n').map((line) => line.trim());

  const headline = lines.find((line) => line !== '') ?? message.trim();
  const decoded: string[] = [];
  for (const line of lines) {
    if (line === headline || !DECODED.test(line) || decoded.includes(line)) continue;
    decoded.push(line);
    if (decoded.length === MAX_DECODED_LINES) break;
  }

  return [headline, ...decoded].join('; ');
}
