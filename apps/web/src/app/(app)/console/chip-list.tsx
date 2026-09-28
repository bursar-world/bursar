'use client';

/** A removable list of short values, as the create form and the workspace drafts show them. */
export function ChipList({
  items,
  onRemove,
  empty,
  disabled = false,
}: {
  readonly items: readonly { readonly key: string; readonly label: string }[];
  readonly onRemove: (key: string) => void;
  readonly empty: string;
  readonly disabled?: boolean;
}) {
  if (items.length === 0) return <p className="text-detail text-[color:var(--color-muted)]">{empty}</p>;

  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.key} className="inline-flex items-center gap-2 border border-[color:var(--color-line)] bg-surface px-3 py-1 text-detail">
          <span className="tabular">{item.label}</span>
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            disabled={disabled}
            aria-label={`Remove ${item.label}`}
            className="text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)] focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[color:var(--color-ring)]"
          >
            &times;
          </button>
        </li>
      ))}
    </ul>
  );
}
