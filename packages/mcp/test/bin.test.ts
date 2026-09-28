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
   * command is never on PATH: the configuration the documentation prints stops working before it
   * is ever tried.
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

  it('runs the built server and says so plainly when there is no build to run', async () => {
    const [target] = Object.values((await manifest()).bin ?? {});
    const source = await readFile(fileURLToPath(new URL(target ?? '', root)), 'utf8');

    expect(source).toContain('#!/usr/bin/env node');
    expect(source).toContain('../dist/cli.js');
    expect(source).toMatch(/has not been built/u);
  });
});
