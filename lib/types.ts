// Shared types for the carpark rate pipeline and the runtime cost engine.

export type TieredPricing = {
  type: "tiered";
  firstBlockMins: number;
  firstBlockFee: number;
  subsequentBlockMins: number;
  subsequentFee: number;
  cap?: number;
};

export type FlatEntryPricing = {
  type: "flatEntry";
  fee: number;
};

export type PerMinutePricing = {
  type: "perMinute";
  feePerMin: number;
  cap?: number;
};

export type UnparsedPricing = {
  type: "unparsed";
  raw: string;
};

export type Pricing =
  | TieredPricing
  | FlatEntryPricing
  | PerMinutePricing
  | UnparsedPricing;

export type RatePeriod = {
  start: string; // "HH:MM" 24hr
  end: string; // "HH:MM" 24hr, may cross midnight
  pricing: Pricing;
};

export type Surcharge = {
  start: string;
  end: string;
  days: string[]; // e.g. ["Mon","Tue","Wed","Thu","Fri"]
  extraFee: number;
  note: string;
};

export type CarparkRates = {
  name: string;
  region: string;
  weekday: RatePeriod[];
  saturday: RatePeriod[];
  sundayPh: RatePeriod[];
  surcharges?: Surcharge[];
  notes?: string;
};

export type Carpark = CarparkRates & {
  id: string;
  address?: string;
  lat: number;
  lng: number;
};

export type DayType = "weekday" | "saturday" | "sundayPh";

export type CostBlock = {
  start: string; // ISO
  end: string; // ISO
  label: string;
  cost: number;
};

export type CostSegment = {
  start: string; // ISO
  end: string; // ISO
  ratePeriod: RatePeriod | null;
  cost: number | null; // null when unparsed / no matching rate
  note?: string;
  blocks?: CostBlock[]; // per-block breakdown for tiered pricing, when more than one block applies
};

export type CostResult = {
  carpark: Carpark;
  distanceMeters: number;
  totalCost: number | null; // null if any segment unparsed
  hasUnparsed: boolean;
  segments: CostSegment[];
  surchargesApplied: { note: string; fee: number }[];
};

export type SearchRequest = {
  address: string;
  startTime: string; // ISO
  endTime: string; // ISO
  radiusMeters?: number;
  // When set (e.g. a suggestion was picked), search from these coordinates
  // directly instead of re-geocoding `address` through OneMap.
  lat?: number;
  lng?: number;
};

export type SearchResponse = {
  query: {
    address: string;
    lat: number;
    lng: number;
    startTime: string;
    endTime: string;
    radiusMeters: number;
  };
  results: CostResult[];
};
