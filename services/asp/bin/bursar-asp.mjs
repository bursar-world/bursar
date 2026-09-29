#!/usr/bin/env node
// Committed rather than pointed at dist/ from package.json: the package manager links bins before
// tsc has built anything, and a link to a file that does not exist yet is skipped for good.
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/main.js', import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('bursar-asp has not been built yet. Run `pnpm --filter @bursar/asp build` and try again.\n');
  process.exit(1);
}

await import(entry.href);
