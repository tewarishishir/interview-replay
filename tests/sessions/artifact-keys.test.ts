/**
 * Pure unit tests for the artifact-image URL parser.
 *
 * The host-allowlist guard is the only thing standing between an
 * attacker who's uploaded one legitimate image and the ability to
 * store an `evil.com` URL against their own artifact row — which
 * would then render via `<img src>` and leak viewer IP / UA on every
 * read. Its rules deserve their own focused suite.
 */
import { describe, expect, it } from "vitest";

import {
  type ArtifactImageHostSpec,
  parseArtifactImageUrl,
} from "@/lib/storage/artifact-keys";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

const virtualHosted: ArtifactImageHostSpec[] = [
  { kind: "virtual-hosted", bucket: "ir-artifacts", region: "us-east-1" },
];

const pathStyle: ArtifactImageHostSpec[] = [
  { kind: "path-style", endpointHost: "minio.local:9000", bucket: "ir-artifacts" },
];

describe("parseArtifactImageUrl - virtual-hosted shape", () => {
  it("accepts a virtual-hosted URL with the expected host", () => {
    const url =
      `https://ir-artifacts.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBe(
      `artifacts/${USER}/${SESSION}/${FILE}.png`,
    );
  });

  it("rejects a foreign host with a path that contains artifacts/...", () => {
    // This is the host-spoofing attack: the path matches the shape
    // of a real key, but the host points at attacker-controlled
    // infra. Pre-fix, the parser scanned for `artifacts/` anywhere
    // in the pathname and returned a key — the validator would then
    // HEAD our bucket (success) and store the evil URL in the DB.
    const url =
      `https://evil.example.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a URL whose host is the wrong bucket subdomain", () => {
    const url =
      `https://other-bucket.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a URL whose host is in the wrong region", () => {
    const url =
      `https://ir-artifacts.s3.eu-west-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a URL whose path does not start with artifacts/", () => {
    // Even with the correct host, an arbitrary path is a bug or
    // exploit attempt — we mint keys only under `artifacts/`.
    const url =
      `https://ir-artifacts.s3.us-east-1.amazonaws.com/junk/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a non-http(s) protocol", () => {
    const url =
      `javascript://ir-artifacts.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a URL carrying a query string", () => {
    const url =
      `https://ir-artifacts.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png?x=1`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a URL carrying a fragment", () => {
    const url =
      `https://ir-artifacts.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png#bad`;
    expect(parseArtifactImageUrl(url, virtualHosted)).toBeNull();
  });

  it("rejects a malformed URL", () => {
    expect(parseArtifactImageUrl("not a url", virtualHosted)).toBeNull();
  });

  it("rejects every URL when the allowlist is empty", () => {
    const url =
      `https://ir-artifacts.s3.us-east-1.amazonaws.com/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, [])).toBeNull();
  });
});

describe("parseArtifactImageUrl - path-style shape (MinIO/R2)", () => {
  it("accepts a path-style URL with the expected endpoint + bucket", () => {
    const url =
      `https://minio.local:9000/ir-artifacts/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, pathStyle)).toBe(
      `artifacts/${USER}/${SESSION}/${FILE}.png`,
    );
  });

  it("rejects a path-style URL pointed at a different bucket", () => {
    const url =
      `https://minio.local:9000/other-bucket/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, pathStyle)).toBeNull();
  });

  it("rejects a path-style URL on a foreign host", () => {
    const url =
      `https://evil.example.com/ir-artifacts/artifacts/${USER}/${SESSION}/${FILE}.png`;
    expect(parseArtifactImageUrl(url, pathStyle)).toBeNull();
  });

  it("rejects a path-style URL whose path-after-bucket does not start with artifacts/", () => {
    const url =
      `https://minio.local:9000/ir-artifacts/audio/${USER}/${SESSION}/${FILE}.webm`;
    expect(parseArtifactImageUrl(url, pathStyle)).toBeNull();
  });
});
