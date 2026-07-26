import Link from "next/link";
import type { Metadata } from "next";
import { Check } from "lucide-react";

import { features } from "@/lib/env";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Pricing — Free & Self-Hosted",
  description:
    "InterviewReplay is free and self-hosted. Run it on your own server. No subscriptions, no credit card required.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — Free & Self-Hosted",
    description:
      "InterviewReplay is free and self-hosted. No subscription, no payment required.",
    url: "/pricing",
  },
};

const creditUsage = [
  { duration: "Up to 30 minutes", credits: 1 },
  { duration: "Up to 60 minutes", credits: 2 },
  { duration: "Up to 90 minutes", credits: 3 },
  { duration: "Up to 120 minutes", credits: 4 },
] as const;

export default function PricingPage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Free & self-hosted
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            InterviewReplay is open source. Deploy it on your own infrastructure
            and use it without limits. No subscription, no payment required.
          </p>
          <p className="mt-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground">
            Every account starts with <strong>2 free credits</strong> &mdash;
            enough for one full 60-minute interview, or two 30-minute rounds.
            Admins can grant additional credits at any time.
          </p>
        </div>

        <div className="mt-16 grid gap-6 lg:grid-cols-1">
          <Card className="relative mx-auto max-w-md border-primary/60 shadow-md">
            <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
              Self-hosted
            </span>
            <CardHeader>
              <CardTitle>InterviewReplay</CardTitle>
              <CardDescription>
                Full-featured interview coaching — deploy on your own server
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-semibold tracking-tight">
                    Free
                  </span>
                  <span className="text-sm text-muted-foreground">
                    forever
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Open source · Self-hosted · No limits
                </p>
              </div>

              <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>Full AI feedback report on every interview</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>Your data stays on your server</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>Unlimited users and sessions</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>Use your own LLM (Ollama, OpenAI-compatible)</span>
                </li>
              </ul>

              <Button
                asChild
                className="w-full"
                variant="primary"
              >
                <Link
                  href={
                    features.inviteOnlyBeta
                      ? "/signin"
                      : "/signup"
                  }
                >
                  {features.inviteOnlyBeta ? "Sign in" : "Get started"}
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      <section
        id="credit-usage"
        aria-labelledby="credit-usage-heading"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <h2
            id="credit-usage-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            How credits get charged
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            We charge by the length of the recording, rounded up to the
            nearest 30-minute bucket. A 35-minute behavioral interview costs
            the same as a 60-minute one.
          </p>

          <div className="mt-8 overflow-hidden rounded-xl border border-border bg-background">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Recording length</th>
                  <th className="px-4 py-3 font-medium">Credits charged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {creditUsage.map((row) => (
                  <tr key={row.duration}>
                    <td className="px-4 py-3">{row.duration}</td>
                    <td className="px-4 py-3 font-medium">
                      {row.credits} credit{row.credits === 1 ? "" : "s"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
            <li>· Credits are managed by your instance administrator.</li>
            <li>· Credits never expire.</li>
            <li>
              · Failed analyses (e.g. corrupted audio) don&apos;t use a
              credit.
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-16 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Your first interview, free &mdash; up to 60 minutes
          </h2>
          <p className="max-w-xl text-base text-muted-foreground">
            Sign up and you&apos;ll get 2 credits in your account. See what
            InterviewReplay tells you about your real interview.
          </p>
          <Button asChild size="lg" variant="primary" className="mt-2">
            <Link href={features.inviteOnlyBeta ? "/signin" : "/signup"}>
              {features.inviteOnlyBeta ? "Sign in" : "Get your free credits"}
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
