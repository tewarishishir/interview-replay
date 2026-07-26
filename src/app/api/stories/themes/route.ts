import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import {
  STORY_FIELD_WORD_TARGETS,
  STORY_THEMES,
} from "@/lib/profiles/themes";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * `GET /api/stories/themes`
 *
 * Static list of pre-defined behavioral story themes + the
 * suggested word counts for each STAR field. The frontend renders
 * a placeholder card per theme even when the user has no story
 * for it, so the canonical list lives here on the server.
 *
 * Authenticated to keep the surface area uniform with the rest of
 * `/api/profile/*`; the contents aren't sensitive but a 401 here
 * keeps probing tools out.
 */

export async function GET(): Promise<Response> {
  const h = await headers();
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

  return NextResponse.json(
    {
      themes: STORY_THEMES.map((t) => ({
        value: t.value,
        label: t.label,
        hint: t.hint,
      })),
      fieldWordTargets: STORY_FIELD_WORD_TARGETS,
    },
    { status: 200 },
  );
}
