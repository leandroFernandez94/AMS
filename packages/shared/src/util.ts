/**
 * Base utilities for the package. Kept minimal so we do not speculate
 * abstractions before the tracer bullet justifies them.
 */

export const PACKAGE_NAME = "@ams/shared" as const;

/** Checks that a string is non-empty after trimming. Used by write-side guards. */
export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
