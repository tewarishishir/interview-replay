import "server-only";

export { sendEmail, type SendEmailArgs, type SendEmailResult } from "./client";
export { sendAlertEmail } from "./alerts";
export {
  sendAnalysisReadyEmail,
  sendWelcomeEmail,
  sendTranscriptionCompleteEmail,
  sendAccountDeletionInitiatedEmail,
  sendAccountDeletionFinalEmail,
  sendOutcomeReminderEmail,
  sendContactSubmissionEmail,
} from "./templates";
