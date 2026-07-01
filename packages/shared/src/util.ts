/**
 * Utilidades base del package. Mantenidas mínimas para no especular
 * abstracciones antes de que el tracer bullet las justifique.
 */

export const PACKAGE_NAME = "@ams/shared" as const;

/** Check que un string sea no vacío tras trim. Usado por guards del write-side. */
export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
