import Link from "next/link";
import type { ReactNode } from "react";

import { ThemeToggle } from "@/components/app/theme-toggle";
import { Wordmark } from "@/components/brand/wordmark";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" aria-label="InterviewReplay home">
            <Wordmark />
          </Link>
          {/*
            Theme toggle on the auth shell as well — users finalize
            light/dark preference BEFORE signing in (they're staring
            at a form for a minute or two), so giving them the same
            quick-flip the rest of the site has is worth the extra
            button. Cookie persistence carries the choice into the
            (app) shell after sign-in.
          */}
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
