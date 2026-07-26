"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import { signInAction, type AuthActionState } from "@/lib/auth/actions";
import { signInFormSchema } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const INITIAL_STATE: AuthActionState = { state: "idle" };

interface SignInFormProps {
  /**
   * Where to send the user after a successful sign-in. Comes from the
   * `?callbackUrl=` query string on the sign-in page so middleware can
   * round-trip the originally-requested route.
   */
  callbackUrl: string;
}

function SubmitButton() {
  // Pulled into its own component so it can read `useFormStatus()` —
  // that hook only reports `pending: true` for the closest enclosing
  // form's *current* submission, which is exactly what we want for the
  // submit button's disabled/loading state.
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

export function SignInForm({ callbackUrl }: SignInFormProps) {
  const [serverState, formAction] = useActionState(
    signInAction,
    INITIAL_STATE,
  );

  // Mirror server-returned field errors locally so they clear as soon
  // as the user starts typing in the corresponding field.
  const [clientErrors, setClientErrors] = useState<{
    email?: string;
    password?: string;
  }>({});

  // When the server returns new field errors, surface them through the
  // local state so subsequent keystrokes can dismiss them.
  useEffect(() => {
    if (serverState.state === "error" && serverState.fieldErrors) {
      setClientErrors(serverState.fieldErrors);
    }
  }, [serverState]);

  const emailId = useId();
  const passwordId = useId();
  const formError =
    serverState.state === "error" ? serverState.formError : undefined;

  // Final client-side check before letting the form post. We don't
  // `event.preventDefault()` on a successful parse — we just stop the
  // submit on a failed one. This is purely a UX optimization; the
  // server still runs the same Zod schema.
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const data = new FormData(event.currentTarget);
    const parsed = signInFormSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
    });
    if (!parsed.success) {
      event.preventDefault();
      const next: typeof clientErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "email" || key === "password") {
          next[key] ??= issue.message;
        }
      }
      setClientErrors(next);
    }
  };

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      <div className="space-y-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          aria-invalid={Boolean(clientErrors.email) || undefined}
          aria-describedby={clientErrors.email ? `${emailId}-err` : undefined}
          onChange={() =>
            setClientErrors((prev) => ({ ...prev, email: undefined }))
          }
        />
        {clientErrors.email && (
          <p id={`${emailId}-err`} className="text-sm text-destructive">
            {clientErrors.email}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          aria-invalid={Boolean(clientErrors.password) || undefined}
          aria-describedby={
            clientErrors.password ? `${passwordId}-err` : undefined
          }
          onChange={() =>
            setClientErrors((prev) => ({ ...prev, password: undefined }))
          }
        />
        {clientErrors.password && (
          <p id={`${passwordId}-err`} className="text-sm text-destructive">
            {clientErrors.password}
          </p>
        )}
      </div>

      {formError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      )}

      <SubmitButton />
    </form>
  );
}
