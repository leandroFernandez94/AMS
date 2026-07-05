/**
 * Indexing port (Spec 5) — the thing the scheduler calls to make pending
 * writes searchable.
 *
 * Why a port and not a direct call? The QMD daemon's MCP surface (Spec 4)
 * exposes only read tools (`query`/`get`/`multi_get`/`status`); it has no
 * `update` or `embed` tool. Indexing is therefore a CLI/SDK operation that
 * writes to the shared index DB the daemon reads. Modeling it behind a
 * single-method interface keeps the scheduler agnostic of HOW reindexing
 * happens (CLI today, SDK or a future daemon tool tomorrow) and — just as
 * importantly — fully unit-testable without models, a daemon, or even the
 * `qmd` binary on PATH.
 */
import type { DirtyEntry } from "../dirty.js";

/** Structured outcome of a single reindex cycle, for logging and the admin API. */
export interface ReindexResult {
  /** Number of dirty paths that drove this cycle (0 means nothing ran). */
  pending: number;
  /** First line of `qmd update`'s stdout summary, when available. */
  updateSummary?: string;
  /** First line of `qmd embed`’s stdout summary, when available. */
  embedSummary?: string;
}

/**
 * Single-method indexing port.
 *
 * Implementations re-index whatever collection(s) the AMS vault maps to and
 * resolve on success. Any failure MUST reject — the scheduler treats a
 * rejected promise as "keep the flags, retry next tick".
 */
export interface Reindexer {
  /**
   * @param entries snapshot of currently-flagged paths. Implementations that
   *                reindex at collection granularity (the default CLI one)
   *                use this only for logging/counts; the contract does not
   *                require per-file reindexing.
   */
  reindex(entries: DirtyEntry[]): Promise<ReindexResult>;
}
