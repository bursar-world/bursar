/**
 * Pays your worker once, from a mandate, the way an agent would.
 *
 *   MANDATE=0x…  AGENT_KEY=0x…  npx tsx scripts/pay.ts http://localhost:8787/render
 *
 * MANDATE is a mandate account whose principal allows the worker's capability and provider.
 * AGENT_KEY is the key of the agent that mandate names. The mandate pays the quoted price through
 * its own escrow, and the worker's answer comes back with the settlement.
 */
import { mandateAccount } from '@bursar/sdk';
import type { Hex } from 'viem';

const url = process.argv[2];
const mandateAddress = process.env['MANDATE'];
const agentKey = process.env['AGENT_KEY'];
const capability = process.env['CAPABILITY'] ?? 'service:render:1';

if (!url || !mandateAddress || !agentKey) {
  console.error('usage: MANDATE=0x… AGENT_KEY=0x… npx tsx scripts/pay.ts <url>');
  process.exit(1);
}

const mandate = await mandateAccount(mandateAddress as `0x${string}`, { account: agentKey as Hex });
const paid = await mandate.fetch(url, {
  method: 'POST',
  body: JSON.stringify({ prompt: 'a koi' }),
  capability,
  lane: 'mandate',
});

console.log(paid.response.status, await paid.response.text());
if (paid.payment) {
  console.log('paid', paid.payment.amount.toString(), 'micro-USDG to', paid.payment.payTo);
  console.log('lock', paid.payment.lock?.id.toString(), 'opened in', paid.payment.lock?.transaction);
  console.log('settlement', paid.payment.settlement);
}
