import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_LOCK_TTL_MS, DEFAULT_PORT, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires AMS_VAULT_PATH", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ AMS_VAULT_PATH: "   " })).toThrow(ConfigError);
  });

  it("applies default port and lock TTL when unset", () => {
    const cfg = loadConfig({ AMS_VAULT_PATH: "/tmp/vault" });
    expect(cfg).toEqual({
      vaultPath: "/tmp/vault",
      port: DEFAULT_PORT,
      lockTtlMs: DEFAULT_LOCK_TTL_MS,
    });
  });

  it("parses explicit port and lock TTL", () => {
    const cfg = loadConfig({
      AMS_VAULT_PATH: "/tmp/vault",
      AMS_API_PORT: "8080",
      AMS_LOCK_TTL_MS: "1234",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.lockTtlMs).toBe(1234);
  });

  it("rejects non-numeric port", () => {
    expect(() => loadConfig({ AMS_VAULT_PATH: "/v", AMS_API_PORT: "not-a-port" })).toThrow(
      ConfigError,
    );
  });

  it("rejects negative lock TTL", () => {
    expect(() => loadConfig({ AMS_VAULT_PATH: "/v", AMS_LOCK_TTL_MS: "-5" })).toThrow(ConfigError);
  });
});
