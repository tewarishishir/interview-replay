import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge auth gate for the authenticated app surface.
 *
 * The matcher below enumerates every public URL that lives inside the
 * `(app)` route group — `(app)` is purely a layout-scoping construct and
 * does not appear in URLs, so we list its children explicitly. As new
 * authenticated routes land, add them here AND remember the
 * `(app)/layout.tsx` server-side check still re-validates the session.
 *
 * We decode the JWT directly via `getToken` (edge-safe, no DB) rather
 * than the `auth()` wrapper from Auth.js v5, because the wrapper
 * intercepts and redirects on its own before our handler can run —
 * which would lose `callbackUrl`. Auth.js requires the JWT session
 * strategy with the Credentials provider, so reading the JWT directly
 * is the only stable edge check.
 *
 * Defense in depth: `src/app/(app)/layout.tsx` re-runs `auth()` and
 * verifies the user still exists in the DB on every request.
 */
export default async function middleware(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  });

  if (token?.sub) {
    // Forward the requested path to the (app) layout so its
    // revocation-redirect can preserve `callbackUrl` too. The header
    // is read via `next/headers` in the layout.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(
      "x-ir-pathname",
      req.nextUrl.pathname + req.nextUrl.search,
    );
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const signInUrl = new URL("/signin", req.nextUrl);
  signInUrl.searchParams.set(
    "callbackUrl",
    req.nextUrl.pathname + req.nextUrl.search,
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/sessions/:path*",
    "/account/:path*",
    "/profile/:path*",
  ],
};
