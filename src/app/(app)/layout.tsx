import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth } from "@/lib/auth";
import { features } from "@/lib/env";
import { getDashboardUser } from "@/lib/queries/sessions";
import { sanitizeCallback } from "@/lib/safe-redirect";
import { AppHeader } from "@/components/app/app-header";
import { FeedbackWidget } from "@/components/app/feedback-widget";

/**
 * Returns the originally requested path (so the sign-in page can
 * round-trip the user back after re-auth). The middleware sets
 * `x-ir-pathname` for authenticated traffic; we sanitize it
 * through the same helper that scrubs `?callbackUrl=` so a forged
 * header can never become an open-redirect.
 */
async function requestedPath(): Promise<string> {
  const h = await headers();
  return sanitizeCallback(h.get("x-ir-pathname"));
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Middleware already blocks unauthenticated traffic; this is defense
  // in depth (middleware misconfigurations, matcher drift) and also
  // where we do the DB revocation check, which is not edge-safe.
  const session = await auth();
  if (!session?.user?.id) {
    const cb = await requestedPath();
    redirect(`/signin?callbackUrl=${encodeURIComponent(cb)}`);
  }

  // Revocation: the JWT is stateless, so a deleted/disabled user would
  // otherwise keep access until expiry. One small index lookup per
  // request closes that gap; it also doubles as the source for the
  // header's display name + credit balance, so we'd be hitting the
  // table either way.
  //
  // Note: we used to redirect to `/signin?reason=revoked` for a
  // distinct banner, but that param was user-controllable and so
  // forgeable. The signin page now shows a generic "please sign in"
  // notice for any redirect with a callbackUrl — same UX, no forge
  // surface. Server Components in Next 15 can't set cookies, which
  // ruled out the cleaner cookie-flash approach.
  const user = await getDashboardUser(session.user.id);
  if (!user) {
    const cb = await requestedPath();
    redirect(`/signin?callbackUrl=${encodeURIComponent(cb)}`);
  }

  // Email-verification gate. We enforce only when the email feature
  // is actually wired up (`features.email` reflects RESEND_API_KEY +
  // EMAIL_FROM presence). Without that, no verification email is
  // dispatched, so blocking unverified users would lock everyone out
  // — that's why this is a feature flag, not an unconditional gate.
  // Once Resend ships, set those env vars and this clause activates
  // with no further code change.
  //
  // Signed-in but unverified users go to `/verify-email-required`
  // (NOT `/signin`) — they're already authenticated; the right UX
  // is a dedicated "check your inbox" page with a resend button,
  // not bouncing them back to a sign-in form they'd just complete
  // again and loop on.
  if (features.email && user.emailVerified == null) {
    redirect("/verify-email-required");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        user={{
          name: user.name,
          email: user.email,
          imageUrl: user.imageUrl,
        }}
        creditBalance={user.creditBalance}
        rebuildCritiqueUnits={user.rebuildCritiqueUnits}
      />
      <main className="flex-1">{children}</main>
      <FeedbackWidget userId={user.id} />
    </div>
  );
}
