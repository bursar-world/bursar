#!/usr/bin/env node
/**
 * The command, kept out of the build output.
 *
 * A package manager creates the links in `node_modules/.bin` while it installs, which is before
 * `tsc` has produced `dist/`. A `bin` entry pointing straight at `dist/main.js` is therefore
 * skipped with an ENOENT warning, and `bursar-sidecar` never reaches PATH however many times the
 * workspace is rebuilt afterwards. This file is committed, so the link is always made, and the
 * build output is resolved when the command is actually run.
 */
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/main.js', import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write(
    'bursar-sidecar has not been built yet. Run `pnpm --filter @bursar/sidecar build` and try again.\n',
  );
  process.exit(1);
}

await import(entry.href);
