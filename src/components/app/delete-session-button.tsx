"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { AlertTriangle, CoinsIcon, Loader2, Trash2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Inline "delete this session" CTA used on the pre-analysis screens
 * (review, augment) so a candidate who's unhappy with their recording
 * or transcript can bail out without having to dig into the report
 * page later.
 *
 * Wraps the existing DELETE /api/sessions/:id endpoint, which is the
 * same soft-delete the report page already uses — the state machine
 * allows `deleted` from every non-terminal state, so calling this
 * from `review` or `analyzing` is safe.
 *
 * Billing: when `transcriptionFee > 0` we surface a warning panel
 * AND expand the confirm() copy to call out the charge. Backed by
 * `transcriptionFeeForDelete` from `lib/credits/pricing` — both
 * client and server import from that single source so the UI copy
 * matches the actual deduction the API will perform.
 *
 * UX notes:
 *   - Confirmation goes through `window.confirm`. Same pattern the
 *     report-page action cluster already uses (matches user
 *     expectations across the app, no extra modal dependency).
 *   - On success we route to `/dashboard` and `router.refresh()` so
 *     the deleted row disappears from the list.
 *   - Errors are surfaced inline rather than thrown — the user is
 *     mid-flow and a runtime crash here would be much worse than a
 *     non-blocking error message.
 */
interface DeleteSessionButtonProps {
  sessionId: string;
  /** Customise the visible CTA copy. Defaults to "Delete session". */
  label?: string;
  /**
   * Confirmation prompt shown in the browser's `confirm()` dialog.
   * Override per-screen so the wording fits the surrounding context
   * (e.g. "this will discard your transcript" on review). When
   * `transcriptionFee > 0` we append a billing notice automatically
   * — callers don't need to repeat the credits language here.
   */
  confirmMessage?: string;
  /** Visual variant — defaults to a subtle ghost so it doesn't compete
   * with the primary "Continue" CTA living next to it. */
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  /** Optional className passthrough so callers can stretch it full-width
   * inside narrow sidebars. */
  className?: string;
  /** Where to land after the delete succeeds. Defaults to /dashboard. */
  redirectTo?: Route;
  /** Disable from the parent (e.g. while another mutation is pending). */
  disabled?: boolean;
  /**
   * Number of credits the API will charge when this delete is
   * performed (transcription fee). When > 0:
   *   - render an inline warning panel above the button explaining
   *     the consequence,
   *   - extend the confirm() prompt with the same charge language,
   *   - surface the actually-charged amount in a confirmation toast
   *     after a successful delete (server may charge less if the
   *     balance was lower).
   * `0` disables all of this — the button behaves like a plain
   * delete with no billing chatter.
   */
  transcriptionFee?: number;
}

interface DeleteResponse {
  ok?: boolean;
  alreadyDeleted?: boolean;
  creditsCharged?: number;
  balanceAfter?: number;
  message?: string;
}

export function DeleteSessionButton({
  sessionId,
  label = "Delete session",
  confirmMessage = "Delete this session? This can't be undone.",
  variant = "ghost",
  size = "default",
  className,
  redirectTo = "/dashboard" as Route,
  disabled,
  transcriptionFee = 0,
}: DeleteSessionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const willCharge = transcriptionFee > 0;

  // Build the final confirmation prompt. We tack on the billing
  // sentence here (rather than asking each caller to repeat it) so
  // the warning copy stays in lockstep with the inline panel below
  // and the real server-side fee.
  const fullConfirmMessage = willCharge
    ? `${confirmMessage}\n\n` +
      `Heads up: ${formatCreditCount(transcriptionFee)} will be deducted from your balance ` +
      `to cover the transcription we already paid for. ` +
      `If your balance is lower, we'll only charge what you have.`
    : confirmMessage;

  const handleClick = () => {
    if (!window.confirm(fullConfirmMessage)) return;

    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as DeleteResponse;
        if (!res.ok) {
          setError(data.message ?? `Couldn't delete (${res.status}).`);
          return;
        }
        router.push(redirectTo);
        router.refresh();
      } catch (err) {
        console.error("[DeleteSessionButton] delete failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className={cn("inline-flex flex-col items-start gap-2", className)}>
      {willCharge && (
        <div
          role="note"
          className="flex max-w-md items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-200"
        >
          <CoinsIcon
            className="size-3.5 shrink-0 mt-0.5"
            aria-hidden
          />
          <span>
            Deleting now will charge{" "}
            <strong>{formatCreditCount(transcriptionFee)}</strong> for the
            transcription we already paid for on your behalf.
            {" "}
            If your balance is lower, we&apos;ll only charge what you have.
          </span>
        </div>
      )}
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn("text-destructive hover:bg-destructive/5")}
        // The button-variants palette doesn't include a destructive token
        // yet; pin the foreground inline so the affordance reads as
        // dangerous regardless of the chosen variant.
        style={{ color: "rgb(190, 18, 60)" }}
        disabled={disabled || pending}
        onClick={handleClick}
        aria-label={label}
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Deleting…
          </>
        ) : (
          <>
            <Trash2 className="size-4" aria-hidden />
            {label}
          </>
        )}
      </Button>
      {error && (
        <p
          role="alert"
          className="inline-flex items-center gap-1 text-xs"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

function formatCreditCount(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}
