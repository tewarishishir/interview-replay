"use client";

import { ArrowRight, ChevronRight, Quote } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";

import type { PerQuestionAnalytics, QuestionCovered } from "@/lib/llm";

import {
  QuestionConfidencePill,
  QuestionSourcePill,
} from "./QuestionPills";
import {
  formatMmSs,
  formatProfileLeverage,
  hasWeakOrMissingStar,
  isAllNa,
  starBadgeStyleFor,
  starLetterFor,
  type StarDimensionKey,
} from "./analytics-utils";

export interface MergedQuestionRowProps {
  /** Zero-based position in the unified list. */
  index: number;
  /**
   * Matching `questionsCovered` row (when one resolved via
   * `findCoverageMatch`). Drives the confidence dot and the
   * evidence-quote block in the expanded state. `null` means we
   * either ran on a legacy report with no `questionsCovered`
   * array OR the two strings drifted enough that they couldn't be
   * paired — the row falls back to a neutral confidence dot in
   * that case.
   */
  coverage: QuestionCovered | null;
  /**
   * Matching `per_question_analytics` entry. Drives the duration,
   * STAR badges, fillers/min, I/we counts, profile-leverage row,
   * and the inline "Rebuild this answer" button. `null` for
   * coverage-only rows (the report carried no analytics for this
   * question — either legacy or the LLM dropped this row in the
   * post-launch case).
   */
  analytics: PerQuestionAnalytics | null;
  /**
   * Fired on the "View in transcript" link inside the expanded
   * card. Receives the analytics entry when one exists so the
   * parent's analytics event has the same shape `PerQuestionCard`
   * used to produce. Coverage-only rows still fire with `null` so
   * the orchestrator can credit the click; it skips the artifact-
   * scroll path internally for those rows.
   *
   * The card's main click is reserved for the expand/collapse
   * interaction — see the spec section "Collapsible per-question
   * cards" for the rationale.
   */
  onCardClick: (
    analytics: PerQuestionAnalytics | null,
    index: number,
  ) => void;
  /**
   * Fired on Rebuild button / clickable profile-leverage. Only
   * called for rows that have an analytics entry — the button
   * itself never renders without one.
   */
  onRebuildClick: (
    analytics: PerQuestionAnalytics,
    index: number,
    source: "card_button" | "profile_indicator",
  ) => void;
  /**
   * When `false`, the rebuild button is hidden and the profile-
   * leverage row is unclickable even when its status is
   * `available_unused`. Used in historical / Storybook renders.
   */
  rebuildEnabled: boolean;
  /**
   * Optional expand/collapse hook for the parent — fires with the
   * new state AFTER it's been committed locally. The parent uses
   * it to ship the `per_question_card_expanded` /
   * `per_question_card_collapsed` analytics events.
   */
  onExpandedChange?: (expanded: boolean, index: number) => void;
  /**
   * Optional controlled-mode override for the expanded state. When
   * provided, the row delegates the open/close decision to the
   * parent (used by the "Expand all / Collapse all" toggle).
   * When omitted, the row owns its own state and defaults to
   * collapsed.
   */
  expanded?: boolean;
}

/**
 * Collapsible per-question row for the merged "Questions" tab.
 *
 * Two states:
 *
 *   Collapsed (default):
 *     [• confidence dot] Q-N · {question text}   [STAR badges]   {duration}  ▸
 *
 *   Expanded (after click):
 *     ...same collapsed row at top...
 *     ---divider---
 *     {filler/min}   {I/we counts}   {profile leverage}
 *     [Rebuild this answer]   [View in transcript →]
 *
 * Design intent (per the visual-refinement spec):
 *   - Reduce visual weight per row so the per-question list
 *     scans like a table of contents, not a wall of cards.
 *   - Promote the load-bearing read (Q-N + question + STAR +
 *     duration) into the always-visible row; demote secondary
 *     metrics behind a click.
 *   - The Transcript-inferred badge is REMOVED from individual
 *     rows; the section header above surfaces the caveat once
 *     for the whole list.
 *
 * State management: local `useState` per row. Not persisted
 * across navigations. The optional `expanded` prop allows the
 * parent to override the local state for an "Expand all" toggle.
 */
export function MergedQuestionRow({
  index,
  coverage,
  analytics,
  onCardClick,
  onRebuildClick,
  rebuildEnabled,
  onExpandedChange,
  expanded: expandedProp,
}: MergedQuestionRowProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = expandedProp ?? localExpanded;
  const [hovering, setHovering] = useState(false);

  // Prefer the candidate-confirmed string (more authoritative and
  // matches the framing the candidate sees on the review screen);
  // fall back to the analytics-side text when the row is
  // analytics-only. One of the two is guaranteed non-null by the
  // parent — the list builder doesn't emit empty rows.
  const questionText =
    coverage?.question ?? analytics?.question_text ?? "";

  const showRebuild = useMemo(() => {
    if (!rebuildEnabled) return false;
    if (analytics === null) return false;
    if (hasWeakOrMissingStar(analytics)) return true;
    if (analytics.profile_leverage.status === "available_unused") return true;
    return false;
  }, [analytics, rebuildEnabled]);

  const profileLeverage = useMemo(() => {
    if (analytics === null) return null;
    if (
      analytics.question_type === "closing" ||
      analytics.question_type === "clarification"
    ) {
      return null;
    }
    return formatProfileLeverage(analytics.profile_leverage);
  }, [analytics]);

  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    if (expandedProp === undefined) {
      setLocalExpanded(next);
    }
    onExpandedChange?.(next, index);
  }, [expanded, expandedProp, onExpandedChange, index]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded],
  );

  const handleViewInTranscript = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCardClick(analytics, index);
    },
    [onCardClick, analytics, index],
  );

  const handleProfileClick = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      if (analytics === null) return;
      onRebuildClick(analytics, index, "profile_indicator");
    },
    [onRebuildClick, analytics, index],
  );

  const handleProfileKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleProfileClick(e);
      }
    },
    [handleProfileClick],
  );

  const handleRebuildButton = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (analytics === null) return;
      onRebuildClick(analytics, index, "card_button");
    },
    [onRebuildClick, analytics, index],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Question ${index + 1}: ${questionText}`}
      aria-expanded={expanded}
      onClick={toggleExpanded}
      onKeyDown={handleKey}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
      data-testid="merged-question-row"
      data-question-index={index}
      data-expanded={expanded ? "true" : "false"}
      id={analytics?.artifact_id ? `artifact-${analytics.artifact_id}` : undefined}
      className="group relative cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{
        background: hovering
          ? "var(--color-bg-secondary)"
          : "var(--color-bg-primary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-lg, 10px)",
        padding: "10px 14px",
        transition: "background 150ms ease",
      }}
    >
      {/*
        Always-visible row: Q-N + text + STAR badges + duration +
        chevron. The chevron rotates 90deg when expanded (CSS
        transform; respects prefers-reduced-motion via the global
        stylesheet).

        The heading shows the FULL question text — earlier versions
        clamped it to two lines with an ellipsis, but long
        coding-problem prompts (e.g. "Given a cinema-hall seating
        table with columns ID and status (0=available, 1=taken),
        write a SQL query…") routinely overran the limit and the
        truncated form told the candidate nothing useful. The row
        is still collapsible for the expanded-state surfaces
        (evidence quote, STAR detail, rebuild launcher) — the
        always-visible header just no longer hides text. Sibling
        elements use `items-start` so the badges/duration/chevron
        anchor to the first line when the question wraps.
      */}
      <div className="flex items-start gap-3">
        <h4
          className="font-medium text-foreground"
          style={{
            fontSize: "14px",
            lineHeight: 1.45,
            margin: 0,
            flex: 1,
            minWidth: 0,
            wordBreak: "break-word",
          }}
        >
          Q{index + 1} &middot; {questionText}
        </h4>
        {analytics !== null && (
          <div className="flex shrink-0 items-center" style={{ gap: "8px" }}>
            <StarBadges item={analytics} />
            <span
              className="text-muted-foreground tabular-nums"
              style={{
                fontSize: "12px",
                whiteSpace: "nowrap",
              }}
            >
              {formatMmSs(analytics.duration_seconds)}
            </span>
          </div>
        )}
        <ChevronRight
          aria-hidden
          style={{
            width: 14,
            height: 14,
            marginTop: 4,
            flexShrink: 0,
            color: "var(--color-text-tertiary)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 150ms ease-out",
          }}
        />
      </div>

      {/*
        Confidence + source pills row. Always visible (collapsed or
        expanded) so a candidate scanning the list immediately sees
        how sure the model is about each question and whether it
        came from a candidate-confirmed artifact or was inferred
        from the transcript. Suppressed entirely when no coverage
        record paired with the row (legacy reports or string-drift
        cases) so we don't render an empty pills strip.
      */}
      {coverage !== null && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="merged-question-row-pills"
        >
          <QuestionConfidencePill confidence={coverage.confidence} />
          <QuestionSourcePill source={coverage.source} />
        </div>
      )}

      {/* Expanded panel. Only mounted when expanded so we don't
          ship the (relatively heavy) metrics + narrative DOM for
          every row in long-question rounds. */}
      {expanded && (
        <div
          style={{
            marginTop: "10px",
            paddingTop: "10px",
            borderTop: "0.5px solid var(--color-border-tertiary)",
          }}
          data-testid="merged-question-row-expanded"
        >
          {analytics !== null && (
            <div
              className="flex flex-wrap items-center"
              style={{
                gap: "16px",
                fontSize: "12px",
                color: "var(--color-text-secondary)",
              }}
            >
              <span>{analytics.filler_per_minute.toFixed(1)} fillers/min</span>
              <span>
                {analytics.i_count} &lsquo;I&rsquo; / {analytics.we_count}{" "}
                &lsquo;we&rsquo;
              </span>
              {profileLeverage !== null && (
                <span
                  role={
                    profileLeverage.clickable && rebuildEnabled
                      ? "button"
                      : undefined
                  }
                  tabIndex={
                    profileLeverage.clickable && rebuildEnabled ? 0 : undefined
                  }
                  onClick={
                    profileLeverage.clickable && rebuildEnabled
                      ? handleProfileClick
                      : undefined
                  }
                  onKeyDown={
                    profileLeverage.clickable && rebuildEnabled
                      ? handleProfileKey
                      : undefined
                  }
                  style={{
                    color: profileLeverage.color,
                    cursor:
                      profileLeverage.clickable && rebuildEnabled
                        ? "pointer"
                        : "default",
                    textDecoration:
                      profileLeverage.clickable && rebuildEnabled
                        ? "underline"
                        : "none",
                    textUnderlineOffset: "2px",
                  }}
                  data-leverage-status={analytics.profile_leverage.status}
                >
                  {profileLeverage.text}
                </span>
              )}
            </div>
          )}

          {coverage?.evidenceQuote && (
            <p
              className="flex gap-2 border-l-2 border-primary/40 pl-3"
              style={{
                fontSize: "13px",
                marginTop: "8px",
                color: "var(--color-text-secondary)",
              }}
            >
              <Quote
                className="mt-0.5 size-3 shrink-0 text-primary/70"
                aria-hidden
              />
              <span>{coverage.evidenceQuote}</span>
            </p>
          )}

          <div
            className="flex flex-wrap items-center"
            style={{ gap: "12px", marginTop: "10px" }}
          >
            {showRebuild && (
              <button
                type="button"
                onClick={handleRebuildButton}
                aria-label={`Rebuild answer for question ${index + 1}`}
                data-testid="rebuild-button"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--color-info-text)",
                  background: "var(--color-info-bg)",
                  border: "0.5px solid var(--color-info)",
                  borderRadius: "var(--border-radius-md, 6px)",
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                Rebuild this answer
                <ArrowRight aria-hidden style={{ width: 12, height: 12 }} />
              </button>
            )}
            {analytics?.artifact_id && (
              <button
                type="button"
                onClick={handleViewInTranscript}
                data-testid="view-in-transcript"
                style={{
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--color-text-secondary)",
                  background: "transparent",
                  border: "none",
                  padding: "4px 0",
                  cursor: "pointer",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                }}
              >
                View in transcript →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * STAR badges block — kept inline at the right of the collapsed
 * row so the user reads the verdict alongside Q-N + duration.
 *
 *   - All four signals `'na'` collapse to a single grey N/A chip.
 *   - Partial-na dimensions skip their own chip (rather than
 *     rendering a meaningless `N/A` per dimension).
 */
function StarBadges({ item }: { item: PerQuestionAnalytics }) {
  if (isAllNa(item)) {
    return (
      <div
        className="flex flex-wrap"
        style={{ gap: "4px" }}
      >
        <span
          style={{
            fontSize: "11px",
            padding: "2px 6px",
            borderRadius: "var(--border-radius-md, 6px)",
            background: "var(--color-bg-secondary)",
            color: "var(--color-text-secondary)",
          }}
          data-badge="na"
        >
          N/A
        </span>
      </div>
    );
  }

  const dimensions: StarDimensionKey[] = [
    "situation",
    "task",
    "action",
    "result",
  ];

  return (
    <div
      className="flex flex-wrap"
      style={{ gap: "3px" }}
    >
      {dimensions.map((dim) => {
        const signal = item.star_signals[dim];
        const style = starBadgeStyleFor(signal);
        if (style === null) return null;
        return (
          <span
            key={dim}
            data-badge-dim={dim}
            data-badge-signal={signal}
            style={{
              fontSize: "11px",
              padding: "2px 6px",
              borderRadius: "var(--border-radius-md, 6px)",
              background: style.background,
              color: style.color,
            }}
          >
            {starLetterFor(dim)} {style.glyph}
          </span>
        );
      })}
    </div>
  );
}
