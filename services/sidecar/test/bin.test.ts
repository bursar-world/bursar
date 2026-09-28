import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type Manifest = { bin?: Record<string, string>; files?: string[] };

const root = new URL('../', import.meta.url);

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as Manifest;
}

describe('the command this package installs', () => {
  /**
   * A package manager links every `bin` entry while it installs, which is before the build has
   * run. A target inside `dist/` does not exist yet, so the link is skipped with a warning and the
   * command is never on PATH: the run command in the README stops working before it is ever tried.
   */
  it('points at a file that exists before anything is built', async () => {
    const entries = Object.entries((await manifest()).bin ?? {});

    expect(entries).not.toHaveLength(0);

    for (const [name, target] of entries) {
      expect(target.startsWith('./dist/'), `${name} is linked at install time, before dist exists`).toBe(false);
      expect(existsSync(fileURLToPath(new URL(target, root))), `${name} -> ${target}`).toBe(true);
    }
  });

  it('ships the launcher alongside the build', async () => {
    expect((await manifest()).files ?? []).toContain('bin');
  });

  it('runs the built worker and says so plainly when there is no build to run', async () => {
    const [target] = Object.values((await manifest()).bin ?? {});
    const source = await readFile(fileURLToPath(new URL(target ?? '', root)), 'utf8');

    expect(source).toContain('#!/usr/bin/env node');
    expect(source).toContain('../dist/main.js');
    expect(source).toMatch(/has not been built/u);
  });
});

/**
 * The README's run command and the README's own configuration table have to agree.
 *
 * When the table called four variables required and the command set two, the documented first run
 * would not start and the refusal it printed did not say which two were missing.
 */
describe('the run command the README prints', () => {
  const readme = readFile(new URL('README.md', root), 'utf8');

  async function sections(): Promise<{ run: string; table: string }> {
    const source = await readme;
    return {
      run: source.split('## Running it')[1]?.split('## Configuration')[0] ?? '',
      table: source.split('## Configuration')[1]?.split('\n## ')[0] ?? '',
    };
  }

  it('sets every variable the configuration table calls required', async () => {
    const { run, table } = await sections();

    const required = [...table.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*required\s*\|/gmu)].map((match) => match[1]);

    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(run, `${name} is required and the run command never sets it`).toContain(`${name}=`);
    }
  });

  it('does not tell a reader to build and then run something that ignores the build', async () => {
    const { run } = await sections();

    expect(run).toContain('pnpm --filter @bursar/sidecar build');
    expect(run).toMatch(/^bursar-sidecar$/mu);
  });
});
