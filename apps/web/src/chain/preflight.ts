import { RHC_MAINNET, RHC_TESTNET, DEPLOYMENTS, defaultFallbackRpc } from '@bursar/core';
import type { RhcChain } from '@bursar/core';

import { TOKEN_CHAIN_ID } from './generated/token';

/**
 * What this build needs before it compiles a line, checked while there is still somewhere to print.
 *
 * Every one of these conditions is also enforced where it matters, in chain/rhc.ts, which is
 * module-level code inside the bundle. That failure is correct and unreadable: the bundler catches
 * it once per page it was collecting, minifies the frame it came from, and reports the page it gave
 * up on. The sentence explaining why is nowhere in that. Reading the same conditions here, before
 * the build starts, turns a pile of stacks into the one line an operator can act on.
 */

export type BuildEnv = Readonly<Record<string, string | undefined>>;

export type ConfigProblem = {
  readonly variable: string;
  /** What is wrong, in the present tense, with the value that caused it. */
  readonly condition: string;
  /** Imperative, and something the operator running the build can do. */
  readonly nextAction: string;
};

const RECORDED_CHAIN_IDS: readonly number[] = Object.values(DEPLOYMENTS).map((record) => record.chainId);

export function configProblems(env: BuildEnv): readonly ConfigProblem[] {
  const configured = env.NEXT_PUBLIC_RHC_NETWORK?.trim();

  if (!isNetworkName(configured)) {
    return [
      {
        variable: 'NEXT_PUBLIC_RHC_NETWORK',
        condition: `Set to "${configured}". This build talks to one Robinhood Chain network, and the two it knows are mainnet and testnet.`,
        nextAction: 'Leave it unset to build against mainnet, which is the network Bursar settles on.',
      },
    ];
  }

  // The one configuration this product cannot have. USDG is the settlement asset and it has no
  // contract on 46630, so a build pointed there has a console, an escrow and nothing to pay with.
  // Refusing it is the only honest answer: the alternative is a deployment that looks complete
  // until the first payment.
  if (configured === 'testnet') {
    return [
      {
        variable: 'NEXT_PUBLIC_RHC_NETWORK',
        condition:
          `Set to "testnet", chain ${RHC_TESTNET.chainId}. USDG is not deployed on ${RHC_TESTNET.chainId}, and USDG is what ` +
          'every mandate holds, every escrow locks and every provider is paid in. Nothing on that chain can settle a payment.',
        nextAction:
          `Leave it unset to build against Robinhood Chain ${RHC_MAINNET.chainId}. Testing runs against a local fork of ` +
          `${RHC_MAINNET.chainId}, where USDG and its balances are the real ones.`,
      },
    ];
  }

  const chain: RhcChain = RHC_MAINNET;
  const problems: ConfigProblem[] = [];

  if (!RECORDED_CHAIN_IDS.includes(chain.chainId)) {
    problems.push({
      variable: 'NEXT_PUBLIC_RHC_NETWORK',
      condition:
        `Selects chain ${chain.chainId}. No deployment record exists for that chain, so this build has no contract ` +
        `addresses to read. Recorded: ${RECORDED_CHAIN_IDS.join(', ')}.`,
      nextAction:
        'Record the mainnet deploy under contracts/deployments and run `pnpm --filter @bursar/core codegen`.',
    });
  } else if (TOKEN_CHAIN_ID !== chain.chainId) {
    // Worth saying only once the deployment exists. Otherwise it is the same missing deploy twice.
    problems.push({
      variable: 'NEXT_PUBLIC_RHC_NETWORK',
      condition:
        `Selects chain ${chain.chainId}, and the generated token addresses belong to chain ${TOKEN_CHAIN_ID}. ` +
        "The token surface would read one network at another network's addresses.",
      nextAction: 'Run `pnpm --filter @bursar/web codegen:token` against the selected network.',
    });
  }

  problems.push(...rpcProblems(env));

  const explorer = explorerProblem(env);
  if (explorer !== undefined) problems.push(explorer);

  return problems;
}

/**
 * The endpoints this build would use, with the defaults each variable falls back to. Mainnet is
 * the only network that gets this far, so there is nothing to choose between.
 */
export function rpcEndpoints(env: BuildEnv): { readonly primary: string; readonly fallback: string } {
  return {
    primary: env.NEXT_PUBLIC_RHC_RPC_PRIMARY?.trim() || RHC_MAINNET.rpcUrl,
    fallback: env.NEXT_PUBLIC_RHC_RPC_FALLBACK?.trim() || defaultFallbackRpc('mainnet'),
  };
}

/**
 * Checks for two endpoints at different hosts.
 *
 * .env.example says it and all three services enforce it by name. This app
 * published the same rule and enforced none of it: two copies of one host were accepted in
 * silence, and so was a primary that is not a URL at all. Both leave a build with one endpoint,
 * or none, and nothing on screen says so.
 */
export function rpcProblems(env: BuildEnv): readonly ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const endpoints = rpcEndpoints(env);

  const primaryHost = hostOf(endpoints.primary);
  const fallbackHost = hostOf(endpoints.fallback);

  if (primaryHost === undefined) {
    problems.push({
      variable: 'NEXT_PUBLIC_RHC_RPC_PRIMARY',
      condition: `Set to "${endpoints.primary}", which is not an http or https URL, so nothing can be read from it.`,
      nextAction: `Give it the full URL of a Robinhood Chain endpoint, scheme and all, or leave it unset to take ${RHC_MAINNET.rpcUrl}.`,
    });
  }

  if (fallbackHost === undefined) {
    problems.push({
      variable: 'NEXT_PUBLIC_RHC_RPC_FALLBACK',
      condition: `Set to "${endpoints.fallback}", which is not an http or https URL, so there is no second endpoint behind the first.`,
      nextAction: `Give it the full URL of a second Robinhood Chain endpoint at a different host, or leave it unset to take ${defaultFallbackRpc(
        'mainnet',
      )}, which needs no key.`,
    });
  }

  if (primaryHost !== undefined && primaryHost === fallbackHost) {
    problems.push({
      variable: 'NEXT_PUBLIC_RHC_RPC_FALLBACK',
      condition:
        `Both endpoints point at ${primaryHost}. Two names for one host is one endpoint: one rate meter, one ` +
        'outage, and no second opinion on what the chain says.',
      nextAction: `Name a second Robinhood Chain endpoint at a different host, or leave it unset to take ${defaultFallbackRpc(
        'mainnet',
      )}, which needs no key.`,
    });
  }

  return problems;
}

/** The explorer override, which exists so a moved explorer is a configuration change. */
function explorerProblem(env: BuildEnv): ConfigProblem | undefined {
  const declared = env.NEXT_PUBLIC_RHC_EXPLORER?.trim();
  if (declared === undefined || declared === '' || hostOf(declared) !== undefined) return undefined;

  return {
    variable: 'NEXT_PUBLIC_RHC_EXPLORER',
    condition: `Set to "${declared}", which is not an http or https URL, so every transaction and address link would be broken.`,
    nextAction: 'Give it the origin of the explorer readers should open, or leave it unset to take the recorded one.',
  };
}

/** The host, or undefined when the value is not an http or https URL at all. */
function hostOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.host.toLowerCase();
}

/**
 * The refusal an operator reads, or nothing when this build is configured. One block, no stack, and
 * the variable that caused each line.
 */
export function refusal(env: BuildEnv): string | undefined {
  const problems = configProblems(env);
  if (problems.length === 0) return undefined;

  const network = env.NEXT_PUBLIC_RHC_NETWORK?.trim();
  const lines: string[] = [
    '',
    isNetworkName(network)
      ? `  BURSAR cannot build for Robinhood Chain ${network === undefined || network === '' ? 'mainnet' : network}.`
      : '  BURSAR cannot build: NEXT_PUBLIC_RHC_NETWORK does not name a Robinhood Chain network.',
    '',
  ];

  for (const problem of problems) {
    lines.push(`  ${problem.variable}`);
    for (const line of wrap(problem.condition)) lines.push(`    ${line}`);
    for (const line of wrap(`Next: ${problem.nextAction}`)) lines.push(`    ${line}`);
    lines.push('');
  }

  lines.push('  Nothing was built.', '');
  return lines.join('\n');
}

/**
 * The same refusal as one sentence.
 *
 * Running `next build` directly skips the check above and reaches the guard inside the bundle,
 * where the bundler repeats the throw per page and minifies the frame around it. The message is
 * the only part that survives that intact, so it carries the condition and the next action itself.
 */
export function refusalLine(env: BuildEnv): string | undefined {
  const [first] = configProblems(env);
  if (first === undefined) return undefined;

  return `${first.variable}: ${first.condition} ${first.nextAction}`;
}

function isNetworkName(value: string | undefined): value is undefined | '' | 'testnet' | 'mainnet' {
  return value === undefined || value === '' || value === 'testnet' || value === 'mainnet';
}

const WIDTH = 92;

function wrap(text: string): readonly string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(' ')) {
    if (line === '') {
      line = word;
    } else if (`${line} ${word}`.length > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }

  if (line !== '') lines.push(line);
  return lines;
}
