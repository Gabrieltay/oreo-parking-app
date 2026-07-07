"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "install-prompt-dismissed-at";
const DISMISS_DAYS = 14;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isDismissedRecently() {
  const dismissedAt = localStorage.getItem(DISMISS_KEY);
  if (!dismissedAt) return false;
  const daysSince = (Date.now() - Number(dismissedAt)) / (1000 * 60 * 60 * 24);
  return daysSince < DISMISS_DAYS;
}

function computeShowIosHint() {
  if (typeof window === "undefined") return false;
  if (isStandalone() || isDismissedRecently()) return false;

  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  const isSafari =
    /safari/i.test(window.navigator.userAgent) && !/crios|fxios|edgios/i.test(window.navigator.userAgent);

  return isIos && isSafari;
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(computeShowIosHint);

  useEffect(() => {
    if (isStandalone() || isDismissedRecently()) return;

    const handler = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDeferredPrompt(null);
    setShowIosHint(false);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  };

  if (!deferredPrompt && !showIosHint) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4 sm:px-0">
      <div className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-teal-900/10 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
        <div className="flex-1 text-sm text-slate-700 dark:text-slate-200">
          {deferredPrompt ? (
            <>
              <p className="font-medium">Install Parking How Much?</p>
              <p className="text-slate-500 dark:text-slate-400">Add it to your home screen for quick, offline access.</p>
            </>
          ) : (
            <>
              <p className="font-medium">Install Parking How Much?</p>
              <p className="text-slate-500 dark:text-slate-400">
                Tap the Share icon, then &quot;Add to Home Screen&quot;.
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {deferredPrompt && (
            <button
              onClick={install}
              className="rounded-full bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700"
            >
              Install
            </button>
          )}
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
