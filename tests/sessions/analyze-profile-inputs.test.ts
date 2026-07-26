/**
 * Tests for the profile-loading half of `loadAnalysisInputs` —
 * the new bundle the analyze worker hands to Sonnet so the
 * `per_question_analytics[i].profile_leverage` field has real,
 * owned items to point at.
 *
 * Two contracts under test:
 *   1. The bundle's `projects` / `stories` arrays are gated by
 *      the per-section `exclude_*` toggles. A candidate who opted
 *      out shouldn't see their profile leak into the prompt.
 *   2. Artifact rows carry their UUID into the bundle (the new
 *      `id` field) so the worker can build the guardrail-3
 *      `validArtifactIds` set without a second DB round-trip.
 */
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
import { createSession } from "@/lib/sessions/create";
import { loadAnalysisInputs } from "@/lib/sessions/analyze";

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

const seedBaseFixture = async () => {
  const created = await createCredentialsUser({
    email: "alice@example.com",
    password: "password123",
    name: "Alice",
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error}`);
  const user = created.user;

  const session = await createSession({
    userId: user.id,
    companyName: "Stripe",
    roleTitle: "Engineer",
    level: "senior",
    roundType: "behavioral",
    scheduledAt: null,
  });

  await db.insert(schema.transcripts).values({
    sessionId: session.id,
    rawText: "raw",
    redactedText: "redacted",
    redactionCount: 0,
    language: "en",
    wordCount: 10,
    durationSeconds: 60,
    fillerWordCount: 0,
    transcriptionError: null,
  });

  return { userId: user.id, sessionId: session.id };
};

describe("loadAnalysisInputs — profile + artifact ids", () => {
  it("returns the user's projects and stories in the bundle", async () => {
    const { userId, sessionId } = await seedBaseFixture();

    await db.insert(schema.projects).values({
      userId,
      name: "Stripe migration",
      companyContext: "Stripe",
      myRole: "Tech lead",
      outcomesWithMetrics: "Halved p99 latency",
      displayOrder: 0,
    });
    await db.insert(schema.stories).values({
      userId,
      theme: "leadership_conflict",
      title: "Convincing a skeptical staff engineer",
      situation: "team was split on direction",
    });

    const inputs = await loadAnalysisInputs({ userId, sessionId });
    expect(inputs.profile.projects).toHaveLength(1);
    expect(inputs.profile.projects[0]!.name).toBe("Stripe migration");
    expect(inputs.profile.stories).toHaveLength(1);
    expect(inputs.profile.stories[0]!.theme).toBe("leadership_conflict");
  });

  it("returns empty arrays when no profile row exists for the user", async () => {
    const { userId, sessionId } = await seedBaseFixture();
    const inputs = await loadAnalysisInputs({ userId, sessionId });
    expect(inputs.profile.projects).toEqual([]);
    expect(inputs.profile.stories).toEqual([]);
  });

  it("honors exclude_projects = true", async () => {
    const { userId, sessionId } = await seedBaseFixture();
    await db.insert(schema.userProfiles).values({
      userId,
      excludeProjects: true,
      excludeStories: false,
    });
    await db.insert(schema.projects).values({
      userId,
      name: "Stripe migration",
      displayOrder: 0,
    });
    await db.insert(schema.stories).values({
      userId,
      theme: "leadership_conflict",
      title: "Story title",
    });

    const inputs = await loadAnalysisInputs({ userId, sessionId });
    expect(inputs.profile.projects).toEqual([]);
    expect(inputs.profile.stories).toHaveLength(1);
  });

  it("honors exclude_stories = true", async () => {
    const { userId, sessionId } = await seedBaseFixture();
    await db.insert(schema.userProfiles).values({
      userId,
      excludeProjects: false,
      excludeStories: true,
    });
    await db.insert(schema.projects).values({
      userId,
      name: "Stripe migration",
      displayOrder: 0,
    });
    await db.insert(schema.stories).values({
      userId,
      theme: "leadership_conflict",
      title: "Story title",
    });

    const inputs = await loadAnalysisInputs({ userId, sessionId });
    expect(inputs.profile.projects).toHaveLength(1);
    expect(inputs.profile.stories).toEqual([]);
  });

  it("returns the artifact UUID alongside the rest of the row", async () => {
    const { userId, sessionId } = await seedBaseFixture();
    const [art] = await db
      .insert(schema.artifacts)
      .values({
        sessionId,
        artifactType: "question",
        content: "Tell me about yourself.",
        displayOrder: 0,
        source: "user_added",
      })
      .returning({ id: schema.artifacts.id });

    const inputs = await loadAnalysisInputs({ userId, sessionId });
    expect(inputs.artifacts).toHaveLength(1);
    expect(inputs.artifacts[0]!.id).toBe(art!.id);
  });
});
