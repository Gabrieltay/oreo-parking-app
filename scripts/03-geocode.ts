/**
 * Build-time only: geocode each parsed carpark's name via OneMap Singapore
 * and write the final merged dataset the running app reads.
 * Run with `tsx scripts/03-geocode.ts` after `02-extract-rates.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { searchOneMap } from "../lib/geo";
import type { CarparkRates, Carpark } from "../lib/types";

// OneMap asks integrators not to hammer the search endpoint.
const REQUEST_DELAY_MS = 250;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const dataDir = path.join(process.cwd(), "data");
  const parsedRates: CarparkRates[] = JSON.parse(
    await readFile(path.join(dataDir, "parsed-rates.json"), "utf-8")
  );

  let needsReview: { row: unknown; reason: string }[] = [];
  try {
    needsReview = JSON.parse(
      await readFile(path.join(dataDir, "needs-review.json"), "utf-8")
    );
  } catch {
    // no needs-review.json yet — that's fine
  }

  const carparks: Carpark[] = [];
  const usedIds = new Set<string>();

  for (const [i, rates] of parsedRates.entries()) {
    console.log(`Geocoding ${i + 1}/${parsedRates.length}: ${rates.name}...`);

    let match;
    try {
      const results = await searchOneMap(rates.name);
      match = results[0];
    } catch (err) {
      console.error(`  search failed: ${(err as Error).message}`);
    }

    if (!match) {
      console.warn(`  no OneMap match — flagged for review`);
      needsReview.push({
        row: { name: rates.name, region: rates.region },
        reason: "OneMap search returned no results",
      });
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    let id = slugify(rates.name);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${slugify(rates.name)}-${suffix++}`;
    }
    usedIds.add(id);

    carparks.push({
      ...rates,
      id,
      address: match.address,
      lat: match.lat,
      lng: match.lng,
    });

    await sleep(REQUEST_DELAY_MS);
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "carparks.json"),
    JSON.stringify(carparks, null, 2)
  );
  await writeFile(
    path.join(dataDir, "needs-review.json"),
    JSON.stringify(needsReview, null, 2)
  );

  console.log(
    `\nWrote ${carparks.length} geocoded carparks to data/carparks.json` +
      (needsReview.length > 0
        ? ` (${needsReview.length} flagged in data/needs-review.json)`
        : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
