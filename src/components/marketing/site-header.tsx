import Link from "next/link";
import { LayoutDashboard } from "lucide-react";

import { auth } from "@/lib/auth";
import { features } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UserMenu } from "@/components/app/user-menu";
import { Wordmark } from "@/components/brand/wordmark";

const navLinks = [
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
] as const;

/**
 * Marketing-site header.
 *
 * The header is auth-aware so a signed-in user landing on /, /pricing, or
 * /about doesn't see "Sign in / Get started" CTAs (which made it look
 * like they'd been signed out). When authenticated we swap them for a
 * "Dashboard" link plus the same `UserMenu` rendered inside the (app)
 * shell, so the user can sign out from anywhere.
 *
 * We use `auth()` (which only decodes the JWT — no DB hit) instead of
 * the heavier `getDashboardUser` lookup. Marketing pages don't need
 * revocation defense-in-depth because clicking "Dashboard" bounces the
 * request through the (app) layout, which DOES re-validate the user
 * exists in the DB before rendering anything sensitive.
 */
export async function SiteHeader() {
  const session = await auth();
  const user = session?.user;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="InterviewReplay home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-6 text-sm text-muted-foreground sm:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/*
            Theme toggle sits before the auth cluster on every
            marketing surface — same affordance as the (app) shell
            so a signed-in user crossing back to / doesn't lose
            the quick light/dark/system flip. Visible to anonymous
            visitors too; the preference is cookie-backed and
            therefore persists right through signup.
          */}
          <ThemeToggle />
          {user?.email ? (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard">
                  <LayoutDashboard className="size-4" aria-hidden />
                  Dashboard
                </Link>
              </Button>
              <UserMenu
                name={user.name ?? null}
                email={user.email}
                imageUrl={user.image ?? null}
              />
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/signin">Sign in</Link>
              </Button>
              {!features.inviteOnlyBeta && (
                <Button asChild size="sm">
                  <Link href="/signup">Get started</Link>
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  );
}
