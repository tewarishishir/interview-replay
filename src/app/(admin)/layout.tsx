import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getAdminUser } from "@/lib/admin/auth";
import { recordAdminPageView } from "@/lib/admin/audit";
import { AdminSidebar } from "@/components/admin/sidebar";
import { FeedbackWidget } from "@/components/app/feedback-widget";

/**
 * Server layout for the `(admin)` route group.
 *
 * Gate order (each step is load-bearing):
 *   1. Middleware (`src/middleware.ts`) handles the auth check —
 *      anonymous traffic to `/admin/*` is redirected to /signin
 *      with the original URL in `callbackUrl`.
 *
 *   2. THIS layout checks `users.is_admin` on every request via
 *      `getAdminUser()`. A non-admin (authenticated user without
 *      the flag) is redirected to `/dashboard` with NO message and
 *      NO query string — we don't want to leak the existence of
 *      `/admin/*` via a different error page or a "you're not
 *      authorized" banner.
 *
 *   3. On success, we record an `admin_page_viewed` audit row
 *      BEFORE rendering. Failures are swallowed (page views are
 *      best-effort; a DB blip MUST NOT block the admin's own
 *      dashboard).
 *
 * The sidebar is hard-coded with three links + logout. No fancy
 * navigation — this is operational tooling, not a customer surface.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await getAdminUser();

  if (!admin) {
    // Same redirect target as a non-existent route would yield for
    // an authenticated non-admin: bounce to /dashboard, no banner.
    // If they're not signed in at all, middleware already handled
    // it; this branch covers "signed in but not an admin".
    redirect("/dashboard");
  }

  const h = await headers();
  const path = h.get("x-ir-pathname") ?? "/admin";
  // Strip the query string before logging — the admin's filter
  // selection (e.g. `?status=paying`) isn't sensitive, but it
  // bloats the audit table and makes the forensic search noisy.
  const pathOnly = path.split("?")[0] ?? path;
  await recordAdminPageView({ adminId: admin.id, path: pathOnly });

  return (
    <div
      className="flex min-h-screen"
      style={{ background: "var(--color-bg-primary)" }}
    >
      <AdminSidebar adminEmail={admin.email} adminName={admin.name} />
      <main className="flex-1 min-w-0 overflow-x-auto">{children}</main>
      {/*
        Floating feedback pill is shared with the `(app)` layout so
        an admin sees the same in-product feedback affordance
        the candidates see — useful when dogfooding.
      */}
      <FeedbackWidget userId={admin.id} />
    </div>
  );
}
