"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import {
  completePasswordResetAction,
  type CompleteResetActionState,
} from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const INITIAL_STATE: CompleteResetActionState = { state: "idle" };

interface ResetPasswordFormProps {
  /**
   * Reset token from the URL `?token=`. Carried as a hidden form
   * field so the server action can validate it without parsing the
   * referer/URL.
   */
  token: string;
  /**
   * Email the token was issued for. Same hidden-field pattern as
   * `token` — the server action re-checks the (email, token) pair
   * against `password_reset_tokens`.
   */
  email: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      className="w-full"
      disabled={pending}
    >
      {pending ? "Resetting…" : "Reset password"}
    </Button>
  );
}

export function ResetPasswordForm({ token, email }: ResetPasswordFormProps) {
  const [serverState, formAction] = useActionState(
    completePasswordResetAction,
    INITIAL_STATE,
  );

  const passwordId = useId();
  const confirmId = useId();

  const fieldErrors =
    serverState.state === "error" ? serverState.fieldErrors ?? {} : {};
  const formError =
    serverState.state === "error" ? serverState.formError : undefined;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="email" value={email} />

      {formError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>New password</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        {fieldErrors.password && (
          <p className="text-xs text-destructive">{fieldErrors.password}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={confirmId}>Confirm new password</Label>
        <Input
          id={confirmId}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        {fieldErrors.confirmPassword && (
          <p className="text-xs text-destructive">
            {fieldErrors.confirmPassword}
          </p>
        )}
      </div>

      <SubmitButton />
    </form>
  );
}
