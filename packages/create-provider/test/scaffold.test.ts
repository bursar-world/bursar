import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { scaffold, workerName } from '../src/scaffold.js';

const TEMPLATE = fileURLToPath(new URL('../../../templates/cloudflare-worker/', import.meta.url));
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-provider-'));
  made.push(dir);
  return dir;
}

describe('scaffolding a provider worker', () => {
  it('copies the template, names the worker after the directory, and restores .gitignore', () => {
    const root = scratch();
    // The published package carries the ignore file under another name; the repository template does not.
    const template = join(root, 'template');
    mkdirSync(template);
    for (const file of ['package.json', 'wrangler.toml', 'tsconfig.json', 'README.md']) writeFileSync(join(template, file), readFileSync(join(TEMPLATE, file)));
    mkdirSync(join(template, 'src'));
    writeFileSync(join(template, 'src', 'index.ts'), readFileSync(join(TEMPLATE, 'src', 'index.ts')));
    writeFileSync(join(template, '_gitignore'), readFileSync(join(TEMPLATE, '.gitignore')));

    const target = join(root, 'My Render API');
    const result = scaffold(template, target);

    expect(result.name).toBe('my-render-api');
    expect(result.files).toEqual(['.gitignore', 'README.md', 'package.json', 'src', 'src/index.ts', 'tsconfig.json', 'wrangler.toml']);
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name).toBe('my-render-api');
    expect(readFileSync(join(target, 'wrangler.toml'), 'utf8')).toMatch(/^name = "my-render-api"$/m);
    expect(existsSync(join(target, '_gitignore'))).toBe(false);
  });

  it('refuses a directory that already has files', () => {
    const root = scratch();
    writeFileSync(join(root, 'keep.txt'), 'x');
    expect(() => scaffold(TEMPLATE, root)).toThrow(/not empty/);
  });

  it('turns a directory name into a worker name', () => {
    expect(workerName('/tmp/My_API v2')).toBe('my-api-v2');
    expect(workerName('/tmp/---')).toBe('bursar-provider');
  });
});
