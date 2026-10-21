/**
 * Base utilities for the package. Kept minimal so we do not speculate
 * abstractions before the current scope justifies them.
 */

export const PACKAGE_NAME = "@ams/shared" as const;

/** HTTP header used to propagate a request correlation id across services. */
export const REQUEST_ID_HEADER = "x-request-id" as const;

/**
 * Generates a fresh correlation id. Uses the web-standard crypto global so the
 * shared package stays platform-agnostic (no node:crypto import); the cast is
 * needed because the shared tsconfig has no DOM lib.
 */
export function newRequestId(): string {
  const crypto = (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto;
  return `req_${crypto.randomUUID()}`;
}

/** Checks that a string is non-empty after trimming. Used by write-side guards. */
export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
