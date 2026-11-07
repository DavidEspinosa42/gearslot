"use client";

import { MS_PER_DAY, overlaps } from "@/lib/booking/interval";
import type { Block } from "@/lib/booking/timeline";
import { localDayWindow } from "@/lib/booking/zone";
import { formatDay } from "@/lib/client/format";

interface Props {
  readonly dayKeys: readonly string[];
  readonly activeKey: string;
  readonly blocks: readonly Block[];
  readonly timezone: string;
  readonly now: number;
  readonly horizonDays: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onSelect: (key: string) => void;
  readonly onShift: (direction: -1 | 1) => void;
}

/** One week of days; the bar under each day shows how much of it is already taken. */
export function WeekStrip(props: Props) {
  const { dayKeys, activeKey, blocks, timezone, now, horizonDays, onSelect, onShift } = props;
  const last = now + horizonDays * MS_PER_DAY;

  return (
    <div className="flex items-stretch gap-1.5">
      <button
        type="button"
        aria-label="Previous week"
        disabled={!props.canGoBack}
        onClick={() => onShift(-1)}
        className="min-h-11 w-9 shrink-0 rounded-md border border-line bg-card text-lg disabled:opacity-30"
      >
        ‹
      </button>
      <ul className="m-0 grid min-w-0 flex-1 list-none grid-cols-7 gap-1 p-0">
        {dayKeys.map((key) => {
          const day = localDayWindow(key, timezone);
          const closed = day.start > last || day.end <= now - MS_PER_DAY;
          const taken = blocks
            .filter((b) => overlaps(day, b))
            .reduce((sum, b) => sum + Math.min(b.end, day.end) - Math.max(b.start, day.start), 0);
          const share = Math.min(1, taken / (day.end - day.start));
          const active = key === activeKey;
          const [weekday = "", dayNumber = ""] = formatDay(day.start, timezone).split(" ");
          return (
            <li key={key} className="min-w-0">
              <button
                type="button"
                disabled={closed}
                aria-pressed={active}
                aria-label={`${formatDay(day.start, timezone)}, ${Math.round(share * 100)}% taken`}
                onClick={() => onSelect(key)}
                className={`flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-md border px-0.5 ${
                  active
                    ? "border-action bg-action text-action-ink"
                    : "border-line bg-card text-ink"
                } disabled:opacity-30`}
              >
                <span className="text-xs leading-none">{weekday}</span>
                <span className="text-lg font-semibold leading-none">{dayNumber}</span>
                <DayLoad share={share} active={active} />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        aria-label="Next week"
        disabled={!props.canGoForward}
        onClick={() => onShift(1)}
        className="min-h-11 w-9 shrink-0 rounded-md border border-line bg-card text-lg disabled:opacity-30"
      >
        ›
      </button>
    </div>
  );
}

function DayLoad({ share, active }: { share: number; active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`block h-1.5 w-[70%] overflow-hidden rounded-full ${active ? "bg-action-ink/30" : "bg-line"}`}
    >
      <span
        className={`block h-full ${active ? "bg-action-ink" : "bg-tape"}`}
        style={{ width: `${Math.max(share > 0 ? 8 : 0, share * 100)}%` }}
      />
    </span>
  );
}
