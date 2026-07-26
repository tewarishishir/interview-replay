import "server-only";

import { hash, verify } from "@node-rs/argon2";

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";

/**
 * Argon2id parameters.
 *
 * Per spec: memory 64 MiB, iterations 3, parallelism 4. These are heavier
 * than the OWASP 2023 minimum (19 MiB / 2 / 1) and well within the
 * "interactive auth" budget on a modern server (~100–250 ms per hash on
 * 8-core hardware). If you're tuning for a much smaller deployment,
 * lower `memoryCost` first — it's the dominant cost.
 *
 * The exact numbers are versioned with the hash itself in the encoded
 * string `argon2id$v=19$m=65536,t=3,p=4$...`, so changing them later is
 * safe — old hashes still verify with their original parameters.
 */
const ARGON2_OPTS = {
  memoryCost: 65_536, // 64 MiB (kibibytes)
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Cached argon2id hash of a throwaway password. Used to equalize response
 * time on failed sign-in attempts where the user doesn't exist (or has no
 * password hash), defeating user-enumeration via timing.
 */
let dummyHashPromise: Promise<string> | null = null;
const getDummyHash = (): Promise<string> => {
  dummyHashPromise ??= hash(
    "ir-dummy-password-do-not-use-ever",
    ARGON2_OPTS,
  );
  return dummyHashPromise;
};

export const hashPassword = (password: string): Promise<string> =>
  hash(password, ARGON2_OPTS);

/**
 * Constant-ish-time password check. Always runs exactly one argon2 verify,
 * whether or not we found a user, so attackers can't distinguish
 * "no such user" from "wrong password" by timing.
 */
export const verifyPassword = async (
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> => {
  if (!storedHash) {
    await verify(await getDummyHash(), password);
    return false;
  }
  try {
    return await verify(storedHash, password);
  } catch {
    // Malformed hash in the DB — treat as failed auth rather than 500.
    return false;
  }
};
