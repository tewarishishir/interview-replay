import Link from "next/link";
import type { Metadata } from "next";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

/**
 * Static 404 served by the App Router for both unmatched routes and
 * any explicit `notFound()` calls. Server Component on purpose — no
 * JS shipped for the 404 path.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-6 text-center">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          404
        </p>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Page not found
          </h1>
          <p className="text-sm text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or may have
            moved.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild variant="default">
            <Link href="/">Go home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Open dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
