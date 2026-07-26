import { z } from "zod";

/**
 * Central, fail-fast runtime environment validation.
 *
 * - Imported by `@/lib/db` and `@/lib/auth` so a bad env crashes at startup
 *   rather than on first request.
 * - Intentionally NOT imported by marketing pages or the root layout: those
 *   surfaces only touch `process.env.NEXTAUTH_URL` with a safe fallback, so a
 *   marketing-only build still works without a full env.
 *
 * "Optional but paired" rule:
 *   Some integrations (Google OAuth) consist of multiple env vars that
 *   only make sense together. Each is `.optional()` here, but we add a
 *   `.refine()` at the bottom that fails if you set one half of a pair
 *   without the other — much friendlier than discovering this at the
 *   OAuth round-trip.
 */

const PLACEHOLDER_AUTH_SECRETS = new Set([
  "replace-me-with-a-32-byte-random-string",
]);

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required (see .env.example)")
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "DATABASE_URL must be a postgres:// or postgresql:// connection string",
      ),

    AUTH_SECRET: z
      .string()
      .min(
        32,
        "AUTH_SECRET must be at least 32 characters. Generate one with `openssl rand -base64 32`.",
      )
      .refine(
        (v) => !PLACEHOLDER_AUTH_SECRETS.has(v),
        "AUTH_SECRET is still the placeholder from .env.example. Generate a real secret.",
      ),

    NEXTAUTH_URL: z
      .string()
      .url("NEXTAUTH_URL must be a full URL (e.g. http://localhost:3000)")
      .optional(),

    // ── Google OAuth ─────────────────────────────────────────────────────
    // Auth.js v5 conventionally reads these from `AUTH_GOOGLE_ID` /
    // `AUTH_GOOGLE_SECRET` when no provider config is passed. We pass them
    // explicitly anyway (see lib/auth/index.ts) so missing values surface
    // here instead of as a 500 mid-OAuth.
    AUTH_GOOGLE_ID: z.string().min(1).optional(),
    AUTH_GOOGLE_SECRET: z.string().min(1).optional(),

    // ── Rate limiting ─────────────────────────────────────────────────────
    // Rate limiting is in-memory. No external dependencies needed.

    // ── Email (SMTP — optional) ─────────────────────────────────────────
    // SMTP transport. Falls back to console logging when not set.
    // Configured via SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
    // (read directly from process.env in the email client).
    EMAIL_REPLY_TO_GENERAL: z.string().email().optional(),
    EMAIL_REPLY_TO_PRIVACY: z.string().email().optional(),
    EMAIL_REPLY_TO_FEEDBACK: z.string().email().optional(),
    EMAIL_REPLY_TO_FOUNDERS: z.string().email().optional(),

    // ── Local file storage ─────────────────────────────────────────────
    // Path where uploaded files (audio, resumes, exports) are stored.
    // Defaults to `./data/uploads` when not set.
    STORAGE_PATH: z.string().min(1).optional(),
    // Secret used to sign file-access tokens for the storage API.
    // Required in production; generate with `openssl rand -base64 32`.
    STORAGE_SECRET: z.string().min(1).optional(),

    // ── Whisper (speech-to-text) ──────────────────────────────────────────
    // Model size for local faster-whisper transcription (e.g. "base",
    // "small", "medium", "large-v3"). When unset, transcription is
    // disabled and the candidate is prompted to type/paste instead.
    WHISPER_MODEL_SIZE: z.string().min(1).optional(),

    // ── Privacy SLA alerting ─────────────────────────────────────────────
    // Optional webhook the SLA enforcement cron POSTs to when an
    // audio file blew through its deletion deadline by more than an
    // hour. A Slack incoming webhook URL or a PagerDuty Events API v2
    // URL both work; the body is plain JSON so any sink that accepts
    // arbitrary JSON will do. Empty/unset means "log only" — fine for
    // dev, deliberately allowed in prod (logs are still emitted, and
    // the spec doesn't mandate an external hook).
    PRIVACY_SLA_ALERT_WEBHOOK_URL: z.string().url().optional(),

    // ── India-only mode flag ─────────────────────────────────────────────
    // Removed for self-hosted mode. Always defaults to false.
    INDIA_ONLY_MODE: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .default("false"),

    // ── MaxMind GeoIP (optional) ─────────────────────────────────────────
    MAXMIND_GEOIP_DB_PATH: z.string().min(1).optional(),

    // ── Ops alerting ─────────────────────────────────────────────────────
    // Email address that receives internal ops alerts: background job
    // failures, health-check degradation, payment anomalies (chargebacks,
    // hash mismatches), privacy SLA breaches, etc.
    //
    // Set to the founder's personal email so critical failures page
    // immediately without a separate PagerDuty / Slack integration.
    // When unset, alerts fall back to stderr logging (fine for dev).
    ALERT_TO_EMAIL: z.string().email().optional(),

    /**
     * Operator-set monthly infrastructure cost in INR (hosting,
     * storage fees — whatever the operator considers "cost of
     * running this month"). Surfaced on `/admin/health`. Optional;
     * when unset, the card renders a hint instead of a misleading
     * zero.
     */
    MONTHLY_INFRA_COST_INR: z.coerce.number().int().positive().optional(),

    /**
     * DEV-ONLY fallback country / subdivision applied by `geoForIp`
     * when the real lookup returns null. Two scenarios this is
     * for:
     *   1. No MaxMind `.mmdb` installed in dev — contributors
     *      shouldn't have to download a 6MB DB just to demo the
     *      admin Users surface.
     *   2. Local browser requests come in with `unknown-ip` /
     *      `127.0.0.1`, which the reserved-IP gate short-circuits.
     *
     * IGNORED in production (`NODE_ENV=production`) so a fake
     * stamp can never leak into real analytics. Set in
     * `.env.local` only, e.g. `DEV_GEO_FALLBACK_COUNTRY=IN` /
     * `DEV_GEO_FALLBACK_SUBDIVISION=MH`. Both are passed through
     * verbatim — no length / format validation, since the
     * upstream MaxMind ISO codes vary in length (2 chars for
     * country, 1-3 for subdivision).
     */
    DEV_GEO_FALLBACK_COUNTRY: z.string().min(1).max(8).optional(),
    DEV_GEO_FALLBACK_SUBDIVISION: z.string().min(1).max(8).optional(),

    // Shared secret for the admin geography endpoint. Sent as the
    // `x-ir-admin-key` header. Not a high-security gate — this
    // is a manual-tooling endpoint, not a write surface — but enough
    // to keep casual probes from enumerating signup geography.
    ADMIN_API_KEY: z.string().min(32).optional(),

    // ── Ollama (local LLM inference) ──────────────────────────────────────
    // Base URL for the Ollama OpenAI-compatible API. Defaults to
    // http://localhost:11434/v1 when not set.
    OLLAMA_BASE_URL: z.string().url().optional(),
    // API key for the LLM backend. Ollama ignores this but other
    // OpenAI-compatible backends may require a real key.
    LLM_API_KEY: z.string().min(1).optional(),
    // Model names for the large (analysis) and small (inference) tiers.
    // Defaults: llama3.3:70b and llama3.3:8b.
    LLM_MODEL_LARGE: z.string().min(1).optional(),
    LLM_MODEL_SMALL: z.string().min(1).optional(),

    // ── Deployment environment ───────────────────────────────────────────
    // Explicit override so staging can share an env-var set with
    // production while still bypassing prod-only validations.
    APP_ENV: z.string().optional(),

    // ── Trusted proxy hops ───────────────────────────────────────────────
    // How many proxies sit between the client and this app. We use this
    // to pick the right entry from `x-forwarded-for` for rate-limit and
    // audit-log IP attribution.
    //
    // Default 0 = "trust nothing": we ignore XFF entirely and use the
    // single-IP `x-real-ip` (or fall back to `unknown-ip`). That is the
    // safe default — if you don't tell us how many hops to skip, an
    // attacker can rotate `X-Forwarded-For: <whatever>` per request and
    // bypass per-IP rate limits.
    //
    // Behind one proxy that prepends the real client IP (reverse proxy,
    // Cloudflare, most reverse proxies) set this to 1. Behind two
    // (Cloudflare → load balancer → app) set it to 2. The Nth-from-end
    // entry is what we'll use, since trusted proxies append on the way
    // in but the client-supplied prefix is untrusted.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    // ── Closed-beta gate ────────────────────────────────────────────────
    // When `true`, the public signup route 404s, the signup server
    // action rejects, the Google provider is disabled, and marketing
    // CTAs swap from "Sign up" to "Sign in". Existing seeded credentials
    // accounts can still sign in normally. Flip back to `false` (or
    // unset) to re-open public signup with no code change.
    //
    // Accepts the strings "true", "1", or "yes" (case-insensitive) as
    // truthy; everything else (including unset) is false.
    INVITE_ONLY_BETA: z
      .string()
      .optional()
      .transform((v) => {
        if (!v) return false;
        const norm = v.trim().toLowerCase();
        return norm === "true" || norm === "1" || norm === "yes";
      }),
  })
  .refine(
    (v) =>
      Boolean(v.AUTH_GOOGLE_ID) === Boolean(v.AUTH_GOOGLE_SECRET),
    {
      message:
        "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set together " +
        "(or both unset to disable Google sign-in).",
      path: ["AUTH_GOOGLE_ID"],
    },
  )
  
  .refine(
    (v) => v.NODE_ENV !== "production" || Boolean(v.NEXTAUTH_URL),
    {
      message:
        "NEXTAUTH_URL is required in production (e.g. https://interview-replay.example.com)",
      path: ["NEXTAUTH_URL"],
    },
  )
  .refine(
    (v) => v.NODE_ENV !== "production" || Boolean(v.STORAGE_SECRET),
    {
      message: "STORAGE_SECRET is required in production for signed file URLs.",
      path: ["STORAGE_SECRET"],
    },
  );

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => ` - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");

  // During `next build` (NEXT_PHASE=phase-production-build) Next.js performs
  // static analysis of every route module to collect metadata (exports,
  // dynamic/static markers, etc.). Route *handlers* are never actually invoked
  // in this phase, so missing env vars are non-fatal: the module can be loaded
  // safely and any runtime call that reaches a missing var will fail loudly.
  //
  // This lets CI/preview builds (which may not carry all env vars) pass the
  // build step. The actual production deployment always runs with all vars
  // present and will throw at startup if any are missing.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    console.warn(
      `[env] Incomplete environment variables during build (non-fatal):\n${issues}\n\n` +
        "Ensure all required vars are set in the deployment environment.",
    );
  } else {
    throw new Error(
      `Invalid environment variables:\n${issues}\n\n` +
        "Copy .env.example to .env.local and fill in real values.",
    );
  }
}

export const env: Env = (parsed.data ?? {}) as Env;

export const isProduction = env.NODE_ENV === "production";

/**
 * Feature flags derived from env presence. Use these instead of repeatedly
 * checking `env.X !== undefined` so the call sites read like product
 * statements ("if Google sign-in is enabled, render the button").
 */
export const features = {
  inviteOnlyBeta: env.INVITE_ONLY_BETA,
  googleAuth:
    Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) &&
    !env.INVITE_ONLY_BETA,
  rateLimiting: true as const,
  /** Email is available when SMTP is configured. */
  email: Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT),
  audioStorage: true as const,
  transcription: Boolean(env.WHISPER_MODEL_SIZE),
  privacySlaWebhook: Boolean(env.PRIVACY_SLA_ALERT_WEBHOOK_URL),
  /** Billing is disabled in self-hosted mode — the app is free. */
  billing: false as const,
  /** India-only restrictions removed for global self-hosted use. */
  indiaOnly: false as const,
  /** GeoIP is optional. */
  geoIp: Boolean(env.MAXMIND_GEOIP_DB_PATH),
  llmAnalysis: Boolean(env.OLLAMA_BASE_URL || env.LLM_API_KEY),
} as const;
