import { NextResponse } from "next/server";
import carparksData from "@/data/carparks.json";
import { computeCost } from "@/lib/costEngine";
import { geocodeAddress, haversineMeters } from "@/lib/geo";
import type { Carpark, CostResult, SearchRequest, SearchResponse } from "@/lib/types";

const carparks = carparksData as Carpark[];
const DEFAULT_RADIUS_METERS = 500;

function isValidLocalDatetime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

export async function POST(request: Request) {
  let body: SearchRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { address, startTime, endTime } = body;
  const radiusMeters =
    typeof body.radiusMeters === "number" && body.radiusMeters > 0
      ? body.radiusMeters
      : DEFAULT_RADIUS_METERS;

  if (typeof address !== "string" || !address.trim()) {
    return NextResponse.json({ error: "address is required." }, { status: 400 });
  }
  if (!isValidLocalDatetime(startTime) || !isValidLocalDatetime(endTime)) {
    return NextResponse.json(
      { error: "startTime and endTime must be datetime strings (YYYY-MM-DDTHH:MM)." },
      { status: 400 }
    );
  }
  if (endTime <= startTime) {
    return NextResponse.json({ error: "endTime must be after startTime." }, { status: 400 });
  }

  const geocoded = await geocodeAddress(address).catch(() => null);
  if (!geocoded) {
    return NextResponse.json(
      { error: `Could not find "${address}" in Singapore. Try a more specific address.` },
      { status: 404 }
    );
  }

  const origin = { lat: geocoded.lat, lng: geocoded.lng };

  const results: CostResult[] = carparks
    .map((carpark) => {
      const distanceMeters = haversineMeters(origin, { lat: carpark.lat, lng: carpark.lng });
      if (distanceMeters > radiusMeters) return null;

      const cost = computeCost(carpark, startTime, endTime);
      return { carpark, distanceMeters, ...cost };
    })
    .filter((r): r is CostResult => r !== null)
    .sort((a, b) => {
      // Carparks with an unresolvable (unparsed) rate are pushed to the end,
      // sorted by distance among themselves; priced carparks sort by cost.
      if (a.totalCost === null && b.totalCost === null) {
        return a.distanceMeters - b.distanceMeters;
      }
      if (a.totalCost === null) return 1;
      if (b.totalCost === null) return -1;
      return a.totalCost - b.totalCost;
    });

  const response: SearchResponse = {
    query: {
      address,
      lat: origin.lat,
      lng: origin.lng,
      startTime,
      endTime,
      radiusMeters,
    },
    results,
  };

  return NextResponse.json(response);
}
