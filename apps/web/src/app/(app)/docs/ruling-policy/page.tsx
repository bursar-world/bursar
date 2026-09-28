import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Metadata } from 'next';

import { Card, Section } from '@/components/layout';

import { Inline, Markdown, parseMarkdown } from './markdown';

export const metadata: Metadata = {
  title: 'Ruling policy · BURSAR',
  description: 'How disputed payments are ruled on: who rules, the rules they apply, the evidence that counts and when each step happens.',
};

/** Built once from the repository's copy, so the page and the file cannot drift apart. */
export const dynamic = 'force-static';

const SOURCE = join(process.cwd(), '..', '..', 'docs', 'RULING-POLICY.md');

export default function RulingPolicyPage() {
  const blocks = parseMarkdown(readFileSync(SOURCE, 'utf8'));
  const first = blocks[0];
  const intro = blocks[1];

  return (
    <Section title={first?.kind === 'heading' ? first.text : 'Ruling policy'} description={intro?.kind === 'paragraph' ? <Inline text={intro.text} /> : undefined}>
      <Card>
        <div className="space-y-4">
          <Markdown blocks={blocks.slice(2)} />
        </div>
      </Card>
    </Section>
  );
}
