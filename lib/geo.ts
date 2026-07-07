const EARTH_RADIUS_METERS = 6371000;

export type LatLng = { lat: number; lng: number };

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_METERS * c;
}

export type OneMapSearchResult = {
  searchVal: string;
  blockNo: string;
  building: string;
  address: string;
  postal: string;
  lat: number;
  lng: number;
};

type OneMapRawResult = {
  SEARCHVAL: string;
  BLK_NO: string;
  BUILDING: string;
  ADDRESS: string;
  POSTAL: string;
  LATITUDE: string;
  LONGITUDE: string;
};

type OneMapRawResponse = {
  found: number;
  totalNumPages: number;
  pageNum: number;
  results: OneMapRawResult[];
};

const ONEMAP_SEARCH_URL =
  "https://www.onemap.gov.sg/api/common/elastic/search";

/**
 * Free-text search against OneMap Singapore (no API key needed for basic
 * search). Returns raw candidate results, closest match first as ranked by
 * OneMap itself.
 */
export async function searchOneMap(
  query: string
): Promise<OneMapSearchResult[]> {
  const url = new URL(ONEMAP_SEARCH_URL);
  url.searchParams.set("searchVal", query);
  url.searchParams.set("returnGeom", "Y");
  url.searchParams.set("getAddrDetails", "Y");
  url.searchParams.set("pageNum", "1");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(
      `OneMap search failed for "${query}": ${res.status} ${res.statusText}`
    );
  }

  const data = (await res.json()) as OneMapRawResponse;

  return data.results.map((r) => ({
    searchVal: r.SEARCHVAL,
    blockNo: r.BLK_NO,
    building: r.BUILDING,
    address: r.ADDRESS,
    postal: r.POSTAL,
    lat: parseFloat(r.LATITUDE),
    lng: parseFloat(r.LONGITUDE),
  }));
}

/**
 * Geocode a single address/place name to its best-match lat/lng. Returns
 * null (never guesses) when OneMap has no results.
 */
export async function geocodeAddress(
  query: string
): Promise<OneMapSearchResult | null> {
  const results = await searchOneMap(query);
  return results[0] ?? null;
}
