/**
 * Process entry point for the Write API.
 *
 * Wires real collaborators from configuration and starts the HTTP server.
 * Kept thin on purpose: all logic lives in testable modules; this file only
 * composes them and binds the port.
 */

import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { DirtyStore } from "./dirty.js";
import { WriteLock } from "./lock.js";
import { createLogger } from "./logger.js";
import { Vault } from "./vault.js";

/** Builds the production dependency graph from resolved configuration. */
export function buildProductionDeps(config: ApiConfig) {
  return {
    vault: new Vault(config.vaultPath),
    lock: new WriteLock(config.lockTtlMs),
    dirty: new DirtyStore(join(config.vaultPath, ".ams", "dirty.json")),
    logger: createLogger(),
  };
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

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    deps.logger.info("ams-write-api:listening", {
      port: info.port,
      vault: config.vaultPath,
      lockTtlMs: config.lockTtlMs,
    });
  });
}

main();
