import Link from "next/link";
import { LayoutDashboard } from "lucide-react";

import { auth } from "@/lib/auth";
import { features } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UserMenu } from "@/components/app/user-menu";
import { Wordmark } from "@/components/brand/wordmark";

/**
 * Marketing-site header.
 *
 * Auth-aware: a signed-in user sees "Dashboard" + UserMenu instead of
 * "Sign in / Get started" CTAs. Uses `auth()` (JWT decode, no DB hit).
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
