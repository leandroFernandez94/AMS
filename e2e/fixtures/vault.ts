import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CliReindexer,
  createApp,
  createLogger,
  DirtyStore,
  IndexScheduler,
  QmdClient,
  Vault,
  WriteLock,
} from "@ams/api";
import { createServer as createMcpServer } from "@ams/mcp";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const execFileP = promisify(execFile);

/** A fully booted tracer fixture with all resources needed for a test. */
export interface TracerFixture {
  /** Temp fixture root — cwd for every spawned qmd process. */
  root: string;
  /** Vault directory served by the Write API (<root>/vault). */
  vaultPath: string;
  /** Write API base URL on its ephemeral port. */
  apiUrl: string;
  /** Live daemon base URL on its dynamically probed port. */
  qmdUrl: string;
  /** QmdClient aimed at the live daemon (same instance the MCP server uses). */
  qmdClient: QmdClient;
  /** Connected in-process MCP client (SDK Client over InMemoryTransport). */
  mcp: Client;
  /** Convenience: POST /admin/reindex, returns the parsed TickResult JSON. */
  reindex(): Promise<{ status: string; indexed: number; pending: number }>;
  /** Idempotent, best-effort teardown. */
  teardown(): Promise<void>;
}

/** Probes an ephemeral TCP port and returns it after releasing the socket. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to probe ephemeral port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

/**
 * Runs `qmd mcp --http --port <p>` with the fixture cwd.
 *
 * Detects a premature exit caused by EADDRINUSE and retries with a fresh probed
 * port, up to 3 attempts. This is the daemon-boot seam used by the fixture and
 * by the port-taken scenario test.
 */
export async function startQmdDaemon(
  cwd: string,
  nextPort: () => Promise<number> = freePort,
): Promise<{ child: ChildProcess; port: number; url: string }> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await nextPort();
    const child = spawn("qmd", ["mcp", "--http", "--port", String(port)], {
      cwd,
      env: { ...process.env, PWD: cwd },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(true);
      }, 750);

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stderr += String(error);
        resolve(false);
      });

      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stderr += ` (exit ${code ?? "signal"})`;
        resolve(false);
      });
    });

    if (ok) {
      return { child, port, url: `http://localhost:${port}` };
    }

    lastError = stderr.trim();
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    if (!lastError.includes("EADDRINUSE") && attempt === 3) {
      throw new Error(`qmd daemon failed to start: ${lastError}`);
    }
  }
  throw new Error(`qmd daemon failed after 3 attempts (port in use): ${lastError}`);
}

/** Snapshots global and parent locations so a test can assert isolation. */
export function createIsolationCanary(): { assertUnchanged(): void } {
  const repoRoot = process.cwd();
  const globalIndexPath = join(homedir(), ".cache", "qmd", "index.sqlite");
  const globalStat = (() => {
    try {
      const s = statSync(globalIndexPath);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  })();
  const repoHadQmd = existsSync(join(repoRoot, ".qmd"));
  const tmpQmdBefore = new Set(listQmdDirs(tmpdir()));

  return {
    assertUnchanged() {
      if (globalStat !== null) {
        const now = statSync(globalIndexPath);
        if (now.mtimeMs !== globalStat.mtimeMs || now.size !== globalStat.size) {
          throw new Error(`Global QMD index changed: ${globalIndexPath}`);
        }
      } else if (existsSync(globalIndexPath)) {
        throw new Error(`Global QMD index was created: ${globalIndexPath}`);
      }
      if (!repoHadQmd && existsSync(join(repoRoot, ".qmd"))) {
        throw new Error("Repo root .qmd appeared");
      }
      const tmpQmdNow = new Set(listQmdDirs(tmpdir()));
      for (const dir of tmpQmdNow) {
        if (!tmpQmdBefore.has(dir)) {
          throw new Error(`New .qmd artifact in tmpdir: ${dir}`);
        }
      }
    },
  };
}

/** Lists directories ending in `.qmd` directly under `root`. */
function listQmdDirs(root: string): string[] {
  const result: string[] = [];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(".qmd")) {
        result.push(join(root, entry.name));
      }
    }
  } catch {
    // tmpdir may contain unreadable entries; ignore.
  }
  return result;
}

/** Runs a `qmd` CLI command pinned to the fixture cwd. */
async function runQmd(cwd: string, args: string[]): Promise<void> {
  const { stderr } = await execFileP("qmd", args, {
    cwd,
    env: { ...process.env, PWD: cwd },
  });
  if (stderr) {
    // qmd sometimes writes progress to stderr; only fail on explicit errors.
    if (stderr.toLowerCase().includes("error")) {
      throw new Error(`qmd ${args.join(" ")} failed: ${stderr}`);
    }
  }
}

/** Builds a cwd-scoped CommandRunner for the CliReindexer. */
function createFixtureRunner(cwd: string) {
  return async (command: string, args: string[]) => {
    try {
      const { stdout, stderr } = await execFileP(command, args, {
        cwd,
        env: { ...process.env, PWD: cwd },
        timeout: 5 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
      const code = typeof err.code === "number" ? err.code : -1;
      return {
        code,
        stdout: err.stdout ?? "",
        stderr: err.stderr?.trim() || err.stdout?.trim() || err.message || "unknown error",
      };
    }
  };
}

/** Polls the daemon until `QmdClient#isReachable()` succeeds or the cap hits. */
async function waitForReachable(client: QmdClient, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  let interval = 250;
  while (Date.now() - started < timeoutMs) {
    if (await client.isReachable()) return;
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 2000);
  }
  throw new Error("QMD daemon did not become reachable within timeout");
}

/**
 * Creates a fully isolated tracer fixture:
 * temp vault → qmd init → collection add → Write API (port 0) → QMD daemon → MCP client.
 */
export async function createTracerFixture(): Promise<TracerFixture> {
  const root = await mkdtemp(join(tmpdir(), "ams-tracer-"));
  const vaultPath = join(root, "vault");
  await mkdir(vaultPath);

  await runQmd(root, ["init"]);
  await runQmd(root, ["collection", "add", vaultPath, "--name", "ams"]);

  const vault = new Vault(vaultPath);
  const lock = new WriteLock(5000);
  const dirty = new DirtyStore(join(vaultPath, ".ams", "dirty.json"));
  const logger = createLogger(() => undefined, "error");

  const reindexer = new CliReindexer({
    collection: "ams",
    run: createFixtureRunner(root),
  });

  const scheduler = new IndexScheduler({
    dirty,
    reindexer,
    logger,
    cronExpression: "*/2 * * * *",
    enabled: false,
  });

  const app = createApp({ vault, lock, dirty, logger, scheduler });

  let httpServer: ServerType | undefined;
  const apiUrl = await new Promise<string>((resolve, reject) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(`http://127.0.0.1:${info.port}`);
    });
    httpServer.on("error", reject);
  });

  const { child, url: qmdUrl } = await startQmdDaemon(root);
  const qmdClient = new QmdClient({ url: qmdUrl });
  await waitForReachable(qmdClient);

  const server = createMcpServer({ apiUrl, qmdClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "ams-tracer", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);

  return {
    root,
    vaultPath,
    apiUrl,
    qmdUrl,
    qmdClient,
    mcp,
    reindex: async () => {
      const res = await fetch(`${apiUrl}/admin/reindex`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Reindex failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as { status: string; indexed: number; pending: number };
    },
    teardown: async () => {
      try {
        await mcp.close();
      } catch {
        /* best effort */
      }
      try {
        httpServer?.close();
      } catch {
        /* best effort */
      }
      if (child && !child.killed) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]).catch(() => {
          child.kill("SIGKILL");
        });
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
