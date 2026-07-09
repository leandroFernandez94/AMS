/**
 * CLI-backed `Reindexer` — drives the QMD index that the daemon reads.
 *
 * The QMD HTTP daemon exposes only read tools; `update`/`embed` live in the
 * CLI and write to the shared index DB (`~/.cache/qmd/index.sqlite`) that the
 * daemon serves queries from. So "reindex" means: shell out to `qmd update`
 * (refresh the FTS5 index) then `qmd embed` (generate vector embeddings). The
 * daemon picks the changes up with no restart.
 *
 * Command execution is injectable: production wires `createExecRunner` (a
 * thin `execFile` wrapper with a timeout); unit tests pass a fake that records
 * calls and returns canned results, so the suite never needs the `qmd` binary,
 * a daemon, or any GGUF models.
 *
 * Scope note: the `qmd` CLI accepts `-c <collection>` only on `embed`, not on
 * `update` (verified against qmd 2.5). When `collection` is configured `embed`
 * is scoped to it; `update` always re-scans every registered collection. On a
 * single-collection AMS vault the difference is moot.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DirtyEntry } from "../dirty.js";
import type { Reindexer, ReindexResult } from "./reindexer.js";

/** Result of running one subprocess. */
export interface CommandResult {
  /** Process exit code (`0` = success). */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and resolves with its outcome. Never rejects — failures
 * (non-zero exit, spawn error, timeout) are reported via `code !== 0` so the
 * caller formats a single, consistent error message.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** Options for `CliReindexer`. */
export interface CliReindexerOptions {
  /** QMD binary path. Defaults to `qmd` (must be on PATH). */
  qmdBin?: string;
  /** Scope `qmd embed -c <name>` to one collection. `qmd update` is unaffected. */
  collection?: string;
  /** Per-subprocess timeout in ms (default 300000 = 5 min). */
  timeoutMs?: number;
  /** Injectable runner. Defaults to `createExecRunner(timeoutMs)`. */
  run?: CommandRunner;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Production runner backed by `node:child_process#execFile`. Classifies every
 * failure (non-zero exit, ENOENT, timeout) as a non-zero `CommandResult` so the
 * reindexer can surface a readable error instead of a raw `ExecFileException`.
 */
export function createExecRunner(timeoutMs = DEFAULT_TIMEOUT_MS): CommandRunner {
  const execFileP = promisify(execFile);
  return async (command, args) => {
    try {
      const { stdout, stderr } = await execFileP(command, args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
      const code = typeof err.code === "number" ? err.code : -1;
      return {
        code,
        stdout: err.stdout ?? "",
        // On a spawn failure (ENOENT) stdout/stderr are empty — fold the node
        // message in so the reindexer's error explains *what* was missing.
        stderr: err.stderr?.trim() || err.stdout?.trim() || err.message || "unknown error",
      };
    }
  };
}

/** First non-empty line of a subprocess' stdout, trimmed; for log summaries. */
function firstLine(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** CLI-backed reindexer: `qmd update` then `qmd embed`, throwing on any failure. */
export class CliReindexer implements Reindexer {
  private readonly qmdBin: string;
  private readonly collection?: string;
  private readonly run: CommandRunner;

  constructor(opts: CliReindexerOptions = {}) {
    this.qmdBin = opts.qmdBin ?? "qmd";
    this.collection = opts.collection;
    this.run = opts.run ?? createExecRunner(opts.timeoutMs);
  }

  async reindex(entries: DirtyEntry[]): Promise<ReindexResult> {
    // `update` has no `-c` flag in qmd 2.5; it re-scans every collection.
    const updateArgs = ["update"];
    const embedArgs = ["embed"];
    if (this.collection) embedArgs.push("-c", this.collection);

    const update = await this.run(this.qmdBin, updateArgs);
    if (update.code !== 0) {
      throw new Error(
        `${this.qmdBin} update failed (exit ${update.code}): ${update.stderr.trim()}`,
      );
    }

    const embed = await this.run(this.qmdBin, embedArgs);
    if (embed.code !== 0) {
      throw new Error(`${this.qmdBin} embed failed (exit ${embed.code}): ${embed.stderr.trim()}`);
    }

    return {
      pending: entries.length,
      updateSummary: firstLine(update.stdout),
      embedSummary: firstLine(embed.stdout),
    };
  }
}
