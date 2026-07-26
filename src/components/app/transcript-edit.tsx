"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Post-analysis "edit call text & re-analyze" surface.
 *
 * Reachable from the report sidebar once a session is `complete`.
 * Two responsibilities:
 *
 *   1. Let the candidate read and tweak `edited_text`. Auto-save
 *      mirrors the cadence on the pre-analysis review screen
 *      (debounced ~1.5s). The same PATCH endpoint backs both
 *      surfaces; the server now allows edits from `complete` so
 *      the candidate doesn't have to drop back to a draft state
 *      to fix a typo.
 *
 *   2. Re-run analysis. The CTA shows the worst-case price (the
 *      credits the user would owe outside the 24h free window) so
 *      they're never surprised by a charge they didn't expect.
 *      A confirm dialog spells out the exact amount that will be
 *      consumed *this* click before we POST. If the API ends up
 *      charging zero (free re-analysis), the user gets a happy
 *      surprise rather than a "wait, why did that cost something"
 *      moment.
 */

const AUTOSAVE_DEBOUNCE_MS = 1_500;

type SaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

interface TranscriptDto {
  id: string;
  editedText: string | null;
  redactedText: string;
  durationSeconds: number;
  wordCount: number;
}

export interface TranscriptEditProps {
  sessionId: string;
  transcript: TranscriptDto;
  /**
   * Worst-case price (what the user would owe outside the 24h
   * free window). `null` when we couldn't compute a price — over
   * the 120-minute cap, zero-duration, etc. — in which case the
   * action is disabled.
   */
  baseCredits: number | null;
  /**
   * What the API will actually consume on a click right now: 0
   * inside the 24h free window, otherwise equal to `baseCredits`.
   */
  discountedCredits: number;
  /** Whether `discountedCredits` reflects the 24h free discount. */
  free: boolean;
  /** Whether the user has enough credits to cover `discountedCredits`. */
  canAfford: boolean;
  creditBalance: number;
  overLimit: boolean;
}

export function TranscriptEdit({
  sessionId,
  transcript,
  baseCredits,
  discountedCredits,
  free,
  canAfford,
  creditBalance,
  overLimit,
}: TranscriptEditProps) {
  const router = useRouter();

  const initial = useMemo(
    () => transcript.editedText ?? transcript.redactedText ?? "",
    [transcript.editedText, transcript.redactedText],
  );

  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [analyzePending, setAnalyzePending] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const lastSavedRef = useRef(initial);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  const save = useCallback(
    async (next: string): Promise<boolean> => {
      if (next === lastSavedRef.current) {
        setStatus({ kind: "saved", at: new Date() });
        return true;
      }

      saveAbortRef.current?.abort();
      const controller = new AbortController();
      saveAbortRef.current = controller;

      setStatus({ kind: "pending" });

      try {
        const res = await fetch(`/api/sessions/${sessionId}/transcript`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edited_text: next }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let detail = `Save failed with ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body.message) detail = body.message;
          } catch {
            // body wasn't JSON
          }
          setStatus({ kind: "error", message: detail });
          return false;
        }

        lastSavedRef.current = next;
        setStatus({ kind: "saved", at: new Date() });
        return true;
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return false;
        setStatus({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Save failed. Check your connection.",
        });
        return false;
      }
    },
    [sessionId],
  );

  // Debounced auto-save. Mirrors the pre-analysis review screen so
  // edits land even if the user navigates away without clicking
  // "Re-analyze". The report on /sessions/:id will pick up a stale
  // banner if the saved text is newer than the last report.
  useEffect(() => {
    if (text === lastSavedRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      void save(text);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [text, save]);

  useEffect(() => {
    return () => {
      saveAbortRef.current?.abort();
    };
  }, []);

  const handleExplicitSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    void save(text);
  }, [save, text]);

  const reanalyzeDisabled =
    analyzePending ||
    overLimit ||
    baseCredits === null ||
    !canAfford ||
    status.kind === "pending";

  const handleReanalyze = useCallback(() => {
    if (reanalyzeDisabled) return;

    // Spell out the exact charge before any commit. We use the
    // discounted price (what will actually leave the user's
    // balance) — `baseCredits` is what they'd see on the button
    // when there's no discount. If the discount applies, the
    // dialog says "no charge" and the button still shows the
    // worst-case so it stays an honest ceiling.
    const chargeLine =
      discountedCredits === 0
        ? "This is your one free re-run for this session — no credits will be charged. Any future re-analysis will be billed at the full price."
        : `This will charge ${discountedCredits} credit${
            discountedCredits === 1 ? "" : "s"
          } from your balance of ${creditBalance}.`;
    const message =
      `Re-analyze this interview based on the current transcript text?\n\n${chargeLine}\n\n` +
      "We'll regenerate your report from scratch.";
    if (!window.confirm(message)) return;

    setAnalyzeError(null);
    setAnalyzePending(true);
    void (async () => {
      try {
        // Flush any pending edits before we hit the analyze
        // endpoint so the new report is grounded against the text
        // the user is looking at right now — not a debounced-but-
        // not-yet-sent version that loses the race.
        if (text !== lastSavedRef.current) {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
          const ok = await save(text);
          if (!ok) {
            setAnalyzeError(
              "Couldn't save your edits before re-analyzing. Please try again.",
            );
            setAnalyzePending(false);
            return;
          }
        }

        const res = await fetch(`/api/sessions/${sessionId}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });

        if (res.status === 402) {
          router.push("/credits/buy");
          return;
        }

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          setAnalyzeError(
            data.message ??
              `Couldn't start analysis (${res.status}). Please try again.`,
          );
          setAnalyzePending(false);
          return;
        }

        // 202 Accepted — bounce to the detail page so the user
        // sees the "we're analyzing" panel.
        router.push(`/sessions/${sessionId}`);
        router.refresh();
      } catch (err) {
        console.error("[TranscriptEdit] re-analyze failed:", err);
        setAnalyzeError("Something went wrong. Please try again.");
        setAnalyzePending(false);
      }
    })();
  }, [
    creditBalance,
    discountedCredits,
    reanalyzeDisabled,
    router,
    save,
    sessionId,
    text,
  ]);

  const buttonLabel = (() => {
    if (baseCredits === null) return "Re-analyze (unavailable)";
    if (discountedCredits === 0) return "Re-analyze (free re-run)";
    return `Re-analyze (${discountedCredits} credit${
      discountedCredits === 1 ? "" : "s"
    })`;
  })();

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-xl border border-border bg-background p-4">
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor="transcript-edit"
            className="text-sm font-medium text-muted-foreground"
          >
            Call text
          </label>
          <p className="text-xs text-muted-foreground tabular-nums">
            {transcript.wordCount.toLocaleString()} words ·{" "}
            {Math.floor(transcript.durationSeconds / 60)}:
            {String(transcript.durationSeconds % 60).padStart(2, "0")}
          </p>
        </div>
        <textarea
          id="transcript-edit"
          aria-label="Call text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={true}
          rows={20}
          className="mt-2 block min-h-[24rem] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
          placeholder="Your transcript will appear here. Edit freely — we'll auto-save."
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <SaveBadge status={status} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExplicitSave}
            disabled={status.kind === "pending"}
          >
            {status.kind === "pending" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              <>
                <Save className="size-3.5" aria-hidden />
                Save edits
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Re-analysis cost
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight">
              {baseCredits === null ? (
                <span className="text-base font-normal text-muted-foreground">
                  unavailable
                </span>
              ) : free ? (
                <span>
                  <span className="text-muted-foreground line-through">
                    {baseCredits}
                  </span>{" "}
                  0 credits
                </span>
              ) : (
                <span>
                  {baseCredits} credit{baseCredits === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {free ? (
              <p className="mt-1 text-xs text-muted-foreground">
                One free re-run per session, within 24 hours of your last
                analysis. After this run, each re-analysis costs 1 credit.
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Re-analyzing this session costs 1 credit.
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Wallet className="size-3.5" aria-hidden />
              Your balance
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {creditBalance} credit{creditBalance === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        {overLimit && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900"
          >
            This recording is longer than 120 minutes. Re-analysis tops out
            at the 120-minute bucket — please trim the recording in a new
            session before re-running.
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={handleReanalyze}
            disabled={reanalyzeDisabled}
          >
            {analyzePending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Starting analysis…
              </>
            ) : (
              <>
                <RefreshCw className="size-4" aria-hidden />
                {buttonLabel}
              </>
            )}
          </Button>
          {!overLimit && baseCredits !== null && !canAfford && (
            <Button asChild variant="outline" size="lg">
              <a href="/credits/buy">Buy credits</a>
            </Button>
          )}
        </div>

        {!overLimit && baseCredits !== null && !canAfford && (
          <p className="mt-3 text-sm text-muted-foreground">
            You need {Math.max(0, discountedCredits - creditBalance)} more
            credit
            {Math.max(0, discountedCredits - creditBalance) === 1 ? "" : "s"}{" "}
            to re-analyze.
          </p>
        )}

        {analyzeError && (
          <p
            role="alert"
            className="mt-3 text-sm"
            style={{ color: "rgb(190, 18, 60)" }}
          >
            {analyzeError}
          </p>
        )}
      </div>
    </div>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status.kind === "idle") return <span>Auto-save on</span>;
  if (status.kind === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  if (status.kind === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-600">
        <CheckCircle2 className="size-3.5" aria-hidden />
        Saved
      </span>
    );
  }
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1.5 text-destructive"
    >
      <AlertTriangle className="size-3.5" aria-hidden />
      {status.message}
    </span>
  );
}
