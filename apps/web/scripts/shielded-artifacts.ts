import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shielded page proves in the browser with the official Privacy Pools artifacts. They live once,
 * in circuits/privacy-pools, pinned by sha256 in its manifest; the build copies the four the browser
 * needs into public/shielded and refuses to go on if any of them differs from the manifest.
 */
export const SHIELDED_FILES = ['withdraw.wasm', 'withdraw.zkey', 'commitment.wasm', 'commitment.zkey'] as const;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function copyShieldedArtifacts(source: string, target: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { sha256: Record<string, string> };
  mkdirSync(target, { recursive: true });
  const copied: string[] = [];
  for (const file of SHIELDED_FILES) {
    const expected = manifest.sha256[file];
    if (expected === undefined) throw new Error(`circuits/privacy-pools/manifest.json has no hash for ${file}.`);
    const from = join(source, 'build', file);
    if (sha256(from) !== expected) throw new Error(`${from} does not match its hash in the manifest.`);
    const to = join(target, file);
    if (existsSync(to) && sha256(to) === expected) continue;
    copyFileSync(from, to);
    copied.push(file);
  }
  return copied;
}
