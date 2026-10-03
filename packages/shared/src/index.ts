/**
 * AMS shared package — cross-package types and schemas.
 *
 * Core data contract of the tracer bullet. Defines the generic note
 * type and its (de)serialization helpers consumed by the Write API,
 * MCP and the indexing layer.
 */

export {
  type DeleteResponse,
  DeleteResponseSchema,
  type TagCount,
  TagCountSchema,
  type TagsResponse,
  TagsResponseSchema,
  type TypesResponse,
  TypesResponseSchema,
  type UpsertResponse,
  UpsertResponseSchema,
  type ValidationErrorIssue,
  ValidationErrorIssueSchema,
} from "./api-contracts.js";
export {
  buildNote,
  type Frontmatter,
  FrontmatterSchema,
  isCoherent,
  type Note,
  NoteParseError,
  notePath,
  parseNote,
  serializeNote,
} from "./note.js";
export { deriveId, isIsoDate, slugify } from "./slug.js";
export { isNonEmpty, newRequestId, PACKAGE_NAME, REQUEST_ID_HEADER } from "./util.js";
export {
  type RecordNoteInput,
  WriteApiClient,
  type WriteApiClientOptions,
  type WriteApiLogger,
  type WriteApiRequestOptions,
} from "./write-api/client.js";
export {
  type ExistingNoteSummary,
  NoteExistsError,
  WriteApiConfigError,
  WriteApiError,
  WriteApiNotFoundError,
  WriteApiUnavailableError,
  WriteApiUnexpectedPayloadError,
  WriteApiValidationError,
} from "./write-api/errors.js";
