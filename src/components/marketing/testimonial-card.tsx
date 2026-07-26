"use client";

import { useEffect, useMemo, useState } from "react";
import { Star } from "lucide-react";

/**
 * A single testimonial card on the marketing home page.
 *
 * Client component because the avatar needs `onError` to fall back
 * to initials when the upstream OAuth image (Google `lh3.googleusercontent.com`
 * etc.) 403s or 404s. Mirrors the pattern in `src/components/app/user-menu.tsx`
 * so the home page and the authenticated header behave consistently
 * when a user's profile image disappears.
 *
 * Plain `<img>` is used (not `next/image`) because:
 *   - Most images are OAuth-hosted on third-party CDNs that we
 *     haven't configured `next/image` `remotePatterns` for — adding
 *     a wildcard pattern just for testimonials would weaken the
 *     existing image policy.
 *   - The displayed size (48px) means the optimization gains
 *     from `next/image` are marginal.
 *
 * The Google `lh3.googleusercontent.com` referrer-policy quirk is
 * the same one the `user-menu` handles — strip the referrer so the
 * CDN doesn't gate on origin.
 */
export function TestimonialCard({
  imageUrl,
  displayName,
  displayRole,
  rating,
  message,
}: {
  imageUrl: string | null;
  displayName: string | null;
  displayRole: string | null;
  rating: number;
  message: string;
}) {
  // Track image-load failure so a CDN blip falls back to initials
  // instead of leaving the browser's broken-image icon visible.
  // Resetting on `imageUrl` change isn't strictly necessary (this
  // component doesn't update post-mount in normal use), but it
  // matches user-menu's behaviour and is the future-safe default.
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    setAvatarFailed(false);
  }, [imageUrl]);

  // Google avatars historically 403 when sent a Referer; sending
  // no referrer is the low-risk workaround. Costs nothing on hosts
  // that don't care.
  const useNoReferrer = useMemo(() => {
    if (!imageUrl) return false;
    try {
      const host = new URL(imageUrl).hostname;
      return /\.googleusercontent\.com$/i.test(host);
    } catch {
      return false;
    }
  }, [imageUrl]);

  const initials = getInitials(displayName);
  const showImage = imageUrl !== null && !avatarFailed;

  return (
    <figure className="flex h-full flex-col rounded-xl border border-border bg-background p-6">
      <blockquote className="flex-1 text-sm leading-relaxed text-foreground">
        <RatingStars value={rating} />
        <p className="mt-3 whitespace-pre-wrap">&ldquo;{message}&rdquo;</p>
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-3">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- see component header
          <img
            src={imageUrl ?? ""}
            alt=""
            width={40}
            height={40}
            className="size-10 rounded-full object-cover"
            referrerPolicy={useNoReferrer ? "no-referrer" : undefined}
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          >
            {initials}
          </span>
        )}
        <div className="min-w-0">
          {displayName && (
            <div className="truncate text-sm font-medium text-foreground">
              {displayName}
            </div>
          )}
          {displayRole && (
            <div className="truncate text-xs text-muted-foreground">
              {displayRole}
            </div>
          )}
        </div>
      </figcaption>
    </figure>
  );
}

function RatingStars({ value }: { value: number }) {
  return (
    <div
      className="inline-flex items-center gap-0.5"
      aria-label={`${value} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={
            i <= value
              ? "size-4 fill-amber-400 text-amber-500"
              : "size-4 text-muted-foreground/30"
          }
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * Two-letter initials from a display name, falling back to "?" when
 * the input is empty/null. Lives here rather than as a shared util
 * so the testimonials card is self-contained; the user-menu has its
 * own copy that's slightly different (also accepts email). If a
 * third caller ever needs this, lift it to `@/lib/avatar`.
 */
function getInitials(name: string | null): string {
  const source = (name ?? "").trim();
  if (!source) return "?";
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && tokens[0] && tokens[1]) {
    return (tokens[0][0]! + tokens[1][0]!).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
