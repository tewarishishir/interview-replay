import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/lib/theme/ThemeProvider";
import { resolveTheme } from "@/lib/theme/resolve";

import "@/styles/globals.css";

const resolveMetadataBase = (): URL => {
  const raw = process.env.NEXTAUTH_URL;
  if (!raw) return new URL("http://localhost:3000");
  try {
    return new URL(raw);
  } catch {
    return new URL("http://localhost:3000");
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "InterviewReplay — AI Interview Coaching",
    template: "%s · InterviewReplay",
  },
  description:
    "Record your voice during real interviews and get structured AI feedback calibrated to your target level. Self-hosted, private, open-source.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico",
  },
};

/**
 * Inline anti-FOUC theme resolver.
 *
 * Runs synchronously in the document `<head>` before any other JS
 * or paint. Reads the same preference the server used (passed in
 * via the JSON literal below), and if it's `'system'`, asks the
 * browser via `matchMedia` what the OS actually prefers. The
 * resulting concrete theme is stamped onto `<html data-theme>` so
 * the very first painted frame is correct.
 *
 * Why this is necessary even though the server already set
 * `data-theme`: the server has to GUESS for `'system'` users
 * (defaulting to dark when the `sec-ch-prefers-color-scheme`
 * client hint isn't sent). If the OS actually wants light, that
 * first frame would be dark unless this script corrects it before
 * paint.
 *
 * The script is intentionally tiny and untranspiled — it has to
 * execute synchronously and any module/dynamic-import wait would
 * defeat the point.
 */
function antiFoucScript(preference: string): string {
  return [
    "(function(){",
    "try{",
    `var p=${JSON.stringify(preference)};`,
    "var t=p;",
    "if(p==='system'){",
    "t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';",
    "}",
    "if(t!=='light'&&t!=='dark'){t='dark';}",
    "document.documentElement.setAttribute('data-theme',t);",
    "}catch(e){}",
    "})();",
  ].join("");
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { preference, resolved } = await resolveTheme();

  return (
    <html
      lang="en"
      data-theme={resolved}
      data-theme-preference={preference}
      suppressHydrationWarning
    >
      <head>
        {/* Tell the browser we want the `prefers-color-scheme`
         * client hint on subsequent requests. Once accepted, the
         * server-side resolver can do a better-than-default guess
         * for `'system'` users (today it defaults to dark when
         * the hint isn't sent). Doesn't affect this request — it
         * primes the next one. */}
        <meta httpEquiv="Accept-CH" content="Sec-CH-Prefers-Color-Scheme" />
        <meta
          httpEquiv="Critical-CH"
          content="Sec-CH-Prefers-Color-Scheme"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: antiFoucScript(preference),
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider
          initialPreference={preference}
          initialResolved={resolved}
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

