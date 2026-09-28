import {
  RHC_MAINNET,
  deploymentForChain,
  explorerAddressUrl,
  explorerBlockUrl,
  explorerTxUrl,
  viemChain,
} from '@bursar/core';
import type { Deployment, RhcChain, RpcProvider } from '@bursar/core';
import type { Address, Chain, Hex } from 'viem';

import { TOKEN_CHAIN_ID } from './generated/token';
import { refusalLine, rpcEndpoints, rpcProblems } from './preflight';

/**
 * The one chain this build talks to, named by the deployment and never compiled in.
 *
 * Robinhood Chain 4663 is the target. Chain 46630 carries the same contracts and no USDG, so a
 * build pointed at it has nothing to settle with; `NEXT_PUBLIC_RHC_NETWORK` is refused when it
 * names testnet and an unset variable means mainnet.
 *
 * `rhcChain()` is what the services use. It is not used here because it reads its parameters from
 * the process environment, which a browser bundle does not have.
 */
refuseAnythingButMainnet();

export const RHC: RhcChain = selectedChain();
export const CHAIN: Chain = viemChain(RHC);
export const CHAIN_ID = RHC.chainId;

/**
 * The recorded chain, with the explorer this deployment links readers to.
 *
 * An explorer that moves host takes every transaction and address link on the product with it, and
 * a value compiled into the bundle makes that a release. `NEXT_PUBLIC_RHC_EXPLORER` makes it a
 * configuration change. It governs links and nothing else: the index this app reads is a separate,
 * paid host and is never reached from a browser. See src/app/api/index/route.ts.
 */
function selectedChain(): RhcChain {
  // Mainnet is the only chain record with a settlement asset, and `selectedNetwork` has already
  // refused everything else, so there is no second branch to take here.
  const declared = process.env.NEXT_PUBLIC_RHC_EXPLORER?.trim();
  if (declared === undefined || declared === '') return RHC_MAINNET;

  return Object.freeze({ ...RHC_MAINNET, explorer: declared.replace(/\/+$/, '') });
}

/**
 * The address book, found by chain id and never by name. Point this app at a network it has no
 * record for and it stops before one network's contracts appear under another's heading.
 *
 * Resolved the first time something asks for an address. The build already refuses a missing
 * record up front, in one legible block, so the copy inside the bundle is a fallback and not the
 * gate. Resolving it at import would take down every module that reaches here for `shortAddress`
 * or the chain's own name, and a screen that formats an address has no business failing to load
 * because the address book is absent.
 */
let recorded: Deployment | undefined;

export function deployment(): Deployment {
  if (recorded !== undefined) return recorded;

  try {
    recorded = deploymentForChain(CHAIN_ID);
    return recorded;
  } catch (error) {
    // `pnpm build` reads the same condition first and prints it in full. This is the path a bare
    // `next build` takes, where the throw is repeated once per page and the frame is minified, so
    // the message has to carry the whole answer on its own.
    const line = refusalLine({
      NEXT_PUBLIC_RHC_NETWORK: process.env.NEXT_PUBLIC_RHC_NETWORK,
      NEXT_PUBLIC_RHC_RPC_FALLBACK: process.env.NEXT_PUBLIC_RHC_RPC_FALLBACK,
    });

    throw line === undefined ? error : new Error(line);
  }
}

/**
 * The token addresses are generated from one deployment and carry no chain with them, so left
 * unchecked the token surface would read one network at another network's addresses. Called by
 * the two functions that read token state, which is the last point where it can still be stopped.
 */
export function assertTokenChain(): void {
  if (TOKEN_CHAIN_ID === CHAIN_ID) return;

  throw new Error(
    `The generated token addresses belong to chain ${TOKEN_CHAIN_ID} and this build talks to chain ${CHAIN_ID}. ` +
      'Regenerate them with `pnpm --filter @bursar/web codegen:token` against the selected network.',
  );
}

/** Multicall3, canonical across EVM chains and bytecode-checked on Robinhood Chain. */
export const MULTICALL3: Address = RHC.multicall3;

/**
 * ArbSys, the Arbitrum precompile that answers this chain's own block height.
 *
 * Fixed at this address on every Arbitrum and Orbit chain, so it is written here rather than
 * carried in the deployment record. See `arbSysAbi` for why the height cannot come from the EVM's
 * `block.number`.
 */
export const ARB_SYS = '0x0000000000000000000000000000000000000064' as const satisfies Address;

/** Contract addresses. Read from the deployment record so this file holds none of its own. */
export const ADDRESSES = {
  get mandateAccountFactory() {
    return deployment().contracts.MandateAccountFactory;
  },
  get escrow() {
    return deployment().contracts.Escrow;
  },
  get reputation() {
    return deployment().contracts.Reputation;
  },
  get agentRegistry() {
    return deployment().contracts.AgentRegistry;
  },
  get oracleRegistry() {
    return deployment().contracts.OracleRegistry;
  },
  get adminTimelock() {
    return deployment().contracts.AdminTimelock;
  },
  get usdg() {
    return deployment().settlementAsset;
  },
  get treasury() {
    return deployment().roles.treasury;
  },
  get guardian() {
    return deployment().roles.guardian;
  },
} satisfies Readonly<Record<string, Address>>;

/**
 * Two endpoints at different hosts. One name for one endpoint is one rate meter and one outage.
 * The fallback needs no key so a build with nothing configured still has somewhere to go.
 *
 * The rule is checked here, not assumed. `pnpm build` reads the same conditions first and prints
 * them as a block; this is the path a bare `next dev` takes, where the only thing that reaches the
 * reader is the message.
 */
export function rpcProviders(): readonly RpcProvider[] {
  const env = {
    NEXT_PUBLIC_RHC_RPC_PRIMARY: process.env.NEXT_PUBLIC_RHC_RPC_PRIMARY,
    NEXT_PUBLIC_RHC_RPC_FALLBACK: process.env.NEXT_PUBLIC_RHC_RPC_FALLBACK,
  };

  const [problem] = rpcProblems(env);
  if (problem !== undefined) throw new Error(`${problem.variable}: ${problem.condition} ${problem.nextAction}`);

  const endpoints = rpcEndpoints(env);
  return [
    { name: 'primary', url: endpoints.primary },
    { name: 'fallback', url: endpoints.fallback },
  ];
}

/**
 * Where a reader goes to check a hash or an address for themselves.
 *
 * Robinhood Chain's explorer is open to anyone with a browser, so every transaction and every
 * address on the product carries a link to it. It sits behind a challenge that expects a person, so
 * nothing in this app ever fetches it: the history and the revert reasons come from the index, and
 * the index is read server-side. These three functions produce link targets and make no requests.
 */
export function explorerTx(hash: Hex): string {
  return explorerTxUrl(RHC, hash);
}

export function explorerAddress(address: Address): string {
  return explorerAddressUrl(RHC, address);
}

export function explorerBlock(block: bigint): string {
  return explorerBlockUrl(RHC, block);
}

/** `0x1234…cdef`. Long enough to recognise, short enough for a table cell. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export function isZeroAddress(address: string | undefined): boolean {
  return sameAddress(address, ZERO_ADDRESS);
}

/**
 * Runs for its refusal, before anything below reads a chain record.
 *
 * Mainnet is the product and an unset variable means mainnet. Everything else stops here, and the
 * preflight owns the sentence that explains it, including the one about USDG, so this asks for
 * that line instead of writing a second version of it.
 */
function refuseAnythingButMainnet(): void {
  const configured = process.env.NEXT_PUBLIC_RHC_NETWORK?.trim();
  if (configured === undefined || configured === '' || configured === 'mainnet') return;

  throw new Error(refusalLine({ NEXT_PUBLIC_RHC_NETWORK: configured }) ?? `NEXT_PUBLIC_RHC_NETWORK is "${configured}".`);
}
