"use client";

import { useState, useTransition } from "react";
import { Download, FileArchive, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Client islands for /account.
 *
 * Three pieces:
 *   - <AccountRestoreBanner /> : when the user is inside the
 *     deletion grace window, surfaces "you're scheduled for
 *     deletion on X — cancel?" and POSTs `/api/me/restore`.
 *   - <AccountDataExportSection /> : POST `/api/me/export` to
 *     trigger a new export, and shows the latest ready download
 *     when the server already passed one in.
 *   - <AccountDeletionSection /> : two-step "type DELETE my account"
 *     confirmation before DELETE `/api/me`. Reloads to /signin on
 *     success so the dropped Auth.js cookie takes effect.
 */

const formatBytes = (bytes: number | null): string => {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export function AccountRestoreBanner({
  hardDeleteAtIso,
  graceDays,
}: {
  hardDeleteAtIso: string;
  graceDays: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dateStr = new Date(hardDeleteAtIso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const onRestore = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch("/api/me/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (r.status === 410) {
          setError(
            "Your account is past the restore window. Please contact the site administrator for help.",
          );
          return;
        }
        if (!r.ok) {
          setError("Couldn't cancel deletion. Please try again.");
          return;
        }
        setDone(true);
        // Reload so the page re-renders without the banner and the
        // header reflects the active user.
        setTimeout(() => window.location.reload(), 800);
      } catch {
        setError("Network error — please try again.");
      }
    });
  };

  if (done) {
    return (
      <div
        role="status"
        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-foreground"
      >
        Deletion cancelled. Reloading…
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert
          className="mt-0.5 size-5 shrink-0 text-amber-700"
          aria-hidden
        />
        <div>
          <p className="font-medium text-foreground">
            Your account will be deleted on {dateStr}.
          </p>
          <p className="text-muted-foreground">
            You started a {graceDays}-day grace period. Cancel here to
            keep your account.
          </p>
          {error && (
            <p className="mt-2 text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onRestore}
        disabled={isPending}
      >
        {isPending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        Cancel deletion
      </Button>
    </div>
  );
}

export function AccountDataExportSection({
  latest,
}: {
  latest: {
    id: string;
    expiresAt: string;
    completedAtIso: string | null;
    fileSizeBytes: number | null;
    downloadUrl: string | null;
  } | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRequest = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch("/api/me/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (r.status === 503) {
          setError(
            "Exports are not available in this environment. Please contact support.",
          );
          return;
        }
        if (!r.ok) {
          setError("Couldn't start the export. Please try again.");
          return;
        }
        setRequested(true);
      } catch {
        setError("Network error — please try again.");
      }
    });
  };

  return (
    <div className="space-y-4">
      {latest && (
        <div className="rounded-md border border-border bg-muted/40 p-4">
          <div className="flex items-start gap-3">
            <FileArchive className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">
                Your last export is ready
              </p>
              <p className="text-xs text-muted-foreground">
                Expires{" "}
                {new Date(latest.expiresAt).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
                {latest.fileSizeBytes
                  ? ` • ${formatBytes(latest.fileSizeBytes)}`
                  : ""}
              </p>
              {latest.downloadUrl ? (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="mt-3"
                >
                  <a href={latest.downloadUrl}>
                    <Download className="size-4" aria-hidden />
                    Download ZIP
                  </a>
                </Button>
              ) : (
                <p className="mt-2 text-xs text-destructive">
                  Download link unavailable. Try requesting a new export.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {requested ? (
        <div
          role="status"
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-foreground"
        >
          Your export has been queued. We&apos;ll email you a download
          link when it&apos;s ready (usually a few minutes).
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="default"
            onClick={onRequest}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {latest ? "Request a new export" : "Request my data export"}
          </Button>
          {error && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const DELETE_CONFIRM_PHRASE = "DELETE my account";

export function AccountDeletionSection({
  graceDays,
  userEmail,
}: {
  graceDays: number;
  userEmail: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onDelete = () => {
    setError(null);
    if (confirmText !== DELETE_CONFIRM_PHRASE) {
      setError(`Type "${DELETE_CONFIRM_PHRASE}" exactly to confirm.`);
      return;
    }
    startTransition(async () => {
      try {
        const r = await fetch("/api/me", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });
        if (!r.ok) {
          setError("Couldn't initiate deletion. Please try again.");
          return;
        }
        // Hard-navigate to signin so the dropped cookie + the new
        // (deleted) state are reflected without any stale layout.
        window.location.href = "/signin?deletion=initiated";
      } catch {
        setError("Network error — please try again.");
      }
    });
  };

  if (!showConfirm) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setShowConfirm(true)}
      >
        Delete my account
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <p className="text-sm text-foreground">
        This starts a {graceDays}-day deletion clock for{" "}
        <strong>{userEmail}</strong>. To confirm, type{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {DELETE_CONFIRM_PHRASE}
        </code>{" "}
        below.
      </p>
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        placeholder={DELETE_CONFIRM_PHRASE}
        aria-label="Type DELETE my account to confirm"
      />
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setShowConfirm(false);
            setConfirmText("");
            setError(null);
          }}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          onClick={onDelete}
          disabled={isPending || confirmText !== DELETE_CONFIRM_PHRASE}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          Confirm deletion
        </Button>
      </div>
    </div>
  );
}
