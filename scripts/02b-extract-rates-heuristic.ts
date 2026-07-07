/**
 * One-time substitute for the LLM-based scripts/02-extract-rates.ts.
 *
 * scripts/02-extract-rates.ts (the documented pipeline step) calls the
 * Anthropic API to convert LTA's free-text rate strings into structured
 * JSON. This sandbox has no ANTHROPIC_API_KEY available, so this script
 * implements the same conversion as a deterministic, auditable rule-based
 * parser instead — no hallucination risk, and every row it can't confidently
 * parse is marked `unparsed` (never guessed), exactly per spec. Prefer
 * re-running the real scripts/02-extract-rates.ts once API access exists;
 * this script exists only to unblock this one import.
 *
 * Run with `tsx scripts/02b-extract-rates-heuristic.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawRateRow } from "./01-crawl";
import type { CarparkRates, Pricing, RatePeriod } from "../lib/types";

type Chunk = { start: string; end: string; priceText: string };

const TIME_RE = /(\d{1,2})[.:](\d{2})\s*(am|pm)/i;
const TIME_RANGE_RE = new RegExp(`^\\s*${TIME_RE.source}\\s*[-–]+\\s*${TIME_RE.source}`, "i");
const AFT_RE = new RegExp(`^\\s*(?:aft|after)\\.?\\s*${TIME_RE.source}`, "i");

function to24h(h: number, mm: number, ampm: string): string {
  let hour = h % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  if (h === 12 && ampm.toLowerCase() === "am") hour = 0;
  return `${String(hour).padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

function stripDayNoise(s: string): string {
  return s
    .replace(/the following day/gi, "")
    .replace(/the followng day/gi, "")
    .replace(/next day/gi, "")
    .replace(/next morning/gi, "")
    .replace(/\(next day\)/gi, "")
    .trim();
}

/** Splits a column's raw text into time-bounded price chunks. */
const DAILY_PREFIX_RE = /^daily\s*(?:\([^)]*\))?\s*:?\s*/i;

function splitIntoChunks(text: string): Chunk[] {
  const clauses = text
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];

  for (const rawClause of clauses) {
    // Strip a leading "Daily"/"Daily:" label unconditionally — it may or may
    // not be followed by its own embedded time range (e.g. "Daily: $1.60 per
    // hr" vs "Daily 7.00am-11.00pm: free"), so let the normal time-range /
    // whole-day checks below decide based on what's left.
    const clause = rawClause.replace(DAILY_PREFIX_RE, "");

    const rangeMatch = clause.match(TIME_RANGE_RE);
    if (rangeMatch) {
      const [, h1, m1, ap1, h2, m2, ap2] = rangeMatch;
      const start = to24h(Number(h1), Number(m1), ap1);
      const end = to24h(Number(h2), Number(m2), ap2);
      const rest = stripDayNoise(clause.slice(rangeMatch[0].length).replace(/^:?\s*/, ""));
      chunks.push({ start, end, priceText: rest });
      continue;
    }

    const aftMatch = clause.match(AFT_RE);
    if (aftMatch) {
      const [, h1, m1, ap1] = aftMatch;
      const start = to24h(Number(h1), Number(m1), ap1);
      const rest = stripDayNoise(clause.slice(aftMatch[0].length).replace(/^:?\s*/, ""));
      chunks.push({ start, end: "__NEXT_START__", priceText: rest });
      continue;
    }

    // No leading time marker: a continuation of the previous chunk's price
    // description (e.g. "$X for 1st hr; $Y for sub. 30min" — the second
    // clause has no time prefix of its own, it's part of the same period).
    // Only becomes a new all-day chunk if there's no previous chunk yet.
    if (chunks.length > 0) {
      const prev = chunks[chunks.length - 1];
      prev.priceText = prev.priceText ? `${prev.priceText}; ${clause}` : clause;
    } else {
      chunks.push({ start: "00:00", end: "00:00", priceText: stripDayNoise(clause) });
    }
  }

  // Resolve "Aft H:MM" chunks (open end) against the next chunk's start,
  // wrapping to the first chunk's start if it's the last chunk.
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].end === "__NEXT_START__") {
      const next = chunks[i + 1] ?? chunks[0];
      chunks[i].end = next ? next.start : "00:00";
    }
  }

  return chunks;
}

const CAP_RE = /(?:capped at|max(?:imum)?(?:\s*(?:cap|charge))?(?:\/day)?:?)\s*\$?([\d.]+)/i;

function extractCap(text: string): number | undefined {
  const m = text.match(CAP_RE);
  return m ? Number(m[1]) : undefined;
}

function unitToMinutes(numStr: string | undefined, unit: string): number | null {
  if (/½/.test(unit)) return 30;
  const n = numStr ? Number(numStr) : 1;
  if (/hr|hour/i.test(unit)) return n * 60;
  if (/min/i.test(unit)) return n;
  return null;
}

const UNIT_ALT = "hrs?|hours?|min(?:ute)?s?|½\\s*hr";

function parsePriceText(priceText: string, capHint?: number): Pricing {
  let text = priceText.trim();
  // Normalize noise that would otherwise break keyword-adjacency regexes.
  text = text
    .replace(/S\$/gi, "$")
    .replace(/\(with \d+%\s*GST\)/gi, "")
    .replace(/half[- ]hourly/gi, "per 30min")
    .replace(/(\d+(?:\.\d+)?)\s*¢/g, (_, n) => `$${(Number(n) / 100).toFixed(2)}`);

  if (/^free\b/i.test(text) || /free parking/i.test(text)) {
    return { type: "flatEntry", fee: 0 };
  }
  if (/^closed\b/i.test(text) || /no entry/i.test(text) || /carpark closed/i.test(text)) {
    return { type: "unparsed", raw: priceText };
  }

  // Tiered: "$X for/per 1st <hr|min>", "1st <hr|min> at $X", or
  // "for 1st <hr|min> [or part thereof] $X" (fee trailing the unit).
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
    );
  let firstFeeStr: string | undefined;
  let firstUnitStr: string | undefined;
  if (firstMatch) {
    // The unit-then-fee forms ("at $X" / "... or part thereof $X") capture
    // (unit, fee) instead of (fee, unit).
    const isUnitFirstForm = /\$?[\d.]+$/i.test(firstMatch[0]) && !/^\$?[\d.]+/.test(firstMatch[0]);
    firstFeeStr = isUnitFirstForm ? firstMatch[2] : firstMatch[1];
    firstUnitStr = isUnitFirstForm ? firstMatch[1] : firstMatch[2];
  }

  const subMatch = text.match(
    new RegExp(
      `\\$?([\\d.]+)\\s*(?:(?:for|per)\\s+)*(?:next\\s*|every\\s*)?sub\\.?(?:sequent)?\\.?\\s*((?:\\d+)?\\s*(?:${UNIT_ALT}))`,
      "i"
    )
  );

  if (firstMatch && firstFeeStr && firstUnitStr && subMatch) {
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

  // Positional shorthand: "$X for 1st hr; $Y/30min" — a second rate with no
  // "sub" keyword, implied by being the next clause after the first-block fee.
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

  // Pure per-minute (continuous), e.g. "$0.02 per min"
  const perMinMatch = text.match(/\$?([\d.]+)\s*(?:per|\/)\s*min(?:ute)?\b/i);
  if (perMinMatch && !/\d\s*min/i.test(text.replace(perMinMatch[0], ""))) {
    const pricing: Pricing = { type: "perMinute", feePerMin: Number(perMinMatch[1]) };
    if (capHint !== undefined) pricing.cap = capHint;
    return pricing;
  }

  // Uniform block: "$X per 30min" / "$X every 30min" / "$X/30min" / "$X per
  // hr" (same rate for every block including the first — modeled as tiered
  // w/ equal fees so "part thereof" rounding matches LTA's stated behaviour).
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

  // Flat entry: "$X per entry" / "$X/entry" / "$X per parking session"
  const entryMatch = text.match(/\$?([\d.]+)\s*(?:per\s*entry|\/entry|per\s*parking session)/i);
  if (entryMatch) {
    return { type: "flatEntry", fee: Number(entryMatch[1]) };
  }

  return { type: "unparsed", raw: priceText };
}

function chunksToPeriods(chunks: Chunk[]): RatePeriod[] {
  return chunks.map((c) => ({
    start: c.start,
    end: c.end,
    pricing: parsePriceText(c.priceText, extractCap(c.priceText)),
  }));
}

const SAME_AS_WEEKDAYS_RE = /^same\s+(?:as|s)\s+(?:weekdays?|wkdays)\.?$/i;
const SAME_AS_SATURDAY_RE = /^same\s+(?:as|s)\s+saturday\.?$/i;

function resolveWeekday(row: RawRateRow): RatePeriod[] {
  const beforeChunks = splitIntoChunks(row.weekdayBefore);
  const beforePeriods = chunksToPeriods(beforeChunks);

  const afterText = row.weekdayAfter.trim();
  if (afterText === "-" || afterText === "") return beforePeriods;

  const afterChunks = splitIntoChunks(afterText);
  const afterPeriods = chunksToPeriods(afterChunks);
  return [...beforePeriods, ...afterPeriods];
}

function resolveReferential(
  text: string,
  weekday: RatePeriod[],
  saturday: RatePeriod[] | null
): RatePeriod[] | null {
  const t = text.trim();
  if (SAME_AS_WEEKDAYS_RE.test(t)) return weekday;
  if (saturday && SAME_AS_SATURDAY_RE.test(t)) return saturday;
  // A bare "-" mirrors the weekdayAfter convention elsewhere in this source:
  // "nothing additional beyond what's already stated" (e.g. IKEA Tampines'
  // "Daily ... free" weekday rate with "-" for Sat/Sun).
  if (t === "-") return weekday;
  // Conservative: anything with an embedded modification ("Charges same as
  // weekdays; but ...") is too risky to auto-merge — fall through to normal
  // parsing, which will likely yield `unparsed` for the modified part.
  return null;
}

function main() {
  return (async () => {
    const dataDir = path.join(process.cwd(), "data");
    const rawRows: RawRateRow[] = JSON.parse(
      await readFile(path.join(dataDir, "raw-rates.json"), "utf-8")
    );

    const parsedRates: CarparkRates[] = [];
    const needsReview: { row: RawRateRow; reason: string }[] = [];

    for (const row of rawRows) {
      const weekday = resolveWeekday(row);

      const saturdayResolved =
        resolveReferential(row.saturday, weekday, null) ?? chunksToPeriods(splitIntoChunks(row.saturday));

      const sundayPhResolved =
        resolveReferential(row.sundayPh, weekday, saturdayResolved) ??
        chunksToPeriods(splitIntoChunks(row.sundayPh));

      const rates: CarparkRates = {
        name: row.carparkName,
        region: row.region,
        weekday,
        saturday: saturdayResolved,
        sundayPh: sundayPhResolved,
        notes:
          "Rates parsed by a local deterministic parser (no LLM available in this environment) from LTA OneMotoring — guide only, verify on-site.",
      };

      parsedRates.push(rates);

      const allPeriods = [...weekday, ...saturdayResolved, ...sundayPhResolved];
      const unparsedCount = allPeriods.filter((p) => p.pricing.type === "unparsed").length;
      if (unparsedCount > 0) {
        needsReview.push({
          row,
          reason: `${unparsedCount}/${allPeriods.length} rate period(s) could not be auto-parsed`,
        });
      }
    }

    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "parsed-rates.json"),
      JSON.stringify(parsedRates, null, 2)
    );
    await writeFile(
      path.join(dataDir, "needs-review.json"),
      JSON.stringify(needsReview, null, 2)
    );

    const totalPeriods = parsedRates.reduce(
      (sum, r) => sum + r.weekday.length + r.saturday.length + r.sundayPh.length,
      0
    );
    const unparsedPeriods = parsedRates.reduce(
      (sum, r) =>
        sum +
        [...r.weekday, ...r.saturday, ...r.sundayPh].filter((p) => p.pricing.type === "unparsed")
          .length,
      0
    );

    console.log(`Parsed ${parsedRates.length} carparks.`);
    console.log(
      `${totalPeriods - unparsedPeriods}/${totalPeriods} rate periods auto-parsed (${(
        (100 * (totalPeriods - unparsedPeriods)) /
        totalPeriods
      ).toFixed(1)}%).`
    );
    console.log(`${needsReview.length} carparks flagged in data/needs-review.json.`);
  })();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
