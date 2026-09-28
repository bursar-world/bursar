import type { KeyboardEvent, ReactNode } from 'react';
import { EmptyState } from './layout';

export type Column<Row> = {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row, index: number) => ReactNode;
  /** Right-align a column of amounts so the digits line up. */
  readonly align?: 'left' | 'right';
  readonly width?: string;
  /** Hidden below the small breakpoint, for a column carrying supporting detail. */
  readonly secondary?: boolean;
};

export type TableProps<Row> = {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly empty?: ReactNode;
  readonly caption?: string;
  readonly onRowClick?: (row: Row) => void;
};

export function Table<Row>({ columns, rows, rowKey, empty, caption, onRowClick }: TableProps<Row>) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet." />}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-[color:var(--color-line-strong)]">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={`px-3 pb-2.5 pt-1 text-label font-normal uppercase tracking-wide text-[color:var(--color-muted)] ${
                  column.align === 'right' ? 'text-right' : 'text-left'
                } ${column.secondary ? 'hidden sm:table-cell' : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              // A clickable row is a control, and a control that only answers the mouse leaves
              // whatever is behind it out of reach of a keyboard. Space scrolls the page unless it
              // is taken.
              {...(onRowClick
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: () => onRowClick(row),
                    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onRowClick(row);
                    },
                  }
                : {})}
              className={`border-b border-[color:var(--color-line)] transition-colors last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-[color:var(--color-raised)]' : ''}`}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-3 py-3 align-top ${column.align === 'right' ? 'text-right' : 'text-left'} ${column.secondary ? 'hidden sm:table-cell' : ''}`}
                >
                  {column.cell(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
