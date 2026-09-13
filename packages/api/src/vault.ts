/**
 * Vault persistence — the only code that writes note files to disk.
 *
 * The Write API never exposes raw file writes to agents (Spec 3 contract).
 * Instead every mutation funnels through `Vault.upsertNote`, which guarantees:
 *  - the note lands at its canonical path `<type>s/<id>.md`,
 *  - the canonical serialization is used (stable frontmatter + verbatim body),
 *  - the parent directory exists before writing.
 *
 * Upsert semantics: the same canonical id overwrites the existing file. The
 * caller is told whether the write created a new file or updated an existing
 * one, so the HTTP layer can answer 201 vs 200.
 */
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isCoherent, type Note, notePath, parseNote, serializeNote } from "@ams/shared";

/** Result of an upsert operation. */
export interface UpsertResult {
  /** Canonical id of the note. */
  id: string;
  /** Relative path inside the vault. */
  path: string;
  /** True when a new file was created, false when an existing one was updated. */
  created: boolean;
}

/** A note located in the vault by its `topic_key`. */
export interface TopicKeyMatch {
  /** The parsed note that owns the key. */
  note: Note;
  /** Vault-relative path of the note file. */
  path: string;
}

export class Vault {
  constructor(private readonly root: string) {}

  /** Absolute path for a note given its type and id. */
  resolvePath(id: string, type: string): string {
    return join(this.root, notePath(id, type));
  }

  /**
   * Idempotently persists `note` at its canonical path.
   *
   * Refuses to write incoherent notes (id/title/date mismatch) — that would
   * break the idempotency contract the indexer relies on.
   */
  async upsertNote(note: Note): Promise<UpsertResult> {
    if (!isCoherent(note)) {
      throw new Error(
        `Refusing to persist incoherent note: id=${note.frontmatter.id} is not derived from the title`,
      );
    }
    const relPath = notePath(note.frontmatter.id, note.frontmatter.type);
    const absPath = join(this.root, relPath);
    const created = !(await this.exists(absPath));
    await mkdir(dirname(absPath), { recursive: true });
    await this.writeAtomic(absPath, serializeNote(note));
    return { id: note.frontmatter.id, path: relPath, created };
  }

  /** Reads and parses a note by its canonical id and type (or null if absent). */
  async readNote(id: string, type: string): Promise<Note | null> {
    const relPath = notePath(id, type);
    try {
      const source = await readFile(join(this.root, relPath), "utf8");
      return parseNote(source);
    } catch {
      return null;
    }
  }

  /**
   * Finds the note whose `frontmatter.topic_key` exactly matches, across all
   * types. Deterministic: every `*.md` under the vault root is visited in
   * sorted path order and the first match wins.
   *
   * Tradeoff: a linear scan per topic-key write is O(vault size). At
   * tracer-bullet scale (hundreds of notes) that is fine; replace with an
   * index only when the vault grows enough for the scan to matter.
   */
  async findByTopicKey(topicKey: string): Promise<TopicKeyMatch | null> {
    const paths: string[] = [];
    await this.collectMarkdownPaths(".", paths);
    paths.sort();
    for (const relPath of paths) {
      const source = await this.readRaw(relPath);
      if (source === null) continue;
      let note: Note;
      try {
        note = parseNote(source);
      } catch {
        // Not an AMS note (or corrupt frontmatter) — not ours to route.
        continue;
      }
      if (note.frontmatter.topic_key === topicKey) {
        return { note, path: relPath };
      }
    }
    return null;
  }

  /**
   * Reads the RAW markdown source at a vault-relative path (null if absent).
   * Used to surface the exact on-disk content in conflict responses — raw
   * bytes, never re-serialized, so the agent sees precisely what it collides
   * with.
   */
  async readRaw(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.root, relPath), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Deletes the note file at a vault-relative path. Used by the rename flow
   * (write the moved note first, then unlink the old file). Returns whether
   * a file was actually removed.
   */
  async deleteNote(relPath: string): Promise<boolean> {
    try {
      await unlink(join(this.root, relPath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively collects vault-relative paths of `*.md` files under `relDir`.
   * Dot-directories (`.ams`, `.qmd`, ...) are skipped — they carry system
   * state, not notes. Paths always use `/` separators to match `notePath()`.
   */
  private async collectMarkdownPaths(relDir: string, out: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(this.root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.collectMarkdownPaths(rel, out);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(rel);
      }
    }
  }

  private async exists(absPath: string): Promise<boolean> {
    try {
      await stat(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Writes UTF-8 content, replacing any existing file. */
  private async writeAtomic(absPath: string, content: string): Promise<void> {
    // Node's writeFile with the default flag truncates+creates, which gives us
    // the overwrite semantics we want. The OS page cache is the durability
    // level for the tracer bullet; fsync is out of scope until needed.
    await writeFile(absPath, content, "utf8");
  }
}
