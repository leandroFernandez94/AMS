/**
 * HTTP application for the Write API.
 *
 * The semantic operations for the tracer bullet are `record_note`
 * (`POST /notes`) and note deletion (`DELETE /notes/:path`). Agents never
 * touch the filesystem directly — every mutation is validated, lock-protected
 * and flagged for the indexer.
 *
 * Dependencies are injected via `createApp` so tests can wire a temp vault,
 * a fake lock or a spy logger without spinning up a real server or touching
 * the real environment.
 */
import {
  buildNote,
  type DeleteResponse,
  FrontmatterSchema,
  isCoherent,
  isIsoDate,
  type Logger,
  type Note,
  newRequestId,
  notePath,
  parseNote,
  REQUEST_ID_HEADER,
  type TagsResponse,
  type TypesResponse,
  type UpsertResponse,
} from "@ams/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { DirtyStore } from "./dirty.js";
import type { IndexScheduler } from "./indexing/scheduler.js";
import type { ReleaseFunction, WriteLock } from "./lock.js";
import type { TopicKeyMatch, Vault } from "./vault.js";

/** Hono environment: the per-request correlation id set by the middleware. */
export type AppEnv = { Variables: { requestId: string } };

/** Collaborators the HTTP layer needs. Injected for testability. */
export interface AppDeps {
  vault: Vault;
  lock: WriteLock;
  dirty: DirtyStore;
  logger: Logger;
  /**
   * Optional so the tracer-bullet app can run without the scheduler wired
   * (e.g. the existing note-writing tests). When present it powers
   * `POST /admin/reindex`.
   */
  scheduler?: IndexScheduler;
}

/** Request payload accepted by POST /notes. */
const NoteInputSchema = z.object({
  title: z.string().min(1, "title must be a non-empty string"),
  type: z.string().min(1, "type must be a non-empty string"),
  body: z.string(),
  topic_key: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  date: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export type NoteInput = z.infer<typeof NoteInputSchema>;

/**
 * Upper bound on lock-set re-acquisitions per request. A topic_key write
 * discovers the note's current path pre-lock; if the note moves between that
 * lookup and lock acquisition, the decision cannot run safely and the whole
 * sequence retries with fresh state. Sustained contention beyond this bound
 * surfaces as a retryable 503 instead of corrupting the vault.
 */
const MAX_LOCK_ATTEMPTS = 3;

/**
 * Upper bound on an inbound `x-request-id`. Longer values are treated as
 * hostile/malformed and replaced with a generated id.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Resolves the correlation id for a request: reuse a sane inbound
 * `x-request-id`, otherwise generate one.
 */
function resolveRequestId(rawHeader: string | undefined): string {
  const inbound = rawHeader?.trim();
  if (inbound && inbound.length <= MAX_REQUEST_ID_LENGTH) {
    return inbound;
  }
  return newRequestId();
}

/** Builds a fresh Hono app wired to the supplied dependencies. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Correlation middleware — registered FIRST so every route (and its logs)
  // runs with a requestId in scope. Also emits exactly one access-log line
  // per request, after the handler finished, with ids/shapes only.
  app.use("*", async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);
    const startedAt = Date.now();
    await next();
    // Echo the id so callers that did not send one can learn it.
    c.res.headers.set(REQUEST_ID_HEADER, requestId);
    const status = c.res.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    deps.logger[level]("http:request:done", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Date.now() - startedAt,
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/types", async (c) => {
    // Live first-level directory scan via the vault — authoritative with no
    // index dependency, so it works even before the first reindex.
    const types = await deps.vault.listTypes();
    const response: TypesResponse = { types };
    return c.json(response);
  });

  app.get("/tags", async (c) => {
    // Live tolerant scan of the vault frontmatter via the vault — the
    // authoritative tag vocabulary, independent of the QMD index.
    const tags = await deps.vault.listTags();
    const response: TagsResponse = { tags };
    return c.json(response);
  });

  app.post("/notes", async (c) => recordNote(c, deps));
  // Regex param so slashes inside the vault-relative path survive routing.
  app.delete("/notes/:path{.+}", async (c) => deleteNoteAt(c, deps));

  app.post("/admin/reindex", async (c) => {
    // Forces one indexing cycle now, regardless of the cron schedule. Used for
    // debugging and for tests that need retrieval to reflect a write without
    // waiting on real time. Returns 503 when the scheduler is unwired or the
    // reindex fails, so callers can tell a missing-config answer from an ok.
    if (!deps.scheduler) {
      return c.json(
        { error: "scheduler_unavailable", message: "Index scheduler is not wired" },
        503,
      );
    }
    const result = await deps.scheduler.tick();
    const code = result.status === "failed" ? 503 : 200;
    return c.json(result, code);
  });

  return app;
}

/** Current UTC date in ISO `YYYY-MM-DD` form. Injected via param for tests. */
function todayUtc(now: () => Date = () => new Date()): string {
  return now().toISOString().slice(0, 10);
}

async function recordNote(c: Context<AppEnv>, deps: AppDeps, now: () => Date = () => new Date()) {
  // 1. Parse and validate the JSON payload (shape only; format is enforced
  //    later by the shared frontmatter schema).
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be valid JSON" }, 400);
  }
  const parsed = NoteInputSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "validation_error", issues: formatIssues(parsed.error) }, 400);
  }

  // 2. Resolve the date (caller may override; otherwise stamp today UTC).
  const date = parsed.data.date ?? todayUtc(now);
  if (!isIsoDate(date)) {
    return c.json(
      {
        error: "validation_error",
        issues: [{ field: "date", message: "date must be YYYY-MM-DD" }],
      },
      400,
    );
  }

  // 3. Build the canonical note. This derives the id and can throw if the
  //    title collapses to an empty slug.
  let note: Note;
  try {
    note = buildNote({
      title: parsed.data.title,
      type: parsed.data.type,
      body: parsed.data.body,
      date,
      ...(parsed.data.topic_key !== undefined ? { topic_key: parsed.data.topic_key } : {}),
      ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
    });
  } catch (e) {
    return c.json(
      { error: "validation_error", issues: [{ field: "title", message: (e as Error).message }] },
      400,
    );
  }

  // 4. Full frontmatter validation (type/topic_key format) via the shared
  //    contract, plus coherence (id === deriveId(title)).
  const fmCheck = FrontmatterSchema.safeParse(note.frontmatter);
  if (!fmCheck.success) {
    return c.json({ error: "validation_error", issues: formatIssues(fmCheck.error) }, 400);
  }
  if (!isCoherent(note)) {
    return c.json(
      { error: "incoherent_note", message: "id is not derived from title and date" },
      400,
    );
  }

  const newRel = notePath(note.frontmatter.id, note.frontmatter.type);
  const topicKey = note.frontmatter.topic_key;
  const overwrite = parsed.data.overwrite ?? false;
  const requestId = c.get("requestId");

  deps.logger.info("record_note:start", { requestId, id: note.frontmatter.id, path: newRel });

  // 5. Lock EVERY path this write can touch, then decide and write under the
  //    lock. A topic_key update may rename the note, which touches two paths
  //    (old + new); acquiring both in SORTED key order serializes crossing
  //    renames and prevents deadlock. When old == new this degenerates to the
  //    single lock of the original design.
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt++) {
    // The old path can only be discovered by an unlocked scan; the decision
    // itself is re-verified once the locks are held.
    const pre = topicKey !== undefined ? await deps.vault.findByTopicKey(topicKey) : null;
    const lockKeys = [...new Set([newRel, pre?.path ?? newRel])].sort();
    const releases: ReleaseFunction[] = [];
    try {
      for (const key of lockKeys) {
        releases.push(await deps.lock.acquire(key));
      }
      const existing = topicKey !== undefined ? await deps.vault.findByTopicKey(topicKey) : null;
      if (existing !== null && !lockKeys.includes(existing.path)) {
        // The note moved between the pre-lock lookup and acquisition, so the
        // path we would delete is not lock-protected. Drop the locks and
        // retry with fresh state.
        continue;
      }
      return await persistNote(c, deps, { note, newRel, existing, overwrite, requestId });
    } finally {
      // Release is non-blocking; order is irrelevant, completeness is not.
      for (const release of releases) {
        release();
      }
    }
  }
  deps.logger.error("record_note:lock_contention", { requestId, id: note.frontmatter.id });
  return c.json(
    { error: "write_conflict", message: "Target note moved repeatedly; retry the request" },
    503,
  );
}

/**
 * DELETE /notes/:path — removes the note file at a vault-relative path and
 * flags the vanished path for reindexing (same rationale as the rename flow:
 * `qmd update` drops docs whose files are missing, verified against qmd 2.5.3).
 *
 * A single bounded lock attempt is correct here — unlike recordNote there is
 * no unlocked discovery step whose result could go stale, so no move-retry
 * loop is possible: the target path comes straight from the URL and the
 * check+unlink pair runs atomically under the lock.
 */
async function deleteNoteAt(c: Context<AppEnv>, deps: AppDeps) {
  // Undefined is impossible with the `.+` route pattern; coalescing routes
  // any hypothetical miss into the empty-path validation branch.
  const relPath = c.req.param("path") ?? "";
  const issues = notePathIssues(relPath);
  if (issues.length > 0) {
    return c.json({ error: "validation_error", issues }, 400);
  }

  const requestId = c.get("requestId");
  deps.logger.info("delete_note:start", { requestId, path: relPath });

  // Fast-fail before queueing on the lock: the common mistake (wrong path)
  // must not wait behind a concurrent writer.
  if ((await deps.vault.readRaw(relPath)) === null) {
    return c.json({ error: "not_found", message: `No note at ${relPath}` }, 404);
  }

  let release: ReleaseFunction;
  try {
    release = await deps.lock.acquire(relPath);
  } catch {
    deps.logger.error("delete_note:lock_contention", { requestId, path: relPath });
    return c.json(
      { error: "write_conflict", message: "Note is locked by another writer; retry the request" },
      503,
    );
  }

  try {
    // Re-check under the lock: the file may have vanished while we waited.
    const raw = await deps.vault.readRaw(relPath);
    if (raw === null) {
      return c.json({ error: "not_found", message: `No note at ${relPath}` }, 404);
    }
    // Unparseable files (hand-written notes) are deleted too; their raw
    // content travels back so an accidental delete stays recoverable.
    const note = safeParseNote(raw);
    if (!(await deps.vault.deleteNote(relPath))) {
      deps.logger.error("delete_note:failed", { requestId, path: relPath });
      return c.json({ error: "internal_error", message: "Failed to delete note" }, 500);
    }
    await deps.dirty.mark(relPath, requestId);

    deps.logger.info("delete_note:done", { requestId, path: relPath });
    // Best-effort immediate reindex — the periodic tick remains the real
    // guarantee, so a failed tick must not fail the already-durable delete.
    if (deps.scheduler) {
      void deps.scheduler.tick().catch(() => {});
    }
    const response: DeleteResponse = {
      deleted: true,
      path: relPath,
      ...(note !== null ? { note } : { note: null, raw }),
    };
    return c.json(response);
  } finally {
    release();
  }
}

/** Inputs of the locked decision+write step. */
interface PersistArgs {
  note: Note;
  /** Canonical (new) relative path derived from the payload. */
  newRel: string;
  /** Note currently owning the payload's topic_key, when routing applies. */
  existing: TopicKeyMatch | null;
  /** Whether the caller explicitly forces replacement on collision. */
  overwrite: boolean;
  /** Correlation id of the originating HTTP request. */
  requestId: string;
}

/**
 * Decision flow for POST /notes, executed UNDER the path lock(s).
 *
 *  - `topic_key` routing: when a note already owns the payload's key, this
 *    request is an INTENDED UPDATE of that note — even if the new title or
 *    type changes the canonical id/path. The rebuilt note is written at its
 *    new path and the old file is then deleted (write-then-unlink). Only the
 *    single writer holding both path locks runs here, so no reader can see a
 *    half-move, and a crash between the two calls leaves at worst a
 *    duplicate that the next topic_key write re-collapses. No orphan files.
 *  - Otherwise this is a create. A create (keyed or not) landing on an
 *    occupied canonical path is a conflict: 409 with the occupying note's
 *    full raw content, nothing written — unless `overwrite: true` forces the
 *    replacement.
 */
async function persistNote(c: Context<AppEnv>, deps: AppDeps, args: PersistArgs) {
  const { note, newRel, existing, overwrite, requestId } = args;
  try {
    const destRaw = await deps.vault.readRaw(newRel);
    const destNote = destRaw !== null ? safeParseNote(destRaw) : null;

    if (existing !== null) {
      // The destination only conflicts when a DIFFERENT note occupies it —
      // the matched note itself (same path, or a duplicate carrying the same
      // key) is exactly what we intend to update.
      const destIsSameNote =
        existing.path === newRel || destNote?.frontmatter.topic_key === note.frontmatter.topic_key;
      if (destRaw !== null && !destIsSameNote && !overwrite) {
        return noteExistsResponse(c, newRel, destRaw, destNote);
      }
      const renamed = existing.path !== newRel;
      await deps.vault.upsertNote(note);
      if (renamed) {
        await deps.vault.deleteNote(existing.path);
      }
      await deps.dirty.mark(newRel, requestId);
      if (renamed) {
        // Mark the vanished path too. `qmd update` re-scans collections and
        // drops documents whose files are missing from disk (verified against
        // qmd 2.5.3), so the stale index entry is removed on the next tick.
        await deps.dirty.mark(existing.path, requestId);
      }
      const response: UpsertResponse = {
        id: note.frontmatter.id,
        path: newRel,
        created: false,
        ...(renamed ? { moved_from: existing.path } : {}),
      };
      // Log fields carry ids/shapes only — the response body stays as-is.
      deps.logger.info("record_note:done", { requestId, ...response });
      return c.json(response, 200);
    }

    // Create flow (with or without a topic_key nobody owns yet).
    if (destRaw !== null && !overwrite) {
      return noteExistsResponse(c, newRel, destRaw, destNote);
    }
    const result = await deps.vault.upsertNote(note);
    await deps.dirty.mark(result.path, requestId);
    deps.logger.info("record_note:done", {
      requestId,
      id: result.id,
      path: result.path,
      created: result.created,
    });
    const response: UpsertResponse = {
      id: result.id,
      path: result.path,
      created: result.created,
    };
    return c.json(response, result.created ? 201 : 200);
  } catch (e) {
    deps.logger.error("record_note:failed", {
      requestId,
      id: note.frontmatter.id,
      error: String(e),
    });
    return c.json({ error: "internal_error", message: "Failed to persist note" }, 500);
  }
}

/**
 * Builds the 409 conflict answer. `existing.body` is the FULL raw markdown
 * source of the on-disk file — raw content, never re-serialized — so the
 * caller sees exactly what it collides with.
 */
function noteExistsResponse(c: Context, relPath: string, raw: string, parsed: Note | null) {
  const fallbackId = relPath.split("/").pop()?.replace(/\.md$/, "") ?? relPath;
  const id = parsed?.frontmatter.id ?? fallbackId;
  return c.json({ error: "note_exists", existing: { id, path: relPath, body: raw } }, 409);
}

/** Parses a note, returning null instead of throwing on invalid content. */
function safeParseNote(source: string): Note | null {
  try {
    return parseNote(source);
  } catch {
    return null;
  }
}

interface ValidationIssue {
  field: string;
  message: string;
}

function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Structural validation for a vault-relative note path (DELETE /notes/:path).
 *
 * Deliberately NOT a strict `<type>s/<id>.md` pattern: the vault tolerates
 * nested and hand-written files, so only shapes that could escape the vault
 * or touch system state are rejected. Note that a standards-compliant URL
 * parser resolves `..` (and `%2e`-encoded) dot-segments before routing, so
 * that rule is defense-in-depth for non-HTTP callers, not a live route case.
 */
function notePathIssues(relPath: string): ValidationIssue[] {
  if (relPath.length === 0) {
    return [{ field: "path", message: "path must not be empty" }];
  }
  const issues: ValidationIssue[] = [];
  if (relPath.includes("\\")) {
    issues.push({ field: "path", message: "path must use / as separator" });
  }
  if (relPath.startsWith("/")) {
    issues.push({ field: "path", message: "path must be vault-relative, not absolute" });
  }
  if (!relPath.endsWith(".md")) {
    issues.push({ field: "path", message: "path must end in .md" });
  }
  for (const segment of relPath.split("/")) {
    if (segment === "") {
      issues.push({ field: "path", message: "path must not contain empty segments" });
    } else if (segment === "..") {
      issues.push({ field: "path", message: "path must not contain .. segments" });
    } else if (segment.startsWith(".")) {
      // Blocks `.ams/`, `.qmd/` — system state, never note content.
      issues.push({ field: "path", message: "path must not enter dot-directories" });
    }
  }
  return issues;
}
