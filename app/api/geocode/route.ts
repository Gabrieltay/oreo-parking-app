import { NextResponse } from "next/server";
import { searchOneMap } from "@/lib/geo";

// Thin server-side proxy so the client never needs to hit OneMap directly
// (avoids CORS uncertainty) and reuses the same client used at request time
// in /api/search.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchOneMap(q);
    return NextResponse.json({ results: results.slice(0, 8) });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
