import { z } from "zod";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./constants";

/**
 * Shared Zod shapes for the sign-in / sign-up forms.
 *
 * The same shapes run on:
 *   - the client (instant inline validation in the form components),
 *   - the server (`lib/auth/actions.ts` `safeParse` before any DB work),
 *   - tests (`tests/auth/*` to assert the rules don't drift).
 *
 * If you change a rule here, the message in `lib/auth/actions.ts` is
 * the one users actually see — keep them aligned.
 */

export const passwordRules = {
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
  requireDigit: true,
} as const;

export const passwordFieldSchema = z
  .string()
  .min(passwordRules.minLength, `Use at least ${passwordRules.minLength} characters.`)
  .max(passwordRules.maxLength, "Password is too long.")
  .refine((v) => /\d/.test(v), "Include at least one number.");

/**
 * Trim + lowercase BEFORE `.email()` so a mobile keyboard's trailing
 * space (or paste with leading whitespace) normalizes cleanly instead
 * of failing the email shape check.
 */
export const emailFieldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter your email.")
  .max(320, "Email is too long.")
  .pipe(z.string().email("Enter a valid email address."));

export const signUpFormSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100, "Name is too long.")
    .optional()
    .or(z.literal("")),
  email: emailFieldSchema,
  password: passwordFieldSchema,
});
export type SignUpFormValues = z.infer<typeof signUpFormSchema>;

export const signInFormSchema = z.object({
  email: emailFieldSchema,
  password: z.string().min(1, "Enter your password."),
});
export type SignInFormValues = z.infer<typeof signInFormSchema>;
