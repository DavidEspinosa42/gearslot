"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/booking/interval";
import type { BookingRules } from "@/lib/booking/rules";
import { type Block, daySlots, initialMinutes, maxBookableMinutes } from "@/lib/booking/timeline";
import {
  addDays,
  localDateKey,
  localDayWindow,
  wallClockToUtc,
  zoneLabel,
} from "@/lib/booking/zone";
import {
  type Attempt,
  attemptFor,
  attemptIsFinished,
  type BoundAttempt,
  createApi,
  type LabDto,
  NO_ATTEMPT,
  newAttempt,
  type ReservationDto,
  type ResourceDto,
} from "@/lib/client/api";
import { formatDay } from "@/lib/client/format";
import { ConfirmSheet, type SheetPhase } from "./confirm-sheet";
import { DayTimeline } from "./day-timeline";
import { ItemPicker } from "./item-picker";
import { MyBookings } from "./my-bookings";
import { WeekStrip } from "./week-strip";

const REFRESH_MS = 20_000;

type Load = "loading" | "ready" | "signin" | "failed";

interface Pick {
  readonly start: number;
  readonly minutes: number;
}

export function BookingApp() {
  const api = useMemo(() => createApi(), []);
  const [load, setLoad] = useState<Load>("loading");
  const [lab, setLab] = useState<LabDto>();
  const [resources, setResources] = useState<ResourceDto[]>([]);
  const [resourceId, setResourceId] = useState<string>();
  const [weekStart, setWeekStart] = useState<string>("");
  const [dayKey, setDayKey] = useState<string>("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [stale, setStale] = useState(false);
  // Which resource and week `blocks` describe. Until it matches the screen, availability is unknown.
  const [loadedFor, setLoadedFor] = useState("");
  const [mine, setMine] = useState<ReservationDto[]>([]);
  // Real time and random keys are read after mount only: prerendering must stay deterministic.
  const [now, setNow] = useState(0);
  const [pick, setPick] = useState<Pick>();
  const [phase, setPhase] = useState<SheetPhase>({ kind: "ready" });
  // The booking attempt is bound to the exact request body it was made for: the same body keeps
  // its Idempotency-Key across retries, any other body gets a fresh key.
  const attempt = useRef<BoundAttempt>(NO_ATTEMPT);
  // Bumped whenever the selection changes, so a late response can tell it is no longer current.
  const view = useRef(0);
  const cancelAttempts = useRef(new Map<string, Attempt>());
  const latest = useRef(0);

  const rules: BookingRules | undefined = useMemo(
    () =>
      lab && {
        slotMinutes: lab.slotMinutes,
        minMinutes: lab.minMinutes,
        maxMinutes: lab.maxMinutes,
        horizonDays: lab.horizonDays,
      },
    [lab],
  );
  const resource = resources.find((r) => r.id === resourceId);
  const timezone = lab?.timezone ?? "UTC";

  // Only the newest list response may replace the list: an older one must never erase a fresh booking
  // or bring back a cancelled one.
  const mineTicket = useRef(0);
  const loadMine = useCallback(async () => {
    const ticket = ++mineTicket.current;
    const outcome = await api.mine();
    if (outcome.kind === "ok" && ticket === mineTicket.current) setMine(outcome.data.reservations);
  }, [api]);

  // First load: lab rules, items, and the caller's bookings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const outcome = await api.lab();
      if (cancelled) return;
      if (outcome.kind === "unauthorized") return setLoad("signin");
      if (outcome.kind !== "ok") return setLoad("failed");
      const start = localDateKey(Date.now(), outcome.data.lab.timezone);
      setLab(outcome.data.lab);
      setResources(outcome.data.resources);
      setResourceId(outcome.data.resources[0]?.id);
      setNow(Date.now());
      setWeekStart(start);
      setDayKey(start);
      setLoad("ready");
      void loadMine();
    })();
    return () => {
      cancelled = true;
    };
  }, [api, loadMine]);

  const dayKeys = useMemo(
    () => (weekStart === "" ? [] : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))),
    [weekStart],
  );

  const refresh = useCallback(async () => {
    if (!resourceId || !lab || dayKeys.length === 0) return;
    const ticket = ++latest.current;
    const from = localDayWindow(dayKeys[0] ?? "", lab.timezone).start;
    // Look past the last displayed day by the longest bookable length plus the buffer, so a
    // selection near the end of the week still sees a booking that starts just after it.
    const buffer = resources.find((r) => r.id === resourceId)?.bufferMinutes ?? 0;
    const to =
      localDayWindow(dayKeys[6] ?? "", lab.timezone).end +
      (lab.maxMinutes + buffer) * MS_PER_MINUTE;
    const outcome = await api.availability(resourceId, from, to);
    if (ticket !== latest.current) return; // a newer request superseded this one
    setNow(Date.now());
    if (outcome.kind === "ok") {
      setBlocks(outcome.data);
      setLoadedFor(`${resourceId}|${dayKeys[0]}`);
      setStale(false);
    } else {
      setStale(true);
    }
  }, [api, resourceId, resources, lab, dayKeys]);

  // Callbacks that outlive a render must refresh the *current* resource, not the one they closed over.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Keep availability fresh: on change, on a timer, and when the phone comes back online or into view.
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  if (load === "loading") return <Shell>Loading equipment…</Shell>;
  if (load === "signin") {
    return <Shell>Sign in through the institution's SSO to book equipment.</Shell>;
  }
  if (load === "failed" || !lab || !rules || !resource) {
    return <Shell>Can't reach the booking server. Check your connection and reload.</Shell>;
  }

  const slots = daySlots(localDayWindow(dayKey, timezone), rules);
  const eight = wallClockToUtc(Date.UTC(...(ymd(dayKey) as [number, number, number]), 8), timezone);
  const ready = loadedFor === `${resourceId}|${dayKeys[0]}`;
  const room = pick
    ? maxBookableMinutes(pick.start, blocks, resource.bufferMinutes, now, rules)
    : 0;
  const todayKey = localDateKey(now, timezone);
  const lastKey = localDateKey(now + rules.horizonDays * MS_PER_DAY, timezone);

  function openPick(start: number) {
    if (!rules || !resource || !ready) return;
    const fits = maxBookableMinutes(start, blocks, resource.bufferMinutes, now, rules);
    if (fits === 0) return;
    view.current += 1;
    setPhase({ kind: "ready" });
    setPick({ start, minutes: initialMinutes(fits, rules) });
  }

  function changeMinutes(minutes: number) {
    // Re-tapping the current length changes nothing, so it must not reset the phase or the key.
    if (!pick || minutes === pick.minutes) return;
    view.current += 1;
    setPhase({ kind: "ready" });
    setPick({ ...pick, minutes });
  }

  function focusDay(instant: number) {
    const key = localDateKey(instant, timezone);
    if (!dayKeys.includes(key)) setWeekStart(key);
    setDayKey(key);
  }

  async function confirm() {
    if (!pick || !resourceId) return;
    const startsAt = pick.start;
    const endsAt = pick.start + pick.minutes * MS_PER_MINUTE;
    const body = `${resourceId}|${startsAt}|${endsAt}`;
    attempt.current = attemptFor(attempt.current, body);
    const sent = attempt.current;
    const generation = view.current;

    setPhase({ kind: "sending" });
    const outcome = await api.book(sent, resourceId, startsAt, endsAt);

    // A definitive answer closes this attempt; silence keeps the key for the retry.
    if (attemptIsFinished(outcome) && attempt.current === sent) {
      attempt.current = NO_ATTEMPT;
    }
    if (outcome.kind !== "network") void refreshRef.current(); // show what is actually free, immediately
    if (outcome.kind === "ok") void loadMine();

    // The sheet may have been closed or pointed at another time while we waited. The answer then
    // belongs to a selection nobody is looking at; the timeline and "Your bookings" carry the truth.
    if (view.current !== generation) return;

    if (outcome.kind === "ok") {
      // Success is shown only now, after the server has confirmed it.
      setPhase({ kind: "done", reservation: outcome.data.reservation });
    } else if (
      outcome.kind === "problem" &&
      outcome.status === 409 &&
      outcome.problem.code === "conflict"
    ) {
      setPhase({ kind: "conflict", suggestions: outcome.problem.suggestions });
    } else if (outcome.kind === "problem" && outcome.status < 500) {
      setPhase({ kind: "refused", problem: outcome.problem });
    } else if (outcome.kind === "unauthorized") {
      setPhase({
        kind: "refused",
        problem: { code: "unauthorized", title: "Your session ended. Sign in again.", status: 401 },
      });
    } else {
      setPhase({ kind: "unknown" });
    }
  }

  async function cancel(id: string): Promise<string | undefined> {
    const existing = cancelAttempts.current.get(id) ?? newAttempt();
    cancelAttempts.current.set(id, existing);
    const outcome = await api.cancel(existing, id);
    if (attemptIsFinished(outcome)) cancelAttempts.current.delete(id);
    void refreshRef.current();
    void loadMine();
    if (outcome.kind === "ok") return undefined;
    if (outcome.kind === "problem" && outcome.status === 409) return undefined; // already gone
    if (outcome.kind === "problem" && outcome.status < 500) return outcome.problem.title;
    return "No clear answer from the server. Tap Cancel again to retry; it will not cancel twice.";
  }

  const selection = pick && { start: pick.start, end: pick.start + pick.minutes * MS_PER_MINUTE };

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 pt-5">
      <header className="mb-4">
        <h1 className="m-0 text-3xl font-semibold tracking-tight">Gearslot</h1>
        <p className="m-0 mt-1 text-ink-soft">
          All times are {cityOf(timezone)} time ({zoneLabel(now, timezone)}).
        </p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-[19rem_minmax(0,1fr)] md:items-start">
        <div className="md:col-start-1 md:row-start-1">
          <ItemPicker
            resources={resources}
            selectedId={resourceId}
            onSelect={(id) => {
              if (id === resourceId) return; // already showing it; keep what we know
              view.current += 1;
              setResourceId(id);
              setPick(undefined);
              setBlocks([]);
              setLoadedFor(""); // availability is unknown again until the new response lands
            }}
          />
        </div>

        <section aria-label="Availability" className="md:col-start-2 md:row-span-2 md:row-start-1">
          <h2 className="m-0 mb-1 text-xl font-semibold">{resource.name}</h2>
          <p className="m-0 mb-3 text-sm text-ink-soft">
            {resource.locationLabel}
            {resource.bufferMinutes > 0
              ? `, ${resource.bufferMinutes} min buffer after each booking`
              : ""}
          </p>
          <WeekStrip
            dayKeys={dayKeys}
            activeKey={dayKey}
            blocks={blocks}
            timezone={timezone}
            now={now}
            horizonDays={rules.horizonDays}
            canGoBack={weekStart > todayKey}
            canGoForward={addDays(weekStart, 7) <= lastKey}
            onSelect={setDayKey}
            onShift={(direction) => {
              const next = addDays(weekStart, direction * 7);
              // biome-ignore lint/complexity/useMathMinMax: ISO date strings, Math.max would give NaN
              const clamped = next < todayKey ? todayKey : next;
              setWeekStart(clamped);
              setDayKey(clamped);
            }}
          />
          <p className="m-0 my-2 text-sm text-ink-soft" aria-live="polite">
            {stale
              ? "Can't refresh right now. This may be out of date."
              : `${formatDay(localDayWindow(dayKey, timezone).start, timezone)}. Tap a free time to start.`}
          </p>
          <DayTimeline
            slots={slots}
            blocks={blocks}
            now={now}
            rules={rules}
            bufferMinutes={resource.bufferMinutes}
            ready={ready}
            timezone={timezone}
            selected={selection}
            scrollTo={Math.max(eight, slots[0]?.start ?? eight)}
            onPick={openPick}
          />
        </section>

        <div className="md:col-start-1 md:row-start-2">
          <MyBookings reservations={mine} timezone={timezone} onCancel={cancel} />
        </div>
      </div>

      {pick ? (
        <ConfirmSheet
          resourceName={resource.name}
          timezone={timezone}
          start={pick.start}
          minutes={pick.minutes}
          maxMinutes={Math.max(room, pick.minutes)}
          minMinutes={rules.minMinutes}
          slotMinutes={rules.slotMinutes}
          bufferMinutes={resource.bufferMinutes}
          phase={phase}
          onMinutes={changeMinutes}
          onConfirm={confirm}
          onClose={() => {
            view.current += 1;
            setPick(undefined);
            setPhase({ kind: "ready" });
          }}
          onUseUnit={(id) => {
            view.current += 1;
            setResourceId(id);
            setBlocks([]);
            setLoadedFor(""); // availability is unknown again until the new response lands
            setPhase({ kind: "ready" });
          }}
          onUseSlot={(startsAt, endsAt) => {
            const start = Date.parse(startsAt);
            view.current += 1;
            setPick({ start, minutes: (Date.parse(endsAt) - start) / MS_PER_MINUTE });
            setPhase({ kind: "ready" });
            focusDay(start);
          }}
        />
      ) : null}
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-4 pt-8">
      <h1 className="m-0 text-3xl font-semibold tracking-tight">Gearslot</h1>
      <p className="mt-3 text-ink-soft">{children}</p>
    </main>
  );
}

function ymd(key: string): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return [y, m - 1, d];
}

function cityOf(timezone: string): string {
  return (timezone.split("/").pop() ?? timezone).replaceAll("_", " ");
}
