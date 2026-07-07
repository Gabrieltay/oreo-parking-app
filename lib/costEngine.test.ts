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

describe("computeCost — The Cathay am/pm typo regression", () => {
  it("charges the evening flatEntry fee instead of the daytime tiered rate leaking past 6pm", () => {
    // Mirrors The Cathay's real (corrected) rate table: a daytime tiered
    // period ending 17:59, followed by an evening flatEntry period. The
    // source data originally mis-parsed the daytime end as "05:59" (am)
    // instead of "17:59" (pm), which made it swallow the whole evening.
    const carpark = makeCarpark({
      weekday: [
        { start: "08:00", end: "17:59", pricing: { type: "tiered", firstBlockMins: 60, firstBlockFee: 1.8, subsequentBlockMins: 60, subsequentFee: 1.8 } },
        { start: "18:00", end: "07:59", pricing: { type: "flatEntry", fee: 2.95 } },
      ],
    });

    const result = computeCost(carpark, "2026-07-07T15:00", "2026-07-07T20:00");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[1].cost).toBe(2.95);
    expect(result.totalCost).toBeCloseTo(8.35, 5);
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

describe("computeCost — tiered pricing with a middle block", () => {
  it("charges first block, one flat middle block, then ceil'd subsequent blocks (IMM-style 3-tier rate)", () => {
    const carpark = makeCarpark({
      weekday: [
        {
          start: "00:00",
          end: "00:00",
          pricing: {
            type: "tiered",
            firstBlockMins: 60,
            firstBlockFee: 1,
            middleBlockMins: 60,
            middleBlockFee: 2,
            subsequentBlockMins: 30,
            subsequentFee: 0.5,
          },
        },
      ],
    });

    // 200 minutes: 1 (first 60) + 2 (next 60) + ceil(80/30)=3*0.5=1.5 -> 4.5
    const result = computeCost(carpark, "2026-07-07T08:00", "2026-07-07T11:20");
    expect(result.totalCost).toBeCloseTo(4.5, 5);
    expect(result.segments[0].blocks).toEqual([
      { start: "2026-07-07T08:00:00", end: "2026-07-07T09:00:00", label: "First 60 min", cost: 1 },
      { start: "2026-07-07T09:00:00", end: "2026-07-07T10:00:00", label: "+60 min", cost: 2 },
      { start: "2026-07-07T10:00:00", end: "2026-07-07T10:30:00", label: "+30 min", cost: 0.5 },
      { start: "2026-07-07T10:30:00", end: "2026-07-07T11:00:00", label: "+30 min", cost: 0.5 },
      { start: "2026-07-07T11:00:00", end: "2026-07-07T11:20:00", label: "+20 min", cost: 0.5 },
    ]);
  });
});

describe("computeCost — dayOverrides (Jem-style Friday/eve-of-PH grouped with Saturday)", () => {
  function makeJemStyleCarpark() {
    const weekdayPeriod = {
      start: "00:00" as const,
      end: "00:00" as const,
      pricing: { type: "tiered" as const, firstBlockMins: 60, firstBlockFee: 2.18, subsequentBlockMins: 15, subsequentFee: 0.55 },
    };
    const fridayStylePeriod = {
      start: "00:00" as const,
      end: "00:00" as const,
      pricing: { type: "tiered" as const, firstBlockMins: 60, firstBlockFee: 2.73, subsequentBlockMins: 15, subsequentFee: 0.65 },
    };
    return makeCarpark({
      weekday: [weekdayPeriod],
      saturday: [fridayStylePeriod],
      dayOverrides: [
        { id: "friSatEvePh", match: [{ daysOfWeek: ["Fri"] }, { eveOfPublicHoliday: true }], periods: [fridayStylePeriod] },
      ],
    });
  }

  it("uses the ordinary weekday schedule on a Thursday", () => {
    const result = computeCost(makeJemStyleCarpark(), "2026-07-09T08:00", "2026-07-09T09:00"); // Thu
    expect(result.totalCost).toBeCloseTo(2.18, 5);
  });

  it("redirects a real Friday to the Saturday-style schedule via the override", () => {
    const result = computeCost(makeJemStyleCarpark(), "2026-07-10T08:00", "2026-07-10T09:00"); // Fri
    expect(result.totalCost).toBeCloseTo(2.73, 5);
  });

  it("redirects the eve of a public holiday to the Saturday-style schedule even on a weekday", () => {
    // 2026-04-02 is a Thursday and the eve of Good Friday (2026-04-03).
    const result = computeCost(makeJemStyleCarpark(), "2026-04-02T08:00", "2026-04-02T09:00");
    expect(result.totalCost).toBeCloseTo(2.73, 5);
  });
});

describe("computeCost — entryScope and excludeOnPublicHoliday (IMM-style first-entry-only free hour)", () => {
  function makeImmStyleCarpark() {
    const firstEntryPeriod = {
      start: "00:00" as const,
      end: "00:00" as const,
      entryScope: "firstEntryOfDay" as const,
      excludeOnPublicHoliday: true,
      pricing: {
        type: "tiered" as const,
        firstBlockMins: 60,
        firstBlockFee: 0,
        middleBlockMins: 60,
        middleBlockFee: 1.2,
        subsequentBlockMins: 15,
        subsequentFee: 0.4,
      },
    };
    const fallbackPeriod = {
      start: "00:00" as const,
      end: "00:00" as const,
      pricing: {
        type: "tiered" as const,
        firstBlockMins: 60,
        firstBlockFee: 1.2,
        subsequentBlockMins: 15,
        subsequentFee: 0.4,
      },
    };
    return makeCarpark({
      weekday: [firstEntryPeriod, fallbackPeriod],
      sundayPh: [firstEntryPeriod, fallbackPeriod],
    });
  }

  it("gives the free first hour on a first-entry weekday stay", () => {
    const result = computeCost(makeImmStyleCarpark(), "2026-07-07T08:00", "2026-07-07T09:30"); // Tue, 90 min
    expect(result.totalCost).toBeCloseTo(1.2, 5); // free 1st hr + 2nd hr (part thereof) $1.20
  });

  it("does not give the free first hour on a public holiday", () => {
    // 2026-01-01 is New Year's Day (PH); dayType resolves to sundayPh.
    const result = computeCost(makeImmStyleCarpark(), "2026-01-01T08:00", "2026-01-01T09:30"); // 90 min
    expect(result.totalCost).toBeCloseTo(2.0, 5); // 1.20 (1st hr) + ceil(30/15)=2*0.4=0.8
  });

  it("only gives the free hour on the first calendar day of a multi-day stay, not later re-entries", () => {
    // Mon 23:00 -> Tue 01:30: first chunk (23:00-24:00, 60 min) is the first
    // entry of the day and is free; the second calendar day is treated as a
    // fresh entry, so its first 90 min are charged at the fallback rate.
    const result = computeCost(makeImmStyleCarpark(), "2026-07-06T23:00", "2026-07-07T01:30");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].cost).toBeCloseTo(0, 5);
    expect(result.segments[1].cost).toBeCloseTo(2.0, 5);
    expect(result.totalCost).toBeCloseTo(2.0, 5);
  });
});
