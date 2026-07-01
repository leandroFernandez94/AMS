/**
 * Contrato de datos de una decision note — el tipo canónico de nota
 * del tracer bullet. Toda otra spec (Write API, MCP, QMD) lee y
 * escribe contra este contrato.
 *
 * Decisiones de diseño (ver issue #2):
 *  - Formato canónico determinístico: `parseNote()` acepta cualquier
 *    nota bien formada y `serializeNote()` siempre emite el mismo
 *    formato. Round-trip estable:
 *      serializeNote(parseNote(serializeNote(parseNote(x))))
 *        === serializeNote(parseNote(x))
 *  - Las secciones H2 canónicas son Context / Decision / Consequences.
 *    Secciones extra se preservan verbatim para no perder contenido.
 *  - Wikilinks `[[target]]` se extraen para validación, pero la política
 *    del sistema es NO materializar stubs para links rotos (ver
 *    architecture constraints de AMS).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { deriveId, isIsoDate, slugify } from "./slug.js";

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Error de parseo de nota. Distinto tipo para distinguirlo en tests/catch. */
export class NoteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteParseError";
  }
}

// ---------------------------------------------------------------------------
// Schema de frontmatter
// ---------------------------------------------------------------------------

export const DecisionStatus = z.enum(["proposed", "accepted", "superseded", "deprecated"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** Id canónico: <YYYY-MM-DD>-<slug>. Validado para garantizar idempotencia. */
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/** topic_key opcional: path en minúsculas separado por `/`. */
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
// Secciones del body
// ---------------------------------------------------------------------------

export const SECTION_ORDER = ["Context", "Decision", "Consequences"] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export interface ExtraSection {
  heading: string;
  body: string;
}

/** Nota parseada. Las secciones canónicas están garantizadas presentes. */
export interface DecisionNote {
  frontmatter: Frontmatter;
  sections: Record<SectionName, string>;
  /** Contenido libre antes del primer H2 (preservado verbatim, suele ser vacío). */
  preface: string;
  /** Secciones H2 no canónicas, preservadas en orden de aparición. */
  extraSections: ExtraSection[];
  /** Targets de wikilinks encontrados en el body. Solo para validación. */
  wikilinks: string[];
}

// ---------------------------------------------------------------------------
// Path en el vault
// ---------------------------------------------------------------------------

export const DECISIONS_DIR = "decisions";

/** Path canónico de una nota a partir de su id: `decisions/<id>.md`. */
export function notePath(id: string): string {
  return `${DECISIONS_DIR}/${id}.md`;
}

/** Construye una nota nueva garantizando coherencia id/date/slug. */
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
// Parseo
// ---------------------------------------------------------------------------

interface SplitDoc {
  frontmatterRaw: string | null;
  body: string;
}

/** Separa el bloque `--- ... ---` del cuerpo markdown. */
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

/** Parte el cuerpo por headers H2. Preserva todo el contenido textual. */
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

/** Extrae targets únicos de wikilinks `[[target]]` o `[[target|alias]]`. */
export function extractWikilinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (target && !seen.has(target)) seen.add(target);
  }
  return [...seen];
}

/**
 * Parsea una decision note desde su fuente markdown.
 *
 * Lanza `NoteParseError` ante frontmatter faltante/inválido o secciones
 * canónicas ausentes. Errores de schema (Zod) se envuelven en NoteParseError
 * para un único tipo de error de parseo.
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
// Serialización (canónica)
// ---------------------------------------------------------------------------

/**
 * Serializa una nota a su forma canónica determinística.
 *
 * Garantiza: mismo orden de keys, LF, secciones en SECTION_ORDER seguidas
 * de extras, y bloques separados por una sola línea en blanco. Es la base
 * del contrato de idempotencia de upserts.
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

/** Serializa el frontmatter en orden de keys fijo para diffs estables. */
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
// Validación de coherencia (idempotencia)
// ---------------------------------------------------------------------------

/**
 * Verifica que el id, fecha y título de una nota sean coherentes
 * (id === deriveId(title, date)). Útil en el Write API antes de persistir.
 */
export function isCoherent(note: DecisionNote): boolean {
  const { id, title, date } = note.frontmatter;
  if (!isIsoDate(date)) return false;
  const slug = slugify(title);
  if (slug === "") return false;
  return id === `${date}-${slug}`;
}
