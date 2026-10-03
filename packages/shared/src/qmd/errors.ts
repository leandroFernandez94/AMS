/**
 * Typed errors for the QMD retrieval adapter.
 *
 * QMD runs as an independent HTTP daemon (Spec 4). Every failure mode the
 * adapter can hit is expressed as a distinct error class so callers can react
 * without string-matching messages: a daemon-down event is a recoverable,
 * retryable condition and must never crash the host process.
 *
 * Hierarchy:
 *   QmdError                 — base for everything QMD-related
 *     QmdUnavailableError    — network failure / daemon not reachable
 *     QmdProtocolError       — unexpected, malformed, or non-JSON response
 *     QmdToolError           — the daemon answered a JSON-RPC error, or the
 *                              MCP tool reported `isError: true`
 */

/** Base class for all QMD adapter failures. Distinct type for catch blocks. */
export class QmdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QmdError";
  }
}

/**
 * The QMD daemon could not be reached or refused the connection.
 *
 * This is the "graceful" failure: the read path should degrade (e.g. return an
 * empty result or a typed error to the agent) rather than crash. Carries the
 * underlying cause when available.
 */
export class QmdUnavailableError extends QmdError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "QmdUnavailableError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** The daemon responded, but the payload was not a valid JSON-RPC result. */
export class QmdProtocolError extends QmdError {
  constructor(message: string) {
    super(message);
    this.name = "QmdProtocolError";
  }
}

/** The daemon returned a JSON-RPC error or an MCP tool-level error. */
export class QmdToolError extends QmdError {
  constructor(message: string) {
    super(message);
    this.name = "QmdToolError";
  }
}
