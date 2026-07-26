/**
 * Shared theme types. Kept dependency-free (no `server-only`,
 * no React) so both the server-side resolver, the client
 * provider, and the API route can import the same union.
 */

/**
 * What the user picked. `'system'` defers to the OS-level
 * `prefers-color-scheme` media query, resolved client-side on each
 * load.
 */
export type ThemePreference = "light" | "dark" | "system";

/**
 * What's actually applied to the DOM. Always concrete — the
 * `'system'` preference is resolved to one of these before being
 * stamped onto `<html data-theme="...">`.
 */
export type ResolvedTheme = "light" | "dark";

/** Valid preference strings, for runtime validation. */
export const THEME_PREFERENCES: ReadonlyArray<ThemePreference> = [
  "light",
  "dark",
  "system",
];

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    (THEME_PREFERENCES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Cookie name used for SSR theme resolution. Set by the
 * /api/users/me/theme endpoint on success and read by the root
 * layout on the next request — this is how the user's choice
 * survives the page reload without needing a DB lookup on the
 * critical render path.
 */
export const THEME_COOKIE_NAME = "ir-theme";

/**
 * Cookie lifetime. One year is the de-facto standard for "remember
 * this preference"; longer is wasteful (browsers cap it anyway)
 * and shorter would surprise users who set the theme once and
 * never came back for months.
 */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Fallback used when we genuinely can't resolve a preference
 * server-side — no cookie, no user, no client hint. Dark matches
 * what the app shipped with before this feature, so unauthenticated
 * cold loads don't change visually for existing users.
 */
export const FALLBACK_RESOLVED_THEME: ResolvedTheme = "dark";
