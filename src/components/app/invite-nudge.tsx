"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Copy, Gift, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Compact dashboard nudge: "Invite friends, earn 2 credits when an
 * invited friend first recharges." Persists a dismiss state in
 * `localStorage` so users that don't care don't see it on every
 * dashboard load. The dismiss is per-browser intentionally — we
 * don't want to spend a server round-trip on a presentation choice
 * that can wait until the next browser.
 *
 * SSR safety: we render `null` until `useEffect` resolves the
 * stored dismiss flag so the server-rendered HTML and the post-
 * hydration tree agree (avoids a hydration warning + a flash of
 * the nudge for users that already dismissed it).
 */

const DISMISS_STORAGE_KEY = "ir:invite-nudge:dismissed";

export function InviteNudge({
  link,
  creditsEarned,
}: {
  link: string;
  creditsEarned: number;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_STORAGE_KEY) === "1");
    } catch {
      // localStorage can throw in private mode + with SameSite
      // restrictions. Default to "show the nudge" — worse to hide
      // a potential revenue stream than to nag.
    }
    setHydrated(true);
  }, []);

  const onDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, "1");
    } catch {
      // Ignore — the dismiss survives at least the current page.
    }
  };

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
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
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Silent — the user can still long-press the link via the
      // Account page.
    }
  };

  if (!hydrated || dismissed) return null;

  return (
    <div className="relative flex flex-wrap items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Gift
          className="mt-0.5 size-5 shrink-0 text-emerald-700"
          aria-hidden
        />
        <div>
          <p className="text-sm font-medium text-foreground">
            Invite friends, earn credits
          </p>
          <p className="text-xs text-muted-foreground">
            +2 credits when an invited friend makes their first
            recharge.
            {creditsEarned > 0 && (
              <>
                {" "}
                <span className="font-medium text-emerald-700">
                  You&apos;ve earned +{creditsEarned} so far.
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCopy}
          aria-label="Copy invite link"
        >
          {copied ? (
            <>
              <Check className="size-4" aria-hidden />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-4" aria-hidden />
              Copy link
            </>
          )}
        </Button>
        <Button asChild variant="default" size="sm">
          <Link href="/account">Manage</Link>
        </Button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground sm:static"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
