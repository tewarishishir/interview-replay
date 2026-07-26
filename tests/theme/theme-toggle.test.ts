/**
 * Unit tests for the toggle cycle helper. The component itself is
 * presentation-only (icon + button + aria-label), and the
 * codebase doesn't ship `@testing-library/react`, so we cover the
 * single piece of stateful logic in isolation — the cycle order.
 *
 * Cycle under test: light → dark → system → light. The off-piste
 * input case (corrupted preference) recovers to `'light'`.
 */
import { describe, expect, it } from "vitest";

import { nextPreference } from "@/components/app/theme-toggle";

describe("nextPreference", () => {
  it("advances light → dark", () => {
    expect(nextPreference("light")).toBe("dark");
  });

  it("advances dark → system", () => {
    expect(nextPreference("dark")).toBe("system");
  });

  it("advances system → light (closing the cycle)", () => {
    expect(nextPreference("system")).toBe("light");
  });

  it("recovers to 'light' on an unknown input rather than throwing", () => {
    // @ts-expect-error — deliberately passing an invalid value to
    // verify the defensive branch.
    expect(nextPreference("neon")).toBe("light");
  });
});
