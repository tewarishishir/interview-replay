"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";

import { Button } from "@/components/ui/button";

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
  overLimit: boolean;
}

export function TranscriptEdit({
  sessionId,
  transcript,
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
    analyzePending || overLimit || status.kind === "pending";

  const handleReanalyze = useCallback(() => {
    if (reanalyzeDisabled) return;

    const message =
      "Re-analyze this interview based on the current transcript text?\n\n" +
      "We'll regenerate your report from scratch.";
    if (!window.confirm(message)) return;

    setAnalyzeError(null);
    setAnalyzePending(true);
    void (async () => {
      try {
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

        router.push(`/sessions/${sessionId}`);
        router.refresh();
      } catch (err) {
        console.error("[TranscriptEdit] re-analyze failed:", err);
        setAnalyzeError("Something went wrong. Please try again.");
        setAnalyzePending(false);
      }
    })();
  }, [reanalyzeDisabled, router, save, sessionId, text]);

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
        {overLimit && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900"
          >
            This recording is longer than 120 minutes. Re-analysis tops out
            at the 120-minute bucket — please trim the recording in a new
            session before re-running.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
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
                Re-analyze
              </>
            )}
          </Button>
        </div>

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
