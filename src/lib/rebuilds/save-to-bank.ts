import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { PROFILE_LIMITS } from "@/lib/profiles/constants";
import {
  REBUILD_QUESTION_THEMES,
  type RebuildQuestionTheme,
  type Story,
  type StoryRebuild,
  type StoryTheme,
} from "@/lib/db/schema";

/**
 * Promote a rebuild to the user's behavioral story bank.
 *
 * Field mapping (single source of truth — pinned by tests):
 *
 *   rebuild.headline         → story.title (truncated to 200 chars)
 *   rebuild.situation        → story.situation
 *   rebuild.task             → story.task
 *   rebuild.action           → story.action
 *   rebuild.result           → story.result
 *   rebuild.whatIWouldChange → story.whatILearned
 *   args.theme               → story.theme  (REQUIRED at the route
 *                              edge; also written back to
 *                              `story_rebuilds.questionTheme`)
 *
 * The chosen theme overrides whatever (potentially-null)
 * `rebuild.questionTheme` carried — the report-launch path of
 * `RebuildLauncher` never sets it, which historically dropped
 * every save into "Other". Forcing the user to pick at save time
 * (UI is a `<Select>` defaulted to the rebuild's existing theme
 * or "other") gives the bucketing back to the human.
 *
 * Both writes (the `stories` insert and the `story_rebuilds`
 * promotion stamp) ride one transaction so a partial promotion
 * (story exists but rebuild not flipped, OR rebuild flipped
 * pointing at a story that didn't get inserted) is impossible.
 */

export class StoryBankLimitExceededError extends Error {
  readonly code = "stories_limit_exceeded";
  readonly limit: number;
  constructor(limit: number) {
    super(
      `Cannot promote rebuild: user already has ${limit} stories (the cap).`,
    );
    this.name = "StoryBankLimitExceededError";
    this.limit = limit;
  }
}

export class RebuildAlreadyPromotedError extends Error {
  readonly code = "rebuild_already_promoted";
  constructor(rebuildId: string) {
    super(
      `Rebuild ${rebuildId} is already promoted to a story (status === 'saved_to_bank').`,
    );
    this.name = "RebuildAlreadyPromotedError";
  }
}

export class RebuildDiscardedError extends Error {
  readonly code = "rebuild_discarded";
  constructor(rebuildId: string) {
    super(
      `Rebuild ${rebuildId} has been discarded and cannot be promoted to the story bank.`,
    );
    this.name = "RebuildDiscardedError";
  }
}

export class RebuildVanishedError extends Error {
  readonly code = "rebuild_not_found";
  constructor(rebuildId: string) {
    super(
      `Rebuild ${rebuildId} was deleted before save-to-bank completed.`,
    );
    this.name = "RebuildVanishedError";
  }
}

export class RebuildNotReadyToSaveError extends Error {
  readonly code = "rebuild_not_ready_to_save";
  readonly missing: ReadonlyArray<string>;
  constructor(missing: ReadonlyArray<string>) {
    super(
      `Rebuild missing fields required for save-to-bank: ${missing.join(", ")}`,
    );
    this.name = "RebuildNotReadyToSaveError";
    this.missing = missing;
  }
}

export interface SaveRebuildToBankResult {
  story: Story;
  /** Updated rebuild row (status='saved_to_bank', promoted_to_story_id set). */
  rebuild: StoryRebuild;
}

/**
 * Validate-and-promote. The route handler funnels through this
 * after verifying ownership; this layer enforces:
 *
 *   - The rebuild has a non-empty `headline` (the story bank
 *     `title` is NOT NULL in the DB; an empty headline would
 *     trip the constraint).
 *   - At least one of situation/task/action/result is non-empty
 *     — a story bank entry made entirely of nulls is useless
 *     and almost always a client bug.
 *   - The rebuild isn't already promoted (a stuck client
 *     double-clicking shouldn't create two stories).
 *   - The rebuild isn't discarded (would resurrect a
 *     soft-deleted draft as a permanent story).
 *   - The user is below the story cap.
 *
 * The transaction re-reads the rebuild row so a concurrent PATCH
 * that finished between the route's `getRebuild` and the
 * transaction landing is reflected in the story we write. The
 * caller passes only `{ rebuildId, userId }`; the snapshot lives
 * inside the tx.
 */
export async function saveRebuildToBank(args: {
  rebuildId: string;
  userId: string;
  /**
   * Theme the candidate picked at the Save-to-bank step. If
   * omitted (legacy call sites / tests not yet updated), we fall
   * back to `mapRebuildThemeToStoryTheme(rebuild.questionTheme)`
   * for backwards compatibility — but the API edge requires it.
   */
  theme?: StoryTheme;
}): Promise<SaveRebuildToBankResult> {
  return db.transaction(async (tx) => {
    // Per-user transaction-scoped advisory lock — same key
    // shape as `lib/profiles/persist.ts:userCapLock` so a
    // concurrent story create-via-API + this promotion serialize
    // per-user without serializing across users.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.userId}::text, 0))`,
    );

    // Re-read the rebuild row inside the transaction (after the
    // advisory lock so concurrent PATCH/save flows serialize
    // through the same lock). This is the load-bearing fix to
    // the TOCTOU between the route's `getRebuild` and this
    // transaction: any draft edit that committed in between is
    // visible here.
    const [r] = await tx
      .select()
      .from(schema.storyRebuilds)
      .where(
        and(
          eq(schema.storyRebuilds.id, args.rebuildId),
          eq(schema.storyRebuilds.userId, args.userId),
        ),
      )
      .limit(1);

    if (!r) throw new RebuildVanishedError(args.rebuildId);
    if (r.status === "saved_to_bank" && r.promotedToStoryId) {
      throw new RebuildAlreadyPromotedError(r.id);
    }
    if (r.status === "discarded") {
      throw new RebuildDiscardedError(r.id);
    }

    const missing: string[] = [];
    if (!r.headline?.trim()) missing.push("headline");
    if (
      !r.situation?.trim() &&
      !r.task?.trim() &&
      !r.action?.trim() &&
      !r.result?.trim()
    ) {
      missing.push("at_least_one_star_field");
    }
    if (missing.length > 0) {
      throw new RebuildNotReadyToSaveError(missing);
    }

    const theme: StoryTheme =
      args.theme ?? mapRebuildThemeToStoryTheme(r.questionTheme);
    const title = truncateTitle(r.headline!.trim());

    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stories)
      .where(eq(schema.stories.userId, r.userId));
    if ((count?.n ?? 0) >= PROFILE_LIMITS.storiesMax) {
      throw new StoryBankLimitExceededError(PROFILE_LIMITS.storiesMax);
    }

    const [story] = await tx
      .insert(schema.stories)
      .values({
        userId: r.userId,
        theme,
        title,
        situation: r.situation,
        task: r.task,
        action: r.action,
        result: r.result,
        whatILearned: r.whatIWouldChange,
      })
      .returning();
    if (!story) {
      throw new Error("saveRebuildToBank: stories insert returned no row");
    }

    // Back-write the chosen theme onto the rebuild row so the
    // audit trail reflects what the candidate decided at save
    // time. This keeps `story.theme === rebuild.questionTheme`
    // post-save, which downstream queries (analyze, list-with-
    // rebuilds) rely on for theme-grouped joins.
    const [rebuild] = await tx
      .update(schema.storyRebuilds)
      .set({
        promotedToStoryId: story.id,
        questionTheme: theme,
        status: "saved_to_bank",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.storyRebuilds.id, r.id),
          eq(schema.storyRebuilds.userId, r.userId),
        ),
      )
      .returning();
    if (!rebuild) {
      throw new Error(
        `saveRebuildToBank: failed to flip rebuild ${r.id} to saved_to_bank — concurrent delete?`,
      );
    }

    return { story, rebuild };
  });
}

/**
 * Spec: title cap is 200 chars (story bank titles are display
 * surface, not prose). We slice at the closest word boundary
 * within the last 12 chars before the limit so a slice doesn't
 * end mid-word like "transmissi…".
 */
const TITLE_MAX = 200;
function truncateTitle(input: string): string {
  if (input.length <= TITLE_MAX) return input;
  const slice = input.slice(0, TITLE_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > TITLE_MAX - 12) {
    return slice.slice(0, lastSpace) + "…";
  }
  return slice + "…";
}

/**
 * Map a rebuild's `question_theme` (TEXT, may be null or
 * out-of-enum because we don't enforce membership in the DB
 * column) onto a valid `story_theme`. Fallback is 'other' —
 * the spec calls this out explicitly so the renderer always
 * has a category for the new bank entry.
 *
 * Exported for tests.
 */
export function mapRebuildThemeToStoryTheme(
  theme: string | null | undefined,
): StoryTheme {
  if (
    theme &&
    (REBUILD_QUESTION_THEMES as readonly string[]).includes(theme)
  ) {
    return theme as RebuildQuestionTheme as StoryTheme;
  }
  return "other";
}
