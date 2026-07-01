import { describe, expect, it } from "vitest";
import { isNonEmpty, PACKAGE_NAME } from "../src/index.js";

describe("@ams/shared", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@ams/shared");
  });

  it("treats whitespace-only strings as empty", () => {
    expect(isNonEmpty("   ")).toBe(false);
    expect(isNonEmpty("x")).toBe(true);
  });
});
