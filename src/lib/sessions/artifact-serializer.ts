import "server-only";

import type { Artifact } from "@/lib/db/schema";

/**
 * One serializer to rule them all for the artifact API surface.
 *
 * The collection POST, item PATCH, confirm/dismiss/restore actions,
 * and the SSR review/augment pages all need the same shape on the
 * wire. Without this helper we ended up with three near-identical
 * inline objects across the routes; adding a column (e.g.
 * `userConfirmedAt` for the AI-inferred review flow) meant a
 * three-place edit and at least one route shipped before the others.
 *
 * Keep this in sync with the `ArtifactDto` types on the client. If
 * a column is meaningful to the UI it goes here; if it's purely
 * server bookkeeping (e.g. internal timestamps the UI doesn't render)
 * we leave it out so the wire payload stays small.
 */
export interface SerializedArtifact {
  id: string;
  sessionId: string;
  artifactType: string;
  content: string | null;
  imageUrl: string | null;
  displayOrder: number;
  source: "user_added" | "ai_inferred";
  aiConfidence: "high" | "medium" | "low" | null;
  linkedTranscriptOffset: number | null;
  linkedTranscriptLength: number | null;
  userConfirmedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

export function serializeArtifact(row: Artifact): SerializedArtifact {
  return {
    id: row.id,
    sessionId: row.sessionId,
    artifactType: row.artifactType,
    content: row.content,
    imageUrl: row.imageUrl,
    displayOrder: row.displayOrder,
    source: row.source,
    aiConfidence: row.aiConfidence,
    linkedTranscriptOffset: row.linkedTranscriptOffset,
    linkedTranscriptLength: row.linkedTranscriptLength,
    userConfirmedAt: row.userConfirmedAt
      ? row.userConfirmedAt.toISOString()
      : null,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
