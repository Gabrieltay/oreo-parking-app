/**
 * Build-time only: converts data/sgcarmart/<id>.json (SGCarMart's per-carpark
 * detail dumps, fetched by scripts/fetch-sgcarmart.ts) into the app's
 * CarparkRates/Carpark schema, then merges the result into data/carparks.json.
 *
 * Unlike the LTA pipeline (01-crawl -> 02-extract-rates -> 03-geocode), each
 * SGCarMart record already carries its own address/lat/lng, so no geocoding
 * step is needed here. Rate text is parsed with a deterministic rule-based
 * parser (same approach as scripts/02b-extract-rates-heuristic.ts) — no LLM
 * call, no guessed numbers. Anything ambiguous is marked "unparsed" and
 * flagged in data/needs-review.json.
 *
 * Per instructions: SGCarMart rows are the newer source of truth. A merged
 * carpark whose (case-insensitive) name matches an existing data/carparks.json
 * entry *replaces* it; a name with no match is appended as a new carpark.
 *
 * Run with `tsx scripts/04-parse-sgcarmart.ts`.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Carpark, CarparkRates, Pricing, RatePeriod } from "../lib/types";

type SgCarMartDetail = {
  id: number;
  name: string;
  location: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  wd1: string | null;
  wd2: string | null;
  sat: string | null;
  sun: string | null;
  remarks: string | null;
};

type Segment = { start: string; end: string; priceText: string };

// --- time parsing -----------------------------------------------------

const TIME_TOKEN_SRC =
  "\\d{1,2}[.:]\\d{2}\\s*(?:am|pm)|\\d{3,4}\\s*(?:am|pm)|\\d{1,2}\\s*(?:am|pm)|12\\s*midnight|12\\s*noon|midnight|noon";

function parseTimeToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  if (/^12\s*midnight$/.test(t) || t === "midnight") return "00:00";
  if (/^12\s*noon$/.test(t) || t === "noon") return "12:00";

  let m = t.match(/^(\d{1,2})[.:](\d{2})\s*(am|pm)$/);
  if (m) return to24h(Number(m[1]), Number(m[2]), m[3]);

  m = t.match(/^(\d{3,4})\s*(am|pm)$/);
  if (m) {
    const digits = m[1];
    const mm = Number(digits.slice(-2));
    const h = Number(digits.slice(0, -2));
    return to24h(h, mm, m[2]);
  }

  m = t.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) return to24h(Number(m[1]), 0, m[2]);

  return null;
}

function to24h(h: number, mm: number, ampm: string): string {
  let hour = h % 12;
  if (ampm === "pm") hour += 12;
  if (h === 12 && ampm === "am") hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

const TIME_RANGE_RE = new RegExp(
  `(?:from|between)?\\s*(${TIME_TOKEN_SRC})\\s*(?:to|-|–|till|and)\\s*(${TIME_TOKEN_SRC})` +
    `(\\s*(?:the\\s*)?(?:foll?ow(?:ing)?|next)\\s*(?:day|morning))?`,
  "gi"
);

const AFTER_RE = new RegExp(`\\bafter\\s*(${TIME_TOKEN_SRC})\\b`, "i");

const TRAILING_DAY_RANGE_RE =
  /\s*(?:the\s*)?from\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*(?:to|-)\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s*$/i;

const LEADING_DAY_RANGE_RE =
  /^\(\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*(?:to|-)\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:\s*and\s*PH)?\s*\)\s*/i;

/** Splits a raw wd1/wd2/sat/sun field into time-bounded price segments. */
function splitIntoSegments(rawText: string): { segments: Segment[]; dayRangeQualifiers: string[] } {
  const text = rawText
    .replace(TRAILING_DAY_RANGE_RE, "")
    .trim();

  const dayRangeQualifiers: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TIME_RANGE_RE.lastIndex = 0;

  while ((match = TIME_RANGE_RE.exec(text))) {
    const priceTextRaw = text.slice(cursor, match.index).replace(/^[,;\s]+/, "").trim();
    let priceText = priceTextRaw;
    const dayRangeMatch = priceText.match(LEADING_DAY_RANGE_RE);
    if (dayRangeMatch) {
      dayRangeQualifiers.push(dayRangeMatch[0].trim());
      priceText = priceText.slice(dayRangeMatch[0].length).trim();
    }
    const start = parseTimeToken(match[1]);
    const end = parseTimeToken(match[2]);
    if (start && end && priceText) {
      segments.push({ start, end, priceText });
    }
    cursor = TIME_RANGE_RE.lastIndex;
  }

  const leftover = text.slice(cursor).replace(/^[,;\s]+/, "").trim();
  if (leftover && /\d/.test(leftover)) {
    // Unmatched trailing text with digits in it (e.g. an "after HH:MM"
    // open-ended clause) — surface as its own unparsed segment rather than
    // silently dropping it.
    const afterMatch = leftover.match(AFTER_RE);
    if (afterMatch) {
      const start = parseTimeToken(afterMatch[1]);
      if (start) {
        segments.push({ start, end: start, priceText: leftover });
      }
    } else {
      segments.push({ start: "00:00", end: "00:00", priceText: leftover });
    }
  }

  if (segments.length === 0 && text.trim()) {
    segments.push({ start: "00:00", end: "00:00", priceText: text.trim() });
  }

  return { segments, dayRangeQualifiers };
}

// --- price text parsing -------------------------------------------------

const UNIT_ALT = "hrs?|hours?|min(?:ute)?s?|½\\s*hr";

function unitToMinutes(numStr: string | undefined, unit: string): number | null {
  if (/½/.test(unit)) return 30;
  const n = numStr ? Number(numStr) : 1;
  if (/hr|hour/i.test(unit)) return n * 60;
  if (/min/i.test(unit)) return n;
  return null;
}

const CAP_RE =
  /(?:up\s*to\s*(?:a\s*)?)?(?:capp?ed(?:\s+at)?|cap(?:ped)?\s*of|max(?:imum)?\s*(?:parking\s*)?(?:charge|cap)?(?:\s*of)?)\s*(?:maximum\s*|max\s*)?\$?([\d.]+)/i;

function extractCap(text: string): number | undefined {
  const m = text.match(CAP_RE);
  return m ? Number(m[1]) : undefined;
}

const EXCLUDE_PHRASES = [
  /private car park/i,
  /not for public/i,
  /building demolished/i,
  /season parking only/i,
  /complimentary parking for .*only/i,
  /^\*+$/,
  /no longer in operation/i,
  /under construction/i,
  /not in operation/i,
];

function parsePriceText(raw: string, capHint?: number): Pricing {
  const text = raw
    .replace(/S\$/gi, "$")
    .replace(/\(with \d+%\s*GST\)/gi, "")
    .replace(/half[- ]hourly/gi, "per 30min")
    .replace(/(\d+(?:\.\d+)?)\s*¢/g, (_, n) => `$${(Number(n) / 100).toFixed(2)}`)
    .replace(/\bfro\b/gi, "for")
    .replace(/\bmmin\b/gi, "min")
    .trim();

  if (EXCLUDE_PHRASES.some((re) => re.test(text))) {
    return { type: "unparsed", raw };
  }
  if (/^free\b/i.test(text) || /free parking/i.test(text) || /free entry/i.test(text)) {
    return { type: "flatEntry", fee: 0 };
  }
  if (/closed/i.test(text) || /no entry/i.test(text)) {
    return { type: "unparsed", raw };
  }

  // 3-tier "$X/hr for 1st Nhr, $Y/hr for next subsequent Mhr, $Z/30min ..."
  const firstHrMulti = text.match(
    /\$?([\d.]+)\s*\/\s*hr\s*for\s*(?:the\s*)?(?:first|1st)\s*(\d+)\s*hrs?/i
  );
  const midHrMulti = text.match(
    /\$?([\d.]+)\s*\/\s*hr\s*for\s*next\s*(?:subsequent\s*)?(\d+)\s*hrs?/i
  );
  if (firstHrMulti && midHrMulti) {
    const subTail = text.match(
      new RegExp(`\\$?([\\d.]+)\\s*\\/\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "gi")
    );
    // Last "$X/unit" occurrence in the string is the recurring subsequent rate.
    const lastSub = subTail && subTail.length > 0 ? subTail[subTail.length - 1] : null;
    const lastSubMatch = lastSub?.match(
      new RegExp(`\\$?([\\d.]+)\\s*\\/\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
    );
    if (lastSubMatch) {
      const subNum = lastSubMatch[2].match(/\d+/)?.[0];
      const subsequentBlockMins = unitToMinutes(subNum, lastSubMatch[2]);
      if (subsequentBlockMins) {
        const pricing: Pricing = {
          type: "tiered",
          firstBlockMins: Number(firstHrMulti[2]) * 60,
          firstBlockFee: Number(firstHrMulti[1]) * Number(firstHrMulti[2]),
          middleBlockMins: Number(midHrMulti[2]) * 60,
          middleBlockFee: Number(midHrMulti[1]) * Number(midHrMulti[2]),
          subsequentBlockMins,
          subsequentFee: Number(lastSubMatch[1]),
        };
        if (capHint !== undefined) pricing.cap = capHint;
        return pricing;
      }
    }
  }

  // "<N> <unit> free" (e.g. "1st hr free", "first 30min free")
  const freeFirstMatch = text.match(
    new RegExp(`(?:first|1st)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))\\s*free`, "i")
  );

  // Tiered: "$X for/per 1st <hr|min>", "1st <hr|min> at $X",
  // "for 1st <hr|min> [or part thereof] $X", or "$X 1st <hr|min>".
  const firstMatch =
    text.match(
      new RegExp(`\\$?([\\d.]+)\\s*(?:for|per)\\s*(?:the\\s*)?(?:first|1st)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
    ) ??
    text.match(
      new RegExp(`(?:first|1st)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))\\s*at\\s*\\$?([\\d.]+)`, "i")
    ) ??
    text.match(
      new RegExp(
        `for\\s*(?:the\\s*)?(?:first|1st)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))\\s*(?:or part thereof\\s*)?\\$?([\\d.]+)`,
        "i"
      )
    ) ??
    text.match(
      new RegExp(`\\$?([\\d.]+)\\s*\\/\\s*(?:1st|first)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
    ) ??
    text.match(
      new RegExp(`\\$?([\\d.]+)\\s*(?:first|1st)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
    );

  let firstFeeStr: string | undefined;
  let firstUnitStr: string | undefined;
  if (freeFirstMatch) {
    firstFeeStr = "0";
    firstUnitStr = freeFirstMatch[1];
  } else if (firstMatch) {
    const isUnitFirstForm = /\$?[\d.]+$/i.test(firstMatch[0]) && !/^\$?[\d.]+/.test(firstMatch[0]);
    firstFeeStr = isUnitFirstForm ? firstMatch[2] : firstMatch[1];
    firstUnitStr = isUnitFirstForm ? firstMatch[1] : firstMatch[2];
  }

  const subMatch =
    text.match(
      new RegExp(
        `\\$?([\\d.]+)\\s*(?:\\/\\s*|(?:for|per)\\s+)?(?:the\\s+)?(?:next\\s*|every\\s*)?sub\\.?(?:sequent)?\\.?\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`,
        "i"
      )
    ) ??
    text.match(
      new RegExp(
        `\\$?([\\d.]+)\\s*(?:for\\s+)?every\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))\\s*thereafter`,
        "i"
      )
    );

  if (firstFeeStr && firstUnitStr && subMatch) {
    const firstFee = Number(firstFeeStr);
    const subFee = Number(subMatch[1]);
    const subUnitStr = subMatch[2];
    const firstNum = firstUnitStr.match(/\d+/)?.[0];
    const subNum = subUnitStr.match(/\d+/)?.[0];
    const firstBlockMins = unitToMinutes(firstNum, firstUnitStr);
    const subsequentBlockMins = unitToMinutes(subNum, subUnitStr);
    if (firstBlockMins && subsequentBlockMins) {
      const pricing: Pricing = {
        type: "tiered",
        firstBlockMins,
        firstBlockFee: firstFee,
        subsequentBlockMins,
        subsequentFee: subFee,
      };
      if (capHint !== undefined) pricing.cap = capHint;
      return pricing;
    }
  }

  // Positional shorthand: "$X for 1st hr, $Y/30min" — no "sub" keyword,
  // implied by being the next clause after the first-block fee.
  if (firstMatch && firstFeeStr && firstUnitStr) {
    const remainder = text.slice(text.indexOf(firstMatch[0]) + firstMatch[0].length);
    const positionalSub = remainder.match(
      new RegExp(`\\$?([\\d.]+)\\s*(?:\\/|per\\s*)\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
    );
    if (positionalSub) {
      const firstFee = Number(firstFeeStr);
      const subFee = Number(positionalSub[1]);
      const subUnitStr = positionalSub[2];
      const firstNum = firstUnitStr.match(/\d+/)?.[0];
      const subNum = subUnitStr.match(/\d+/)?.[0];
      const firstBlockMins = unitToMinutes(firstNum, firstUnitStr);
      const subsequentBlockMins = unitToMinutes(subNum, subUnitStr);
      if (firstBlockMins && subsequentBlockMins) {
        const pricing: Pricing = {
          type: "tiered",
          firstBlockMins,
          firstBlockFee: firstFee,
          subsequentBlockMins,
          subsequentFee: subFee,
        };
        if (capHint !== undefined) pricing.cap = capHint;
        return pricing;
      }
    }
  }

  // A lone "$X for (next) subsequent <unit>" with no first-tier fee stated
  // in this segment (e.g. continuing on from a preceding flatEntry clause) —
  // treat as a uniform per-block rate rather than leaving it unparsed.
  if (!firstFeeStr && subMatch) {
    const subFee = Number(subMatch[1]);
    const subUnitStr = subMatch[2];
    const subNum = subUnitStr.match(/\d+/)?.[0];
    const subsequentBlockMins = unitToMinutes(subNum, subUnitStr);
    if (subsequentBlockMins) {
      const pricing: Pricing = {
        type: "tiered",
        firstBlockMins: subsequentBlockMins,
        firstBlockFee: subFee,
        subsequentBlockMins,
        subsequentFee: subFee,
      };
      if (capHint !== undefined) pricing.cap = capHint;
      return pricing;
    }
  }

  // Pure per-minute (continuous), e.g. "$0.02 per min"
  const perMinMatch = text.match(/\$?([\d.]+)\s*(?:per|\/)\s*min(?:ute)?\b/i);
  if (perMinMatch && !/\d\s*min/i.test(text.replace(perMinMatch[0], ""))) {
    const pricing: Pricing = { type: "perMinute", feePerMin: Number(perMinMatch[1]) };
    if (capHint !== undefined) pricing.cap = capHint;
    return pricing;
  }

  // Uniform block: "$X per 30min" / "$X every 30min" / "$X/30min" / "$X per hr"
  const uniformMatch = text.match(
    new RegExp(`\\$?([\\d.]+)\\s*(?:per\\s*|every\\s*|\\/)(?:every\\s*)?((?:\\d+)?\\s*(?:${UNIT_ALT}))`, "i")
  );
  if (uniformMatch) {
    const fee = Number(uniformMatch[1]);
    const unitStr = uniformMatch[2];
    const num = unitStr.match(/\d+/)?.[0];
    const blockMins = unitToMinutes(num, unitStr);
    if (blockMins) {
      const pricing: Pricing = {
        type: "tiered",
        firstBlockMins: blockMins,
        firstBlockFee: fee,
        subsequentBlockMins: blockMins,
        subsequentFee: fee,
      };
      if (capHint !== undefined) pricing.cap = capHint;
      return pricing;
    }
  }

  // Flat entry: "$X per entry" / "$X/entry"
  const entryMatch = text.match(/\$?([\d.]+)\s*(?:per\s*entry|\/entry|per\s*parking session)/i);
  if (entryMatch) {
    return { type: "flatEntry", fee: Number(entryMatch[1]) };
  }

  return { type: "unparsed", raw };
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Whether `inner`'s [start,end) window sits entirely inside `outer`'s (both possibly wrapping past midnight). */
function windowContains(outer: RatePeriod, inner: RatePeriod): boolean {
  const os = hhmmToMinutes(outer.start);
  const oe = hhmmToMinutes(outer.end);
  const within = (m: number) => (os === oe ? true : os < oe ? m >= os && m <= oe : m >= os || m <= oe);
  return within(hhmmToMinutes(inner.start)) && within(hhmmToMinutes(inner.end));
}

/**
 * A clause like "Parking charges capped at $5.60 from 10.30pm to 7am" that
 * only refines a cap for part of a window already priced by another period
 * in this same field (e.g. "$0.70/30min from 5pm to 7am") would otherwise
 * become its own unparsed period — and, being narrower, would shadow the
 * correctly-parsed base period for that sub-window (see findMatchingPeriod
 * in lib/costEngine.ts). Fold the cap into the containing period instead.
 */
function backfillCapOnlyPeriods(periods: RatePeriod[]): RatePeriod[] {
  return periods.map((p) => {
    if (p.pricing.type !== "unparsed") return p;
    const raw = p.pricing.raw;
    const cap = extractCap(raw);
    if (cap === undefined) return p;
    const withoutCap = raw
      .replace(CAP_RE, "")
      .replace(/\bparking\s*charges?\b/gi, "")
      .replace(/\bper\s*day\b/gi, "")
      .replace(/\bdaily\b/gi, "")
      .replace(/[^a-z0-9]/gi, "")
      .trim();
    // Any leftover alphanumeric text (beyond boilerplate already stripped)
    // means there's more going on here than a bare cap — don't guess.
    if (withoutCap) return p;

    const base = periods.find(
      (other) =>
        other !== p &&
        (other.pricing.type === "tiered" || other.pricing.type === "perMinute") &&
        windowContains(other, p)
    );
    if (!base || (base.pricing.type !== "tiered" && base.pricing.type !== "perMinute")) return p;
    return { ...p, pricing: { ...base.pricing, cap } };
  });
}

function segmentsToPeriods(segments: Segment[]): RatePeriod[] {
  const periods = segments.map((s) => ({
    start: s.start,
    end: s.end,
    pricing: parsePriceText(s.priceText, extractCap(s.priceText)),
  }));
  return backfillCapOnlyPeriods(periods);
}

const SAME_AS_WEEKDAYS_RE = /^same\s+(?:as|s)\s+(?:weekdays?|wkdays)\.?$/i;
const CHARGES_SAME_AS_WEEKDAYS_RE = /charges?\s+same\s+(?:as|s)\s+weekdays?\.?/i;
const SAME_AS_SATURDAY_RE = /^(?:charges?\s+)?same\s+(?:as|s)\s+saturday\.?$/i;

function fieldText(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function isSameAsWeekdays(t: string): boolean {
  return SAME_AS_WEEKDAYS_RE.test(t) || CHARGES_SAME_AS_WEEKDAYS_RE.test(t);
}

function parseField(text: string): { periods: RatePeriod[]; multiDayRangeUnparsed: boolean } {
  if (!text || text === "-") return { periods: [], multiDayRangeUnparsed: false };
  const { segments, dayRangeQualifiers } = splitIntoSegments(text);
  // More than one distinct parenthetical day-range qualifier inside a single
  // field means the source is describing a schedule split that doesn't map
  // cleanly onto weekday/Saturday/Sunday-PH — too risky to auto-merge.
  const distinctQualifiers = new Set(dayRangeQualifiers.map((q) => q.toLowerCase()));
  if (distinctQualifiers.size > 1) {
    return {
      periods: [{ start: "00:00", end: "00:00", pricing: { type: "unparsed", raw: text } }],
      multiDayRangeUnparsed: true,
    };
  }
  return { periods: segmentsToPeriods(segments), multiDayRangeUnparsed: false };
}

/** SGCarMart sometimes repeats the exact same clause verbatim in wd1 and wd2 (both spanning the full day) — drop the redundant copy. */
function dedupePeriods(periods: RatePeriod[]): RatePeriod[] {
  const seen = new Set<string>();
  return periods.filter((p) => {
    const key = `${p.start}|${p.end}|${JSON.stringify(p.pricing)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveWeekday(wd1: string, wd2: string): { periods: RatePeriod[]; flagged: boolean } {
  const before = parseField(fieldText(wd1));
  const afterText = fieldText(wd2);
  if (!afterText || afterText === "-" || isSameAsWeekdays(afterText)) {
    return { periods: before.periods, flagged: before.multiDayRangeUnparsed };
  }
  const after = parseField(afterText);
  return {
    periods: dedupePeriods([...before.periods, ...after.periods]),
    flagged: before.multiDayRangeUnparsed || after.multiDayRangeUnparsed,
  };
}

function resolveReferential(
  text: string,
  weekday: RatePeriod[],
  saturday: RatePeriod[] | null
): { periods: RatePeriod[]; flagged: boolean } | null {
  const t = fieldText(text);
  if (!t) return { periods: [], flagged: false };
  if (isSameAsWeekdays(t)) return { periods: weekday, flagged: false };
  if (saturday && SAME_AS_SATURDAY_RE.test(t)) return { periods: saturday, flagged: false };
  if (t === "-") return { periods: weekday, flagged: false };
  return null;
}

// --- region / id -------------------------------------------------------

const REGION_BY_LOCATION: Record<string, string> = {
  n: "North",
  s: "South",
  e: "East",
  w: "West",
};

function regionFor(location: string | null): string {
  const key = (location ?? "").trim().toLowerCase();
  return REGION_BY_LOCATION[key] ?? "Singapore";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- main ----------------------------------------------------------------

function allPeriodsOf(r: CarparkRates): RatePeriod[] {
  return [...r.weekday, ...r.saturday, ...r.sundayPh, ...(r.dayOverrides ?? []).flatMap((o) => o.periods)];
}

async function main() {
  const dataDir = path.join(process.cwd(), "data");
  const sgDir = path.join(dataDir, "sgcarmart");
  const files = (await readdir(sgDir)).filter((f) => f.endsWith(".json"));

  const existingRaw: Carpark[] = JSON.parse(
    await readFile(path.join(dataDir, "carparks.json"), "utf-8")
  );

  const byNameKey = new Map<string, Carpark>();
  for (const c of existingRaw) byNameKey.set(c.name.trim().toLowerCase(), c);

  const needsReview: { row: { id: number; name: string }; reason: string }[] = [];
  const usedIds = new Set<string>(existingRaw.map((c) => c.id));

  let replaced = 0;
  let added = 0;
  let totalPeriods = 0;
  let unparsedPeriods = 0;

  for (const file of files) {
    const raw: SgCarMartDetail = JSON.parse(await readFile(path.join(sgDir, file), "utf-8"));
    const name = raw.name.trim();
    if (!name || raw.latitude == null || raw.longitude == null) {
      needsReview.push({
        row: { id: raw.id, name: name || `(id ${raw.id})` },
        reason: "missing name or coordinates in SGCarMart data",
      });
      continue;
    }

    const wd = resolveWeekday(fieldText(raw.wd1), fieldText(raw.wd2));
    const satResolved =
      resolveReferential(fieldText(raw.sat), wd.periods, null) ?? parseField(fieldText(raw.sat));
    const sunResolved =
      resolveReferential(fieldText(raw.sun), wd.periods, satResolved.periods) ??
      parseField(fieldText(raw.sun));

    const notes = [
      "Rates parsed by a local deterministic parser (no LLM available in this environment) from SGCarMart — guide only, verify on-site.",
    ];
    if (raw.remarks && raw.remarks.trim()) notes.push(raw.remarks.trim());

    const rates: CarparkRates = {
      name,
      region: regionFor(raw.location),
      weekday: wd.periods,
      saturday: satResolved.periods,
      sundayPh: sunResolved.periods,
      notes: notes.join(" "),
    };

    const nameKey = name.toLowerCase();
    const existing = byNameKey.get(nameKey);
    let id: string;
    if (existing) {
      id = existing.id;
    } else {
      id = slugify(name) || `sgcarmart-${raw.id}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${slugify(name) || `sgcarmart-${raw.id}`}-${suffix++}`;
      usedIds.add(id);
    }

    const carpark: Carpark = {
      ...rates,
      id,
      address: raw.address ?? undefined,
      lat: raw.latitude,
      lng: raw.longitude,
    };

    if (existing) replaced++;
    else added++;
    byNameKey.set(nameKey, carpark);

    const periods = allPeriodsOf(rates);
    totalPeriods += periods.length;
    const unparsedCount = periods.filter((p) => p.pricing.type === "unparsed").length;
    unparsedPeriods += unparsedCount;
    if (unparsedCount > 0) {
      needsReview.push({
        row: { id: raw.id, name },
        reason: `${unparsedCount}/${periods.length} rate period(s) could not be auto-parsed`,
      });
    }
  }

  const merged = [...byNameKey.values()];

  await writeFile(path.join(dataDir, "carparks.json"), JSON.stringify(merged, null, 2));

  let existingReview: unknown[] = [];
  try {
    existingReview = JSON.parse(await readFile(path.join(dataDir, "needs-review.json"), "utf-8"));
  } catch {
    // no existing needs-review.json — fine
  }
  await writeFile(
    path.join(dataDir, "needs-review.json"),
    JSON.stringify([...existingReview, ...needsReview], null, 2)
  );

  console.log(`Parsed ${files.length} SGCarMart carparks.`);
  console.log(`  ${replaced} replaced an existing carpark (matched by name).`);
  console.log(`  ${added} added as new carparks.`);
  console.log(
    `  ${totalPeriods - unparsedPeriods}/${totalPeriods} rate periods auto-parsed ` +
      `(${((100 * (totalPeriods - unparsedPeriods)) / totalPeriods).toFixed(1)}%).`
  );
  console.log(`  ${needsReview.length} carparks flagged in data/needs-review.json.`);
  console.log(`\nWrote ${merged.length} total carparks to data/carparks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
