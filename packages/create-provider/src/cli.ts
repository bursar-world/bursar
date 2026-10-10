#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { scaffold } from './scaffold.js';

const directory = process.argv[2];

if (!directory || directory.startsWith('-')) {
  console.error('usage: npm create @bursar/provider <directory>');
  process.exit(1);
}

const target = resolve(process.cwd(), directory);
let name: string;
try {
  ({ name } = scaffold(fileURLToPath(new URL('../template/', import.meta.url)), target));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`Created ${name} in ${target}.

Next:
  cd ${directory}
  npm install
  edit wrangler.toml: your provider address, the capability, the prices
  npx wrangler secret put BURSAR_FACILITATOR_TOKEN
  npx wrangler deploy

Then an agent can pay it:
  MANDATE=0x… AGENT_KEY=0x… npx tsx scripts/pay.ts https://${name}.<your-subdomain>.workers.dev/render
`);
