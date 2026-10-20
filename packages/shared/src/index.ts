/**
 * AMS shared package — cross-package types and schemas.
 *
 * Core data contract of AMS. Defines the generic note
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
export { createLogger, type LogEntry, type Logger, type LogLevel } from "./logger.js";
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
export {
  type GetMemoryInput,
  QmdClient,
  type QmdClientOptions,
  type SearchMemoryInput,
} from "./qmd/client.js";
export { DEFAULT_QMD_URL, loadQmdConfig, QMD_URL_ENV, type QmdConfig } from "./qmd/config.js";
export { QmdError, QmdProtocolError, QmdToolError, QmdUnavailableError } from "./qmd/errors.js";
export {
  createFetchTransport,
  type FetchTransportOptions,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
} from "./qmd/http.js";
export {
  type MemoryDoc,
  type MemoryHit,
  mapDocument,
  mapSearchResults,
  type QmdResource,
  stripQmdUri,
} from "./qmd/mapping.js";
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
