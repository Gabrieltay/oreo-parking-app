/**
 * Build-time only: fetch each carpark's detail from SGCarMart's API by id
 * (1..MAX_ID) and store every *valid* result as data/sgcarmart/<id>.json.
 * Run with `tsx scripts/fetch-sgcarmart.ts` (or `npm run fetch:sgcarmart`).
 *
 * The API wraps its payload as { data: { success, data, message } }. We only
 * keep responses where data.success === true, writing the inner carpark object.
 * Requests run in small concurrent batches to stay polite to the server.
 *
 * Resumable: ids that already have a data/sgcarmart/<id>.json file are skipped,
 * so re-running continues where a previous run left off. If the server returns
 * 429 (rate limited), the run aborts cleanly — just re-run later to continue.
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const BASE = "https://www.sgcarmart.com/api/carpark/fetch-carpark-detail-data";
const MAX_ID = Number(process.env.MAX_ID ?? 1235);
const CONCURRENCY = 10; // ids fetched in parallel per batch
const BATCH_DELAY_MS = 200; // pause between batches

type CarparkDetail = {
  id: number;
  name: string;
  availability: number | null;
  location: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  shopping: number;
  office: number;
  hotel: number;
  placesOfInterest: number;
  wd1: string | null;
  wd2: string | null;
  sat: string | null;
  sun: string | null;
  remarks: string | null;
};

type ApiResponse = {
  data?: {
    success?: boolean;
    data?: CarparkDetail;
    message?: string;
    errors?: string;
  };
};

const outDir = path.join(process.cwd(), "data", "sgcarmart");

/** Thrown when the server rate-limits us so the run can abort and be resumed. */
class RateLimitError extends Error {
  constructor(public id: number) {
    super(`Rate limited (HTTP 429) at id=${id}`);
  }
}

/** Returns the carpark detail if valid, or null for a not-found / bad response. */
async function fetchCarpark(id: number): Promise<CarparkDetail | null> {
  const url = `${BASE}?id=${id}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new RateLimitError(id);
  }
  if (!res.ok) {
    console.warn(`  id=${id}: HTTP ${res.status} ${res.statusText}`);
    return null;
  }

  const json = (await res.json()) as ApiResponse;
  const payload = json.data;
  if (!payload?.success || !payload.data) return null;

  return payload.data;
}

/** Ids that already have a saved <id>.json — used to resume a partial run. */
async function loadDoneIds(): Promise<Set<number>> {
  try {
    const files = await readdir(outDir);
    const ids = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => Number(f.replace(/\.json$/, "")))
      .filter((n) => Number.isFinite(n));
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const done = await loadDoneIds();
  const allIds = Array.from({ length: MAX_ID }, (_, i) => i + 1);
  const ids = allIds.filter((id) => !done.has(id));

  if (done.size > 0) {
    console.log(
      `Resuming: ${done.size} ids already saved, ${ids.length} of ${MAX_ID} left to fetch.`
    );
  }
  if (ids.length === 0) {
    console.log("Nothing to do — all ids already fetched.");
    return;
  }

  let valid = 0;
  let invalid = 0;
  let rateLimited = false;

  for (let start = 0; start < ids.length; start += CONCURRENCY) {
    const batch = ids.slice(start, start + CONCURRENCY);

    let results: { id: number; detail: CarparkDetail | null }[];
    try {
      results = await Promise.all(
        batch.map(async (id) => {
          const detail = await fetchCarpark(id);
          return { id, detail };
        })
      );
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`\n⚠ ${err.message}. Stopping — re-run later to resume.`);
        rateLimited = true;
        break;
      }
      throw err;
    }

    for (const { id, detail } of results) {
      if (!detail) {
        invalid++;
        continue;
      }
      await writeFile(
        path.join(outDir, `${id}.json`),
        JSON.stringify(detail, null, 2)
      );
      valid++;
      console.log(`  id=${id}: saved "${detail.name}"`);
    }

    console.log(
      `Progress: ${Math.min(start + CONCURRENCY, ids.length)}/${ids.length} ` +
        `(${valid} valid, ${invalid} invalid)`
    );

    if (start + CONCURRENCY < ids.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const total = done.size + valid;
  console.log(
    `\n${rateLimited ? "Paused" : "Done"}. Wrote ${valid} carparks this run ` +
      `(${total} total in data/sgcarmart/, ${invalid} ids skipped).`
  );
  if (rateLimited) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
