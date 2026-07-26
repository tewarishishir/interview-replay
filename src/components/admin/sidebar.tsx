"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  Activity,
  LogOut,
  MessageSquareText,
  ShieldCheck,
  Users,
} from "lucide-react";

import { signOutAction } from "@/lib/auth/actions";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { cn } from "@/lib/utils";

interface AdminSidebarProps {
  adminEmail: string;
  adminName: string | null;
}

const NAV_LINKS = [
  { href: "/admin/ops", label: "Daily ops", icon: Activity },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/health", label: "Product health", icon: ShieldCheck },
  { href: "/admin/feedback", label: "Feedback", icon: MessageSquareText },
] as const;

/**
 * Fixed-width left sidebar for the (admin) shell. Plain and
 * functional per the spec — three nav links, the admin's identity,
 * and a logout link. No customer-facing polish.
 *
 * Client component because the active-link highlight needs
 * `usePathname()` and the logout action needs `useTransition`.
 * Everything else (the header, content area) stays a server
 * component.
 */
export function AdminSidebar({ adminEmail, adminName }: AdminSidebarProps) {
  const pathname = usePathname();
  const [isSigningOut, startSignOut] = useTransition();

  return (
    <aside
      aria-label="Admin navigation"
      className="flex w-56 shrink-0 flex-col border-r"
      style={{
        background: "var(--color-bg-secondary)",
        borderColor: "var(--color-border-tertiary)",
      }}
    >
      <div
        className="px-4 py-4 text-xs font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        InterviewReplay admin
      </div>

      <nav className="flex-1 px-2 py-1">
        <ul className="flex flex-col gap-1">
          {NAV_LINKS.map((link) => {
            const Icon = link.icon;
            // Active when the current path starts with the nav href.
            // /admin/users matches /admin/users/[id] etc.
            const isActive =
              pathname === link.href || pathname.startsWith(link.href + "/");
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  )}
                  style={{
                    background: isActive
                      ? "var(--color-bg-tertiary)"
                      : "transparent",
                    color: isActive
                      ? "var(--color-text-primary)"
                      : "var(--color-text-secondary)",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  <Icon className="size-4" aria-hidden />
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        className="border-t px-4 py-3 text-xs"
        style={{
          borderColor: "var(--color-border-tertiary)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate" title={adminEmail}>
              {adminName?.trim() || adminEmail}
            </div>
            {adminName?.trim() && (
              <div className="mt-0.5 truncate" title={adminEmail}>
                {adminEmail}
              </div>
            )}
          </div>
          {/*
            Theme toggle alongside the admin identity — admin tools
            get used at all hours; matching the rest of the app's
            light/dark affordance keeps muscle memory consistent.
          */}
          <ThemeToggle />
        </div>
        <button
          type="button"
          disabled={isSigningOut}
          onClick={() => {
            startSignOut(async () => {
              try {
                await signOutAction();
              } catch (err) {
                const isRedirect =
                  err != null &&
                  typeof err === "object" &&
                  "digest" in err &&
                  typeof (err as { digest?: unknown }).digest === "string" &&
                  (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
                if (!isRedirect) {
                  console.error("[admin/sidebar] sign-out failed:", err);
                }
              }
            });
          }}
          className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors disabled:opacity-50"
          style={{
            color: "var(--color-text-secondary)",
            background: "transparent",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-bg-tertiary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <LogOut className="size-4" aria-hidden />
          {isSigningOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </aside>
  );
}
