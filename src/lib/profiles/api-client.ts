"use client";

import type { ProfileDto, ProjectDto, ResumeParseJobDto, StoryDto } from "@/lib/profiles/dto";
import type {
  ProfileExcludeBody,
  ProfilePatchInput,
  ProjectCreateInput,
  ProjectPatchInput,
  StoryCreateInput,
  StoryPatchInput,
} from "@/lib/profiles/schemas";

import type { SuggestedResponse } from "@/lib/rebuilds/schemas";
import type { CritiqueResponse } from "@/lib/rebuilds/schemas";

/**
 * Thin client-side wrappers around `/api/profile/*`,
 * `/api/projects/*`, `/api/stories/*`,
 * `/api/profile/parse-resume*`.
 *
 * Why have a wrapper at all rather than inlining `fetch()` in the
 * components:
 *   - One place to coerce the Response → typed DTO + throw on
 *     error, so every form has the same error UX.
 *   - One place to send the standard headers (`Content-Type:
 *     application/json`, `credentials: same-origin`) without
 *     repeating boilerplate.
 *   - Tests can mock this module instead of intercepting global
 *     `fetch` (faster + scoped).
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const b = (body ?? {}) as {
      error?: string;
      message?: string;
      fieldErrors?: Record<string, string>;
    };
    throw new ApiError(
      res.status,
      b.error ?? "request_failed",
      b.message ?? `Request failed (${res.status})`,
      b.fieldErrors,
    );
  }
  return body as T;
}

/* ─── Profile ──────────────────────────────────────────────── */

export async function fetchProfile(): Promise<{ profile: ProfileDto }> {
  return jsonRequest<{ profile: ProfileDto }>("/api/profile");
}

export async function patchProfile(
  patch: ProfilePatchInput,
): Promise<{ profile: ProfileDto }> {
  return jsonRequest<{ profile: ProfileDto }>("/api/profile", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function patchProfileExclusion(
  body: ProfileExcludeBody,
): Promise<{ profile: ProfileDto }> {
  return jsonRequest<{ profile: ProfileDto }>("/api/profile/exclude", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/* ─── Projects ─────────────────────────────────────────────── */

export async function fetchProjects(): Promise<{
  projects: ProjectDto[];
  limits: { max: number; recommendedMin: number };
}> {
  return jsonRequest("/api/projects");
}

export async function postProject(
  body: ProjectCreateInput,
): Promise<{ project: ProjectDto }> {
  return jsonRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchProject(
  id: string,
  body: ProjectPatchInput,
): Promise<{ project: ProjectDto }> {
  return jsonRequest(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await jsonRequest(`/api/projects/${id}`, { method: "DELETE" });
}

export async function reorderProjects(
  projectIdsInOrder: string[],
): Promise<{ projects: ProjectDto[] }> {
  return jsonRequest("/api/projects/reorder", {
    method: "PATCH",
    body: JSON.stringify({ project_ids_in_order: projectIdsInOrder }),
  });
}

/* ─── Stories ──────────────────────────────────────────────── */

export async function fetchStories(): Promise<{ stories: StoryDto[] }> {
  return jsonRequest("/api/stories");
}

export async function postStory(
  body: StoryCreateInput,
): Promise<{ story: StoryDto }> {
  return jsonRequest("/api/stories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchStory(
  id: string,
  body: StoryPatchInput,
): Promise<{ story: StoryDto }> {
  return jsonRequest(`/api/stories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteStory(id: string): Promise<void> {
  await jsonRequest(`/api/stories/${id}`, { method: "DELETE" });
}

/* ─── Bank-surface "AI suggested response" ─────────────────── */

/**
 * Generate (or regenerate) an AI suggested response for a saved
 * story. Two response shapes share this endpoint:
 *
 *   - `passedGuardrails: true` — the model returned a grounded
 *     draft. `aiSuggestedResponse` carries the new persisted
 *     suggestion. `syntheticSuggestion` is null. `creditsCharged`
 *     is 0 or 1 depending on accumulator rollover.
 *
 *   - `passedGuardrails: false` — schema parse / verbatim
 *     guardrail tripped. The server did NOT touch the story row
 *     (so any previously cached `aiSuggestedResponse` is
 *     preserved), did NOT bump the 10/24h gate, and did NOT
 *     charge. `aiSuggestedResponse` echoes the unchanged cached
 *     value. `syntheticSuggestion` carries a placeholder STAR
 *     shell the UI can show alongside a "try again" caveat.
 */
export async function postStorySuggestResponse(id: string): Promise<{
  story: { id: string };
  aiSuggestedResponse: SuggestedResponse | null;
  aiSuggestedResponseGeneratedAt: string | null;
  syntheticSuggestion: SuggestedResponse | null;
  passedGuardrails: boolean;
  creditsCharged: 0 | 1;
  balanceAfter: number | null;
}> {
  return jsonRequest(`/api/stories/${id}/suggest-response`, {
    method: "POST",
  });
}

/**
 * Form-time draft generation. Used by the Add-Story form to
 * prefill the STAR textareas with an AI-drafted starting point.
 * Ephemeral — the suggestion is NOT persisted anywhere. The
 * user's edits + final save creates the canonical record.
 *
 * Inputs: the title the user has typed (used as the implicit
 * interview question) + the theme of the form's group.
 *
 * On `passedGuardrails: false`, no charge — the form should
 * show a "try again" message and keep the user's typed title.
 */
export async function postStoryDraftSuggestion(args: {
  title: string;
  theme: string;
}): Promise<{
  suggestion: SuggestedResponse;
  passedGuardrails: boolean;
  creditsCharged: 0 | 1;
  balanceAfter: number | null;
}> {
  return jsonRequest("/api/stories/draft-suggestion", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/**
 * Story-bank critique. Submits an in-progress STAR draft for AI
 * feedback without requiring a saved story or a rebuild context.
 * The critique is ephemeral — the response is never persisted. The
 * user can run this before saving their story to get early feedback.
 *
 * Response shape mirrors the rebuild critique route:
 *   - `critique` contains the `CritiqueResponse` (six dimensions for
 *     story-bank vs. seven for rebuild — `behavioral_change` is
 *     omitted since there's no interview question context).
 *   - `passedGuardrails` / `guardrailTripCount` surface model quality.
 *   - `creditsCharged` / `balanceAfter` let the UI refresh the
 *     balance pill without a follow-up fetch.
 */
export async function postStoryCritique(args: {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
}): Promise<{
  critique: CritiqueResponse;
  passedGuardrails: boolean;
  guardrailTripCount: number;
  creditsCharged: 0 | 1;
  balanceAfter: number | null;
}> {
  return jsonRequest("/api/stories/critique", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/**
 * Story-bank "Apply suggestions" enhance. Rewrites an in-progress
 * STAR draft by applying the suggestions from a prior critique
 * response. Stateless — no story row is required, and nothing is
 * persisted. The caller overwrites its form textareas with the
 * returned enhanced fields.
 *
 * Response:
 *   - `enhanced` contains the rewritten STAR fields (situation, task,
 *     action, result, whatILearned).
 *   - `creditsCharged` / `balanceAfter` let the UI refresh the
 *     balance pill without a follow-up fetch.
 */
export async function postStoryEnhance(args: {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  whatILearned: string;
  critique: CritiqueResponse;
}): Promise<{
  enhanced: {
    situation: string;
    task: string;
    action: string;
    result: string;
    whatILearned: string;
  };
  creditsCharged: 0 | 1;
  balanceAfter: number | null;
}> {
  return jsonRequest("/api/stories/enhance", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/* ─── Resume parsing ───────────────────────────────────────── */

export interface UploadResumeOptions {
  /**
   * Called with the byte-progress of the multipart upload. The
   * caller uses this to render a determinate progress bar while
   * the PDF is in flight. Falls back to indeterminate (the caller
   * never gets called) when the browser can't report progress.
   */
  onProgress?: (progress: { loaded: number; total: number }) => void;
  /** Optional AbortSignal so callers can cancel an in-flight upload. */
  signal?: AbortSignal;
}

export async function uploadResumePdf(
  file: File,
  options: UploadResumeOptions = {},
): Promise<{ job: ResumeParseJobDto }> {
  const form = new FormData();
  form.append("file", file);

  // We use XHR (not fetch) here because the standard `fetch` API
  // doesn't expose upload progress events. The 5 MB cap means
  // most uploads finish in well under a second on broadband, but
  // a slow connection can take 10+ seconds — without a visible
  // progress indicator the dropzone looks frozen.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const settleResolve = (value: { job: ResumeParseJobDto }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: ApiError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      xhr.abort();
    };
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    try {
      xhr.open("POST", "/api/profile/parse-resume", true);
      xhr.withCredentials = true;
      // We DON'T set responseType = "json" because invalid JSON
      // bodies (e.g. a 502 HTML page from an upstream proxy) would
      // be silently coerced to `null`, hiding diagnostic context.
      // Parse the body ourselves below.
    } catch (err) {
      settleReject(
        new ApiError(
          0,
          "request_open_failed",
          (err as Error).message || "Could not open the upload request.",
        ),
      );
      return;
    }

    if (options.onProgress) {
      xhr.upload.addEventListener("progress", (e) => {
        if (settled) return;
        if (e.lengthComputable) {
          options.onProgress?.({ loaded: e.loaded, total: e.total });
        }
      });
    }

    if (options.signal) {
      if (options.signal.aborted) {
        settleReject(new ApiError(0, "aborted", "Upload was cancelled."));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.addEventListener("load", () => {
      const status = xhr.status;
      const text = typeof xhr.responseText === "string" ? xhr.responseText : "";
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON response body (e.g. proxy error page). Leave
          // body=null; we fall back to a generic message below.
        }
      }
      if (status >= 200 && status < 300) {
        if (
          body &&
          typeof body === "object" &&
          "job" in (body as Record<string, unknown>)
        ) {
          settleResolve(body as { job: ResumeParseJobDto });
        } else {
          settleReject(
            new ApiError(
              status,
              "resume_upload_invalid_response",
              "Server returned an unexpected response shape.",
            ),
          );
        }
        return;
      }
      const b = (body ?? {}) as { error?: string; message?: string };
      settleReject(
        new ApiError(
          status,
          b.error ?? "resume_upload_failed",
          b.message ?? `Resume upload failed (${status})`,
        ),
      );
    });

    xhr.addEventListener("error", () => {
      settleReject(
        new ApiError(0, "network_error", "Network error while uploading."),
      );
    });

    xhr.addEventListener("timeout", () => {
      settleReject(
        new ApiError(0, "timeout", "The upload timed out. Try again."),
      );
    });

    xhr.addEventListener("abort", () => {
      settleReject(new ApiError(0, "aborted", "Upload was cancelled."));
    });

    try {
      xhr.send(form);
    } catch (err) {
      // `send` can throw synchronously (e.g. CSP block, rare network
      // adapter bugs). Without this, the promise would never settle.
      settleReject(
        new ApiError(
          0,
          "request_send_failed",
          (err as Error).message || "Could not start the upload.",
        ),
      );
    }
  });
}

export async function pollResumeParseJob(
  jobId: string,
): Promise<{ job: ResumeParseJobDto }> {
  return jsonRequest(`/api/profile/parse-resume/${jobId}`);
}
