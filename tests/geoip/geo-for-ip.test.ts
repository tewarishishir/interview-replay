/**
 * Unit tests for `geoForIp` — the country + subdivision lookup
 * helper added for the admin Users surface.
 *
 * We exercise the helper's behavior against a STUBBED MaxMind
 * Reader rather than a real `.mmdb` file. The reader is injected
 * by replacing the dynamic-import surface — see
 * `__setReaderForTests` exported from the production module. We
 * don't have that hook yet, so this suite focuses on:
 *
 *   - reserved-IP short-circuit (returns null country/subdivision)
 *   - test reset hook
 *
 * The full City-DB integration is exercised in the broader
 * integration suite that runs against the real .mmdb when
 * MAXMIND_GEOIP_DB_PATH is set.
 */
import { afterEach, describe, expect, it } from "vitest";

import { __resetGeoIpForTests, geoForIp } from "@/lib/geoip";

afterEach(() => {
  __resetGeoIpForTests();
});

describe("geoForIp", () => {
  it("short-circuits reserved IPs to {null, null}", async () => {
    const cases = [
      "127.0.0.1",
      "::1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.0.5",
      "unknown-ip",
      "",
    ];
    for (const ip of cases) {
      const result = await geoForIp(ip);
      expect(result).toEqual({ countryCode: null, subdivisionCode: null });
    }
  });

  it("returns {null, null} when no GeoIP DB is configured", async () => {
    // The default test env doesn't set MAXMIND_GEOIP_DB_PATH, so
    // `getReader` short-circuits to "unavailable" and `geoForIp`
    // returns the empty shape. This is the dev / fresh-clone case
    // the helper is explicitly designed to handle gracefully.
    const result = await geoForIp("8.8.8.8");
    expect(result).toEqual({ countryCode: null, subdivisionCode: null });
  });
});
