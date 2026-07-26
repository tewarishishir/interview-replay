"use client";

import { Check } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface CreditPackCardProps {
  pack: {
    id: "starter" | "standard" | "heavy";
    name: string;
    blurb: string;
    priceLabel: string;
    credits: number;
    perCreditLabel: string;
    equivalenceLabel: string;
    highlighted: boolean;
  };
  available: boolean;
}

/**
 * Self-hosted credit pack card. All features are free — no payment
 * processing. Credits are granted directly via admin actions.
 */
export function CreditPackCard({ pack }: CreditPackCardProps) {
  return (
    <Card
      className={
        pack.highlighted
          ? "relative border-primary/60 shadow-md"
          : "border-border"
      }
    >
      {pack.highlighted && (
        <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
          Most popular
        </span>
      )}
      <CardHeader>
        <CardTitle>{pack.name}</CardTitle>
        <CardDescription>{pack.blurb}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-semibold tracking-tight">
              Free
            </span>
            <span className="text-sm text-muted-foreground">self-hosted</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {pack.credits} credits · {pack.equivalenceLabel}
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
            <span>Credits never expire</span>
          </li>
          <li className="flex items-start gap-2">
            <Check
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden
            />
            <span>Self-hosted — your data stays on your server</span>
          </li>
        </ul>

        <p className="text-xs text-muted-foreground">
          This is a self-hosted instance. Credits are managed by your
          administrator.
        </p>
      </CardContent>
    </Card>
  );
}
