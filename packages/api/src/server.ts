/**
 * Process entry point for the Write API.
 *
 * Wires real collaborators from configuration and starts the HTTP server.
 * Kept thin on purpose: all logic lives in testable modules; this file only
 * composes them and binds the port.
 */

import { join } from "node:path";
import { createLogger } from "@ams/shared";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { DirtyStore } from "./dirty.js";
import { CliReindexer, IndexScheduler, loadIndexConfig } from "./indexing/index.js";
import { WriteLock } from "./lock.js";
import { Vault } from "./vault.js";

/** Builds the production dependency graph from resolved configuration. */
export function buildProductionDeps(config: ApiConfig) {
  const vault = new Vault(config.vaultPath);
  const lock = new WriteLock(config.lockTtlMs);
  const dirty = new DirtyStore(join(config.vaultPath, ".ams", "dirty.json"));
  const logger = createLogger();

  // Scheduler: cron-driven reindex of the QMD collection. Constructed even
  // when disabled so the manual /admin/reindex endpoint still works; `start()`
  // is the no-op gate for the periodic task.
  const indexConfig = loadIndexConfig();
  const reindexer = new CliReindexer({
    qmdBin: indexConfig.qmdBin,
    collection: indexConfig.collection,
  });
  const scheduler = new IndexScheduler({
    dirty,
    reindexer,
    logger,
    cronExpression: indexConfig.cron,
    enabled: indexConfig.enabled,
  });

  return { vault, lock, dirty, logger, scheduler };
}

/** Loads config, exiting the process with a readable message on failure. */
function loadConfigOrExit(): ApiConfig {
  try {
    return loadConfig();
  } catch (e) {
    process.stderr.write(`Configuration error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

function main(): void {
  const config = loadConfigOrExit();
  const deps = buildProductionDeps(config);
  const app = createApp(deps);

  // Start the background indexer alongside the HTTP server.
  deps.scheduler.start();

  // Tear the scheduler down on shutdown so an in-flight tick can't keep the
  // process (or a tick mid-reindex) alive past the port being released.
  const shutdown = (signal: string) => {
    deps.logger.info("ams-write-api:shutdown", { signal });
    deps.scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    deps.logger.info("ams-write-api:listening", {
      port: info.port,
      vault: config.vaultPath,
      lockTtlMs: config.lockTtlMs,
    });
  });
}

main();
