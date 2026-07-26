"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  THEME_COOKIE_MAX_AGE_SECONDS,
  THEME_COOKIE_NAME,
} from "./types";

/**
 * Client-side theme controller.
 *
 * Wraps the app and exposes:
 *
 *   - `theme`: the user's PREFERENCE (`'light' | 'dark' | 'system'`).
 *     This is what the settings UI reflects — including the
 *     "Match system" radio.
 *
 *   - `resolvedTheme`: the CONCRETE theme actually applied to the
 *     DOM (`'light' | 'dark'`). Components that want to branch on
 *     "what does it actually look like right now" should read this.
 *
 *   - `setTheme(next)`: updates the preference. Side effects in
 *     order:
 *       1. Recomputes the resolved theme.
 *       2. Stamps `<html data-theme>` so the page updates
 *          immediately (no waiting for the network round-trip).
 *       3. Sets the `ir-theme` cookie client-side as a
 *          defensive measure so an SSR'd page after a quick
 *          reload picks up the new value even if the API call
 *          hadn't returned yet.
 *       4. Fires `POST /api/users/me/theme` so the choice
 *          persists to the user's row (where it survives
 *          logout + cross-device).
 *
 * The provider also subscribes to the OS-level
 * `prefers-color-scheme` media query so a user on `'system'` who
 * flips their OS theme while the tab is open gets an immediate
 * recompute — without a full reload.
 *
 * SSR contract: the root layout sets `data-theme` on `<html>`
 * server-side and passes the resolved value as `initialResolved`.
 * The provider trusts that on first render (same value used
 * during SSR) and only re-computes on subsequent interactions.
 * This avoids the React 19 hydration mismatch that would
 * otherwise occur if we recomputed via `matchMedia` during the
 * first client render.
 */

interface ThemeContextValue {
  /** The user's preference (can be `'system'`). */
  theme: ThemePreference;
  /** The concrete theme currently applied to the DOM. */
  resolvedTheme: ResolvedTheme;
  /**
   * Update the preference. Persists to server + cookie + DOM.
   * Returns when the optimistic DOM update is done; the server
   * call runs in the background.
   */
  setTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error(
      "useTheme must be used within a <ThemeProvider>. Make sure the app " +
        "is wrapped at the root layout.",
    );
  }
  return ctx;
}

interface ThemeProviderProps {
  /**
   * The user's stored preference. Resolved server-side from the
   * cookie or DB; passed in to avoid a flash where the first
   * client render computes a different value than the SSR pass.
   */
  initialPreference: ThemePreference;
  /**
   * The concrete theme stamped on `<html>` by the server. Used as
   * the initial `resolvedTheme` so the first render matches the
   * SSR'd DOM exactly.
   */
  initialResolved: ResolvedTheme;
  children: React.ReactNode;
}

export function ThemeProvider({
  initialPreference,
  initialResolved,
  children,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(initialPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(initialResolved);

  // Track whether the user has signed in (so we know whether the
  // API persistence call has any chance of succeeding). Anonymous
  // users still get cookie persistence.
  const inFlightController = useRef<AbortController | null>(null);

  const applyTheme = useCallback((next: ResolvedTheme) => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", next);
    setResolved(next);
  }, []);

  /**
   * Listen for OS-level `prefers-color-scheme` changes when the
   * user is on `'system'`. We re-resolve only in that mode —
   * explicit `light` / `dark` choices ignore the OS hint.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (preference !== "system") return;

    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => {
      applyTheme(mql.matches ? "light" : "dark");
    };
    update();

    // Use addEventListener — `mql.addListener` is deprecated.
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [preference, applyTheme]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      if (!isThemePreference(next)) return;

      setPreferenceState(next);

      // Compute the concrete theme for the new preference.
      let concrete: ResolvedTheme;
      if (next === "system" && typeof window !== "undefined") {
        concrete = window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
      } else if (next === "system") {
        // SSR path — should never run here in practice (setTheme is
        // only called from event handlers) but keep a safe fallback.
        concrete = "dark";
      } else {
        concrete = next;
      }
      applyTheme(concrete);

      // Defensive cookie write — the API call below is the canonical
      // path, but writing the cookie here ensures a tab that loses
      // network connectivity immediately after still SSRs the right
      // theme on its next request.
      if (typeof document !== "undefined") {
        const maxAge = THEME_COOKIE_MAX_AGE_SECONDS;
        // SameSite=Lax matches the Auth.js cookie policy and keeps
        // the value attached on top-level navigations (which is the
        // case that matters for SSR resolution).
        const isSecure = window.location.protocol === "https:";
        document.cookie =
          `${THEME_COOKIE_NAME}=${encodeURIComponent(next)}; ` +
          `Path=/; Max-Age=${maxAge}; SameSite=Lax` +
          (isSecure ? "; Secure" : "");
      }

      // Cancel any in-flight persistence so a rapid burst of clicks
      // doesn't end with the DB landing on a stale value.
      inFlightController.current?.abort();
      const controller = new AbortController();
      inFlightController.current = controller;

      // Fire-and-forget — the UI already updated. A failed persist
      // (anonymous user, DB outage) is a soft failure: the cookie
      // carries the value across reloads.
      void fetch("/api/users/me/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
        signal: controller.signal,
        // Same-origin only — no leakage of the (auth-required)
        // cookie to third parties.
        credentials: "same-origin",
      }).catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        // Don't spam console.error for anonymous users — they get a
        // 401, which is expected. Only log unexpected failures.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[ThemeProvider] persist failed:", err);
        }
      });
    },
    [applyTheme],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: preference, resolvedTheme: resolved, setTheme }),
    [preference, resolved, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
