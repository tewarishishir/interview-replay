"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Client form for recording or editing the outcome of a completed
 * interview. Renders inside the `/sessions/[id]/outcome` page; the
 * page is server-rendered and pre-fills `initial` when the user
 * is editing an existing outcome.
 *
 * Submit calls the JSON API (POST for new, PATCH for edits). On
 * success we navigate back to the report view, where the outcome
 * card now reflects the saved state.
 *
 * Validation duplicates the server-side Zod schema (length caps,
 * required outcome_type, conditional next_round_type) so the user
 * sees inline errors instead of a 400 round-trip. The server is
 * still authoritative — the client checks are purely UX.
 */

const OUTCOME_OPTIONS = [
  {
    value: "advanced_to_next_round",
    label: "Advanced to next round",
    description: "The company invited you to the next stage.",
  },
  {
    value: "received_offer",
    label: "Received an offer",
    description: "Congrats!",
  },
  {
    value: "did_not_advance",
    label: "Did not advance",
    description: "You didn't move forward to the next round.",
  },
  {
    value: "withdrew",
    label: "I withdrew from the process",
    description: "You decided to step out.",
  },
  {
    value: "no_response",
    label: "No response from the company",
    description: "It's been a while and you haven't heard anything.",
  },
  {
    value: "other",
    label: "Other",
    description: "Something else.",
  },
] as const;

type OutcomeType = (typeof OUTCOME_OPTIONS)[number]["value"];

interface OutcomeFormState {
  outcomeType: OutcomeType | "";
  outcomeReceivedAt: string; // YYYY-MM-DD; we convert to ISO at submit time.
  nextRoundType: string;
  feedbackReceived: string;
  noFeedbackShared: boolean;
  askedForFeedback: boolean;
  reflectionNotes: string;
  wouldChange: string;
}

const FEEDBACK_MAX = 5000;
const REFLECTION_MAX = 5000;
const WOULD_CHANGE_MAX = 500;
const NEXT_ROUND_MAX = 200;

/** Converts an ISO timestamp or YYYY-MM-DD string to the local YYYY-MM-DD for <input type="date">. */
function toLocalDateInput(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const empty = (): OutcomeFormState => ({
  outcomeType: "",
  outcomeReceivedAt: "",
  nextRoundType: "",
  feedbackReceived: "",
  noFeedbackShared: false,
  askedForFeedback: false,
  reflectionNotes: "",
  wouldChange: "",
});

export interface OutcomeFormInitial {
  outcomeType: OutcomeType | "";
  outcomeReceivedAt: string;
  nextRoundType: string;
  feedbackReceived: string;
  noFeedbackShared: boolean;
  askedForFeedback: boolean;
  reflectionNotes: string;
  wouldChange: string;
}

interface OutcomeFormProps {
  sessionId: string;
  /**
   * When editing an existing outcome, the current values; null
   * when recording a new one. The page does the load — this
   * component never fetches on its own.
   */
  initial: OutcomeFormInitial | null;
}

export function OutcomeForm({ sessionId, initial }: OutcomeFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<OutcomeFormState>(
    initial
      ? { ...initial, outcomeReceivedAt: toLocalDateInput(initial.outcomeReceivedAt) }
      : empty()
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isEditing = initial !== null;

  /**
   * Convert form state into the JSON body the API expects. We
   * trim everywhere and convert empty strings to `undefined` so
   * the PATCH path doesn't accidentally clear a field that was
   * left untouched. (`undefined` keys are dropped by JSON.stringify.)
   *
   * Date handling: we get YYYY-MM-DD from `<input type="date">`,
   * but a few mobile browsers and the user's "type freely" path
   * (some browsers allow text editing inside the date input) can
   * surface a malformed value. We validate the shape with a
   * regex AND `Date.parse` before constructing — a `new Date()`
   * on garbage produces an `Invalid Date`, and `.toISOString()`
   * on that throws RangeError, which would crash the submit
   * before the server ever sees it.
   */
  const toApiBody = useCallback((s: OutcomeFormState) => {
    const trim = (v: string) => v.trim();
    const t = (v: string) => (trim(v).length === 0 ? undefined : trim(v));

    const dateRaw = trim(s.outcomeReceivedAt);
    let outcomeReceivedAtIso: string | undefined;
    if (dateRaw.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      const ts = Date.parse(`${dateRaw}T00:00:00Z`);
      if (Number.isFinite(ts)) {
        outcomeReceivedAtIso = new Date(ts).toISOString();
      }
    }

    // When "No feedback was shared" is checked, send null explicitly
    // so the server clears any existing feedback text.
    const feedbackValue = s.noFeedbackShared
      ? undefined // null handled below via explicit null
      : t(s.feedbackReceived);

    return {
      outcome_type: s.outcomeType === "" ? undefined : s.outcomeType,
      outcome_received_at: outcomeReceivedAtIso,
      next_round_type:
        s.outcomeType === "advanced_to_next_round" ? t(s.nextRoundType) : undefined,
      feedback_received: s.noFeedbackShared ? null : feedbackValue,
      reflection_notes: t(s.reflectionNotes),
      would_change: t(s.wouldChange),
      asked_for_feedback: s.askedForFeedback,
    };
  }, []);

  const validateLocal = useCallback((s: OutcomeFormState) => {
    const errs: Record<string, string> = {};
    if (!isEditing && s.outcomeType === "") {
      errs.outcome_type = "Please pick one.";
    }
    if (!s.noFeedbackShared && s.feedbackReceived.length > FEEDBACK_MAX) {
      errs.feedback_received = `Up to ${FEEDBACK_MAX.toLocaleString()} characters.`;
    }
    if (s.reflectionNotes.length > REFLECTION_MAX) {
      errs.reflection_notes = `Up to ${REFLECTION_MAX.toLocaleString()} characters.`;
    }
    if (s.wouldChange.length > WOULD_CHANGE_MAX) {
      errs.would_change = `Up to ${WOULD_CHANGE_MAX} characters.`;
    }
    if (
      s.outcomeType === "advanced_to_next_round" &&
      s.nextRoundType.length > NEXT_ROUND_MAX
    ) {
      errs.next_round_type = `Up to ${NEXT_ROUND_MAX} characters.`;
    }
    const dateRaw = s.outcomeReceivedAt.trim();
    if (dateRaw.length > 0) {
      // Accept only canonical YYYY-MM-DD from the date input. A
      // browser quirk that yields anything else (some mobile
      // browsers, paste-into-text fallback) gets surfaced inline
      // instead of silently dropping the value at serialize time.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        errs.outcome_received_at = "Please use the date picker.";
      } else {
        const ts = Date.parse(`${dateRaw}T00:00:00Z`);
        if (!Number.isFinite(ts)) {
          errs.outcome_received_at = "That date doesn't look right.";
        } else if (ts > Date.now() + 24 * 60 * 60 * 1000) {
          errs.outcome_received_at = "Date can't be in the future.";
        }
      }
    }
    return errs;
  }, [isEditing]);

  const wouldChangeCount = state.wouldChange.length;
  const showNextRound = state.outcomeType === "advanced_to_next_round";

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormError(null);
      const localErrs = validateLocal(state);
      if (Object.keys(localErrs).length > 0) {
        setFieldErrors(localErrs);
        return;
      }
      setFieldErrors({});

      const body = toApiBody(state);
      startTransition(async () => {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/outcome`, {
            method: isEditing ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (res.ok) {
            router.push(`/sessions/${sessionId}`);
            router.refresh();
            return;
          }

          let payload: {
            error?: string;
            message?: string;
            fieldErrors?: Record<string, string>;
          } = {};
          try {
            payload = await res.json();
          } catch {
            /* best-effort */
          }

          if (res.status === 409) {
            setFormError(
              isEditing
                ? "This outcome was just modified by another tab. Refresh and try again."
                : "An outcome already exists for this session. Edit it instead.",
            );
            return;
          }
          if (res.status === 400 && payload.fieldErrors) {
            setFieldErrors(payload.fieldErrors);
            return;
          }
          if (res.status === 401) {
            setFormError("Session expired. Please sign in again.");
            return;
          }
          setFormError(
            payload.message ??
              "Something went wrong saving your outcome. Please try again.",
          );
        } catch (err) {
          console.error("[outcome-form] submit failed:", err);
          setFormError(
            "We couldn't reach the server. Check your connection and try again.",
          );
        }
      });
    },
    [
      isEditing,
      router,
      sessionId,
      state,
      toApiBody,
      validateLocal,
    ],
  );

  const onCancel = useCallback(() => {
    router.push(`/sessions/${sessionId}`);
  }, [router, sessionId]);

  const todayIso = useMemo(() => {
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          What was the outcome?{" "}
          <span className="text-destructive" aria-hidden>
            *
          </span>
        </legend>
        <RadioGroup
          value={state.outcomeType}
          onValueChange={(v) =>
            setState((s) => ({ ...s, outcomeType: v as OutcomeType }))
          }
          aria-label="Outcome"
        >
          {OUTCOME_OPTIONS.map((opt) => {
            const id = `outcome-${opt.value}`;
            return (
              <Label
                key={opt.value}
                htmlFor={id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/40",
                  state.outcomeType === opt.value &&
                    "border-foreground/40 bg-muted/40",
                )}
              >
                <RadioGroupItem
                  id={id}
                  value={opt.value}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {opt.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>
        {fieldErrors.outcome_type && (
          <p className="text-sm text-destructive">
            {fieldErrors.outcome_type}
          </p>
        )}
      </fieldset>

      {showNextRound && (
        <div className="space-y-2">
          <Label htmlFor="next-round-type">What&apos;s the next round?</Label>
          <Input
            id="next-round-type"
            type="text"
            maxLength={NEXT_ROUND_MAX}
            placeholder="System design with hiring manager · Onsite loop · Final round with VP"
            value={state.nextRoundType}
            onChange={(e) =>
              setState((s) => ({ ...s, nextRoundType: e.target.value }))
            }
            aria-invalid={Boolean(fieldErrors.next_round_type)}
          />
          {fieldErrors.next_round_type && (
            <p className="text-sm text-destructive">
              {fieldErrors.next_round_type}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="outcome-received-at">When did you hear back?</Label>
        <Input
          id="outcome-received-at"
          type="date"
          max={todayIso}
          value={state.outcomeReceivedAt}
          onChange={(e) =>
            setState((s) => ({ ...s, outcomeReceivedAt: e.target.value }))
          }
          aria-invalid={Boolean(fieldErrors.outcome_received_at)}
        />
        <p className="text-xs text-muted-foreground">
          Optional.
          {fieldErrors.outcome_received_at && (
            <span className="ml-2 text-destructive">
              {fieldErrors.outcome_received_at}
            </span>
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="feedback-received">
          Did the company share any feedback?
        </Label>
        <Textarea
          id="feedback-received"
          rows={4}
          maxLength={FEEDBACK_MAX}
          placeholder="Paste any feedback the company shared, or leave blank if none."
          value={state.noFeedbackShared ? "" : state.feedbackReceived}
          disabled={state.noFeedbackShared}
          onChange={(e) =>
            setState((s) => ({ ...s, feedbackReceived: e.target.value }))
          }
          aria-invalid={Boolean(fieldErrors.feedback_received)}
          className={state.noFeedbackShared ? "opacity-40" : undefined}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="no-feedback-shared"
            checked={state.noFeedbackShared}
            onCheckedChange={(checked) =>
              setState((s) => ({
                ...s,
                noFeedbackShared: checked === true,
                feedbackReceived: checked === true ? "" : s.feedbackReceived,
              }))
            }
          />
          <Label
            htmlFor="no-feedback-shared"
            className="text-xs font-normal text-muted-foreground cursor-pointer"
          >
            No feedback was shared
          </Label>
        </div>
        {fieldErrors.feedback_received && (
          <p className="text-sm text-destructive">
            {fieldErrors.feedback_received}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          We keep this private to your account and use it only for your
          coaching.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="asked-for-feedback"
            checked={state.askedForFeedback}
            onCheckedChange={(checked) =>
              setState((s) => ({
                ...s,
                askedForFeedback: checked === true,
              }))
            }
          />
          <Label
            htmlFor="asked-for-feedback"
            className="text-sm font-normal cursor-pointer"
          >
            I asked the company for feedback
          </Label>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="reflection-notes">Your reflection notes</Label>
        <Textarea
          id="reflection-notes"
          rows={4}
          maxLength={REFLECTION_MAX}
          placeholder="Looking back, what do you think actually happened? What surprised you?"
          value={state.reflectionNotes}
          onChange={(e) =>
            setState((s) => ({ ...s, reflectionNotes: e.target.value }))
          }
          aria-invalid={Boolean(fieldErrors.reflection_notes)}
        />
        {fieldErrors.reflection_notes && (
          <p className="text-xs text-destructive">
            {fieldErrors.reflection_notes}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="would-change">
          If you could redo this interview, what&apos;s the one thing you&apos;d
          change?
        </Label>
        <Input
          id="would-change"
          type="text"
          maxLength={WOULD_CHANGE_MAX}
          placeholder="One specific thing — your one-line takeaway"
          value={state.wouldChange}
          onChange={(e) =>
            setState((s) => ({ ...s, wouldChange: e.target.value }))
          }
          aria-invalid={Boolean(fieldErrors.would_change)}
        />
        <p className="text-xs text-muted-foreground">
          {wouldChangeCount}/{WOULD_CHANGE_MAX} characters.
          {fieldErrors.would_change && (
            <span className="ml-2 text-destructive">
              {fieldErrors.would_change}
            </span>
          )}
        </p>
      </div>

      {formError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {formError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            "Save outcome"
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
