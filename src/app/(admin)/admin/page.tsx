import { redirect } from "next/navigation";

/**
 * `/admin` exists only to redirect to the default landing surface
 * (Daily Ops). Done server-side so an admin who bookmarks `/admin`
 * lands on Ops without a flash.
 *
 * The redirect target is `/admin/ops` rather than the most-recently-
 * viewed surface intentionally — a brand-new admin should see the
 * single most important view first, and a returning admin can
 * navigate to the others in one click. No per-user "last route"
 * state to maintain.
 */
export default function AdminIndexPage() {
  redirect("/admin/ops");
}
