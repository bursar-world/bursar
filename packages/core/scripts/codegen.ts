/**
 * Turns the Foundry artifacts and deployment records into committed TypeScript.
 *
 * The output is checked in. Anyone who clones this repo to work on a service should not need
 * Foundry installed to typecheck an import, and a build step that shells out to `forge`
 * fails on exactly the machines least able to debug it. Run this after `forge build` or after a
 * deploy, then commit what it writes.
 *
 *   pnpm --filter @bursar/core codegen
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRetiredDeploymentRecord, selectDeploymentRecords } from '../src/deployment-record.js';
import type { DeploymentRecordFile } from '../src/deployment-record.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const artifactsDir = join(repoRoot, 'contracts', 'out');
const deploymentsDir = join(repoRoot, 'contracts', 'deployments');
const generatedDir = join(packageRoot, 'src', 'generated');

/** Keyed by the contract's name in `contracts/src`. */
const CONTRACTS = {
  MandateAccount: 'mandateAccountAbi',
  MandateAccountFactory: 'mandateAccountFactoryAbi',
  Escrow: 'escrowAbi',
  Reputation: 'reputationAbi',
  OracleRegistry: 'oracleRegistryAbi',
  AgentRegistry: 'agentRegistryAbi',
  AdminTimelock: 'adminTimelockAbi',
  AssetRegistry: 'assetRegistryAbi',
  PriceGuard: 'priceGuardAbi',
  StockSpendRouter: 'stockSpendRouterAbi',
  TreasuryPark: 'treasuryParkAbi',
  RobinhoodStockAdapter: 'parkAdapterAbi',
  CollateralVault: 'collateralVaultAbi',
  CreditPool: 'creditPoolAbi',
  CommittedMandateAccount: 'committedMandateAccountAbi',
  CommittedMandateFactory: 'committedMandateFactoryAbi',
  DisclosureRegistry: 'disclosureRegistryAbi',
  SolvencyLog: 'solvencyLogAbi',
  WithinMandateVerifier: 'withinMandateVerifierAbi',
} as const;

/**
 * The settlement-asset ABI is lifted from the local stand-in for USDG, then cut back to what the
 * live token answers. Shipping more than that invites a call that reverts for no visible
 * reason, and USDG makes that easy: it is a diamond proxy, so a selector no facet declares does
 * not revert with a name, it reverts with `FacetNotFound` (`0x800ab12c`).
 *
 * Checked against `0x5fc5…d168` on chain 4663 on 2026-09-22. Present: `decimals`, `nonces`,
 * `authorizationState`, `DOMAIN_SEPARATOR`, `paused`, `isFrozen`, `owner`. Absent: `version`,
 * `eip712Domain`, `isBlacklisted`. The version the EIP-712 domain needs is pinned in chain.ts and
 * is never read from the token.
 *
 * Two kinds of name are cut. `mint`, `setPaused` and `setFrozen` exist only so a test can put the
 * stand-in into a state; the live token has no such entry points. `version`, `eip712Domain` and
 * `isBlacklisted` are the ones a caller reaches for by habit, and they revert on chain, so the
 * stand-in declares `version` and reverts it while the shipped ABI leaves no way to call it.
 */
export const SETTLEMENT_ASSET_SOURCE = 'MockUsdg';
export const SETTLEMENT_ASSET_OMIT = new Set([
  'mint',
  'setPaused',
  'setFrozen',
  'eip712Domain',
  'EIP712DomainChanged',
  'version',
  'isBlacklisted',
]);

type AbiEntry = { type: string; name?: string };
type Artifact = { abi?: unknown; metadata?: { compiler?: { version?: string } } };
type Build = { path: string; artifact: Artifact; solc: string | undefined };

/** Bursar's own contracts are compiled with this; `compilation_restrictions` in foundry.toml pins it. */
const SOLC = '0.8.24';

/**
 * Forge writes `<Name>.sol/<Name>.json` for a source it compiled once. A source compiled more than
 * once, like a mock imported both by the 0.8.24 tests and by the 0.8.28 shielded suite, gets a file
 * per build (`<Name>.0.8.24.json`, `<Name>.0.8.28.json`), and which build keeps the plain name
 * depends on build order. So the compiler is read from each file's metadata, and the 0.8.24 build
 * wins.
 */
function pickBuild(contract: string): Build {
  const dir = join(artifactsDir, `${contract}.sol`);
  const builds: Build[] = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((file) => file.startsWith(`${contract}.`) && file.endsWith('.json'))
    .map((file) => {
      const path = join(dir, file);
      const artifact = JSON.parse(readFileSync(path, 'utf8')) as Artifact;
      return { path, artifact, solc: artifact.metadata?.compiler?.version?.split('+')[0] };
    });

  const [only, ...rest] = builds;
  if (only && rest.length === 0) return only;
  const [preferred, ...others] = builds.filter((build) => build.solc === SOLC);
  if (preferred && others.length === 0) return preferred;

  if (builds.length === 0) {
    throw new Error(
      `No Foundry artifact for ${contract}: neither ${join(dir, `${contract}.json`)} nor ` +
        `${join(dir, `${contract}.${SOLC}.json`)} exists. Run \`forge build\` in contracts/ before generating.`,
    );
  }
  const found = builds.map((build) => `\n  ${build.path} (solc ${build.solc ?? 'unknown'})`).join('');
  throw new Error(
    `Expected exactly one solc ${SOLC} build of ${contract} among:${found}\n` +
      'Run `forge clean && forge build` in contracts/, then generate again.',
  );
}

function readArtifact(contract: string): AbiEntry[] {
  const { path, artifact } = pickBuild(contract);
  if (!Array.isArray(artifact.abi)) throw new Error(`${path} has no abi array.`);
  return artifact.abi as AbiEntry[];
}

function settlementAssetAbi(): AbiEntry[] {
  return readArtifact(SETTLEMENT_ASSET_SOURCE).filter((entry) => {
    if (entry.type === 'error') return false;
    return !(entry.name !== undefined && SETTLEMENT_ASSET_OMIT.has(entry.name));
  });
}

const header = (source: string) =>
  `// Generated by packages/core/scripts/codegen.ts from ${source}.\n` +
  `// Do not edit by hand. Regenerate with \`pnpm --filter @bursar/core codegen\`.\n\n`;

function writeAbis(): void {
  const parts: string[] = [header('contracts/out')];
  const exported: string[] = [];

  for (const [contract, constName] of Object.entries(CONTRACTS)) {
    parts.push(`export const ${constName} = ${JSON.stringify(readArtifact(contract), null, 2)} as const;\n\n`);
    exported.push(`  ${contract}: ${constName},`);
  }

  parts.push(`export const settlementAssetAbi = ${JSON.stringify(settlementAssetAbi(), null, 2)} as const;\n\n`);
  parts.push(`export const BURSAR_ABIS = {\n${exported.join('\n')}\n} as const;\n`);

  writeFileSync(join(generatedDir, 'abi.ts'), parts.join(''));
  console.log(`abi.ts: ${Object.keys(CONTRACTS).length} contracts plus the settlement asset`);
}

/**
 * The address-book module, as text.
 *
 * `never` keys an empty record. Joining an empty list would emit `export type X = ;`, which does
 * not parse, so a checkout with nothing deployed would fail to typecheck rather than build.
 */
export function renderDeploymentsModule(selected: readonly DeploymentRecordFile[]): string {
  const entries = selected.map(
    (file) => `  ${JSON.stringify(file.name)}: ${JSON.stringify(file.json, null, 2)},`,
  );
  const union = selected.length === 0 ? 'never' : selected.map((f) => JSON.stringify(f.name)).join(' | ');

  return (
    `${header('contracts/deployments')}` +
    `export type RawDeploymentName = ${union};\n\n` +
    `export const RAW_DEPLOYMENTS: Readonly<Record<RawDeploymentName, unknown>> = {\n${entries.join('\n')}\n};\n`
  );
}

function writeDeployments(): void {
  // Missing is the same as empty. Before the first deploy there is nothing here, and a generator
  // that needs its own output to already exist is no use on the day it is needed.
  const files = (existsSync(deploymentsDir) ? readdirSync(deploymentsDir) : [])
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({
      name: basename(file, '.json'),
      json: JSON.parse(readFileSync(join(deploymentsDir, file), 'utf8')) as unknown,
    }));

  const selected = selectDeploymentRecords(files);
  const skipped = files.filter((file) => !selected.includes(file)).map((file) => file.name);
  const retired = selected.filter((file) => isRetiredDeploymentRecord(file.json)).map((f) => f.name);

  writeFileSync(join(generatedDir, 'deployments.ts'), renderDeploymentsModule(selected));
  console.log(`deployments.ts: ${selected.map((file) => file.name).join(', ') || 'nothing deployed yet'}`);
  if (retired.length > 0) {
    console.log(`  retired, kept as history and never resolved by chain: ${retired.join(', ')}`);
  }
  if (skipped.length > 0) {
    console.log(`  skipped, not the BURSAR contract set: ${skipped.join(', ')}`);
  }
}

// Importing this module has to be free of side effects, because the tests that cover the rules
// above would otherwise rewrite the checked-in output as they ran.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeAbis();
  writeDeployments();
}
