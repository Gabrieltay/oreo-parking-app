"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CostResult, DayType, Pricing, RatePeriod, SearchResponse } from "@/lib/types";

const DAY_TYPE_LABELS: Record<DayType, string> = {
  weekday: "Weekdays",
  saturday: "Saturday",
  sundayPh: "Sunday & PH",
};

type OneMapSuggestion = {
  searchVal: string;
  address: string;
  lat: number;
  lng: number;
};

const RADIUS_OPTIONS = [250, 500, 1000, 2000];

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toDatetimeLocalValue(d);
}

function defaultEnd(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  d.setHours(d.getHours() + 2);
  return toDatetimeLocalValue(d);
}

function formatCurrency(amount: number): string {
  return `S$${amount.toFixed(2)}`;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

function formatTime(iso: string): string {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : iso;
}

function formatPeriodRange(period: RatePeriod): string {
  return period.start === period.end ? "24 hours" : `${period.start}–${period.end}`;
}

function formatRate(pricing: Pricing | undefined): string | null {
  if (!pricing) return null;
  switch (pricing.type) {
    case "tiered": {
      const base = `First ${pricing.firstBlockMins} min ${formatCurrency(
        pricing.firstBlockFee
      )}, then ${formatCurrency(pricing.subsequentFee)} / ${pricing.subsequentBlockMins} min`;
      return pricing.cap !== undefined ? `${base} (cap ${formatCurrency(pricing.cap)})` : base;
    }
    case "perMinute": {
      const base = `${formatCurrency(pricing.feePerMin)} / min`;
      return pricing.cap !== undefined ? `${base} (cap ${formatCurrency(pricing.cap)})` : base;
    }
    case "flatEntry":
      return `Flat ${formatCurrency(pricing.fee)} entry`;
    case "unparsed":
      return pricing.raw;
  }
}

export default function Home() {
  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState<OneMapSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [radiusMeters, setRadiusMeters] = useState(500);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (address.trim().length < 2) {
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`);
        const data: { results: OneMapSuggestion[] } = await res.json();
        setSuggestions(data.results);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [address]);

  const canSubmit = useMemo(
    () => address.trim().length > 0 && startTime && endTime && endTime > startTime && !loading,
    [address, startTime, endTime, loading]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setShowSuggestions(false);
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, startTime, endTime, radiusMeters }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
      } else {
        setResponse(data as SearchResponse);
      }
    } catch {
      setError("Could not reach the search API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Singapore Commercial Parking Cost Finder
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Enter a location and how long you&apos;ll park — see nearby commercial carparks
          ranked cheapest first for that exact duration.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="relative flex flex-col gap-1">
          <label htmlFor="address" className="text-sm font-medium">
            Location
          </label>
          <input
            id="address"
            type="text"
            required
            autoComplete="off"
            placeholder="e.g. Suntec City, Raffles Place, 238801"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setShowSuggestions(true);
              if (e.target.value.trim().length < 2) setSuggestions([]);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {suggestions.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    onMouseDown={() => {
                      setAddress(s.searchVal || s.address);
                      setShowSuggestions(false);
                    }}
                  >
                    <div className="font-medium">{s.searchVal}</div>
                    <div className="text-xs text-neutral-500">{s.address}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="startTime" className="text-sm font-medium">
              Start
            </label>
            <input
              id="startTime"
              type="datetime-local"
              required
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="endTime" className="text-sm font-medium">
              End
            </label>
            <input
              id="endTime"
              type="datetime-local"
              required
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="radius" className="text-sm font-medium">
            Search radius
          </label>
          <select
            id="radius"
            value={radiusMeters}
            onChange={(e) => setRadiusMeters(Number(e.target.value))}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          >
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r >= 1000 ? `${r / 1000} km` : `${r} m`}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {loading ? "Searching…" : "Find cheapest parking"}
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {response && (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-neutral-500">
            {response.results.length} carpark{response.results.length === 1 ? "" : "s"} within{" "}
            {formatDistance(response.query.radiusMeters)} of &quot;{response.query.address}&quot;
          </p>

          <ul className="flex flex-col gap-3">
            {response.results.map((result: CostResult, i: number) => {
              const key = result.carpark.id;
              const isExpanded = !!expanded[key];
              return (
                <li
                  key={key}
                  className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-neutral-400">#{i + 1}</span>
                        <h2 className="font-medium">{result.carpark.name}</h2>
                        {result.hasUnparsed && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                            verify on-site
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {result.carpark.address ?? result.carpark.region} ·{" "}
                        {formatDistance(result.distanceMeters)}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold">
                        {result.totalCost !== null ? formatCurrency(result.totalCost) : "—"}
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                        className="text-xs text-neutral-500 underline underline-offset-2"
                      >
                        {isExpanded ? "Hide breakdown" : "Show breakdown"}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
                      <ul className="flex flex-col gap-1">
                        {result.segments.map((seg, si) => {
                          const rate = formatRate(seg.ratePeriod?.pricing);
                          return (
                            <li key={si} className="flex flex-col gap-0.5">
                              <div className="flex justify-between gap-2">
                                <span className="text-neutral-500">
                                  {formatTime(seg.start)}–{formatTime(seg.end)}
                                </span>
                                <span>{seg.cost !== null ? formatCurrency(seg.cost) : "—"}</span>
                              </div>
                              {(rate || seg.note) && (
                                <span className="text-xs text-neutral-400">
                                  {rate}
                                  {rate && seg.note ? " · " : ""}
                                  {seg.note}
                                </span>
                              )}
                              {seg.blocks && seg.blocks.length > 0 && (
                                <ul className="mt-1 flex flex-col gap-0.5 border-l border-neutral-200 pl-2 dark:border-neutral-800">
                                  {seg.blocks.map((b, bi) => (
                                    <li
                                      key={bi}
                                      className="flex justify-between gap-2 text-xs text-neutral-500"
                                    >
                                      <span>
                                        {formatTime(b.start)}–{formatTime(b.end)} ({b.label})
                                      </span>
                                      <span>{formatCurrency(b.cost)}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                        {result.surchargesApplied.map((s, si) => (
                          <li key={`s-${si}`} className="flex justify-between gap-2">
                            <span className="text-neutral-500">{s.note}</span>
                            <span>{formatCurrency(s.fee)}</span>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                        <p className="mb-1 text-xs font-semibold text-neutral-500">
                          Parking rates
                        </p>
                        <ul className="flex flex-col gap-2">
                          {(["weekday", "saturday", "sundayPh"] as DayType[]).map((dayType) => {
                            const periods = result.carpark[dayType];
                            if (!periods.length) return null;
                            return (
                              <li key={dayType}>
                                <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                                  {DAY_TYPE_LABELS[dayType]}
                                </p>
                                <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                                  {periods.map((p, pi) => (
                                    <li
                                      key={pi}
                                      className="flex justify-between gap-2 text-xs text-neutral-500"
                                    >
                                      <span>{formatPeriodRange(p)}</span>
                                      <span className="text-right">{formatRate(p.pricing)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            );
                          })}
                        </ul>

                        {result.carpark.surcharges && result.carpark.surcharges.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                              Surcharges
                            </p>
                            <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                              {result.carpark.surcharges.map((s, si) => (
                                <li
                                  key={si}
                                  className="flex justify-between gap-2 text-xs text-neutral-500"
                                >
                                  <span>
                                    {s.note} ({s.days.join(", ")} {s.start}–{s.end})
                                  </span>
                                  <span>{formatCurrency(s.extraFee)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {result.carpark.notes && (
                          <p className="mt-2 text-xs text-neutral-400">{result.carpark.notes}</p>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {response.results.length === 0 && (
            <p className="text-sm text-neutral-500">
              No commercial carparks found within this radius. Try widening the search.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
