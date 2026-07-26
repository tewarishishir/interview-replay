import "server-only";

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  Story,
  StorySuggestedResponseHistoryEntry,
} from "@/lib/db/schema";
import type { SuggestedResponse } from "@/lib/rebuilds/schemas";

import type { WriteOutcome } from "@/lib/rebuilds";

/**
 * Hard cap on `stories.suggested_response_history` length. Same
 * posture as `SUGGEST_HISTORY_MAX` in the rebuild persist layer —
 * the per-story 24h gate caps generations at 10/day, so 100
 * entries spans ~2 weeks of heavy use.
 */
const STORY_SUGGEST_HISTORY_MAX = 100;

/**
 * Apply a fresh story-side suggested response. Pushes the
 * previous suggestion (if any) onto `suggested_response_history`
 * with the timestamp the row currently carries on
 * `aiSuggestedResponseGeneratedAt`, sets the new suggestion +
 * model version + new generated-at on the row, and bumps
 * `updatedAt`.
 *
 * Mirrors `applySuggestedResponse` in `src/lib/rebuilds/persist.ts`
 * 1:1 — the only difference is which row we write to. The rebuild
 * surface attaches its suggestion to the rebuild row; the bank
 * surface attaches it to the story row directly. The two are
 * deliberately independent so a hand-authored story (no rebuild
 * row) can carry its own suggestion, and a rebuild-derived story
 * can carry both (the bank UI prefers the story-side value when
 * present, falling back to the rebuild side).
 *
 * Ownership: the WHERE clause pins `(id, user_id)` so a future
 * refactor that drops the route-level ownership check can't
 * cross-tenant leak through this helper.
 *
 * Lifecycle: stories don't have a `status` enum — there's no
 * "saved_to_bank vs in_progress" distinction. Existence + scoped
 * ownership is the entire gate.
 */
export async function applyStorySuggestedResponse(args: {
  storyId: string;
  userId: string;
  suggestion: SuggestedResponse;
  modelVersion: string;
  /**
   * The timestamp the suggestion was generated at, in UTC. Pinned
   * by the caller (not derived from `now()`) so unit tests can
   * write deterministic history entries.
   */
  at: Date;
}): Promise<WriteOutcome<Story>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.stories)
      .where(
        and(
          eq(schema.stories.id, args.storyId),
          eq(schema.stories.userId, args.userId),
        ),
      )
      .limit(1);

    if (!current) return { ok: false, reason: "not_found" } as const;

    const prior: StorySuggestedResponseHistoryEntry[] = Array.isArray(
      current.suggestedResponseHistory,
    )
      ? current.suggestedResponseHistory
      : [];
    const newHistory: StorySuggestedResponseHistoryEntry[] = [...prior];
    if (
      current.aiSuggestedResponseJson != null &&
      current.aiSuggestedResponseGeneratedAt != null
    ) {
      newHistory.push({
        at: current.aiSuggestedResponseGeneratedAt.toISOString(),
        suggestion: current.aiSuggestedResponseJson,
      });
    }
    // Trim to the hard cap, dropping the oldest entries first so
    // the rate gate never loses an in-window timestamp.
    const trimmedHistory =
      newHistory.length > STORY_SUGGEST_HISTORY_MAX
        ? newHistory.slice(newHistory.length - STORY_SUGGEST_HISTORY_MAX)
        : newHistory;

    const [updated] = await tx
      .update(schema.stories)
      .set({
        aiSuggestedResponseJson: args.suggestion,
        aiSuggestedResponseModelVersion: args.modelVersion,
        aiSuggestedResponseGeneratedAt: args.at,
        suggestedResponseHistory: trimmedHistory,
        updatedAt: args.at,
      })
      .where(
        and(
          eq(schema.stories.id, args.storyId),
          // Defense-in-depth: the id+userId pair was matched by
          // the SELECT above; we re-pin the userId on the UPDATE
          // so a future refactor can't silently drop the
          // ownership boundary.
          eq(schema.stories.userId, args.userId),
        ),
      )
      .returning();

    if (!updated) return { ok: false, reason: "not_found" } as const;
    return { ok: true, row: updated };
  });
}

/**
 * Read a single story scoped to the caller. Returns `null` when
 * the story doesn't exist OR is owned by another user — both
 * shapes collapse so cross-tenant probes can't differentiate.
 */
export async function getStoryForUser(
  storyId: string,
  userId: string,
): Promise<Story | null> {
  const [row] = await db
    .select()
    .from(schema.stories)
    .where(
      and(eq(schema.stories.id, storyId), eq(schema.stories.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}
