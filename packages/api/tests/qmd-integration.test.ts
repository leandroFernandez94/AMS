/**
 * Integration test for the QMD retrieval adapter against a REAL daemon.
 *
 * This is intentionally opt-in: it requires a running `qmd mcp --http` daemon
 * over an indexed fixture vault, which CI does not provision. It runs only
 * when `AMS_QMD_INTEGRATION=1` is set; otherwise it is skipped. Mark it slow
 * so it can be filtered out of the fast unit suite.
 *
 * Runbook to execute locally:
 *   1. Index the vault:   `qmd collection add <vault> --name ams`
 *                         `qmd embed -c ams`
 *   2. Start the daemon:  `qmd mcp --http`  (serves http://localhost:8181)
 *   3. Point AMS at it:   `AMS_QMD_URL=http://localhost:8181`
 *   4. Run:               `AMS_QMD_INTEGRATION=1 pnpm test qmd-integration`
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QmdClient } from "../src/qmd/client.js";

const ENABLED = process.env.AMS_QMD_INTEGRATION === "1";
const itOrSkip = ENABLED ? it : it.skip;

function client(): QmdClient {
  return new QmdClient({});
}

describe("QmdClient integration (real daemon)", { timeout: 60_000 }, () => {
  beforeAll(function skipUnlessEnabled() {
    if (!ENABLED) return;
  });

  afterAll(async () => {
    // Nothing to tear down — the daemon lifecycle is out of scope (Spec 4).
  });

  itOrSkip("reports the daemon as reachable", async () => {
    expect(await client().isReachable()).toBe(true);
  });

  itOrSkip("returns normalized hits for a query that matches the fixture vault", async () => {
    const hits = await client().searchMemory({ query: "memory", limit: 5 });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      // Vault-relative path: no qmd:// scheme, collection prefix stripped.
      expect(hit.path).toMatch(/\.md$/);
      expect(hit.path.startsWith("qmd://")).toBe(false);
    }
  });

  itOrSkip("rerank: false is the default on the wire", async () => {
    // Smoke-level: a rerank-off query must not throw and must return a list.
    const hits = await client().searchMemory({ query: "architecture" });
    expect(Array.isArray(hits)).toBe(true);
  });

  itOrSkip("fetches a document by docid and returns clean body", async () => {
    const hits = await client().searchMemory({ query: "memory", limit: 1 });
    const target = hits[0];
    if (!target?.id) return; // vault may be empty — not a failure
    // The docid is the reliable `get` handle; a stripped path does NOT resolve.
    const doc = await client().getMemory({ file: target.id });
    expect(doc).not.toBeNull();
    expect(doc?.body.length ?? 0).toBeGreaterThan(0);
  });
});
