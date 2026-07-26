import { Mic } from "lucide-react";
import { Manrope } from "next/font/google";

import { cn } from "@/lib/utils";

/**
 * Brand display face. Manrope is a rounded geometric grotesque that
 * reads warm-but-precise — a good fit for "honest reflections" without
 * tipping into the corporate Inter/SF default. Self-hosted via
 * `next/font` so we get a single, swap-free render and no FOUT.
 *
 * Loaded only with the weights actually rendered here (700 for the
 * wordmark) to keep the font payload tiny.
 */
const brandFace = Manrope({
  subsets: ["latin"],
  weight: ["700"],
  display: "swap",
});

interface WordmarkProps {
  /** Optional extra classes for the outer wrapper. */
  className?: string;
  /**
   * Visual scale of the wordmark. `default` matches the 64-px header
   * (h-16) — large enough to feel like a brand, not a footnote. `sm`
   * is kept around in case we ever need an inline wordmark inside a
   * paragraph or a tight badge.
   */
  size?: "default" | "sm";
}

/**
 * InterviewReplay wordmark.
 *
 * A typographic logo (not an image) so it stays crisp at any DPR,
 * inherits text color in dark mode, and never blocks first paint
 * on a network image fetch. The `.` accent in the brand teal is a
 * deliberate nod to the `.ai` we use everywhere else in the brand
 * — it punctuates the wordmark literally and figuratively.
 *
 * Rendered consistently from three places (marketing header, app
 * header, auth header) so a future refresh is one file, not three.
 */
export function Wordmark({ className, size = "default" }: WordmarkProps) {
  const isSmall = size === "sm";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "grid place-items-center rounded-md bg-primary/10 text-primary",
          isSmall ? "size-6" : "size-8",
        )}
        aria-hidden
      >
        <Mic className={isSmall ? "size-3.5" : "size-4"} />
      </span>
      <span
        className={cn(
          brandFace.className,
          "leading-none tracking-[-0.04em]",
          isSmall ? "text-lg" : "text-2xl",
        )}
      >
        interview-replay
        <span className="text-primary">.ai</span>
      </span>
    </span>
  );
}
