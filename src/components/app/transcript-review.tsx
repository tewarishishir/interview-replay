"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Pencil,
  Save,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteSessionButton } from "@/components/app/delete-session-button";
import { transcriptionFeeForDelete } from "@/lib/credits/pricing";
import type { SerializedArtifact } from "@/lib/sessions/artifact-serializer";

/**
 * Browser-side transcript review screen.
 *
 * Responsibilities:
 *   - Render the transcript in a multi-line textarea (full edit
 *     surface — no rich text, no inline highlighting; the spec says
 *     "editable text area" and we don't want a hidden gotcha where
 *     a redaction marker becomes uneditable rich-text decoration).
 *   - Surface a persistent banner explaining that AI-inferred
 *     questions are estimates and the candidate should review them.
 *   - Surface AI-inferred question cards above the transcript. Each
 *     card shows the inferred question + a quoted snippet of the
 *     answer chunk it refers to (computed from the linked transcript
 *     offsets). Confirm / Edit / Wasn't asked actions update the
 *     server immediately and the local card-state in lockstep.
 *   - Surface the redaction-count banner when `redactionCount > 0`.
 *   - Surface the transcription-error banner when the transcript
 *     row carries a non-null `transcriptionError`.
 *   - Save edits explicitly via the "Save edits" button AND
 *     debounced auto-save 1.5s after the user stops typing.
 *   - "Continue to add context" navigates to /sessions/[id]/augment.
 *
 * Defensive notes:
 *   - We treat `editedText` (when present) as authoritative —
 *     reloading after an edit shouldn't re-display the redacted
 *     baseline. `redactedText` is only the seed for the very first
 *     render.
 *   - The AI-inferred card snippets always read from `redactedText`
 *     because the linked offsets were computed against that string;
 *     we surface the snippet purely as visual context and never
 *     edit the live transcript through it.
 *   - Auto-save is best-effort: a failed POST surfaces in the badge
 *     but doesn't block the user from continuing; the explicit
 *     "Save edits" CTA is the safety net.
 */

const AUTOSAVE_DEBOUNCE_MS = 1_500;
const SNIPPET_MAX_CHARS = 200;

type SaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

interface SessionMeta {
  id: string;
  companyName: string;
  roleTitle: string;
  level: string;
}

interface TranscriptDto {
  id: string;
  redactedText: string;
  editedText: string | null;
  redactionCount: number;
  transcriptionError: string | null;
  wordCount: number;
  fillerWordCount: number;
  durationSeconds: number;
}

export interface TranscriptReviewProps {
  session: SessionMeta;
  transcript: TranscriptDto | null;
  /**
   * AI-inferred question cards for this session — high, medium,
   * AND low confidence. Each card renders a `ConfidencePill` so
   * the candidate can see at a glance how reliable the guess is
   * before confirming or dismissing it. The server excludes
   * dismissed-and-not-restored rows; confirmed rows are still
   * passed through (they render with a "Confirmed" pill).
   *
   * Empty array is the normal "no inferences" state and the panel
   * collapses entirely.
   */
  inferredQuestions: SerializedArtifact[];
}

export function TranscriptReview({
  session,
  transcript,
  inferredQuestions,
}: TranscriptReviewProps) {
  const router = useRouter();

  const initial = useMemo(
    () => transcript?.editedText ?? transcript?.redactedText ?? "",
    [transcript?.editedText, transcript?.redactedText],
  );

  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  /**
   * `dirtyRef` tracks whether the local `text` differs from what
   * we last persisted. Stored as a ref so the auto-save scheduler
   * can read it without re-rendering on every keystroke.
   */
  const lastSavedRef = useRef(initial);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  const save = useCallback(
    async (next: string): Promise<void> => {
      if (next === lastSavedRef.current) {
        // No-op save (auto-save fired but the value matches what's
        // already on the server). Still surface "saved" so the UI
        // doesn't get stuck on "saving…".
        setStatus({ kind: "saved", at: new Date() });
        return;
      }

      // Cancel any in-flight save — a newer one is about to fire.
      saveAbortRef.current?.abort();
      const controller = new AbortController();
      saveAbortRef.current = controller;

      setStatus({ kind: "pending" });

      try {
        const res = await fetch(
          `/api/sessions/${session.id}/transcript`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ edited_text: next }),
            signal: controller.signal,
          },
        );

        if (!res.ok) {
          let detail = `Save failed with ${res.status}`;
          try {
            const body = (await res.json()) as { message?: string };
            if (body.message) detail = body.message;
          } catch {
            // body wasn't JSON
          }
          setStatus({ kind: "error", message: detail });
          return;
        }

        lastSavedRef.current = next;
        setStatus({ kind: "saved", at: new Date() });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setStatus({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Save failed. Check your connection.",
        });
      }
    },
    [session.id],
  );

  // Debounced auto-save. Triggered on every keystroke that mutates
  // `text`. The cleanup from the previous render cancels the prior
  // timer so only the most recent edit ends up triggering a POST.
  useEffect(() => {
    if (!transcript) return;
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
  }, [text, transcript, save]);

  // Cancel any in-flight save on unmount so the abort doesn't fire
  // mid-navigation and leave the user with a stale "error" badge.
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

  const handleContinue = useCallback(() => {
    // Make sure any pending edits land before we navigate. We don't
    // block on a successful save here; the user is allowed to move
    // on and the augment page can keep the same edits in memory if
    // a re-edit is needed.
    if (text !== lastSavedRef.current) {
      void save(text);
    }
    router.push(`/sessions/${session.id}/augment` as Route);
  }, [router, save, session.id, text]);

  // Empty-transcript fallback. Happens when the worker landed in
  // `review` with a `transcription_error` (transcription failed). The user
  // can still type their own transcript in or skip ahead.
  const showTranscriptionErrorBanner =
    transcript !== null && transcript.transcriptionError !== null;
  const showRedactionBanner =
    transcript !== null &&
    transcript.transcriptionError === null &&
    transcript.redactionCount > 0;

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {session.companyName} · review
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {session.roleTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          Level: {session.level}
        </p>
      </header>

      {showTranscriptionErrorBanner && transcript && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">
              We couldn&apos;t auto-transcribe your recording.
            </p>
            {transcript.transcriptionError &&
            transcript.transcriptionError.length >= 60 ? (
              <p className="text-destructive/90">
                {transcript.transcriptionError}
              </p>
            ) : (
              <p className="text-destructive/90">
                You can paste or type the transcript yourself, then
                continue to add context.
              </p>
            )}
          </div>
        </div>
      )}

      {showRedactionBanner && transcript && (
        <div
          role="status"
          className="mt-6 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
        >
          <ShieldAlert className="size-4 shrink-0 mt-0.5" aria-hidden />
          <span>
            We detected and redacted{" "}
            <strong>
              {transcript.redactionCount}
              {" "}
              {transcript.redactionCount === 1 ? "segment" : "segments"}
            </strong>{" "}
            that may have been the interviewer speaking. Review and edit as
            needed.
          </span>
        </div>
      )}

      {transcript && (
        <dl className="mt-6 grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Words</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {transcript.wordCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">
              Filler words
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {transcript.fillerWordCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">
              Duration
            </dt>
            <dd className="mt-1 font-medium tabular-nums">
              {Math.floor(transcript.durationSeconds / 60)}:
              {String(transcript.durationSeconds % 60).padStart(2, "0")}
            </dd>
          </div>
        </dl>
      )}

      {transcript && inferredQuestions.length > 0 && (
        <InferredQuestionsPanel
          sessionId={session.id}
          initialItems={inferredQuestions}
          // The snippets are derived from `redacted_text` because
          // the model's offsets were computed against it. We pass
          // the original verbatim so per-card "Edit"s don't have
          // to re-fetch from the server to render the answer
          // preview.
          redactedTranscript={transcript.redactedText}
        />
      )}

      <div className="mt-6 rounded-xl border border-border bg-background p-4">
        <label
          htmlFor="transcript-edit"
          className="text-sm font-medium text-muted-foreground"
        >
          Transcript
        </label>
        <textarea
          id="transcript-edit"
          aria-label="Transcript"
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

      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <DeleteSessionButton
          sessionId={session.id}
          confirmMessage="Delete this session? Your recording and transcript will be removed and you'll lose any edits. This can't be undone."
          disabled={status.kind === "pending"}
          // Review page is always state="review" (the server bounces
          // anything else here), so the only variable left for the
          // fee is the recording length. Compute the fee from the
          // same helper the API uses so the warning panel only fires
          // when an actual charge will land.
          transcriptionFee={transcriptionFeeForDelete(
            "review",
            transcript?.durationSeconds ?? null,
          )}
        />
        <Button
          type="button"
          variant="primary"
          size="lg"
          onClick={handleContinue}
        >
          Continue to add context
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
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

/* ─────────────────────────────────────────────────────────────────── */
/*                  AI-inferred questions panel                         */
/* ─────────────────────────────────────────────────────────────────── */

type CardState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

interface InferredItemState extends SerializedArtifact {
  /**
   * Per-card UX state. Held in the parent so a network error on
   * one card doesn't disturb the others' loading states.
   */
  ui: CardState;
}

function InferredQuestionsPanel({
  sessionId,
  initialItems,
  redactedTranscript,
}: {
  sessionId: string;
  initialItems: SerializedArtifact[];
  redactedTranscript: string;
}) {
  const [items, setItems] = useState<InferredItemState[]>(() =>
    initialItems.map((it) => ({ ...it, ui: { kind: "idle" } })),
  );

  // Filter out cards the candidate has already explicitly handled
  // (dismiss / confirm-and-move-on) so the panel doesn't clutter
  // up the review screen. Confirmed cards stay visible with a
  // "Confirmed" pill so the candidate can see what they've already
  // acted on this session.
  const visible = items.filter((it) => it.dismissedAt === null);

  if (visible.length === 0) return null;

  const setItem = (id: string, next: Partial<InferredItemState>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...next } : it)),
    );
  };

  const callAction = async (
    id: string,
    action: "confirm" | "dismiss",
  ): Promise<void> => {
    setItem(id, { ui: { kind: "pending" } });
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/artifacts/${id}/${action}`,
        {
          method: "POST",
          credentials: "same-origin",
        },
      );
      if (!res.ok) {
        const detail = await readError(res);
        setItem(id, { ui: { kind: "error", message: detail } });
        return;
      }
      const data = (await res.json()) as { artifact: SerializedArtifact };
      setItem(id, { ...data.artifact, ui: { kind: "idle" } });
    } catch (err) {
      setItem(id, {
        ui: {
          kind: "error",
          message: err instanceof Error ? err.message : "Action failed.",
        },
      });
    }
  };

  const callPatch = async (id: string, content: string): Promise<void> => {
    setItem(id, { ui: { kind: "pending" } });
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/artifacts/${id}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok) {
        const detail = await readError(res);
        setItem(id, { ui: { kind: "error", message: detail } });
        return;
      }
      const data = (await res.json()) as { artifact: SerializedArtifact };
      setItem(id, { ...data.artifact, ui: { kind: "idle" } });
    } catch (err) {
      setItem(id, {
        ui: {
          kind: "error",
          message: err instanceof Error ? err.message : "Edit failed.",
        },
      });
    }
  };

  return (
    <section
      aria-label="AI-inferred questions"
      className="mt-6 rounded-xl border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-900/60 dark:bg-blue-950/20"
    >
      <div
        role="status"
        className="flex items-start gap-2 text-sm text-blue-900 dark:text-blue-200"
      >
        <Sparkles className="size-4 shrink-0 mt-0.5" aria-hidden />
        <p>
          We&apos;ve guessed at the questions that prompted each part of
          your transcript. Each card shows a confidence band — confirm the
          ones that match what was actually asked, dismiss the ones that
          don&apos;t. Lower-confidence guesses are still useful to scan;
          you&apos;re the one who was in the room.
        </p>
      </div>

      <ul className="mt-4 space-y-3">
        {visible.map((item) => (
          <li key={item.id}>
            <InferredCard
              item={item}
              snippet={extractSnippet(redactedTranscript, item)}
              onConfirm={() => callAction(item.id, "confirm")}
              onDismiss={() => callAction(item.id, "dismiss")}
              onSaveEdit={(content) => callPatch(item.id, content)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InferredCard({
  item,
  snippet,
  onConfirm,
  onDismiss,
  onSaveEdit,
}: {
  item: InferredItemState;
  snippet: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
  onSaveEdit: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content ?? "");

  // When the parent re-renders after a server roundtrip we want the
  // draft to track the latest server value rather than fossilize on
  // the candidate's first input.
  useEffect(() => {
    if (!editing) setDraft(item.content ?? "");
  }, [item.content, editing]);

  const isConfirmed = item.userConfirmedAt !== null;
  const isPending = item.ui.kind === "pending";

  if (editing) {
    return (
      <div className="rounded-lg border border-blue-300 bg-background p-3 dark:border-blue-800/60">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100">
            <MessageCircle className="size-3" aria-hidden />
            AI-inferred
          </Badge>
          <span className="text-xs text-muted-foreground">
            Edit the actual question
          </span>
        </div>
        <textarea
          aria-label="Edit inferred question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(4, Math.max(2, draft.split("\n").length + 1))}
          className="mt-3 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(item.content ?? "");
              setEditing(false);
            }}
            disabled={isPending}
          >
            <X className="size-3.5" aria-hidden />
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={async () => {
              const trimmed = draft.trim();
              if (!trimmed) return;
              await onSaveEdit(trimmed);
              setEditing(false);
            }}
            disabled={isPending || draft.trim().length === 0}
          >
            {isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-300 bg-background p-3 dark:border-blue-800/60">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
        >
          <MessageCircle className="size-3" aria-hidden />
          AI-inferred
        </Badge>
        <ConfidencePill confidence={item.aiConfidence} />
        {isConfirmed && (
          <Badge variant="secondary" className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100">
            <Check className="size-3" aria-hidden />
            Confirmed
          </Badge>
        )}
      </div>

      <p className="mt-2 font-medium italic text-foreground">
        &ldquo;{item.content ?? ""}&rdquo;
      </p>

      {snippet && (
        <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
          <span className="font-medium uppercase tracking-wide">
            Refers to:
          </span>{" "}
          <span className="font-mono">{snippet}</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isConfirmed && (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            Confirm
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
          disabled={isPending}
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={isPending}
        >
          <X className="size-3.5" aria-hidden />
          Wasn&apos;t asked
        </Button>
        {item.ui.kind === "error" && (
          <span
            role="alert"
            className="ml-auto inline-flex items-center gap-1.5 text-xs text-destructive"
          >
            <AlertTriangle className="size-3.5" aria-hidden />
            {item.ui.message}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Color-coded badge for the inference's confidence band. The
 * three colors form a quick visual hierarchy so the candidate
 * can scan a list of suggestions without reading the label every
 * time:
 *   - green/emerald  high     "I'm pretty sure this was asked"
 *   - amber          medium   "Plausible — your call"
 *   - slate          low      "Weak guess, take a look"
 *
 * Returns null when the artifact carries no `aiConfidence` (i.e.
 * a user-added row that was somehow rendered through this code
 * path — defensive). The artifact-source check upstream already
 * guarantees we only render this for `ai_inferred` rows.
 */
function ConfidencePill({
  confidence,
}: {
  confidence: SerializedArtifact["aiConfidence"];
}) {
  if (!confidence) return null;
  const styles: Record<string, string> = {
    high: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100",
    medium: "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
    low: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200",
  };
  const label: Record<string, string> = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence",
  };
  // Defensive fallback: a future DB enum extension OR an old
  // client hitting a newer server during a rolling deploy could
  // produce a band string we don't yet have styling for. Render a
  // neutral pill that still tells the candidate what they're
  // looking at (instead of an empty `<Badge>` with `undefined`
  // children, which collapses visually).
  const style =
    styles[confidence] ?? "bg-muted text-muted-foreground";
  const text = label[confidence] ?? `${confidence} confidence`;
  return (
    <Badge variant="secondary" className={style}>
      {text}
    </Badge>
  );
}

/**
 * Pull the answer-chunk preview text out of the redacted transcript
 * using the linked offsets the inference pass wrote. We clamp to
 * `SNIPPET_MAX_CHARS` so a long answer doesn't visually dominate
 * the card; if the source string we're handed is shorter than the
 * recorded offsets (e.g. a stale render after a hot-reload), we
 * gracefully fall through to no snippet rather than throwing.
 */
function extractSnippet(
  redactedTranscript: string,
  item: SerializedArtifact,
): string | null {
  const offset = item.linkedTranscriptOffset;
  const length = item.linkedTranscriptLength;
  if (offset === null || length === null) return null;
  if (offset < 0 || length <= 0) return null;
  const end = Math.min(redactedTranscript.length, offset + length);
  if (offset >= end) return null;
  const slice = redactedTranscript.slice(offset, end).trim();
  if (slice.length === 0) return null;
  if (slice.length <= SNIPPET_MAX_CHARS) return slice;
  return slice.slice(0, SNIPPET_MAX_CHARS).trimEnd() + "…";
}

async function readError(res: Response): Promise<string> {
  let detail = `Request failed with ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = body.message;
  } catch {
    // body wasn't JSON
  }
  return detail;
}
