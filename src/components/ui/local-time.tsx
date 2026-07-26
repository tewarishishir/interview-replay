"use client";

/**
 * Renders a timestamp in the browser's local timezone.
 *
 * The server can't know the user's timezone, so date-fns `format()` on the
 * server produces UTC times (e.g. "3:12 AM" when the user is in IST and the
 * real local time is "8:42 AM"). This component defers formatting to the
 * client where `Intl.DateTimeFormat` has access to the user's real timezone.
 *
 * Hydration note: the server renders a neutral ISO-8601 date string inside
 * a <time> element (always correct, timezone-agnostic). The client replaces
 * it with the localized string on mount. `suppressHydrationWarning` prevents
 * React from complaining about the mismatch — it's intentional.
 */

import { useEffect, useState } from "react";

type LocalTimeProps = {
  /** The UTC date to display. */
  date: Date | string;
  /**
   * Intl.DateTimeFormat options. Defaults to a compact "Jun 4, 2026, 8:42 AM"
   * format that matches the rest of the sidebar's date/time style.
   */
  options?: Intl.DateTimeFormatOptions;
  className?: string;
};

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

export function LocalTime({ date, options = DEFAULT_OPTIONS, className }: LocalTimeProps) {
  const d = typeof date === "string" ? new Date(date) : date;
  const iso = d.toISOString();

  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(new Intl.DateTimeFormat(undefined, options).format(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);

  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {/* Server: show ISO string (neutral, always correct). Client: show localized. */}
      {label ?? iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}
    </time>
  );
}
