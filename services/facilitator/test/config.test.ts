import { describe, expect, it } from 'vitest';
import { EnvError, RHC_MAINNET, collateralDeployment, isBursarError } from '@bursar/core';
import { describeConfig, loadConfig } from '../src/config.js';
import { isLaneMode } from '../src/lanes/types.js';

const RELAYER_KEY = `0x${'11'.repeat(32)}`;
/** The address that key signs for. Derived once, asserted below so a change cannot slip through. */
const RELAYER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';

const base: Record<string, string> = {
  DATABASE_URL: 'postgres://mandate:secret@127.0.0.1:5432/mandate',
  RHC_RPC_PRIMARY: 'https://rpc.mainnet.chain.robinhood.com',
  RHC_RPC_FALLBACK: 'https://robinhood.drpc.org',
  FACILITATOR_GAS_FLOAT: RELAYER,
  FACILITATOR_SETTLEMENT: '0x2222222222222222222222222222222222222222',
  FACILITATOR_COLLATERAL: '0x3333333333333333333333333333333333333333',
  FACILITATOR_TREASURY: '0x4444444444444444444444444444444444444444',
  FACILITATOR_RELAYER_KEY: RELAYER_KEY,
  FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.005',
  FACILITATOR_FEE_BPS: '100',
  FACILITATOR_FEE_FLOOR_MICRO: '1900',
};

const env = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...base,
  ...overrides,
});

function refusalOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (isBursarError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the configuration to be refused');
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isBursarError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the configuration to be refused');
}

describe('configuration', () => {
  it('loads a complete environment', () => {
    const config = loadConfig(env());
    expect(config.network).toBe('eip155:4663');
    expect(config.settlementAsset).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(config.feeFloorMicro).toBe(1_900n);
    expect(config.funding.gasFloat).toBe(RELAYER);
    expect(config.reservationTtlMs).toBe(120_000);
  });

  it('collects every missing variable in one refusal', () => {
    try {
      loadConfig({});
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const names = (error as EnvError).problems.map((problem) => problem.name);
      expect(names).toContain('DATABASE_URL');
      expect(names).toContain('FACILITATOR_FEE_FLOOR_MICRO');
      expect(names.length).toBeGreaterThan(5);
    }
  });

  it('refuses a gas float that shares an address with settlement', () => {
    expect(codeOf(() => loadConfig(env({ FACILITATOR_SETTLEMENT: RELAYER })))).toBe('funding_collision');
  });

  it('refuses a gas float that shares an address with collateral', () => {
    expect(
      codeOf(() =>
        loadConfig(env({ FACILITATOR_COLLATERAL: '0x2222222222222222222222222222222222222222' })),
      ),
    ).toBe('funding_collision');
  });

  it('refuses a relayer key that signs for anything but the gas float', () => {
    expect(
      codeOf(() => loadConfig(env({ FACILITATOR_GAS_FLOAT: '0x5555555555555555555555555555555555555555' }))),
    ).toBe('relayer_is_not_gas_float');
  });

  it('refuses a key that is not a key', () => {
    expect(codeOf(() => loadConfig(env({ FACILITATOR_RELAYER_KEY: `0x${'00'.repeat(32)}` })))).toBe(
      'relayer_key_invalid',
    );
  });

  it('requires a token once the listener leaves loopback', () => {
    expect(codeOf(() => loadConfig(env({ FACILITATOR_HOST: '0.0.0.0' })))).toBe(
      'facilitator_token_required',
    );
    expect(
      loadConfig(env({ FACILITATOR_HOST: '0.0.0.0', FACILITATOR_AUTH_TOKEN: 'x'.repeat(32) })).authToken,
    ).toHaveLength(32);
  });

  it('runs without a token on loopback', () => {
    expect(loadConfig(env({ FACILITATOR_HOST: '127.0.0.1' })).authToken).toBeNull();
  });

  it('refuses a fee floor of zero, because a settled call is not free', () => {
    expect(codeOf(() => loadConfig(env({ FACILITATOR_FEE_FLOOR_MICRO: '0' })))).toBe('fee_floor_invalid');
  });

  it('refuses a sink token with nowhere to send it', () => {
    expect(codeOf(() => loadConfig(env({ TRUST_SINK_TOKEN: 'y'.repeat(32) })))).toBe(
      'trust_sink_token_without_url',
    );
  });

  it('refuses money amounts that are not atomic units', () => {
    expect(() => loadConfig(env({ FACILITATOR_FEE_FLOOR_MICRO: '0.0019' }))).toThrow(EnvError);
  });

  it('needs a second RPC provider, so one bad endpoint is not the whole chain', () => {
    // An unset fallback resolves to the keyless second provider, so the failure mode worth
    // catching is two names pointing at one host: same rate limit, same outage, no second opinion.
    expect(codeOf(() => loadConfig(env({ RHC_RPC_FALLBACK: base['RHC_RPC_PRIMARY'] })))).toBe(
      'rpc_single_provider',
    );

    const providers = loadConfig(env({ RHC_RPC_FALLBACK: undefined })).rpcProviders;
    expect(providers.map((provider) => provider.name)).toEqual(['primary', 'fallback']);
    expect(new Set(providers.map((provider) => new URL(provider.url).host)).size).toBe(2);
  });

  it('advertises exactly the lanes a request may name', () => {
    const described = describeConfig(loadConfig(env()));

    // `/config` is the only place a caller learns what a lane can be, so a lane it lists and a
    // lane `isLaneMode` accepts are the same set or the service refuses what it advertises.
    const advertised = described['lanes'] as readonly string[];
    expect([...advertised].sort()).toEqual(['collateral', 'direct', 'prefund']);
    for (const lane of advertised) expect(isLaneMode(lane)).toBe(true);
  });

  it('names a migration mode, and applies on start unless told otherwise', () => {
    expect(loadConfig(env()).migrate).toBe('on-start');
    expect(loadConfig(env({ FACILITATOR_MIGRATE: 'verify' })).migrate).toBe('verify');
    expect(loadConfig(env({ FACILITATOR_MIGRATE: 'off' })).migrate).toBe('off');
    expect(codeOf(() => loadConfig(env({ FACILITATOR_MIGRATE: 'sometimes' })))).toBe('env_invalid');
  });

  it('never prints the relayer key, however it was mistyped', () => {
    // `loadEnv` echoes the value it could not parse for every variable not declared secret, and
    // pasting the key without its `0x` is exactly that failure.
    const refusal = refusalOf(() => loadConfig(env({ FACILITATOR_RELAYER_KEY: '11'.repeat(32) })));
    expect(refusal.code).toBe('env_invalid');
    expect(refusal.message).toContain('FACILITATOR_RELAYER_KEY');
    expect(refusal.message).not.toContain('11'.repeat(32));
  });

  it('refuses a fee that would leave the merchant nothing', () => {
    // The ledger refuses a settlement the merchant nets nothing from, and it refuses it after the
    // transfer is on chain. Catching the rate here is the difference between a startup failure and
    // a deployment that broadcasts every payment and then declines to record it.
    expect(codeOf(() => loadConfig(env({ FACILITATOR_FEE_BPS: '10000' })))).toBe('fee_takes_the_whole_payment');
    expect(loadConfig(env({ FACILITATOR_FEE_BPS: '9999' })).feeBps).toBe(9_999);
  });

  it('refuses a settlement ceiling that would refuse every payment', () => {
    // Zero is not "no cap". The budget refuses at the limit, so a zero on either one takes the
    // deployment down while health, readiness and every probe stay green.
    expect(codeOf(() => loadConfig(env({ FACILITATOR_DAILY_SETTLEMENTS: '0' })))).toBe('env_invalid');
    expect(codeOf(() => loadConfig(env({ FACILITATOR_PER_PAYER_HOURLY: '0' })))).toBe('env_invalid');
    expect(loadConfig(env({ FACILITATOR_DAILY_SETTLEMENTS: '1' })).dailySettlements).toBe(1);
  });

  it('describes itself without leaking a secret', () => {
    const described = describeConfig(loadConfig(env()));
    const text = JSON.stringify(described);
    expect(text).not.toContain(RELAYER_KEY);
    expect(text).not.toContain('secret');
    expect(described).toMatchObject({ network: 'eip155:4663', feeBps: 100 });
    // Marketing copy has no reader on this route; nothing in the console, SDK or MCP server asks.
    expect(described).not.toHaveProperty('heroLane');
    expect(described).not.toHaveProperty('brand');
  });

  it('reads the fee rebate from the staking pool the deployment record names, and says which', () => {
    const pool = collateralDeployment(RHC_MAINNET.chainId)?.Staking;
    expect(pool).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const config = loadConfig(env());
    expect(config.stakingPool).toBe(pool);
    expect(describeConfig(config)).toMatchObject({ stakingPool: pool });
  });

  it('refuses the testnet, naming the variable that chose it', () => {
    // 46630 carries no USDG contract, so a facilitator pointed at it comes up healthy and refuses
    // every payment at the last step, where the message reads like a signature problem.
    const refusal = refusalOf(() => loadConfig(env({ RHC_NETWORK: 'testnet' })));

    expect(refusal.code).toBe('rhc_testnet_no_settlement_asset');
    expect(refusal.message).toContain('RHC_NETWORK');
    expect(refusal.message).toContain('USDG is not deployed');
  });

  it('defaults to the one network that can settle', () => {
    expect(loadConfig(env()).chain.chainId).toBe(4663);
  });

  it('takes the gas float reserve in ETH, because gas is ETH and settlement is USDG', () => {
    // Held as wei, written as ETH. Read as micro-USD, 0.005 ETH would be five thousand dollars,
    // which is how a reserve set in the wrong unit passes every check and then never fires.
    expect(loadConfig(env()).gasFloatMinimumWei).toBe(5_000_000_000_000_000n);
    expect(loadConfig(env({ FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '0.004' })).gasFloatMinimumWei).toBe(
      4_000_000_000_000_000n,
    );
    expect(codeOf(() => loadConfig(env({ FACILITATOR_GAS_FLOAT_MINIMUM_ETH: 'plenty' })))).toBe('env_invalid');
  });

  it('refuses a reserve written in wei, which the ETH pattern would otherwise accept', () => {
    // 0.004 ETH written as wei parses as four quadrillion ETH. Nothing downstream can tell that
    // from an operator who meant it, so /healthz sits at degraded from startup and never says why.
    const refusal = refusalOf(() =>
      loadConfig(env({ FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '4000000000000000' })),
    );

    expect(refusal.code).toBe('gas_float_minimum_implausible');
    expect(refusal.message).toContain('read as ETH, not as wei');
    expect(loadConfig(env({ FACILITATOR_GAS_FLOAT_MINIMUM_ETH: '999' })).gasFloatMinimumWei).toBe(
      999n * 10n ** 18n,
    );
  });

  it('will not read a reserve written for the old unit', () => {
    // The variable changed asset, not just scale, so it changed name. An operator who carries the
    // old one forward gets a missing variable, not 5,000,000 micro-USD silently read as ETH.
    const refusal = refusalOf(() =>
      loadConfig(env({ FACILITATOR_GAS_FLOAT_MINIMUM_ETH: undefined, FACILITATOR_GAS_FLOAT_MINIMUM: '5000000' })),
    );

    expect(refusal.code).toBe('env_invalid');
    expect(refusal.message).toContain('FACILITATOR_GAS_FLOAT_MINIMUM_ETH');
  });

  it('refuses two funding roles at one address without giving a reason that is not true here', () => {
    const refusal = refusalOf(() => loadConfig(env({ FACILITATOR_SETTLEMENT: RELAYER })));

    expect(refusal.code).toBe('funding_collision');
    expect(refusal.message).toContain('gasFloat and settlement');
    expect(refusal.message).toContain(RELAYER);
    // Gas is ETH and settlement is USDG. Neither balance can spend the other, so a refusal that
    // said so would be telling an operator to fix a problem they do not have.
    expect(refusal.message.toLowerCase()).not.toContain('usdc');
    expect(refusal.message.toLowerCase()).not.toContain('gas budget');
  });

  it('runs without an index key, and never echoes one it is given', () => {
    expect(describeConfig(loadConfig(env()))['index']).toBe('unkeyed');

    const keyed = loadConfig(env({ BLOCKSCOUT_API_KEY: 'index-key-value' }));
    expect(keyed.indexKey).toBe('index-key-value');
    expect(JSON.stringify(describeConfig(keyed))).not.toContain('index-key-value');
    expect(describeConfig(keyed)['index']).toBe('keyed');
  });
});
