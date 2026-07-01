/**
 * AMS shared package — cross-package types and schemas.
 *
 * Placeholder surface until Spec 2 (decision note schema + vault model)
 * lands real types. Kept intentionally minimal so the monorepo wiring is
 * provable end-to-end without speculative abstractions.
 */

export const PACKAGE_NAME = "@ams/shared" as const;

/** Check that a string is non-empty after trimming. Used by write-side guards. */
export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
