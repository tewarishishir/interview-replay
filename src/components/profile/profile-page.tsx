"use client";

import { useCallback, useState } from "react";

import { CompletenessBanner } from "./completeness-banner";
import { ProjectsSection } from "./projects-section";
import { ResumeSection } from "./resume-section";
import { SectionShell } from "./section-shell";
import { TargetSection } from "./target-section";

import { PROFILE_SECTIONS } from "@/lib/profiles/constants";
import type {
  ProfileDto,
  ProjectDto,
  ResumeParseJobDto,
} from "@/lib/profiles/dto";
import {
  ApiError,
  patchProfileExclusion,
} from "@/lib/profiles/api-client";
import type {
  ProfileCompleteness,
} from "@/lib/queries/profiles";
import type { ProfileExcludeField } from "@/lib/profiles/schemas";

interface ProfilePageProps {
  initialProfile: ProfileDto;
  initialProjects: ProjectDto[];
  initialLatestParseJob: ResumeParseJobDto | null;
  initialSectionTimestamps: {
    resume: string | null;
    projects: string | null;
    target: string | null;
  };
  initialCompleteness: ProfileCompleteness;
}

const SECTION_BY_KEY = Object.fromEntries(
  PROFILE_SECTIONS.map((s) => [s.key, s] as const),
) as Record<(typeof PROFILE_SECTIONS)[number]["key"], typeof PROFILE_SECTIONS[number]>;

/**
 * Top-level client component. Owns:
 *   - Local mirrors of each slab (profile, projects, stories) so
 *     the four sub-sections can re-render independently after
 *     PATCH/POST/DELETE without the parent doing a full refetch.
 *   - The "exclude from analysis" toggle wiring (one route, four
 *     callers; centralized here for consistent error handling).
 *   - The completeness banner: re-derived from local state so it
 *     updates the moment any section saves.
 */
export function ProfilePage(props: ProfilePageProps) {
  const [profile, setProfile] = useState(props.initialProfile);
  const [projects, setProjects] = useState(props.initialProjects);
  const [completeness, setCompleteness] = useState(props.initialCompleteness);
  const [sectionTimestamps, setSectionTimestamps] = useState(
    props.initialSectionTimestamps,
  );
  const [exclusionError, setExclusionError] = useState<string | null>(null);

  /* ── Re-derive completeness whenever the slabs change ─────── */

  const recomputeCompleteness = useCallback(
    (next: { profile?: ProfileDto; projects?: ProjectDto[] }) => {
      const p = next.profile ?? profile;
      const proj = next.projects ?? projects;
      const resumeDone =
        p.currentRole != null ||
        p.yearsOfExperience != null ||
        p.companies.length > 0;
      const projectsDone = proj.length > 0;
      const targetDone =
        p.levels.length > 0 ||
        p.targetCompanies.length > 0 ||
        Boolean(p.careerNarrative);
      // `stories` is reported separately on /stories and stays on
      // the wire shape for backwards compat with the dashboard
      // pill, but the fraction is over 3 (resume / projects /
      // target). See `getProfileCompleteness` for the matching
      // server-side computation.
      const flags = {
        resume: resumeDone,
        projects: projectsDone,
        stories: completeness.stories,
        target: targetDone,
      };
      const filled = [resumeDone, projectsDone, targetDone].filter(
        Boolean,
      ).length;
      setCompleteness({ ...flags, fraction: filled / 3 });
    },
    [profile, projects, completeness.stories],
  );

  /* ── Section save handlers ────────────────────────────────── */

  const onProfileSaved = useCallback(
    (next: ProfileDto) => {
      setProfile(next);
      setSectionTimestamps((prev) => ({
        ...prev,
        resume: next.resumeUpdatedAt ?? prev.resume,
        target: next.targetUpdatedAt ?? prev.target,
      }));
      recomputeCompleteness({ profile: next });
    },
    [recomputeCompleteness],
  );

  const onProjectsChanged = useCallback(
    (next: ProjectDto[]) => {
      setProjects(next);
      // Use the freshest updated_at as the section timestamp.
      const latest = next.reduce<string | null>(
        (acc, p) => (acc == null || p.updatedAt > acc ? p.updatedAt : acc),
        null,
      );
      setSectionTimestamps((prev) => ({ ...prev, projects: latest ?? prev.projects }));
      recomputeCompleteness({ projects: next });
    },
    [recomputeCompleteness],
  );

  /* ── Exclusion toggle ─────────────────────────────────────── */

  const toggleExclusion = useCallback(
    async (field: ProfileExcludeField, excluded: boolean) => {
      setExclusionError(null);
      // Optimistic update.
      const prev = profile;
      const optimistic: ProfileDto = {
        ...prev,
        excludeResume:
          field === "resume" ? excluded : prev.excludeResume,
        excludeProjects:
          field === "projects" ? excluded : prev.excludeProjects,
        excludeStories:
          field === "stories" ? excluded : prev.excludeStories,
        excludeTarget:
          field === "target" ? excluded : prev.excludeTarget,
      };
      setProfile(optimistic);
      try {
        const { profile: persisted } = await patchProfileExclusion({
          field,
          excluded,
        });
        setProfile(persisted);
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : "Could not update exclusion.";
        setExclusionError(msg);
        setProfile(prev);
      }
    },
    [profile],
  );

  return (
    <div className="flex flex-col gap-4">
      <CompletenessBanner completeness={completeness} />

      {exclusionError ? (
        <p className="text-sm text-destructive" role="alert">
          {exclusionError}
        </p>
      ) : null}

      <SectionShell
        title={SECTION_BY_KEY.resume.title}
        description={SECTION_BY_KEY.resume.description}
        lastUpdated={sectionTimestamps.resume}
        excluded={profile.excludeResume}
        onToggleExcluded={(v) => toggleExclusion("resume", v)}
      >
        <ResumeSection
          profile={profile}
          initialLatestParseJob={props.initialLatestParseJob}
          onSaved={onProfileSaved}
        />
      </SectionShell>

      <SectionShell
        title={SECTION_BY_KEY.projects.title}
        description={SECTION_BY_KEY.projects.description}
        lastUpdated={sectionTimestamps.projects}
        excluded={profile.excludeProjects}
        onToggleExcluded={(v) => toggleExclusion("projects", v)}
        badge={
          <span className="text-xs text-muted-foreground">
            {projects.length}/{profile.limits.projectsMax}
          </span>
        }
      >
        <ProjectsSection projects={projects} onChange={onProjectsChanged} />
      </SectionShell>

      <SectionShell
        title={SECTION_BY_KEY.target.title}
        description={SECTION_BY_KEY.target.description}
        lastUpdated={sectionTimestamps.target}
        excluded={profile.excludeTarget}
        onToggleExcluded={(v) => toggleExclusion("target", v)}
      >
        <TargetSection profile={profile} onSaved={onProfileSaved} />
      </SectionShell>
    </div>
  );
}
