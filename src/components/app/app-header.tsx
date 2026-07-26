import Link from "next/link";
import { BookOpen, LayoutDashboard, UserRound } from "lucide-react";

import { MobileNav } from "@/components/app/mobile-nav";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UserMenu } from "@/components/app/user-menu";
import { Wordmark } from "@/components/brand/wordmark";
import {
  effectiveCreditBalance,
  formatCreditsDecimal,
} from "@/lib/credits/pricing";

interface AppHeaderProps {
  user: {
    name: string | null;
    email: string;
    imageUrl: string | null;
  };
  creditBalance: number;
  /**
   * Sub-credit accumulator for the AI-draft / critique surfaces.
   * Combined with `creditBalance` to render the *effective* decimal
   * balance the user can actually spend (e.g. `9.40 credits` when
   * the integer column says 10 but three AI calls already sit in
   * the accumulator).
   *
   * Defaults to `0` so a legacy caller that hasn't been updated
   * yet still renders the integer balance — same shape as the
   * pre-decimal pill.
   */
  rebuildCritiqueUnits?: number;
}

const navLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/stories", label: "Story bank", icon: BookOpen },
  { href: "/profile", label: "Profile", icon: UserRound },
] as const;

/**
 * Server component for the authenticated app shell. Renders the brand,
 * the nav, the credit-balance pill, and the user menu (a client island).
 *
 * Lives in `components/app/` so the (app) layout can stay tiny and any
 * future page-specific override (e.g. a session-detail "back" header)
 * doesn't need to fork the whole layout.
 */
export function AppHeader({
  user,
  creditBalance,
  rebuildCritiqueUnits = 0,
}: AppHeaderProps) {
  // Effective decimal balance: the integer column minus the
  // already-incurred sub-credit accumulator. This is the number the
  // user can actually spend on the next AI call, so the pill shows
  // it (not the raw integer) to avoid the "I have 10 credits but
  // the buy page says I have 9.40" gap right before a rollover.
  const decimalBalance = effectiveCreditBalance(
    creditBalance,
    rebuildCritiqueUnits,
  );
  const decimalLabel = formatCreditsDecimal(decimalBalance);
  // The "credit" / "credits" suffix is pluralized off the *integer*
  // column for stable copy across the pill ("1.00 credit" reads
  // worse than "1.00 credits" when the user is mid-rollover; we
  // prefer the consistent plural for any non-singular integer).
  const pluralSuffix = creditBalance === 1 ? "" : "s";
  const creditLabel = `${decimalLabel} credit${pluralSuffix}`;
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-4 sm:gap-8">
          {/* Hamburger — mobile only */}
          <MobileNav
            creditLabel={creditLabel}
            userName={user.name}
            userEmail={user.email}
          />
          {/*
            The brand mark goes to the marketing home (`/`), not the
            dashboard. Most SaaS conventions (GitHub, Stripe, Linear)
            do this, and we already render a separate "Dashboard"
            nav link below for the app-internal home. Sending the
            wordmark to `/dashboard` gave logged-in users no obvious
            way back to the marketing site short of editing the URL.
          */}
          <Link href="/" aria-label="InterviewReplay home">
            <Wordmark />
          </Link>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-1 text-sm sm:flex"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <link.icon className="size-4" aria-hidden />
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {/*
            The credit pill links to `/credits/history` so users can
            see exactly where each credit was spent or earned. We
            considered making it a popover, but a full page is more
            scannable when the ledger has many entries AND it gives
            the "Buy credits" CTA a permanent home.
          */}
          <Link
            href="/credits/history"
            aria-label={`${decimalLabel} credits available — view history`}
            title="Each AI draft or critique deducts 0.20 credits"
            className="hidden items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:inline-flex tabular-nums"
          >
            <span className="text-foreground">{decimalLabel}</span>
            <span className="text-muted-foreground">credit{pluralSuffix}</span>
          </Link>
          {/*
            Theme toggle. Single-button cycle through
            light → dark → system. The Account page is still the
            full picker; this is just the in-shell quick-flip.
          */}
          <ThemeToggle />
          <UserMenu
            name={user.name}
            email={user.email}
            imageUrl={user.imageUrl}
          />
        </div>
      </div>
    </header>
  );
}
