"use client";

import type { ResourceDto } from "@/lib/client/api";

interface Props {
  readonly resources: readonly ResourceDto[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

/**
 * Items grouped by category. Tapping one is the first of the three taps.
 *
 * On a phone every item is a chip in one wrapping flow, in category order, so everything is on screen
 * at once with no sideways scrolling; the names say what each item is, and the category headings are
 * kept for screen readers. From the `md` breakpoint the categories stack with visible headings.
 */
export function ItemPicker({ resources, selectedId, onSelect }: Props) {
  const groups = new Map<string, ResourceDto[]>();
  for (const item of resources) {
    const list = groups.get(item.categoryName) ?? [];
    list.push(item);
    groups.set(item.categoryName, list);
  }

  return (
    <nav aria-label="Equipment" className="flex flex-wrap gap-2 md:flex-col md:gap-3">
      {[...groups].map(([category, items]) => (
        <section
          key={category}
          aria-label={category}
          className="contents md:flex md:flex-col md:gap-1.5"
        >
          <h2 className="sr-only m-0 text-sm font-semibold text-ink-soft md:not-sr-only">
            {category}
          </h2>
          <ul className="m-0 contents list-none p-0 md:flex md:flex-wrap md:gap-2">
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect(item.id)}
                    className={`min-h-11 whitespace-nowrap rounded-md border px-3 text-base ${
                      active
                        ? "border-action bg-action font-semibold text-action-ink"
                        : "border-line bg-card text-ink"
                    }`}
                  >
                    {item.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
