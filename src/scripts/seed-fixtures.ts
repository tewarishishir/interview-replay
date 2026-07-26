/**
 * Shared fixtures for the local-dev seed.
 *
 * Lives in its own module (rather than inside `seed.ts`) so tests and
 * any future fixture code can import these constants without
 * accidentally executing the seed's `main()` as a side effect of
 * module evaluation. `seed.ts` itself imports from here and is the
 * only place the CLI side effect runs.
 *
 * India-launch seed: realistic Indian name + companies + projects so
 * a dev clone matches the production user's context out of the box.
 */

export const SEED_EMAIL = "demo@interview-replay.local";
export const SEED_PASSWORD = "ir-dev-password-1";
export const SEED_NAME = "Priya Sharma";
export const SEED_CREDITS = 5;

/**
 * Sample sessions to render on the dashboard. The mix is deliberate —
 * one each of complete / analyzing / created so the UI's state-pill
 * colors all show up at once during dev. Names match the
 * `interview_session_state` enum tokens exactly (see
 * `lib/state-machine.ts`).
 *
 * Companies are weighted toward Indian tech with one global name for
 * the FAANG-equivalent interview path that's typical of the audience.
 */
export const sampleSessions = [
  {
    companyName: "Flipkart",
    roleTitle: "Senior Software Engineer",
    level: "senior",
    roundType: "system_design" as const,
    state: "complete" as const,
    daysAgo: 1,
    creditsCharged: 1,
  },
  {
    companyName: "Razorpay",
    roleTitle: "SDE-3",
    level: "staff",
    roundType: "coding" as const,
    state: "complete" as const,
    daysAgo: 5,
    creditsCharged: 2,
  },
  {
    companyName: "Zomato",
    roleTitle: "Senior Product Engineer",
    level: "senior",
    roundType: "behavioral" as const,
    state: "analyzing" as const,
    daysAgo: 0,
    creditsCharged: 1,
  },
  {
    companyName: "Google",
    roleTitle: "Engineering Manager",
    level: "staff",
    roundType: "behavioral" as const,
    state: "created" as const,
    daysAgo: 0,
    creditsCharged: null,
  },
] as const;

/**
 * Sample projects for the seed user's profile. The phrasing mirrors
 * what we'd want a real Indian engineer to write — concrete platform
 * + scope, no fluff — so the AI-coaching flow has realistic content to
 * critique during dev.
 */
export const sampleProjects = [
  {
    title: "UPI checkout integration",
    companyContext: "Flipkart — Payments platform",
    description:
      "Led the team that migrated checkout to UPI-first, cutting payment latency 38% and lifting completion rate 6 pts.",
  },
  {
    title: "Search relevance overhaul",
    companyContext: "Razorpay — Merchant dashboard",
    description:
      'Rebuilt the merchant search ranking on top of an Elastic-backed retrieval layer; reduced "no result" rate from 11% to 2.4%.',
  },
] as const;
