/**
 * Dirty-flag store — the signal the indexer (Spec 5) consumes to know which
 * notes changed and must be re-indexed.
 *
 * Currently this is a single JSON file under `<vault>/.ams/dirty.json`
 * mapping a note's relative path to the timestamp it was marked. The store is
 * intentionally simple: it is NOT a query index by itself (QMD is). Its only
 * job is to record "this path changed, please re-index".
 *
 * Concurrency: all marks are serialized on a single promise chain so
 * concurrent writes from different lock-protected handlers cannot clobber
 * each other. Persistence is atomic (temp file + rename) so a crash mid-write
 * never leaves a half-written JSON file.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DirtyEntry {
  /** Relative path of the note inside the vault, e.g. "decisions/use-qmd.md". */
  path: string;
  /** Epoch millis when the path was marked dirty. */
  markedAt: number;
  /** Correlation id of the request that marked the path, when known. */
  requestId?: string;
}

export type DirtyMap = Record<string, { markedAt: number; requestId?: string }>;

export class DirtyStore {
  private readonly entries = new Map<string, { markedAt: number; requestId?: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath absolute path to the JSON file backing the store.
   *                 The `.ams` parent directory is created on demand.
   */
  constructor(private readonly filePath: string) {}

  /**
   * Marks `relPath` as dirty, persisting atomically. `requestId` records which
   * write caused the flag so indexer logs can point back at the originating
   * request.
   */
  mark(relPath: string, requestId?: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.entries.set(relPath, { markedAt: Date.now(), ...(requestId ? { requestId } : {}) });
      await this.persist();
    });
    return this.chain as Promise<void>;
  }

  /** In-memory snapshot, primarily for tests and introspection. */
  snapshot(): DirtyEntry[] {
    return [...this.entries.entries()].map(([path, entry]) => ({ path, ...entry }));
  }

  /** Whether a path is currently flagged as dirty. */
  has(relPath: string): boolean {
    return this.entries.has(relPath);
  }

  /**
   * Clears the supplied paths (or every path when omitted), persisting
   * atomically. The Spec 5 indexer calls this with the batch it just
   * re-indexed successfully — flags survive every failed tick because they
   * are removed only here, never on the error path.
   */
  clear(paths?: string[]): Promise<void> {
    const toClear = paths ?? [...this.entries.keys()];
    if (toClear.length === 0) return Promise.resolve();
    this.chain = this.chain.then(async () => {
      for (const p of toClear) this.entries.delete(p);
      await this.persist();
    });
    return this.chain as Promise<void>;
  }

  private async persist(): Promise<void> {
    const map: DirtyMap = {};
    for (const [path, entry] of this.entries) {
      map[path] = entry;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}
