/**
 * Pure mapping between QMD's result shapes and AMS domain shapes.
 *
 * Keeping this layer pure (no I/O) means the translation can be unit-tested
 * exhaustively with plain fixtures, independent of any running daemon. The
 * client (`client.ts`) owns the I/O and delegates the shaping to these
 * functions.
 *
 * Empirically validated against a real QMD 2.5 daemon (the README is partly
 * inaccurate):
 *  - `query` results carry a `structuredContent.results` array; each hit's
 *    `file` is `<collection>/<relpath>` (NO `qmd://` scheme).
 *  - `get` returns a `{ type: "resource", resource: { uri, text } }` content
 *    item; `uri` IS a `qmd://<collection>/<relpath>` URI and `text` is the
 *    document body prefixed with a `<!-- Context: ... -->` comment.
 *
 * AMS works in vault-relative paths. Because a QMD collection is rooted at the
 * vault, the collection segment is the only thing to strip from a QMD path to
 * obtain the vault-relative form. The opaque QMD docid (`#abc123`) is kept as
 * the retrieval handle because that is exactly what `get` resolves reliably
 * (a stripped vault path does NOT resolve in `get`).
 */

/** AMS read-side shape for a single search hit (Spec 4 acceptance criteria). */
export interface MemoryHit {
  /** QMD docid (`#abc123`) — the opaque handle to pass back to `getMemory`. */
  id: string;
  /** Vault-relative path, e.g. `decisions/use-qmd.md`. */
  path: string;
  /** Document title as QMD indexed it (empty when unknown). */
  title: string;
  /** Match snippet, already trimmed to the relevant window by QMD. */
  snippet: string;
  /** Normalized relevance score in [0, 1]. */
  score: number;
}

/** AMS read-side shape for a fetched document. `null` when not found. */
export interface MemoryDoc {
  /** QMD docid when known (only when `getMemory` was called with one). */
  id: string;
  /** Vault-relative path. */
  path: string;
  /** Document body (QMD's `<!-- Context -->` prefix removed). */
  body: string;
}

const QMD_PREFIX = "qmd://";
const CONTEXT_RE = /^<!--\s*Context:[\s\S]*?-->\s*\n*/;

/**
 * Converts a QMD path/URI into a vault-relative path by stripping an optional
 * `qmd://` scheme and the leading collection segment.
 *
 * QMD always emits `<collection>/<relpath>` (with or without the `qmd://`
 * scheme), so dropping the first segment yields the vault-relative path. This
 * is intended for QMD output only — a bare vault path has no collection prefix
 * to strip.
 */
export function stripQmdUri(file: string): string {
  if (!file) return "";
  let s = file;
  if (s.startsWith(QMD_PREFIX)) s = s.slice(QMD_PREFIX.length);
  const slash = s.indexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** Removes QMD's injected `<!-- Context: ... -->` preamble from a body. */
export function stripContextComment(text: string): string {
  return text.replace(CONTEXT_RE, "");
}

/** Coerces an arbitrary value to a number, defaulting to 0 when not finite. */
function toScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reduces a parsed QMD `query` payload to a uniform result array.
 *
 * `structuredContent` is the canonical shape (`{ results: [...] }`); the text
 * fallback may be a bare array. Both are accepted so the adapter is robust to
 * transport drift.
 */
function asResultArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.docs)) return obj.docs;
  }
  return [];
}

/** Maps a parsed QMD query payload into AMS search hits. */
export function mapSearchResults(payload: unknown): MemoryHit[] {
  return asResultArray(payload)
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const rawFile =
        typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : "";
      return {
        id: typeof item.docid === "string" ? item.docid : "",
        path: stripQmdUri(rawFile),
        title: typeof item.title === "string" ? item.title : "",
        snippet: typeof item.snippet === "string" ? item.snippet : "",
        score: toScore(item.score),
      };
    });
}

/** Resource content item as returned by the `get` tool. */
export interface QmdResource {
  /** `qmd://<collection>/<relpath>` URI from the resource envelope. */
  uri?: string;
  /** Raw document text, including QMD's context comment prefix. */
  text?: string;
}

/**
 * Maps a `get` resource into an AMS document, or `null` when the resource is
 * empty (document not found).
 */
export function mapDocument(resource: QmdResource | null, id = ""): MemoryDoc | null {
  if (!resource) return null;
  const uri = typeof resource.uri === "string" ? resource.uri : "";
  const body = stripContextComment(typeof resource.text === "string" ? resource.text : "");
  if (!uri && !body.trim()) return null;
  return {
    id,
    path: stripQmdUri(uri),
    body,
  };
}
