import "server-only";

import { env, features, isProduction } from "@/lib/env";

/**
 * Lazy MaxMind GeoIP2 reader. The .mmdb file is loaded once per
 * process and held in memory (the underlying buffer is small —
 * GeoLite2-Country is ~6MB).
 *
 * Operations that touch user data should pass IPs through
 * `countryCodeForIp`, which short-circuits to `null` when:
 *   - `INDIA_ONLY_MODE` is off (no point burning CPU on the lookup),
 *   - `MAXMIND_GEOIP_DB_PATH` is unset (dev / fresh clone),
 *   - the IP is reserved/private (localhost, RFC1918, etc.).
 *
 * The reader is constructed via dynamic import so the @maxmind dep
 * is only loaded when it's needed — environments without the .mmdb
 * file don't pay the SDK's startup cost.
 */

type CountryResult = { country?: { isoCode?: string } } | undefined;
type CityResult =
  | {
      country?: { isoCode?: string };
      subdivisions?: Array<{ isoCode?: string }>;
    }
  | undefined;

type Reader = {
  country: (ip: string) => CountryResult;
  /**
   * Only present when the loaded .mmdb is GeoLite2-City (or the paid
   * equivalent). Calling `.city()` against a Country-only DB throws,
   * which is why every call site below feature-detects the method
   * before dispatching.
   */
  city?: (ip: string) => CityResult;
};

let cached: Reader | null | "unavailable" = null;

async function getReader(): Promise<Reader | null> {
  if (cached === "unavailable") return null;
  if (cached) return cached;
  if (!features.geoIp || !env.MAXMIND_GEOIP_DB_PATH) {
    cached = "unavailable";
    return null;
  }
  try {
    const [{ Reader }, fs] = await Promise.all([
      import("@maxmind/geoip2-node"),
      import("node:fs/promises"),
    ]);
    const dbBuffer = await fs.readFile(env.MAXMIND_GEOIP_DB_PATH);
    cached = Reader.openBuffer(dbBuffer) as unknown as Reader;
    return cached;
  } catch (err) {
    console.warn(
      "[geoip] failed to open MaxMind DB at",
      env.MAXMIND_GEOIP_DB_PATH,
      err,
    );
    cached = "unavailable";
    return null;
  }
}

/**
 * RFC1918 / loopback / link-local quick check — returns true for IPs
 * we shouldn't bother passing to MaxMind. The lookup would return
 * undefined anyway, but skipping the call avoids the cost in dev
 * where every request comes from 127.0.0.1.
 */
function isReservedIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "unknown-ip") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) {
    return true;
  }
  return false;
}

/**
 * Resolve an IP to its ISO 3166-1 alpha-2 country code (e.g. "IN",
 * "US"). Returns `null` when:
 *   - GeoIP is not configured (env flag off, no DB on disk),
 *   - the IP is reserved/private,
 *   - the lookup itself failed for any reason.
 *
 * Designed to be best-effort: callers should treat `null` as "we
 * don't know" and never fail-closed on the answer.
 */
export async function countryCodeForIp(ip: string): Promise<string | null> {
  if (isReservedIp(ip)) return null;
  const reader = await getReader();
  if (!reader) return null;
  try {
    const result = reader.country(ip);
    return result?.country?.isoCode ?? null;
  } catch {
    return null;
  }
}

export interface GeoResult {
  /** ISO 3166-1 alpha-2 country code, or null when unresolved. */
  countryCode: string | null;
  /**
   * ISO 3166-2 subdivision suffix (e.g. `MH`, `KA`, `CA`), or null.
   * Stripped of the `IN-` / `US-` prefix that the full ISO-3166-2
   * string carries — see the column comment in `db/schema/users.ts`.
   */
  subdivisionCode: string | null;
}

/**
 * Best-effort country + subdivision (state/province) lookup.
 *
 * Falls back gracefully when the loaded .mmdb is the smaller
 * Country DB (which has no subdivisions): the country still
 * resolves, the subdivision returns `null`. Same return shape
 * regardless of which DB is loaded, so callers don't have to
 * branch.
 *
 * Returns `{ countryCode: null, subdivisionCode: null }` when:
 *   - GeoIP isn't configured,
 *   - the IP is reserved/private,
 *   - any lookup error fires (we log nothing here — the surface
 *     is best-effort and a noisy per-signup warning would flood
 *     the logs).
 *
 * For callers that only need the country, `countryCodeForIp`
 * remains the cheaper one-field call.
 */
export async function geoForIp(ip: string): Promise<GeoResult> {
  const result = await resolveGeoFromReader(ip);
  return applyDevFallback(result);
}

/**
 * Dev-only fallback: when the real lookup returns null for either
 * field AND `NODE_ENV !== 'production'`, stamp the configured
 * `DEV_GEO_FALLBACK_*` value. Returns the input untouched in
 * production or when the env vars aren't set.
 */
function applyDevFallback(real: GeoResult): GeoResult {
  if (isProduction) return real;
  return {
    countryCode: real.countryCode ?? env.DEV_GEO_FALLBACK_COUNTRY ?? null,
    subdivisionCode: real.subdivisionCode ?? env.DEV_GEO_FALLBACK_SUBDIVISION ?? null,
  };
}

/**
 * Inner lookup against the MaxMind reader. Extracted so
 * `geoForIp` can wrap every return path in the dev fallback
 * uniformly — the reserved-IP and no-reader short-circuits used
 * to return null directly and bypass any fallback layered on top.
 */
async function resolveGeoFromReader(ip: string): Promise<GeoResult> {
  if (isReservedIp(ip)) return { countryCode: null, subdivisionCode: null };
  const reader = await getReader();
  if (!reader) return { countryCode: null, subdivisionCode: null };

  // Prefer the City DB when available — it gives us both country
  // AND subdivision in one lookup. Fall back to Country if the
  // loaded DB doesn't ship a `.city()` method.
  if (typeof reader.city === "function") {
    try {
      const result = reader.city(ip);
      const subdivision = result?.subdivisions?.[0]?.isoCode ?? null;
      return {
        countryCode: result?.country?.isoCode ?? null,
        subdivisionCode: subdivision,
      };
    } catch {
      // City lookup failed (bad row, missing block) — fall through
      // to the Country lookup so we still get the country.
    }
  }

  try {
    const result = reader.country(ip);
    return {
      countryCode: result?.country?.isoCode ?? null,
      subdivisionCode: null,
    };
  } catch {
    return { countryCode: null, subdivisionCode: null };
  }
}

/**
 * Best-effort geo lookup from request headers.
 *
 * Priority order:
 *   1. Common geo headers (`x-geo-country` / `x-geo-region`) that
 *      a reverse proxy can inject.
 *   2. MaxMind DB lookup via `fallbackIp` — only runs when the DB is
 *      configured (`MAXMIND_GEOIP_DB_PATH`) and `fallbackIp` is provided.
 *   3. Dev fallback (`DEV_GEO_FALLBACK_*`) — applied inside `geoForIp`.
 */
export async function geoFromHeaders(
  requestHeaders: Headers,
  fallbackIp?: string | null,
): Promise<GeoResult> {
  const country =
    requestHeaders.get("x-vercel-ip-country") ??
    requestHeaders.get("x-geo-country");
  const region =
    requestHeaders.get("x-vercel-ip-country-region") ??
    requestHeaders.get("x-geo-region");

  if (country && country !== "XX") {
    return applyDevFallback({
      countryCode: country,
      subdivisionCode: region ?? null,
    });
  }

  if (fallbackIp) {
    return geoForIp(fallbackIp);
  }

  return applyDevFallback({ countryCode: null, subdivisionCode: null });
}

/** Test hook to force a re-open of the .mmdb between cases. */
export function __resetGeoIpForTests(): void {
  cached = null;
}
