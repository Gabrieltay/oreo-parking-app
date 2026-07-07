/**
 * Build-time only: converts LTA's free-text parking rate strings into
 * structured JSON via the Anthropic API. Run with
 * `tsx scripts/02-extract-rates.ts` after `01-crawl.ts`.
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawRateRow } from "./01-crawl";
import type { CarparkRates } from "../lib/types";

// Latest Sonnet model at time of writing. The original spec referenced
// "claude-sonnet-4-6"; swap this constant if a newer Sonnet is preferred.
const MODEL = "claude-sonnet-5";
const BATCH_SIZE = 10;

const SCHEMA_DESCRIPTION = `
Respond with a JSON array only — no prose, no markdown fences. One object per
input row, in the same order as the input, matching this TypeScript type:

type RatePeriod = {
  start: string;        // "HH:MM" 24hr
  end: string;           // "HH:MM" 24hr, may cross midnight (e.g. end < start)
  pricing:
    | { type: "tiered"; firstBlockMins: number; firstBlockFee: number;
        // Optional single flat-fee block between the first block and the
        // recurring subsequent blocks, for 3-tier rates like "1st hr free,
        // 2nd hr $1.20, then $0.40/15min".
        middleBlockMins?: number; middleBlockFee?: number;
        subsequentBlockMins: number; subsequentFee: number; cap?: number }
    | { type: "flatEntry"; fee: number }
    | { type: "perMinute"; feePerMin: number; cap?: number }
    | { type: "unparsed"; raw: string };
  // Restricts this period to a first-entry-of-the-day rate vs. a later
  // same-day re-entry (e.g. "first hour free, first entry only"). Omit when
  // the rate applies regardless of entry ordinal.
  entryScope?: "firstEntryOfDay" | "subsequentEntryOfDay";
  // True when this period explicitly does not apply on a public holiday
  // (e.g. a free first hour withdrawn on PH) — a broader fallback
  // RatePeriod for the same window should also be included for that case.
  excludeOnPublicHoliday?: boolean;
};
type DayOverride = {
  id: string; // short label, e.g. "friSatEvePh"
  // Alternative conditions (any one matching redirects the date to this
  // override's periods instead of the normal weekday/saturday/sundayPh
  // bucket for that calendar date).
  match: { daysOfWeek?: ("Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun")[]; eveOfPublicHoliday?: boolean }[];
  periods: RatePeriod[];
};
type CarparkRates = {
  name: string;
  region: string;
  weekday: RatePeriod[];
  saturday: RatePeriod[];
  sundayPh: RatePeriod[];
  // Only needed when the source text groups days differently from the plain
  // weekday/Saturday/Sunday-PH split (e.g. "Friday/Saturday & eve of PH"
  // priced like Saturday, or "Mon-Thu" vs "Fri/Sat/Sun/PH"). Put the
  // Mon-Thu-only rate in "weekday" itself, and add an override redirecting
  // Friday (and eve-of-PH, if mentioned) to the same periods as "saturday".
  dayOverrides?: DayOverride[];
  surcharges?: { start: string; end: string; days: string[]; extraFee: number; note: string }[];
  notes?: string;
};

Rules:
- "weekdayBefore"/"weekdayAfter" input columns both apply to weekdays; combine
  them into one "weekday" array of consecutive RatePeriods covering the full
  24 hours where the source text implies a time-of-day split (e.g. "before
  5pm" / "after 5pm"). If they don't reference a time split, treat them as
  describing the same weekday schedule and reconcile into a single period list.
- If the source text scopes a rate to specific days (e.g. "Mon-Thurs",
  "Friday/Saturday & eve of PH", "Fri/Sat/Sun/PH") rather than the plain
  weekday/Saturday/Sunday-PH split, do not silently drop the day-scoping:
  put the Mon-Thu rate in "weekday", the Sat/Sun/PH-inclusive rate in
  "saturday" and "sundayPh" as appropriate, and add a "dayOverrides" entry
  redirecting any day mentioned in the grouping that the plain calendar
  split wouldn't already cover (typically Friday, and "eve of PH") to the
  matching periods.
- If the source text conditions a rate on entry ordinal (e.g. "first entry
  only", "first hour of subsequent same-day entry") or explicitly excludes
  public holidays from a rate, express that with "entryScope" and
  "excludeOnPublicHoliday" on the relevant RatePeriod(s), and include a
  second, unrestricted RatePeriod for the same window covering the
  complementary case (subsequent entries / public holidays) instead of
  marking the whole thing "unparsed".
- Use type "unparsed" with the original raw string when the text is ambiguous,
  contradictory, refers to per-entry negotiated/season-parking-only rates with
  no walk-in structure, or you are not confident of the exact numbers. Never
  guess numbers.
- Preserve any "additional/surcharge" mentions (e.g. flat lunch-hour or
  event-day fees) as "surcharges" entries instead of folding them into the
  base pricing.
- Put any caveats (effective dates, GST treatment, "rates subject to change")
  in "notes".
`;

async function extractBatch(
  client: Anthropic,
  rows: RawRateRow[]
): Promise<CarparkRates[]> {
  const input = rows.map((r) => ({
    name: r.carparkName,
    region: r.region,
    weekdayBefore: r.weekdayBefore,
    weekdayAfter: r.weekdayAfter,
    saturday: r.saturday,
    sundayPh: r.sundayPh,
  }));

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: `${SCHEMA_DESCRIPTION}\n\nInput rows:\n${JSON.stringify(
          input,
          null,
          2
        )}`,
      },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const jsonText = text.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(jsonText) as CarparkRates[];

  if (parsed.length !== rows.length) {
    throw new Error(
      `Model returned ${parsed.length} rows for a batch of ${rows.length}`
    );
  }

  return parsed;
}

function hasUnparsed(rates: CarparkRates): boolean {
  const overridePeriods = (rates.dayOverrides ?? []).flatMap((o) => o.periods);
  return [...rates.weekday, ...rates.saturday, ...rates.sundayPh, ...overridePeriods].some(
    (p) => p.pricing.type === "unparsed"
  );
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to run this script.");
  }
  const client = new Anthropic({ apiKey });

  const dataDir = path.join(process.cwd(), "data");
  const rawRows: RawRateRow[] = JSON.parse(
    await readFile(path.join(dataDir, "raw-rates.json"), "utf-8")
  );

  const parsedRates: CarparkRates[] = [];
  const needsReview: { row: RawRateRow; reason: string }[] = [];

  for (let i = 0; i < rawRows.length; i += BATCH_SIZE) {
    const batch = rawRows.slice(i, i + BATCH_SIZE);
    console.log(
      `Extracting rows ${i + 1}-${i + batch.length} of ${rawRows.length}...`
    );

    let batchResults: CarparkRates[];
    try {
      batchResults = await extractBatch(client, batch);
    } catch (err) {
      console.error(`  batch failed: ${(err as Error).message}`);
      for (const row of batch) {
        needsReview.push({ row, reason: `batch extraction failed: ${(err as Error).message}` });
      }
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const rates = batchResults[j];
      parsedRates.push(rates);
      if (hasUnparsed(rates)) {
        needsReview.push({
          row: batch[j],
          reason: "one or more rate periods marked unparsed by the model",
        });
      }
    }
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "parsed-rates.json"),
    JSON.stringify(parsedRates, null, 2)
  );

  if (needsReview.length > 0) {
    await writeFile(
      path.join(dataDir, "needs-review.json"),
      JSON.stringify(needsReview, null, 2)
    );
  }

  console.log(
    `\nWrote ${parsedRates.length} parsed carparks to data/parsed-rates.json` +
      (needsReview.length > 0
        ? ` (${needsReview.length} flagged in data/needs-review.json)`
        : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
