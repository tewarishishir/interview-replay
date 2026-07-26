"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { LogOut, User as UserIcon } from "lucide-react";

import { signOutAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface UserMenuProps {
  /** The user's display name — falls back to email if no name is set. */
  name: string | null;
  /** Always present once authenticated — used as the secondary line in the menu. */
  email: string;
  /** Optional avatar URL (Google OAuth populates this). */
  imageUrl?: string | null;
  className?: string;
}

const initials = (name: string | null, email: string): string => {
  const source = (name ?? email).trim();
  if (!source) return "?";
  // Take up to two whitespace-separated tokens; fall back to first two
  // characters of the local-part for single-word names / raw emails.
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && tokens[0] && tokens[1]) {
    return (tokens[0][0]! + tokens[1][0]!).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
};

/**
 * Authenticated header dropdown: avatar / initials trigger, with the
 * user's name + email and a sign-out item.
 *
 * The sign-out item triggers a server action wrapped in
 * `useTransition` so the UI stays responsive (and doesn't double-fire
 * if the user keyboard-mashes Enter on the menu item).
 */
export function UserMenu({ name, email, imageUrl, className }: UserMenuProps) {
  const [isPending, startTransition] = useTransition();
  // Sign-out can fail (network blip, server error). Surface it instead
  // of silently leaving the user "signed in" — they need to know their
  // session is still live so they can retry. NEXT_REDIRECT is not an
  // error, so we filter it out before showing anything.
  //
  // The error renders BOTH inside the menu (where the click happened)
  // and as a fixed-position banner so it survives the menu closing.
  // The banner auto-dismisses after 6 s; the user can also dismiss it.
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Avatar load state. When the image fails (Google CDN 403/blip,
  // referrer-policy reject, the user deleted the photo) we fall back
  // to initials instead of leaving the browser's broken-image icon
  // in the header. Tracking this in component state — rather than
  // hiding via CSS — also lets us reset on `imageUrl` change so a
  // user updating their photo doesn't get stuck on the failed state.
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    setAvatarFailed(false);
  }, [imageUrl]);

  // Some image hosts gate on `Referer`. Google's `lh3.googleusercontent.com`
  // serves avatars publicly today, but has historically returned 403 to
  // certain origins; sending no referrer is the canonical, low-risk
  // workaround and costs nothing for hosts that don't care.
  const useNoReferrer = useMemo(() => {
    if (!imageUrl) return false;
    try {
      const host = new URL(imageUrl).hostname;
      return /\.googleusercontent\.com$/i.test(host);
    } catch {
      return false;
    }
  }, [imageUrl]);

  useEffect(() => {
    if (!signOutError) return;
    const timer = setTimeout(() => setSignOutError(null), 6_000);
    return () => clearTimeout(timer);
  }, [signOutError]);

  const displayName = name?.trim() ? name : email;
  const showImage = Boolean(imageUrl) && !avatarFailed;

  return (
    <>
      {signOutError && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-md border border-destructive/40 bg-background px-4 py-3 text-sm text-destructive shadow-lg sm:inset-x-auto sm:right-4"
        >
          <span>{signOutError}</span>
          <button
            type="button"
            onClick={() => setSignOutError(null)}
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
      <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open user menu"
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm transition-colors hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className,
        )}
      >
        <span className="flex size-7 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium uppercase text-muted-foreground">
          {showImage ? (
            // OAuth avatar. `next/image` would require an explicit
            // remotePattern entry per provider; a plain <img> is fine
            // for a 28×28 thumbnail and avoids the config churn.
            //
            // `referrerPolicy="no-referrer"` for Google avatars (and
            // a no-op for everyone else) keeps the request reliable
            // across `strict-origin-when-cross-origin` defaults.
            // `onError` swaps to initials so a CDN blip never leaves
            // the browser's broken-image icon in the header.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl ?? undefined}
              alt=""
              width={28}
              height={28}
              decoding="async"
              loading="eager"
              referrerPolicy={useNoReferrer ? "no-referrer" : undefined}
              onError={() => setAvatarFailed(true)}
              className="size-full object-cover"
            />
          ) : (
            <span aria-hidden>{initials(name, email)}</span>
          )}
        </span>
        <span className="hidden max-w-[12ch] truncate sm:inline">
          {displayName}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{displayName}</span>
          {name && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account" className="flex items-center gap-2">
            <UserIcon className="size-4" aria-hidden />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isPending}
          onSelect={(event) => {
            // Prevent the default close-then-navigate so the action
            // can run inside our transition without a flash.
            event.preventDefault();
            setSignOutError(null);
            startTransition(async () => {
              try {
                await signOutAction();
              } catch (err) {
                // `redirect()` from a Server Action throws a special
                // `NEXT_REDIRECT` error that React/Next consumes — it
                // is NOT a real failure and the user IS signed out.
                // Anything else (network drop, 500) is a real problem
                // and we want the user to see it.
                const isRedirect =
                  err != null &&
                  typeof err === "object" &&
                  "digest" in err &&
                  typeof (err as { digest?: unknown }).digest === "string" &&
                  (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
                if (isRedirect) return;
                console.error("[user-menu] sign-out failed:", err);
                setSignOutError(
                  "We couldn't sign you out. Please try again or refresh the page.",
                );
              }
            });
          }}
        >
          <LogOut className="size-4" aria-hidden />
          {isPending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
        {signOutError && (
          <p
            role="alert"
            className="px-2 pb-2 pt-1 text-xs text-destructive"
          >
            {signOutError}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
