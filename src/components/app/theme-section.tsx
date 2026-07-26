"use client";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useTheme } from "@/lib/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/theme/types";

/**
 * Theme picker for the Account page.
 *
 * Three radios: Light, Dark, Match system. Selection persists
 * immediately — no Save button. The optimistic DOM update happens
 * synchronously inside `setTheme`; the server persistence is
 * fire-and-forget, so a slow network won't delay the UI feedback.
 *
 * `useTheme` reads from the same context the root layout
 * initialized, so the radios reflect the SSR'd preference on
 * first paint (no hydration mismatch).
 */
export function ThemeSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Match your operating system or pick a fixed appearance. Your
        choice persists across devices when you&apos;re signed in.
      </p>

      <RadioGroup
        value={theme}
        onValueChange={(next) => setTheme(next as ThemePreference)}
        className="grid gap-3"
        aria-label="Theme preference"
      >
        <ThemeOption
          value="light"
          label="Light"
          description="A bright, paper-white appearance."
        />
        <ThemeOption
          value="dark"
          label="Dark"
          description="A muted, near-black appearance — easier on the eyes at night."
        />
        <ThemeOption
          value="system"
          label="Match system"
          description="Follow your OS-level appearance setting."
        />
      </RadioGroup>
    </div>
  );
}

function ThemeOption({
  value,
  label,
  description,
}: {
  value: ThemePreference;
  label: string;
  description: string;
}) {
  const id = `theme-${value}`;
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <Label htmlFor={id} className="cursor-pointer">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </Label>
    </div>
  );
}
