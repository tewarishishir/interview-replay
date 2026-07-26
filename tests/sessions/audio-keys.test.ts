/**
 * Pure unit tests for the local storage audio key builder + validator.
 *
 * The validator is the *only* thing standing between an attacker
 * who's discovered the bucket name and the ability to claim someone
 * else's upload — so its rules deserve their own focused suite.
 */
import { describe, expect, it } from "vitest";

import {
  buildAudioKey,
  parseAudioKey,
  audioUploadedBodySchema,
  AUDIO_KEY_PREFIX,
} from "@/lib/storage/keys";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

describe("buildAudioKey", () => {
  it("produces a key in the documented layout", () => {
    const key = buildAudioKey({
      userId: USER,
      sessionId: SESSION,
      fileUuid: FILE,
    });
    expect(key).toBe(`${AUDIO_KEY_PREFIX}/${USER}/${SESSION}/${FILE}.webm`);
  });

  it("rejects a non-UUID userId", () => {
    expect(() =>
      buildAudioKey({ userId: "alice", sessionId: SESSION, fileUuid: FILE }),
    ).toThrow(/invalid userId/);
  });

  it("rejects a non-UUID sessionId", () => {
    expect(() =>
      buildAudioKey({ userId: USER, sessionId: "not-a-uuid", fileUuid: FILE }),
    ).toThrow(/invalid sessionId/);
  });

  it("auto-generates a fileUuid when not provided", () => {
    const a = buildAudioKey({ userId: USER, sessionId: SESSION });
    const b = buildAudioKey({ userId: USER, sessionId: SESSION });
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^audio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webm$/,
    );
  });
});

describe("parseAudioKey", () => {
  it("round-trips a key from buildAudioKey", () => {
    const key = buildAudioKey({
      userId: USER,
      sessionId: SESSION,
      fileUuid: FILE,
    });
    const parsed = parseAudioKey(key);
    expect(parsed).toEqual({ userId: USER, sessionId: SESSION, fileUuid: FILE });
  });

  it("rejects keys missing the audio/ prefix", () => {
    // Even if all three UUIDs are present, omitting the prefix
    // means the client is making the key up. We reject so the
    // `uploaded` route returns 400.
    expect(parseAudioKey(`${USER}/${SESSION}/${FILE}.webm`)).toBeNull();
  });

  it("rejects keys with an extra path segment", () => {
    expect(
      parseAudioKey(`audio/something/${USER}/${SESSION}/${FILE}.webm`),
    ).toBeNull();
  });

  it("rejects keys with a wrong file extension", () => {
    expect(
      parseAudioKey(`audio/${USER}/${SESSION}/${FILE}.mp3`),
    ).toBeNull();
  });

  it("rejects keys with non-UUID segments", () => {
    expect(
      parseAudioKey(`audio/${USER}/not-a-session/${FILE}.webm`),
    ).toBeNull();
  });

  it("rejects keys that try to traverse upward via ..", () => {
    // Belt-and-suspenders — even if the regex would somehow match,
    // we never want a key with `..` in it.
    expect(
      parseAudioKey(`audio/${USER}/../${SESSION}/${FILE}.webm`),
    ).toBeNull();
  });

  it("normalizes parsed UUID segments to lowercase (regression)", () => {
    // The regex is case-insensitive so an uppercased key still
    // matches, but the route compares the parsed userId against the
    // auth-context userId (which is always lowercase). Without
    // explicit lowercasing here, a key with uppercase hex would
    // fail the equality check and 403 a legitimate upload.
    const upper = `audio/${USER.toUpperCase()}/${SESSION.toUpperCase()}/${FILE.toUpperCase()}.webm`;
    const parsed = parseAudioKey(upper);
    expect(parsed).toEqual({
      userId: USER,
      sessionId: SESSION,
      fileUuid: FILE,
    });
  });
});

describe("audioUploadedBodySchema", () => {
  it("accepts a well-formed body", () => {
    const result = audioUploadedBodySchema.safeParse({
      key: `audio/${USER}/${SESSION}/${FILE}.webm`,
      file_size_bytes: 12345,
      duration_seconds: 600,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a zero-byte upload (almost certainly a bug)", () => {
    const result = audioUploadedBodySchema.safeParse({
      key: `audio/${USER}/${SESSION}/${FILE}.webm`,
      file_size_bytes: 0,
      duration_seconds: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duration over the 6h ceiling", () => {
    const result = audioUploadedBodySchema.safeParse({
      key: `audio/${USER}/${SESSION}/${FILE}.webm`,
      file_size_bytes: 1024,
      duration_seconds: 6 * 60 * 60 + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a file size over the 1 GiB ceiling", () => {
    const result = audioUploadedBodySchema.safeParse({
      key: `audio/${USER}/${SESSION}/${FILE}.webm`,
      file_size_bytes: 1024 * 1024 * 1024 + 1,
      duration_seconds: 60,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer numeric fields", () => {
    const result = audioUploadedBodySchema.safeParse({
      key: `audio/${USER}/${SESSION}/${FILE}.webm`,
      file_size_bytes: 1.5,
      duration_seconds: 60,
    });
    expect(result.success).toBe(false);
  });
});
