import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@ams/mcp", () => {
  it("re-exports the shared package name via workspace reference", () => {
    expect(PACKAGE_NAME).toBe("@ams/shared");
  });
});
