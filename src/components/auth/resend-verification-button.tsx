"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

export function ResendVerificationButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Sending…" : "Resend verification email"}
    </Button>
  );
}
