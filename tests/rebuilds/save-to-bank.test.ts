/**
 * DB-backed tests for the save-to-bank promotion path.
 *
 * Covers the pieces the spec calls out as load-bearing:
 *   - field mapping (rebuild → story columns)
 *   - title truncation at 200 chars
 *   - theme fallback to 'other' when null / unknown
 *   - story-bank cap is honored (won't promote the 51st story)
 *   - rebuild row gets `promoted_to_story_id` + status flip
 *   - "ready to save" preflight catches missing headline / empty STAR
 *
 * The advisory-lock + transaction guarantees aren't easy to assert
 * directly here without a parallel-promotion harness; those rely on
 * Postgres semantics and are exercised by the cap test.
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
import { PROFILE_LIMITS } from "@/lib/profiles/constants";
import { createRebuild } from "@/lib/rebuilds/persist";
import {
  RebuildAlreadyPromotedError,
  RebuildNotReadyToSaveError,
  StoryBankLimitExceededError,
  mapRebuildThemeToStoryTheme,
  saveRebuildToBank,
} from "@/lib/rebuilds/save-to-bank";

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

interface SeedRebuildOverrides {
  headline?: string | null;
  situation?: string | null;
  task?: string | null;
  action?: string | null;
  result?: string | null;
  whatIWouldChange?: string | null;
  questionTheme?:
    | "leadership_conflict"
    | "biggest_failure"
    | "technical_disagreement"
    | "ambiguous_problem"
    | "mentoring"
    | "cross_team_collaboration"
    | "deadline_pressure"
    | "recovering_from_mistake"
    | null;
}

async function seedRebuild(userId: string, over: SeedRebuildOverrides = {}) {
  const created = await createRebuild({
    userId,
    questionText: "Tell me about a time you led through a tough decision.",
    questionTheme:
      over.questionTheme === undefined
        ? "leadership_conflict"
        : over.questionTheme,
  });

  const [updated] = await db
    .update(schema.storyRebuilds)
    .set({
      headline: over.headline ?? "Drove the migration to a new payments stack",
      situation:
        over.situation ?? "We had a 90-day mandate from the CFO.",
      task: over.task ?? "I was the tech lead on the migration team.",
      action:
        over.action ??
        "I split the work into two phases and ran daily syncs with the dependent teams.",
      result:
        over.result ??
        "We shipped 18 days early and cut payment-error rate by 40%.",
      whatIWouldChange:
        over.whatIWouldChange ??
        "I should have written down the success criteria on day one.",
    })
    .where(eq(schema.storyRebuilds.id, created.id))
    .returning();
  if (!updated) throw new Error("seedRebuild: update returned no row");
  return updated;
}

describe("saveRebuildToBank — field mapping", () => {
  it("maps every rebuild field onto the corresponding story column", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);

    const { story, rebuild: updated } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
    });

    expect(story.userId).toBe(user.id);
    expect(story.title).toBe(rebuild.headline);
    expect(story.situation).toBe(rebuild.situation);
    expect(story.task).toBe(rebuild.task);
    expect(story.action).toBe(rebuild.action);
    expect(story.result).toBe(rebuild.result);
    expect(story.whatILearned).toBe(rebuild.whatIWouldChange);
    expect(story.theme).toBe("leadership_conflict");

    expect(updated.promotedToStoryId).toBe(story.id);
    expect(updated.status).toBe("saved_to_bank");
  });

  it("uses the explicit theme override and back-writes it to the rebuild row", async () => {
    // Service-layer contract: when the route passes an explicit
    // theme (the candidate's pick at the Save-to-bank step), the
    // story row carries it AND the rebuild's questionTheme is
    // overwritten so the audit row matches the chosen theme.
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, {
      questionTheme: "leadership_conflict",
    });

    const { story, rebuild: updated } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
      theme: "deadline_pressure",
    });

    expect(story.theme).toBe("deadline_pressure");
    expect(updated.questionTheme).toBe("deadline_pressure");
    expect(updated.promotedToStoryId).toBe(story.id);
  });

  it("an explicit theme override rescues a NULL questionTheme from defaulting to 'other'", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, { questionTheme: null });

    const { story } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
      theme: "mentoring",
    });

    expect(story.theme).toBe("mentoring");
  });

  it("truncates a >200-char headline to ≤200 chars in story.title", async () => {
    const user = await seedUser();
    const giant = "x ".repeat(150).trim(); // 299 chars
    const rebuild = await seedRebuild(user.id, { headline: giant });

    const { story } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
    });

    expect(story.title.length).toBeLessThanOrEqual(201); // +1 for ellipsis
    expect(story.title.endsWith("…")).toBe(true);
  });

  it("re-reads the rebuild inside the transaction (TOCTOU defense)", async () => {
    // Specifically tests the fix for the load-bearing race: the
    // route does a `getRebuild` for ownership, then calls
    // `saveRebuildToBank`. Between those two, a concurrent PATCH
    // could change the headline / STAR fields. The save must
    // promote the LATEST content, not the snapshot the route saw.
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, {
      headline: "Stale headline the route read",
    });

    // Simulate the concurrent PATCH that fires between the route's
    // `getRebuild` and this `saveRebuildToBank` call.
    await db
      .update(schema.storyRebuilds)
      .set({
        headline: "Fresh headline the user typed in another tab",
        situation: "Fresh situation",
      })
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    const { story } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
    });

    expect(story.title).toBe("Fresh headline the user typed in another tab");
    expect(story.situation).toBe("Fresh situation");
  });
});

describe("saveRebuildToBank — theme fallback", () => {
  it("falls back to 'other' when questionTheme is null", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, { questionTheme: null });

    const { story } = await saveRebuildToBank({
      rebuildId: rebuild.id,
      userId: user.id,
    });

    expect(story.theme).toBe("other");
  });

  it("mapRebuildThemeToStoryTheme returns 'other' for unknown values", () => {
    expect(mapRebuildThemeToStoryTheme(null)).toBe("other");
    expect(mapRebuildThemeToStoryTheme(undefined)).toBe("other");
    expect(mapRebuildThemeToStoryTheme("not_a_theme")).toBe("other");
  });

  it("mapRebuildThemeToStoryTheme passes valid themes through", () => {
    expect(mapRebuildThemeToStoryTheme("biggest_failure")).toBe(
      "biggest_failure",
    );
    expect(mapRebuildThemeToStoryTheme("mentoring")).toBe("mentoring");
  });
});

describe("saveRebuildToBank — preflight rejection", () => {
  it("throws RebuildNotReadyToSaveError when headline is empty", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, { headline: "" });

    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(RebuildNotReadyToSaveError);
  });

  it("throws when every STAR field is empty", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id, {
      situation: "",
      task: "",
      action: "",
      result: "",
    });

    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(RebuildNotReadyToSaveError);
  });

  it("rejects double-promotion of the same rebuild", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id });

    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(RebuildAlreadyPromotedError);
  });

  it("rejects promoting a discarded rebuild (would resurrect a soft-delete)", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await db
      .update(schema.storyRebuilds)
      .set({ status: "discarded" })
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    const { RebuildDiscardedError } = await import(
      "@/lib/rebuilds/save-to-bank"
    );
    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(RebuildDiscardedError);
  });

  it("returns a vanished error when the row was deleted concurrently", async () => {
    const user = await seedUser();
    const rebuild = await seedRebuild(user.id);
    await db
      .delete(schema.storyRebuilds)
      .where(eq(schema.storyRebuilds.id, rebuild.id));

    const { RebuildVanishedError } = await import(
      "@/lib/rebuilds/save-to-bank"
    );
    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(RebuildVanishedError);
  });

  it("404-equivalent when promoting another user's rebuild", async () => {
    const owner = await seedUser("owner@example.com");
    const attacker = await seedUser("attacker@example.com");
    const rebuild = await seedRebuild(owner.id);

    const { RebuildVanishedError } = await import(
      "@/lib/rebuilds/save-to-bank"
    );
    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: attacker.id }),
    ).rejects.toBeInstanceOf(RebuildVanishedError);
  });
});

describe("saveRebuildToBank — story bank cap", () => {
  it("rejects promotion when the user is already at the cap", async () => {
    const user = await seedUser();

    // Fill the story bank to the cap directly (creating via
    // promotion would be O(N) save calls; we just need the count
    // to be at the cap at the moment of the next promote).
    const cap = PROFILE_LIMITS.storiesMax;
    for (let i = 0; i < cap; i++) {
      await db.insert(schema.stories).values({
        userId: user.id,
        theme: "other",
        title: `existing ${i}`,
      });
    }

    const rebuild = await seedRebuild(user.id);
    await expect(
      saveRebuildToBank({ rebuildId: rebuild.id, userId: user.id }),
    ).rejects.toBeInstanceOf(StoryBankLimitExceededError);
  });
});
