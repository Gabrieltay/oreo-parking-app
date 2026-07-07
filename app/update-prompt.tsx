"use client";

import { useEffect, useState } from "react";

const UPDATE_CHECK_INTERVAL_MS = 60_000;

export function UpdatePrompt() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let onVisible: (() => void) | undefined;

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (cancelled) return;

        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        });

        const checkForUpdate = () => registration.update().catch(() => {});
        interval = setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
        onVisible = () => {
          if (document.visibilityState === "visible") checkForUpdate();
        };
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4 sm:px-0">
      <div className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-teal-900/10 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
        <div className="flex-1 text-sm text-slate-700 dark:text-slate-200">
          <p className="font-medium">Update available</p>
          <p className="text-slate-500 dark:text-slate-400">A new version of Parking How Much? is ready.</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-full bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
