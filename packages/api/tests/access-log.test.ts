import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApp,
  createLogger,
  DirtyStore,
  type LogEntry,
  Vault,
  WriteLock,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "ams-access-log-"));
});

afterEach(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

/** Logger that buffers parsed entries so tests can assert on structured output. */
function bufferLogger() {
  const entries: LogEntry[] = [];
  const logger = createLogger((line) => entries.push(JSON.parse(line)), "debug");
  return Object.assign(logger, { entries });
}

function makeApp() {
  const logger = bufferLogger();
  const app = createApp({
    vault: new Vault(vaultDir),
    lock: new WriteLock(5000),
    dirty: new DirtyStore(join(vaultDir, ".ams", "dirty.json")),
    logger,
  });
  return { app, logger };
}

function post(app: ReturnType<typeof createApp>, body: unknown, headers?: Record<string, string>) {
  return app.request("/notes", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const basePayload = {
  title: "Use QMD for retrieval",
  type: "decision",
  body: "We will use [[qmd]] as the local hybrid retrieval engine.",
  date: "2026-07-01",
};

/** Entries emitted for one msg, in emission order. */
const byMsg = (entries: LogEntry[], msg: string) => entries.filter((e) => e.msg === msg);

// ---------------------------------------------------------------------------
// One access-log line per request
// ---------------------------------------------------------------------------

describe("access log — http:request:done", () => {
  it("emits exactly one line for a successful GET /health", async () => {
    const { app, logger } = makeApp();

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const lines = byMsg(logger.entries, "http:request:done");
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.level).toBe("info");
    expect(entry.requestId).toMatch(/^req_/);
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe("number");
  });

  it("emits exactly one line for a POST /notes happy path, sharing the requestId with record_note lines", async () => {
    const { app, logger } = makeApp();

    const res = await post(app, basePayload);
    expect(res.status).toBe(201);

    const access = byMsg(logger.entries, "http:request:done");
    expect(access).toHaveLength(1);
    const recordNote = logger.entries.filter((e) => e.msg.startsWith("record_note:"));
    expect(recordNote.length).toBeGreaterThanOrEqual(2);
    for (const entry of recordNote) {
      expect(entry.requestId).toBe(access[0].requestId);
    }
    expect(access[0].level).toBe("info");
    expect(access[0].method).toBe("POST");
    expect(access[0].path).toBe("/notes");
    expect(access[0].status).toBe(201);
    expect(typeof access[0].durationMs).toBe("number");
  });

  it("logs a 400 validation error at warn level", async () => {
    const { app, logger } = makeApp();

    const res = await post(app, { type: "decision", body: "no title" });
    expect(res.status).toBe(400);

    const access = byMsg(logger.entries, "http:request:done");
    expect(access).toHaveLength(1);
    expect(access[0].level).toBe("warn");
    expect(access[0].status).toBe(400);
  });

  it("logs a 409 conflict at warn level", async () => {
    const { app, logger } = makeApp();

    await post(app, basePayload);
    logger.entries.length = 0;
    const res = await post(app, { ...basePayload, body: "Clobber attempt." });
    expect(res.status).toBe(409);

    const access = byMsg(logger.entries, "http:request:done");
    expect(access).toHaveLength(1);
    expect(access[0].level).toBe("warn");
    expect(access[0].status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Correlation id resolution
// ---------------------------------------------------------------------------

describe("access log — requestId resolution", () => {
  it("honors an inbound x-request-id and echoes it on the response", async () => {
    const { app, logger } = makeApp();

    const res = await post(app, basePayload, { "x-request-id": "req_test123" });

    expect(res.headers.get("x-request-id")).toBe("req_test123");
    const access = byMsg(logger.entries, "http:request:done");
    expect(access).toHaveLength(1);
    expect(access[0].requestId).toBe("req_test123");
    for (const entry of logger.entries.filter((e) => e.msg.startsWith("record_note:"))) {
      expect(entry.requestId).toBe("req_test123");
    }
  });

  it("generates a fresh id when no header is sent and echoes it on the response", async () => {
    const { app, logger } = makeApp();

    const res = await app.request("/health");

    const access = byMsg(logger.entries, "http:request:done")[0];
    expect(access.requestId).toMatch(/^req_/);
    expect(res.headers.get("x-request-id")).toBe(access.requestId);
  });

  it("falls back to a generated id when the inbound header exceeds 128 characters", async () => {
    const { app, logger } = makeApp();
    const overlong = `req_${"a".repeat(200)}`;

    const res = await app.request("/health", { headers: { "x-request-id": overlong } });

    const access = byMsg(logger.entries, "http:request:done")[0];
    expect(access.requestId).toMatch(/^req_/);
    expect(access.requestId).not.toBe(overlong);
    expect(res.headers.get("x-request-id")).toBe(access.requestId);
  });
});
