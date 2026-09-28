import type { ReactNode } from 'react';

/**
 * The few shapes docs/RULING-POLICY.md is written in, and nothing more: headings, paragraphs,
 * bullet lists, tables, fenced code and inline code. The policy is published from that one file so
 * the console and the repository can never say two different things, and a general Markdown
 * library would be a dependency carried for a page this plain.
 */
export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'code'; readonly text: string };

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) body.push(lines[index++] ?? '');
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,2})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1] === '#' ? 1 : 2, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const head = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) rows.push(cells(lines[index++] ?? ''));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('- ')) {
        let item = (lines[index++] ?? '').slice(2);
        while (index < lines.length && /^\s{2,}\S/.test(lines[index] ?? '')) item += ` ${(lines[index++] ?? '').trim()}`;
        items.push(item);
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    const text: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim() === '' || next.startsWith('#') || next.startsWith('|') || next.startsWith('- ') || next.startsWith('```')) break;
      text.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: text.join(' ') });
  }

  return blocks;
}

/** Backticks become code. Nothing else inline is interpreted. */
export function Inline({ text }: { readonly text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          <code key={index} className="break-all font-mono text-note">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function Markdown({ blocks }: { readonly blocks: readonly Block[] }): ReactNode {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'heading':
        return block.level === 1 ? null : (
          <h2 key={index} className="pt-4 text-lg font-medium">
            <Inline text={block.text} />
          </h2>
        );
      case 'paragraph':
        return (
          <p key={index} className="max-w-3xl text-sm">
            <Inline text={block.text} />
          </p>
        );
      case 'list':
        return (
          <ul key={index} className="max-w-3xl list-disc space-y-1 pl-5 text-sm">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        );
      case 'code':
        return (
          <pre key={index} className="overflow-x-auto border border-[color:var(--color-line)] bg-surface px-4 py-3 font-mono text-note">
            {block.text}
          </pre>
        );
      case 'table':
        return (
          <div key={index} className="max-w-3xl overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={cellIndex} className="border-b border-[color:var(--color-line-strong)] py-2 pr-4 text-left text-label uppercase tracking-wide text-[color:var(--color-muted)]">
                      <Inline text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border-b border-[color:var(--color-line)] py-2 pr-4 align-top">
                        <Inline text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}
