/**
 * HTTP application for the Write API.
 *
 * The single semantic operation for the tracer bullet is `record_note`,
 * exposed as `POST /notes`. Agents never touch the filesystem directly —
 * every mutation is validated, lock-protected and flagged for the indexer.
 *
 * Dependencies are injected via `createApp` so tests can wire a temp vault,
 * a fake lock or a spy logger without spinning up a real server or touching
 * the real environment.
 */
import {
  buildNote,
  FrontmatterSchema,
  isCoherent,
  isIsoDate,
  type Note,
  notePath,
} from "@ams/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { DirtyStore } from "./dirty.js";
import type { IndexScheduler } from "./indexing/scheduler.js";
import type { WriteLock } from "./lock.js";
import type { Logger } from "./logger.js";
import type { Vault } from "./vault.js";

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
});

export type NoteInput = z.infer<typeof NoteInputSchema>;

/** Builds a fresh Hono app wired to the supplied dependencies. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/notes", async (c) => recordNote(c, deps));

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

async function recordNote(c: Context, deps: AppDeps, now: () => Date = () => new Date()) {
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

  const lockKey = notePath(note.frontmatter.id, note.frontmatter.type);
  deps.logger.info("record_note:start", { id: note.frontmatter.id, path: lockKey });

  // 5. Lock the canonical path, then upsert + flag. The TTL guarantees the
  //    lock is freed even if this handler blows up between acquire and release.
  const release = await deps.lock.acquire(lockKey);
  try {
    const result = await deps.vault.upsertNote(note);
    await deps.dirty.mark(result.path);
    deps.logger.info("record_note:done", {
      id: result.id,
      path: result.path,
      created: result.created,
    });
    return c.json(
      { id: result.id, path: result.path, created: result.created },
      result.created ? 201 : 200,
    );
  } catch (e) {
    deps.logger.error("record_note:failed", { id: note.frontmatter.id, error: String(e) });
    return c.json({ error: "internal_error", message: "Failed to persist note" }, 500);
  } finally {
    release();
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
