import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDEX_CRON,
  INDEX_CRON_ENV,
  INDEX_ENABLED_ENV,
  IndexConfigError,
  loadIndexConfig,
  QMD_BIN_ENV,
  QMD_COLLECTION_ENV,
} from "../src/indexing/config.js";

describe("loadIndexConfig", () => {
  it("returns the default cron and enabled flag when nothing is set", () => {
    const cfg = loadIndexConfig({});
    expect(cfg.cron).toBe(DEFAULT_INDEX_CRON);
    expect(cfg.enabled).toBe(true);
    expect(cfg.collection).toBeUndefined();
    expect(cfg.qmdBin).toBe("qmd");
  });

  it("reads a custom cron expression", () => {
    const cfg = loadIndexConfig({ [INDEX_CRON_ENV]: "*/5 * * * *" });
    expect(cfg.cron).toBe("*/5 * * * *");
  });

  it("throws IndexConfigError on an invalid cron expression", () => {
    expect(() => loadIndexConfig({ [INDEX_CRON_ENV]: "not a cron" })).toThrow(IndexConfigError);
    expect(() => loadIndexConfig({ [INDEX_CRON_ENV]: "99 99 99 99 99" })).toThrow(IndexConfigError);
  });

  it("parses the enabled flag from common truthy/falsy literals", () => {
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "false" }).enabled).toBe(false);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "0" }).enabled).toBe(false);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "off" }).enabled).toBe(false);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "no" }).enabled).toBe(false);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "true" }).enabled).toBe(true);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "1" }).enabled).toBe(true);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "yes" }).enabled).toBe(true);
    expect(loadIndexConfig({ [INDEX_ENABLED_ENV]: "" }).enabled).toBe(true);
  });

  it("forwards the collection name and qmd binary", () => {
    const cfg = loadIndexConfig({
      [QMD_COLLECTION_ENV]: "ams",
      [QMD_BIN_ENV]: "/usr/local/bin/qmd",
    });
    expect(cfg.collection).toBe("ams");
    expect(cfg.qmdBin).toBe("/usr/local/bin/qmd");
  });
});
