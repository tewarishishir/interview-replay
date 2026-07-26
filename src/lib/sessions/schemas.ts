import { z } from "zod";

import {
  interviewLevelSchema,
  interviewRoundTypeSchema,
} from "@/lib/db/schema";
import type { interviewLevels } from "@/lib/db/schema";

/**
 * Zod schemas shared between the `/sessions/new` form, the
 * `/api/sessions` POST handler, and the tests.
 *
 * One module → one source of truth. If you change a constraint here,
 * the form's inline error message, the API's 400 response, and the
 * test assertions all update in lockstep with no manual sync.
 */

/**
 * Stable display labels for the level radio group. Centralized so the
 * UI and the tests render the same casing/wording. The DB stores the
 * lowercase token (the `value`), the UI shows `label`.
 */
export const LEVEL_OPTIONS = [
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
  { value: "unsure", label: "Not sure" },
] as const satisfies ReadonlyArray<{
  value: (typeof interviewLevels)[number];
  label: string;
}>;

export const ROUND_TYPE_OPTIONS = [
  { value: "coding", label: "Coding" },
  { value: "system_design", label: "System design" },
  { value: "behavioral", label: "Behavioral" },
  { value: "other", label: "Other" },
] as const;

const COMPANY_MAX = 200;
const ROLE_MAX = 200;

/**
 * Characters we strip on the way in. The list is the union of
 * three concerns:
 *
 *   1. NUL byte (`\u0000`). Postgres `text` rejects it at insert
 *      time with a generic 5xx — we'd rather flunk it as a clean
 *      400 here than pay for the stack trace.
 *   2. C0 / C1 control characters (everything below U+0020 except
 *      tab/newline/carriage-return, plus DEL and the C1 range).
 *      They serve no purpose in a company / role name and break
 *      log readability.
 *   3. Bidi overrides + zero-width characters (U+200B-U+200F,
 *      U+202A-U+202E, U+2066-U+2069, U+FEFF). These are the
 *      classic "trojan source" / display-spoof primitives. A
 *      candidate's company name is a label, not a place those
 *      should ever appear.
 *
 * After stripping we also collapse internal whitespace so a
 * candidate who pastes from a job board doesn't fail validation on
 * an invisible double-space.
 */
const STRIP_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const cleanedString = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(STRIP_CHARS, "").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(max));

/**
 * Step 1 — interview metadata. Everything here is required except
 * `scheduledAt`. The form's "Continue" button gates on this schema's
 * validity, so messages here are user-facing.
 */
export const sessionMetadataSchema = z.object({
  companyName: cleanedString(COMPANY_MAX).meta({
    description: "Company you're interviewing with.",
  }),
  roleTitle: cleanedString(ROLE_MAX),
  level: interviewLevelSchema,
  roundType: interviewRoundTypeSchema,
  /**
   * `coerce.date` so the form can submit ISO strings (HTML
   * `datetime-local` inputs) and the API can accept JSON-encoded
   * dates without a custom transform on each side.
   *
   * Optional and nullable — the candidate may not know the exact time
   * yet, and we shouldn't block session creation on that. The
   * preprocess collapses an empty `<input>` value (the form's
   * "untouched" state) and the JSON literal `null` into `null` so
   * the downstream coerce never sees a malformed date string.
   *
   * Range: we accept anything from one year in the past (so a
   * candidate logging a session after the fact still works) up to
   * two years in the future (interview scheduling rarely runs longer
   * than a quarter; two years is generous and bounds the column).
   * Anything outside is almost certainly a bug or paste error and
   * gets rejected with a friendly message rather than silently
   * landing as `9999-12-31` in Postgres.
   */
  scheduledAt: z
    .preprocess(
      // Collapse the form's "untouched" representations into null so
      // the union below short-circuits on `z.null()` and never hits
      // `coerce.date()` with a falsy input — `new Date(null)` would
      // happily coerce to 1970-01-01, which would silently corrupt
      // the UI's "no scheduled time" state.
      (v) => {
        if (v === "" || v === undefined || v === null) return null;
        return v;
      },
      z.union([
        z.null(),
        z.coerce
          .date()
          .refine(
            (d) => {
              const now = Date.now();
              const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
              const twoYearsFromNow = now + 2 * 365 * 24 * 60 * 60 * 1000;
              const t = d.getTime();
              return t >= oneYearAgo && t <= twoYearsFromNow;
            },
            "Scheduled date must be within the last year or the next two years.",
          ),
      ]),
    )
    .optional(),
});

export type SessionMetadataInput = z.input<typeof sessionMetadataSchema>;
export type SessionMetadataOutput = z.output<typeof sessionMetadataSchema>;

/**
 * Step 2 — the consent gate.
 *
 * `consent_affirmed` is a single boolean on the wire (matching the
 * spec's literal phrasing) and MUST be exactly `true`. The API rejects
 * any other value with 400, and we mirror that here so the form
 * surfaces the same error.
 *
 * The two checkboxes are individually tracked too — if a future
 * audit asks "which clauses did the user agree to?", we can answer
 * from the form payload alone, even though right now we collapse them
 * into one boolean for the DB write.
 */
export const consentSchema = z.object({
  headphones: z.literal(true, {
    error: "Confirm headphones or a private space before continuing.",
  }),
  doNotClose: z.literal(true, {
    error: "Confirm you'll keep this tab open during the interview.",
  }),
});

export type ConsentInput = z.input<typeof consentSchema>;

/**
 * Wire shape for the API. The form composes step1 + step2 into this
 * before POSTing. The literal `true` on `consentAffirmed` is the
 * teeth: any client that submits `false`, omits it, or coerces a
 * non-boolean gets 400 with no DB write.
 */
export const createSessionPayloadSchema = sessionMetadataSchema.extend({
  consentAffirmed: z.literal(true, {
    error: "Consent must be affirmed.",
  }),
});

export type CreateSessionPayload = z.input<typeof createSessionPayloadSchema>;
