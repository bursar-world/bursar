import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { configProblems, refusal, refusalLine, rpcEndpoints, rpcProblems } from '@/chain/preflight';

/**
 * Which network this build is allowed to be, and what it says when it is pointed at the other one.
 *
 * The refusal used to run the other way: mainnet was the configuration that could not work,
 * because the mainnet parameters were unpublished. Here mainnet is the product and testnet is the
 * configuration that cannot work, because USDG has no contract on 46630 and USDG is what every
 * mandate holds. A build that came up on testnet would have a console, an escrow and nothing to
 * pay with, and it would look complete until the first payment.
 */
describe('mainnet is what this build is for', () => {
  it('passes with the network unset, which is how a checkout runs', () => {
    expect(refusal({})).toBeUndefined();
    expect(configProblems({})).toEqual([]);
  });

  it('passes when mainnet is named outright', () => {
    expect(refusal({ NEXT_PUBLIC_RHC_NETWORK: 'mainnet' })).toBeUndefined();
  });

  it('asks for no second endpoint by name, because the recorded one needs no key', () => {
    expect(configProblems({ NEXT_PUBLIC_RHC_NETWORK: 'mainnet' })).toEqual([]);
  });
});

describe('testnet refuses, and says why', () => {
  const text = refusal({ NEXT_PUBLIC_RHC_NETWORK: 'testnet' });

  it('refuses', () => {
    expect(text).toBeDefined();
  });

  it('names the asset that is missing and the chain it is missing from', () => {
    expect(text).toContain('BURSAR cannot build for Robinhood Chain testnet.');
    expect(text).toContain('USDG is not deployed on 46630');
    expect(text).toContain('46630');
  });

  it('says where testing runs instead', () => {
    const [problem] = configProblems({ NEXT_PUBLIC_RHC_NETWORK: 'testnet' });

    expect(text).toContain('Next:');
    expect(problem?.nextAction).toContain('local fork of 4663');
  });

  it('stops there, because nothing after it can be read', () => {
    const problems = configProblems({ NEXT_PUBLIC_RHC_NETWORK: 'testnet' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('NEXT_PUBLIC_RHC_NETWORK');
  });

  it('is a block an operator reads, not a stack', () => {
    const lines = (text ?? '').split('\n');
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(text).not.toContain('Failed to collect page data');
    expect(text).not.toContain('/docs');
    expect(text).not.toMatch(/\bat [\w$.]+ \(/);
  });
});

describe('a network this build has never heard of refuses by name', () => {
  const text = refusal({ NEXT_PUBLIC_RHC_NETWORK: 'sandbox' });

  it('says which value it read and which two it knows', () => {
    expect(text).toContain('NEXT_PUBLIC_RHC_NETWORK does not name a Robinhood Chain network');
    expect(text).toContain('Set to "sandbox"');
    expect(text).toContain('mainnet and testnet');
  });

  it('sends the reader to mainnet, which is the one that works', () => {
    expect(configProblems({ NEXT_PUBLIC_RHC_NETWORK: 'sandbox' })[0]?.nextAction).toContain('unset to build against mainnet');
  });
});

/**
 * `next build` run on its own skips the check and reaches the guard inside the bundle, which the
 * bundler minifies and repeats per page. What survives that is the message, so it carries the
 * whole answer. The fragment that used to sit mid-dump carried none of it.
 */
describe('the refusal inside the bundle', () => {
  it('carries the condition and the next action in one line', () => {
    const line = refusalLine({ NEXT_PUBLIC_RHC_NETWORK: 'testnet' });

    expect(line).toContain('NEXT_PUBLIC_RHC_NETWORK');
    expect(line).toContain('USDG is not deployed on 46630');
    expect(line).toContain('local fork');
    expect(line?.split('\n')).toHaveLength(1);
  });

  it('says nothing when there is nothing to refuse', () => {
    expect(refusalLine({ NEXT_PUBLIC_RHC_NETWORK: 'mainnet' })).toBeUndefined();
  });
});

/**
 * The two-endpoint rule, enforced where it is published.
 *
 * .env.example says the fallback has to be a different host, and all three services refuse it
 * by name. This app published the same rule and checked none of it: two copies
 * of one host were accepted in silence, and so was a primary that is not a URL. Both ship a build
 * with one endpoint or none, and nothing on screen says which.
 */
describe('two endpoints at different hosts', () => {
  it('refuses two names for one host, and says which host', () => {
    const problems = rpcProblems(
      {
        NEXT_PUBLIC_RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
        NEXT_PUBLIC_RHC_RPC_FALLBACK: 'https://rpc.mainnet.chain.robinhood.com/',
      },
    );

    expect(problems.map((problem) => problem.variable)).toEqual(['NEXT_PUBLIC_RHC_RPC_FALLBACK']);
    expect(problems[0]?.condition).toContain('rpc.mainnet.chain.robinhood.com');
    expect(problems[0]?.condition).toContain('Two names for one host is one endpoint');
    expect(problems[0]?.nextAction).toContain('different host');
  });

  it('catches it through the whole preflight, not only the helper', () => {
    const text = refusal({
      NEXT_PUBLIC_RHC_RPC_PRIMARY: 'https://robinhood.drpc.org',
      NEXT_PUBLIC_RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
    });

    expect(text).toContain('NEXT_PUBLIC_RHC_RPC_FALLBACK');
    expect(text).toContain('robinhood.drpc.org');
  });

  it('refuses a primary that is not a URL, rather than taking it as an endpoint', () => {
    const problems = rpcProblems({ NEXT_PUBLIC_RHC_RPC_PRIMARY: 'notaurl' });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.variable).toBe('NEXT_PUBLIC_RHC_RPC_PRIMARY');
    expect(problems[0]?.condition).toContain('not an http or https URL');
    expect(problems[0]?.nextAction).toContain('https://rpc.mainnet.chain.robinhood.com');
  });

  it('refuses a fallback that is not a URL', () => {
    const problems = rpcProblems({ NEXT_PUBLIC_RHC_RPC_FALLBACK: 'ws://rhc.example' });

    expect(problems.map((problem) => problem.variable)).toEqual(['NEXT_PUBLIC_RHC_RPC_FALLBACK']);
    expect(problems[0]?.condition).toContain('no second endpoint behind the first');
  });

  it('passes the recorded pair, which is what an unconfigured checkout runs', () => {
    expect(rpcProblems({})).toEqual([]);
    expect(rpcEndpoints({})).toEqual({
      primary: 'https://rpc.mainnet.chain.robinhood.com',
      fallback: 'https://robinhood.drpc.org',
    });
  });
});

describe('the explorer readers are sent to', () => {
  it('refuses an override that is not a URL, because every link would break', () => {
    const problems = configProblems({ NEXT_PUBLIC_RHC_EXPLORER: 'robinhoodchain.blockscout.com' });

    expect(problems.map((problem) => problem.variable)).toEqual(['NEXT_PUBLIC_RHC_EXPLORER']);
    expect(problems[0]?.condition).toContain('not an http or https URL');
  });

  it('takes a host that is one, so a moved explorer is a config change', () => {
    expect(configProblems({ NEXT_PUBLIC_RHC_EXPLORER: 'https://robinhoodchain.blockscout.com' })).toEqual([]);
  });
});

describe('the build runs it', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };

  it('reads the environment before it compiles anything', () => {
    expect(manifest.scripts.build).toBe('tsx scripts/preflight.ts && next build');
    expect(manifest.scripts.dev).toContain('tsx scripts/preflight.ts &&');
  });

  /**
   * Nobody takes a port they did not start, including this. The dev server was the one script
   * that could not obey it: `start` reads PORT and `dev` had 4310 written into it.
   */
  it('lets the person running it choose the port, the way start does', () => {
    expect(manifest.scripts.dev).toContain('${PORT:-4310}');
    expect(manifest.scripts.start).toContain('${PORT:-4310}');
  });
});

/**
 * The key for the paid index is the one variable in this app that must never be public. A
 * NEXT_PUBLIC_ prefix is not a naming convention in Next: it is the instruction that inlines a
 * value into every bundle the browser downloads, so the prefix and the key together are the key
 * published.
 */
describe('the index key never becomes a public variable', () => {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

  it('is documented without the prefix that would ship it to the browser', () => {
    expect(example).toContain('BLOCKSCOUT_API_KEY=');
    expect(example).not.toContain('NEXT_PUBLIC_BLOCKSCOUT');
  });

  it('says where it is read and what happens without it', () => {
    expect(example).toContain('never\n# reaches a browser');
    expect(example).toContain('402');
  });
});
