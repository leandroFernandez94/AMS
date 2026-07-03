import { describe, expect, it } from "vitest";
import { DEFAULT_QMD_URL, loadQmdConfig, QMD_URL_ENV } from "../src/qmd/config.js";

describe("loadQmdConfig", () => {
  it(`exposes the env var name ${QMD_URL_ENV}`, () => {
    expect(QMD_URL_ENV).toBe("AMS_QMD_URL");
  });

  it("defaults to the local daemon URL when unset", () => {
    expect(loadQmdConfig({})).toEqual({ url: DEFAULT_QMD_URL });
    expect(DEFAULT_QMD_URL).toBe("http://localhost:8181");
  });

  it("honors an explicit AMS_QMD_URL", () => {
    expect(loadQmdConfig({ AMS_QMD_URL: "http://qmd.local:9000" })).toEqual({
      url: "http://qmd.local:9000",
    });
  });

  it("strips a trailing slash from the URL", () => {
    expect(loadQmdConfig({ AMS_QMD_URL: "http://localhost:8181///" })).toEqual({
      url: "http://localhost:8181",
    });
  });

  it("falls back to the default when the value is blank", () => {
    expect(loadQmdConfig({ AMS_QMD_URL: "   " }).url).toBe(DEFAULT_QMD_URL);
  });
});
