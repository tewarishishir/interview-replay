"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageSquarePlus,
  Star,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FEEDBACK_DISPLAY_NAME_MAX,
  FEEDBACK_DISPLAY_ROLE_MAX,
  FEEDBACK_MESSAGE_MAX,
} from "@/lib/feedback/schemas";

/**
 * Floating "Feedback" widget mounted in every authenticated layout
 * (`(app)`, `(admin)`). Renders a small fixed-position pill in the
 * bottom-right corner; clicking opens a modal with the submission
 * form.
 *
 * Visibility rules:
 *
 *   - `userId === null` → render nothing. The widget assumes its
 *     caller (a server-component layout) has resolved the active
 *     session and is passing the id in. This keeps the client
 *     bundle free of an `useSession()` round-trip on every render.
 *   - Sensitive recording surfaces (`/sessions/<id>/record`) hide
 *     the widget so it doesn't compete with the mic-button focus
 *     state. The recording flow's own header has a "Report a
 *     problem" affordance — the user isn't blocked from giving
 *     feedback, they just don't get the bottom-right pill while
 *     the call is live.
 *
 * The form posts to `POST /api/feedback`; on success the modal
 * switches to a "Thanks" confirmation state and auto-dismisses
 * after 2.5s (or on explicit close). The candidate's typed text
 * is cleared on every successful submit so a second submission
 * starts fresh.
 *
 * The `page_path` field is set from `usePathname()` at submit time
 * — query strings are stripped client-side so we don't smuggle
 * UTM or one-time tokens into the analytics + admin queue.
 */
export function FeedbackWidget({ userId }: { userId: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Hide on the recording surface (see component header). All
  // other paths get the widget. Use `startsWith` so dynamic
  // segments (e.g. /sessions/<uuid>/record) match without a
  // regex.
  const hideOnPath = useMemo(() => {
    if (!pathname) return false;
    return pathname.startsWith("/sessions/") && pathname.endsWith("/record");
  }, [pathname]);

  if (userId === null) return null;
  if (hideOnPath) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 print:hidden"
      >
        <MessageSquarePlus className="size-4" aria-hidden />
        Feedback
      </button>
      {open && (
        <FeedbackModal
          pathname={pathname}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface FeedbackModalProps {
  pathname: string | null;
  onClose: () => void;
}

function FeedbackModal({ pathname, onClose }: FeedbackModalProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayRole, setDisplayRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  const firstFocusableRef = useRef<HTMLButtonElement | null>(null);

  // Focus the first star on open so keyboard users land on a
  // useful control instead of the close button.
  useEffect(() => {
    firstFocusableRef.current?.focus();
  }, []);

  // Auto-dismiss the success confirmation after a beat so the
  // candidate isn't stranded in a "Thanks!" panel.
  useEffect(() => {
    if (!submitted) return;
    const t = window.setTimeout(onClose, 2500);
    return () => window.clearTimeout(t);
  }, [submitted, onClose]);

  // ESC closes — standard modal convention. Mouse close goes
  // through the backdrop click handler below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remaining = FEEDBACK_MESSAGE_MAX - message.length;
  const canSubmit =
    !isPending &&
    !submitted &&
    rating !== null &&
    message.trim().length > 0 &&
    message.length <= FEEDBACK_MESSAGE_MAX;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || rating === null) return;
    setError(null);
    startTransition(async () => {
      try {
        // Strip any query string from the path — we never want
        // to retain one-time tokens / UTM in the audit row.
        const pathWithoutQuery =
          pathname?.split("?")[0]?.split("#")[0] ?? null;
        const body = {
          rating,
          message: message.trim(),
          consentPublic: consent,
          displayName: consent ? displayName.trim() : "",
          displayRole: consent ? displayRole.trim() : "",
          pagePath: pathWithoutQuery ?? "",
        };
        const res = await fetch("/api/feedback", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
          };
          if (res.status === 429) {
            setError(
              data.message ??
                "You've sent a lot of feedback recently — try again later.",
            );
          } else if (res.status === 400) {
            setError(
              data.message ?? "Please check the form for issues and try again.",
            );
          } else {
            setError(
              data.message ??
                "Something went wrong. Please try again in a moment.",
            );
          }
          return;
        }
        setSubmitted(true);
      } catch (err) {
        console.error("[FeedbackWidget] submit failed:", err);
        setError("Network error. Please try again in a moment.");
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-modal-heading"
      className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 px-4 pb-4 backdrop-blur-sm sm:items-center sm:justify-end sm:pb-0 sm:pr-4"
      onClick={(e) => {
        // Click on the backdrop (not on the modal body) dismisses.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-xl"
        // `noValidate` keeps the browser's native bubbles out of the
        // way — our zod errors are richer.
      >
        <div className="flex items-start justify-between">
          <h2
            id="feedback-modal-heading"
            className="text-base font-semibold text-foreground"
          >
            {submitted ? "Thanks — we read every one." : "Tell us how it's going"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close feedback"
            className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {submitted ? (
          <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden />
            <p>
              Your feedback is in. If it&apos;s OK to feature, we&apos;ll reach
              out before publishing anything publicly.
            </p>
          </div>
        ) : (
          <form className="mt-3 space-y-4" onSubmit={handleSubmit} noValidate>
            <fieldset>
              <legend className="text-xs font-medium text-foreground">
                How would you rate InterviewReplay so far?{" "}
                <span className="text-destructive">*</span>
              </legend>
              <div
                className="mt-1.5 inline-flex items-center gap-1"
                role="radiogroup"
                aria-label="Rating"
              >
                {[1, 2, 3, 4, 5].map((value) => {
                  const active = rating !== null && value <= rating;
                  return (
                    <button
                      type="button"
                      key={value}
                      ref={value === 1 ? firstFocusableRef : undefined}
                      role="radio"
                      aria-checked={rating === value}
                      aria-label={`${value} out of 5`}
                      onClick={() => setRating(value)}
                      className="rounded-md p-1 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
                    >
                      <Star
                        className={
                          active
                            ? "size-6 fill-amber-400 text-amber-500"
                            : "size-6 text-muted-foreground/40"
                        }
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label
                htmlFor="feedback-message"
                className="text-xs font-medium text-foreground"
              >
                What stood out (good or bad)?{" "}
                <span className="text-destructive">*</span>
              </label>
              <Textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={FEEDBACK_MESSAGE_MAX}
                placeholder="The honest details help more than a star count."
                className="mt-1.5"
              />
              <p
                className={`mt-1 text-xs ${
                  remaining < 100
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground"
                }`}
              >
                {remaining} characters left
              </p>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="feedback-consent"
                checked={consent}
                onCheckedChange={(v) => setConsent(v === true)}
                className="mt-0.5"
              />
              <label
                htmlFor="feedback-consent"
                className="text-xs text-foreground"
              >
                OK to feature this on the InterviewReplay home page (we&apos;ll only
                use what you fill in below — no email or session
                details).
              </label>
            </div>

            {consent && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="feedback-display-name"
                    className="text-xs font-medium text-foreground"
                  >
                    Display name <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    id="feedback-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={FEEDBACK_DISPLAY_NAME_MAX}
                    placeholder="e.g. Priya R."
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <label
                    htmlFor="feedback-display-role"
                    className="text-xs font-medium text-foreground"
                  >
                    Role / title <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    id="feedback-display-role"
                    value={displayRole}
                    onChange={(e) => setDisplayRole(e.target.value)}
                    maxLength={FEEDBACK_DISPLAY_ROLE_MAX}
                    placeholder="e.g. Senior PM"
                    className="mt-1.5"
                  />
                </div>
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="flex items-start gap-1.5 text-xs text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-3.5" aria-hidden />
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="default"
                size="sm"
                disabled={!canSubmit}
              >
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Sending…
                  </>
                ) : (
                  "Send feedback"
                )}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
