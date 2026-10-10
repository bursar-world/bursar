// Pays 0.25 USDG (or BURSAR_EXAMPLE_AMOUNT, in six-decimal units) to the demo provider from the example mandate on Robinhood Chain, through the
// AI SDK tools, with no model in the loop: each tool's execute runs the way generateText runs it.
//
//   BURSAR_AGENT_KEY=0x…  npx tsx examples/pay.ts            inspect, quote, pay, settlements
//   BURSAR_AGENT_KEY=0x…  npx tsx examples/pay.ts --quote    inspect and quote only; nothing is sent
//
// The agent key can also come from a keystore: BURSAR_KEYSTORE and BURSAR_KEYSTORE_PASSWORD_FILE.
import { bursarTools, toolsetFromEnv, usdg } from '@bursar/ai-sdk';

const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const AMOUNT = process.env.BURSAR_EXAMPLE_AMOUNT ?? '250000';
const quoteOnly = process.argv.includes('--quote');

const toolset = toolsetFromEnv(process.env, { mandate: MANDATE, spendCap: { total: usdg('0.25') } });
const tools = bursarTools(toolset);

async function call(name: string, args: Record<string, string>) {
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  console.log(await tools[name]!.execute!(args, { toolCallId: name, messages: [], context: undefined }));
}

const spend = { provider: PROVIDER, capability: 'gpu.render:1', amount: AMOUNT };
await call('bursar_inspect', {});
await call('bursar_quote', spend);
if (!quoteOnly) {
  await call('bursar_pay', { ...spend, input: 'render a koi, ink on paper' });
  await call('bursar_settlements', {});
}
