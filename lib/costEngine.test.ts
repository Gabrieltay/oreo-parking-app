import { describe, expect, it } from "vitest";
import { computeCost, determineDayType } from "./costEngine";
import type { Carpark } from "./types";

function makeCarpark(overrides: Partial<Carpark> = {}): Carpark {
  return {
    id: "test-carpark",
    name: "Test Carpark",
    region: "Test",
    lat: 1.3,
    lng: 103.8,
    weekday: [],
    saturday: [],
    sundayPh: [],
    ...overrides,
  };
}

describe("determineDayType", () => {
  it("treats Saturday as saturday", () => {
    expect(determineDayType("2026-07-11")).toBe("saturday"); // Sat
  });
  it("treats Sunday as sundayPh", () => {
    expect(determineDayType("2026-07-12")).toBe("sundayPh"); // Sun
  });
  it("treats an ordinary weekday as weekday", () => {
    expect(determineDayType("2026-07-07")).toBe("weekday"); // Tue
  });
  it("treats a gazetted public holiday as sundayPh even on a weekday", () => {
    expect(determineDayType("2026-01-01")).toBe("sundayPh"); // Thu, New Year's Day
  });
});

describe("computeCost — tiered pricing", () => {
  it("charges the first block plus ceil'd subsequent blocks", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 30,
            firstBlockFee: 1.2,
            subsequentBlockMins: 30,
            subsequentFee: 0.6,
          },
        },
      ],
    });

    // Tue 2026-07-07, 08:00 -> 09:10 = 70 minutes.
    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T09:10");

    expect(result.hasUnparsed).toBe(false);
    // 1.2 (first 30 min) + ceil(40/30)=2 blocks * 0.6 = 1.2 -> 2.4 total
    expect(result.totalCost).toBeCloseTo(2.4, 5);
    expect(result.segments).toHaveLength(1);
  });

  it("applies a cap", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 30,
            firstBlockFee: 1,
            subsequentBlockMins: 30,
            subsequentFee: 1,
            cap: 5,
          },
        },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T20:00");
    expect(result.totalCost).toBe(5);
  });
});

describe("computeCost — flatEntry pricing", () => {
  it("charges the flat fee once for the entry window", () => {
    const carpark = makeCarpark({
      weekday: [{ start: "00:00", end: "00:00", pricing: { type: "flatEntry", fee: 5 } }],
    });

    const result = computeCost(carpark, "2026-07-07T10:00", "2026-07-07T16:00");
    expect(result.totalCost).toBe(5);
    expect(result.segments).toHaveLength(1);
  });

  it("does not re-charge a later flatEntry window entered after the original entry", () => {
    const carpark = makeCarpark({
      weekday: [
        { start: "00:00", end: "12:00", pricing: { type: "flatEntry", fee: 5 } },
        {
          start: "12:00",
          end: "24:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 30,
            firstBlockFee: 1,
            subsequentBlockMins: 30,
            subsequentFee: 0.5,
          },
        },
      ],
    });

    // Entry at 10:00 (flatEntry window), exit at 14:00 (crosses into tiered window).
    const result = computeCost(carpark, "2026-07-07T10:00", "2026-07-07T14:00");
    expect(result.segments).toHaveLength(2);
    // segment 1: 10:00-12:00 flatEntry -> 5
    // segment 2: 12:00-14:00 tiered, 120 min -> 1 + ceil(90/30)=3*0.5=1.5 -> 2.5
    expect(result.totalCost).toBeCloseTo(7.5, 5);
  });

  it("charges the flat fee when entry starts in a tiered window and crosses into the flatEntry window (Suntec-style)", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "07:00",
          end: "17:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 60,
            firstBlockFee: 2.6,
            subsequentBlockMins: 30,
            subsequentFee: 1.3,
          },
        },
        { start: "17:00", end: "04:00", pricing: { type: "flatEntry", fee: 3 } },
      ],
    });

    // Tue 2026-07-07, 15:20 -> 20:20.
    const result = computeCost(carpark, "2026-07-07T15:20", "2026-07-07T20:20");
    expect(result.segments).toHaveLength(2);
    // segment 1: 15:20-17:00 tiered, 100 min -> 2.6 + ceil(40/30)=2*1.3=2.6 -> 5.2
    // segment 2: 17:00-20:20 flatEntry, first flatEntry window of the day -> 3
    expect(result.totalCost).toBeCloseTo(8.2, 5);
    expect(result.segments[1].cost).toBe(3);

    // The tiered segment should expose a per-block breakdown: 1st hour,
    // then two 30-min blocks (matching the user's own manual calculation).
    expect(result.segments[0].blocks).toEqual([
      { start: "2026-07-07T15:20:00", end: "2026-07-07T16:20:00", label: "First 60 min", cost: 2.6 },
      { start: "2026-07-07T16:20:00", end: "2026-07-07T16:50:00", label: "+30 min", cost: 1.3 },
      { start: "2026-07-07T16:50:00", end: "2026-07-07T17:00:00", label: "+10 min", cost: 1.3 },
    ]);
    // A flatEntry segment has no block breakdown.
    expect(result.segments[1].blocks).toBeUndefined();
  });
});

describe("computeCost — overlapping periods (flatEntry shadowed by a broader period)", () => {
  it("prefers the narrower flatEntry window over a broader tiered window that happens to overlap it", () => {
    // Mirrors TripleOne Somerset's real rate table: an evening flatEntry
    // period (18:00-11:59) whose window is numerically contained within a
    // much broader daytime tiered period (07:00-17:59 doesn't overlap here,
    // but a mis-parsed "07:00-05:59" would) — array order alone must not
    // let the broader period win.
    const carpark = makeCarpark({
      weekday: [
        { start: "00:00", end: "06:59", pricing: { type: "tiered", firstBlockMins: 15, firstBlockFee: 0.55, subsequentBlockMins: 15, subsequentFee: 0.55 } },
        { start: "07:00", end: "17:59", pricing: { type: "tiered", firstBlockMins: 30, firstBlockFee: 1.64, subsequentBlockMins: 30, subsequentFee: 1.64 } },
        { start: "18:00", end: "11:59", pricing: { type: "flatEntry", fee: 2.51 } },
      ],
    });

    // Tue 2026-07-07, 15:20 -> 20:20 (the exact window from the bug report).
    const result = computeCost(carpark, "2026-07-07T15:20", "2026-07-07T20:20");
    expect(result.segments).toHaveLength(2);
    // segment 1: 15:20-18:00 tiered, 160 min -> 1.64 + ceil(130/30)=5*1.64=8.2 -> 9.84
    expect(result.segments[0].cost).toBeCloseTo(9.84, 5);
    // segment 2: 18:00-20:20 flatEntry -> 2.51 flat, not metered
    expect(result.segments[1].cost).toBe(2.51);
    expect(result.totalCost).toBeCloseTo(12.35, 5);
  });
});

describe("computeCost — tiered per-block breakdown", () => {
  it("omits the breakdown when only a single block applies", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 60,
            firstBlockFee: 2,
            subsequentBlockMins: 30,
            subsequentFee: 1,
          },
        },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T08:45");
    expect(result.segments[0].blocks).toBeUndefined();
  });

  it("stops the breakdown once a cap is reached", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 30,
            firstBlockFee: 1,
            subsequentBlockMins: 30,
            subsequentFee: 1,
            cap: 3,
          },
        },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T12:00");
    expect(result.totalCost).toBe(3);
    const blocks = result.segments[0].blocks ?? [];
    expect(blocks.reduce((sum, b) => sum + b.cost, 0)).toBeCloseTo(3, 5);
  });
});

describe("computeCost — perMinute pricing with cap", () => {
  it("charges per minute up to the cap", () => {
    const carpark = makeCarpark({
      weekday: [
        { start: "00:00", end: "00:00", pricing: { type: "perMinute", feePerMin: 0.1, cap: 8 } },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T10:00"); // 120 min
    expect(result.totalCost).toBe(8); // 120*0.1=12, capped at 8
  });
});

describe("computeCost — spans midnight into a different day type", () => {
  it("applies the overnight weekday period then switches to Saturday's own periods", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "22:00",
          end: "06:00",
          pricing: { type: "flatEntry", fee: 3 },
        },
      ],
      saturday: [
        {
          start: "00:00",
          end: "06:00",
          pricing: { type: "flatEntry", fee: 10 },
        },
      ],
    });

    // Fri 2026-07-10 23:00 -> Sat 2026-07-11 02:00.
    const result = computeCost(carpark, "2026-07-10T23:00", "2026-07-11T02:00");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].start).toContain("2026-07-10");
    expect(result.segments[1].start).toContain("2026-07-11");
    // Friday (weekday flatEntry) charges 3; Saturday is a new calendar day
    // so its flatEntry period is treated as a fresh entry and charges 10.
    expect(result.totalCost).toBeCloseTo(13, 5);
  });
});

describe("computeCost — unparsed rates", () => {
  it("flags hasUnparsed and returns a null total", () => {
    const carpark = makeCarpark({
      weekday: [{ start: "00:00", end: "00:00", pricing: { type: "unparsed", raw: "Season parking only" } }],
    });

    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T09:00");
    expect(result.hasUnparsed).toBe(true);
    expect(result.totalCost).toBeNull();
  });
});

describe("computeCost — surcharges", () => {
  it("adds a flat surcharge when the window overlaps", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: { type: "perMinute", feePerMin: 0 },
        },
      ],
      surcharges: [
        { start: "12:00", end: "14:00", days: ["Mon", "Tue", "Wed", "Thu", "Fri"], extraFee: 2, note: "Lunch surcharge" },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T11:00", "2026-07-07T13:00");
    expect(result.surchargesApplied).toEqual([{ note: "Lunch surcharge", fee: 2 }]);
    expect(result.totalCost).toBe(2);
  });
});
