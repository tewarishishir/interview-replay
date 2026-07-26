"use client";

import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Plus,
  RotateCw,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { CritiqueView } from "@/components/app/critique-view";
import { SuggestedResponseView } from "@/components/app/suggested-response-view";
import { StoryDraftForm, type StoryDraftFormData } from "@/components/app/story-draft-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { StoryTheme } from "@/lib/db/schema";
import {
  ApiError,
  deleteStory,
  patchProfileExclusion,
  patchStory,
  postStory,
  postStoryDraftSuggestion,
  postStoryCritique,
  postStoryEnhance,
  postStorySuggestResponse,
} from "@/lib/profiles/api-client";
import type { StoryWithRebuildDto } from "@/lib/profiles/dto";
import type { CritiqueResponse, SuggestedResponse } from "@/lib/rebuilds/schemas";
import { STORY_THEMES } from "@/lib/profiles/themes";

interface StoryBankPageProps {
  initialStories: StoryWithRebuildDto[];
  initialExcludeStories: boolean;
  storiesMax: number;
}

/**
 * Top-level Story Bank page.
 *
 * Mirrors the per-theme layout the previous in-profile section
 * used so muscle memory carries over, but adds rebuild-derived
 * context to each card:
 *
 *   - "From interview" pill linking to `/sessions/:id` (when the
 *     source session still exists; sessions retention-swept yield
 *     a greyed "Source session unavailable" line).
 *   - "View AI critique" expander rendering the saved
 *     `CritiqueResponse` via `<CritiqueView variant="compact" />`.
 *   - "Open rebuild" link to `/rebuilds/:id` so the candidate can
 *     re-critique or revise the same draft.
 *
 * Hand-authored stories (`rebuild === null`) render exactly the
 * same card UX they did in the profile section.
 *
 * The "Exclude from analysis" toggle still lives here because
 * `excludeStories` is a `user_profiles` column that gates the
 * analyze prompt — it just moved to the new home.
 */
export function StoryBankPage({
  initialStories,
  initialExcludeStories,
  storiesMax,
}: StoryBankPageProps) {
  const [stories, setStories] = useState<StoryWithRebuildDto[]>(initialStories);
  const [excludeStories, setExcludeStoriesState] = useState(
    initialExcludeStories,
  );
  const [exclusionPending, setExclusionPending] = useState(false);
  const [exclusionError, setExclusionError] = useState<string | null>(null);

  // Page-view event — fired once on mount.
  useEffect(() => {
    fireAnalytics("story_bank_viewed", { story_count: initialStories.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<StoryTheme, StoryWithRebuildDto[]>();
    for (const s of stories) {
      const list = map.get(s.theme);
      if (list) list.push(s);
      else map.set(s.theme, [s]);
    }
    return map;
  }, [stories]);

  async function toggleExclusion(next: boolean) {
    setExclusionError(null);
    setExclusionPending(true);
    const previous = excludeStories;
    // Optimistic update — the Switch is also `disabled` while the
    // request is in flight so a fast double-click can't overlap.
    setExcludeStoriesState(next);
    try {
      const { profile } = await patchProfileExclusion({
        field: "stories",
        excluded: next,
      });
      // Mirror the persisted value rather than the optimistic
      // one. Identical in steady state, but if the server ever
      // coerces the input (or another tab raced this toggle), the
      // UI now reflects the row of record.
      setExcludeStoriesState(profile.excludeStories);
    } catch (err) {
      setExcludeStoriesState(previous);
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not update exclusion. Try again.";
      setExclusionError(msg);
    } finally {
      setExclusionPending(false);
    }
  }

  const isAtCap = stories.length >= storiesMax;
  const isEmpty = stories.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 p-4">
        <div>
          <p className="text-sm font-medium">Include in analysis</p>
          <p className="text-xs text-muted-foreground">
            When on, your stories are included as context in your interview
            reports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={!excludeStories}
            onCheckedChange={(checked) => toggleExclusion(!checked)}
            disabled={exclusionPending}
            aria-label="Include stories in analysis"
          />
          <span className="text-xs text-muted-foreground">
            {stories.length}/{storiesMax}
          </span>
        </div>
      </div>

      {exclusionError ? (
        <p className="text-sm text-destructive" role="alert">
          {exclusionError}
        </p>
      ) : null}

      {isEmpty ? (
        <EmptyState />
      ) : null}

      {STORY_THEMES.map((theme) => (
        <ThemeGroup
          key={theme.value}
          themeValue={theme.value}
          themeLabel={theme.label}
          themeHint={theme.hint}
          stories={grouped.get(theme.value) ?? []}
          disabled={isAtCap}
          onCreate={async (data) => {
            const { story } = await postStory({
              ...data,
              theme: theme.value,
            });
            setStories((prev) => [
              ...prev,
              { ...story, rebuild: null },
            ]);
          }}
          onUpdate={async (id, patch) => {
            const { story } = await patchStory(id, patch);
            setStories((prev) =>
              prev.map((s) =>
                s.id === id ? { ...story, rebuild: s.rebuild } : s,
              ),
            );
          }}
          onDelete={async (id) => {
            await deleteStory(id);
            setStories((prev) => prev.filter((s) => s.id !== id));
          }}
          onStorySuggestionUpdated={(storyId, suggestion, generatedAt) => {
            setStories((prev) =>
              prev.map((s) =>
                s.id === storyId
                  ? {
                      ...s,
                      aiSuggestedResponse: suggestion,
                      aiSuggestedResponseGeneratedAt: generatedAt,
                    }
                  : s,
              ),
            );
          }}
        />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
      <h2 className="text-lg font-semibold">Your story bank is empty</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Add stories by hand below, or finish an interview session and use
        Practice Rebuild to draft them with AI critique.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        <Button asChild variant="outline">
          <Link href="/sessions/new">Start a new session</Link>
        </Button>
      </div>
    </div>
  );
}

interface ThemeGroupProps {
  themeValue: StoryTheme;
  themeLabel: string;
  themeHint: string;
  stories: StoryWithRebuildDto[];
  disabled: boolean;
  onCreate: (data: StoryFormData) => Promise<void>;
  onUpdate: (id: string, patch: StoryFormData) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** Bank-surface story-side suggestion update. */
  onStorySuggestionUpdated: (
    storyId: string,
    suggestion: SuggestedResponse,
    generatedAt: string,
  ) => void;
}

function ThemeGroup(props: ThemeGroupProps) {
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{props.themeLabel}</h3>
        <p className="text-xs text-muted-foreground">{props.themeHint}</p>
      </div>

      <div className="flex flex-col gap-2">
        {props.stories.map((story) => (
          <StoryCard
            key={story.id}
            story={story}
            onSave={(patch) => props.onUpdate(story.id, patch)}
            onDelete={() => props.onDelete(story.id)}
            onStorySuggestionUpdated={(suggestion, generatedAt) =>
              props.onStorySuggestionUpdated(
                story.id,
                suggestion,
                generatedAt,
              )
            }
          />
        ))}

        {adding ? (
          <StoryForm
            mode="create"
            theme={props.themeValue}
            onSave={async (data) => {
              await props.onCreate(data);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
            className="self-start"
            disabled={props.disabled}
            title={
              props.disabled
                ? "Story bank cap reached. Delete a story to add another."
                : undefined
            }
          >
            <Plus className="size-4" aria-hidden /> Add story
          </Button>
        )}
      </div>
    </div>
  );
}

function StoryCard(props: {
  story: StoryWithRebuildDto;
  onSave: (patch: StoryFormData) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Called when the bank-surface story-side suggestion is updated. */
  onStorySuggestionUpdated: (
    suggestion: SuggestedResponse,
    generatedAt: string,
  ) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showCritique, setShowCritique] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Track guardrail state for the most recent in-session generate.
  // The cached suggestion on the row was generated at SOME prior
  // time; we don't know whether it passed guardrails (the API only
  // tells us on the call that produced it). Default optimistic to
  // true — the renderer's caveat banner already handles "this is a
  // starting point" without needing the flag.
  const [suggestPassedGuardrails, setSuggestPassedGuardrails] = useState(true);
  // Holds the placeholder STAR shell the server returns when
  // guardrails trip. We render this inline (with the rose "not
  // grounded" banner SuggestedResponseView already has) instead of
  // blocking the user with a "try again" error — retrying with the
  // same profile usually fails the same way. This state is local to
  // the in-session generate and is never persisted to the row.
  const [syntheticSuggestion, setSyntheticSuggestion] =
    useState<SuggestedResponse | null>(null);

  if (editing) {
    return (
      <StoryForm
        mode="edit"
        theme={props.story.theme}
        initial={props.story}
        onSave={async (data) => {
          await props.onSave(data);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  async function performDelete() {
    setDeleting(true);
    try {
      await props.onDelete();
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Bank-surface generation. ALWAYS uses the story-side endpoint
   * (`POST /api/stories/:id/suggest-response`) regardless of
   * whether the story has a backing rebuild — the bank surface
   * grounds against `story.title` + `story.theme`, which is the
   * mental model the user is in when they're looking at the
   * card. The rebuild-flow surface continues to write to the
   * rebuild row (separate `aiSuggestedResponse` field that
   * survives independently).
   */
  async function handleGenerateSuggestion() {
    setSuggestError(null);
    setSyntheticSuggestion(null);
    setSuggestLoading(true);
    try {
      const response = await postStorySuggestResponse(props.story.id);
      if (!response.passedGuardrails) {
        // Server skipped persistence + the credit charge. Render
        // the placeholder STAR shell inline so the user gets a
        // usable scaffold to fill in — the SuggestedResponseView
        // shows its own rose "not grounded" caveat banner above
        // the body when `passedGuardrails` is false.
        if (response.syntheticSuggestion) {
          setSyntheticSuggestion(response.syntheticSuggestion);
          setSuggestPassedGuardrails(false);
          setShowSuggestion(true);
        } else {
          // Defensive: server marked the response ungrounded but
          // didn't ship the synthetic body. Fall back to the prior
          // "try again" copy.
          setSuggestError(
            "AI generation didn't produce a grounded draft this time. Try again — InterviewReplay needs more profile detail to ground the answer.",
          );
        }
        fireAnalytics("story_suggested_response_requested", {
          story_id: props.story.id,
          passed_guardrails: false,
        });
        return;
      }
      if (!response.aiSuggestedResponse || !response.aiSuggestedResponseGeneratedAt) {
        // Defensive: success flag set but no body shipped. Treat
        // as a transient error.
        setSuggestError("AI draft generation failed. Try again.");
        return;
      }
      setSuggestPassedGuardrails(true);
      setShowSuggestion(true);
      props.onStorySuggestionUpdated(
        response.aiSuggestedResponse,
        response.aiSuggestedResponseGeneratedAt,
      );
      router.refresh();
      fireAnalytics("story_suggested_response_requested", {
        story_id: props.story.id,
        passed_guardrails: true,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setSuggestError(err.message);
      } else {
        setSuggestError("We couldn't generate an AI draft. Try again.");
      }
    } finally {
      setSuggestLoading(false);
    }
  }

  const filled = [
    props.story.situation,
    props.story.task,
    props.story.action,
    props.story.result,
    props.story.whatILearned,
  ].filter((v) => v && v.trim().length > 0).length;

  const rebuild = props.story.rebuild;
  // The card prefers the story-side suggestion when present
  // (regenerated from the bank), falling back to the rebuild-side
  // cache (generated during the rebuild flow). This keeps a
  // user's previously-generated rebuild draft visible until they
  // explicitly regenerate from the bank.
  const cachedSuggestion =
    props.story.aiSuggestedResponse ?? rebuild?.aiSuggestedResponse ?? null;
  const cachedSuggestionAt =
    props.story.aiSuggestedResponseGeneratedAt ??
    rebuild?.aiSuggestedResponseGeneratedAt ??
    null;
  // When the most-recent generate tripped guardrails, the server
  // ships a placeholder STAR shell as `syntheticSuggestion` and
  // intentionally does NOT touch the row (so `cachedSuggestion`
  // still reflects the last grounded draft, if any). For THIS
  // render we prefer the synthetic so the user sees the scaffold
  // they just generated, even though it isn't persisted. The
  // `passedGuardrails` flag drives SuggestedResponseView's rose
  // "not grounded" banner.
  const displayedSuggestion = syntheticSuggestion ?? cachedSuggestion;
  const displayedSuggestionAt = syntheticSuggestion ? null : cachedSuggestionAt;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-4">
        <div className="flex-1 space-y-2">
          <Link
            href={`/stories/${props.story.id}`}
            className="text-sm font-semibold hover:underline"
          >
            {props.story.title}
          </Link>
          <p className="text-xs text-muted-foreground">{filled}/5 STAR fields</p>
          {rebuild ? <RebuildBadge rebuild={rebuild} /> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          {confirmDelete ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={performDelete}
                disabled={deleting}
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete story"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </CardHeader>
      {filled > 0 ? (
        <CardContent className="grid gap-2 p-4 pt-0 text-sm">
          {props.story.situation ? (
            <p>
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Situation:
              </span>{" "}
              <span className="whitespace-pre-line">{props.story.situation}</span>
            </p>
          ) : null}
          {props.story.task ? (
            <p>
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Task:
              </span>{" "}
              <span className="whitespace-pre-line">{props.story.task}</span>
            </p>
          ) : null}
          {props.story.action ? (
            <p>
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Action:
              </span>{" "}
              <span className="whitespace-pre-line">{props.story.action}</span>
            </p>
          ) : null}
          {props.story.result ? (
            <p>
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Result:
              </span>{" "}
              <span className="whitespace-pre-line">{props.story.result}</span>
            </p>
          ) : null}
          {props.story.whatILearned ? (
            <p>
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                What I learned:
              </span>{" "}
              <span className="whitespace-pre-line">
                {props.story.whatILearned}
              </span>
            </p>
          ) : null}
        </CardContent>
      ) : null}

      <CardContent className="border-t border-border/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* AI suggested response affordance. Available for ALL
              stories — the bank surface always uses the
              story-side endpoint. The button label / behavior
              depends on whether a cached suggestion exists
              (rebuild-side or story-side, in that fallback
              order). */}
          {cachedSuggestion ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = !showSuggestion;
                setShowSuggestion(next);
                if (next) {
                  fireAnalytics("story_suggested_response_requested", {
                    story_id: props.story.id,
                    cached: true,
                  });
                }
              }}
              aria-expanded={showSuggestion}
            >
              <Wand2 className="size-4" aria-hidden />
              {showSuggestion
                ? "Hide AI suggested response"
                : "View AI suggested response"}
              {showSuggestion ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerateSuggestion}
              disabled={suggestLoading}
            >
              {suggestLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Wand2 className="size-4" aria-hidden />
              )}
              Generate AI suggested response
            </Button>
          )}

          {rebuild?.aiCritique ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = !showCritique;
                setShowCritique(next);
                if (next) {
                  fireAnalytics("story_critique_expanded", {
                    story_id: props.story.id,
                  });
                }
              }}
              aria-expanded={showCritique}
            >
              <Sparkles className="size-4" aria-hidden />
              {showCritique ? "Hide AI critique" : "View AI critique"}
              {showCritique ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
            </Button>
          ) : null}

          {rebuild ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/rebuilds/${rebuild.id}`}>
                <Wrench className="size-4" aria-hidden /> Open rebuild
              </Link>
            </Button>
          ) : null}
          {rebuild?.sourceSession ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              onClick={() => {
                fireAnalytics("story_jump_to_session", {
                  story_id: props.story.id,
                });
              }}
            >
              <Link href={`/sessions/${rebuild.sourceSession.id}`}>
                <ExternalLink className="size-4" aria-hidden />
                View source session
              </Link>
            </Button>
          ) : rebuild?.sourceSessionId ? (
            <span className="text-xs text-muted-foreground">
              Source session unavailable (deleted)
            </span>
          ) : null}
        </div>

        {showCritique && rebuild?.aiCritique ? (
          <div className="mt-4 rounded-lg border border-border/60 bg-background p-4">
            <CritiqueView critique={rebuild.aiCritique} variant="compact" />
          </div>
        ) : null}

        {showSuggestion && displayedSuggestion ? (
          <div className="mt-4 rounded-lg border border-border/60 bg-background p-4">
            <SuggestedResponseView
              suggestion={displayedSuggestion}
              variant="compact"
              passedGuardrails={suggestPassedGuardrails}
              generatedAt={displayedSuggestionAt}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
              <p className="text-xs text-muted-foreground">
                {syntheticSuggestion
                  ? "This is a scaffold — fill in the placeholders, or regenerate after adding more profile detail."
                  : "Want a fresh draft? Regenerate against your current profile."}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGenerateSuggestion}
                disabled={suggestLoading}
              >
                {suggestLoading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <RotateCw className="size-4" aria-hidden />
                )}
                Regenerate
              </Button>
            </div>
          </div>
        ) : null}

        {suggestError ? (
          <div className="mt-3 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
            <XCircle className="mr-2 inline size-4" aria-hidden />
            {suggestError}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RebuildBadge({
  rebuild,
}: {
  rebuild: NonNullable<StoryWithRebuildDto["rebuild"]>;
}) {
  const session = rebuild.sourceSession;
  const round = session ? formatRound(session.roundType) : null;
  const dateLabel = session
    ? formatDate(session.createdAt)
    : formatDate(rebuild.updatedAt);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary" className="bg-primary/10 text-primary">
        <Wrench className="mr-1 size-3" aria-hidden />
        From Practice Rebuild
      </Badge>
      {session ? (
        <span className="text-xs text-muted-foreground">
          {session.companyName}
          {round ? ` · ${round}` : ""}
          {dateLabel ? ` · ${dateLabel}` : ""}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          Critiqued {dateLabel}
        </span>
      )}
    </div>
  );
}

function formatRound(roundType: string): string {
  switch (roundType) {
    case "coding":
      return "Coding round";
    case "system_design":
      return "System design round";
    case "behavioral":
      return "Behavioral round";
    case "other":
      return "Interview";
    default:
      return roundType;
  }
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface StoryFormData {
  title: string;
  situation: string | null;
  task: string | null;
  action: string | null;
  result: string | null;
  whatILearned: string | null;
}

function StoryForm(props: {
  mode: "create" | "edit";
  /**
   * Theme of the group the form is rendered under. Required for
   * the "Generate AI draft" button — the LLM grounds against
   * `(title, theme)` so we need the theme even before the story
   * is saved (the create path attaches the theme on the server
   * via the URL grouping, so the form doesn't normally need it).
   */
  theme: StoryTheme;
  initial?: StoryWithRebuildDto;
  onSave: (data: StoryFormData) => Promise<void>;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<StoryDraftFormData>(() => ({
    title: props.initial?.title ?? "",
    situation: props.initial?.situation ?? "",
    task: props.initial?.task ?? "",
    action: props.initial?.action ?? "",
    result: props.initial?.result ?? "",
    whatILearned: props.initial?.whatILearned ?? "",
    whatIWouldChange: "",
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftCaveat, setDraftCaveat] = useState<string | null>(null);

  // ── Critique state ────────────────────────────────────────────
  const [critiqueResult, setCritiqueResult] =
    useState<CritiqueResponse | null>(null);
  const [critiquePassedGuardrails, setCritiquePassedGuardrails] = useState(true);
  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [critiqueError, setCritiqueError] = useState<string | null>(null);
  // ── Enhance state ─────────────────────────────────────────────
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [preEnhanceDraft, setPreEnhanceDraft] =
    useState<StoryDraftFormData | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The "Get critique" button is enabled when at least the three
  // STAR fields that drive most critique dimensions are non-empty.
  const canGetCritique =
    data.situation.trim().length > 0 ||
    data.action.trim().length > 0 ||
    data.result.trim().length > 0;

  /**
   * Form-time AI draft generation. Calls the ephemeral endpoint
   * (no persistence) and prefills the STAR textareas with the
   * model's output. The user can edit before saving — the saved
   * STAR fields are the canonical record.
   *
   * Only available on the create path. On edit, the user already
   * has content; "Generate AI suggested response" on the saved
   * card is the path for "show me an AI version of this story I
   * already have".
   */
  async function handleGenerateDraft() {
    setDraftError(null);
    setDraftCaveat(null);
    const trimmedTitle = data.title.trim();
    if (!trimmedTitle) {
      setDraftError("Add a title first — InterviewReplay grounds the AI draft on it.");
      return;
    }
    setDrafting(true);
    try {
      const response = await postStoryDraftSuggestion({
        title: trimmedTitle,
        theme: props.theme,
      });
      if (!response.passedGuardrails) {
        setDraftError(
          "AI draft generation didn't produce a grounded answer this time. Try again — InterviewReplay needs more profile detail.",
        );
        return;
      }
      // Prefill the STAR textareas with the model's output. We
      // don't overwrite a non-empty existing value — a user who
      // typed something and THEN clicked Generate doesn't want to
      // lose their work.
      setData((prev) => ({
        ...prev,
        situation: prev.situation?.trim()
          ? prev.situation
          : response.suggestion.situation,
        task: prev.task?.trim() ? prev.task : response.suggestion.task,
        action: prev.action?.trim() ? prev.action : response.suggestion.action,
        result: prev.result?.trim() ? prev.result : response.suggestion.result,
      }));
      // Surface a soft caveat — the AI draft is a starting point;
      // the user should edit and own it before saving.
      setDraftCaveat(
        "AI draft inserted. Edit each field to make it yours — interviewers can tell when answers aren't authentic.",
      );
      router.refresh();
      fireAnalytics("story_draft_generated", {
        theme: props.theme,
        passed_guardrails: true,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setDraftError(err.message);
      } else {
        setDraftError("We couldn't generate an AI draft. Try again.");
      }
    } finally {
      setDrafting(false);
    }
  }

  async function handleGetCritique() {
    setCritiqueError(null);
    setCritiqueLoading(true);
    try {
      const response = await postStoryCritique({
        title: data.title,
        situation: data.situation,
        task: data.task,
        action: data.action,
        result: data.result,
        whatILearned: data.whatILearned,
      });
      setCritiqueResult(response.critique);
      setCritiquePassedGuardrails(response.passedGuardrails);
      router.refresh();
      fireAnalytics("story_critique_requested", {
        passed_guardrails: response.passedGuardrails,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setCritiqueError(err.message);
      } else {
        setCritiqueError("We couldn't generate a critique. Try again.");
      }
    } finally {
      setCritiqueLoading(false);
    }
  }

  async function handleApplyEnhancement() {
    if (!critiqueResult) return;
    setEnhanceError(null);
    setEnhanceLoading(true);
    // Capture pre-enhance snapshot for undo.
    setPreEnhanceDraft({ ...data });
    try {
      const response = await postStoryEnhance({
        title: data.title,
        situation: data.situation,
        task: data.task,
        action: data.action,
        result: data.result,
        whatILearned: data.whatILearned,
        critique: critiqueResult,
      });
      // Overwrite the form textareas with the enhanced draft.
      setData((prev) => ({
        ...prev,
        situation: response.enhanced.situation,
        task: response.enhanced.task,
        action: response.enhanced.action,
        result: response.enhanced.result,
        whatILearned: response.enhanced.whatILearned || prev.whatILearned,
      }));
      // Start the 30-second undo window.
      setUndoAvailable(true);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => {
        setUndoAvailable(false);
        setPreEnhanceDraft(null);
      }, 30_000);
      router.refresh();
      fireAnalytics("story_enhance_applied", {});
    } catch (err) {
      // Clear snapshot — enhancement didn't apply.
      setPreEnhanceDraft(null);
      if (err instanceof ApiError) {
        setEnhanceError(err.message);
      } else {
        setEnhanceError("We couldn't rewrite your draft. Try again.");
      }
    } finally {
      setEnhanceLoading(false);
    }
  }

  function handleUndoEnhancement() {
    if (!preEnhanceDraft) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setData(preEnhanceDraft);
    setUndoAvailable(false);
    setPreEnhanceDraft(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!data.title.trim()) {
      setError("Title is required.");
      return;
    }
    setSaving(true);
    try {
      const payload: StoryFormData = {
        title: data.title.trim(),
        situation: data.situation?.trim() || null,
        task: data.task?.trim() || null,
        action: data.action?.trim() || null,
        result: data.result?.trim() || null,
        whatILearned: data.whatILearned?.trim() || null,
      };
      await props.onSave(payload);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Could not save story.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <StoryDraftForm
      mode="story-bank"
      storyBankFormMode={props.mode}
      data={data}
      onChange={setData}
      saving={saving}
      submitError={error}
      onSubmit={onSubmit}
      onCancel={props.onCancel}
      aiDraftLoading={drafting}
      aiDraftError={draftError}
      aiDraftCaveat={draftCaveat}
      onGenerateAiDraft={handleGenerateDraft}
      storyCritiqueResult={critiqueResult}
      storyCritiquePassedGuardrails={critiquePassedGuardrails}
      storyCritiqueLoading={critiqueLoading}
      storyCritiqueError={critiqueError}
      canGetStoryCritique={canGetCritique}
      onGetStoryCritique={handleGetCritique}
      storyEnhanceLoading={enhanceLoading}
      storyEnhanceError={enhanceError}
      storyUndoAvailable={undoAvailable}
      onApplyStorySuggestions={handleApplyEnhancement}
      onUndoStoryEnhancement={handleUndoEnhancement}
    />
  );
}

function fireAnalytics(_event: string, _properties: Record<string, unknown>): void {
  // No-op: external analytics removed for open-source.
}
