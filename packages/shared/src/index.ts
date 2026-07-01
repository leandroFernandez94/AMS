/**
 * AMS shared package — cross-package types and schemas.
 *
 * Núcleo del contrato de datos del tracer bullet. Define el tipo
 * canónico de decision note y sus helpers de (de)serialización que
 * consumen Write API, MCP y la capa de indexación.
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
