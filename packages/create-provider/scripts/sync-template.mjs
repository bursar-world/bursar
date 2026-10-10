// Copies the worker template into this package so `npm create @bursar/provider` ships it, with
// the workspace links replaced by the published versions. Runs before every build and pack.
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const here = new URL('../', import.meta.url);
const source = new URL('../../templates/cloudflare-worker/', here);
const target = new URL('template/', here);

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (path) => !/node_modules|\.wrangler|\.dev\.vars/.test(path),
});
// npm leaves .gitignore out of a published package, so it travels under another name.
renameSync(new URL('.gitignore', target), new URL('_gitignore', target));

const version = (path) => JSON.parse(readFileSync(new URL(path, here), 'utf8')).version;
const manifest = JSON.parse(readFileSync(new URL('package.json', target), 'utf8'));
manifest.dependencies['@bursar/provider-worker'] = `^${version('../provider-worker/package.json')}`;
manifest.devDependencies['@bursar/sdk'] = `^${version('../sdk/package.json')}`;
writeFileSync(new URL('package.json', target), `${JSON.stringify(manifest, null, 2)}\n`);
