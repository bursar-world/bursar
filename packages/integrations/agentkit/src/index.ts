import { createToolset } from '@bursar/toolset';
import type { BursarToolset, SpendCap, ToolArgs, ToolSpec } from '@bursar/toolset';
import { ActionProvider } from '@coinbase/agentkit';
import type { Action, EvmWalletProvider, Network } from '@coinbase/agentkit';
import { createWalletClient, custom, defineChain, numberToHex } from 'viem';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

export { agentKeyFromEnv, createToolset, toolsetFromEnv, usdg } from '@bursar/toolset';
export type { BursarToolset, SpendCap, ToolSpec, ToolsetOptions } from '@bursar/toolset';

export type BursarActionProviderOptions = {
  /** The mandate account the agent spends from. The wallet provider has to be its agent. */
  readonly mandate?: Address;
  /** What this agent may spend on top of the mandate's own limits. */
  readonly spendCap?: SpendCap;
  readonly rpc?: string | readonly string[];
  readonly deliverWithinSeconds?: number;
  /** A toolset opened elsewhere, which then supplies the signer instead of the wallet provider. */
  readonly toolset?: BursarToolset | readonly ToolSpec[];
};

/** Robinhood Chain, the only network a Bursar mandate settles on. */
const CHAIN_ID = '4663';

const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
});

type Request = { readonly method: string; readonly params?: unknown };

/**
 * A viem wallet client whose transactions the AgentKit wallet provider sends. The provider
 * prepares, signs and broadcasts the way it does for every other action, so a CDP wallet, a Privy
 * wallet or a viem account all work and no key is copied. Reads never come this way: the SDK
 * reads through its own connection.
 */
function walletClientFor(walletProvider: EvmWalletProvider) {
  const address = walletProvider.getAddress() as Address;
  const transport = custom({
    async request({ method, params }: Request) {
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [address];
        case 'eth_chainId':
          return numberToHex(Number(CHAIN_ID));
        case 'eth_sendTransaction': {
          const [tx] = params as [{ to: Address; data?: Hex; value?: Hex }];
          const hash = await walletProvider.sendTransaction({
            to: tx.to,
            ...(tx.data === undefined ? {} : { data: tx.data }),
            ...(tx.value === undefined ? {} : { value: BigInt(tx.value) }),
          });
          // A smart wallet answers with a user operation hash; its receipt names the transaction.
          const receipt = (await walletProvider.waitForTransactionReceipt(hash)) as { transactionHash?: Hex } | undefined;
          return receipt?.transactionHash ?? hash;
        }
        default:
          throw new Error(`The AgentKit wallet provider does not serve ${method}.`);
      }
    },
  });
  return createWalletClient({ account: address, chain: robinhoodChain, transport });
}

function zodSchemaFor(spec: ToolSpec) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of spec.parameters) {
    let field = z.string();
    if (p.pattern !== undefined) field = field.regex(new RegExp(p.pattern));
    const described = field.describe(p.description);
    shape[p.name] = p.required ? described : described.optional();
  }
  return z.object(shape).strip();
}

/**
 * Bursar as an AgentKit action provider: inspect, quote, pay and settlements over one mandate.
 *
 * The wallet provider AgentKit was configured with is the mandate's agent. It sends the spend the
 * way it sends every other action, so a CDP wallet, a Privy wallet or a viem account all work and
 * no key is copied. The money is the mandate's, never the wallet's: the wallet only signs.
 */
export class BursarActionProvider extends ActionProvider<EvmWalletProvider> {
  readonly #options: BursarActionProviderOptions;
  #specs: readonly ToolSpec[] | undefined;

  constructor(options: BursarActionProviderOptions = {}) {
    super('bursar', []);
    if (options.mandate === undefined && options.toolset === undefined) {
      throw new Error('bursarActionProvider needs a mandate address, or a toolset opened elsewhere.');
    }
    this.#options = options;
  }

  supportsNetwork(network: Network): boolean {
    return network.protocolFamily === 'evm' && (network.chainId === undefined || network.chainId === CHAIN_ID);
  }

  override getActions(walletProvider: EvmWalletProvider): Action[] {
    return this.#tools(walletProvider).map((spec) => ({
      name: spec.name,
      description: spec.description,
      schema: zodSchemaFor(spec),
      invoke: (args: ToolArgs) => spec.call(args),
    }));
  }

  #tools(walletProvider: EvmWalletProvider): readonly ToolSpec[] {
    if (this.#specs) return this.#specs;
    const { toolset, mandate, spendCap, rpc, deliverWithinSeconds } = this.#options;
    if (toolset !== undefined) {
      this.#specs = Array.isArray(toolset) ? (toolset as readonly ToolSpec[]) : (toolset as BursarToolset).tools();
      return this.#specs;
    }
    this.#specs = createToolset({
      mandate: mandate!,
      walletClient: walletClientFor(walletProvider),
      ...(spendCap === undefined ? {} : { spendCap }),
      ...(rpc === undefined ? {} : { rpc }),
      ...(deliverWithinSeconds === undefined ? {} : { deliverWithinSeconds }),
    }).tools();
    return this.#specs;
  }
}

export function bursarActionProvider(options: BursarActionProviderOptions = {}): BursarActionProvider {
  return new BursarActionProvider(options);
}
