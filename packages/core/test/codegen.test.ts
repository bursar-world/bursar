import { describe, expect, it } from 'vitest';
import { SETTLEMENT_ASSET_OMIT, renderDeploymentsModule } from '../scripts/codegen.js';
import type { DeploymentRecordFile } from '../src/deployment-record.js';

const RECORD: DeploymentRecordFile = { name: 'rhc-mainnet', json: { network: 'rhc-mainnet' } };

/**
 * The generator has to produce a module that compiles on a checkout with nothing deployed. A new
 * chain starts with an empty address book, and the workspace still has to build before its first
 * deploy lands.
 */
describe('the generated address book', () => {
  it('keys an empty record on never, so the module still parses', () => {
    const module = renderDeploymentsModule([]);

    expect(module).toContain('export type RawDeploymentName = never;');
    expect(module).toContain('export const RAW_DEPLOYMENTS: Readonly<Record<RawDeploymentName, unknown>> = {');
    expect(module).not.toContain('RawDeploymentName = ;');
  });

  it('names what it was given', () => {
    const module = renderDeploymentsModule([RECORD, { name: 'other', json: {} }]);

    expect(module).toContain('export type RawDeploymentName = "rhc-mainnet" | "other";');
    expect(module).toContain('"rhc-mainnet": {');
  });
});

/**
 * USDG routes only the selectors its facets declare, so a call to one it does not reverts with
 * `FacetNotFound` and no name. Shipping those selectors in the ABI is what turns that into a
 * revert nobody can explain, which is why they are cut at generation rather than avoided by
 * convention.
 */
describe('the settlement-asset ABI', () => {
  it('omits the selectors USDG does not answer', () => {
    expect(SETTLEMENT_ASSET_OMIT.has('version')).toBe(true);
    expect(SETTLEMENT_ASSET_OMIT.has('isBlacklisted')).toBe(true);
    expect(SETTLEMENT_ASSET_OMIT.has('eip712Domain')).toBe(true);
  });

  it('keeps the EIP-3009 surface that does answer', () => {
    for (const kept of [
      'transferWithAuthorization',
      'authorizationState',
      'DOMAIN_SEPARATOR',
      'nonces',
      'paused',
      'isFrozen',
      'owner',
    ]) {
      expect(SETTLEMENT_ASSET_OMIT.has(kept), kept).toBe(false);
    }
  });
});
