/**
 * Auth-related constants safe to import from any runtime (RSC, client,
 * edge, tests). Lives in its own file so the schemas / forms can pull
 * `MIN_PASSWORD_LENGTH` without dragging in `@node-rs/argon2` (which
 * has Node-only native bindings) through `password.ts`.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
