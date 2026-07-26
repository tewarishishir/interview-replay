"use client";

import { useState } from "react";
import { Building2 } from "lucide-react";

import { getCompanyLogoUrl } from "@/lib/company-logos";
import { cn } from "@/lib/utils";

/**
 * Inline company avatar for dashboard cards / rows.
 *
 * Looks up the company in our curated `COMPANY_DOMAINS` table and
 * renders Google's `s2/favicons` icon for the matched domain. Falls
 * back to a `Building2` icon when:
 *
 *   - the company name isn't in our curated lookup table, OR
 *   - the image fails to load (network blocked, ad blocker chewing
 *     the request, gstatic outage, …).
 *
 * The fallback path is also what we get during SSR — `useState`
 * starts `errored=false`, so the `<img>` is the first paint for
 * recognized companies. If it 404s, the `onError` handler flips to
 * the icon on the next render. There's no flash for unknown
 * companies because they take the icon branch up-front.
 *
 * Marked `aria-hidden` because the company name is rendered next to
 * the logo in every consumer — a screen reader doesn't need to
 * announce the brand mark a second time.
 */
export function CompanyLogo({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const logoUrl = getCompanyLogoUrl(name);
  const [errored, setErrored] = useState(false);

  if (!logoUrl || errored) {
    return <Building2 className={cn("size-3.5", className)} aria-hidden />;
  }

  // Intentional `<img>` (not next/image): this is a 14px inline
  // avatar served from Google's public favicon CDN. Routing it
  // through `next/image` would force us to list `google.com`
  // / `gstatic.com` in `next.config.ts > images.remotePatterns`
  // AND pulls in size negotiation we don't need at this footprint.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      className={cn(
        "size-3.5 shrink-0 rounded-sm object-contain",
        className,
      )}
    />
  );
}
