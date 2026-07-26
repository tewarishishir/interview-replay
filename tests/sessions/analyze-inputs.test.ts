/**
 * Integration tests for `loadAnalysisInputs` — the read-side
 * helper that gathers the snapshot the analyze worker hands to
 * Sonnet. Lives next to `tests/sessions/transcribe.test.ts`
 * because both files exercise the same DB-schema path.
 *
 * What we cover here:
 *   - Dismissed AI-inferred artifacts are EXCLUDED from the
 *     analyze inputs. Without this filter, the analyzer used to
 *     critique the candidate against questions they had already
 *     marked "wasn't asked".
 *   - Provenance fields (`source`, `aiConfidence`,
 *     `userConfirmed`) are propagated so the prompt builder can
 *     label each artifact correctly downstream. `userConfirmed` is
 *     a derived boolean (NOT the raw timestamp) so the value
 *     survives job runner's JSON serialization of `step.run` returns.
 *   - User-added artifacts are always returned regardless of
 *     other state (the augment UI has no dismiss control on
 *     them — but the test pins the contract anyway).
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

const seed = async () => {
  const created = await createCredentialsUser({
    email: "alice@example.com",
    password: "password123",
    name: "Alice",
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error}`);
  const user = created.user;

  const session = await createSession({
    userId: user.id,
    companyName: "Google",
    roleTitle: "Data Engineering Manager",
    level: "senior",
    roundType: "behavioral",
    scheduledAt: null,
  });

  // The analyze read path requires a transcript row to exist —
  // the worker would normally have written this before triggering
  // analysis. The text content is unimportant for these tests.
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

describe("loadAnalysisInputs — dismissed artifact filter", () => {
  it("excludes AI-inferred artifacts the candidate dismissed", async () => {
    const { userId, sessionId } = await seed();

    await db.insert(schema.artifacts).values([
      {
        sessionId,
        artifactType: "question",
        content: "Tell me about yourself.",
        displayOrder: 0,
        source: "ai_inferred",
        aiConfidence: "high",
        userConfirmedAt: null,
        dismissedAt: null,
      },
      {
        sessionId,
        artifactType: "question",
        content: "Wasn't actually asked — dismissed.",
        displayOrder: 1,
        source: "ai_inferred",
        aiConfidence: "medium",
        userConfirmedAt: null,
        dismissedAt: new Date("2026-05-08T12:00:00Z"),
      },
      {
        sessionId,
        artifactType: "question",
        content: "Why Google?",
        displayOrder: 2,
        source: "user_added",
        aiConfidence: null,
      },
    ]);

    const inputs = await loadAnalysisInputs({ sessionId, userId });
    const contents = inputs.artifacts.map((a) => a.content);
    expect(contents).toContain("Tell me about yourself.");
    expect(contents).toContain("Why Google?");
    // The dismissed row must NOT appear — feeding it to the
    // analyzer would re-surface a question the candidate already
    // said wasn't asked.
    expect(contents).not.toContain("Wasn't actually asked — dismissed.");
    expect(inputs.artifacts).toHaveLength(2);
  });

  it("propagates source + aiConfidence + userConfirmed so the prompt builder can annotate", async () => {
    const { userId, sessionId } = await seed();

    const confirmedAt = new Date("2026-05-08T12:00:00Z");
    await db.insert(schema.artifacts).values([
      {
        sessionId,
        artifactType: "question",
        content: "Tell me about yourself.",
        displayOrder: 0,
        source: "ai_inferred",
        aiConfidence: "high",
        userConfirmedAt: null,
      },
      {
        sessionId,
        artifactType: "question",
        content: "Why our company?",
        displayOrder: 1,
        source: "ai_inferred",
        aiConfidence: "medium",
        userConfirmedAt: confirmedAt,
      },
      {
        sessionId,
        artifactType: "code",
        content: "function foo() {}",
        displayOrder: 2,
        source: "user_added",
      },
    ]);

    const inputs = await loadAnalysisInputs({ sessionId, userId });
    expect(inputs.artifacts).toHaveLength(3);

    const yourself = inputs.artifacts.find(
      (a) => a.content === "Tell me about yourself.",
    );
    expect(yourself?.source).toBe("ai_inferred");
    expect(yourself?.aiConfidence).toBe("high");
    expect(yourself?.userConfirmed).toBe(false);

    const company = inputs.artifacts.find(
      (a) => a.content === "Why our company?",
    );
    expect(company?.source).toBe("ai_inferred");
    expect(company?.aiConfidence).toBe("medium");
    expect(company?.userConfirmed).toBe(true);

    const code = inputs.artifacts.find((a) => a.artifactType === "code");
    expect(code?.source).toBe("user_added");
    expect(code?.aiConfidence).toBeNull();
    expect(code?.userConfirmed).toBe(false);
  });

  it("returns artifacts in (displayOrder, createdAt) order", async () => {
    const { userId, sessionId } = await seed();

    await db.insert(schema.artifacts).values([
      {
        sessionId,
        artifactType: "question",
        content: "second",
        displayOrder: 1,
        source: "user_added",
      },
      {
        sessionId,
        artifactType: "question",
        content: "first",
        displayOrder: 0,
        source: "user_added",
      },
      {
        sessionId,
        artifactType: "question",
        content: "third",
        displayOrder: 2,
        source: "user_added",
      },
    ]);

    const inputs = await loadAnalysisInputs({ sessionId, userId });
    expect(inputs.artifacts.map((a) => a.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
