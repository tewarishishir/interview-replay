/**
 * Diagnose a failing analysis session by running generateReport directly
 * against the session's transcript and artifacts.
 *
 * Run with:
 *   DATABASE_URL="..." npx tsx src/scripts/diagnose-session.ts <session-id>
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../lib/db/index";
import { generateReport, flatReportForForbiddenCheck } from "../lib/llm/client";
import { findForbiddenLanguage } from "../lib/llm/forbidden";

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("Usage: npx tsx src/scripts/diagnose-session.ts <session-id>");
  process.exit(1);
}
const sessionId = SESSION_ID as string;

async function main() {
  console.log(`\n🔍 Diagnosing session: ${sessionId}\n`);

  // 1. Fetch session
  const [session] = await db
    .select()
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.id, sessionId))
    .limit(1);

  if (!session) {
    console.error("❌ Session not found");
    process.exit(1);
  }
  console.log(`Session: ${session.companyName} / ${session.roleTitle} / ${session.roundType} / ${session.state}`);

  // 2. Fetch transcript
  const [transcript] = await db
    .select()
    .from(schema.transcripts)
    .where(eq(schema.transcripts.sessionId, sessionId))
    .limit(1);

  if (!transcript) {
    console.error("❌ No transcript found");
    process.exit(1);
  }
  console.log(`Transcript: ${transcript.wordCount} words, ${transcript.durationSeconds}s, ${transcript.redactedText.length} chars`);

  // 3. Fetch artifacts
  const artifacts = await db
    .select()
    .from(schema.artifacts)
    .where(eq(schema.artifacts.sessionId, sessionId));
  console.log(`Artifacts: ${artifacts.length} items`);

  // 4. Build analyzeArgs
  const analyzeArgs = {
    session: {
      companyName: session.companyName,
      roleTitle: session.roleTitle,
      level: session.level as "junior" | "mid" | "senior" | "staff" | "principal" | "unsure",
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
  } as const;

  // 5. Run generateReport with coreOnly=true
  console.log("\n⚙️  Running generateReport (coreOnly=true)...\n");
  try {
    const result = await generateReport({ ...analyzeArgs, coreOnly: true });
    console.log("✅ generateReport succeeded!");
    console.log(`Model: ${result.modelVersion}`);
    console.log(`executiveSummary (first 200): ${result.report.executiveSummary.slice(0, 200)}`);
    console.log(`aiRead (first 200): ${result.report.aiRead.paragraph.slice(0, 200)}`);
    console.log(`roundSpecific.kind: ${result.report.roundSpecific.kind}`);
    
    // Check forbidden language on the successful result
    const flat = flatReportForForbiddenCheck(result.report);
    const hits = findForbiddenLanguage(flat);
    if (hits.length > 0) {
      console.warn(`\n⚠️  Forbidden language hits (would have triggered retry):`);
      hits.forEach(h => console.warn(`  Pattern: ${h.pattern}\n  Excerpt: "${h.excerpt}"`));
    } else {
      console.log("✅ No forbidden language hits");
    }
  } catch (err: unknown) {
    console.error("❌ generateReport FAILED:");
    if (err instanceof Error) {
      console.error(`  Error type: ${err.constructor.name}`);
      console.error(`  Message: ${err.message}`);
    } else {
      console.error(err);
    }
  }
}

main().catch(console.error).finally(() => process.exit(0));
