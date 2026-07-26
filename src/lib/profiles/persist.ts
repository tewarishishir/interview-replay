import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  NewProject,
  NewStory,
  NewUserProfile,
  Project,
  Story,
  UserProfile,
} from "@/lib/db/schema";

import type {
  ProfileExcludeField,
  ProfilePatchOutput,
  ProjectCreateOutput,
  ProjectPatchOutput,
  StoryCreateOutput,
  StoryPatchOutput,
} from "./schemas";

/**
 * Per-user transaction-scoped advisory lock SQL. Used by
 * `createProject` and `createStory` so the count-then-insert
 * pattern is genuinely race-free.
 *
 * Without this, two concurrent POST /api/projects requests at
 * `READ COMMITTED` (Postgres' default) can each see `count = 4`,
 * each insert, and end the transaction with 6 rows for a user
 * whose cap is 5. The transaction provides atomicity but NOT
 * mutual exclusion against other transactions reading the same
 * counter.
 *
 * `pg_advisory_xact_lock(bigint)` is the right tool here:
 *   - Held until the end of the transaction; no manual release.
 *   - Per-user keyed on `hashtextextended(userId, 0)` (UUID →
 *     bigint), so independent users don't serialize.
 *   - O(1) with no schema changes; alternative
 *     ("CREATE UNIQUE INDEX … WHERE display_order < 5") would
 *     need a generated column and migration risk.
 */
function userCapLock(userId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
}

/**
 * Pure persistence helpers for the profile feature.
 *
 * Keeping the SQL one layer below the API routes lets us:
 *   - Unit-test these against a real DB without spinning up Next.
 *   - Reuse them from server actions if we add any later.
 *   - Centralize the "did this PATCH touch the resume slab?
 *     bump resume_updated_at" bookkeeping so we don't sprinkle
 *     it across half a dozen API handlers.
 */

/* ────────────────────────────────────────────────────────────── */
/* Profile upsert                                                 */
/* ────────────────────────────────────────────────────────────── */

const RESUME_FIELDS = [
  "yearsOfExperience",
  "currentRole",
  "professionalSummary",
  "companies",
  "technologies",
  "education",
  "markResumeSaved",
] as const;
const TARGET_FIELDS = ["levels", "targetCompanies", "careerNarrative"] as const;

function touchesAny<K extends string>(
  patch: Record<string, unknown>,
  keys: ReadonlyArray<K>,
): boolean {
  for (const k of keys) {
    if (k in patch) return true;
  }
  return false;
}

/**
 * Apply a PATCH to `user_profiles`. Inserts an empty row first if
 * the user has never saved before (the schema has the user_id PK
 * pointed at users, with no NOT NULL on any nullable slabs, so an
 * empty insert is well-defined).
 *
 * Bookkeeping handled here:
 *   - `resumeUpdatedAt` bumps when ANY resume field is in the patch.
 *   - `targetUpdatedAt` bumps when ANY target field is in the patch.
 *   - `resumeSavedAt` bumps when `markResumeSaved` is `true`. The
 *     flag itself is consumed and not persisted.
 *   - `updatedAt` always bumps (it's the row-level "any change" stamp).
 *
 * Returns the resulting row.
 */
export async function applyProfilePatch(args: {
  userId: string;
  patch: ProfilePatchOutput;
}): Promise<UserProfile> {
  const { userId, patch } = args;
  const now = new Date();

  // Build the SET clause from whatever was supplied. Absent keys
  // are left untouched on update.
  const setClause: Partial<NewUserProfile> = { updatedAt: now };

  if ("yearsOfExperience" in patch) {
    setClause.yearsOfExperience = patch.yearsOfExperience ?? null;
  }
  if ("currentRole" in patch) {
    setClause.currentRole = patch.currentRole ?? null;
  }
  if ("professionalSummary" in patch) {
    setClause.professionalSummary = patch.professionalSummary ?? null;
  }
  if ("companies" in patch) {
    setClause.companies = patch.companies ?? null;
  }
  if ("technologies" in patch) {
    setClause.technologies = patch.technologies ?? null;
  }
  if ("education" in patch) {
    setClause.education = patch.education ?? null;
  }
  if ("levels" in patch) {
    setClause.levels = patch.levels ?? null;
  }
  if ("targetCompanies" in patch) {
    setClause.targetCompanies = patch.targetCompanies ?? null;
  }
  if ("careerNarrative" in patch) {
    setClause.careerNarrative = patch.careerNarrative ?? null;
  }

  if (touchesAny(patch, RESUME_FIELDS)) {
    setClause.resumeUpdatedAt = now;
  }
  if (touchesAny(patch, TARGET_FIELDS)) {
    setClause.targetUpdatedAt = now;
  }
  if (patch.markResumeSaved === true) {
    setClause.resumeSavedAt = now;
  }

  // Upsert keyed by `user_id` PK. The first save creates the row;
  // subsequent saves go through the DO UPDATE branch.
  const insertRow: NewUserProfile = {
    userId,
    ...setClause,
  };

  const [row] = await db
    .insert(schema.userProfiles)
    .values(insertRow)
    .onConflictDoUpdate({
      target: schema.userProfiles.userId,
      set: setClause,
    })
    .returning();

  if (!row) {
    throw new Error("applyProfilePatch: upsert returned no row");
  }
  return row;
}

/* ────────────────────────────────────────────────────────────── */
/* Exclude toggle                                                 */
/* ────────────────────────────────────────────────────────────── */

const EXCLUDE_COLUMN: Record<
  ProfileExcludeField,
  keyof typeof schema.userProfiles
> = {
  resume: "excludeResume",
  projects: "excludeProjects",
  stories: "excludeStories",
  target: "excludeTarget",
};

/**
 * Flip `exclude_{section}` on the user's profile row, creating the
 * row if it doesn't exist yet (a brand-new user might toggle exclude
 * before they've saved anything).
 *
 * Returns the resulting row so the route can echo the new state.
 */
export async function toggleProfileExclusion(args: {
  userId: string;
  field: ProfileExcludeField;
  excluded: boolean;
}): Promise<UserProfile> {
  const { userId, field, excluded } = args;
  const now = new Date();
  const column = EXCLUDE_COLUMN[field];

  const insertRow: NewUserProfile = {
    userId,
    [column]: excluded,
    updatedAt: now,
  } as NewUserProfile;

  const setClause: Partial<NewUserProfile> = {
    [column]: excluded,
    updatedAt: now,
  } as Partial<NewUserProfile>;

  const [row] = await db
    .insert(schema.userProfiles)
    .values(insertRow)
    .onConflictDoUpdate({
      target: schema.userProfiles.userId,
      set: setClause,
    })
    .returning();

  if (!row) {
    throw new Error("toggleProfileExclusion: upsert returned no row");
  }
  return row;
}

/* ────────────────────────────────────────────────────────────── */
/* Projects                                                       */
/* ────────────────────────────────────────────────────────────── */

export class ProjectsLimitExceededError extends Error {
  readonly code = "projects_limit_exceeded";
  constructor(public readonly limit: number) {
    super(`User already has ${limit} projects.`);
    this.name = "ProjectsLimitExceededError";
  }
}

export async function createProject(args: {
  userId: string;
  data: ProjectCreateOutput;
  limit: number;
}): Promise<Project> {
  const { userId, data, limit } = args;

  return db.transaction(async (tx) => {
    // Per-user lock FIRST. Everything below this line is
    // serialized for the same userId; concurrent users still run
    // in parallel because the lock key is a hash of `userId`.
    await tx.execute(userCapLock(userId));

    // Count + insert in one transaction so two concurrent POSTs
    // can't both pass the count check and exceed the cap.
    const countRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId));
    const currentCount = countRows[0]?.n ?? 0;
    if (currentCount >= limit) {
      throw new ProjectsLimitExceededError(limit);
    }

    // Place new project at the end. The reorder endpoint can
    // shuffle later. Using MAX(displayOrder)+1 keeps numbers
    // stable even after deletes.
    const orderRows = await tx
      .select({
        next: sql<number>`COALESCE(MAX(${schema.projects.displayOrder}), -1) + 1`,
      })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId));
    const nextOrder = orderRows[0]?.next ?? 0;

    const insertRow: NewProject = {
      userId,
      name: data.name,
      companyContext: data.companyContext ?? null,
      timePeriod: data.timePeriod ?? null,
      scaleDescription: data.scaleDescription ?? null,
      teamSize: data.teamSize ?? null,
      myRole: data.myRole ?? null,
      keyDecisions: data.keyDecisions ?? null,
      outcomesWithMetrics: data.outcomesWithMetrics ?? null,
      displayOrder: nextOrder,
    };

    const [row] = await tx
      .insert(schema.projects)
      .values(insertRow)
      .returning();
    if (!row) {
      throw new Error("createProject: INSERT returned no row");
    }
    return row;
  });
}

/**
 * PATCH a single project, ownership-pinned. Returns the updated
 * row, or `null` if no row matched (caller maps to 404).
 */
export async function updateProject(args: {
  projectId: string;
  userId: string;
  patch: ProjectPatchOutput;
}): Promise<Project | null> {
  const { projectId, userId, patch } = args;
  const now = new Date();

  const setClause: Partial<NewProject> = { updatedAt: now };
  if ("name" in patch) setClause.name = patch.name!;
  if ("companyContext" in patch)
    setClause.companyContext = patch.companyContext ?? null;
  if ("timePeriod" in patch) setClause.timePeriod = patch.timePeriod ?? null;
  if ("scaleDescription" in patch)
    setClause.scaleDescription = patch.scaleDescription ?? null;
  if ("teamSize" in patch) setClause.teamSize = patch.teamSize ?? null;
  if ("myRole" in patch) setClause.myRole = patch.myRole ?? null;
  if ("keyDecisions" in patch)
    setClause.keyDecisions = patch.keyDecisions ?? null;
  if ("outcomesWithMetrics" in patch)
    setClause.outcomesWithMetrics = patch.outcomesWithMetrics ?? null;

  const [row] = await db
    .update(schema.projects)
    .set(setClause)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, userId),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * Delete one project. Returns whether a row was actually deleted —
 * `false` for both "not found" and "owned by someone else".
 */
export async function deleteProject(args: {
  projectId: string;
  userId: string;
}): Promise<boolean> {
  const { projectId, userId } = args;
  const result = await db
    .delete(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, userId),
      ),
    )
    .returning({ id: schema.projects.id });
  return result.length > 0;
}

export class ProjectReorderMismatchError extends Error {
  readonly code = "project_reorder_mismatch";
  constructor() {
    super(
      "The reorder list must contain every project the user owns, exactly once.",
    );
    this.name = "ProjectReorderMismatchError";
  }
}

/**
 * Atomically rewrite `display_order` for every one of the user's
 * projects. The supplied list must match the user's owned set
 * exactly (same ids, same count) — that way a concurrent insert
 * or delete since the client last loaded is detected and surfaced
 * as a 409 instead of silently dropping a project from view.
 */
export async function reorderProjects(args: {
  userId: string;
  projectIdsInOrder: string[];
}): Promise<Project[]> {
  const { userId, projectIdsInOrder } = args;

  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId));

    const ownedIds = new Set(owned.map((r) => r.id));
    const desired = new Set(projectIdsInOrder);
    if (
      ownedIds.size !== desired.size ||
      ![...ownedIds].every((id) => desired.has(id))
    ) {
      throw new ProjectReorderMismatchError();
    }

    const now = new Date();
    // Drizzle has no bulk SET-from-VALUES helper; small N (<= 5
    // per spec, generous cap of 50 in the schema) means
    // sequential UPDATEs inside the transaction are fine.
    for (let i = 0; i < projectIdsInOrder.length; i++) {
      const id = projectIdsInOrder[i];
      if (!id) continue;
      await tx
        .update(schema.projects)
        .set({ displayOrder: i, updatedAt: now })
        .where(
          and(
            eq(schema.projects.id, id),
            eq(schema.projects.userId, userId),
          ),
        );
    }

    return tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId))
      .orderBy(schema.projects.displayOrder);
  });
}

/* ────────────────────────────────────────────────────────────── */
/* Stories                                                        */
/* ────────────────────────────────────────────────────────────── */

export class StoriesLimitExceededError extends Error {
  readonly code = "stories_limit_exceeded";
  constructor(public readonly limit: number) {
    super(`User already has ${limit} stories.`);
    this.name = "StoriesLimitExceededError";
  }
}

export async function createStory(args: {
  userId: string;
  data: StoryCreateOutput;
  limit: number;
}): Promise<Story> {
  const { userId, data, limit } = args;

  return db.transaction(async (tx) => {
    // Per-user advisory lock so the cap is hard, not soft.
    // Concurrent POSTs serialize for this user; other users go
    // through unimpeded.
    await tx.execute(userCapLock(userId));

    const countRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stories)
      .where(eq(schema.stories.userId, userId));
    const currentCount = countRows[0]?.n ?? 0;
    if (currentCount >= limit) {
      throw new StoriesLimitExceededError(limit);
    }

    const insertRow: NewStory = {
      userId,
      theme: data.theme,
      title: data.title,
      situation: data.situation ?? null,
      task: data.task ?? null,
      action: data.action ?? null,
      result: data.result ?? null,
      whatILearned: data.whatILearned ?? null,
    };
    const [row] = await tx.insert(schema.stories).values(insertRow).returning();
    if (!row) {
      throw new Error("createStory: INSERT returned no row");
    }
    return row;
  });
}

export async function updateStory(args: {
  storyId: string;
  userId: string;
  patch: StoryPatchOutput;
}): Promise<Story | null> {
  const { storyId, userId, patch } = args;
  const now = new Date();
  const setClause: Partial<NewStory> = { updatedAt: now };
  if ("theme" in patch) setClause.theme = patch.theme!;
  if ("title" in patch) setClause.title = patch.title!;
  if ("situation" in patch) setClause.situation = patch.situation ?? null;
  if ("task" in patch) setClause.task = patch.task ?? null;
  if ("action" in patch) setClause.action = patch.action ?? null;
  if ("result" in patch) setClause.result = patch.result ?? null;
  if ("whatILearned" in patch)
    setClause.whatILearned = patch.whatILearned ?? null;

  const [row] = await db
    .update(schema.stories)
    .set(setClause)
    .where(
      and(eq(schema.stories.id, storyId), eq(schema.stories.userId, userId)),
    )
    .returning();
  return row ?? null;
}

export async function deleteStory(args: {
  storyId: string;
  userId: string;
}): Promise<boolean> {
  const { storyId, userId } = args;
  const result = await db
    .delete(schema.stories)
    .where(
      and(eq(schema.stories.id, storyId), eq(schema.stories.userId, userId)),
    )
    .returning({ id: schema.stories.id });
  return result.length > 0;
}
