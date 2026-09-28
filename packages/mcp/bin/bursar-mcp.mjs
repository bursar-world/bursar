#!/usr/bin/env node
/**
 * The command lives outside `dist/` on purpose.
 *
 * A package manager creates the links in `node_modules/.bin` while it installs, which is before
 * `tsc` has produced `dist/`. A `bin` entry pointing straight at `dist/cli.js` is therefore
 * skipped with an ENOENT warning, and `bursar-mcp` never reaches PATH however many times the
 * workspace is rebuilt afterwards. This file is committed, so the link is always made, and the
 * build output is resolved when the command is actually run.
 */
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/cli.js', import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write(
    'bursar-mcp has not been built yet. Run `pnpm --filter @bursar/mcp build` and try again.\n',
  );
  process.exit(1);
}

await import(entry.href);
