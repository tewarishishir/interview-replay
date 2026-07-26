"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Referral block for the Account page (and reused as a compact
 * variant on the Dashboard nudge).
 *
 * The page passes us the `link` and `code` already composed
 * server-side via `buildReferralLink` so the SSR render shows the
 * real share URL on first paint (no hydration flicker). The counts
 * tile reflects whatever the server read at SSR time; the
 * `/api/referrals/me` endpoint is available for any future
 * post-mount refresh but isn't called on every render.
 *
 * Copy-to-clipboard uses the modern Clipboard API and falls back
 * to a hidden textarea + execCommand for older Safari + any
 * browser that withdraws clipboard permissions for a session.
 *
 * Web Share API: when present (mobile + some desktop) we offer a
 * native share sheet alongside the copy button. The button is
 * conditionally rendered to avoid showing a non-functional control
 * on browsers without `navigator.share`.
 */

export function ReferralSection({
  code,
  link,
  refereesCount,
  creditsEarned,
}: {
  code: string;
  link: string;
  refereesCount: number;
  creditsEarned: number;
}) {
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onCopy = () => {
    setShareError(null);
    startTransition(async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(link);
        } else {
          // Fallback: synthetic textarea + execCommand. Older
          // Safari + locked-down extension contexts. Not exposed
          // as a normal copy button because it briefly steals
          // focus, but it's the only way to copy without the
          // modern API.
          const textarea = document.createElement("textarea");
          textarea.value = link;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        setCopied(true);
        // 1.6s feels long enough that users register the change
        // without the button looking permanently in a "done" state.
        window.setTimeout(() => setCopied(false), 1600);
      } catch {
        setShareError("Couldn't copy. Long-press the link to copy manually.");
      }
    });
  };

  const onShare = () => {
    setShareError(null);
    if (typeof navigator === "undefined" || !navigator.share) return;
    void navigator
      .share({
        title: "Try InterviewReplay — your AI interview coach",
        text: "I've been using InterviewReplay to prep for interviews. Sign up with my link and we both get 2 bonus credits when you first recharge.",
        url: link,
      })
      .catch((err: unknown) => {
        // User-initiated dismissals throw `AbortError`; only
        // surface anything else.
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name?: unknown }).name === "AbortError"
        ) {
          return;
        }
        setShareError("Couldn't open the share sheet — try the copy button.");
      });
  };

  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Share this link with friends. When they sign up and make their
        first recharge, you&apos;ll earn{" "}
        <span className="font-medium text-foreground">+2 credits</span>.
        There&apos;s no cap.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm break-all">
          {link}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onCopy}
          aria-label="Copy share link"
        >
          {copied ? (
            <>
              <Check className="size-4" aria-hidden />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4" aria-hidden />
              Copy
            </>
          )}
        </Button>
        {canNativeShare && (
          <Button
            type="button"
            variant="outline"
            onClick={onShare}
            aria-label="Open share sheet"
          >
            <Share2 className="size-4" aria-hidden />
            Share
          </Button>
        )}
      </div>

      {shareError && (
        <p className="text-sm text-destructive" role="alert">
          {shareError}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-md border border-border bg-background px-3 py-2.5">
          <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your code
          </dt>
          <dd className="mt-1 font-mono text-base text-foreground">
            {code}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2.5">
          <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Friends joined
          </dt>
          <dd className="mt-1 text-base font-semibold tabular-nums text-foreground">
            {refereesCount}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background px-3 py-2.5">
          <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Credits earned
          </dt>
          <dd className="mt-1 text-base font-semibold tabular-nums text-emerald-700">
            +{creditsEarned}
          </dd>
        </div>
      </dl>
    </div>
  );
}
