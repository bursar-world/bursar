// Pays 0.25 USDG (or BURSAR_EXAMPLE_AMOUNT, in six-decimal units) to the demo provider from the example mandate on Robinhood Chain, through
// AgentKit, with no model in the loop: the actions are invoked the way an agent invokes them. The
// wallet AgentKit holds is the mandate's agent; it signs, and the mandate pays.
//
//   BURSAR_AGENT_KEY=0x…  npx tsx examples/pay.ts            inspect, quote, pay, settlements
//   BURSAR_AGENT_KEY=0x…  npx tsx examples/pay.ts --quote    inspect and quote only; nothing is sent
//
// The agent key can also come from a keystore: BURSAR_KEYSTORE and BURSAR_KEYSTORE_PASSWORD_FILE.
import { agentKeyFromEnv, bursarActionProvider, usdg } from '@bursar/agentkit';
import { AgentKit, ViemWalletProvider } from '@coinbase/agentkit';
import { createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const PROVIDER = '0x5210D8df060A9D5ce4c1305045ED5c9548fca374';
const RPC = process.env.BURSAR_RPC?.split(',')[0] ?? 'https://robinhood.drpc.org';
const AMOUNT = process.env.BURSAR_EXAMPLE_AMOUNT ?? '250000';
const quoteOnly = process.argv.includes('--quote');

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

// AgentKit 0.10 reports wallet initialisation to Coinbase without awaiting the call, so a refusal
// from that endpoint would otherwise end this process. Warn and carry on.
process.on('unhandledRejection', (error) => {
  if (error instanceof Error && error.message.startsWith('HTTP error! status:')) {
    console.warn(`agentkit analytics: ${error.message}`);
    return;
  }
  throw error;
});

const key = agentKeyFromEnv();
if (!key) throw new Error('Set BURSAR_AGENT_KEY, or BURSAR_KEYSTORE with BURSAR_KEYSTORE_PASSWORD_FILE.');

// AgentKit pins its own viem; the cast only reconciles the two copies' types.
const walletClient = createWalletClient({ account: privateKeyToAccount(key), chain: robinhoodChain, transport: http(RPC) });
const walletProvider = new ViemWalletProvider(walletClient as unknown as ConstructorParameters<typeof ViemWalletProvider>[0]);
const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [bursarActionProvider({ mandate: MANDATE, rpc: RPC, spendCap: { total: usdg('0.25') } })],
});
const actions = agentKit.getActions();

async function call(name: string, args: Record<string, string>) {
  const action = actions.find((a) => a.name === name)!;
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  console.log(await action.invoke(action.schema.parse(args)));
}

const spend = { provider: PROVIDER, capability: 'gpu.render:1', amount: AMOUNT };
await call('bursar_inspect', {});
await call('bursar_quote', spend);
if (!quoteOnly) {
  await call('bursar_pay', { ...spend, input: 'render a koi, ink on paper' });
  await call('bursar_settlements', {});
}
