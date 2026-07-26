"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Code as CodeIcon,
  HelpCircle,
  Image as ImageIcon,
  Layout,
  Loader2,
  MessageCircle,
  NotebookPen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import type {
  ActiveArtifactType,
  InterviewSessionState,
} from "@/lib/db/schema";
import type { SerializedArtifact } from "@/lib/sessions/artifact-serializer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteSessionButton } from "@/components/app/delete-session-button";
const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
const MAX_ARTIFACT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Per-textarea character ceiling used by the augment screen.
 *
 * Mirrors `createArtifactBodySchema.content` (50,000 chars) on the
 * server so the client UX rejects oversize input before a network
 * round-trip. The limit is intentionally generous for legitimate
 * answers (a 10-minute monologue is roughly 12,000 chars) but
 * tight enough to defend against pasted-in megabytes that would
 * otherwise be billed verbatim through the analyzer.
 */
const MAX_TEXT_ARTIFACT_CHARS = 50_000;

/**
 * Image-batch limits for the design-notes uploader. Caps the
 * single-action upload to 20 files totalling 50 MB. Each individual
 * file is still bounded by `MAX_ARTIFACT_IMAGE_BYTES` (5 MB) at the
 * presign route — these batch limits sit on top of that.
 */
const MAX_IMAGES_PER_BATCH = 20;
const MAX_TOTAL_IMAGE_BYTES_PER_BATCH = 50 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;

/**
 * Browser-side "add context" screen.
 *
 * Sections:
 *   - Questions you were asked   (artifact_type: question)
 *       Three groupings, visually distinct:
 *         1. ✓ Confirmed — user_added rows + ai_inferred rows the
 *            candidate has confirmed (or edited).
 *         2. 🤖 Suggested by AI — ai_inferred rows the candidate
 *            hasn't confirmed or dismissed yet.
 *         3. ✗ Dismissed — collapsed gray strip with restore CTA.
 *   - Code you wrote             (artifact_type: code, monospace)
 *   - System design notes        (text or image; design_text/design_image)
 *   - Other notes                (artifact_type: other_note)
 *
 * Each section renders the existing artifacts of its type plus an
 * "Add" CTA that opens an inline composer (textarea or file picker).
 * Edit and Delete are surfaced per-row.
 *
 * State management is local: the page server-renders the initial
 * list and we mutate via the JSON API + optimistic updates. We
 * deliberately don't reach for a state library here — there's
 * exactly one entity (artifacts) and exactly one parent that holds
 * the list.
 */

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

interface SessionMeta {
  id: string;
  companyName: string;
  roleTitle: string;
  level: string;
  state: InterviewSessionState;
  /**
   * Recording length in seconds. Used solely to mirror the API's
   * fee logic in the in-page delete confirmation — recordings <= 15
   * min are absorbed (no charge). `null` is treated the same as
   * "unknown" and falls through to no charge, which is the safe
   * default.
   */
  transcriptDurationSeconds: number | null;
}

type ArtifactDto = SerializedArtifact;

export interface SessionAugmentProps {
  session: SessionMeta;
  initialArtifacts: ArtifactDto[];
}

const TYPE_TO_SECTION: Record<ActiveArtifactType, "questions" | "code" | "design" | "other"> = {
  question: "questions",
  code: "code",
  design_text: "design",
  design_image: "design",
  other_note: "other",
};

export function SessionAugment({
  session,
  initialArtifacts,
}: SessionAugmentProps) {
  const router = useRouter();
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>(initialArtifacts);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const update = useCallback(
    async (
      artifactId: string,
      body: { content?: string; image_url?: string },
    ): Promise<void> => {
      setStatus({ kind: "saving" });
      try {
        const res = await fetch(
          `/api/sessions/${session.id}/artifacts/${artifactId}`,
          {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const detail = await readError(res);
          setStatus({ kind: "error", message: detail });
          return;
        }
        const data = (await res.json()) as { artifact: ArtifactDto };
        setArtifacts((prev) =>
          prev.map((a) => (a.id === artifactId ? data.artifact : a)),
        );
        setStatus({ kind: "idle" });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Update failed.",
        });
      }
    },
    [session.id],
  );

  const remove = useCallback(
    async (artifactId: string): Promise<void> => {
      // Optimistic delete — we can roll back if the server says no.
      const previous = artifacts;
      setArtifacts((prev) => prev.filter((a) => a.id !== artifactId));
      setStatus({ kind: "saving" });
      try {
        const res = await fetch(
          `/api/sessions/${session.id}/artifacts/${artifactId}`,
          { method: "DELETE", credentials: "same-origin" },
        );
        if (!res.ok) {
          const detail = await readError(res);
          setArtifacts(previous);
          setStatus({ kind: "error", message: detail });
          return;
        }
        setStatus({ kind: "idle" });
      } catch (err) {
        setArtifacts(previous);
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Delete failed.",
        });
      }
    },
    [artifacts, session.id],
  );

  const create = useCallback(
    async (
      body:
        | { artifact_type: "question" | "code" | "design_text" | "other_note"; content: string }
        | {
            artifact_type: "design_image";
            image_url: string;
            content?: string;
          },
    ): Promise<ArtifactDto | null> => {
      setStatus({ kind: "saving" });
      try {
        const res = await fetch(`/api/sessions/${session.id}/artifacts`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await readError(res);
          setStatus({ kind: "error", message: detail });
          return null;
        }
        const data = (await res.json()) as { artifact: ArtifactDto };
        setArtifacts((prev) => [...prev, data.artifact]);
        setStatus({ kind: "idle" });
        return data.artifact;
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Create failed.",
        });
        return null;
      }
    },
    [session.id],
  );

  /**
   * AI-inferred lifecycle. These hit dedicated POST endpoints so
   * the route layer can enforce "this action is only legal for
   * ai_inferred rows" without leaking that rule into the generic
   * PATCH path.
   */
  const aiAction = useCallback(
    async (
      artifactId: string,
      action: "confirm" | "dismiss" | "restore",
    ): Promise<void> => {
      setStatus({ kind: "saving" });
      try {
        const res = await fetch(
          `/api/sessions/${session.id}/artifacts/${artifactId}/${action}`,
          { method: "POST", credentials: "same-origin" },
        );
        if (!res.ok) {
          const detail = await readError(res);
          setStatus({ kind: "error", message: detail });
          return;
        }
        const data = (await res.json()) as { artifact: ArtifactDto };
        setArtifacts((prev) =>
          prev.map((a) => (a.id === artifactId ? data.artifact : a)),
        );
        setStatus({ kind: "idle" });
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Action failed.",
        });
      }
    },
    [session.id],
  );

  const handleContinue = useCallback(() => {
    router.push(`/sessions/${session.id}/submit` as Route);
  }, [router, session.id]);

  const bySection = (
    section: "questions" | "code" | "design" | "other",
  ) => artifacts.filter((a) => TYPE_TO_SECTION[a.artifactType as ActiveArtifactType] === section);

  // Header back-link target depends on where the candidate came
  // from in the lifecycle:
  //   - `review`     → /review owns the editable transcript at this
  //                    point in the flow. We surface "Back to
  //                    transcript" so the candidate can correct
  //                    something they spotted in their own answers
  //                    without losing context on this page.
  //   - `complete`   → the existing report is the natural anchor;
  //                    transcript edits happen on /edit, which is
  //                    one click away from the report page.
  //   - `analyzing`  → transcript is locked while the worker runs,
  //                    so no destination would be safe to offer.
  const backLink: { href: Route; label: string } | null = (() => {
    if (session.state === "review") {
      return {
        href: `/sessions/${session.id}/review` as Route,
        label: "Back to transcript",
      };
    }
    if (session.state === "complete") {
      return {
        href: `/sessions/${session.id}` as Route,
        label: "Back to report",
      };
    }
    return null;
  })();

  return (
    <section className="mx-auto max-w-4xl px-6 py-10">
      {backLink && (
        <Link
          href={backLink.href}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {backLink.label}
        </Link>
      )}

      <header className={`space-y-1 ${backLink ? "mt-6" : ""}`}>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {session.companyName} · add context
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {session.roleTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          The more context we have, the more useful the feedback. Add as much or
          as little as you like — every section is optional.
        </p>
      </header>

      {status.kind === "error" && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />
          <span>{status.message}</span>
        </div>
      )}

      <div className="mt-10 space-y-10">
        <QuestionsSection
          artifacts={bySection("questions")}
          onCreate={(content) =>
            create({ artifact_type: "question", content })
          }
          onUpdate={(id, content) => update(id, { content })}
          onDelete={remove}
          onConfirm={(id) => aiAction(id, "confirm")}
          onDismiss={(id) => aiAction(id, "dismiss")}
          onRestore={(id) => aiAction(id, "restore")}
        />

        <Section
          title="Code you wrote"
          icon={<CodeIcon className="size-4" aria-hidden />}
          addLabel="Add code"
          composerKind="code"
          placeholder="Paste the code you wrote during the round."
          artifacts={bySection("code")}
          onCreate={(content) =>
            create({ artifact_type: "code", content })
          }
          onUpdate={(id, content) => update(id, { content })}
          onDelete={remove}
          monospace
        />

        <DesignSection
          artifacts={bySection("design")}
          sessionId={session.id}
          onCreateText={(content) =>
            create({ artifact_type: "design_text", content })
          }
          onCreateImage={(imageUrl, fileName) =>
            create({
              artifact_type: "design_image",
              image_url: imageUrl,
              ...(fileName ? { content: fileName } : {}),
            })
          }
          onUpdate={(id, content) => update(id, { content })}
          onDelete={remove}
        />

        <Section
          title="Other notes"
          icon={<NotebookPen className="size-4" aria-hidden />}
          addLabel="Add note"
          composerKind="text"
          placeholder="Anything else worth remembering — vibe, hiring manager comments, your own observations."
          artifacts={bySection("other")}
          onCreate={(content) =>
            create({ artifact_type: "other_note", content })
          }
          onUpdate={(id, content) => update(id, { content })}
          onDelete={remove}
        />
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {status.kind === "saving" ? (
            <>
              <Loader2
                className="mr-1 inline size-3.5 animate-spin"
                aria-hidden
              />
              Saving…
            </>
          ) : (
            "All changes save automatically."
          )}
        </p>
        <Button
          type="button"
          variant="primary"
          size="lg"
          onClick={handleContinue}
        >
          Continue to analysis
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>

      {session.state === "review" && (
        <div className="mt-6 flex justify-start border-t border-border/40 pt-6">
          <DeleteSessionButton
            sessionId={session.id}
            confirmMessage="Delete this session? Your transcript and any context you've added will be removed. This can't be undone."
            disabled={status.kind === "saving"}
          />
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                       Questions section                              */
/* ─────────────────────────────────────────────────────────────────── */

interface QuestionsSectionProps {
  artifacts: ArtifactDto[];
  onCreate: (content: string) => Promise<ArtifactDto | null>;
  onUpdate: (artifactId: string, content: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
  onConfirm: (artifactId: string) => Promise<void>;
  onDismiss: (artifactId: string) => Promise<void>;
  onRestore: (artifactId: string) => Promise<void>;
}

function QuestionsSection({
  artifacts,
  onCreate,
  onUpdate,
  onDelete,
  onConfirm,
  onDismiss,
  onRestore,
}: QuestionsSectionProps) {
  const [composing, setComposing] = useState(false);

  // Three groupings, visually distinct:
  //   1. Confirmed = user-added OR (ai_inferred + user_confirmed_at).
  //   2. Suggested by AI = ai_inferred + not yet confirmed or dismissed.
  //   3. Dismissed = ai_inferred + dismissed_at IS NOT NULL.
  const confirmed = artifacts.filter(
    (a) =>
      a.dismissedAt === null &&
      (a.source === "user_added" || a.userConfirmedAt !== null),
  );
  const suggested = artifacts.filter(
    (a) =>
      a.source === "ai_inferred" &&
      a.userConfirmedAt === null &&
      a.dismissedAt === null,
  );
  const dismissed = artifacts.filter(
    (a) => a.source === "ai_inferred" && a.dismissedAt !== null,
  );

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span className="text-muted-foreground">
          <HelpCircle className="size-4" aria-hidden />
        </span>
        Questions you were asked
      </h2>

      {confirmed.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Confirmed
          </h3>
          <ul className="mt-2 space-y-3">
            {confirmed.map((a) => (
              <li key={a.id}>
                <ConfirmedQuestionRow
                  artifact={a}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {suggested.length > 0 && (
        <div className="mt-6">
          <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-blue-700 dark:text-blue-300">
            <Sparkles className="size-3" aria-hidden />
            Suggested by AI
          </h3>
          <ul className="mt-2 space-y-3">
            {suggested.map((a) => (
              <li key={a.id}>
                <SuggestedQuestionRow
                  artifact={a}
                  onConfirm={onConfirm}
                  onDismiss={onDismiss}
                  onSaveEdit={(content) => onUpdate(a.id, content)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {dismissed.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Dismissed
          </h3>
          <ul className="mt-2 space-y-2">
            {dismissed.map((a) => (
              <li key={a.id}>
                <DismissedQuestionRow
                  artifact={a}
                  onRestore={onRestore}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {artifacts.length === 0 && !composing && (
        <p className="mt-4 text-sm text-muted-foreground">None added yet.</p>
      )}

      {composing ? (
        <Composer
          kind="text"
          placeholder="e.g. How would you scale a write-heavy service to handle 50k QPS?"
          onCancel={() => setComposing(false)}
          onSubmit={async (value) => {
            const created = await onCreate(value);
            if (created) setComposing(false);
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={() => setComposing(true)}
        >
          <Plus className="size-4" aria-hidden />
          Add question
        </Button>
      )}
    </section>
  );
}

function ConfirmedQuestionRow({
  artifact,
  onUpdate,
  onDelete,
}: {
  artifact: ArtifactDto;
  onUpdate: (artifactId: string, content: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content ?? "");

  // Show a subtle "AI-confirmed" badge when the row started life as
  // an AI inference and the candidate has acknowledged it. Pure
  // user-added rows just show the green check.
  const wasAiInferred = artifact.source === "ai_inferred";

  if (editing) {
    return (
      <div className="rounded-lg border border-border bg-background p-3">
        <textarea
          aria-label="Edit question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
          maxLength={MAX_TEXT_ARTIFACT_CHARS}
          className="block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <CharCount value={draft} max={MAX_TEXT_ARTIFACT_CHARS} />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(artifact.content ?? "");
              setEditing(false);
            }}
          >
            <X className="size-3.5" aria-hidden />
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={async () => {
              await onUpdate(artifact.id, draft);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-between gap-3 rounded-lg border border-emerald-300/60 bg-emerald-50/30 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/20">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="size-4 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          {wasAiInferred && (
            <Badge
              variant="secondary"
              className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
            >
              <MessageCircle className="size-3" aria-hidden />
              AI-confirmed
            </Badge>
          )}
        </div>
        <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed font-sans">
          {artifact.content}
        </pre>
      </div>
      <div className="flex shrink-0 gap-1 opacity-100 sm:opacity-60 sm:group-hover:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label="Edit"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDelete(artifact.id)}
          aria-label="Delete"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function SuggestedQuestionRow({
  artifact,
  onConfirm,
  onDismiss,
  onSaveEdit,
}: {
  artifact: ArtifactDto;
  onConfirm: (artifactId: string) => Promise<void>;
  onDismiss: (artifactId: string) => Promise<void>;
  onSaveEdit: (content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content ?? "");

  useEffect(() => {
    if (!editing) setDraft(artifact.content ?? "");
  }, [artifact.content, editing]);

  if (editing) {
    return (
      <div className="rounded-lg border border-blue-300 bg-background p-3 dark:border-blue-800/60">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
          >
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
          maxLength={MAX_TEXT_ARTIFACT_CHARS}
          className="mt-3 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <CharCount value={draft} max={MAX_TEXT_ARTIFACT_CHARS} />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(artifact.content ?? "");
              setEditing(false);
            }}
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
            disabled={draft.trim().length === 0}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-300 bg-blue-50/40 p-3 dark:border-blue-800/60 dark:bg-blue-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className="bg-blue-100 text-blue-900 dark:bg-blue-900/60 dark:text-blue-100"
        >
          <MessageCircle className="size-3" aria-hidden />
          AI-inferred
        </Badge>
        <ConfidencePill confidence={artifact.aiConfidence} />
      </div>
      <p className="mt-2 italic text-foreground">
        &ldquo;{artifact.content ?? ""}&rdquo;
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => onConfirm(artifact.id)}
        >
          <Check className="size-3.5" aria-hidden />
          Confirm
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onDismiss(artifact.id)}
        >
          <X className="size-3.5" aria-hidden />
          Wasn&apos;t asked
        </Button>
      </div>
    </div>
  );
}

function DismissedQuestionRow({
  artifact,
  onRestore,
}: {
  artifact: ArtifactDto;
  onRestore: (artifactId: string) => Promise<void>;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <div className="min-w-0 flex-1">
        <span className="line-through">{artifact.content ?? ""}</span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onRestore(artifact.id)}
      >
        <Undo2 className="size-3.5" aria-hidden />
        Restore
      </Button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                      Generic (non-question) section                  */
/* ─────────────────────────────────────────────────────────────────── */

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  addLabel: string;
  composerKind: "text" | "code";
  placeholder: string;
  artifacts: ArtifactDto[];
  onCreate: (content: string) => Promise<ArtifactDto | null>;
  onUpdate: (artifactId: string, content: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
  monospace?: boolean;
}

function Section({
  title,
  icon,
  addLabel,
  composerKind,
  placeholder,
  artifacts,
  onCreate,
  onUpdate,
  onDelete,
  monospace = false,
}: SectionProps) {
  const [composing, setComposing] = useState(false);

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>

      <ul className="mt-4 space-y-3">
        {artifacts.map((a) => (
          <li key={a.id}>
            <ArtifactRow
              artifact={a}
              monospace={monospace || composerKind === "code"}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          </li>
        ))}
        {artifacts.length === 0 && !composing && (
          <li className="text-sm text-muted-foreground">
            None added yet.
          </li>
        )}
      </ul>

      {composing ? (
        <Composer
          kind={composerKind}
          placeholder={placeholder}
          onCancel={() => setComposing(false)}
          onSubmit={async (value) => {
            const created = await onCreate(value);
            if (created) setComposing(false);
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={() => setComposing(true)}
        >
          <Plus className="size-4" aria-hidden />
          {addLabel}
        </Button>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                       System design section                         */
/* ─────────────────────────────────────────────────────────────────── */

interface DesignSectionProps {
  artifacts: ArtifactDto[];
  sessionId: string;
  onCreateText: (content: string) => Promise<ArtifactDto | null>;
  onCreateImage: (
    imageUrl: string,
    fileName?: string,
  ) => Promise<ArtifactDto | null>;
  onUpdate: (artifactId: string, content: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
}

type DesignComposer = "none" | "text" | "image";

function DesignSection({
  artifacts,
  sessionId,
  onCreateText,
  onCreateImage,
  onUpdate,
  onDelete,
}: DesignSectionProps) {
  const [composer, setComposer] = useState<DesignComposer>("none");

  return (
    <section>
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span className="text-muted-foreground">
          <Layout className="size-4" aria-hidden />
        </span>
        System design notes
      </h2>

      <ul className="mt-4 space-y-3">
        {artifacts.map((a) => (
          <li key={a.id}>
            {a.artifactType === "design_image" ? (
              <ImageArtifactRow artifact={a} onDelete={onDelete} />
            ) : (
              <ArtifactRow
                artifact={a}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            )}
          </li>
        ))}
        {artifacts.length === 0 && composer === "none" && (
          <li className="text-sm text-muted-foreground">
            None added yet.
          </li>
        )}
      </ul>

      {composer === "text" ? (
        <Composer
          kind="text"
          placeholder="e.g. Started with a single Postgres + Redis cache, then sketched out a CDC pipeline to push events to a search service."
          onCancel={() => setComposer("none")}
          onSubmit={async (value) => {
            const created = await onCreateText(value);
            if (created) setComposer("none");
          }}
        />
      ) : composer === "image" ? (
        <ImageComposer
          sessionId={sessionId}
          onCancel={() => setComposer("none")}
          onUploaded={onCreateImage}
          onAllDone={() => setComposer("none")}
        />
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setComposer("text")}
          >
            <Plus className="size-4" aria-hidden />
            Add text note
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setComposer("image")}
          >
            <ImageIcon className="size-4" aria-hidden />
            Upload images
          </Button>
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                       Per-artifact rendering                        */
/* ─────────────────────────────────────────────────────────────────── */

function ArtifactRow({
  artifact,
  monospace = false,
  onUpdate,
  onDelete,
}: {
  artifact: ArtifactDto;
  monospace?: boolean;
  onUpdate: (artifactId: string, content: string) => Promise<void>;
  onDelete: (artifactId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content ?? "");

  if (editing) {
    return (
      <div className="rounded-lg border border-border bg-background p-3">
        <textarea
          aria-label="Edit artifact"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
          maxLength={MAX_TEXT_ARTIFACT_CHARS}
          className={`block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 ${
            monospace ? "font-mono" : ""
          }`}
        />
        <CharCount value={draft} max={MAX_TEXT_ARTIFACT_CHARS} />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(artifact.content ?? "");
              setEditing(false);
            }}
          >
            <X className="size-3.5" aria-hidden />
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={async () => {
              await onUpdate(artifact.id, draft);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-background p-3">
      <pre
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed ${
          monospace ? "font-mono" : "font-sans"
        }`}
      >
        {artifact.content}
      </pre>
      <div className="flex shrink-0 gap-1 opacity-100 sm:opacity-60 sm:group-hover:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label="Edit"
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDelete(artifact.id)}
          aria-label="Delete"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function ImageArtifactRow({
  artifact,
  onDelete,
}: {
  artifact: ArtifactDto;
  onDelete: (artifactId: string) => Promise<void>;
}) {
  // The browser draws its own broken-image glyph when an `<img>`
  // 404s, which looks awful inside our card. Track load failure
  // so we can swap to our own muted icon + filename fallback (the
  // "icon broken" issue from the augment screen).
  const [imgFailed, setImgFailed] = useState(false);

  // `content` on a `design_image` is the original filename the
  // candidate uploaded — we prefer it for the alt text, the
  // user-visible label, and the broken-image fallback. It can
  // legitimately be null (older rows or when the browser didn't
  // expose `File.name`), so we degrade to a generic label.
  const fileName = artifact.content?.trim() || null;
  const displayName = fileName ?? "System design upload";

  // We render through our authenticated proxy route rather than the
  // storage key stored on the artifact: access requires authentication,
  // so the `<img>` MUST go through `/api/.../image` which generates
  // a short-lived GET URL and 307-redirects.
  const previewSrc = artifact.imageUrl
    ? `/api/sessions/${artifact.sessionId}/artifacts/${artifact.id}/image`
    : null;

  return (
    <div className="group flex items-start justify-between gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {previewSrc && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewSrc}
            alt={displayName}
            onError={() => setImgFailed(true)}
            className="max-h-64 w-auto shrink-0 rounded-md border border-border/40"
          />
        ) : (
          <div
            className="flex size-20 shrink-0 items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/40 text-muted-foreground"
            aria-hidden
          >
            <ImageIcon className="size-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={displayName}
          >
            {displayName}
          </p>
          {imgFailed && artifact.imageUrl && (
            <p className="mt-1 text-xs text-muted-foreground">
              Preview unavailable — the image couldn&apos;t be loaded right now.
            </p>
          )}
          {!artifact.imageUrl && (
            <p className="mt-1 text-xs text-muted-foreground">
              Image missing.
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1 opacity-100 sm:opacity-60 sm:group-hover:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDelete(artifact.id)}
          aria-label="Delete"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                            Composers                                */
/* ─────────────────────────────────────────────────────────────────── */

function Composer({
  kind,
  placeholder,
  onCancel,
  onSubmit,
}: {
  kind: "text" | "code";
  placeholder: string;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="mt-4 rounded-lg border border-border bg-background p-3">
      <textarea
        aria-label="New artifact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={kind === "code" ? 8 : 4}
        placeholder={placeholder}
        maxLength={MAX_TEXT_ARTIFACT_CHARS}
        className={`block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 ${
          kind === "code" ? "font-mono" : ""
        }`}
      />
      <CharCount value={value} max={MAX_TEXT_ARTIFACT_CHARS} />
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          <X className="size-3.5" aria-hidden />
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={async () => {
            const trimmed = value.trim();
            if (!trimmed) return;
            setBusy(true);
            try {
              await onSubmit(trimmed);
              setValue("");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy || value.trim().length === 0}
        >
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            "Add"
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Multi-image uploader for the design-notes section.
 *
 * Accepts up to `MAX_IMAGES_PER_BATCH` files per browse, totalling
 * no more than `MAX_TOTAL_IMAGE_BYTES_PER_BATCH`. Per-file size is
 * also capped at `MAX_ARTIFACT_IMAGE_BYTES` (enforced both here and
 * by the presign route, which is the source of truth).
 *
 * Why batch limits *and* per-file limits:
 *   - Per-file (5 MB) keeps any one upload from monopolising the
 *     bucket / slowing the page paint when the artifact is later
 *     rendered next to the report.
 *   - Per-batch (20 files / 50 MB) is a defense-in-depth cap for
 *     bad-actor pasting: without it, a script could trivially burn
 *     storage + force the analyzer to walk thousands of `[image …]`
 *     references, each of which costs us tokens at run time.
 *
 * Files are uploaded sequentially so a partial failure can be
 * recovered by retrying just the unfinished tail — and so an
 * intermediate 5xx on the presign route doesn't fan out 20
 * simultaneous failures.
 */
type FileStatus =
  | { kind: "queued" }
  | { kind: "uploading" }
  | { kind: "done" }
  | { kind: "error"; message: string };

interface QueuedFile {
  id: string;
  file: File;
  status: FileStatus;
}

function ImageComposer({
  sessionId,
  onCancel,
  onUploaded,
  onAllDone,
}: {
  sessionId: string;
  onCancel: () => void;
  onUploaded: (
    imageUrl: string,
    fileName?: string,
  ) => Promise<ArtifactDto | null>;
  onAllDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const totalBytes = queue.reduce((acc, q) => acc + q.file.size, 0);

  const validateAndStage = useCallback((files: File[]): string | null => {
    if (files.length === 0) return null;
    if (files.length > MAX_IMAGES_PER_BATCH) {
      return `You can upload up to ${MAX_IMAGES_PER_BATCH} images at a time. Please pick fewer files.`;
    }
    let total = 0;
    for (const f of files) {
      const validMime = (ALLOWED_IMAGE_MIMES as readonly string[]).includes(
        f.type,
      );
      if (!validMime) {
        return `“${f.name}” isn't a supported image (PNG, JPG, GIF, WebP).`;
      }
      if (f.size > MAX_ARTIFACT_IMAGE_BYTES) {
        return `“${f.name}” is too large (max ${
          MAX_ARTIFACT_IMAGE_BYTES / MEGABYTE
        } MB per image).`;
      }
      total += f.size;
    }
    if (total > MAX_TOTAL_IMAGE_BYTES_PER_BATCH) {
      return `Selected images total ${(total / MEGABYTE).toFixed(1)} MB — the batch limit is ${
        MAX_TOTAL_IMAGE_BYTES_PER_BATCH / MEGABYTE
      } MB.`;
    }
    return null;
  }, []);

  const handleSelected = useCallback(
    (fileList: FileList | null) => {
      setBatchError(null);
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const error = validateAndStage(files);
      if (error) {
        setBatchError(error);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
      setQueue(
        files.map((file) => ({
          id: globalThis.crypto.randomUUID(),
          file,
          status: { kind: "queued" },
        })),
      );
    },
    [validateAndStage],
  );

  const updateStatus = useCallback((id: string, status: FileStatus) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, status } : q)),
    );
  }, []);

  const uploadOne = useCallback(
    async (item: QueuedFile): Promise<boolean> => {
      updateStatus(item.id, { kind: "uploading" });
      try {
        const presignRes = await fetch(
          `/api/sessions/${sessionId}/artifacts/image-upload-url`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content_type: item.file.type,
              file_size_bytes: item.file.size,
            }),
          },
        );
        if (!presignRes.ok) {
          const detail = await readError(presignRes);
          updateStatus(item.id, { kind: "error", message: detail });
          return false;
        }
        const presigned = (await presignRes.json()) as {
          url: string;
          requiredHeaders: Record<string, string>;
          imageUrl: string;
        };

        const putRes = await fetch(presigned.url, {
          method: "PUT",
          headers: presigned.requiredHeaders,
          body: item.file,
        });
        if (!putRes.ok) {
          updateStatus(item.id, {
            kind: "error",
            message: `Upload failed (${putRes.status}). Try again.`,
          });
          return false;
        }

        const created = await onUploaded(presigned.imageUrl, item.file.name);
        if (!created) {
          updateStatus(item.id, {
            kind: "error",
            message: "Saved to storage but couldn't be added to the session.",
          });
          return false;
        }
        updateStatus(item.id, { kind: "done" });
        return true;
      } catch (err) {
        updateStatus(item.id, {
          kind: "error",
          message: err instanceof Error ? err.message : "Upload failed.",
        });
        return false;
      }
    },
    [onUploaded, sessionId, updateStatus],
  );

  const startUpload = useCallback(async () => {
    setBusy(true);
    setBatchError(null);
    // Pull the snapshot we want to march through, but ignore items
    // that are already finished (in case the user retried after a
    // partial failure).
    const pending = queue.filter(
      (q) => q.status.kind === "queued" || q.status.kind === "error",
    );
    let allOk = true;
    for (const item of pending) {
      const ok = await uploadOne(item);
      if (!ok) allOk = false;
    }
    setBusy(false);
    if (allOk) onAllDone();
  }, [onAllDone, queue, uploadOne]);

  const removeQueued = useCallback((id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const hasQueue = queue.length > 0;
  const allDone =
    hasQueue && queue.every((q) => q.status.kind === "done");
  const anyErrored = queue.some((q) => q.status.kind === "error");

  return (
    <div className="mt-4 rounded-lg border border-dashed border-border bg-background p-4">
      <p className="text-sm text-muted-foreground">
        PNG, JPG, GIF, or WebP up to{" "}
        {MAX_ARTIFACT_IMAGE_BYTES / MEGABYTE} MB per image. Up to{" "}
        {MAX_IMAGES_PER_BATCH} images and{" "}
        {MAX_TOTAL_IMAGE_BYTES_PER_BATCH / MEGABYTE} MB total per upload.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_IMAGE_MIMES.join(",")}
        disabled={busy}
        className="mt-3 block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-foreground file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-background hover:file:bg-foreground/90"
        onChange={(e) => handleSelected(e.target.files)}
      />

      {batchError && (
        <p
          role="alert"
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-destructive"
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {batchError}
        </p>
      )}

      {hasQueue && (
        <>
          <ul className="mt-3 space-y-1.5">
            {queue.map((q) => (
              <li
                key={q.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs"
              >
                <ImageIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span
                  className="min-w-0 flex-1 truncate font-medium"
                  title={q.file.name}
                >
                  {q.file.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {(q.file.size / MEGABYTE).toFixed(1)} MB
                </span>
                <span className="ml-1 shrink-0">
                  {q.status.kind === "uploading" ? (
                    <Loader2
                      className="size-3.5 animate-spin text-muted-foreground"
                      aria-label="Uploading"
                    />
                  ) : q.status.kind === "done" ? (
                    <Check
                      className="size-3.5 text-emerald-600 dark:text-emerald-400"
                      aria-label="Uploaded"
                    />
                  ) : q.status.kind === "error" ? (
                    <span
                      className="inline-flex items-center gap-1 text-destructive"
                      title={q.status.message}
                    >
                      <AlertTriangle className="size-3.5" aria-hidden />
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => removeQueued(q.id)}
                      disabled={busy}
                      aria-label={`Remove ${q.file.name}`}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            {queue.length} file{queue.length === 1 ? "" : "s"} ·{" "}
            {(totalBytes / MEGABYTE).toFixed(1)} MB total
          </p>

          {anyErrored && !busy && (
            <p
              role="alert"
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-destructive"
            >
              <AlertTriangle className="size-3.5" aria-hidden />
              Some files didn&apos;t upload. Click Upload to retry the failed
              ones.
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          <X className="size-3.5" aria-hidden />
          {allDone ? "Close" : "Cancel"}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={startUpload}
          disabled={busy || !hasQueue || allDone}
        >
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Uploading…
            </>
          ) : (
            <>
              <ImageIcon className="size-3.5" aria-hidden />
              Upload
              {queue.length > 1 ? ` ${queue.filter((q) => q.status.kind !== "done").length} images` : ""}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/*                              Helpers                                */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * Color-coded confidence badge for AI-inferred suggestion cards.
 * Mirrors the same component on the review screen so the candidate
 * sees a consistent traffic-light hierarchy across both surfaces.
 */
function ConfidencePill({
  confidence,
}: {
  confidence: ArtifactDto["aiConfidence"];
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
  // Defensive fallback for an unrecognised band (future enum
  // value, or stale client during a rolling deploy). Mirrors the
  // ConfidencePill in transcript-review.tsx — keep them in sync.
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
 * Tiny inline counter for text-artifact composers. Hidden until the
 * candidate is past ~80% of the cap, then it surfaces in muted text;
 * once they hit the limit we flip it to the destructive color so
 * "the textarea stopped accepting input" has a visible explanation.
 *
 * The browser's native `maxLength` is what actually enforces the
 * cap — this is purely the UI affordance.
 */
function CharCount({
  value,
  max,
}: {
  value: string;
  max: number;
}) {
  const len = value.length;
  if (len < Math.floor(max * 0.8)) return null;
  const atLimit = len >= max;
  return (
    <p
      className={`mt-2 text-right text-xs tabular-nums ${
        atLimit ? "text-destructive" : "text-muted-foreground"
      }`}
      aria-live="polite"
    >
      {len.toLocaleString()} / {max.toLocaleString()} characters
      {atLimit ? " — limit reached" : ""}
    </p>
  );
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
