// Shared types for the carpark rate pipeline and the runtime cost engine.

export type TieredPricing = {
  type: "tiered";
  firstBlockMins: number;
  firstBlockFee: number;
  // Optional single flat-fee block between the first block and the
  // recurring subsequent blocks, e.g. "1st hr free, 2nd hr $1.20, then
  // $0.40/15min" — a 3-tier structure the plain first/subsequent pair can't
  // express on its own.
  middleBlockMins?: number;
  middleBlockFee?: number;
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
  // Restricts this period to a carpark's first calendar-day entry of the
  // queried stay vs. a later one (e.g. a multi-day stay re-entering after
  // midnight) — for rates like "first hour free, first entry only".
  // Omitted means the period applies regardless of entry ordinal.
  entryScope?: "firstEntryOfDay" | "subsequentEntryOfDay";
  // This period does not apply on a public holiday (e.g. a free-first-hour
  // period that's explicitly withdrawn on PH) — the next best-matching
  // period for the window is used instead on those dates.
  excludeOnPublicHoliday?: boolean;
};

export type DayOfWeek = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

// One alternative condition under which a DayOverride applies to a given
// calendar date; a date matches if it satisfies every field that's set.
export type DayMatchClause = {
  daysOfWeek?: DayOfWeek[];
  eveOfPublicHoliday?: boolean;
};

// Some carparks group days differently from the standard weekday/Saturday/
// Sunday-PH split (e.g. "Friday & eve of PH" priced like Saturday instead of
// like a weekday). A DayOverride redirects a date to its own `periods`
// instead of the calendar-bucket periods whenever any clause in `match`
// applies to that date.
export type DayOverride = {
  id: string; // human-readable label, e.g. "friSatEvePh"
  match: DayMatchClause[];
  periods: RatePeriod[];
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
  dayOverrides?: DayOverride[];
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
