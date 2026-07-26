"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/types";

/**
 * Single-icon theme toggle for the app shell header.
 *
 * Cycles the user's PREFERENCE through three states on click:
 *   light → dark → system → light
 *
 * The icon reflects the current preference (not the resolved
 * theme):
 *   - light    → Sun
 *   - dark     → Moon
 *   - system   → Monitor
 *
 * This is deliberate. If we showed the RESOLVED theme, a `system`
 * user whose OS is dark would see a moon icon — indistinguishable
 * from an explicit `dark` user. Mirroring the preference makes it
 * obvious which of the three modes the user is on, which matters
 * because the click behavior depends on it.
 *
 * The Account-page radio group remains the authoritative picker;
 * this is just a 2-click way to flip themes without leaving the
 * current screen. Both surfaces share the same `setTheme`, so
 * either path persists identically.
 */

const ORDER: ReadonlyArray<ThemePreference> = ["light", "dark", "system"];

/**
 * Pure helper exported for unit testing. Returns the preference
 * the toggle should advance to after a click on the given current
 * value. Cycles `light → dark → system → light`.
 *
 * Defensive: if the input drifts out of the known set, returns
 * `'light'` rather than throwing — better to recover gracefully
 * than to break the entire header on a corrupted preference.
 */
export function nextPreference(current: ThemePreference): ThemePreference {
  const i = ORDER.indexOf(current);
  if (i < 0) return "light";
  return ORDER[(i + 1) % ORDER.length] as ThemePreference;
}

const ICON_BY_PREFERENCE = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

const NEXT_LABEL_BY_PREFERENCE: Record<ThemePreference, string> = {
  // The tooltip-ish aria-label tells screen-reader users both the
  // current state AND what tapping will do next, so the control is
  // discoverable without sighted hover affordances.
  light: "Theme: Light. Switch to Dark.",
  dark: "Theme: Dark. Switch to Match system.",
  system: "Theme: Match system. Switch to Light.",
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON_BY_PREFERENCE[theme] ?? Sun;
  const label = NEXT_LABEL_BY_PREFERENCE[theme] ?? "Change theme";

  return (
    <button
      type="button"
      onClick={() => setTheme(nextPreference(theme))}
      aria-label={label}
      title={label}
      // Same hover/focus tokens as the nav links for consistency.
      className="
        inline-flex h-8 w-8 items-center justify-center rounded-full
        border border-border bg-muted text-muted-foreground
        transition-colors hover:bg-accent hover:text-accent-foreground
        focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-ring focus-visible:ring-offset-2
        focus-visible:ring-offset-background
      "
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
