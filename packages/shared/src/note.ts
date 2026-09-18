/**
 * Data contract for a generic note — the base note type of the tracer
 * bullet. Every other spec (Write API, MCP, QMD) reads and writes
 * against this contract.
 *
 * Design decisions (see issue #2):
 *  - AMS is a general-purpose note-taking system, not an ADR tool. The
 *    note is type-generic: a `type` field carries the semantic
 *    (decision, learning, pattern, note, ...) and the body is free-form
 *    markdown. Per-type structure (e.g. Context/Decision/Consequences
 *    for decisions) is a documented convention, NOT enforced here.
 *  - Deterministic canonical format: `parseNote()` accepts any
 *    well-formed note and `serializeNote()` always emits the same form.
 *    Stable round-trip:
 *      serializeNote(parseNote(serializeNote(parseNote(x))))
 *        === serializeNote(parseNote(x))
 *  - The body is preserved verbatim (no enforced H2 sections) so the
 *    round-trip is lossless for arbitrary markdown content.
 *  - Wikilinks `[[target]]` are extracted for validation, but the
 *    system policy is to NEVER materialize stubs for broken links
 *    (see the AMS architecture constraints).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { deriveId, isIsoDate, slugify } from "./slug.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error type for note parsing failures. Distinct type for tests/catch blocks. */
export class NoteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteParseError";
  }
}

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

/** Canonical id: bare slug derived from the title. Validated to guarantee idempotency. */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Note type: lowercase, starts with a letter (decision, learning, pattern, ...). */
const TYPE_RE = /^[a-z][a-z0-9-]*$/;

/** Optional topic_key: lowercase path separated by `/`. */
const TOPIC_KEY_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** Tag: lowercase kebab-case; a leading digit allows year-like tags (2026). */
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const FrontmatterSchema = z.object({
  id: z.string().regex(ID_RE, "id must be a slug derived from the title"),
  title: z.string().min(1, "title must be non-empty"),
  date: z.string().refine(isIsoDate, "date must be YYYY-MM-DD"),
  type: z.string().regex(TYPE_RE, "type must be lowercase, starting with a letter"),
  topic_key: z.string().regex(TOPIC_KEY_RE, "topic_key must be a lowercase path").optional(),
  tags: z
    .array(z.string().regex(TAG_RE, "tags must be lowercase kebab-case (letters, digits, hyphens)"))
    .default([]),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/** Parsed note. The body is the raw markdown, preserved verbatim. */
export interface Note {
  frontmatter: Frontmatter;
  /** Raw markdown body, preserved verbatim (only CRLF -> LF + edge trim). */
  body: string;
  /** Wikilink targets found in the body. For validation only. */
  wikilinks: string[];
}

// ---------------------------------------------------------------------------
// Vault path
// ---------------------------------------------------------------------------

/**
 * Canonical path of a note from its type and id.
 *
 * Directory = `<type>s` via simple `+s` pluralization (e.g. `decision` ->
 * `decisions`, `learning` -> `learnings`). Documented limitation: irregular
 * plurals are not handled — pick type names that pluralize cleanly, or let
 * the vault organize accordingly.
 */
export function notePath(id: string, type: string): string {
  return `${type}s/${id}.md`;
}

/** Builds a new note, guaranteeing id/date/slug coherence. */
export function buildNote(input: {
  title: string;
  date: string;
  type: string;
  topic_key?: string;
  tags?: string[];
  body: string;
}): Note {
  const id = deriveId(input.title);
  const frontmatter: Frontmatter = {
    id,
    title: input.title,
    date: input.date,
    type: input.type,
    ...(input.topic_key !== undefined ? { topic_key: input.topic_key } : {}),
    tags: input.tags ?? [],
  };
  return {
    frontmatter,
    body: normalizeBody(input.body),
    wikilinks: extractWikilinks(input.body),
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface SplitDoc {
  frontmatterRaw: string | null;
  body: string;
}

/** Splits the `--- ... ---` block from the markdown body. */
function splitFrontmatter(source: string): SplitDoc {
  const trimmed = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(trimmed);
  if (!match || match[1] === undefined) {
    return { frontmatterRaw: null, body: trimmed };
  }
  return { frontmatterRaw: match[1], body: match[2] ?? "" };
}

const WIKILINK_RE = /\[\[([^[\]|]+)(?:\|[^[\]]+)?\]\]/g;

/** Extracts unique targets from `[[target]]` or `[[target|alias]]` wikilinks. */
export function extractWikilinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (target && !seen.has(target)) seen.add(target);
  }
  return [...seen];
}

/** Normalizes body line endings (CRLF -> LF) and trims outer blank lines. */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Parses a note from its markdown source.
 *
 * Throws `NoteParseError` on missing/invalid frontmatter. Schema (Zod) errors
 * are wrapped in NoteParseError so there is a single parse error type. The
 * body is NOT validated for any specific structure — it is free-form
 * markdown, preserved verbatim.
 */
export function parseNote(source: string): Note {
  const { frontmatterRaw, body } = splitFrontmatter(source);
  if (frontmatterRaw === null) {
    throw new NoteParseError("Missing YAML frontmatter delimiters (---)");
  }

  let raw: unknown;
  try {
    raw = parseYaml(frontmatterRaw);
  } catch (e) {
    throw new NoteParseError(`Invalid YAML frontmatter: ${(e as Error).message}`);
  }

  const parsed = FrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new NoteParseError(`Invalid frontmatter: ${issues}`);
  }
  const frontmatter = parsed.data;
  const normalizedBody = normalizeBody(body);

  return {
    frontmatter,
    body: normalizedBody,
    wikilinks: extractWikilinks(normalizedBody),
  };
}

// ---------------------------------------------------------------------------
// Serialization (canonical)
// ---------------------------------------------------------------------------

/**
 * Serializes a note into its deterministic canonical form.
 *
 * Guarantees: fixed frontmatter key order, LF line endings, and the body
 * emitted verbatim after a single blank line. This is the basis of the
 * upsert idempotency contract.
 */
export function serializeNote(note: Note): string {
  const frontmatter = serializeFrontmatter(note.frontmatter).replace(/\n+$/, "");
  const body = normalizeBody(note.body);
  return `${frontmatter}\n\n${body}\n`;
}

/** Serializes frontmatter with a fixed key order for stable diffs. */
function serializeFrontmatter(fm: Frontmatter): string {
  const ordered: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    date: fm.date,
    type: fm.type,
  };
  if (fm.topic_key !== undefined) {
    ordered.topic_key = fm.topic_key;
  }
  ordered.tags = fm.tags;
  const yaml = stringifyYaml(ordered, { lineWidth: 0 });
  return `---\n${yaml}---\n`;
}

// ---------------------------------------------------------------------------
// Coherence validation (idempotency)
// ---------------------------------------------------------------------------

/**
 * Verifies that a note's id and title are coherent (id === deriveId(title))
 * and that the date is a valid ISO date. Useful in the Write API before
 * persisting.
 */
export function isCoherent(note: Note): boolean {
  const { id, title, date } = note.frontmatter;
  if (!isIsoDate(date)) return false;
  const slug = slugify(title);
  if (slug === "") return false;
  return id === slug;
}
