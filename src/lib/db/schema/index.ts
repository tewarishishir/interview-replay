/**
 * Single barrel for the Drizzle schema. Consumers should import from
 * `@/lib/db` (which re-exports `schema`) rather than reaching into a
 * specific file — that keeps the call sites stable if a table moves
 * between files later.
 *
 * NOTE for the Auth.js adapter: `sessions` is intentionally aliased to
 * `authSessions` so it doesn't shadow our domain-level
 * `interview_sessions` table when callers do `schema.sessions`.
 */
export * from "./users";
export * from "./interviews";
export * from "./audit";
export * from "./compliance";
export * from "./profiles";
export * from "./outcomes";
export * from "./rebuilds";
export * from "./feedback";
