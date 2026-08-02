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
  source?: "carpark" | "onemap";
  carparkId?: string;
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

function googleMapsDirectionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function openDirections(lat: number, lng: number): void {
  const url = googleMapsDirectionsUrl(lat, lng);
  if (isStandalone()) {
    // In PWA standalone mode, window.open() spawns a separate browser window
    // that hands off to the Maps app but never closes itself, leaving a blank
    // page behind. Navigate the current window instead.
    window.location.href = url;
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
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
  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const [startTime, setStartTime] = useState(defaultStart);
  const [endTime, setEndTime] = useState(defaultEnd);
  const [radiusMeters, setRadiusMeters] = useState(500);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

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

  function handleUseCurrentLocation() {
    if (!("geolocation" in navigator)) {
      setLocationError("Geolocation is not supported by this browser.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setAddress(`Current location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`);
        setSelectedCoords({ lat: latitude, lng: longitude });
        setSuggestions([]);
        setShowSuggestions(false);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enter an address instead."
            : "Could not get your current location."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

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
        body: JSON.stringify({
          address,
          startTime,
          endTime,
          radiusMeters,
          ...(selectedCoords ?? {}),
        }),
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
        <h1 className="flex items-center gap-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
          <span aria-hidden className="inline-block -rotate-6">🅿️</span>
          <span className="bg-gradient-to-r from-teal-500 via-emerald-500 to-teal-600 bg-clip-text text-transparent">
            Parking How Much?
          </span>
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Enter a location and how long you&apos;ll park — see nearby commercial carparks
          ranked cheapest first for that exact duration.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-2xl border border-teal-900/10 bg-white/70 p-6 shadow-lg shadow-teal-900/5 backdrop-blur-xl dark:border-teal-100/10 dark:bg-slate-900/60"
      >
        <div className="relative flex flex-col gap-1">
          <label htmlFor="address" className="text-sm font-medium">
            Location
          </label>
          <div className="flex items-center gap-2">
            <input
              id="address"
              type="text"
              required
              autoComplete="off"
              placeholder="e.g. Suntec City, Raffles Place, 238801"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setSelectedCoords(null);
                setLocationError(null);
                setShowSuggestions(true);
                if (e.target.value.trim().length < 2) setSuggestions([]);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              className="flex-1 rounded-full border border-slate-200 bg-white/80 px-4 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-800/80"
            />
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating}
              title="Use current location"
              aria-label="Use current location"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white/80 text-teal-600 transition hover:border-teal-500 hover:bg-teal-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800/80 dark:text-teal-400 dark:hover:bg-teal-950/40"
            >
              {locating ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
              )}
            </button>
          </div>
          {locationError && (
            <p className="text-xs text-red-600 dark:text-red-400">{locationError}</p>
          )}
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute top-full z-10 mt-2 max-h-64 w-full overflow-auto rounded-2xl border border-slate-200/70 bg-white/95 shadow-xl backdrop-blur-xl dark:border-slate-700/70 dark:bg-slate-900/95">
              {suggestions.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-teal-50 dark:hover:bg-teal-950/40"
                    onMouseDown={() => {
                      setAddress(s.searchVal || s.address);
                      setSelectedCoords({ lat: s.lat, lng: s.lng });
                      setShowSuggestions(false);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.searchVal}</span>
                      {s.source === "carpark" && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                          carpark
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{s.address}</div>
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
              className="rounded-full border border-slate-200 bg-white/80 px-4 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-800/80"
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
              className="rounded-full border border-slate-200 bg-white/80 px-4 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-800/80"
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
            className="rounded-full border border-slate-200 bg-white/80 px-4 py-2.5 text-sm outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/15 dark:border-slate-700 dark:bg-slate-800/80"
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
          className="mt-2 rounded-full bg-gradient-to-r from-teal-600 to-emerald-500 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-teal-900/20 transition hover:from-teal-500 hover:to-emerald-400 disabled:opacity-40 disabled:grayscale"
        >
          {loading ? "Searching…" : "Find cheapest parking"}
        </button>
      </form>

      {error && (
        <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {response && (
        <section className="flex flex-col gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {response.results.length} carpark{response.results.length === 1 ? "" : "s"} within{" "}
            {formatDistance(response.query.radiusMeters)} of &quot;{response.query.address}&quot;
          </p>

          <ul className="flex flex-col gap-3">
            {response.results.map((result: CostResult, i: number) => {
              const key = result.carpark.id;
              const isExpanded = !!expanded[key];
              const isTop = i === 0;
              return (
                <li
                  key={key}
                  onClick={() => openDirections(result.carpark.lat, result.carpark.lng)}
                  role="link"
                  title={`Get directions to ${result.carpark.name} on Google Maps`}
                  className={`cursor-pointer rounded-2xl border p-4 shadow-sm backdrop-blur transition hover:shadow-md ${
                    isTop
                      ? "border-teal-500/40 bg-teal-50/60 ring-1 ring-teal-500/20 dark:border-teal-400/30 dark:bg-teal-950/20"
                      : "border-slate-200/70 bg-white/60 dark:border-slate-700/60 dark:bg-slate-900/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                            isTop
                              ? "bg-gradient-to-br from-teal-500 to-emerald-500 text-white"
                              : "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400"
                          }`}
                        >
                          {i + 1}
                        </span>
                        <h2 className="font-medium">{result.carpark.name}</h2>
                        {isTop && (
                          <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-800 dark:bg-teal-900/60 dark:text-teal-200">
                            best value
                          </span>
                        )}
                        {result.hasUnparsed && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                            verify on-site
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {result.carpark.address ?? result.carpark.region} ·{" "}
                        {formatDistance(result.distanceMeters)}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold text-teal-700 dark:text-teal-400">
                        {result.totalCost !== null ? formatCurrency(result.totalCost) : "—"}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
                        }}
                        className="text-xs font-medium text-teal-600 underline underline-offset-2 hover:text-teal-500 dark:text-teal-400"
                      >
                        {isExpanded ? "Hide breakdown" : "Show breakdown"}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="mt-3 border-t border-slate-200/70 pt-3 text-sm dark:border-slate-700/60"
                    >
                      <ul className="flex flex-col gap-1">
                        {result.segments.map((seg, si) => {
                          const rate = formatRate(seg.ratePeriod?.pricing);
                          return (
                            <li key={si} className="flex flex-col gap-0.5">
                              <div className="flex justify-between gap-2">
                                <span className="text-slate-500">
                                  {formatTime(seg.start)}–{formatTime(seg.end)}
                                </span>
                                <span>{seg.cost !== null ? formatCurrency(seg.cost) : "—"}</span>
                              </div>
                              {(rate || seg.note) && (
                                <span className="text-xs text-slate-400">
                                  {rate}
                                  {rate && seg.note ? " · " : ""}
                                  {seg.note}
                                </span>
                              )}
                              {seg.blocks && seg.blocks.length > 0 && (
                                <ul className="mt-1 flex flex-col gap-0.5 border-l border-slate-200 pl-2 dark:border-slate-700">
                                  {seg.blocks.map((b, bi) => (
                                    <li
                                      key={bi}
                                      className="flex justify-between gap-2 text-xs text-slate-500"
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
                            <span className="text-slate-500">{s.note}</span>
                            <span>{formatCurrency(s.fee)}</span>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-3 border-t border-slate-200/70 pt-3 dark:border-slate-700/60">
                        <p className="mb-1 text-xs font-semibold text-slate-500">
                          Parking rates
                        </p>
                        <ul className="flex flex-col gap-2">
                          {(["weekday", "saturday", "sundayPh"] as DayType[]).map((dayType) => {
                            const periods = result.carpark[dayType];
                            if (!periods.length) return null;
                            return (
                              <li key={dayType}>
                                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                                  {DAY_TYPE_LABELS[dayType]}
                                </p>
                                <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                                  {periods.map((p, pi) => (
                                    <li
                                      key={pi}
                                      className="flex justify-between gap-2 text-xs text-slate-500"
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
                            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                              Surcharges
                            </p>
                            <ul className="mt-0.5 flex flex-col gap-0.5 pl-2">
                              {result.carpark.surcharges.map((s, si) => (
                                <li
                                  key={si}
                                  className="flex justify-between gap-2 text-xs text-slate-500"
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
                          <p className="mt-2 text-xs text-slate-400">{result.carpark.notes}</p>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {response.results.length === 0 && (
            <p className="text-sm text-slate-500">
              No commercial carparks found within this radius. Try widening the search.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
