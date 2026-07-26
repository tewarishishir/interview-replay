"use client";

import { Loader2, Plus, Save, Trash2, Upload } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ProfileCompany,
  ProfileEducation,
  ProfileTechnology,
  TechProficiency,
} from "@/lib/db/schema";
import {
  PROFILE_LIMITS,
  TECH_PROFICIENCY_OPTIONS,
} from "@/lib/profiles/constants";
import type { ProfileDto, ResumeParseJobDto } from "@/lib/profiles/dto";
import {
  ApiError,
  patchProfile,
  pollResumeParseJob,
  uploadResumePdf,
} from "@/lib/profiles/api-client";
import { RESUME_MAX_BYTES } from "@/lib/profiles/schemas";

interface ResumeSectionProps {
  profile: ProfileDto;
  initialLatestParseJob: ResumeParseJobDto | null;
  onSaved: (next: ProfileDto) => void;
}

type LocalCompany = ProfileCompany & { _key: string };
type LocalTechnology = ProfileTechnology & { _key: string };
type LocalEducation = ProfileEducation & { _key: string };

let _key = 0;
const k = () => `k${++_key}`;

/**
 * Section 1: Resume import.
 *
 * Two states:
 *   1. The candidate has no parsed draft and no saved profile data
 *      → upload area + "Skip upload, fill manually" link.
 *   2. The candidate has a draft (from a finished parse job) OR
 *      already-saved data → editable form fields. Save persists
 *      via PATCH /api/profile.
 *
 * The polling state machine for an in-flight parse job lives
 * here: when an upload returns 202 we kick off `setInterval`-style
 * polling against the GET endpoint, swap the UI to a "parsing…"
 * banner, and on completion seed the editable form with the
 * draft's values.
 */
export function ResumeSection({
  profile,
  initialLatestParseJob,
  onSaved,
}: ResumeSectionProps) {
  // Form state, seeded from the existing profile or from a parsed draft.
  const [yearsOfExperience, setYearsOfExperience] = useState<string>(
    profile.yearsOfExperience == null ? "" : String(profile.yearsOfExperience),
  );
  const [currentRole, setCurrentRole] = useState(profile.currentRole ?? "");
  const [professionalSummary, setProfessionalSummary] = useState<string>(
    profile.professionalSummary ?? "",
  );
  const [companies, setCompanies] = useState<LocalCompany[]>(() =>
    profile.companies.map((c) => ({
      ...c,
      // Legacy rows (saved before this column existed) come back
      // with `description` undefined. Normalize to null so the
      // form binding is controlled and the submit path doesn't
      // accidentally serialize "undefined".
      description: c.description ?? null,
      _key: k(),
    })),
  );
  const [technologies, setTechnologies] = useState<LocalTechnology[]>(
    () => profile.technologies.map((t) => ({ ...t, _key: k() })),
  );
  const [education, setEducation] = useState<LocalEducation[]>(
    () => profile.education.map((e) => ({ ...e, _key: k() })),
  );
  const [showForm, setShowForm] = useState<boolean>(
    () =>
      profile.companies.length +
        profile.technologies.length +
        profile.education.length >
        0 ||
      profile.currentRole != null ||
      profile.yearsOfExperience != null ||
      (profile.professionalSummary?.trim().length ?? 0) > 0,
  );

  // Parse-job state.
  const [activeJob, setActiveJob] = useState<ResumeParseJobDto | null>(
    initialLatestParseJob &&
      ["pending", "processing"].includes(initialLatestParseJob.status)
      ? initialLatestParseJob
      : null,
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(
    initialLatestParseJob?.status === "failed"
      ? humanizeError(initialLatestParseJob.errorMessage)
      : null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Upload progress: tracks the multipart PUT to /api/profile/parse-resume.
  // null = not uploading; otherwise a 0-100 percentage we render below.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic token bumped on every upload start so a late
  // `onProgress` callback (e.g. from a request that already
  // resolved/rejected) can't resurrect the progress bar.
  const uploadTokenRef = useRef(0);

  // Apply a parsed draft to the form fields. Wipes any unsaved
  // edits — the upload action implies the user wants to redo.
  const applyDraft = useCallback(
    (draft: ResumeParseJobDto["draft"]) => {
      if (!draft) return;
      setYearsOfExperience(
        draft.years_of_experience == null
          ? ""
          : String(draft.years_of_experience),
      );
      setCurrentRole(draft.current_role ?? "");
      setProfessionalSummary(draft.professional_summary ?? "");
      setCompanies(
        draft.companies.map((c) => ({
          ...c,
          // The DB schema lets `description` be missing on legacy
          // rows; coerce undefined → null so the form binding is
          // controlled.
          description: c.description ?? null,
          _key: k(),
        })),
      );
      setTechnologies(draft.technologies.map((t) => ({ ...t, _key: k() })));
      setEducation(draft.education.map((e) => ({ ...e, _key: k() })));
      setShowForm(true);
    },
    [],
  );

  // Polling effect — runs while a job is in flight.
  useEffect(() => {
    if (!activeJob) return;
    if (!["pending", "processing"].includes(activeJob.status)) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const { job } = await pollResumeParseJob(activeJob.id);
        if (cancelled) return;
        if (job.status === "completed") {
          setActiveJob(null);
          setParseError(null);
          applyDraft(job.draft);
          return;
        }
        if (job.status === "failed") {
          setActiveJob(null);
          setParseError(humanizeError(job.errorMessage));
          return;
        }
        setActiveJob(job);
        timeout = setTimeout(tick, 2000);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 429) {
          // Back off to keep us under the polling limiter.
          timeout = setTimeout(tick, 8000);
        } else {
          timeout = setTimeout(tick, 4000);
        }
      }
    };

    timeout = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [activeJob, applyDraft]);

  /* ── Upload handlers ───────────────────────────────────────── */

  async function handleFile(file: File) {
    // Guard against concurrent uploads. Without this, a user who
    // drag-drops while a parse is still in flight would start a
    // second upload whose progress callbacks race the first one's
    // and leave the UI in a wedged state.
    if (uploadProgress != null || activeJob) {
      return;
    }
    setUploadError(null);
    setParseError(null);
    if (file.size === 0) {
      setUploadError("That file is empty. Choose a non-empty PDF.");
      return;
    }
    if (file.size > RESUME_MAX_BYTES) {
      setUploadError(
        `Resume must be ${RESUME_MAX_BYTES / (1024 * 1024)} MB or smaller.`,
      );
      return;
    }
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      setUploadError("Only PDF files are accepted.");
      return;
    }
    // Each call gets a stable token so a stale `onProgress` event
    // (e.g. from a previous upload that already settled) can't
    // resurrect the progress bar after we've moved on.
    const uploadToken = ++uploadTokenRef.current;
    setUploadProgress(0);
    try {
      const { job } = await uploadResumePdf(file, {
        onProgress: ({ loaded, total }) => {
          if (uploadTokenRef.current !== uploadToken) return;
          if (total > 0) {
            setUploadProgress(
              Math.min(100, Math.round((loaded / total) * 100)),
            );
          }
        },
      });
      if (uploadTokenRef.current !== uploadToken) return;
      // Once the upload is done the next phase ("Parsing…") owns the
      // status indicator. Drop the progress bar so we don't show two
      // overlapping loading affordances.
      setUploadProgress(null);
      // Normally the upload returns a `pending` job and the polling
      // effect drives the rest. The inline pipeline can return an
      // already-terminal job; handle each status the same way the
      // polling effect does so we don't strand the UI on a forever-
      // spinning "Parsing…" banner.
      if (job.status === "completed") {
        setActiveJob(null);
        setParseError(null);
        applyDraft(job.draft);
      } else if (job.status === "failed") {
        setActiveJob(null);
        setParseError(humanizeError(job.errorMessage));
      } else {
        setActiveJob(job);
      }
    } catch (err) {
      if (uploadTokenRef.current !== uploadToken) return;
      setUploadProgress(null);
      const msg =
        err instanceof ApiError ? err.message : "Could not upload the resume.";
      setUploadError(msg);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    // Refuse drops while an upload or parse is in flight — the
    // dropzone's visual `disabled` styling won't stop a determined
    // user from drag-dropping over it.
    if (uploadProgress != null || activeJob) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Allow re-selecting the same file later.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /* ── Save handler ──────────────────────────────────────────── */

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      // List rows: drop blank ones, then send the survivors. Empty
      // strings on the wire are coerced to `null` by the schema's
      // `optionalCleaned`, matching the DB shape.
      const cleanedCompanies = companies
        .map((c) => ({
          name: c.name,
          role: c.role ?? "",
          time_period: c.time_period ?? "",
          description: c.description ?? "",
        }))
        .filter((c) => c.name.trim().length > 0);
      const cleanedTechnologies = technologies
        .map((t) => ({
          name: t.name,
          years_used: t.years_used,
          proficiency: t.proficiency,
        }))
        .filter((t) => t.name.trim().length > 0);
      const cleanedEducation = education
        .map((e) => ({
          degree: e.degree ?? "",
          institution: e.institution ?? "",
          year: e.year,
          field: e.field,
        }))
        .filter(
          (e) =>
            e.degree.trim().length > 0 || e.institution.trim().length > 0,
        );

      const yoe =
        yearsOfExperience.trim() === "" ? null : Number(yearsOfExperience);
      const { profile: updated } = await patchProfile({
        yearsOfExperience: yoe,
        currentRole: currentRole.trim() || null,
        professionalSummary: professionalSummary.trim() || null,
        companies: cleanedCompanies,
        technologies: cleanedTechnologies,
        education: cleanedEducation,
        markResumeSaved: true,
      });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err.message);
      } else {
        setSaveError("Could not save resume.");
      }
    } finally {
      setSaving(false);
    }
  }

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col gap-5">
      {profile.resumeSavedAt ? (
        <Alert>
          <AlertTitle>Resume saved</AlertTitle>
          <AlertDescription>
            Saved on{" "}
            {new Date(profile.resumeSavedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
            . Re-upload to refresh.
          </AlertDescription>
        </Alert>
      ) : null}

      {uploadProgress != null ? (
        <Alert>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <AlertTitle>Uploading your resume…</AlertTitle>
          <AlertDescription>
            <span className="block text-xs text-muted-foreground">
              {uploadProgress}% uploaded
            </span>
            <Progress
              value={uploadProgress}
              className="mt-2"
              aria-label="Resume upload progress"
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {activeJob ? (
        <Alert>
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <AlertTitle>Parsing your resume…</AlertTitle>
          <AlertDescription>
            <span className="block">
              This usually takes 10-30 seconds. We&apos;ll show you the
              extracted draft below for you to confirm.
            </span>
            {/* Indeterminate-style progress: a steady visual rather
                than a bouncing animation, which can read as broken
                when parses run a hair longer than expected. */}
            <Progress
              value={100}
              className="mt-2 animate-pulse"
              aria-label="Resume parse progress"
            />
          </AlertDescription>
        </Alert>
      ) : null}

      {parseError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t parse that resume</AlertTitle>
          <AlertDescription>
            {parseError} You can re-upload or fill the form manually below.
          </AlertDescription>
        </Alert>
      ) : null}

      <UploadDropzone
        disabled={Boolean(activeJob) || uploadProgress != null}
        onDrop={onDrop}
        onPick={() => fileInputRef.current?.click()}
        onSkip={() => setShowForm(true)}
        showSkip={!showForm}
      />
      {uploadError ? (
        <p className="text-sm text-destructive" role="alert">
          {uploadError}
        </p>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={onFilePicked}
      />

      {showForm ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="yoe">Years of experience</Label>
              <Input
                id="yoe"
                type="number"
                inputMode="numeric"
                min={PROFILE_LIMITS.yoeMin}
                max={PROFILE_LIMITS.yoeMax}
                value={yearsOfExperience}
                onChange={(e) => setYearsOfExperience(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="current-role">Current role</Label>
              <Input
                id="current-role"
                value={currentRole}
                onChange={(e) => setCurrentRole(e.target.value)}
                placeholder="Senior Software Engineer"
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="professional-summary">Professional summary</Label>
            <p className="text-xs text-muted-foreground">
              The 2-4 sentence headline a recruiter reads first.
              We&apos;ll use it as context when scoring your interviews.
            </p>
            <Textarea
              id="professional-summary"
              value={professionalSummary}
              onChange={(e) => setProfessionalSummary(e.target.value)}
              placeholder="Senior backend engineer with 8 years building payments infrastructure at scale…"
              rows={3}
              maxLength={PROFILE_LIMITS.professionalSummaryMax}
              className="mt-2"
            />
          </div>

          <ListEditor
            label="Companies"
            recommendation="Most-recent first. Add a few bullets describing what you owned."
            items={companies}
            limit={PROFILE_LIMITS.companiesMax}
            onChange={setCompanies}
            renderRow={(item, update) => (
              <div className="flex flex-col gap-2">
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    aria-label="Company"
                    placeholder="Razorpay"
                    value={item.name}
                    onChange={(e) => update({ ...item, name: e.target.value })}
                  />
                  <Input
                    aria-label="Role"
                    placeholder="Staff Engineer"
                    value={item.role ?? ""}
                    onChange={(e) =>
                      update({ ...item, role: e.target.value || null })
                    }
                  />
                  <Input
                    aria-label="Time period"
                    placeholder="2021 — Present"
                    value={item.time_period ?? ""}
                    onChange={(e) =>
                      update({
                        ...item,
                        time_period: e.target.value || null,
                      })
                    }
                  />
                </div>
                <Textarea
                  aria-label="What you did at this company"
                  placeholder="Led the migration of the billing pipeline to event-sourced ledgers; reduced reconciliation latency from 6h to 5m."
                  value={item.description ?? ""}
                  onChange={(e) =>
                    update({
                      ...item,
                      description: e.target.value || null,
                    })
                  }
                  rows={2}
                  maxLength={PROFILE_LIMITS.companyDescriptionMax}
                />
              </div>
            )}
            blank={() => ({
              name: "",
              role: null,
              time_period: null,
              description: null,
              _key: k(),
            })}
          />

          <ListEditor
            label="Technologies"
            recommendation="Things you'd be comfortable being asked about."
            items={technologies}
            limit={PROFILE_LIMITS.technologiesMax}
            onChange={setTechnologies}
            renderRow={(item, update) => (
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label="Technology"
                  placeholder="TypeScript"
                  value={item.name}
                  onChange={(e) => update({ ...item, name: e.target.value })}
                />
                <Input
                  aria-label="Years used"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={60}
                  placeholder="Years"
                  value={item.years_used == null ? "" : String(item.years_used)}
                  onChange={(e) =>
                    update({
                      ...item,
                      years_used:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
                <Select
                  value={item.proficiency ?? ""}
                  onValueChange={(v) =>
                    update({
                      ...item,
                      proficiency: (v || null) as TechProficiency | null,
                    })
                  }
                >
                  <SelectTrigger aria-label="Proficiency">
                    <SelectValue placeholder="Proficiency" />
                  </SelectTrigger>
                  <SelectContent>
                    {TECH_PROFICIENCY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            blank={() => ({
              name: "",
              years_used: null,
              proficiency: null,
              _key: k(),
            })}
          />

          <ListEditor
            label="Education"
            recommendation="Degrees, bootcamps, certifications."
            items={education}
            limit={PROFILE_LIMITS.educationMax}
            onChange={setEducation}
            renderRow={(item, update) => (
              <div className="grid gap-2 sm:grid-cols-4">
                <Input
                  aria-label="Degree"
                  placeholder="B.S."
                  value={item.degree ?? ""}
                  onChange={(e) =>
                    update({ ...item, degree: e.target.value || null })
                  }
                />
                <Input
                  aria-label="Institution"
                  placeholder="MIT"
                  value={item.institution ?? ""}
                  onChange={(e) =>
                    update({ ...item, institution: e.target.value || null })
                  }
                />
                <Input
                  aria-label="Field"
                  placeholder="Computer Science"
                  value={item.field ?? ""}
                  onChange={(e) =>
                    update({ ...item, field: e.target.value || null })
                  }
                />
                <Input
                  aria-label="Year"
                  type="number"
                  inputMode="numeric"
                  min={1900}
                  max={2100}
                  placeholder="Year"
                  value={item.year == null ? "" : String(item.year)}
                  onChange={(e) =>
                    update({
                      ...item,
                      year: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            )}
            blank={() => ({
              degree: null,
              institution: null,
              year: null,
              field: null,
              _key: k(),
            })}
          />

          {saveError ? (
            <p className="text-sm text-destructive" role="alert">
              {saveError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Save className="size-4" aria-hidden />
              )}
              Save resume
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Sub-components                                                 */
/* ────────────────────────────────────────────────────────────── */

function UploadDropzone(props: {
  disabled: boolean;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: () => void;
  onSkip: () => void;
  showSkip: boolean;
}) {
  // Block both `drop` and `dragover` while disabled. `dragover` is
  // what tells the browser this is a valid drop target — refusing
  // it draws the "no drop" cursor and prevents `drop` from firing
  // at all.
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (props.disabled) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (props.disabled) {
      e.preventDefault();
      return;
    }
    props.onDrop(e);
  };
  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      aria-disabled={props.disabled}
      className={
        "rounded-lg border-2 border-dashed border-border bg-muted/20 p-6 text-center" +
        (props.disabled ? " opacity-60" : "")
      }
    >
      <Upload className="mx-auto size-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">Drop a resume PDF here</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Up to {RESUME_MAX_BYTES / (1024 * 1024)} MB. We&apos;ll extract a draft
        you can confirm before saving.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onPick}
          disabled={props.disabled}
        >
          Browse for a file
        </Button>
        {props.showSkip ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onSkip}
            disabled={props.disabled}
          >
            Skip upload, fill manually
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface ListEditorProps<T extends { _key: string }> {
  label: string;
  recommendation: string;
  items: T[];
  limit: number;
  onChange: (next: T[]) => void;
  renderRow: (item: T, update: (next: T) => void) => React.ReactNode;
  blank: () => T;
}

function ListEditor<T extends { _key: string }>(props: ListEditorProps<T>) {
  function update(idx: number, next: T) {
    const list = props.items.slice();
    list[idx] = next;
    props.onChange(list);
  }

  function remove(idx: number) {
    props.onChange(props.items.filter((_, i) => i !== idx));
  }

  function add() {
    if (props.items.length >= props.limit) return;
    props.onChange([...props.items, props.blank()]);
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{props.label}</h3>
        <span className="text-xs text-muted-foreground">
          {props.items.length}/{props.limit}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{props.recommendation}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {props.items.map((item, idx) => (
          <li
            key={item._key}
            className="flex items-start gap-2 rounded-md border border-border p-2"
          >
            <div className="flex-1">{props.renderRow(item, (next) => update(idx, next))}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(idx)}
              aria-label={`Remove ${props.label.toLowerCase()} #${idx + 1}`}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {props.items.length < props.limit ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          className="mt-2"
        >
          <Plus className="size-4" aria-hidden /> Add {props.label.toLowerCase()}
        </Button>
      ) : null}
    </div>
  );
}

function humanizeError(raw: string | null): string {
  if (!raw) return "Something went wrong while parsing.";
  // Strip the leading code: "resume_parse_invalid_output: ..." → ".".
  const idx = raw.indexOf(":");
  if (idx > 0 && idx < 60) {
    return raw.slice(idx + 1).trim() || raw;
  }
  return raw;
}
