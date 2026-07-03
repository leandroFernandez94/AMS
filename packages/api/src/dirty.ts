/**
 * Dirty-flag store — the signal the indexer (Spec 5) consumes to know which
 * notes changed and must be re-indexed.
 *
 * For the tracer bullet this is a single JSON file under `<vault>/.ams/dirty.json`
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
  /** Relative path of the note inside the vault, e.g. "decisions/2026-07-01-x.md". */
  path: string;
  /** Epoch millis when the path was marked dirty. */
  markedAt: number;
}

export type DirtyMap = Record<string, { markedAt: number }>;

export class DirtyStore {
  private readonly entries = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath absolute path to the JSON file backing the store.
   *                 The `.ams` parent directory is created on demand.
   */
  constructor(private readonly filePath: string) {}

  /** Marks `relPath` as dirty, persisting atomically. */
  mark(relPath: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.entries.set(relPath, Date.now());
      await this.persist();
    });
    return this.chain as Promise<void>;
  }

  /** In-memory snapshot, primarily for tests and introspection. */
  snapshot(): DirtyEntry[] {
    return [...this.entries.entries()].map(([path, markedAt]) => ({ path, markedAt }));
  }

  /** Whether a path is currently flagged as dirty. */
  has(relPath: string): boolean {
    return this.entries.has(relPath);
  }

  private async persist(): Promise<void> {
    const map: DirtyMap = {};
    for (const [path, markedAt] of this.entries) {
      map[path] = { markedAt };
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}
