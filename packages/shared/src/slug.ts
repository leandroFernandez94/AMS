/**
 * Derivación de slugs y ids determinísticos para notas de decisión.
 *
 * El id canónico de una nota combina la fecha ISO con un slug derivado
 * del título. La regla es determinística: mismo (título, fecha) produce
 * siempre el mismo id y por ende el mismo path en el vault, lo que
 * habilita upserts idempotentes sin estado adicional.
 */

/**
 * Normaliza un texto arbitrario a un slug ASCII seguro para filesystems.
 *
 * Pasos:
 *  1. NFKD + remoción de marcas combinatorias (ñ -> n, é -> e).
 *  2. lowercasing.
 *  3. Todo lo que no sea [a-z0-9] se colapsa a un único `-`.
 *  4. Recorta guiones extremos.
 *
 * Entradas vacías o puramente simbólicas devuelven string vacío; quien
 * llame debe validar que el resultado no esté vacío.
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
 * Valida que una fecha tenga el formato ISO `YYYY-MM-DD` estricto.
 * No valida rango calendario (lo hace la capa de persistencia si lo
 * necesita); sólo el formato canónico para derivar ids estables.
 */
export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/**
 * Deriva el id canónico `<YYYY-MM-DD>-<slug(title)>`.
 * Lanza si la fecha no es ISO válida o si el slug resulta vacío
 * (título sin contenido alfanumérico usable).
 */
export function deriveId(title: string, date: string): string {
  if (!isIsoDate(date)) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  const slug = slugify(title);
  if (slug === "") {
    throw new Error(`Title produces empty slug: ${JSON.stringify(title)}`);
  }
  return `${date}-${slug}`;
}
