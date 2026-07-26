"use client";

// Type-only imports from server-only modules are erased at compile
// time, so they don't trigger the `server-only` runtime guard. The
// shapes below are the wire surface the API routes already publish.
import type {
  CreateRebuildInput,
  PatchRebuildInput,
  SaveToBankInput,
  SuggestedResponse,
} from "./schemas";
import type { RebuildDto, SavedToBankDto } from "./dto";

/**
 * Client-side wrappers around `/api/rebuilds/*`.
 *
 * Mirrors the shape of `lib/profiles/api-client.ts` so the
 * forms in `components/app/rebuild-flow.tsx` import a tight,
 * typed surface and don't repeat `fetch` boilerplate. The
 * shared `RebuildApiError` is what the form's catch blocks
 * narrow on.
 */

export class RebuildApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
    public readonly retryAfter?: number,
    public readonly missing?: ReadonlyArray<string>,
  ) {
    super(message);
    this.name = "RebuildApiError";
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
      retryAfter?: number;
      missing?: ReadonlyArray<string>;
    };
    throw new RebuildApiError(
      res.status,
      b.error ?? "request_failed",
      b.message ?? `Request failed (${res.status})`,
      b.fieldErrors,
      b.retryAfter,
      b.missing,
    );
  }
  return body as T;
}

export async function postRebuild(
  input: CreateRebuildInput,
): Promise<{ rebuild: RebuildDto }> {
  return jsonRequest("/api/rebuilds", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getRebuildClient(
  id: string,
): Promise<{ rebuild: RebuildDto }> {
  return jsonRequest(`/api/rebuilds/${id}`, { method: "GET" });
}

export async function patchRebuildClient(
  id: string,
  patch: PatchRebuildInput,
): Promise<{ rebuild: RebuildDto }> {
  return jsonRequest(`/api/rebuilds/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteRebuildClient(id: string): Promise<void> {
  await jsonRequest(`/api/rebuilds/${id}`, { method: "DELETE" });
}

export async function postCritique(
  id: string,
): Promise<{
  rebuild: RebuildDto;
  passedGuardrails: boolean;
  guardrailTripCount: number;
}> {
  return jsonRequest(`/api/rebuilds/${id}/critique`, { method: "POST" });
}

export async function postEnhance(
  id: string,
): Promise<{
  rebuild: RebuildDto;
}> {
  return jsonRequest(`/api/rebuilds/${id}/enhance`, { method: "POST" });
}

/**
 * `input` is optional — the scaffold-step "Save without critique"
 * shortcut omits it so the server falls back to deriving the
 * theme from `rebuild.questionTheme`. The critique-step CTA
 * always passes `{ theme }` from its dedicated Select.
 */
export async function postSaveToBank(
  id: string,
  input?: SaveToBankInput,
): Promise<SavedToBankDto> {
  return jsonRequest(`/api/rebuilds/${id}/save-to-bank`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/**
 * Generate (or regenerate) the AI suggested response for this
 * rebuild.
 *
 * Two response shapes share this endpoint:
 *
 *   - `passedGuardrails: true` — the model returned a grounded
 *     draft. `rebuild.aiSuggestedResponse` carries the new
 *     persisted suggestion. `syntheticSuggestion` is `null`.
 *
 *   - `passedGuardrails: false` — the model's response failed
 *     the schema parser or the verbatim-citation guardrail.
 *     The server did NOT touch the row (so a previously-good
 *     cached `aiSuggestedResponse` is preserved), did NOT bump
 *     the 10/24h gate. The `rebuild` echoed back is unchanged.
 *     `syntheticSuggestion` carries a placeholder STAR shell
 *     the UI can show alongside a "try again" caveat.
 */
export async function postSuggestResponse(id: string): Promise<{
  rebuild: RebuildDto;
  syntheticSuggestion: SuggestedResponse | null;
  passedGuardrails: boolean;
}> {
  return jsonRequest(`/api/rebuilds/${id}/suggest-response`, {
    method: "POST",
  });
}

export async function listRebuildsClient(query?: {
  status?: string;
  sessionId?: string;
}): Promise<{ rebuilds: RebuildDto[] }> {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.sessionId) params.set("session_id", query.sessionId);
  const qs = params.toString();
  return jsonRequest(`/api/rebuilds${qs ? `?${qs}` : ""}`, { method: "GET" });
}
