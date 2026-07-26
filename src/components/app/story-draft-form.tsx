"use client";

import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCw,
  Save,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  useId,
  useMemo,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { CritiqueView } from "@/components/app/critique-view";
import { SuggestedResponseView } from "@/components/app/suggested-response-view";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { StoryTheme } from "@/lib/db/schema";
import { STORY_FIELD_WORD_TARGETS, STORY_THEMES } from "@/lib/profiles/themes";
import type { CritiqueResponse, SuggestedResponse } from "@/lib/rebuilds/schemas";

/**
 * Credit cost constant shared by both form surfaces (0.20 credits
 * per critique / AI draft call). Mirrors `REBUILD_CRITIQUE_CREDIT_COST`
 * in `src/lib/credits/pricing.ts` — the server-side source of truth.
 */
const AI_DRAFT_CREDIT_COST = 0.2;

/* ────────────────────────────────────────────────────────────── */
/* Public types                                                    */
/* ────────────────────────────────────────────────────────────── */

/**
 * Unified data shape for both form modes. Fields not used by a
 * given mode are passed as empty strings and never rendered.
 *
 *   - title           story-bank only (rebuild passes "")
 *   - whatILearned    story-bank only (rebuild passes "")
 *   - whatIWouldChange rebuild only   (story-bank passes "")
 */
export interface StoryDraftFormData {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
  whatIWouldChange: string;
}

export interface StoryDraftFormProps {
  mode: "rebuild" | "story-bank";
  data: StoryDraftFormData;
  onChange: (d: StoryDraftFormData) => void;

  // ── Rebuild-mode props ──────────────────────────────────────────

  /** SavingPill state rendered in the scaffold header. */
  savingState?: "idle" | "saving" | "error";
  /** Whether to render the `whatIWouldChange` 5th field. */
  showWhatIWouldChange?: boolean;

  // SuggestPanel
  aiSuggestedResponse?: SuggestedResponse | null;
  suggestionGeneratedAt?: string | null;
  suggestionLoading?: boolean;
  suggestionError?: string | null;
  suggestionOutOfCredits?: boolean;
  suggestionPassedGuardrails?: boolean;
  /**
   * True when the server returned 422 `profile_empty`: the user has
   * no resume summary, projects, or stories to ground the draft on.
   * The panel shows a "fill in your profile first" message with CTAs
   * instead of generating generic placeholder text.
   */
  suggestionProfileEmpty?: boolean;
  suggestionExpanded?: boolean;
  onToggleSuggestion?: () => void;
  onGenerateSuggestion?: () => void;
  /**
   * Promote the AI draft into the user's editable STAR fields so
   * they can revise from it. Wired by `rebuild-flow.tsx`. The panel
   * only renders the button when this handler is provided AND a
   * suggestion exists — read-only callers (story bank) leave it
   * undefined and the button is hidden.
   */
  onUseSuggestionAsDraft?: () => void;

  /**
   * Optional "Save to story bank without running critique" path.
   * Renders a secondary button next to "Get critique" so a user
   * who's happy with their draft (or used the AI draft as-is) can
   * skip the critique round-trip entirely.
   *
   * Clicking the button expands an inline "File this story under"
   * theme picker (mirroring the critique-step save UI) so the user
   * picks a theme before the rebuild lands in their story bank —
   * otherwise users complained that everything silently bucketed
   * into "Other" and they had to re-categorize from the bank.
   *
   * Only wired by the rebuild scaffold step; story-bank callers
   * leave this undefined and the button is hidden.
   */
  savingToBank?: boolean;
  saveBankError?: string | null;
  onSaveWithoutCritique?: (theme: StoryTheme) => void;
  /**
   * Theme to default the "Save without critique" picker to.
   * Callers should pass the rebuild's `questionTheme` (cast to
   * `StoryTheme`) so the picker pre-fills with the most likely
   * choice. Falls back to "other" when omitted.
   */
  initialSaveTheme?: StoryTheme;

  // Critique CTA
  critiqueLoading?: boolean;
  critiqueError?: string | null;
  /** True when the user's credit balance is too low for a critique. */
  critiqueOutOfCredits?: boolean;
  canSubmitCritique?: boolean;
  onSubmitCritique?: () => void;

  // ── Story-bank-mode props ───────────────────────────────────────

  /** Controls whether the AI draft generation panel is shown. */
  storyBankFormMode?: "create" | "edit";

  // AI draft panel (create mode only)
  aiDraftLoading?: boolean;
  aiDraftError?: string | null;
  aiDraftOutOfCredits?: boolean;
  aiDraftCaveat?: string | null;
  onGenerateAiDraft?: () => void;

  // Story-bank critique
  storyCritiqueResult?: CritiqueResponse | null;
  storyCritiquePassedGuardrails?: boolean;
  storyCritiqueLoading?: boolean;
  storyCritiqueError?: string | null;
  /** True when the user's credit balance is too low for a critique. */
  storyCritiqueOutOfCredits?: boolean;
  /** True when the draft has enough content to critique. */
  canGetStoryCritique?: boolean;
  onGetStoryCritique?: () => void;

  // Story-bank enhance (visible after critique returns)
  storyEnhanceLoading?: boolean;
  storyEnhanceError?: string | null;
  /** True when the user's credit balance is too low for enhance. */
  storyEnhanceOutOfCredits?: boolean;
  /** True during the 30s undo window after an enhance is applied. */
  storyUndoAvailable?: boolean;
  onApplyStorySuggestions?: () => void;
  onUndoStoryEnhancement?: () => void;

  // Form submission
  saving?: boolean;
  submitError?: string | null;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
}

/* ────────────────────────────────────────────────────────────── */
/* Main component                                                  */
/* ────────────────────────────────────────────────────────────── */

/**
 * Shared STAR draft form used by both the Practice Rebuild flow
 * (Step 4) and the Story Bank create/edit surface.
 *
 * - `mode="rebuild"` renders a `<section>` with ScaffoldFields
 *   (helper text + char count), the SuggestPanel, and the "Get
 *   critique" CTA. Field labels and IDs use stable "rebuild-*"
 *   prefixes so the autosave / debounce machinery in RebuildFlow
 *   continues to work without change.
 *
 * - `mode="story-bank"` renders a `<form>` with StarFields (word
 *   count target hints), the AI draft generation panel (create
 *   mode only), and Cancel / Save buttons.
 *
 * All state management and API calls remain in the parent component;
 * this component is purely presentational.
 */
export function StoryDraftForm(props: StoryDraftFormProps) {
  if (props.mode === "rebuild") {
    return <RebuildForm {...props} />;
  }
  return <StoryBankForm {...props} />;
}

/* ────────────────────────────────────────────────────────────── */
/* Rebuild mode                                                    */
/* ────────────────────────────────────────────────────────────── */

function RebuildForm(props: StoryDraftFormProps) {
  const { data, onChange } = props;

  // Inline "Save without critique" theme picker. Hidden by default
  // so the scaffold step stays focused on the critique CTA — clicking
  // the secondary button expands the picker, the user picks a theme,
  // then a follow-up "Save to story bank" button fires the actual
  // save. The picker collapses again on cancel (or after save, via
  // the parent unmounting this step). The state lives here because
  // it's purely UI — the parent only needs the final theme.
  const [savePickerOpen, setSavePickerOpen] = useState(false);
  const [chosenSaveTheme, setChosenSaveTheme] = useState<StoryTheme>(
    props.initialSaveTheme ?? "other",
  );

  return (
    <section className="space-y-6">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Tell the story in four parts
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Don&apos;t worry about flow — we&apos;ll critique structure in the
            next step.
          </p>
        </div>
        <SavingPill state={props.savingState ?? "idle"} />
      </header>

      <ScaffoldField
        id="rebuild-situation"
        label="Situation"
        helper="Set the scene. When, where, who else was there. About 2–3 sentences."
        value={data.situation}
        onChange={(v) => onChange({ ...data, situation: v })}
      />
      <ScaffoldField
        id="rebuild-task"
        label="Task"
        helper="What was YOUR specific responsibility or decision? Use 'I,' not 'we.'"
        value={data.task}
        onChange={(v) => onChange({ ...data, task: v })}
      />
      <ScaffoldField
        id="rebuild-action"
        label="Action"
        helper="What did you do? Specifically. Step by step if relevant."
        value={data.action}
        onChange={(v) => onChange({ ...data, action: v })}
      />
      <ScaffoldField
        id="rebuild-result"
        label="Result"
        helper="What changed because of you? Include at least one number — time, percentage, headcount, revenue, anything measurable."
        value={data.result}
        onChange={(v) => onChange({ ...data, result: v })}
      />
      {props.showWhatIWouldChange && (
        <ScaffoldField
          id="rebuild-w"
          label="What I'd do differently"
          helper="Complete this sentence: 'Looking back, what I should have done differently is…' Be specific. Not 'I should have communicated better' but 'I should have set written expectations within the first two weeks instead of relying on verbal check-ins.'"
          value={data.whatIWouldChange}
          onChange={(v) => onChange({ ...data, whatIWouldChange: v })}
        />
      )}

      <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-4 text-sm text-foreground/90">
        InterviewReplay will critique your draft. We can also generate an AI draft for
        you to compare against — but interviewers can tell when answers are
        AI-written, so use it as a starting point and make it yours.
      </div>

      {/* AI suggested response panel — sits between the scaffold and
          the critique CTA so a user who wants to compare against an
          AI draft can generate one without leaving Step 4. */}
      <SuggestPanel
        suggestion={props.aiSuggestedResponse ?? null}
        generatedAt={props.suggestionGeneratedAt ?? null}
        loading={props.suggestionLoading ?? false}
        error={props.suggestionError ?? null}
        outOfCredits={props.suggestionOutOfCredits ?? false}
        passedGuardrails={props.suggestionPassedGuardrails ?? true}
        profileEmpty={props.suggestionProfileEmpty ?? false}
        expanded={props.suggestionExpanded ?? false}
        onToggle={props.onToggleSuggestion ?? (() => undefined)}
        onGenerate={props.onGenerateSuggestion ?? (() => undefined)}
        onUseAsDraft={props.onUseSuggestionAsDraft}
      />

      {props.critiqueOutOfCredits ? (
        <div className="flex flex-col gap-3 rounded-lg border border-rose-300/60 bg-rose-50/60 p-4 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">You&apos;re out of credits.</p>
              <p className="mt-0.5 text-rose-900/80">
                Each critique costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits. Top up
                to keep practicing.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/credits/buy">Buy credits</Link>
          </Button>
        </div>
      ) : (
        props.critiqueError && (
          <div className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900">
            <XCircle className="mr-2 inline size-4" aria-hidden />
            {props.critiqueError}
          </div>
        )
      )}

      {/*
        Save-without-critique error is rendered above the CTA row
        so it doesn't get visually swallowed by the buttons. Same
        treatment as `critiqueError` above.
      */}
      {props.saveBankError && (
        <div className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900">
          <XCircle className="mr-2 inline size-4" aria-hidden />
          {props.saveBankError}
        </div>
      )}

      {savePickerOpen && props.onSaveWithoutCritique ? (
        // Inline expand: replace the CTA row with the same "File this
        // story under" picker that the critique step uses, plus a
        // Save / Cancel pair. We don't render the "Get critique"
        // button while the picker is open to keep the user focused on
        // a single decision — Cancel collapses back to the CTA row.
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-muted/30 p-5">
            <Label
              htmlFor="rebuild-save-theme"
              className="text-sm font-medium"
            >
              File this story under
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Pick the behavioral theme that best matches this story. You
              can re-bucket it later from your story bank.
            </p>
            <Select
              value={chosenSaveTheme}
              onValueChange={(v) => setChosenSaveTheme(v as StoryTheme)}
            >
              <SelectTrigger
                id="rebuild-save-theme"
                className="mt-3 w-full max-w-md"
              >
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

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              onClick={() =>
                props.onSaveWithoutCritique?.(chosenSaveTheme)
              }
              disabled={props.savingToBank}
            >
              {props.savingToBank ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" aria-hidden />
                  Save to story bank
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => setSavePickerOpen(false)}
              disabled={props.savingToBank}
            >
              Cancel
            </Button>
            <p className="text-xs text-muted-foreground">
              Saving is free.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={props.onSubmitCritique}
            disabled={
              !props.canSubmitCritique ||
              props.critiqueLoading ||
              props.savingToBank
            }
            size="lg"
          >
            {props.critiqueLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Reviewing your draft against your profile…
              </>
            ) : (
              <>
                Get critique
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </Button>
          {/*
            Secondary "Save without critique" path. Hidden when the
            caller doesn't wire `onSaveWithoutCritique` (e.g. story-
            bank surfaces). Disabled until the same `canSubmitCritique`
            gate passes — both actions need a non-empty STAR draft.

            Click expands the inline theme picker above instead of
            saving immediately, so users get a "File this story under"
            choice rather than silently bucketing into "Other".
          */}
          {props.onSaveWithoutCritique && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => setSavePickerOpen(true)}
              disabled={
                !props.canSubmitCritique ||
                props.savingToBank ||
                props.critiqueLoading
              }
            >
              <Save className="size-4" aria-hidden />
              Save without critique
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Critique costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits. Saving
            is free.
          </p>
        </div>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Story-bank mode                                                 */
/* ────────────────────────────────────────────────────────────── */

function StoryBankForm(props: StoryDraftFormProps) {
  const { data, onChange } = props;
  const formId = useId();

  return (
    <form
      id={formId}
      onSubmit={props.onSubmit}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div>
        <Label htmlFor={`${formId}-title`}>Title</Label>
        <Input
          id={`${formId}-title`}
          value={data.title}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
          className="mt-1"
          required
          placeholder="Disagreed with my staff eng on caching strategy"
        />
      </div>

      {props.storyBankFormMode === "create" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Stuck on where to start? Generate an AI draft from your profile
              to use as a starting point — you&apos;ll edit it before saving.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={props.onGenerateAiDraft}
              disabled={props.aiDraftLoading || !data.title.trim()}
              title={
                !data.title.trim()
                  ? "Add a title first — InterviewReplay grounds the AI draft on it."
                  : undefined
              }
            >
              {props.aiDraftLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-4" aria-hidden />
              )}
              Generate AI draft
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Each AI draft costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
          </p>
          {props.aiDraftCaveat ? (
            <p className="text-xs text-muted-foreground">{props.aiDraftCaveat}</p>
          ) : null}
          {props.aiDraftOutOfCredits ? (
            <div className="flex flex-col gap-2 rounded-md border border-rose-300/60 bg-rose-50/60 p-2 text-xs text-rose-900 sm:flex-row sm:items-center sm:justify-between dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
              <span>You&apos;re out of credits. Top up to keep drafting.</span>
              <Button asChild variant="outline" size="sm">
                <Link href="/credits/buy">Buy credits</Link>
              </Button>
            </div>
          ) : props.aiDraftError ? (
            <p className="text-xs text-rose-700 dark:text-rose-300" role="alert">
              {props.aiDraftError}
            </p>
          ) : null}
        </div>
      ) : null}

      <StarField
        id={`${formId}-situation`}
        label="Situation"
        value={data.situation}
        onChange={(v) => onChange({ ...data, situation: v })}
        target={STORY_FIELD_WORD_TARGETS.situation}
        placeholder="Set the scene — when and where this happened."
      />
      <StarField
        id={`${formId}-task`}
        label="Task"
        value={data.task}
        onChange={(v) => onChange({ ...data, task: v })}
        target={STORY_FIELD_WORD_TARGETS.task}
        placeholder="What was your responsibility?"
      />
      <StarField
        id={`${formId}-action`}
        label="Action"
        value={data.action}
        onChange={(v) => onChange({ ...data, action: v })}
        target={STORY_FIELD_WORD_TARGETS.action}
        placeholder="What did YOU specifically do?"
      />
      <StarField
        id={`${formId}-result`}
        label="Result"
        value={data.result}
        onChange={(v) => onChange({ ...data, result: v })}
        target={STORY_FIELD_WORD_TARGETS.result}
        placeholder="What was the outcome — with metrics if you can."
      />
      <StarField
        id={`${formId}-learned`}
        label="What I learned"
        value={data.whatILearned}
        onChange={(v) => onChange({ ...data, whatILearned: v })}
        target={STORY_FIELD_WORD_TARGETS.what_i_learned}
        placeholder="The transferable lesson."
      />

      {props.submitError ? (
        <p className="text-sm text-destructive" role="alert">
          {props.submitError}
        </p>
      ) : null}

      {/* Critique result panel — shown after "Get critique" returns */}
      {props.storyCritiqueResult ? (
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
            <h3 className="text-sm font-semibold">AI critique</h3>
          </div>
          <CritiqueView critique={props.storyCritiqueResult} variant="compact" />

          {/* Apply suggestions sub-panel */}
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  Apply these suggestions to your draft
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  InterviewReplay will rewrite your STAR fields applying the critique
                  feedback above. Review the result, then save.
                </p>
              </div>
            </div>

            {props.storyEnhanceOutOfCredits ? (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
                <div className="flex items-start gap-2">
                  <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div>
                    <p className="font-medium">You&apos;re out of credits.</p>
                    <p className="mt-0.5 text-rose-900/80 dark:text-rose-200/80">
                      Applying suggestions costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
                      Top up to continue.
                    </p>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/credits/buy">Buy credits</Link>
                </Button>
              </div>
            ) : props.storyEnhanceError ? (
              <div className="mt-3 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
                <XCircle className="mr-2 inline size-4" aria-hidden />
                {props.storyEnhanceError}
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={props.onApplyStorySuggestions}
                disabled={props.storyEnhanceLoading}
              >
                {props.storyEnhanceLoading ? (
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
              {props.storyUndoAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={props.onUndoStoryEnhancement}
                >
                  Undo
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Critique error/out-of-credits — only shown before any result */}
      {!props.storyCritiqueResult && (
        props.storyCritiqueOutOfCredits ? (
          <div className="flex flex-col gap-2 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
            <div className="flex items-start gap-2">
              <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">You&apos;re out of credits.</p>
                <p className="mt-0.5 text-rose-900/80 dark:text-rose-200/80">
                  Each critique costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
                  Top up to keep practicing.
                </p>
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/credits/buy">Buy credits</Link>
            </Button>
          </div>
        ) : props.storyCritiqueError ? (
          <div className="rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
            <XCircle className="mr-2 inline size-4" aria-hidden />
            {props.storyCritiqueError}
          </div>
        ) : null
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Secondary CTA: Get critique */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onGetStoryCritique}
            disabled={!props.canGetStoryCritique || props.storyCritiqueLoading}
          >
            {props.storyCritiqueLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Getting critique…
              </>
            ) : (
              <>
                <Sparkles className="size-4" aria-hidden />
                Get critique
              </>
            )}
          </Button>
          {!props.storyCritiqueLoading && (
            <p className="text-xs text-muted-foreground">
              Costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
            </p>
          )}
        </div>

        {/* Primary CTAs: Cancel + Save */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={props.saving}>
            {props.saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Save className="size-4" aria-hidden />
            )}
            {props.storyBankFormMode === "create" ? "Add story" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Rebuild-mode field helpers                                      */
/* ────────────────────────────────────────────────────────────── */

/**
 * Single-field textarea with helper text + char count, used in
 * the Practice Rebuild scaffold (Step 4). Moved from rebuild-flow.tsx.
 */
export function ScaffoldField({
  id,
  label,
  helper,
  value,
  onChange,
}: {
  id: string;
  label: string;
  helper: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <p className="text-xs text-muted-foreground">{helper}</p>
      <Textarea
        id={id}
        value={value}
        maxLength={2000}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className="min-h-24"
      />
      <p className="text-xs text-muted-foreground">{value.length}/2000</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Story-bank-mode field helpers                                   */
/* ────────────────────────────────────────────────────────────── */

/**
 * Single-field textarea with word-count target hint, used in the
 * Story Bank create/edit form. Moved from story-bank-page.tsx.
 */
export function StarField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  target: { min: number; max: number };
  placeholder: string;
}) {
  const wordCount = useMemo(() => {
    const t = props.value.trim();
    return t.length === 0 ? 0 : t.split(/\s+/u).length;
  }, [props.value]);
  const inRange =
    wordCount === 0 ||
    (wordCount >= props.target.min && wordCount <= props.target.max);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Label htmlFor={props.id}>{props.label}</Label>
        <span
          className={
            inRange
              ? "text-xs text-muted-foreground"
              : "text-xs font-medium text-amber-600 dark:text-amber-400"
          }
          title={`Suggested ${props.target.min}-${props.target.max} words`}
        >
          {wordCount} words
        </span>
      </div>
      <Textarea
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        rows={3}
        placeholder={props.placeholder}
        className="mt-1"
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Rebuild-mode SavingPill                                         */
/* ────────────────────────────────────────────────────────────── */

/**
 * Inline save-state indicator shown in the rebuild scaffold header.
 * Exported so rebuild-flow.tsx can continue to use it outside the
 * shared form (e.g. in the top-level error banner area).
 */
export function SavingPill({ state }: { state: "idle" | "saving" | "error" }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Saving…
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-rose-700">
        <AlertTriangle className="size-3" aria-hidden />
        Save failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
      <CheckCircle2 className="size-3" aria-hidden />
      Saved
    </span>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Rebuild-mode SuggestPanel                                       */
/* ────────────────────────────────────────────────────────────── */

/**
 * "Generate AI draft" panel rendered inside the rebuild scaffold
 * between the STAR fields and the "Get critique" CTA. Moved from
 * rebuild-flow.tsx so the story-bank surface can reuse it when
 * critique + enhance are added there in a future PR.
 */
export function SuggestPanel(props: {
  suggestion: SuggestedResponse | null;
  generatedAt: string | null;
  loading: boolean;
  error: string | null;
  outOfCredits: boolean;
  passedGuardrails: boolean;
  /**
   * True when the server returned 422 `profile_empty`. Renders an
   * amber "add your profile content first" panel with CTAs linking
   * to /profile and /stories instead of showing a useless generic
   * draft.
   */
  profileEmpty: boolean;
  expanded: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  /**
   * Optional: promote the AI draft into the user's editable STAR
   * fields. Only the rebuild flow wires this — read-only callers
   * (story bank) omit it and the button is hidden so the same
   * panel stays safe on read-only pages.
   */
  onUseAsDraft?: () => void;
}) {
  const hasSuggestion = props.suggestion !== null;
  return (
    <section className="rounded-xl border border-border bg-muted/20 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div>
            <h3 className="text-base font-semibold">
              Want a draft to compare against?
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              InterviewReplay can write a STAR-format draft using your profile,
              projects, and existing stories. Read it side-by-side with
              your own draft, then revise yours.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasSuggestion ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onToggle}
              aria-expanded={props.expanded}
            >
              {props.expanded ? (
                <ChevronUp className="size-4" aria-hidden />
              ) : (
                <ChevronDown className="size-4" aria-hidden />
              )}
              {props.expanded ? "Hide draft" : "Show draft"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={hasSuggestion ? "outline" : "primary"}
            size="sm"
            onClick={props.onGenerate}
            disabled={props.loading}
          >
            {props.loading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : hasSuggestion ? (
              <RotateCw className="size-4" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {hasSuggestion ? "Regenerate" : "Generate AI draft"}
          </Button>
        </div>
      </header>

      <p className="mt-3 text-xs text-muted-foreground">
        Each AI draft costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits.
      </p>

      {props.profileEmpty ? (
        <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50/60 p-4 text-sm text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <BookOpen className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Your profile needs some content first.</p>
              <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
                InterviewReplay grounds the AI draft on your real experience — resume
                summary, projects, and existing stories. A generic draft won&apos;t
                help you in an actual interview.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/profile">Add your resume</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/stories">Add a story</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : props.outOfCredits ? (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-rose-300/60 bg-rose-50/60 p-4 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">You&apos;re out of credits.</p>
              <p className="mt-0.5 text-rose-900/80 dark:text-rose-200/80">
                Each AI draft costs {AI_DRAFT_CREDIT_COST.toFixed(2)} credits. Top
                up to keep practicing.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/credits/buy">Buy credits</Link>
          </Button>
        </div>
      ) : props.error ? (
        <div className="mt-4 rounded-lg border border-rose-300/60 bg-rose-50/60 p-3 text-sm text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/30 dark:text-rose-200">
          <XCircle className="mr-2 inline size-4" aria-hidden />
          {props.error}
        </div>
      ) : null}

      {hasSuggestion && props.expanded && props.suggestion ? (
        <div className="mt-5 rounded-lg border border-border/60 bg-background p-4">
          <SuggestedResponseView
            suggestion={props.suggestion}
            variant="full"
            passedGuardrails={props.passedGuardrails}
            generatedAt={props.generatedAt}
          />
          {props.onUseAsDraft && props.passedGuardrails ? (
            <div className="mt-5 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Want to revise this draft? Copy it into your answer
                above and edit from there.
              </p>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={props.onUseAsDraft}
              >
                <ArrowUp className="size-4" aria-hidden />
                Use this as my answer
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
