import { cpSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** A Worker name Cloudflare accepts: lowercase, digits and dashes. */
export function workerName(directory: string): string {
  const slug = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'bursar-provider' : slug;
}

export function scaffold(template: string, target: string): { readonly name: string; readonly files: readonly string[] } {
  if (!existsSync(template)) throw new Error(`The template is missing at ${template}.`);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} exists and is not empty.`);

  cpSync(template, target, { recursive: true });
  const ignore = join(target, '_gitignore');
  if (existsSync(ignore)) renameSync(ignore, join(target, '.gitignore'));

  const name = workerName(target);
  const manifestPath = join(target, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['name'] = name;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const wranglerPath = join(target, 'wrangler.toml');
  writeFileSync(wranglerPath, readFileSync(wranglerPath, 'utf8').replace(/^name = ".*"$/m, `name = "${name}"`));

  return { name, files: readdirSync(target, { recursive: true }).map(String).filter((file) => !file.includes('node_modules')).sort() };
}
