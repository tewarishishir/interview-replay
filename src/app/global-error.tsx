"use client";

import { useEffect } from "react";

export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0b0b0c",
          color: "#e6e6e7",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "1.5rem",
              fontWeight: 600,
            }}
          >
            We hit a snag
          </h1>
          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "0.9rem",
              color: "#a1a1aa",
            }}
          >
            The page failed to load. Please try again.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: "0.5rem",
                fontSize: "0.75rem",
                color: "#71717a",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              Ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1.25rem",
              borderRadius: "0.375rem",
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "#fafafa",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
