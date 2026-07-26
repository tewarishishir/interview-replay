"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Client island for the marketing /contact form.
 *
 * Submission flow:
 *   1. Local field validation (HTML5 `required` + Zod-equivalent
 *      lengths) catches the common typos before the network roundtrip.
 *   2. POST /api/contact with the form payload. The server validates
 *      again (Zod) and dispatches via Resend to the operator inbox.
 *   3. On success: replace the form with a confirmation panel. We
 *      deliberately don't bounce the user to another page — the
 *      acknowledgement should land where they were standing.
 *   4. On error: surface the server message inline, leave the form
 *      filled so they can retry without re-typing.
 *
 * The `_company` honeypot is a hidden input that real browsers leave
 * empty. Spambots that bind to every `<input>` fill it in; the API
 * route fakes a 200 success for those so they don't retry.
 *
 * Submit-button label morphs through states so a power user has clear
 * feedback: "Send message" → "Sending…" → "Sent" (then auto-disabled).
 */

interface FormState {
  name: string;
  email: string;
  subject: string;
  message: string;
  honeypot: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  email: "",
  subject: "",
  message: "",
  honeypot: "",
};

const MAX_MESSAGE_CHARS = 5000;
const MIN_MESSAGE_CHARS = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Client-side validation before the network round-trip. */
function validateForm(form: FormState): string | null {
  if (!form.email.trim()) return "Please enter your email address.";
  if (!EMAIL_RE.test(form.email.trim())) return "Please enter a valid email address.";
  if (!form.subject.trim()) return "Please enter a subject.";
  if (form.message.trim().length < MIN_MESSAGE_CHARS)
    return `Please write at least ${MIN_MESSAGE_CHARS} characters in your message.`;
  return null;
}

/** Translate Zod v4 technical error messages into readable copy. */
function friendlyFieldError(field: string, raw: string): string {
  if (field === "email") {
    if (raw.includes("Invalid email") || raw.startsWith("Invalid input"))
      return "Please enter a valid email address.";
  }
  if (field === "subject" && raw.startsWith("Too small"))
    return "Please enter a subject.";
  if (field === "message" && raw.startsWith("Too small"))
    return `Please write at least ${MIN_MESSAGE_CHARS} characters in your message.`;
  if (raw.startsWith("Invalid input"))
    return "Please check your input and try again.";
  return raw;
}

export function ContactForm() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  const update = (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending || sent) return;
    setError(null);

    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch("/api/contact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: form.email.trim(),
            name: form.name.trim() || null,
            subject: form.subject.trim(),
            message: form.message,
            _company: form.honeypot,
          }),
        });
      } catch (err) {
        const isNetworkError =
          err instanceof TypeError ||
          (err as { name?: string })?.name === "AbortError";
        console.warn("[ContactForm] submit failed:", err);
        setError(
          isNetworkError
            ? "Couldn't reach the server. Check your connection and try again."
            : "Something went wrong. Please try again.",
        );
        return;
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          fieldErrors?: Record<string, string>;
        };
        if (data.fieldErrors) {
          const firstField = Object.keys(data.fieldErrors)[0];
          const rawError = firstField ? data.fieldErrors[firstField] : undefined;
          const displayError =
            firstField && rawError
              ? friendlyFieldError(firstField, rawError)
              : undefined;
          setError(displayError ?? "Please check the form and try again.");
        } else {
          setError(data.message ?? "We couldn't send your message. Please try again.");
        }
        return;
      }

      setSent(true);
      setForm(EMPTY_FORM);
    });
  };

  if (sent) {
    return (
      <div
        role="status"
        className="rounded-xl border border-primary/30 bg-primary/5 p-6 text-center"
      >
        <h2 className="text-lg font-semibold">Message sent</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Thanks for reaching out — we&apos;ll reply to you shortly. Please
          check your spam folder if you don&apos;t see our response within
          a couple of days.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-6"
          onClick={() => setSent(false)}
        >
          Send another message
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-name">Name (optional)</Label>
          <Input
            id="contact-name"
            type="text"
            value={form.name}
            onChange={update("name")}
            autoComplete="name"
            maxLength={120}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="contact-email">
            Email <span className="text-destructive">*</span>
          </Label>
          <Input
            id="contact-email"
            type="email"
            required
            value={form.email}
            onChange={update("email")}
            autoComplete="email"
            maxLength={254}
            className="mt-1"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="contact-subject">
          Subject <span className="text-destructive">*</span>
        </Label>
        <Input
          id="contact-subject"
          type="text"
          required
          value={form.subject}
          onChange={update("subject")}
          maxLength={160}
          placeholder="e.g. Question about pricing, Bug report, Feature request"
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="contact-message">
          Message <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="contact-message"
          required
          value={form.message}
          onChange={update("message")}
          rows={8}
          minLength={10}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="Tell us what's on your mind. The more context the better."
          className="mt-1"
        />
        <p className="mt-1 text-right text-xs text-muted-foreground">
          {form.message.length} / {MAX_MESSAGE_CHARS}
        </p>
      </div>

      {/*
        Honeypot field. Hidden from sighted users + screen readers
        (aria-hidden + tabIndex=-1 + visually-hidden styling). Real
        browsers leave it empty; spambots binding to every <input>
        fill it in and the API route fakes a 200 success.
      */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "-9999px",
          width: 1,
          height: 1,
          overflow: "hidden",
        }}
      >
        <label htmlFor="contact-company">Company (leave blank)</label>
        <input
          id="contact-company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.honeypot}
          onChange={update("honeypot")}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm" style={{ color: "rgb(190, 18, 60)" }}>
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        className="w-full sm:w-auto"
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Sending…
          </>
        ) : (
          "Send message"
        )}
      </Button>
    </form>
  );
}
