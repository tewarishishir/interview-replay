import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe base Auth.js v5 config.
 *
 * This file MUST NOT import anything from `@/lib/db`, `@node-rs/argon2`, or
 * any other Node-only module, because it's consumed by `middleware.ts`,
 * which runs on the edge runtime. Full config (adapter + Credentials
 * provider + DB lookups) lives in `./index.ts`.
 */
export const authConfig = {
  // Behind a proxy in production (behind a reverse proxy) Auth.js v5 rejects
  // requests unless the host is trusted explicitly.
  trustHost: true,

  session: { strategy: "jwt" },

  pages: {
    signIn: "/signin",
  },

  // Providers are filled in by `./index.ts` — middleware only needs to
  // decode the JWT, not authenticate.
  providers: [],

  callbacks: {
    // NOTE: we deliberately don't define an `authorized` callback here.
    // If we did, it would short-circuit the custom `middleware.ts` handler
    // that preserves `callbackUrl` on redirect. Edge-runtime session
    // validation is handled in `middleware.ts` directly.

    jwt: ({ token, user }) => {
      // On initial sign-in, persist the DB user id on the token.
      if (user?.id && typeof user.id === "string") {
        token.sub = user.id;
      }
      return token;
    },

    session: ({ session, token }) => {
      // Defensive: if `sub` ever comes back missing, return a neutered
      // session rather than leaking an undefined id downstream.
      if (!token.sub) {
        return { ...session, user: undefined as never };
      }
      if (session.user) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
