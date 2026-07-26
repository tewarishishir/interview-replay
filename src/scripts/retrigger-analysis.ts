/**
 * Manually re-trigger analysis for a session that has a fallback report.
 * Runs generateReport + generateAnalytics directly and saves the result
 * (useful when a previous run produced a fallback).
 *
 * Run with:
 *   DATABASE_URL="..." LLM_API_KEY="..." \
 *     node_modules/.bin/tsx --conditions=react-server \
 *     src/scripts/retrigger-analysis.ts <session-id>
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db/index";
import {
  generateReport,
  generateAnalytics,
  isThinTranscript,
} from "../lib/llm/client";
import type { AnalyzeArgs } from "../lib/llm/client";

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("Usage: npx tsx ... src/scripts/retrigger-analysis.ts <session-id>");
  process.exit(1);
}
const sessionId = SESSION_ID as string;

async function main() {
  console.log(`\n🔄 Re-triggering analysis for session: ${sessionId}\n`);

  const [session] = await db
    .select()
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.id, sessionId))
    .limit(1);

  if (!session) { console.error("❌ Session not found"); process.exit(1); }

  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.sessionId, sessionId))
    .limit(1);

  if (!transcript) { console.error("❌ No transcript"); process.exit(1); }

  const artifacts = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.sessionId, sessionId));

  console.log(`Session : ${session.companyName} / ${session.roleTitle} / ${session.roundType}`);
  console.log(`Transcript: ${transcript.wordCount} words`);
  console.log(`Artifacts : ${artifacts.length}\n`);

  const analyzeArgs: AnalyzeArgs = {
    session: {
      companyName: session.companyName,
      roleTitle: session.roleTitle,
      level: session.level as AnalyzeArgs["session"]["level"],
      roundType: session.roundType,
    },
    transcript: {
      redactedText: transcript.redactedText,
      editedText: transcript.editedText,
      wordCount: transcript.wordCount,
      durationSeconds: transcript.durationSeconds,
      fillerWordCount: transcript.fillerWordCount,
    },
    artifacts: artifacts.map((a) => ({
      id: a.id,
      artifactType: a.artifactType,
      content: a.content,
      imageUrl: a.imageUrl,
      displayOrder: a.displayOrder,
      source: a.source as "user_added" | "ai_inferred",
      aiConfidence: a.aiConfidence as "high" | "medium" | "low" | null,
      userConfirmed: a.userConfirmedAt !== null,
    })),
  };

  if (isThinTranscript(analyzeArgs.transcript)) {
    console.error("❌ Transcript is too thin to analyze");
    process.exit(1);
  }

  // Run core + analytics in parallel
  console.log("⚙️  Running core + analytics in parallel...\n");
  const [coreResult, analyticsResult] = await Promise.all([
    generateReport({ ...analyzeArgs, coreOnly: true }),
    generateAnalytics(analyzeArgs),
  ]);

  const mergedReport = {
    ...coreResult.report,
    questionsCovered: analyticsResult.questionsCovered,
    per_question_analytics: analyticsResult.per_question_analytics,
    storyHighlights: [],
  };

  console.log("✅ Analysis succeeded!");
  console.log(`Model   : ${coreResult.modelVersion}`);
  console.log(`Exec    : ${mergedReport.executiveSummary.slice(0, 120)}...`);

  // Confirm before writing
  console.log("\n📝 Saving report to database...");

  await db.insert(schema.reports).values({
    sessionId: sessionId,
    reportJson: mergedReport,
    modelVersion: coreResult.modelVersion,
    rubricVersion: coreResult.rubricVersion,
  });

  console.log("✅ Report saved. The user can now view their session.");
  console.log("   Session URL: https://localhost:3000/sessions/" + sessionId);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
}).finally(() => process.exit(0));
