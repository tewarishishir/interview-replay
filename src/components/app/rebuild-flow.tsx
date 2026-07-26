"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { CritiqueView } from "@/components/app/critique-view";
import { StoryDraftForm } from "@/components/app/story-draft-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectDto, StoryDto } from "@/lib/profiles/dto";
import { STORY_THEMES } from "@/lib/profiles/themes";
import type { StoryTheme } from "@/lib/db/schema";
import type { SuggestedResponse } from "@/lib/rebuilds/schemas";

import type { CritiqueResponse } from "@/lib/rebuilds/schemas";
import type { RebuildDto } from "@/lib/rebuilds/dto";
import {
  RebuildApiError,
  patchRebuildClient,
  postCritique,
  postEnhance,
  postSaveToBank,
  postSuggestResponse,
} from "@/lib/rebuilds/api-client";
import type { RebuildQuestionTheme } from "@/lib/db/schema";

/**
 * Practice Rebuild — the 6-step coaching flow.
 *
 * Step structure (mirrors the spec exactly):
 *
 *   Step 1 (auto)  — source-context banner, no UI input.
 *   Step 2         — headline. Single-line input, debounced
 *                    autosave, "Continue" disabled until non-empty.
 *   Step 3         — pull-from-profile picker (stories matching
 *                    theme, projects, "start fresh"). Click on
 *                    a story copies its STAR text VERBATIM into
 *                    the next step's textareas. Click on a project
 *                    pre-fills situation only. NEVER AI-rewrites.
 *   Step 4         — STAR scaffold (4 textareas + optional
 *                    `what_i_would_change` for failure themes).
 *                    Auto-saves on debounced change. "Get critique"
 *                    disabled until S/A/R non-empty (and W for
 *                    failure themes).
 *   Step 5         — critique view. Shows overall_assessment, then
 *                    a list of dimension cards ordered by urgency
 *                    (missing > discrepancy > needs_work > strong).
 *                    Profile_consistency renders side-by-side
 *                    draft-vs-profile comparison; profile_leverage
 *                    surfaces the verbatim profile snippet.
 *   Step 6         — confirmation after Save to story bank.
 *
 * Persistence model:
 *   - All field changes go through `patchRebuildClient` debounced
 *     500 ms. The component keeps the last server-confirmed
 *     `RebuildDto` in `rebuild` state and the in-flight edits as
 *     local strings; the visible "Saving…" badge shows the gap.
 *   - The critique POST is synchronous (no debounce) and always
 *     replaces the local rebuild state with the server's response.
 *
 * AI-vs-coaching contract:
 *   - The pull-from-profile copy is VERBATIM from the user's own
 *     profile. The disclaimer below the picker says so explicitly.
 *   - The "InterviewReplay will critique your draft, not write it for you"
 *     banner is rendered persistently above the STAR scaffold and
 *     above the critique view.
 *   - Re-critique is allowed; the previous critique flows into
 *     `critique_history` server-side. The 10/24h gate trips with a
 *     clear retry-after on the client.
 */

export interface SourceImprovementContext {
  /** "Try this next time" copy from the source session's report. */
  improvementSummary: string | null;
  /** company_name + round_type label, e.g. "Stripe coding round". */
  sessionLabel: string;
}

interface RebuildFlowProps {
  initialRebuild: RebuildDto;
  /**
   * Optional context from the source session — only set when the
   * page-shell verified a source_session_id is set on the
   * rebuild AND the corresponding session + report still exist.
   */
  sourceContext: SourceImprovementContext | null;
  /**
   * Profile slabs the candidate can pull from in Step 3. None
   * are AI-rewritten — they're VERBATIM from the user's own
   * `stories` and `projects` rows.
   */
  matchingStories: StoryDto[];
  allStories: StoryDto[];
  projects: ProjectDto[];
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const FAILURE_THEMES_SET = new Set<RebuildQuestionTheme>([
  "biggest_failure",
  "recovering_from_mistake",
]);

export function RebuildFlow(props: RebuildFlowProps) {
  const router = useRouter();
  const [rebuild, setRebuild] = useState<RebuildDto>(props.initialRebuild);
  const [step, setStep] = useState<Step>(() => initialStepFor(props.initialRebuild));
  const [savingState, setSavingState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Local copies of every editable field. We keep them separate
  // from the server-confirmed `rebuild` so the user's typing
  // never gets clobbered by an in-flight save's response.
  const [headline, setHeadline] = useState(rebuild.headline ?? "");
  const [situation, setSituation] = useState(rebuild.situation ?? "");
  const [task, setTask] = useState(rebuild.task ?? "");
  const [action, setAction] = useState(rebuild.action ?? "");
  const [result, setResult] = useState(rebuild.result ?? "");
  const [whatIWouldChange, setWhatIWouldChange] = useState(
    rebuild.whatIWouldChange ?? "",
  );

  const isFailureShaped = !!(
    rebuild.questionTheme &&
    FAILURE_THEMES_SET.has(rebuild.questionTheme as RebuildQuestionTheme)
  );

  // Debounced auto-save. We collapse multiple sequential edits
  // to the same field into one PATCH.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, string | null>>({});

  const flushPatch = useCallback(async () => {
    const patch = { ...pendingPatch.current };
    pendingPatch.current = {};
    if (Object.keys(patch).length === 0) return;
    setSavingState("saving");
    try {
      const { rebuild: next } = await patchRebuildClient(rebuild.id, patch);
      setRebuild(next);
      setSavingState("idle");
      setErrorMessage(null);
    } catch (err) {
      setSavingState("error");
      setErrorMessage(
        err instanceof RebuildApiError
          ? err.message
          : "We couldn't save your draft. Try again.",
      );
    }
  }, [rebuild.id]);

  const queueSave = useCallback(
    (patch: Record<string, string | null>) => {
      pendingPatch.current = { ...pendingPatch.current, ...patch };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void flushPatch();
      }, 500);
    },
    [flushPatch],
  );

  // Flush any pending edit when the user clicks Continue / Get
  // critique / Save to bank — there's no point letting a 500 ms
  // debounce window race the next-step navigation.
  const flushNow = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await flushPatch();
  }, [flushPatch]);

  // Cleanup on unmount: flush any pending edit so a user closing
  // the tab doesn't lose the last typed character.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
    };
  }, []);

  /* ── Step 2: headline ────────────────────────────────────── */
  const handleHeadlineChange = (value: string) => {
    setHeadline(value);
    queueSave({ headline: value || null });
  };

  /* ── Step 3: pull from profile ───────────────────────────── */
  const pullFromStory = (story: StoryDto) => {
    // Copy VERBATIM — explicitly required by the spec. No AI
    // rewrite, no whitespace collapse, no "smartening".
    setSituation(story.situation ?? "");
    setTask(story.task ?? "");
    setAction(story.action ?? "");
    setResult(story.result ?? "");
    setWhatIWouldChange(story.whatILearned ?? "");
    queueSave({
      situation: story.situation,
      task: story.task,
      action: story.action,
      result: story.result,
      what_i_would_change: story.whatILearned,
    });
    fireAnalytics("rebuild_profile_pulled", { source_type: "story" });
    setStep(4);
  };

  const pullFromProject = (project: ProjectDto) => {
    // Spec: pre-fills SITUATION only (with project context).
    // We render the situation with the project name + role so the
    // candidate has a concrete framing to expand on.
    const composed = composeProjectSituation(project);
    setSituation(composed);
    queueSave({ situation: composed });
    fireAnalytics("rebuild_profile_pulled", { source_type: "project" });
    setStep(4);
  };

  const startFresh = () => {
    fireAnalytics("rebuild_profile_pulled", { source_type: "fresh" });
    setStep(4);
  };

  /* ── Step 4: scaffold ────────────────────────────────────── */
  const canRequestCritique =
    situation.trim().length > 0 &&
    action.trim().length > 0 &&
    result.trim().length > 0 &&
    (!isFailureShaped || whatIWouldChange.trim().length > 0);

  const [critiqueLoading, setCritiqueLoading] = useState(false);
  const [critiqueError, setCritiqueError] = useState<string | null>(null);

  /* ── AI suggested response ────────────────────────────────── */

  const [suggestExpanded, setSuggestExpanded] = useState<boolean>(
    () => rebuild.aiSuggestedResponse !== null,
  );
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestPassedGuardrails, setSuggestPassedGuardrails] = useState(true);
  // True when the server returned 422 `profile_empty`: profile has
  // no resume, projects, or stories to ground the draft on.
  const [suggestProfileEmpty, setSuggestProfileEmpty] = useState(false);

  const generateSuggestion = async () => {
    setSuggestError(null);
    setSuggestProfileEmpty(false);
    setSuggestLoading(true);
    try {
      // Don't flush the in-flight scaffold edits — the suggestion
      // doesn't depend on them. (The runner uses only the
      // `questionText`, `questionTheme`, and the user's profile.)
      const response = await postSuggestResponse(rebuild.id);
      if (!response.passedGuardrails) {
        // Synthetic-fallback path. The server didn't persist
        // anything; we deliberately don't replace the cached
        // `rebuild.aiSuggestedResponse` (preserves a prior good
        // draft) and surface a "try again" message instead. The
        // synthetic body is intentionally not displayed — we
        // don't want the user editing placeholder text.
        setSuggestError(
          "AI generation didn't produce a grounded draft this time. Try again — InterviewReplay needs more profile detail to ground the answer.",
        );
        fireAnalytics("rebuild_suggested_response_requested", {
          suggestion_runs_last_24h: rebuild.suggestionRunsLast24h,
          passed_guardrails: false,
        });
        return;
      }
      setRebuild(response.rebuild);
      setSuggestPassedGuardrails(true);
      setSuggestExpanded(true);
      router.refresh();
      fireAnalytics("rebuild_suggested_response_requested", {
        suggestion_runs_last_24h: response.rebuild.suggestionRunsLast24h,
        passed_guardrails: true,
      });
    } catch (err) {
      if (err instanceof RebuildApiError) {
        if (err.code === "profile_empty") {
          setSuggestProfileEmpty(true);
        } else {
          setSuggestError(err.message);
        }
      } else {
        setSuggestError("We couldn't generate an AI draft. Try again.");
      }
    } finally {
      setSuggestLoading(false);
    }
  };

  /**
   * Copy the AI draft's STAR fields into the user's editable
   * scaffold so they can revise from there before requesting a
   * critique. Same posture as `pullFromStory`: VERBATIM copy with
   * no rewrites, mirroring the existing "pre-fill, then user
   * edits" pattern the rest of the form uses.
   *
   * If any of the scaffold fields already have substantive text
   * we ask before clobbering — the AI draft is regeneratable, the
   * user's typed draft is not.
   */
  const useSuggestionAsDraft = () => {
    const suggestion = rebuild.aiSuggestedResponse;
    if (!suggestion) return;

    const hasUserContent =
      situation.trim().length > 0 ||
      task.trim().length > 0 ||
      action.trim().length > 0 ||
      result.trim().length > 0 ||
      whatIWouldChange.trim().length > 0;

    if (hasUserContent) {
      const confirmed = window.confirm(
        "This will replace what you've written in the Situation, Task, Action, and Result fields with the AI draft. You can still edit afterwards. Continue?",
      );
      if (!confirmed) return;
    }

    const nextSituation = suggestion.situation ?? "";
    const nextTask = suggestion.task ?? "";
    const nextAction = suggestion.action ?? "";
    const nextResult = suggestion.result ?? "";
    // `whatIWouldChange` is only populated by the suggester for
    // failure-shaped themes. For non-failure themes the AI returns
    // null and we leave whatever the user had in the field alone.
    const nextWhatIWouldChange =
      suggestion.whatIWouldChange ?? whatIWouldChange;

    setSituation(nextSituation);
    setTask(nextTask);
    setAction(nextAction);
    setResult(nextResult);
    setWhatIWouldChange(nextWhatIWouldChange);

    queueSave({
      situation: nextSituation || null,
      task: nextTask || null,
      action: nextAction || null,
      result: nextResult || null,
      what_i_would_change: nextWhatIWouldChange || null,
    });

    // Collapse the draft panel so the focus lands on the now-
    // populated scaffold fields rather than a duplicate read of
    // the same content one panel down.
    setSuggestExpanded(false);

    fireAnalytics("rebuild_suggestion_used_as_draft", {
      had_user_content: hasUserContent,
      suggestion_runs_last_24h: rebuild.suggestionRunsLast24h,
    });
  };

  const requestCritique = async () => {
    setCritiqueError(null);
    setCritiqueLoading(true);
    try {
      await flushNow();
      const {
        rebuild: next,
        passedGuardrails,
        creditsCharged,
      } = await postCritique(rebuild.id);
      setRebuild(next);
      setStep(5);
      router.refresh();
      fireAnalytics("rebuild_critique_requested", {
        critique_count: next.critiqueRunCount,
        passed_guardrails: passedGuardrails,
        credits_charged: creditsCharged,
      });
    } catch (err) {
      if (err instanceof RebuildApiError) {
        setCritiqueError(err.message);
      } else {
        setCritiqueError("We couldn't generate your critique. Try again.");
      }
    } finally {
      setCritiqueLoading(false);
    }
  };

  /* ── Step 5: enhance (apply suggestions) ────────────────── */
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);

  /**
   * Snapshot of draft fields captured just before an enhance call
   * so the user can undo within 30 seconds.
   */
  const [preEnhanceDraft, setPreEnhanceDraft] = useState<{
    situation: string;
    task: string;
    action: string;
    result: string;
    whatIWouldChange: string;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyEnhancement = async () => {
    setEnhanceError(null);
    setEnhanceLoading(true);
    try {
      // Flush any pending draft edits so the server state matches
      // what the user sees before enhancement.
      await flushNow();

      // Capture the pre-enhance snapshot for undo.
      setPreEnhanceDraft({
        situation,
        task,
        action,
        result,
        whatIWouldChange,
      });

      const response = await postEnhance(rebuild.id);
      setRebuild(response.rebuild);

      // Overwrite local STAR fields with the enhanced versions.
      const r = response.rebuild;
      setSituation(r.situation ?? "");
      setTask(r.task ?? "");
      setAction(r.action ?? "");
      setResult(r.result ?? "");
      setWhatIWouldChange(r.whatIWouldChange ?? "");

      router.refresh();

      fireAnalytics("rebuild_enhance_applied", {
        credits_charged: response.creditsCharged,
      });

      // Start the 30-second undo window.
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => {
        setPreEnhanceDraft(null);
      }, 30_000);
    } catch (err) {
      // If the enhance fails, clear the snapshot we just set.
      setPreEnhanceDraft(null);
      if (err instanceof RebuildApiError) {
        setEnhanceError(err.message);
      } else {
        setEnhanceError("We couldn't rewrite your draft. Try again.");
      }
    } finally {
      setEnhanceLoading(false);
    }
  };

  const undoEnhancement = () => {
    if (!preEnhanceDraft) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    const snap = preEnhanceDraft;
    setSituation(snap.situation);
    setTask(snap.task);
    setAction(snap.action);
    setResult(snap.result);
    setWhatIWouldChange(snap.whatIWouldChange);
    // Queue a save so the server is kept in sync with the restored
    // draft. The spec says "without an API call" — we use the
    // normal debounced-save path rather than a dedicated undo
    // endpoint, so the undo itself is instant.
    queueSave({
      situation: snap.situation || null,
      task: snap.task || null,
      action: snap.action || null,
      result: snap.result || null,
      what_i_would_change: snap.whatIWouldChange || null,
    });
    setPreEnhanceDraft(null);
  };

  /* ── Step 5: revise / save ───────────────────────────────── */
  const reviseDraft = () => setStep(4);

  const [savingToBank, setSavingToBank] = useState(false);
  const [saveBankError, setSaveBankError] = useState<string | null>(null);
  const [savedStory, setSavedStory] = useState<StoryDto | null>(null);

  /**
   * `theme` is optional so the scaffold-step "Save without critique"
   * shortcut can hand off without exposing a theme picker — the
   * server falls back to `mapRebuildThemeToStoryTheme(questionTheme)`
   * when no theme is provided. The critique step still passes one
   * explicitly (the dedicated `<Select>` defaults to questionTheme
   * but the user can re-bucket before saving).
   */
  const saveToBank = async (theme?: StoryTheme) => {
    setSaveBankError(null);
    setSavingToBank(true);
    try {
      const result = await postSaveToBank(
        rebuild.id,
        theme ? { theme } : undefined,
      );
      setRebuild(result.rebuild);
      setSavedStory(result.story);
      setStep(6);
      fireAnalytics("rebuild_saved_to_bank", {
        theme: result.story.theme,
        skipped_critique: theme === undefined,
      });
    } catch (err) {
      if (err instanceof RebuildApiError) {
        setSaveBankError(err.message);
      } else {
        setSaveBankError("We couldn't save your story. Try again.");
      }
    } finally {
      setSavingToBank(false);
    }
  };

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {props.sourceContext && step !== 6 && (
        <SourceContextBanner
          context={props.sourceContext}
          questionText={rebuild.questionText}
        />
      )}

      <Stepper currentStep={step} />

      {savingState === "error" && errorMessage && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm text-amber-900">
          <AlertTriangle className="mr-2 inline size-4" aria-hidden />
          {errorMessage}
        </div>
      )}

      {step === 2 && (
        <HeadlineStep
          value={headline}
          onChange={handleHeadlineChange}
          onContinue={async () => {
            await flushNow();
            setStep(3);
            fireAnalytics("rebuild_step_completed", {
              step_name: "headline",
              step_number: 2,
            });
          }}
        />
      )}

      {step === 3 && (
        <PullFromProfileStep
          stories={
            rebuild.questionTheme ? props.matchingStories : props.allStories
          }
          projects={props.projects}
          onPullStory={pullFromStory}
          onPullProject={pullFromProject}
          onStartFresh={startFresh}
        />
      )}

      {step === 4 && (
        <ScaffoldStep
          situation={situation}
          task={task}
          action={action}
          result={result}
          whatIWouldChange={whatIWouldChange}
          showWhatIWouldChange={isFailureShaped}
          savingState={savingState}
          critiqueLoading={critiqueLoading}
          critiqueError={critiqueError}
          canSubmit={canRequestCritique}
          aiSuggestedResponse={rebuild.aiSuggestedResponse}
          suggestionGeneratedAt={rebuild.aiSuggestedResponseGeneratedAt}
          suggestionRunsLast24h={rebuild.suggestionRunsLast24h}
          suggestionLoading={suggestLoading}
          suggestionError={suggestError}
          suggestionPassedGuardrails={suggestPassedGuardrails}
          suggestionProfileEmpty={suggestProfileEmpty}
          suggestionExpanded={suggestExpanded}
          onToggleSuggestion={() => setSuggestExpanded((v) => !v)}
          onGenerateSuggestion={generateSuggestion}
          onUseSuggestionAsDraft={useSuggestionAsDraft}
          savingToBank={savingToBank}
          saveBankError={saveBankError}
          onSaveWithoutCritique={(theme) => {
            // ScaffoldStep collects the theme via the inline "File
            // this story under" picker (mirroring the critique-step
            // save UI) so the rebuild lands in the user's chosen
            // bucket instead of silently defaulting to "Other".
            void saveToBank(theme);
          }}
          initialSaveTheme={
            (rebuild.questionTheme as StoryTheme | null) ?? "other"
          }
          onChangeSituation={(v) => {
            setSituation(v);
            queueSave({ situation: v || null });
          }}
          onChangeTask={(v) => {
            setTask(v);
            queueSave({ task: v || null });
          }}
          onChangeAction={(v) => {
            setAction(v);
            queueSave({ action: v || null });
          }}
          onChangeResult={(v) => {
            setResult(v);
            queueSave({ result: v || null });
          }}
          onChangeWhatIWouldChange={(v) => {
            setWhatIWouldChange(v);
            queueSave({ what_i_would_change: v || null });
          }}
          onSubmit={requestCritique}
        />
      )}

      {step === 5 && rebuild.aiCritique && (
        <CritiqueStep
          critique={rebuild.aiCritique}
          critiqueRunsLast24h={rebuild.critiqueRunsLast24h}
          initialTheme={
            (rebuild.questionTheme as StoryTheme | null) ?? "other"
          }
          onRevise={reviseDraft}
          onSaveToBank={saveToBank}
          savingToBank={savingToBank}
          saveBankError={saveBankError}
          onApplyEnhance={applyEnhancement}
          enhanceLoading={enhanceLoading}
          enhanceError={enhanceError}
          canUndo={preEnhanceDraft !== null}
          onUndo={undoEnhancement}
        />
      )}

      {step === 6 && (
        <SavedStep
          story={savedStory}
          rebuild={rebuild}
          onBack={() => {
            if (rebuild.sourceSessionId) {
              router.push(`/sessions/${rebuild.sourceSessionId}`);
            } else {
              router.push("/dashboard");
            }
          }}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Sub-components                                                 */
/* ────────────────────────────────────────────────────────────── */

function Stepper({ currentStep }: { currentStep: Step }) {
  const steps: Array<{ n: Step; label: string }> = [
    { n: 2, label: "Headline" },
    { n: 3, label: "Pull from profile" },
    { n: 4, label: "Scaffold" },
    { n: 5, label: "Critique" },
    { n: 6, label: "Saved" },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground">
      {steps.map((s, i) => {
        const active = s.n === currentStep;
        const done = s.n < currentStep;
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full border ${
                active
                  ? "border-foreground bg-foreground text-background"
                  : done
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-700"
                    : "border-border"
              }`}
            >
              {done ? <CheckCircle2 className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={active ? "font-medium text-foreground" : ""}>
              {s.label}
            </span>
            {i < steps.length - 1 && <span aria-hidden>·</span>}
          </li>
        );
      })}
    </ol>
  );
}

function SourceContextBanner({
  context,
  questionText,
}: {
  context: SourceImprovementContext;
  questionText: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        You&apos;re rebuilding an answer for
      </p>
      <p className="mt-2 text-base font-medium text-foreground">
        &ldquo;{questionText}&rdquo;
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        InterviewReplay flagged this in your {context.sessionLabel}
        {context.improvementSummary ? (
          <> as needing: {context.improvementSummary}</>
        ) : null}
      </p>
    </div>
  );
}

function HeadlineStep({
  value,
  onChange,
  onContinue,
}: {
  value: string;
  onChange: (v: string) => void;
  onContinue: () => void;
}) {
  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">
          Start with your headline
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          In one sentence, what&apos;s the main point of this answer? Don&apos;t
          write the full story yet — just the one-line takeaway.
        </p>
      </header>
      <div className="space-y-2">
        <Label htmlFor="rebuild-headline">Headline</Label>
        <Input
          id="rebuild-headline"
          value={value}
          maxLength={200}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. I rewired our deploy pipeline to cut error rates in half."
        />
        <p className="text-xs text-muted-foreground">
          {value.length}/200
        </p>
      </div>
      <Button onClick={onContinue} disabled={value.trim().length === 0}>
        Continue
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </section>
  );
}

function PullFromProfileStep({
  stories,
  projects,
  onPullStory,
  onPullProject,
  onStartFresh,
}: {
  stories: StoryDto[];
  projects: ProjectDto[];
  onPullStory: (s: StoryDto) => void;
  onPullProject: (p: ProjectDto) => void;
  onStartFresh: () => void;
}) {
  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">
          Choose what this is about
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          InterviewReplay can show you stories and projects from your profile. Pick
          the closest match to copy your own text in. Want a fully-drafted
          starting point instead? You can also generate an AI draft on the
          next step.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            Stories matching this theme
          </h3>
          {stories.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No stories yet for this theme.{" "}
              <Link
                href="/stories"
                className="text-foreground underline underline-offset-2"
                target="_blank"
              >
                Add one →
              </Link>
            </div>
          ) : (
            stories.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPullStory(s)}
                className="block w-full rounded-lg border border-border bg-background p-4 text-left transition-colors hover:bg-muted"
              >
                <div className="text-sm font-medium">{s.title}</div>
                {s.situation && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {s.situation}
                  </p>
                )}
              </button>
            ))
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            Projects from your profile
          </h3>
          {projects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No projects yet.{" "}
              <Link
                href="/profile"
                className="text-foreground underline underline-offset-2"
                target="_blank"
              >
                Add one →
              </Link>
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPullProject(p)}
                className="block w-full rounded-lg border border-border bg-background p-4 text-left transition-colors hover:bg-muted"
              >
                <div className="text-sm font-medium">{p.name}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.companyContext ?? "—"}
                  {p.myRole ? ` · ${p.myRole}` : ""}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">Start fresh</h3>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onStartFresh}
          >
            Start with empty fields
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Pulling from your profile copies your existing text — you&apos;ll edit
        and expand from there. Prefer a fully AI-drafted starting point? Use
        the &ldquo;Generate AI draft&rdquo; panel on the next step.
      </p>
    </section>
  );
}

function ScaffoldStep(props: {
  situation: string;
  task: string;
  action: string;
  result: string;
  whatIWouldChange: string;
  showWhatIWouldChange: boolean;
  savingState: "idle" | "saving" | "error";
  critiqueLoading: boolean;
  critiqueError: string | null;
  canSubmit: boolean;
  aiSuggestedResponse: SuggestedResponse | null;
  suggestionGeneratedAt: string | null;
  suggestionRunsLast24h: number;
  suggestionLoading: boolean;
  suggestionError: string | null;
  suggestionPassedGuardrails: boolean;
  suggestionProfileEmpty: boolean;
  suggestionExpanded: boolean;
  onToggleSuggestion: () => void;
  onGenerateSuggestion: () => void;
  onUseSuggestionAsDraft: () => void;
  savingToBank: boolean;
  saveBankError: string | null;
  onSaveWithoutCritique: (theme: StoryTheme) => void;
  initialSaveTheme: StoryTheme;
  onChangeSituation: (v: string) => void;
  onChangeTask: (v: string) => void;
  onChangeAction: (v: string) => void;
  onChangeResult: (v: string) => void;
  onChangeWhatIWouldChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <StoryDraftForm
      mode="rebuild"
      data={{
        title: "",
        situation: props.situation,
        task: props.task,
        action: props.action,
        result: props.result,
        whatILearned: "",
        whatIWouldChange: props.whatIWouldChange,
      }}
      onChange={(d) => {
        props.onChangeSituation(d.situation);
        props.onChangeTask(d.task);
        props.onChangeAction(d.action);
        props.onChangeResult(d.result);
        props.onChangeWhatIWouldChange(d.whatIWouldChange);
      }}
      savingState={props.savingState}
      showWhatIWouldChange={props.showWhatIWouldChange}
      aiSuggestedResponse={props.aiSuggestedResponse}
      suggestionGeneratedAt={props.suggestionGeneratedAt}
      suggestionLoading={props.suggestionLoading}
      suggestionError={props.suggestionError}
      suggestionPassedGuardrails={props.suggestionPassedGuardrails}
      suggestionProfileEmpty={props.suggestionProfileEmpty}
      suggestionExpanded={props.suggestionExpanded}
      onToggleSuggestion={props.onToggleSuggestion}
      onGenerateSuggestion={props.onGenerateSuggestion}
      onUseSuggestionAsDraft={props.onUseSuggestionAsDraft}
      savingToBank={props.savingToBank}
      saveBankError={props.saveBankError}
      onSaveWithoutCritique={props.onSaveWithoutCritique}
      initialSaveTheme={props.initialSaveTheme}
      critiqueLoading={props.critiqueLoading}
      critiqueError={props.critiqueError}
      canSubmitCritique={props.canSubmit}
      onSubmitCritique={props.onSubmit}
    />
  );
}

/* ── Critique step (rebuild flow shell) ──────────────────────── */

function CritiqueStep({
  critique,
  critiqueRunsLast24h,
  initialTheme,
  onRevise,
  onSaveToBank,
  savingToBank,
  saveBankError,
  onApplyEnhance,
  enhanceLoading,
  enhanceError,
  canUndo,
  onUndo,
}: {
  critique: CritiqueResponse;
  critiqueRunsLast24h: number;
  initialTheme: StoryTheme;
  onRevise: () => void;
  onSaveToBank: (theme: StoryTheme) => void;
  savingToBank: boolean;
  saveBankError: string | null;
  onApplyEnhance: () => void;
  enhanceLoading: boolean;
  enhanceError: string | null;
  canUndo: boolean;
  onUndo: () => void;
}) {
  // Local picker state. Pre-fills with whatever the rebuild
  // already carries (or "other" when null) so a user who is
  // happy with the default just clicks Save.
  const [chosenTheme, setChosenTheme] = useState<StoryTheme>(initialTheme);

  return (
    <section className="space-y-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">Critique</h2>
        <span className="text-xs text-muted-foreground">
          {critiqueRunsLast24h}/10 critiques used in last 24h
        </span>
      </header>

      <CritiqueView critique={critique} />

      {/* ── Apply suggestions ───────────────────────────────── */}
      <div className="rounded-xl border border-border bg-muted/20 p-5">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">Apply these suggestions to your draft</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              InterviewReplay will rewrite your STAR fields applying the critique
              feedback above. Review the result, then revise or save.
            </p>
          </div>
        </div>

        {enhanceError && (
          <div className="mt-4 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900">
            <XCircle className="mr-2 inline size-4" aria-hidden />
            {enhanceError}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={onApplyEnhance}
            disabled={enhanceLoading}
            size="sm"
          >
            {enhanceLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Rewriting your draft…
              </>
            ) : (
              <>
                <Sparkles className="size-4" aria-hidden />
                Apply suggestions
              </>
            )}
          </Button>
          {canUndo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onUndo}
            >
              Undo
            </Button>
          )}
        </div>
      </div>

      {saveBankError && (
        <div className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900">
          {saveBankError}
        </div>
      )}

      <div className="rounded-xl border border-border bg-muted/30 p-5">
        <Label htmlFor="save-theme" className="text-sm font-medium">
          File this story under
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the behavioral theme that best matches this story. You can
          re-bucket it later from your story bank.
        </p>
        <Select
          value={chosenTheme}
          onValueChange={(v) => setChosenTheme(v as StoryTheme)}
        >
          <SelectTrigger id="save-theme" className="mt-3 w-full max-w-md">
            <SelectValue placeholder="Choose a theme" />
          </SelectTrigger>
          <SelectContent>
            {STORY_THEMES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={onRevise} variant="outline">
          Revise
        </Button>
        <Button
          onClick={() => onSaveToBank(chosenTheme)}
          disabled={savingToBank}
        >
          {savingToBank && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Save to story bank
        </Button>
      </div>
    </section>
  );
}

/* ── Step 6: saved confirmation ─────────────────────────────── */

function SavedStep({
  story,
  rebuild,
  onBack,
}: {
  story: StoryDto | null;
  rebuild: RebuildDto;
  onBack: () => void;
}) {
  const themeLabel = STORY_THEMES.find((t) => t.value === story?.theme)?.label;
  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-emerald-300/60 bg-emerald-50/40 p-6">
        <h2 className="text-2xl font-semibold tracking-tight text-emerald-900">
          Saved to your story bank
        </h2>
        <p className="mt-3 text-sm text-emerald-900/85">
          This story is now available
          {themeLabel ? <> under &ldquo;{themeLabel}&rdquo;</> : null}. It will
          be included as context in your future analyses.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button onClick={onBack}>
          {rebuild.sourceSessionId ? "Back to report" : "Back to dashboard"}
        </Button>
        <Link
          href="/stories"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-muted"
        >
          View story bank →
        </Link>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                        */
/* ────────────────────────────────────────────────────────────── */

function initialStepFor(rebuild: RebuildDto): Step {
  if (rebuild.status === "saved_to_bank") return 6;
  if (rebuild.aiCritique) return 5;
  if (
    (rebuild.situation && rebuild.situation.length > 0) ||
    (rebuild.action && rebuild.action.length > 0) ||
    (rebuild.result && rebuild.result.length > 0)
  ) {
    return 4;
  }
  if (rebuild.headline && rebuild.headline.length > 0) return 3;
  return 2;
}

function composeProjectSituation(p: ProjectDto): string {
  const parts: string[] = [];
  parts.push(`At ${p.companyContext ?? "the company"}`);
  if (p.timePeriod) parts.push(`(${p.timePeriod})`);
  if (p.myRole) parts.push(`I was ${p.myRole}`);
  parts.push(`on ${p.name}.`);
  if (p.scaleDescription) parts.push(p.scaleDescription);
  return parts.join(" ");
}

function fireAnalytics(_event: string, _properties: Record<string, unknown>): void {
  // No-op: external analytics removed for open-source.
}
