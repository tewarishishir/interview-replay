import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { isSameOrigin } from "@/lib/same-origin";
import {
  THEME_COOKIE_MAX_AGE_SECONDS,
  THEME_COOKIE_NAME,
  type ThemePreference,
} from "@/lib/theme/types";

/**
 * POST /api/users/me/theme — persist the user's theme preference.
 *
 * Auth required. Body: { theme: 'light' | 'dark' | 'system' }.
 *
 * Side effects:
 *   1. Updates `users.theme_preference`.
 *   2. Sets the `ir-theme` cookie so the SSR resolver in the
 *      root layout reads the latest value on the next request
 *      without re-hitting the DB.
 *
 * The cookie is set for ALL successful writes (not just sign-in)
 * because the resolver consults the cookie first; if we only set
 * it on initial signup, a returning user changing themes would
 * keep getting their old value on SSR until the cookie expired.
 *
 * Anonymous users get 401 (the cookie path on its own would let
 * an unauthenticated client write arbitrary cookies, which isn't
 * useful — anonymous theme is purely a client-side concern handled
 * by the provider's local cookie write).
 */

const BodySchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
});

export async function POST(request: Request): Promise<Response> {
  const h = await headers();

  // CSRF defense — every state-changing endpoint in this codebase
  // gates on `isSameOrigin`. A cross-origin POST forging the auth
  // cookie would otherwise be able to flip a victim's theme.
  // Low-impact, but consistent with the rest of the API.
  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // Parse + validate the body. We accept JSON only; a malformed
  // payload becomes a 400 rather than a 500 with a JSON parse stack.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message:
          "theme must be one of 'light', 'dark', or 'system'.",
      },
      { status: 400 },
    );
  }

  const theme: ThemePreference = parsed.data.theme;

  try {
    await db
      .update(schema.users)
      .set({ themePreference: theme, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  } catch (err) {
    console.error("[POST /api/users/me/theme] DB update failed:", err);
    return NextResponse.json(
      {
        error: "internal_error",
        message: "Could not save your theme. Please try again.",
      },
      { status: 500 },
    );
  }

  // Set the SSR resolution cookie. We set this server-side (rather
  // than relying on the client) so a fresh tab opened immediately
  // after the change picks up the value on its first SSR pass.
  const isSecure = new URL(request.url).protocol === "https:";
  const cookieStore = await cookies();
  cookieStore.set({
    name: THEME_COOKIE_NAME,
    value: theme,
    maxAge: THEME_COOKIE_MAX_AGE_SECONDS,
    httpOnly: false, // The client provider reads it too for cross-tab sync.
    sameSite: "lax",
    secure: isSecure,
    path: "/",
  });

  return NextResponse.json(
    { theme },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
