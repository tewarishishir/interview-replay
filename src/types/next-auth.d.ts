import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  /**
   * Auth.js augments `Session["user"]` with our DB user id so server
   * components and server actions can do `session.user.id` without
   * optional-chaining every time.
   */
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub?: string;
  }
}
