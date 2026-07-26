import "server-only";

import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db, schema } from "@/lib/db";

import {
  FALLBACK_RESOLVED_THEME,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  THEME_COOKIE_NAME,
} from "./types";

/**
 * Server-side theme resolution.
 *
 * Returns BOTH the user's preference (the choice, including the
 * `'system'` sentinel) and a concrete resolved theme to stamp onto
 * `<html data-theme="...">` for the initial paint.
 *
 * Resolution order:
 *   1. The `ir-theme` cookie (if present + valid). Set by the
 *      POST /api/users/me/theme endpoint after the user changes
 *      themes — this avoids a DB lookup on every request.
 *   2. `users.theme_preference` for the signed-in user.
 *   3. Default `'system'`.
 *
 * Once we have a preference, we resolve `'system'` against the
 * `sec-ch-prefers-color-scheme` client hint (when the browser sends
 * it). If the hint isn't available we fall back to
 * `FALLBACK_RESOLVED_THEME` (dark) — the inline anti-FOUC script
 * in the layout then overrides via `window.matchMedia` if the OS
 * actually wants light.
 *
 * Why not just always rely on the inline script? Because the page
 * still renders for a frame with whatever theme the server chose;
 * if we always defaulted to light and the user prefers dark, that
 * single frame is a visible flash. Picking a sensible default
 * server-side (cookie → DB → fallback) makes that initial frame
 * correct in the common case.
 */
export interface ResolvedThemeContext {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

export async function resolveTheme(): Promise<ResolvedThemeContext> {
  const preference = await resolvePreference();
  const resolved =
    preference === "system" ? await resolveSystemTheme() : preference;
  return { preference, resolved };
}

async function resolvePreference(): Promise<ThemePreference> {
  // Cookie wins — set by the API endpoint after each change, so it
  // reflects the user's most recent choice without a DB hit.
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(THEME_COOKIE_NAME)?.value;
    if (isThemePreference(raw)) return raw;
  } catch {
    // `cookies()` throws in some rendering contexts (e.g. static
    // routes). Fall through — we'll try the DB next.
  }

  // DB fallback for the signed-in case. Anonymous users with no
  // cookie default to 'system' below.
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (userId) {
      const [row] = await db
        .select({ themePreference: schema.users.themePreference })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (row && isThemePreference(row.themePreference)) {
        return row.themePreference;
      }
    }
  } catch (err) {
    // A DB outage here MUST NOT prevent the page from rendering.
    // Worst case: we serve the fallback theme and the inline script
    // corrects it on the client.
    console.error("[resolveTheme] DB lookup failed:", err);
  }

  return "system";
}

/**
 * Resolve the `'system'` preference against the
 * `sec-ch-prefers-color-scheme` client hint. Browsers only send
 * this if we opt in via the `Accept-CH` response header (set in
 * the root layout's metadata), and even then not every browser
 * supports it. When absent, default to dark per the spec.
 */
async function resolveSystemTheme(): Promise<ResolvedTheme> {
  try {
    const h = await headers();
    const hint = h.get("sec-ch-prefers-color-scheme");
    if (hint === "light") return "light";
    if (hint === "dark") return "dark";
  } catch {
    // Headers can be unavailable in some rendering contexts.
  }
  return FALLBACK_RESOLVED_THEME;
}
