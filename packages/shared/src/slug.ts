/**
 * Deterministic slug and id derivation for notes.
 *
 * The canonical id of a note is the slug derived from its title. The rule
 * is deterministic: the same title always yields the same id and therefore
 * the same vault path, enabling idempotent upserts without extra state
 * and unambiguous wikilink resolution. The creation date lives in
 * `frontmatter.date` only — it does not participate in the id.
 */

/**
 * Normalizes arbitrary text into a filesystem-safe ASCII slug.
 *
 * Steps:
 *  1. NFKD + strip combining marks (ñ -> n, é -> e).
 *  2. lowercasing.
 *  3. Anything that is not [a-z0-9] collapses to a single `-`.
 *  4. Trim leading/trailing dashes.
 *
 * Empty or symbol-only inputs return an empty string; callers must
 * validate that the result is non-empty.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates that a value matches the strict ISO `YYYY-MM-DD` format.
 * Does not validate calendar range (the persistence layer may do so if
 * needed); only the canonical format required for the frontmatter `date`
 * field.
 */
export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/**
 * Derives the canonical id `<slug(title)>`.
 * Throws if the slug ends up empty (a title with no usable alphanumeric
 * content).
 */
export function deriveId(title: string): string {
  const slug = slugify(title);
  if (slug === "") {
    throw new Error(`Title produces empty slug: ${JSON.stringify(title)}`);
  }
  return slug;
}
