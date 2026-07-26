import "server-only";

import { env } from "@/lib/env";

/**
 * Strict same-origin check used by every state-changing entry point
 * (the `/api/sessions` route AND the `createSessionAction` server
 * action) and by read-only polling endpoints.
 *
 * Trust hierarchy:
 *
 * 1. `Origin` header — set by the browser on cross-origin requests
 *    AND on same-origin POST/PUT/DELETE/PATCH. Cannot be forged by
 *    JavaScript on the page (forbidden header per Fetch spec).
 *
 * 2. `Sec-Fetch-Site` — set by all modern browsers on EVERY fetch,
 *    including same-origin GET/HEAD where the `Origin` header is
 *    deliberately omitted. Also a forbidden header (cannot be set
 *    from JavaScript), so it's as trustworthy as `Origin`. We need
 *    this fallback because otherwise the recorder's GET poll of
 *    `/api/sessions/:id` (a same-origin GET) gets blanket 403'd —
 *    the browser legitimately doesn't send `Origin` for it.
 *
 * `Referer` is intentionally NOT consulted: it's suppressible /
 * forgeable via Referrer-Policy and `<meta name="referrer">`, so
 * accepting it would widen our CSRF surface for no real benefit on
 * top of `SameSite=lax` Auth.js cookies.
 *
 * Origin matching:
 *   - In production we compare against `env.NEXTAUTH_URL`. The env
 *     validator requires it in production so the match is
 *     unambiguous.
 *   - In dev we additionally accept any `localhost` / `127.0.0.1`
 *     origin so contributors using ports 3000, 3100 (e2e), and the
 *     occasional 3001 don't have to set NEXTAUTH_URL just to test.
 *
 * Server actions ALSO get Next.js's built-in CSRF check (Origin vs.
 * Host). This is defense-in-depth: if a future Next.js change loosens
 * that, our explicit guard still holds.
 */
export function isSameOrigin(headers: Headers): boolean {
  const candidate = headers.get("origin");

  if (candidate) {
    let candidateOrigin: string;
    try {
      candidateOrigin = new URL(candidate).origin;
    } catch {
      return false;
    }

    if (env.NEXTAUTH_URL) {
      try {
        const expected = new URL(env.NEXTAUTH_URL).origin;
        if (candidateOrigin === expected) return true;
      } catch {
        // If somehow the env value isn't parseable, fall through to the
        // dev-mode localhost check rather than 500ing every request.
      }
    }

    if (process.env.NODE_ENV !== "production") {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(candidateOrigin)) {
        return true;
      }
    }

    return false;
  }

  // No Origin — browsers omit it on safe-method same-origin requests
  // (GET/HEAD). Fall back to `Sec-Fetch-Site`, which the browser
  // sets on every fetch and which JavaScript cannot forge. Anything
  // other than `same-origin` (cross-site, same-site, none) is
  // rejected — including the absence of the header, which means an
  // older browser or a non-browser client where the Origin guard
  // genuinely is our only signal.
  return headers.get("sec-fetch-site") === "same-origin";
}
