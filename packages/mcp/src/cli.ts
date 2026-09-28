#!/usr/bin/env node
import process from 'node:process';

import { start } from './server.js';
import { redactSecrets } from './tools.js';

/** Names that carry a secret before config has been read and could name them itself. */
const SENSITIVE = [
  'BURSAR_SIGNER_KEY',
  'BURSAR_RELAY_TOKEN',
  'BLOCKSCOUT_API_KEY',
  'RHC_RPC_PRIMARY',
  'RHC_RPC_FALLBACK',
  'RHC_RPC_TERTIARY',
];

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = SENSITIVE.map((name) => process.env[name] ?? '').filter((value) => value !== '');

  process.stderr.write(`${redactSecrets(message, secrets)}\n`);
  process.exitCode = 1;
});
