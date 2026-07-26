"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Tiny client island that nudges the session detail page to
 * re-fetch from the server while the session is in `analyzing`.
 *
 * Why this exists:
 *   The session detail page is server-rendered. While the analyze
 *   worker runs out-of-band (fire-and-forget inline pipeline),
 *   the rendered HTML stays pinned to
 *   `state = analyzing` and the candidate sees the "We're analyzing
 *   your interview" panel forever — until they manually refresh.
 *
 *   `router.refresh()` re-runs the server component and swaps in
 *   the new state without unmounting the rest of the tree, so the
 *   panel animates into the report (or the `failed` panel) the
 *   moment the worker finishes.
 *
 * Cadence:
 *   - We poll every 4 s. The behavioural round at the bumped token
 *     budget runs ~60-120 s, so 4 s gives a snappy resolution
 *     without hammering the server.
 *   - We stop polling on unmount automatically (the page navigates
 *     away on its own when the state advances and re-renders the
 *     report path).
 */
export function AnalyzingPoller() {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      router.refresh();
    }, 4000);
    return () => clearInterval(interval);
  }, [router]);

  return null;
}
