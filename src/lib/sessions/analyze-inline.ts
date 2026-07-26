import "server-only";

import { sendAnalysisReadyEmail } from "@/lib/email";
import { features } from "@/lib/env";
import {
  type AnalyzeArgs,
  buildFallbackReport,
  buildPlaceholderReport,
  FALLBACK_MODEL_VERSION_PREFIX,
  generateReport,
  isThinTranscript,
  LlmNotConfiguredError,
  LlmValidationError,
} from "@/lib/llm";
import {
  AnalysisInputsNotFoundError,
  loadAnalysisInputs,
  persistReportAndComplete,
  recordAnalysisFailure,
  recordFallbackRefund,
} from "./analyze";

/**
 * In-process analyze pipeline. Runs the full analysis flow inline:
 * load inputs → generate report → persist + advance → email.
 *
 * Lives in its own file so importing it dynamically from the route
 * keeps heavy LLM SDK deps out of the main request bundle until
 * actually needed.
 *
 * Error contract:
 *   - On success: returns `{ reportId, modelVersion, rubricVersion }`,
 *     session state is `complete`, credits stay debited.
 *   - On failure: throws. Before throwing, BEST-EFFORT calls
 *     `recordAnalysisFailure(...)` which atomically (a) flips the
 *     session to `failed`, (b) refunds the charged credits if this
 *     wasn't a free re-analysis, and (c) writes the audit row.
 */
export async function runAnalyzeInline(args: {
  sessionId: string;
  userId: string;
  isFreeReanalysis: boolean;
  creditsCharged: number;
}): Promise<{
  reportId: string;
  modelVersion: string;
  rubricVersion: string;
}> {
  // Elapsed-time tracker. Each phase is logged with a delta so a
  // dev hitting "analyze is slow" can see whether the time is in
  // input loading (DB), the LLM call (`generateReport` logs its
  // own line), persistence, or the email send. Without these
  // markers the inline path is silent for the duration of the
  // run and the only signal the operator gets is "report eventually
  // appeared" — useless for performance triage.
  const inlineStart = Date.now();
  const phaseLog = (phase: string, extra: string = "") => {
    console.warn(
      `[runAnalyzeInline] phase=${phase} session=${args.sessionId} ` +
        `elapsed_ms=${Date.now() - inlineStart}${extra ? " " + extra : ""}`,
    );
  };

  try {
    phaseLog("start");
    const inputs = await loadAnalysisInputs({
      sessionId: args.sessionId,
      userId: args.userId,
    });
    phaseLog("inputs_loaded");

    // The route already gated on this, but a re-fire path could
    // slip through.
    if (inputs.transcript.transcriptionError) {
      throw new Error(
        `analyze-inline: transcript has a transcription_error for session ${args.sessionId}`,
      );
    }

    const analyzeArgs: AnalyzeArgs = {
      session: {
        companyName: inputs.session.companyName,
        roleTitle: inputs.session.roleTitle,
        level: inputs.session.level,
        roundType: inputs.session.roundType,
      },
      transcript: inputs.transcript,
      artifacts: inputs.artifacts.map((a) => ({
        artifactType: a.artifactType as
          | "code"
          | "whiteboard_image"
          | "diagram"
          | "notes"
          | "link"
          | "question"
          | "design_text"
          | "design_image"
          | "other_note",
        content: a.content,
        imageUrl: a.imageUrl,
        displayOrder: a.displayOrder,
      })),
    };

    // Bulletproofing layers: same short-circuit rules, same
    // fallback semantics, same refund posture.
    let generated;
    if (isThinTranscript(inputs.transcript)) {
      // Layer 1: thin transcript. Skip the LLM call entirely.
      generated = buildFallbackReport(analyzeArgs, "thin_transcript");
    } else if (!features.llmAnalysis) {
      // Dev path without LLM configured.
      generated = buildPlaceholderReport(analyzeArgs);
    } else {
      try {
        generated = await generateReport(analyzeArgs);
      } catch (err) {
        // Layer 3: permanent LLM-side failures fall back to a
        // graceful report rather than throwing through to the
        // refund-and-fail catch. Transient errors (network /
        // rate-limit / 5xx) still bubble — the inline path
        // doesn't have an automatic retry budget, but the
        // caller (the analyze route's catch fallback) is itself
        // a one-shot retry already.
        if (err instanceof LlmValidationError) {
          console.error(
            `[runAnalyzeInline] LlmValidationError for session ${args.sessionId}; falling back:`,
            err.message,
          );
          generated = buildFallbackReport(analyzeArgs, "llm_validation_failed");
        } else if (err instanceof LlmNotConfiguredError) {
          console.error(
            `[runAnalyzeInline] LlmNotConfiguredError for session ${args.sessionId}; falling back:`,
            err.message,
          );
          generated = buildFallbackReport(analyzeArgs, "llm_unavailable");
        } else {
          throw err;
        }
      }
    }

    phaseLog(
      "report_generated",
      `model_version=${generated.modelVersion}`,
    );

    const persisted = await persistReportAndComplete({
      sessionId: inputs.session.id,
      userId: inputs.session.userId,
      report: generated.report,
      modelVersion: generated.modelVersion,
      rubricVersion: generated.rubricVersion,
    });
    phaseLog("report_persisted", `report_id=${persisted.reportId}`);

    // Fallback refund: the session is already in `complete` by
    // this point; we only touch credits + audit.
    if (generated.modelVersion.startsWith(FALLBACK_MODEL_VERSION_PREFIX)) {
      const refund = args.isFreeReanalysis ? 0 : args.creditsCharged;
      try {
        await recordFallbackRefund({
          sessionId: inputs.session.id,
          userId: inputs.session.userId,
          creditsToRefund: refund,
          fallbackReason: generated.modelVersion.slice(
            FALLBACK_MODEL_VERSION_PREFIX.length,
          ),
        });
      } catch (refundErr) {
        // The report is already persisted and the session is in
        // `complete`. A failed refund means an operator has to
        // adjust the user's balance by hand — log loudly with
        // the IDs they'll need.
        console.error(
          `[runAnalyzeInline] recordFallbackRefund threw for session=${args.sessionId} user=${args.userId} credits=${refund}:`,
          refundErr,
        );
      }
    }

    // Best-effort email. A failed Resend dispatch only logs — the
    // candidate sees the report on the dashboard regardless.
    try {
      await sendAnalysisReadyEmail({
        to: inputs.userEmail,
        sessionId: inputs.session.id,
        companyName: inputs.session.companyName,
        roleTitle: inputs.session.roleTitle,
      });
    } catch (emailErr) {
      console.error("[runAnalyzeInline] email send failed:", emailErr);
    }
    phaseLog("done");

    return {
      reportId: persisted.reportId,
      modelVersion: generated.modelVersion,
      rubricVersion: generated.rubricVersion,
    };
  } catch (err) {
    // On failure: ensure the system is left in a sane state.
    //
    // Rescue (layer 4): if we got far enough that
    // `loadAnalysisInputs` succeeded but the LLM call/persist
    // failed for an unexpected reason (DB blip on report insert,
    // etc.), try ONE last fallback persistence so the user ends
    // up with a "complete" session showing a degraded report
    // instead of the failed panel. Skipped when the original
    // error is `AnalysisInputsNotFoundError` (the row is gone;
    // there's nothing to write to).
    const refund = args.isFreeReanalysis ? 0 : args.creditsCharged;
    const message =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : "analysis_failed";

    // Log loudly so the "analyze is slow and ends in a Retry" path
    // is no longer a silent fallback. Includes elapsed_ms since
    // inline start so the operator can see whether we burned
    // minutes in the LLM call or failed fast somewhere else.
    console.error(
      `[runAnalyzeInline] caught error session=${args.sessionId} ` +
        `elapsed_ms=${Date.now() - inlineStart} ` +
        `error=${message}`,
    );

    if (!(err instanceof AnalysisInputsNotFoundError)) {
      try {
        const rescueInputs = await loadAnalysisInputs({
          sessionId: args.sessionId,
          userId: args.userId,
        });
        if (!rescueInputs.transcript.transcriptionError) {
          const rescueArgs: AnalyzeArgs = {
            session: {
              companyName: rescueInputs.session.companyName,
              roleTitle: rescueInputs.session.roleTitle,
              level: rescueInputs.session.level,
              roundType: rescueInputs.session.roundType,
            },
            transcript: rescueInputs.transcript,
            artifacts: [],
          };
          const rescue = buildFallbackReport(rescueArgs, "llm_error");
          const persisted = await persistReportAndComplete({
            sessionId: rescueInputs.session.id,
            userId: rescueInputs.session.userId,
            report: rescue.report,
            modelVersion: rescue.modelVersion,
            rubricVersion: rescue.rubricVersion,
          });
          try {
            await recordFallbackRefund({
              sessionId: rescueInputs.session.id,
              userId: rescueInputs.session.userId,
              creditsToRefund: refund,
              fallbackReason: `inline_rescue:${message}`,
            });
          } catch (refundErr) {
            console.error(
              `[runAnalyzeInline] rescue refund threw for session=${args.sessionId}:`,
              refundErr,
            );
          }
          return {
            reportId: persisted.reportId,
            modelVersion: rescue.modelVersion,
            rubricVersion: rescue.rubricVersion,
          };
        }
      } catch (rescueErr) {
        // Rescue itself failed (e.g. report INSERT also threw,
        // or load returned `transcription_error`). Fall through
        // to the standard failed-panel path.
        console.error(
          `[runAnalyzeInline] inline rescue threw for session=${args.sessionId}:`,
          rescueErr,
        );
      }
    }

    try {
      await recordAnalysisFailure({
        sessionId: args.sessionId,
        userId: args.userId,
        errorMessage: message,
        creditsToRefund: refund,
      });
    } catch (failureErr) {
      // Last-ditch: the failure-recording transaction itself blew
      // up. We log loudly with all the IDs needed to repair by
      // hand, and rethrow the original error. The caller's
      // defense-in-depth rollback will then attempt its own
      // refund — it's a CAS on the same state guard, so a double-
      // refund is impossible even though we're trying twice.
      console.error(
        `[runAnalyzeInline] recordAnalysisFailure threw for session=${args.sessionId} user=${args.userId} credits=${refund}:`,
        failureErr,
      );
    }

    // Re-throw a sentinel-typed error so the route can map it to
    // a clear user message. We deliberately DO NOT swallow — the
    // caller needs to know analysis didn't actually succeed.
    if (err instanceof AnalysisInputsNotFoundError) throw err;
    if (err instanceof LlmValidationError) throw err;
    if (err instanceof Error) throw err;
    throw new Error(message);
  }
}
