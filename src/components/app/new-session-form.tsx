"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { createSessionAction } from "@/lib/sessions/actions";
import {
  consentSchema,
  LEVEL_OPTIONS,
  ROUND_TYPE_OPTIONS,
  sessionMetadataSchema,
  type ConsentInput,
  type SessionMetadataInput,
} from "@/lib/sessions/schemas";
import { SUGGESTED_COMPANIES } from "@/lib/sessions/companies";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { SuggestInput } from "@/components/ui/suggest-input";

/**
 * Two-step "create session" form, mounted on `/sessions/new`.
 *
 * Step 1 — `MetadataStep`: company / role / level / round / scheduled.
 *          Validates with `sessionMetadataSchema` from
 *          `lib/sessions/schemas` so the API and the form share one
 *          source of truth. "Continue" only advances when the schema
 *          is satisfied.
 *
 * Step 2 — `ConsentStep`: the two required checkboxes plus the
 *          legal/billing footer. "Start session" stays disabled
 *          until both are checked.
 *
 * On submit we call `createSessionAction`, which posts the merged
 * payload to the server, runs the same Zod schema again as
 * defense-in-depth, writes the row + audit log entry, and redirects
 * to `/sessions/[id]/record`. The action only returns to us if
 * something failed — in which case we render the formError or
 * field errors inline.
 */

type Step = 1 | 2;

export function NewSessionForm() {
  const [step, setStep] = useState<Step>(1);
  const [metadata, setMetadata] = useState<SessionMetadataInput | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleStep1 = (values: SessionMetadataInput) => {
    setMetadata(values);
    setStep(2);
  };

  const handleSubmit = (_consent: ConsentInput) => {
    // The two consent booleans are validated by `consentSchema` —
    // we intentionally don't pass them to the server. The wire
    // contract is one boolean, `consentAffirmed: true`, so any
    // future audit lookup goes through the audit log entry rather
    // than per-clause columns. Ignore the values here on purpose.
    if (!metadata) {
      // Should be unreachable: step 2 is only renderable after
      // step 1 sets `metadata`. Fall back to bouncing the user
      // back rather than POSTing an incomplete payload.
      setStep(1);
      return;
    }

    setServerError(null);
    setIsSubmitting(true);
    startTransition(async () => {
      const result = await createSessionAction(
        { state: "idle" },
        {
          ...metadata,
          consentAffirmed: true,
        },
      );

      // Success returns nothing useful here because the action
      // calls `redirect()` — control never reaches this point
      // unless something failed. Surface the message and let the
      // user retry without losing their step-1 inputs.
      if (result.state === "error") {
        setServerError(
          result.formError ??
            "Something went wrong starting your session. Please try again.",
        );
        setIsSubmitting(false);
        // Bounce back to step 1 only if the failure is in step-1
        // territory — consent failures stay on step 2.
        if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) {
          const consentField = result.fieldErrors["consentAffirmed"];
          if (!consentField) setStep(1);
        }
      }
      // No success branch: redirect already happened.
    });
  };

  if (step === 1) {
    return (
      <MetadataStep
        defaultValues={metadata ?? undefined}
        onContinue={handleStep1}
      />
    );
  }

  return (
    <ConsentStep
      onBack={() => setStep(1)}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      serverError={serverError}
    />
  );
}

/* ------------------------------------------------------------------ */
/*                              Step 1                                 */
/* ------------------------------------------------------------------ */

/**
 * Format a `Date` as the `YYYY-MM-DDTHH:mm` string that
 * `<input type="datetime-local">` expects. We can't use
 * `Date#toISOString` here because that returns UTC, which would
 * shift the displayed time by the candidate's UTC offset. Building
 * the string from the local getters keeps "now" looking like "now".
 */
function formatLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function MetadataStep({
  defaultValues,
  onContinue,
}: {
  defaultValues?: SessionMetadataInput;
  onContinue: (values: SessionMetadataInput) => void;
}) {
  // RHF + zodResolver has a well-known input/output asymmetry: at
  // compile time the form is typed by `SessionMetadataInput`
  // (string-shaped form values) but at runtime `handleSubmit`
  // hands `onContinue` the resolver's *output* — e.g. a parsed
  // `Date` for `scheduledAt`. The display code below handles both
  // shapes so a candidate going back from step 2 sees the value
  // they typed, and the API call works regardless of which one we
  // pass through.
  const form = useForm<SessionMetadataInput>({
    resolver: zodResolver(sessionMetadataSchema),
    // Empty strings (rather than `undefined`) so React treats every
    // input as controlled from first render. Otherwise Radix's
    // RadioGroup logs a "controlled-after-uncontrolled" warning the
    // first time a candidate clicks a radio.
    defaultValues: {
      companyName: defaultValues?.companyName ?? "",
      roleTitle: defaultValues?.roleTitle ?? "",
      level: defaultValues?.level ?? ("" as SessionMetadataInput["level"]),
      roundType:
        defaultValues?.roundType ?? ("" as SessionMetadataInput["roundType"]),
      scheduledAt: defaultValues?.scheduledAt ?? "",
    },
    mode: "onSubmit",
  });

  // Prefill `scheduledAt` with the candidate's current local time so
  // the most common case ("I'm starting this right now") is one click
  // away. We do this after mount rather than via `defaultValues`
  // because the value depends on `Date.now()`, which differs between
  // the SSR render and the client render and would otherwise produce
  // a hydration mismatch on the input's `value`. We also skip
  // overwriting anything the candidate has already typed (e.g. when
  // they navigate back from step 2).
  useEffect(() => {
    if (defaultValues?.scheduledAt) return;
    if (form.getValues("scheduledAt")) return;
    form.setValue("scheduledAt", formatLocalDateTimeInput(new Date()));
    // Run once on mount; `form` and `defaultValues` are stable for the
    // lifetime of this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onContinue)}
        className="space-y-8"
        noValidate
      >
        <FormField
          control={form.control}
          name="companyName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Company name</FormLabel>
              <FormControl>
                <SuggestInput
                  suggestions={SUGGESTED_COMPANIES}
                  placeholder="e.g. Razorpay"
                  {...field}
                  value={typeof field.value === "string" ? field.value : ""}
                  onPick={(v) => field.onChange(v)}
                />
              </FormControl>
              <FormDescription>
                Pick from the list or type any company.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="roleTitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Role title</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Senior Software Engineer"
                  autoComplete="off"
                  {...field}
                  value={typeof field.value === "string" ? field.value : ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="level"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Level</FormLabel>
              <FormControl>
                <RadioGroup
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  {LEVEL_OPTIONS.map((opt) => (
                    <RadioRow
                      key={opt.value}
                      value={opt.value}
                      label={opt.label}
                    />
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="roundType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Round type</FormLabel>
              <FormControl>
                <RadioGroup
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  {ROUND_TYPE_OPTIONS.map((opt) => (
                    <RadioRow
                      key={opt.value}
                      value={opt.value}
                      label={opt.label}
                    />
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="scheduledAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Scheduled date and time{" "}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Input
                  type="datetime-local"
                  {...field}
                  value={
                    typeof field.value === "string"
                      ? field.value
                      : field.value instanceof Date
                        ? field.value.toISOString().slice(0, 16)
                        : ""
                  }
                />
              </FormControl>
              <FormDescription>
                Helps you find this session later. Leave blank if you&apos;re
                not sure.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end pt-2">
          <Button type="submit" variant="primary" size="lg">
            Continue
          </Button>
        </div>
      </form>
    </Form>
  );
}

/**
 * Single radio row with its own label-and-control box. Extracted so
 * the radio rendering doesn't duplicate inside both the level and
 * round-type fields.
 */
function RadioRow({ value, label }: { value: string; label: string }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 transition-colors hover:bg-muted/40 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*                              Step 2                                 */
/* ------------------------------------------------------------------ */

function ConsentStep({
  onBack,
  onSubmit,
  isSubmitting,
  serverError,
}: {
  onBack: () => void;
  onSubmit: (consent: ConsentInput) => void;
  isSubmitting: boolean;
  serverError: string | null;
}) {
  const form = useForm<ConsentInput>({
    resolver: zodResolver(consentSchema),
    // We intentionally omit defaults so each checkbox starts as
    // `undefined` — react-hook-form treats that as "untouched", and
    // the schema's `z.literal(true)` rejects everything else.
    mode: "onChange",
  });

  // The "Start session" CTA only enables when both are true.
  // We watch directly (rather than relying on `formState.isValid`)
  // because RHF's `isValid` defaults to `false` until the user
  // interacts, which would make the button look broken.
  const headphones = form.watch("headphones") === true;
  const doNotClose = form.watch("doNotClose") === true;
  const allChecked = headphones && doNotClose;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Before you start
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            InterviewReplay will record only your microphone during the interview. It
            will not record the interviewer. We&apos;ll transcribe what you
            said, you&apos;ll review and edit it, and our AI will give you
            structured feedback.
          </p>
        </div>

        <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-5">
          <ConsentRow
            name="headphones"
            label="I confirm I am using headphones, OR I am in a fully private space where the interviewer's voice cannot be captured by my microphone."
            form={form}
          />
          <ConsentRow
            name="doNotClose"
            label="I understand I should not close this browser tab during the interview, or my recording will be lost."
            form={form}
          />
        </div>

        {serverError && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {serverError}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={onBack}
              disabled={isSubmitting}
            >
              Back
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!allChecked || isSubmitting}
            >
              {isSubmitting && (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              )}
              {isSubmitting ? "Starting…" : "Start session"}
            </Button>
          </div>
          
        </div>
      </form>
    </Form>
  );
}

function ConsentRow({
  name,
  label,
  form,
}: {
  name: keyof ConsentInput;
  label: string;
  form: ReturnType<typeof useForm<ConsentInput>>;
}) {
  const id = useId();
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field, fieldState }) => (
        <FormItem className="flex flex-col gap-1">
          <div className="flex items-start gap-3">
            <FormControl>
              <Checkbox
                id={id}
                checked={field.value === true}
                onCheckedChange={(v) => field.onChange(v === true)}
                aria-invalid={Boolean(fieldState.error) || undefined}
              />
            </FormControl>
            <Label
              htmlFor={id}
              className="cursor-pointer text-sm font-normal leading-relaxed"
            >
              {label}
            </Label>
          </div>
          <FormMessage className="ml-7" />
        </FormItem>
      )}
    />
  );
}
