import Link from "next/link";
import { BookOpen, LayoutDashboard, UserRound } from "lucide-react";

import { MobileNav } from "@/components/app/mobile-nav";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { UserMenu } from "@/components/app/user-menu";
import { Wordmark } from "@/components/brand/wordmark";

interface AppHeaderProps {
  user: {
    name: string | null;
    email: string;
    imageUrl: string | null;
  };
}

const navLinks = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/stories", label: "Story bank", icon: BookOpen },
  { href: "/profile", label: "Profile", icon: UserRound },
] as const;

export function AppHeader({ user }: AppHeaderProps) {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-4 sm:gap-8">
          <MobileNav
            userName={user.name}
            userEmail={user.email}
          />
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
