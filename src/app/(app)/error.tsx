"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AppSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-2xl items-center justify-center px-6 py-16">
      <div className="w-full space-y-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-6" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            This page failed to load
          </h1>
          <p className="text-sm text-muted-foreground">
            Your work is safe. Try again, or jump back to the dashboard.
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground/80">
              Reference: <span className="font-mono">{error.digest}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button onClick={reset} variant="default">
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
