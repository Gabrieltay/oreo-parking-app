import { isPublicHoliday } from "./publicHolidays";
import type {
  Carpark,
  CostResult,
  CostSegment,
  DayType,
  Pricing,
  RatePeriod,
  Surcharge,
} from "./types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * All arithmetic below treats input datetimes as Singapore wall-clock time
 * and does date math against a fake-UTC axis (i.e. "2026-07-07T15:10" is
 * converted with Date.UTC as if it were UTC). This sidesteps the server's
 * actual timezone entirely — we never need real UTC, only consistent,
 * monotonic ordering of SGT wall-clock instants.
 */
function localToFakeUtcMs(isoLocal: string): number {
  const match = isoLocal.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!match) {
    throw new Error(`Expected "YYYY-MM-DDTHH:MM" local datetime, got: ${isoLocal}`);
  }
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0
  );
}

function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function midnightMsOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToIso(dateKey: string, minutes: number): string {
  const ms = new Date(`${dateKey}T00:00:00Z`).getTime() + minutes * MS_PER_MINUTE;
  return new Date(ms).toISOString().slice(0, 19);
}

/** Half-open [start,end) containment, aware of periods that cross midnight. */
function periodContainsMinute(period: RatePeriod, minute: number): boolean {
  const start = hhmmToMinutes(period.start);
  const end = hhmmToMinutes(period.end);
  if (start === end) return true; // spans the full 24h
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end; // crosses midnight
}

export function determineDayType(dateKey: string): DayType {
  if (isPublicHoliday(dateKey)) return "sundayPh";
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  if (dow === 0) return "sundayPh";
  if (dow === 6) return "saturday";
  return "weekday";
}

function periodsForDayType(carpark: Carpark, dayType: DayType): RatePeriod[] {
  return carpark[dayType];
}

function computeTieredCost(
  durationMins: number,
  p: Extract<Pricing, { type: "tiered" }>
): number {
  if (durationMins <= 0) return 0;
  let cost = p.firstBlockFee;
  const remaining = durationMins - p.firstBlockMins;
  if (remaining > 0) {
    const blocks = Math.ceil(remaining / p.subsequentBlockMins);
    cost += blocks * p.subsequentFee;
  }
  return p.cap !== undefined ? Math.min(cost, p.cap) : cost;
}

function computePerMinuteCost(
  durationMins: number,
  p: Extract<Pricing, { type: "perMinute" }>
): number {
  const cost = durationMins * p.feePerMin;
  return p.cap !== undefined ? Math.min(cost, p.cap) : cost;
}

function costForSegment(
  pricing: Pricing | null,
  durationMins: number
): number | null {
  if (!pricing) return null;
  switch (pricing.type) {
    case "tiered":
      return computeTieredCost(durationMins, pricing);
    case "perMinute":
      return computePerMinuteCost(durationMins, pricing);
    case "flatEntry":
      return pricing.fee;
    case "unparsed":
      return null;
  }
}

type DayChunk = { dateKey: string; midnightMs: number; startMs: number; endMs: number };

function splitByCalendarDay(startMs: number, endMs: number): DayChunk[] {
  const chunks: DayChunk[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const midnightMs = midnightMsOf(cursor);
    const nextMidnightMs = midnightMs + MS_PER_DAY;
    const chunkEnd = Math.min(endMs, nextMidnightMs);
    chunks.push({
      dateKey: dateKeyOf(cursor),
      midnightMs,
      startMs: cursor,
      endMs: chunkEnd,
    });
    cursor = chunkEnd;
  }
  return chunks;
}

function computeSegmentsForDay(
  chunk: DayChunk,
  periods: RatePeriod[]
): CostSegment[] {
  const startMinute = (chunk.startMs - chunk.midnightMs) / MS_PER_MINUTE;
  const endMinute = (chunk.endMs - chunk.midnightMs) / MS_PER_MINUTE;

  const breakpoints = new Set<number>([startMinute, endMinute]);
  for (const p of periods) {
    const s = hhmmToMinutes(p.start);
    const e = hhmmToMinutes(p.end);
    if (s > startMinute && s < endMinute) breakpoints.add(s);
    if (e > startMinute && e < endMinute) breakpoints.add(e);
  }
  const sorted = [...breakpoints].sort((a, b) => a - b);

  const segments: CostSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === b) continue;

    const matching = periods.find((p) => periodContainsMinute(p, a)) ?? null;
    const duration = b - a;
    const cost = costForSegment(matching?.pricing ?? null, duration);

    segments.push({
      start: minutesToIso(chunk.dateKey, a),
      end: minutesToIso(chunk.dateKey, b),
      ratePeriod: matching,
      cost,
      note: matching
        ? matching.pricing.type === "unparsed"
          ? "Rate could not be parsed automatically — verify on-site."
          : undefined
        : "No matching rate period for this window.",
    });
  }
  return segments;
}

function computeSurcharges(
  carpark: Carpark,
  startMs: number,
  endMs: number
): { note: string; fee: number }[] {
  if (!carpark.surcharges?.length) return [];
  const applied: { note: string; fee: number }[] = [];

  for (const chunk of splitByCalendarDay(startMs, endMs)) {
    const dayName = DAY_NAMES[new Date(`${chunk.dateKey}T00:00:00Z`).getUTCDay()];
    const chunkStartMin = (chunk.startMs - chunk.midnightMs) / MS_PER_MINUTE;
    const chunkEndMin = (chunk.endMs - chunk.midnightMs) / MS_PER_MINUTE;

    for (const s of carpark.surcharges as Surcharge[]) {
      if (!s.days.includes(dayName)) continue;
      const sStart = hhmmToMinutes(s.start);
      const sEnd = hhmmToMinutes(s.end);
      const overlaps = chunkStartMin < sEnd && chunkEndMin > sStart;
      if (overlaps) applied.push({ note: s.note, fee: s.extraFee });
    }
  }
  return applied;
}

/**
 * Computes total parking cost for a carpark over [startIso, endIso), both
 * "YYYY-MM-DDTHH:MM" local (Singapore) datetimes.
 */
export function computeCost(
  carpark: Carpark,
  startIso: string,
  endIso: string
): Omit<CostResult, "carpark" | "distanceMeters"> {
  const startMs = localToFakeUtcMs(startIso);
  const endMs = localToFakeUtcMs(endIso);
  if (endMs <= startMs) {
    throw new Error("endTime must be after startTime");
  }

  const segments: CostSegment[] = [];
  for (const chunk of splitByCalendarDay(startMs, endMs)) {
    const dayType = determineDayType(chunk.dateKey);
    const periods = periodsForDayType(carpark, dayType);
    segments.push(...computeSegmentsForDay(chunk, periods));
  }

  // A flatEntry rate is a single fee paid on entry, not a per-window charge.
  // The first flatEntry segment encountered on a given calendar day charges;
  // later same-day segments that land back in a flatEntry window are already
  // covered by that entry and cost 0. A flatEntry segment on a *new* calendar
  // day (session spans midnight) is treated as a fresh entry and is charged
  // again.
  const chargedFlatEntryDates = new Set<string>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.ratePeriod?.pricing.type !== "flatEntry") continue;
    const dateKey = seg.start.slice(0, 10);
    if (chargedFlatEntryDates.has(dateKey)) {
      segments[i] = {
        ...seg,
        cost: 0,
        note: "Covered by the flat entry fee charged at the start of this session.",
      };
    } else {
      chargedFlatEntryDates.add(dateKey);
    }
  }

  const hasUnparsed = segments.some((s) => s.cost === null);
  const surchargesApplied = computeSurcharges(carpark, startMs, endMs);

  const totalCost = hasUnparsed
    ? null
    : segments.reduce((sum, s) => sum + (s.cost ?? 0), 0) +
      surchargesApplied.reduce((sum, s) => sum + s.fee, 0);

  return { totalCost, hasUnparsed, segments, surchargesApplied };
}
