import { NextResponse } from "next/server";
import carparksData from "@/data/carparks.json";
import { searchOneMap } from "@/lib/geo";
import type { Carpark } from "@/lib/types";

const carparks = carparksData as Carpark[];
const LOCAL_LIMIT = 5;
const TOTAL_LIMIT = 8;

// Carparks we already know about, matched by name, so e.g. "triple" finds
// "TripleOne Somerset" even though OneMap's own search won't (it only
// matches whole tokens, and "TripleOne" is indexed as one word).
function searchLocalCarparks(query: string) {
  const q = query.toLowerCase();
  return carparks
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, LOCAL_LIMIT)
    .map((c) => ({
      searchVal: c.name,
      address: c.address ?? c.region,
      lat: c.lat,
      lng: c.lng,
      source: "carpark" as const,
      carparkId: c.id,
    }));
}

// Thin server-side proxy so the client never needs to hit OneMap directly
// (avoids CORS uncertainty) and reuses the same client used at request time
// in /api/search.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const localMatches = searchLocalCarparks(q);

  try {
    const oneMapResults = await searchOneMap(q);
    const oneMapMatches = oneMapResults
      .slice(0, Math.max(TOTAL_LIMIT - localMatches.length, 0))
      .map((r) => ({
        searchVal: r.searchVal,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        source: "onemap" as const,
      }));
    return NextResponse.json({ results: [...localMatches, ...oneMapMatches] });
  } catch {
    return NextResponse.json({ results: localMatches });
  }
}
