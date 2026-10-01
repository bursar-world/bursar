import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '@/app/(app)/docs/ruling-policy/markdown';

const SOURCE = readFileSync(fileURLToPath(new URL('../../../docs/RULING-POLICY.md', import.meta.url)), 'utf8');

describe('the published ruling policy', () => {
  const blocks = parseMarkdown(SOURCE);

  const SECTIONS = ['Who rules', 'What a ruling decides', 'When no ruling is reached', 'The rules', 'Evidence', 'Overrides', 'Timeline', 'Publication', 'Changes'];

  it('parses into the sections the page shows', () => {
    const headings = blocks.flatMap((block) => (block.kind === 'heading' && block.level < 3 ? [block.text] : []));
    expect(headings).toEqual(['Ruling policy', ...SECTIONS, 'Version 2', 'Version 1']);
  });

  it('says which version is in force and keeps the ones before it whole at the end', () => {
    expect(SOURCE).toContain('Version 3, in force from 1 October 2026.');

    const start = (title: string) => blocks.findIndex((block) => block.kind === 'heading' && block.level === 2 && block.text === title);
    const archives = [
      { blocks: blocks.slice(start('Version 2'), start('Version 1')), opens: 'Version 2, in force from 30 September 2026.' },
      { blocks: blocks.slice(start('Version 1')), opens: 'Version 1. It applies to disputes' },
    ];
    for (const archive of archives) {
      const sections = archive.blocks.flatMap((block) => (block.kind === 'heading' && block.level === 3 ? [block.text] : []));
      expect(sections).toEqual(SECTIONS);
      expect(archive.blocks.some((block) => block.kind === 'paragraph' && block.text.startsWith(archive.opens))).toBe(true);
    }
  });

  it('takes the score off P1 and says what decides instead', () => {
    const current = SOURCE.slice(0, SOURCE.indexOf('## Version 2')).replace(/\s+/g, ' ');
    expect(current).toMatch(/\| P1 \|[^|]*\| None\./);
    expect(current).toContain('ruled on the delivery evidence alone');
    expect(current).toContain('Version 3 from 00:00 UTC on 1 October 2026, and Version 2 before that');
  });

  it('keeps every table row as wide as its header', () => {
    for (const block of blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) expect(row).toHaveLength(block.head.length);
    }
  });

  it('names all three resolvers as operated by Bursar', () => {
    expect(SOURCE).toContain('All three bonded resolvers on every registry are operated by Bursar');
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
