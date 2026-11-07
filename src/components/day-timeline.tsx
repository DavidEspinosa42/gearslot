"use client";

import { useEffect, useRef } from "react";
import type { Interval } from "@/lib/booking/interval";
import type { BookingRules } from "@/lib/booking/rules";
import { type Block, maxBookableMinutes, slotState } from "@/lib/booking/timeline";
import { formatClock } from "@/lib/client/format";

const ROW_PX = 32;

interface Props {
  readonly slots: readonly Interval[];
  readonly blocks: readonly Block[];
  readonly now: number;
  readonly rules: BookingRules;
  readonly bufferMinutes: number;
  /** False until availability for this resource and week has arrived: unknown is not free. */
  readonly ready: boolean;
  readonly timezone: string;
  /** The range currently chosen in the confirm sheet, highlighted on the strip. */
  readonly selected: Interval | undefined;
  /** Instant the strip scrolls to when the day changes (for example 08:00 local). */
  readonly scrollTo: number;
  readonly onPick: (start: number) => void;
}

export function DayTimeline(props: Props) {
  const { slots, blocks, now, rules, bufferMinutes, timezone, selected, scrollTo, onPick, ready } =
    props;
  const scroller = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll only when the day changes
  useEffect(() => {
    const index = slots.findIndex((slot) => slot.start >= scrollTo);
    if (scroller.current !== null && index >= 0) scroller.current.scrollTop = index * ROW_PX;
  }, [slots[0]?.start]);

  return (
    <div
      ref={scroller}
      className="relative h-[58dvh] min-h-80 overflow-y-auto overscroll-contain rounded-lg border border-line bg-card"
    >
      <ul className="m-0 list-none p-0">
        {slots.map((slot) => {
          const state = slotState(slot, blocks, now, rules);
          const room =
            state === "free"
              ? maxBookableMinutes(slot.start, blocks, bufferMinutes, now, rules)
              : 0;
          const pickable = ready && room > 0;
          const onHour = formatClock(slot.start, timezone).endsWith(":00");
          const inSelection =
            selected !== undefined && slot.start >= selected.start && slot.start < selected.end;
          const label = `${formatClock(slot.start, timezone)}, ${describe(state, pickable, ready)}`;

          const tone = inSelection
            ? "bg-action text-action-ink"
            : state === "taken"
              ? "taken text-ink-soft"
              : state === "mine"
                ? "bg-mine-bg text-ink"
                : pickable
                  ? "bg-card text-ink hover:bg-paper active:bg-paper"
                  : "bg-paper text-ink-soft/60";

          return (
            <li
              key={slot.start}
              className={onHour ? "border-t border-line" : "border-t border-line/40"}
            >
              <button
                type="button"
                disabled={!pickable}
                aria-label={label}
                aria-pressed={inSelection}
                onClick={() => onPick(slot.start)}
                style={{ height: ROW_PX }}
                className={`flex w-full items-center gap-3 px-3 text-left text-sm disabled:cursor-not-allowed ${tone}`}
              >
                <span
                  className={`w-12 shrink-0 ${onHour ? "font-semibold" : "text-xs opacity-60"}`}
                >
                  {formatClock(slot.start, timezone)}
                </span>
                <span className="truncate text-xs">
                  {rowNote(state, pickable, inSelection, ready)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function describe(state: string, pickable: boolean, ready: boolean): string {
  if (state === "taken") return "taken";
  if (state === "mine") return "your booking";
  if (state === "past") return "past";
  if (state === "beyond") return "not open yet";
  if (!ready) return "loading";
  return pickable ? "free" : "too short to book";
}

function rowNote(state: string, pickable: boolean, selected: boolean, ready: boolean): string {
  if (selected) return "Your selection";
  if (state === "mine") return "Yours";
  if (state === "taken") return "Taken";
  if (state === "free" && !pickable) return ready ? "Gap too short" : "Loading…";
  return "";
}
