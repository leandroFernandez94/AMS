/**
 * AMS shared package — cross-package types and schemas.
 *
 * Core data contract of the tracer bullet. Defines the canonical
 * decision note type and its (de)serialization helpers consumed by
 * the Write API, MCP and the indexing layer.
 */

export {
  buildNote,
  DECISIONS_DIR,
  type DecisionNote,
  DecisionStatus,
  type ExtraSection,
  extractWikilinks,
  type Frontmatter,
  FrontmatterSchema,
  isCoherent,
  NoteParseError,
  notePath,
  parseNote,
  SECTION_ORDER,
  type SectionName,
  serializeNote,
} from "./decision-note.js";
export { deriveId, isIsoDate, slugify } from "./slug.js";
export { isNonEmpty, PACKAGE_NAME } from "./util.js";
