import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  CritiqueResponse,
  PatchRebuildInput,
  SuggestedResponse,
} from "./schemas";
import type {
  RebuildCritiqueHistoryEntry,
  RebuildQuestionTheme,
  RebuildStatus,
  RebuildSuggestedResponseHistoryEntry,
  StoryRebuild,
} from "@/lib/db/schema";

/**
 * Statuses we accept writes against. Mutating a `saved_to_bank` row
 * would diverge it from the promoted `stories` row that's now the
 * canonical record; mutating a `discarded` row would resurrect a
 * soft-deleted draft. Both are caught at the persist layer so a
 * future route refactor can't accidentally bypass the check.
 */
const MUTABLE_STATUSES: ReadonlyArray<RebuildStatus> = [
  "in_progress",
  "critiqued",
];

/**
 * Discriminated result for write-side helpers. The route layer maps
 * `not_found` → 404 and `wrong_state` → 409 so the API surface
 * distinguishes "you don't own this" from "this rebuild has moved
 * past the editable lifecycle."
 */
export type WriteOutcome<T> =
  | { ok: true; row: T }
  | { ok: false; reason: "not_found" | "wrong_state" };

/**
 * Write-side helpers for the Practice Rebuild feature. The API
 * routes funnel through these so the SQL stays in one place and
 * unit tests can hit a real DB without spinning up Next.js.
 *
 * Ownership scoping is the boundary contract: every write takes
 * `(rebuildId, userId)` and pins the WHERE on both. The route
 * handler verifies the row exists for the caller via
 * `getRebuild()` before calling these helpers, but the WHERE
 * clauses below are the load-bearing defense — a future refactor
 * that drops the route-level check can't accidentally cross-tenant
 * leak through this layer.
 */

export interface CreateRebuildArgs {
  userId: string;
  sourceSessionId?: string | null;
  sourceImprovementIndex?: number | null;
  /**
   * The artifact (question) row this rebuild addresses. Optional
   * — set when the user launches a rebuild from the Analytics
   * tab. Caller MUST have already verified the UUID belongs to a
   * session the user owns; this layer trusts the caller and just
   * stores the value.
   */
  sourceArtifactId?: string | null;
  /**
   * Profile item (project or story) to pre-select on Step 3 of
   * the rebuild flow. Optional — caller MUST have already
   * verified the UUID belongs to one of the user's `projects` /
   * `stories` (NOT a Postgres FK because it spans two tables).
   */
  preSelectedProfileItemId?: string | null;
  questionText: string;
  questionTheme?: RebuildQuestionTheme | null;
}

export async function createRebuild(
  args: CreateRebuildArgs,
): Promise<StoryRebuild> {
  const [row] = await db
    .insert(schema.storyRebuilds)
    .values({
      userId: args.userId,
      sourceSessionId: args.sourceSessionId ?? null,
      sourceImprovementIndex: args.sourceImprovementIndex ?? null,
      sourceArtifactId: args.sourceArtifactId ?? null,
      preSelectedProfileItemId: args.preSelectedProfileItemId ?? null,
      questionText: args.questionText,
      questionTheme: args.questionTheme ?? null,
      status: "in_progress",
    })
    .returning();

  if (!row) {
    throw new Error("createRebuild: insert returned no row");
  }
  return row;
}

/**
 * Apply a partial update. Only the keys present in `patch` are
 * touched; `undefined` is "leave alone", `null` is "explicitly
 * clear" (per the auto-save UI's behavior — clearing a textarea
 * sends a clear).
 *
 * `updated_at` always advances on a successful PATCH so the
 * "Strengthen your story bank" section's "you've already started
 * a rebuild" badge orders correctly.
 *
 * Refuses to mutate `saved_to_bank` (would drift from the promoted
 * story) and `discarded` (would resurrect a soft-deleted draft).
 * The route maps the two failure modes to 404 and 409 respectively
 * — `not_found` is also returned for a row owned by someone else
 * so cross-tenant probes can't differentiate by error code.
 */
export async function patchRebuild(args: {
  rebuildId: string;
  userId: string;
  patch: PatchRebuildInput;
}): Promise<WriteOutcome<StoryRebuild>> {
  const set: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  // Map snake_case body keys to camelCase columns. Only touch
  // keys that were present in the request — `undefined` means
  // "leave alone".
  if (args.patch.headline !== undefined) set.headline = args.patch.headline;
  if (args.patch.situation !== undefined) set.situation = args.patch.situation;
  if (args.patch.task !== undefined) set.task = args.patch.task;
  if (args.patch.action !== undefined) set.action = args.patch.action;
  if (args.patch.result !== undefined) set.result = args.patch.result;
  if (args.patch.what_i_would_change !== undefined) {
    set.whatIWouldChange = args.patch.what_i_would_change;
  }
  if (args.patch.question_theme !== undefined) {
    set.questionTheme = args.patch.question_theme;
  }

  // The status guard rides in the WHERE clause so the update is
  // a single round-trip with no TOCTOU. A row in a non-mutable
  // state simply won't match. We then disambiguate "row missing"
  // from "wrong state" with a follow-up read; both branches map
  // to distinct API responses.
  const [row] = await db
    .update(schema.storyRebuilds)
    .set(set)
    .where(
      and(
        eq(schema.storyRebuilds.id, args.rebuildId),
        eq(schema.storyRebuilds.userId, args.userId),
        inArray(schema.storyRebuilds.status, MUTABLE_STATUSES as RebuildStatus[]),
      ),
    )
    .returning();

  if (row) return { ok: true, row };

  // No row updated. Distinguish "wrong state" from "not yours / not
  // there" so the route can return 409 vs. 404. We do a userId-pinned
  // existence check — a row that exists for some other user reads
  // back as not_found (no info disclosure).
  const [existing] = await db
    .select({ id: schema.storyRebuilds.id })
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.id, args.rebuildId),
        eq(schema.storyRebuilds.userId, args.userId),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, reason: "wrong_state" };
  return { ok: false, reason: "not_found" };
}

/**
 * Hard cap on `critique_history` length. The 24-h rate gate caps
 * critiques at 10/day, so 100 entries spans roughly two weeks of
 * heavy use — well past the point where older critiques are
 * useful. Bounding the column keeps a single rebuild row from
 * bloating to multi-MB JSONB if a user revives an old draft after
 * months of work.
 */
const CRITIQUE_HISTORY_MAX = 100;

/**
 * Apply a fresh critique. Pushes the previous critique (if any)
 * onto `critique_history` with its generation timestamp, sets the
 * new critique on `ai_critique_json`, and flips the status to
 * `critiqued`.
 *
 * The append-onto-history step uses the prior `aiCritiqueJson` we
 * read inside this function (NOT a stale read from the API
 * handler) so a concurrent re-critique can't drop a prior
 * critique on the floor. The whole thing rides one transaction so
 * a partial write (status flipped, history not appended) is
 * impossible.
 *
 * Refuses to apply on `saved_to_bank` (would diverge from the
 * promoted story) or `discarded` (would resurrect a soft-deleted
 * draft) — the route layer also gates on this, but the persist
 * layer carries the contract too.
 */
export async function applyCritique(args: {
  rebuildId: string;
  userId: string;
  critique: CritiqueResponse;
  /**
   * The timestamp the critique was generated at, in ISO-8601 UTC.
   * Pinned by the caller (not derived from `now()` here) so unit
   * tests can write deterministic history entries.
   */
  at: Date;
}): Promise<WriteOutcome<StoryRebuild>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .limit(1);

    if (!current) return { ok: false, reason: "not_found" } as const;
    if (
      current.status !== "in_progress" &&
      current.status !== "critiqued"
    ) {
      return { ok: false, reason: "wrong_state" } as const;
    }

    const prior: RebuildCritiqueHistoryEntry[] = Array.isArray(
      current.critiqueHistory,
    )
      ? current.critiqueHistory
      : [];
    const newHistory: RebuildCritiqueHistoryEntry[] = [...prior];
    if (current.aiCritiqueJson != null) {
      // The prior critique gets timestamped with the row's
      // `updatedAt` (we don't carry a separate timestamp on the
      // current critique). Keeps the "10 critiques in 24h" gate
      // honest even for rebuilds that pre-date the gate logic.
      newHistory.push({
        at: current.updatedAt.toISOString(),
        critique: current.aiCritiqueJson,
      });
    }
    // Trim to the hard cap, dropping the oldest entries first.
    // Drop from the FRONT (oldest) so the rate-gate's 24-h window
    // — which only cares about timestamps inside the window —
    // never loses an in-window entry: the dropped entries are
    // always older than every kept one.
    const trimmedHistory =
      newHistory.length > CRITIQUE_HISTORY_MAX
        ? newHistory.slice(newHistory.length - CRITIQUE_HISTORY_MAX)
        : newHistory;

    const [updated] = await tx
      .update(schema.storyRebuilds)
      .set({
        aiCritiqueJson: args.critique,
        critiqueHistory: trimmedHistory,
        status: "critiqued",
        updatedAt: args.at,
      })
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          // Defense-in-depth: the id+userId pair was matched by the
          // SELECT above; we re-pin the userId on the UPDATE so a
          // future refactor (reusing this function from a different
          // call site, or extracting the SELECT) can't silently
          // drop the ownership boundary.
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .returning();

    if (!updated) return { ok: false, reason: "not_found" } as const;
    return { ok: true, row: updated };
  });
}

/**
 * Hard cap on `suggested_response_history` length. Same posture
 * as `CRITIQUE_HISTORY_MAX` — the 24h gate caps generations at
 * 10/day, so 100 entries spans roughly two weeks of heavy use.
 */
const SUGGEST_HISTORY_MAX = 100;

/**
 * Apply a fresh suggested-response. Pushes the previous suggestion
 * (if any) onto `suggested_response_history` with the timestamp the
 * row currently carries on `aiSuggestedResponseGeneratedAt`, sets
 * the new suggestion + model version + new generated-at on the row,
 * and bumps `updatedAt`.
 *
 * Crucially, this does NOT flip `status` — a suggestion is a
 * read-only side-channel for the user to compare against, not a
 * lifecycle event. A draft can have a suggestion attached while
 * still in `in_progress`, and a `critiqued` rebuild can still
 * generate fresh suggestions.
 *
 * Refuses to apply on `saved_to_bank` (would diverge from the
 * promoted story) or `discarded` (would resurrect a soft-deleted
 * draft) — same posture as `applyCritique`.
 */
export async function applySuggestedResponse(args: {
  rebuildId: string;
  userId: string;
  suggestion: SuggestedResponse;
  modelVersion: string;
  /**
   * The timestamp the suggestion was generated at, in UTC. Pinned
   * by the caller (not derived from `now()`) so unit tests can
   * write deterministic history entries.
   */
  at: Date;
}): Promise<WriteOutcome<StoryRebuild>> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .limit(1);

    if (!current) return { ok: false, reason: "not_found" } as const;
    if (
      current.status !== "in_progress" &&
      current.status !== "critiqued"
    ) {
      return { ok: false, reason: "wrong_state" } as const;
    }

    const prior: RebuildSuggestedResponseHistoryEntry[] = Array.isArray(
      current.suggestedResponseHistory,
    )
      ? current.suggestedResponseHistory
      : [];
    const newHistory: RebuildSuggestedResponseHistoryEntry[] = [...prior];
    if (
      current.aiSuggestedResponseJson != null &&
      current.aiSuggestedResponseGeneratedAt != null
    ) {
      newHistory.push({
        at: current.aiSuggestedResponseGeneratedAt.toISOString(),
        suggestion: current.aiSuggestedResponseJson,
      });
    }
    const trimmedHistory =
      newHistory.length > SUGGEST_HISTORY_MAX
        ? newHistory.slice(newHistory.length - SUGGEST_HISTORY_MAX)
        : newHistory;

    const [updated] = await tx
      .update(schema.storyRebuilds)
      .set({
        aiSuggestedResponseJson: args.suggestion,
        aiSuggestedResponseModelVersion: args.modelVersion,
        aiSuggestedResponseGeneratedAt: args.at,
        suggestedResponseHistory: trimmedHistory,
        updatedAt: args.at,
      })
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .returning();

    if (!updated) return { ok: false, reason: "not_found" } as const;
    return { ok: true, row: updated };
  });
}

/**
 * Soft-delete: flip the status to `discarded`. The row is kept so
 * the user has 30 days to undo via support; the daily retention
 * sweep purges it after that.
 *
 * Refuses to discard `saved_to_bank` rebuilds — once promoted, the
 * rebuild row is the audit trail for the story; deleting it would
 * orphan the story from its provenance and the retention sweep
 * would later hard-delete the audit history. A user who wants to
 * "delete" a saved rebuild's story should delete the story from
 * the bank instead (which sets `promoted_to_story_id` to NULL via
 * the FK ON DELETE SET NULL).
 *
 * Idempotent on already-discarded rows: returns `{ ok: true }` so
 * a polite client double-click reads the same as the first call.
 */
export async function discardRebuild(args: {
  rebuildId: string;
  userId: string;
}): Promise<WriteOutcome<{ id: string }>> {
  // Read first to distinguish 404 (not yours) from 409
  // (saved_to_bank can't be discarded). A single UPDATE-with-WHERE
  // would conflate the two.
  const [existing] = await db
    .select({ id: schema.storyRebuilds.id, status: schema.storyRebuilds.status })
    .from(schema.storyRebuilds)
    .where(
      and(
        eq(schema.storyRebuilds.id, args.rebuildId),
        eq(schema.storyRebuilds.userId, args.userId),
      ),
    )
    .limit(1);

  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "saved_to_bank") {
    return { ok: false, reason: "wrong_state" };
  }
  if (existing.status === "discarded") {
    return { ok: true, row: { id: existing.id } };
  }

  const [row] = await db
    .update(schema.storyRebuilds)
    .set({ status: "discarded", updatedAt: new Date() })
    .where(
      and(
        eq(schema.storyRebuilds.id, args.rebuildId),
        eq(schema.storyRebuilds.userId, args.userId),
        // Re-assert the editable-status set inside the UPDATE so a
        // race with save-to-bank can't slip a discard past the
        // saved_to_bank guard above.
        inArray(schema.storyRebuilds.status, MUTABLE_STATUSES as RebuildStatus[]),
      ),
    )
    .returning({ id: schema.storyRebuilds.id });

  if (!row) {
    // Race: status flipped between the SELECT and the UPDATE.
    // Re-read once and report consistently.
    const [recheck] = await db
      .select({ status: schema.storyRebuilds.status })
      .from(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .limit(1);
    if (!recheck) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "wrong_state" };
  }
  return { ok: true, row };
}

