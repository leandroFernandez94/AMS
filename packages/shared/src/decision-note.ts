/**
 * Data contract for a decision note — the canonical note type of the
 * tracer bullet. Every other spec (Write API, MCP, QMD) reads and
 * writes against this contract.
 *
 * Design decisions (see issue #2):
 *  - Deterministic canonical format: `parseNote()` accepts any
 *    well-formed note and `serializeNote()` always emits the same
 *    form. Stable round-trip:
 *      serializeNote(parseNote(serializeNote(parseNote(x))))
 *        === serializeNote(parseNote(x))
 *  - Canonical H2 sections are Context / Decision / Consequences.
 *    Extra sections are preserved verbatim so no content is lost.
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

export const DecisionStatus = z.enum(["proposed", "accepted", "superseded", "deprecated"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** Canonical id: <YYYY-MM-DD>-<slug>. Validated to guarantee idempotency. */
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Optional topic_key: lowercase path separated by `/`. */
const TOPIC_KEY_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

export const FrontmatterSchema = z.object({
  id: z.string().regex(ID_RE, "id must match <YYYY-MM-DD>-<slug>"),
  title: z.string().min(1, "title must be non-empty"),
  date: z.string().refine(isIsoDate, "date must be YYYY-MM-DD"),
  status: DecisionStatus,
  topic_key: z.string().regex(TOPIC_KEY_RE, "topic_key must be a lowercase path").optional(),
  tags: z.array(z.string().min(1)).default([]),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

export const SECTION_ORDER = ["Context", "Decision", "Consequences"] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export interface ExtraSection {
  heading: string;
  body: string;
}

/** Parsed note. Canonical sections are guaranteed to be present. */
export interface DecisionNote {
  frontmatter: Frontmatter;
  sections: Record<SectionName, string>;
  /** Free-form content before the first H2 (preserved verbatim, usually empty). */
  preface: string;
  /** Non-canonical H2 sections, preserved in order of appearance. */
  extraSections: ExtraSection[];
  /** Wikilink targets found in the body. For validation only. */
  wikilinks: string[];
}

// ---------------------------------------------------------------------------
// Vault path
// ---------------------------------------------------------------------------

export const DECISIONS_DIR = "decisions";

/** Canonical path of a note from its id: `decisions/<id>.md`. */
export function notePath(id: string): string {
  return `${DECISIONS_DIR}/${id}.md`;
}

/** Builds a new note, guaranteeing id/date/slug coherence. */
export function buildNote(input: {
  title: string;
  date: string;
  status: DecisionStatus;
  topic_key?: string;
  tags?: string[];
  context: string;
  decision: string;
  consequences: string;
}): DecisionNote {
  const id = deriveId(input.title, input.date);
  const frontmatter: Frontmatter = {
    id,
    title: input.title,
    date: input.date,
    status: input.status,
    ...(input.topic_key !== undefined ? { topic_key: input.topic_key } : {}),
    tags: input.tags ?? [],
  };
  return {
    frontmatter,
    preface: "",
    sections: {
      Context: input.context,
      Decision: input.decision,
      Consequences: input.consequences,
    },
    extraSections: [],
    wikilinks: extractWikilinks([input.context, input.decision, input.consequences].join("\n\n")),
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

interface SplitBody {
  preface: string;
  sections: Map<string, string>;
}

/** Splits the body by H2 headers. Preserves all textual content. */
function splitBody(body: string): SplitBody {
  const lines = body.split("\n");
  const sections = new Map<string, string>();
  const prefaceLines: string[] = [];
  let current: string | null = null;
  let bucket: string[] = [];

  const flush = (): void => {
    if (current !== null) {
      sections.set(current, bucket.join("\n"));
    }
    bucket = [];
  };

  for (const line of lines) {
    const h2 = /^##[ \t]+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      current = h2[1] ?? "";
    } else if (current !== null) {
      bucket.push(line);
    } else {
      prefaceLines.push(line);
    }
  }
  flush();

  return { preface: prefaceLines.join("\n"), sections };
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

/**
 * Parses a decision note from its markdown source.
 *
 * Throws `NoteParseError` on missing/invalid frontmatter or missing
 * canonical sections. Schema (Zod) errors are wrapped in NoteParseError
 * so there is a single parse error type.
 */
export function parseNote(source: string): DecisionNote {
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

  const { preface, sections } = splitBody(body);

  const missing = SECTION_ORDER.filter((s) => !sections.has(s));
  if (missing.length > 0) {
    throw new NoteParseError(`Missing required sections: ${missing.join(", ")}`);
  }

  const canonSections = {
    Context: (sections.get("Context") ?? "").trim(),
    Decision: (sections.get("Decision") ?? "").trim(),
    Consequences: (sections.get("Consequences") ?? "").trim(),
  };

  const canonSet = new Set<string>(SECTION_ORDER);
  const extraSections: ExtraSection[] = [];
  for (const [heading, b] of sections) {
    if (!canonSet.has(heading)) {
      extraSections.push({ heading, body: b.replace(/^\n+|\n+$/g, "") });
    }
  }

  const wikilinks = extractWikilinks(body);

  return {
    frontmatter,
    preface: preface.replace(/^\n+|\n+$/g, ""),
    sections: canonSections,
    extraSections,
    wikilinks,
  };
}

// ---------------------------------------------------------------------------
// Serialization (canonical)
// ---------------------------------------------------------------------------

/**
 * Serializes a note into its deterministic canonical form.
 *
 * Guarantees: fixed key order, LF line endings, sections in SECTION_ORDER
 * followed by extras, and blocks separated by a single blank line. This
 * is the basis of the upsert idempotency contract.
 */
export function serializeNote(note: DecisionNote): string {
  const frontmatter = serializeFrontmatter(note.frontmatter);
  const blocks: string[] = [frontmatter.replace(/\n+$/, "")];

  if (note.preface.trim() !== "") {
    blocks.push(note.preface.trim());
  }

  for (const name of SECTION_ORDER) {
    const content = note.sections[name].trim();
    blocks.push(`## ${name}\n\n${content}`);
  }

  for (const extra of note.extraSections) {
    const content = extra.body.trim();
    blocks.push(`## ${extra.heading}\n\n${content}`);
  }

  return `${blocks.join("\n\n")}\n`;
}

/** Serializes frontmatter with a fixed key order for stable diffs. */
function serializeFrontmatter(fm: Frontmatter): string {
  const ordered: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    date: fm.date,
    status: fm.status,
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
 * Verifies that a note's id, date and title are coherent
 * (id === deriveId(title, date)). Useful in the Write API before persisting.
 */
export function isCoherent(note: DecisionNote): boolean {
  const { id, title, date } = note.frontmatter;
  if (!isIsoDate(date)) return false;
  const slug = slugify(title);
  if (slug === "") return false;
  return id === `${date}-${slug}`;
}
