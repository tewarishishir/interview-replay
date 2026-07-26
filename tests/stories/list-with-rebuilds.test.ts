/**
 * DB-backed tests for `listStoriesWithRebuilds` — the read used
 * by the top-level Story Bank page to surface AI critique +
 * source-session backlinks alongside each saved story.
 *
 * Covers:
 *   - Hand-authored stories (no rebuild) → `rebuild === null`.
 *   - Rebuild-promoted stories → carry critique + sourceSession.
 *   - Rebuild whose source session was hard-deleted → rebuild
 *     present but `sourceSession === null`.
 *   - Ownership: a different user's stories are not returned.
 */
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import { createRebuild } from "@/lib/rebuilds/persist";
import { saveRebuildToBank } from "@/lib/rebuilds/save-to-bank";
import { listStoriesWithRebuilds } from "@/lib/queries/profiles";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email = "alice@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

async function seedSession(userId: string) {
  const [row] = await db
    .insert(schema.interviewSessions)
    .values({
      userId,
      companyName: "Stripe",
      roleTitle: "Backend Engineer",
      level: "senior",
      roundType: "coding",
      consentAffirmedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("seedSession: insert returned no row");
  return row;
}

const SAMPLE_CRITIQUE = {
  overall_assessment: "Solid, but result needs a number.",
  dimension_feedback: [
    {
      dimension: "headline",
      status: "strong",
      quoted_excerpt: "Drove the migration.",
      what_to_check: "Well-structured.",
    },
    {
      dimension: "star_completeness",
      status: "needs_work",
      quoted_excerpt: "We made it faster.",
      what_to_check: "Add a metric.",
    },
    {
      dimension: "first_person",
      status: "strong",
      quoted_excerpt: "I led.",
      what_to_check: "Good ownership.",
    },
    {
      dimension: "quantification",
      status: "missing",
      quoted_excerpt: "",
      what_to_check: "Add concrete numbers.",
    },
    {
      dimension: "profile_consistency",
      status: "strong",
      quoted_excerpt: "matches resume",
      what_to_check: "Consistent.",
    },
  ],
  next_step_suggestion: "Quantify the result with a percentage.",
};

describe("listStoriesWithRebuilds", () => {
  it("returns hand-authored stories with rebuild=null", async () => {
    const user = await seedUser();
    await db.insert(schema.stories).values({
      userId: user.id,
      theme: "leadership_conflict",
      title: "Hand-authored story",
      situation: "Set the scene.",
      action: "Did the thing.",
      result: "It worked.",
    });

    const rows = await listStoriesWithRebuilds(user.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.story.title).toBe("Hand-authored story");
    expect(rows[0]?.rebuild).toBeNull();
    expect(rows[0]?.sourceSession).toBeNull();
  });

  it("returns rebuild-promoted stories with critique + source session", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);

    const rebuild = await createRebuild({
      userId: user.id,
      questionText: "Tell me about a time you led through a tough decision.",
      questionTheme: "leadership_conflict",
      sourceSessionId: session.id,
      sourceImprovementIndex: 0,
    });

    // Fill the draft and stash a critique so save-to-bank can run
    // and the read surfaces critique on the joined row.
    await db
      .update(schema.storyRebuilds)
      .set({
        headline: "Drove the payments migration",
        situation: "We had a 90-day mandate.",
        action: "I split the work into two phases.",
        result: "We shipped 18 days early.",
        aiCritiqueJson: SAMPLE_CRITIQUE,
        status: "critiqued",
      })
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
      theme: "leadership_conflict",
    });

    const rows = await listStoriesWithRebuilds(user.id);

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.story.title).toBe("Drove the payments migration");
    expect(r.rebuild).not.toBeNull();
    expect(r.rebuild?.id).toBe(rebuild.id);
    expect(r.rebuild?.sourceSessionId).toBe(session.id);
    expect(r.rebuild?.aiCritiqueJson).toMatchObject({
      overall_assessment: SAMPLE_CRITIQUE.overall_assessment,
    });
    expect(r.sourceSession).not.toBeNull();
    expect(r.sourceSession?.id).toBe(session.id);
    expect(r.sourceSession?.companyName).toBe("Stripe");
    expect(r.sourceSession?.roundType).toBe("coding");
  });

  it("rebuild without surviving session returns rebuild but null sourceSession", async () => {
    // Models the retention-sweep case: the source session was
    // hard-deleted, the rebuild's `source_session_id` FK fired
    // ON DELETE SET NULL, the story's promoted_to_story_id is
    // intact, and the join correctly yields `sourceSession ===
    // null` while keeping the rebuild row visible.
    const user = await seedUser();
    const session = await seedSession(user.id);

    const rebuild = await createRebuild({
      userId: user.id,
      questionText: "Tell me about a time you led through a tough decision.",
      questionTheme: "mentoring",
      sourceSessionId: session.id,
      sourceImprovementIndex: 0,
    });
    await db
      .update(schema.storyRebuilds)
      .set({
        headline: "Mentored a junior through their first prod incident",
        situation: "On-call paged me.",
        action: "I walked them through it.",
        result: "They led the post-mortem.",
        aiCritiqueJson: SAMPLE_CRITIQUE,
        status: "critiqued",
      })
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
      theme: "mentoring",
    });

    // Hard-delete the session — the FK is ON DELETE SET NULL,
    // so the rebuild row survives with `source_session_id` set
    // to NULL.
    await db
      .delete(schema.interviewSessions)
      .where(eq(schema.interviewSessions.id, session.id));

    const rows = await listStoriesWithRebuilds(user.id);

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.rebuild).not.toBeNull();
    expect(r.rebuild?.sourceSessionId).toBeNull();
    expect(r.sourceSession).toBeNull();
  });

  it("does NOT surface metadata for soft-deleted sessions", async () => {
    // Defense against information leakage: a session the user
    // soft-deleted should not have its company/roundType visible
    // on the Story Bank, even though the rebuild row still
    // points at it. The card falls back to "Source session
    // unavailable" the same way it does for hard-deleted rows.
    const user = await seedUser();
    const session = await seedSession(user.id);

    const rebuild = await createRebuild({
      userId: user.id,
      questionText: "Walk me through a time you missed a deadline.",
      questionTheme: "deadline_pressure",
      sourceSessionId: session.id,
      sourceImprovementIndex: 0,
    });
    await db
      .update(schema.storyRebuilds)
      .set({
        headline: "Missed the launch date and fixed the process",
        situation: "We had a hard launch date.",
        action: "I cut scope and shipped a smaller v1.",
        result: "We launched 5 days late but the post-mortem fixed planning.",
        aiCritiqueJson: SAMPLE_CRITIQUE,
        status: "critiqued",
      })
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
      theme: "deadline_pressure",
    });

    // Soft-delete the session (state='deleted' + deleted_at set)
    // — the row remains, the rebuild's source_session_id stays
    // populated (FK only fires on hard delete), but the bank
    // page must NOT leak the soft-deleted session's metadata.
    await db
      .update(schema.interviewSessions)
      .set({ state: "deleted", deletedAt: new Date() })
      .where(eq(schema.interviewSessions.id, session.id));

    const rows = await listStoriesWithRebuilds(user.id);

    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    // Rebuild is still attached — the user's draft + critique
    // survives the source-session deletion.
    expect(r.rebuild).not.toBeNull();
    expect(r.rebuild?.sourceSessionId).toBe(session.id);
    // Source session metadata is filtered out by the join's
    // `deleted_at IS NULL` predicate.
    expect(r.sourceSession).toBeNull();
  });

  it("returns only the caller's stories", async () => {
    const owner = await seedUser("owner@example.com");
    const other = await seedUser("other@example.com");

    await db.insert(schema.stories).values({
      userId: owner.id,
      theme: "leadership_conflict",
      title: "Owner story",
    });
    await db.insert(schema.stories).values({
      userId: other.id,
      theme: "leadership_conflict",
      title: "Other user's story",
    });

    const rows = await listStoriesWithRebuilds(owner.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.story.title).toBe("Owner story");
  });
});
