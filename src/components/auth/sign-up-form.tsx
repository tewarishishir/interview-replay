"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import { signUpAction, type AuthActionState } from "@/lib/auth/actions";
import { passwordRules, signUpFormSchema } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const INITIAL_STATE: AuthActionState = { state: "idle" };

type FieldErrors = {
  name?: string;
  email?: string;
  password?: string;
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={pending}>
      {pending ? "Creating account…" : "Create account"}
    </Button>
  );
}

export function SignUpForm() {
  const [serverState, formAction] = useActionState(
    signUpAction,
    INITIAL_STATE,
  );
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (serverState.state === "error" && serverState.fieldErrors) {
      setClientErrors(serverState.fieldErrors);
    }
  }, [serverState]);

  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const formError =
    serverState.state === "error" ? serverState.formError : undefined;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const data = new FormData(event.currentTarget);
    const parsed = signUpFormSchema.safeParse({
      name: data.get("name"),
      email: data.get("email"),
      password: data.get("password"),
    });
    if (!parsed.success) {
      event.preventDefault();
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "name" || key === "email" || key === "password") {
          next[key] ??= issue.message;
        }
      }
      setClientErrors(next);
    }
  };

  return (
    <form action={formAction} onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>
          Name <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={nameId}
          name="name"
          type="text"
          autoComplete="name"
          aria-invalid={Boolean(clientErrors.name) || undefined}
          aria-describedby={clientErrors.name ? `${nameId}-err` : undefined}
          onChange={() =>
            setClientErrors((prev) => ({ ...prev, name: undefined }))
          }
        />
        {clientErrors.name && (
          <p id={`${nameId}-err`} className="text-sm text-destructive">
            {clientErrors.name}
          </p>
        )}
      </div>

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
          minLength={passwordRules.minLength}
          autoComplete="new-password"
          aria-invalid={Boolean(clientErrors.password) || undefined}
          aria-describedby={
            clientErrors.password
              ? `${passwordId}-err`
              : `${passwordId}-hint`
          }
          onChange={() =>
            setClientErrors((prev) => ({ ...prev, password: undefined }))
          }
        />
        {clientErrors.password ? (
          <p id={`${passwordId}-err`} className="text-sm text-destructive">
            {clientErrors.password}
          </p>
        ) : (
          <p id={`${passwordId}-hint`} className="text-xs text-muted-foreground">
            At least {passwordRules.minLength} characters, including a number.
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
