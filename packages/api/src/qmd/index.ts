/**
 * QMD retrieval adapter (Spec 4).
 *
 * Read-side surface that talks to the QMD daemon over MCP Streamable HTTP and
 * maps results into AMS domain shapes. Everything is injectable so the client
 * is fully testable without a running daemon.
 */

export {
  type GetMemoryInput,
  QmdClient,
  type QmdClientOptions,
  type SearchMemoryInput,
} from "./client.js";
export { DEFAULT_QMD_URL, loadQmdConfig, QMD_URL_ENV, type QmdConfig } from "./config.js";
export {
  QmdError,
  QmdProtocolError,
  QmdToolError,
  QmdUnavailableError,
} from "./errors.js";
export {
  createFetchTransport,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
} from "./http.js";
export {
  type MemoryDoc,
  type MemoryHit,
  mapDocument,
  mapSearchResults,
  stripQmdUri,
} from "./mapping.js";
