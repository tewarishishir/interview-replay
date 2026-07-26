"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DeleteSessionButtonProps {
  sessionId: string;
  label?: string;
  confirmMessage?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  redirectTo?: Route;
  disabled?: boolean;
}

export function DeleteSessionButton({
  sessionId,
  label = "Delete session",
  confirmMessage = "Delete this session? This can't be undone.",
  variant = "ghost",
  size = "default",
  className,
  redirectTo = "/dashboard" as Route,
  disabled,
}: DeleteSessionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (!window.confirm(confirmMessage)) return;

    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          message?: string;
        };
        if (!res.ok) {
          setError(data.message ?? `Couldn't delete (${res.status}).`);
          return;
        }
        router.push(redirectTo);
        router.refresh();
      } catch (err) {
        console.error("[DeleteSessionButton] delete failed:", err);
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className={cn("inline-flex flex-col items-start gap-2", className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn("text-destructive hover:bg-destructive/5")}
        style={{ color: "rgb(190, 18, 60)" }}
        disabled={disabled || pending}
        onClick={handleClick}
        aria-label={label}
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Deleting…
          </>
        ) : (
          <>
            <Trash2 className="size-4" aria-hidden />
            {label}
          </>
        )}
      </Button>
      {error && (
        <p
          role="alert"
          className="inline-flex items-center gap-1 text-xs"
          style={{ color: "rgb(190, 18, 60)" }}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
