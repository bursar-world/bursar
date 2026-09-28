import { describe, expect, test } from 'vitest';
import { RHC_MAINNET, RHC_MAINNET_USDG_DOMAIN } from '@bursar/core';
import {
  assertAssetConsistent,
  assetDomain,
  computeDomainSeparator,
  domainFields,
  resolveAsset,
} from '../src/domain.js';
import { DomainMismatchError } from '../src/errors.js';
import { permit2Domain, PERMIT2_ADDRESS } from '../src/permit2.js';
import { USDG_ASSET, USDG_DOMAIN_SEPARATOR, USDG_NAME, fakeChain, USDG } from './support.js';

describe('the domain comes from the token', () => {
  test('the computed separator equals the one USDG reports on chain 4663', () => {
    // Read from the token on 2026-09-22. If this ever stops matching, every signature the
    // facilitator accepts is being checked against a domain the token does not use.
    expect(computeDomainSeparator(RHC_MAINNET_USDG_DOMAIN)).toBe(USDG_DOMAIN_SEPARATOR);
    expect(RHC_MAINNET_USDG_DOMAIN).toMatchObject({
      name: USDG_NAME,
      version: '1',
      chainId: 4663,
      verifyingContract: USDG,
    });
  });

  test('the name the published examples carry hashes to something else entirely', () => {
    const guessed = computeDomainSeparator({ ...RHC_MAINNET_USDG_DOMAIN, name: 'USD Coin' });
    expect(guessed).not.toBe(USDG_DOMAIN_SEPARATOR);
  });

  test('the wrong version and the wrong chain hash differently too', () => {
    expect(computeDomainSeparator({ ...RHC_MAINNET_USDG_DOMAIN, version: '2' })).not.toBe(
      USDG_DOMAIN_SEPARATOR,
    );
    expect(computeDomainSeparator({ ...RHC_MAINNET_USDG_DOMAIN, chainId: 8453 })).not.toBe(
      USDG_DOMAIN_SEPARATOR,
    );
  });

  test('dropping the version field changes the hash, so an absent version is not a blank one', () => {
    const { version: _omitted, ...withoutVersion } = RHC_MAINNET_USDG_DOMAIN;
    expect(domainFields(withoutVersion)).toHaveLength(3);
    expect(computeDomainSeparator(withoutVersion)).not.toBe(USDG_DOMAIN_SEPARATOR);
  });

  test('Permit2 omits the version, so its domain has three fields', () => {
    const domain = permit2Domain(PERMIT2_ADDRESS, RHC_MAINNET.chainId);
    expect(domain.version).toBeUndefined();
    expect(domainFields(domain)).toHaveLength(3);
    expect(domainFields(RHC_MAINNET_USDG_DOMAIN)).toHaveLength(4);
    // A version field the contract does not use changes the hash and nothing verifies.
    expect(computeDomainSeparator({ ...domain, version: '1' })).not.toBe(computeDomainSeparator(domain));
  });
});

describe('assertAssetConsistent', () => {
  test('an asset whose separator does not match its own domain is refused', () => {
    expect(() =>
      assertAssetConsistent({ ...USDG_ASSET, name: 'USD Coin' }, RHC_MAINNET.chainId),
    ).toThrow(DomainMismatchError);
  });

  test('an asset that is not six decimals has no place in the ledger', () => {
    expect(() =>
      assertAssetConsistent({ ...USDG_ASSET, decimals: 18 as unknown as 6 }, RHC_MAINNET.chainId),
    ).toThrow(/decimals/);
  });

  test('an asset with no authorisation path is a configuration error, not a refusal', () => {
    expect(() => assertAssetConsistent({ ...USDG_ASSET, methods: [] }, RHC_MAINNET.chainId)).toThrow(
      /no authorisation path/,
    );
  });

  test('the domain an asset produces is the one a payer signs under', () => {
    expect(assetDomain(USDG_ASSET, RHC_MAINNET.chainId)).toEqual(RHC_MAINNET_USDG_DOMAIN);
  });
});

describe('resolveAsset', () => {
  test('it reads the token and reports the paths it actually answers', async () => {
    const chain = fakeChain({ code: [PERMIT2_ADDRESS] });
    const asset = await resolveAsset(chain, USDG, { permit2: PERMIT2_ADDRESS });
    expect(asset).toMatchObject({
      address: USDG,
      name: USDG_NAME,
      version: '1',
      decimals: 6,
      domainSeparator: USDG_DOMAIN_SEPARATOR,
    });
    expect(asset.methods).toEqual(['eip3009', 'eip2612', 'permit2']);
  });

  test('a token that publishes no version is resolved against the separator it does publish', async () => {
    // USDG is a diamond proxy and `version()` reverts with FacetNotFound. The version that goes
    // into the domain therefore comes from this side, and the only thing that makes it safe is
    // that the assembled domain has to hash to what the token reports.
    const chain = fakeChain();
    const asset = await resolveAsset(chain, USDG);

    expect(asset.version).toBe('1');
    expect(computeDomainSeparator(assetDomain(asset, chain.chainId))).toBe(asset.domainSeparator);
  });

  test('a supplied version that does not reproduce the separator is refused, and says so', async () => {
    const chain = fakeChain();

    const failure = await resolveAsset(chain, USDG, { version: '2' }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DomainMismatchError);
    if (!(failure instanceof DomainMismatchError)) throw new Error('unreachable');
    expect(failure.attempted).toEqual({
      name: USDG_NAME,
      version: '2',
      versionPublished: false,
    });
    expect(failure.message).toContain('the token publishes no version, so that one was supplied');
    expect(failure.message).toContain('Nothing has been signed');
  });

  test('a token that does publish a version is taken at its word, and checked all the same', async () => {
    const chain = fakeChain({
      identity: { name: USDG_NAME, version: '2', decimals: 6, domainSeparator: USDG_DOMAIN_SEPARATOR },
    });

    const failure = await resolveAsset(chain, USDG, { version: '1' }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DomainMismatchError);
    if (!(failure instanceof DomainMismatchError)) throw new Error('unreachable');
    // The supplied version is not allowed to override what the token said. A token that answers
    // `version()` and then disagrees with its own separator is the wrong token, not a bad pin.
    expect(failure.attempted).toEqual({ name: USDG_NAME, version: '2', versionPublished: true });
    expect(failure.message).toContain('both read from the token');
  });

  test('permit2 is only offered where it is deployed', async () => {
    const chain = fakeChain();
    const asset = await resolveAsset(chain, USDG, { permit2: PERMIT2_ADDRESS });
    expect(asset.methods).toEqual(['eip3009', 'eip2612']);
  });

  test('a token whose separator disagrees with its own name is refused outright', async () => {
    const chain = fakeChain({
      identity: { name: USDG_NAME, version: '1', decimals: 6, domainSeparator: `0x${'22'.repeat(32)}` },
    });
    await expect(resolveAsset(chain, USDG)).rejects.toThrow(DomainMismatchError);
  });

  test('a token that answers neither interface cannot be settled against', async () => {
    const chain = fakeChain();
    const broken = {
      ...chain,
      authorizationState: async (): Promise<boolean> => {
        throw new Error('execution reverted');
      },
      permitNonce: async (): Promise<bigint> => {
        throw new Error('execution reverted');
      },
    };
    await expect(resolveAsset(broken, USDG)).rejects.toThrow(/no authorisation path/);
  });

  test('a token that is not six decimals is refused before anything else', async () => {
    const chain = fakeChain({
      identity: { name: USDG_NAME, version: '1', decimals: 18, domainSeparator: USDG_DOMAIN_SEPARATOR },
    });
    await expect(resolveAsset(chain, USDG)).rejects.toThrow(/decimals/);
  });

  test('a probe the chain did not answer fails resolution instead of dropping the path', async () => {
    // Read as "not implemented", one timeout at startup would serve without EIP-3009 until restart.
    const chain = fakeChain();
    const flaky = {
      ...chain,
      authorizationState: async (): Promise<boolean> => {
        throw new Error('the request timed out after 10000 ms');
      },
    };
    await expect(resolveAsset(flaky, USDG)).rejects.toThrow(/timed out/);
  });

  test('a Permit2 code read the chain did not answer fails resolution too', async () => {
    const chain = fakeChain({ code: [PERMIT2_ADDRESS] });
    const flaky = {
      ...chain,
      hasCode: async (): Promise<boolean> => {
        throw new Error('fetch failed');
      },
    };
    await expect(resolveAsset(flaky, USDG, { permit2: PERMIT2_ADDRESS })).rejects.toThrow(/fetch failed/);
  });

  test('a token address configured in lowercase resolves checksummed', async () => {
    const asset = await resolveAsset(fakeChain(), USDG.toLowerCase() as `0x${string}`);
    expect(asset.address).toBe(USDG);
  });
});
