import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '@/app/(app)/docs/ruling-policy/markdown';

const SOURCE = readFileSync(fileURLToPath(new URL('../../../docs/RULING-POLICY.md', import.meta.url)), 'utf8');

describe('the published ruling policy', () => {
  const blocks = parseMarkdown(SOURCE);

  it('parses into the sections the page shows', () => {
    const headings = blocks.filter((block) => block.kind === 'heading').map((block) => block.text);
    expect(headings).toEqual(['Ruling policy', 'Who rules', 'What a ruling decides', 'When no ruling is reached', 'The rules', 'Evidence', 'Overrides', 'Timeline', 'Publication', 'Changes']);
  });

  it('keeps every table row as wide as its header', () => {
    for (const block of blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) expect(row).toHaveLength(block.head.length);
    }
  });

  it('names all three resolvers as operated by Bursar', () => {
    expect(SOURCE).toContain('All three bonded resolvers on both registries are operated by Bursar');
    for (const address of ['0xD8D90e4c8f3419B1b8305dF2905eb31d3fBBf599', '0xC284CdA6c6982447f202830f4e969F13cBcB0b94', '0x7062A480732EC7B0F00a3D0c968356e1671dd356']) {
      expect(SOURCE).toContain(address);
    }
  });

  it('lists every rule the service can publish', () => {
    for (const rule of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) expect(SOURCE).toContain(`| ${rule} |`);
  });

  it('carries no em dashes', () => {
    expect(SOURCE).not.toContain('—');
  });
});
