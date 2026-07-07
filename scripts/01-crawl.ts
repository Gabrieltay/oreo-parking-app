/**
 * Build-time only: crawl LTA OneMotoring's parking rates pages and parse
 * each page's HTML table into raw rows. Run with `tsx scripts/01-crawl.ts`.
 *
 * The page numbers below matched the regions at time of writing, but LTA
 * renumbers occasionally — this script logs each page's <title>/<h1> so you
 * can confirm the region mapping is still correct after a re-run.
 */
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE =
  "https://onemotoring.lta.gov.sg/content/onemotoring/home/owning/ongoing-car-costs/parking/parking_rates";

const PAGES = [
  { num: 1, region: "Orchard" },
  { num: 2, region: "Central, North & North East" },
  { num: 3, region: "East" },
  { num: 4, region: "South & CBD" },
  { num: 5, region: "West" },
  { num: 6, region: "Hotels" },
  { num: 7, region: "Singapore Attractions" },
];

export type RawRateRow = {
  region: string;
  carparkName: string;
  weekdayBefore: string;
  weekdayAfter: string;
  saturday: string;
  sundayPh: string;
};

async function fetchPage(num: number): Promise<string> {
  const url = `${BASE}.${num}.html`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function parseTable(html: string, region: string): RawRateRow[] {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || $("h1").first().text().trim();
  console.log(`  page title/heading: "${title}"`);

  const rows: RawRateRow[] = [];

  $("table")
    .first()
    .find("tr")
    .each((i, tr) => {
      if (i === 0) return; // header row
      const cells = $(tr)
        .find("td")
        .map((_, td) => $(td).text().trim())
        .get();
      if (cells.length < 5 || !cells[0]) return;

      rows.push({
        region,
        carparkName: cells[0],
        weekdayBefore: cells[1] ?? "",
        weekdayAfter: cells[2] ?? "",
        saturday: cells[3] ?? "",
        sundayPh: cells[4] ?? "",
      });
    });

  return rows;
}

async function main() {
  const allRows: RawRateRow[] = [];

  for (const page of PAGES) {
    console.log(`Fetching page ${page.num} (${page.region})...`);
    const html = await fetchPage(page.num);
    const rows = parseTable(html, page.region);
    console.log(`  parsed ${rows.length} rows`);
    allRows.push(...rows);
  }

  const dataDir = path.join(process.cwd(), "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "raw-rates.json"),
    JSON.stringify(allRows, null, 2)
  );

  console.log(`\nWrote ${allRows.length} total rows to data/raw-rates.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
