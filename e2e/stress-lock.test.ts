import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createLogger, DirtyStore, Vault, WriteLock } from "@ams/api";
import { parseNote } from "@ams/shared";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end stress for the WriteLock stale-release fix.
 *
 * The app runs in-process with a deliberately tiny lock TTL so expiries fire
 * while requests still queue for and hold the path locks. Under that pressure
 * the vault must stay coherent: exactly one note file per topic_key, its body
 * one of the payloads we sent, and no 5xx beyond the defined
 * `write_conflict` 503.
 */

/** Small enough that TTL expiries hit mid-storm, large enough to boot. */
const STRESS_TTL_MS = 10;
const REQUESTS_PER_PHASE = 20;
/** Bounded settle polling — keeps the worst case well under the test timeout. */
const SETTLE_ATTEMPTS = 20;
const SETTLE_DELAY_MS = 100;

interface StressHarness {
  apiUrl: string;
  vaultPath: string;
  teardown(): Promise<void>;
}

/**
 * Boots the Write API in-process with an injected short-TTL WriteLock.
 *
 * Mirrors `createE2eFixture`'s app wiring but skips the QMD daemon and MCP
 * layers: this suite asserts on the vault files themselves, so lock behavior
 * under TTL pressure is the only thing under test.
 */
async function bootHarness(ttlMs: number): Promise<StressHarness> {
  const root = await mkdtemp(join(tmpdir(), "ams-stress-"));
  const vaultPath = join(root, "vault");
  await mkdir(vaultPath);

  const app = createApp({
    vault: new Vault(vaultPath),
    lock: new WriteLock(ttlMs),
    dirty: new DirtyStore(join(vaultPath, ".ams", "dirty.json")),
    logger: createLogger(() => undefined, "error"),
  });

  let httpServer: ServerType | undefined;
  const apiUrl = await new Promise<string>((resolve, reject) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(`http://127.0.0.1:${info.port}`);
    });
    httpServer.on("error", reject);
  });

  return {
    apiUrl,
    vaultPath,
    teardown: async () => {
      try {
        httpServer?.close();
      } catch {
        /* best effort */
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface StormResult {
  status: number;
  error: string | undefined;
}

/** Fires one POST /notes and reduces the answer to status + error code. */
async function postNote(apiUrl: string, payload: Record<string, unknown>): Promise<StormResult> {
  const res = await fetch(`${apiUrl}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: body.error };
}

/** Only 200/201 and the defined 503 write_conflict are acceptable answers. */
function assertAllowedStatuses(results: StormResult[]): void {
  const offenders = results.filter(
    (r) =>
      !(r.status === 200 || r.status === 201 || (r.status === 503 && r.error === "write_conflict")),
  );
  if (offenders.length > 0) {
    throw new Error(
      `Unexpected responses: ${offenders.map((r) => `${r.status}(${r.error ?? "no error code"})`).join(", ")}`,
    );
  }
}

interface VaultScan {
  topicKeyMatches: { relPath: string; body: string }[];
  /** Every .md file that failed to parse — in this vault that IS corruption. */
  unparseable: string[];
}

/** Scans the vault for note files; dot-directories like `.ams/` are skipped. */
async function scanVault(vaultPath: string, topicKey: string): Promise<VaultScan> {
  const entries = await readdir(vaultPath, { recursive: true });
  const noteFiles = entries.filter(
    (p): p is string =>
      typeof p === "string" && p.endsWith(".md") && !p.split("/").some((s) => s.startsWith(".")),
  );

  const topicKeyMatches: { relPath: string; body: string }[] = [];
  const unparseable: string[] = [];
  for (const relPath of noteFiles) {
    try {
      const note = parseNote(await readFile(join(vaultPath, relPath), "utf8"));
      if (note.frontmatter.topic_key === topicKey) {
        topicKeyMatches.push({ relPath, body: note.body });
      }
    } catch {
      unparseable.push(relPath);
    }
  }
  return { topicKeyMatches, unparseable };
}

/**
 * Polls until exactly one parseable file carries the topic key, then returns
 * the final scan either way so the caller's assertion reports the real state.
 */
async function settleToSingleNote(vaultPath: string, topicKey: string): Promise<VaultScan> {
  let scan = await scanVault(vaultPath, topicKey);
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (scan.topicKeyMatches.length === 1 && scan.unparseable.length === 0) return scan;
    await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS));
    scan = await scanVault(vaultPath, topicKey);
  }
  return scan;
}

describe("write-lock TTL stress", () => {
  let harness: StressHarness;

  beforeAll(async () => {
    harness = await bootHarness(STRESS_TTL_MS);
  }, 60_000);

  afterAll(async () => {
    await harness.teardown();
  }, 30_000);

  it("survives a same-path storm under TTL pressure with one coherent file", async () => {
    const topicKey = "stress/same-path";
    const bodies = Array.from(
      { length: REQUESTS_PER_PHASE },
      (_, i) => `same-path stress body #${i}`,
    );

    const results = await Promise.all(
      bodies.map((body) =>
        postNote(harness.apiUrl, {
          title: "Stress Same Path Note",
          type: "note",
          body,
          topic_key: topicKey,
        }),
      ),
    );
    assertAllowedStatuses(results);

    const scan = await settleToSingleNote(harness.vaultPath, topicKey);
    expect(scan.unparseable).toEqual([]);
    expect(scan.topicKeyMatches).toHaveLength(1);
    expect(bodies).toContain(scan.topicKeyMatches[0]?.body);
  });

  it("survives rename churn under TTL pressure with no duplicates or orphans", async () => {
    const topicKey = "stress/rename-churn";
    const alpha = "notes/stress-churn-alpha.md";
    const beta = "notes/stress-churn-beta.md";
    const bodies = Array.from(
      { length: REQUESTS_PER_PHASE },
      (_, i) => `rename-churn stress body #${i}`,
    );

    // Alternating titles map to two canonical paths, forcing the two-lock
    // rename flow (write new path, unlink old) on every request.
    const results = await Promise.all(
      bodies.map((body, i) =>
        postNote(harness.apiUrl, {
          title: i % 2 === 0 ? "Stress Churn Alpha" : "Stress Churn Beta",
          type: "note",
          body,
          topic_key: topicKey,
        }),
      ),
    );
    assertAllowedStatuses(results);

    const scan = await settleToSingleNote(harness.vaultPath, topicKey);
    expect(scan.unparseable).toEqual([]);
    expect(scan.topicKeyMatches).toHaveLength(1);

    // Exactly one of the two churned paths survives; the other is no orphan.
    const survivors = [alpha, beta].filter((relPath) =>
      scan.topicKeyMatches.some((m) => m.relPath === relPath),
    );
    expect(survivors).toHaveLength(1);
    expect(bodies).toContain(scan.topicKeyMatches[0]?.body);
  });
});
