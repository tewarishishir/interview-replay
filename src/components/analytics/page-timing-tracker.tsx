"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Client-side page performance tracker.
 *
 * Mounted once in the root layout. Measures two signals per page:
 *
 *   1. `load_ms` — `PerformanceNavigationTiming.loadEventEnd`, the
 *      browser's measure of the full initial page load (document
 *      + all blocking resources). Only non-null on hard navigations;
 *      SPA route changes produce null (there's no new navigation
 *      entry for a client-side transition).
 *
 *   2. `time_spent_ms` — wall-clock time the user spent on the page,
 *      from mount (or SPA route change) to unmount / tab close /
 *      hard navigation away. Capped server-side at 1 hour.
 *
 * Data is sent to `POST /api/analytics/page-timing` via
 * `navigator.sendBeacon` (reliable on unload) or `fetch` fallback.
 * The endpoint is auth-gated — anonymous users get 204 silently,
 * so the sendBeacon call never produces a visible console error.
 *
 * Privacy: only the pathname is stored (no query params, no UUIDs
 * beyond what's in the path, no user-typed content). The user_id
 * is resolved server-side from the session cookie.
 */

type PageState = {
  pathname: string;
  mountedAt: number;
  loadMs: number | null;
};

function postTiming(data: {
  pathname: string;
  load_ms: number | null;
  time_spent_ms: number;
}): void {
  // Discard sub-1s visits — they're likely SPA prefetches or rapid
  // navigations, not real user dwell time.
  if (data.time_spent_ms < 1000) return;

  const body = JSON.stringify(data);
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      navigator.sendBeacon(
        "/api/analytics/page-timing",
        new Blob([body], { type: "application/json" }),
      );
    } else {
      void fetch("/api/analytics/page-timing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {/* best-effort */});
    }
  } catch {
    /* best-effort — never surface a JS error for telemetry */
  }
}

export function PageTimingTracker() {
  const pathname = usePathname();
  const stateRef = useRef<PageState>({
    pathname,
    mountedAt: Date.now(),
    loadMs: null,
  });

  // Capture Navigation Timing load_ms + handle SPA route changes.
  useEffect(() => {
    const prev = stateRef.current;
    const now = Date.now();

    // SPA navigation — flush the previous page's timing before resetting.
    if (prev.pathname !== pathname) {
      postTiming({
        pathname: prev.pathname,
        load_ms: prev.loadMs,
        time_spent_ms: now - prev.mountedAt,
      });
      stateRef.current = { pathname, mountedAt: now, loadMs: null };
    }

    // Capture Navigation Timing for the initial hard-nav load time.
    // `PerformanceNavigationTiming` only exists for real navigations;
    // SPA transitions don't produce a new entry.
    const captureLoadTiming = () => {
      const nav = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming | undefined;
      if (nav && nav.loadEventEnd > 0) {
        stateRef.current.loadMs = Math.round(nav.loadEventEnd);
      }
    };

    if (document.readyState === "complete") {
      captureLoadTiming();
    } else {
      window.addEventListener("load", captureLoadTiming, { once: true });
      return () => window.removeEventListener("load", captureLoadTiming);
    }
  }, [pathname]);

  // Hard-navigation / tab-close flush — stable listener (no pathname dep).
  useEffect(() => {
    const handlePageHide = () => {
      const state = stateRef.current;
      postTiming({
        pathname: state.pathname,
        load_ms: state.loadMs,
        time_spent_ms: Date.now() - state.mountedAt,
      });
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  return null;
}
