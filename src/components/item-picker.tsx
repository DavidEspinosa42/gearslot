"use client";

import type { ResourceDto } from "@/lib/client/api";

interface Props {
  readonly resources: readonly ResourceDto[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

/**
 * Items grouped by category. Tapping one is the first of the three taps. On a phone the groups sit
 * in one horizontally scrolling row so the timeline stays in view; on wider screens they stack.
 */
export function ItemPicker({ resources, selectedId, onSelect }: Props) {
  const groups = new Map<string, ResourceDto[]>();
  for (const item of resources) {
    const list = groups.get(item.categoryName) ?? [];
    list.push(item);
    groups.set(item.categoryName, list);
  }

  return (
    <nav
      aria-label="Equipment"
      className="-mx-4 flex snap-x gap-5 overflow-x-auto px-4 pb-1 md:mx-0 md:snap-none md:flex-col md:gap-3 md:overflow-visible md:px-0"
    >
      {[...groups].map(([category, items]) => (
        <section
          key={category}
          aria-label={category}
          className="flex shrink-0 snap-start flex-col gap-1.5 md:shrink"
        >
          <h2 className="m-0 text-sm font-semibold text-ink-soft">{category}</h2>
          <ul className="m-0 flex list-none gap-2 p-0 md:flex-wrap">
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect(item.id)}
                    className={`min-h-11 whitespace-nowrap rounded-md border px-3.5 text-base ${
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
