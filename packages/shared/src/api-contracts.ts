/**
 * Wire response contracts for the Write API (issue #40).
 *
 * Single source of truth for the HTTP response SHAPES: the API types its
 * route responses against the inferred types (so shape drift becomes a
 * compile error) and clients parse responses with the same schemas. Only
 * success payloads plus the validation-issue item shared by the 400
 * envelope are modeled here — status codes and full error envelopes stay
 * the API's concern.
 */
import { z } from "zod";
import { FrontmatterSchema } from "./note.js";

// ---------------------------------------------------------------------------
// POST /notes
// ---------------------------------------------------------------------------

export const UpsertResponseSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** True when a new file was created (201), false when an existing one was updated (200). */
  created: z.boolean(),
  /** Old path — present only when a topic_key update renamed the note. */
  moved_from: z.string().optional(),
});

export type UpsertResponse = z.infer<typeof UpsertResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /notes/:path
// ---------------------------------------------------------------------------

/**
 * `note` is typed precisely by composing the existing FrontmatterSchema
 * instead of degrading to `z.unknown().nullable()`: there is no standalone
 * NoteSchema (Note is deliberately a plain interface in note.ts), and this
 * way a client parsing a DeleteResponse actually validates the deleted
 * note's shape instead of trusting an unknown blob.
 */
const NoteWireSchema = z.object({
  frontmatter: FrontmatterSchema,
  body: z.string(),
});

export const DeleteResponseSchema = z.object({
  /** Literal true: a miss answers 404, never `{deleted: false}`. */
  deleted: z.literal(true),
  path: z.string(),
  /** The deleted note, or null when the file was not parseable as one. */
  note: NoteWireSchema.nullable(),
  /** Raw on-disk content — sent only alongside `note: null` (accidental-delete recovery). */
  raw: z.string().optional(),
});

export type DeleteResponse = z.infer<typeof DeleteResponseSchema>;

// ---------------------------------------------------------------------------
// GET /tags
// ---------------------------------------------------------------------------

export const TagCountSchema = z.object({
  name: z.string(),
  count: z.number(),
});

/** Canonical declaration: a tag in the vault vocabulary, with how many notes carry it. */
export type TagCount = z.infer<typeof TagCountSchema>;

export const TagsResponseSchema = z.object({
  tags: z.array(TagCountSchema),
});

export type TagsResponse = z.infer<typeof TagsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /types
// ---------------------------------------------------------------------------

export const TypesResponseSchema = z.object({
  types: z.array(z.string()),
});

export type TypesResponse = z.infer<typeof TypesResponseSchema>;

// ---------------------------------------------------------------------------
// Validation issues (400 envelope item)
// ---------------------------------------------------------------------------

export const ValidationErrorIssueSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export type ValidationErrorIssue = z.infer<typeof ValidationErrorIssueSchema>;
