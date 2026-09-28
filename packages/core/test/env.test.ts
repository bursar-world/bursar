import { describe, expect, it } from 'vitest';
import { EnvError, envVar, loadEnv, optional, withDefault } from '../src/env.js';
import { BursarError } from '../src/errors.js';

describe('loadEnv', () => {
  it('parses every declared variable into its own type', () => {
    const config = loadEnv(
      {
        RHC_RPC_PRIMARY: envVar.url(),
        FACILITATOR_FEE_BPS: envVar.bps(),
        SETTLEMENT_ADDRESS: envVar.address(),
        MAX_MANDATE: envVar.micro(),
        MAX_CONCURRENCY: envVar.int({ min: 1, max: 64 }),
        WINDOW_SECONDS: envVar.seconds({ max: 86_400 }),
        DEBUG_TRACE: envVar.boolean(),
        LANE: envVar.oneOf(['prefund', 'collateral']),
        RESOLVERS: envVar.list(),
        MIN_BOND: envVar.bigint({ min: 0n }),
      },
      {
        RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
        FACILITATOR_FEE_BPS: '100',
        SETTLEMENT_ADDRESS: '0x3600000000000000000000000000000000000000',
        MAX_MANDATE: '500000000',
        MAX_CONCURRENCY: '8',
        WINDOW_SECONDS: '86400',
        DEBUG_TRACE: 'false',
        LANE: 'prefund',
        RESOLVERS: 'a, b ,c',
        MIN_BOND: '1000000',
      },
    );

    expect(config.RHC_RPC_PRIMARY).toBe('https://rpc.mainnet.chain.robinhood.com/');
    expect(config.FACILITATOR_FEE_BPS).toBe(100);
    expect(config.MAX_MANDATE).toBe(500_000_000n);
    expect(config.MAX_CONCURRENCY).toBe(8);
    expect(config.DEBUG_TRACE).toBe(false);
    expect(config.LANE).toBe('prefund');
    expect(config.RESOLVERS).toEqual(['a', 'b', 'c']);
    expect(config.MIN_BOND).toBe(1_000_000n);
  });

  it('reports every problem at once instead of one restart per mistake', () => {
    const error = (() => {
      try {
        loadEnv(
          {
            RHC_RPC_PRIMARY: envVar.url(),
            RHC_RPC_FALLBACK: envVar.url(),
            FACILITATOR_FEE_BPS: envVar.bps(),
            TREASURY: envVar.address(),
          },
          { FACILITATOR_FEE_BPS: '20000', TREASURY: '0xnope' },
        );
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(EnvError);
    const problems = (error as EnvError).problems;
    expect(problems.map((p) => p.name)).toEqual([
      'RHC_RPC_PRIMARY',
      'RHC_RPC_FALLBACK',
      'FACILITATOR_FEE_BPS',
      'TREASURY',
    ]);
    expect(problems[0]?.reason).toBe('is not set');
    expect(problems[2]?.reason).toContain('above 10000');
    expect((error as EnvError).message).toContain('TREASURY');
  });

  it('treats an empty string as unset, which is what container tooling writes', () => {
    expect(() => loadEnv({ TREASURY: envVar.address() }, { TREASURY: '   ' })).toThrow(/is not set/);
    expect(loadEnv({ LOG_LEVEL: withDefault(envVar.oneOf(['info', 'debug']), 'info') }, { LOG_LEVEL: '' })).toEqual({
      LOG_LEVEL: 'info',
    });
  });

  it('applies a default only where one is declared', () => {
    const config = loadEnv(
      {
        LOG_LEVEL: withDefault(envVar.oneOf(['info', 'debug']), 'info'),
        DATABASE_URL: optional(envVar.url()),
        PORT: withDefault(envVar.int({ min: 1, max: 65_535 }), 8080),
      },
      {},
    );

    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DATABASE_URL).toBeUndefined();
    expect(config.PORT).toBe(8080);
  });

  it('refuses a default on anything that controls money', () => {
    expect(() => withDefault(envVar.micro(), 1_000_000n as never)).toThrow(BursarError);
    expect(() => withDefault(envVar.bps(), 100)).toThrow(/cannot have a default/);
    expect(() => withDefault(envVar.address(), '0x0000000000000000000000000000000000000000')).toThrow(
      /cannot have a default/,
    );
    expect(() => withDefault(envVar.int({ money: true }), 1)).toThrow(/cannot have a default/);
  });

  it('keeps a secret out of the error message and shows a plain value', () => {
    const secretError = (() => {
      try {
        loadEnv({ RHC_RPC_PRIMARY: envVar.url() }, { RHC_RPC_PRIMARY: 'ftp://rpc.example/key-abc123' });
        return null;
      } catch (e: unknown) {
        return e as EnvError;
      }
    })();
    expect(secretError?.message).not.toContain('key-abc123');

    const plainError = (() => {
      try {
        loadEnv({ MAX_CONCURRENCY: envVar.int({ min: 1 }) }, { MAX_CONCURRENCY: '0' });
        return null;
      } catch (e: unknown) {
        return e as EnvError;
      }
    })();
    expect(plainError?.message).toContain('value: 0');
  });

  it('names what was expected once, not again after a reason that already says it', () => {
    const error = (() => {
      try {
        loadEnv({ MANDATE_ACCOUNT: envVar.address(), PORT: envVar.int({ min: 1 }) }, { MANDATE_ACCOUNT: '0xbad', PORT: 'x' });
        return null;
      } catch (e: unknown) {
        return e as EnvError;
      }
    })();

    expect(error?.message).toContain('MANDATE_ACCOUNT: is not a 20-byte hex address (value: 0xbad)\n');
    expect(error?.message.match(/20-byte hex address/gu)).toHaveLength(1);
    expect(error?.message).toContain('PORT: is not an integer (value: x) (expected an integer between 1 and');
  });

  it('rejects amounts written as decimals, because the unit is atomic micro-USD', () => {
    expect(() => loadEnv({ CEILING: envVar.micro() }, { CEILING: '1.50' })).toThrow(EnvError);
    expect(loadEnv({ CEILING: envVar.micro({ min: 0n as never }) }, { CEILING: '1500000' })).toEqual({
      CEILING: 1_500_000n,
    });
  });

  it('enforces range bounds', () => {
    expect(() => loadEnv({ N: envVar.int({ min: 1, max: 4 }) }, { N: '5' })).toThrow(/outside 1..4/);
    expect(() => loadEnv({ B: envVar.bigint({ max: 10n }) }, { B: '11' })).toThrow(/above 10/);
    expect(() => loadEnv({ S: envVar.string({ minLength: 3 }) }, { S: 'ab' })).toThrow(/shorter than 3/);
    expect(() => loadEnv({ L: envVar.list({ minLength: 2 }) }, { L: 'only' })).toThrow(/fewer than 2/);
  });
});
