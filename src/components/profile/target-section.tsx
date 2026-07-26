"use client";

import { Loader2, Save, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SuggestInput } from "@/components/ui/suggest-input";
import { Textarea } from "@/components/ui/textarea";
import { TARGET_LEVEL_OPTIONS } from "@/lib/profiles/constants";
import { TARGET_COMPANY_SUGGESTIONS } from "@/lib/profiles/companies";
import type { ProfileDto } from "@/lib/profiles/dto";
import { ApiError, patchProfile } from "@/lib/profiles/api-client";
import type { TargetLevel } from "@/lib/db/schema";

interface TargetSectionProps {
  profile: ProfileDto;
  onSaved: (next: ProfileDto) => void;
}

/**
 * Section 4: Target context.
 *
 * Three controls:
 *   1. Levels — checkbox grid of TARGET_LEVELS (Junior → Other).
 *   2. Target companies — pill input with autocomplete from the
 *      curated SUGGESTED_COMPANIES list (also accepts free text).
 *   3. Career narrative — multi-line textarea, max 500 words
 *      (validated client-side AND server-side).
 *
 * Save button at the bottom posts a PATCH that touches the three
 * target columns; the API stamps `target_updated_at` accordingly.
 */
export function TargetSection({ profile, onSaved }: TargetSectionProps) {
  const [levels, setLevels] = useState<TargetLevel[]>(profile.levels);
  const [companies, setCompanies] = useState<string[]>(profile.targetCompanies);
  const [draftCompany, setDraftCompany] = useState("");
  const [narrative, setNarrative] = useState(profile.careerNarrative ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordCount = useMemo(
    () => (narrative.trim().length === 0 ? 0 : narrative.trim().split(/\s+/u).length),
    [narrative],
  );
  const wordLimit = profile.limits.careerNarrativeMaxWords;
  const overWordLimit = wordCount > wordLimit;

  // Suggestions minus what the candidate has already added — keeps
  // the dropdown from offering a tag they already have.
  const companySuggestions = useMemo(
    () => TARGET_COMPANY_SUGGESTIONS.filter((c) => !companies.includes(c)),
    [companies],
  );

  function toggleLevel(level: TargetLevel, on: boolean) {
    setLevels((prev) =>
      on ? [...new Set([...prev, level])] : prev.filter((l) => l !== level),
    );
  }

  function commitCompany() {
    const cleaned = draftCompany.trim().slice(0, 200);
    if (!cleaned) return;
    if (companies.includes(cleaned)) {
      setDraftCompany("");
      return;
    }
    if (companies.length >= profile.limits.targetCompaniesMax) {
      return;
    }
    setCompanies((prev) => [...prev, cleaned]);
    setDraftCompany("");
  }

  function removeCompany(name: string) {
    setCompanies((prev) => prev.filter((c) => c !== name));
  }

  function onCompanyKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitCompany();
    } else if (e.key === "Backspace" && draftCompany === "" && companies.length) {
      e.preventDefault();
      setCompanies((prev) => prev.slice(0, -1));
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (overWordLimit) {
      setError(`Career narrative must be at most ${wordLimit} words.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // If a draft tag is sitting in the input, commit it before save.
      const finalCompanies = (() => {
        const cleaned = draftCompany.trim();
        if (!cleaned) return companies;
        if (companies.includes(cleaned)) return companies;
        if (companies.length >= profile.limits.targetCompaniesMax) {
          return companies;
        }
        return [...companies, cleaned];
      })();

      const { profile: updated } = await patchProfile({
        levels,
        targetCompanies: finalCompanies,
        careerNarrative: narrative,
      });
      setCompanies(updated.targetCompanies);
      setDraftCompany("");
      onSaved(updated);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Could not save target context.";
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div>
        <Label className="text-sm font-medium">Target levels</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick every level you&apos;re interviewing for.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TARGET_LEVEL_OPTIONS.map((opt) => {
            const id = `target-level-${opt.value}`;
            const checked = levels.includes(opt.value);
            return (
              <label
                key={opt.value}
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/40"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(v) => toggleLevel(opt.value, v === true)}
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium" htmlFor="target-companies-input">
          Target companies
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Press Enter or comma to add. Up to {profile.limits.targetCompaniesMax}.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-input bg-transparent p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
          {companies.map((c) => (
            <Badge
              key={c}
              variant="secondary"
              className="flex items-center gap-1 pl-2 pr-1"
            >
              {c}
              <button
                type="button"
                onClick={() => removeCompany(c)}
                aria-label={`Remove ${c}`}
                className="rounded-sm p-0.5 hover:bg-foreground/10"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <SuggestInput
            id="target-companies-input"
            value={draftCompany}
            onChange={(e) => setDraftCompany(e.target.value)}
            onKeyDown={onCompanyKeyDown}
            onBlur={commitCompany}
            onPick={(name) => {
              // Picking a suggestion commits it directly as a tag rather
              // than just stuffing the draft input — matches what the
              // existing Enter/comma behaviour does.
              if (companies.includes(name)) {
                setDraftCompany("");
                return;
              }
              if (companies.length >= profile.limits.targetCompaniesMax) {
                return;
              }
              setCompanies((prev) => [...prev, name]);
              setDraftCompany("");
            }}
            suggestions={companySuggestions}
            placeholder={
              companies.length ? "" : "Flipkart, Razorpay, Google, …"
            }
            wrapperClassName="flex-1"
            className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <Label className="text-sm font-medium" htmlFor="career-narrative">
            Career narrative
          </Label>
          <span
            className={
              overWordLimit
                ? "text-xs font-medium text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {wordCount}/{wordLimit} words
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          The pitch you&apos;re using when you apply — what you do, what
          you&apos;re looking for, why now.
        </p>
        <Textarea
          id="career-narrative"
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
          rows={6}
          className="mt-3"
          placeholder="I'm a senior backend engineer with 7 years across..."
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          Save target context
        </Button>
      </div>
    </form>
  );
}
