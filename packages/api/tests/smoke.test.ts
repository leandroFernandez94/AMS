import { describe, expect, it } from "vitest";
import { isNonEmpty } from "../src/index.js";

describe("@ams/api", () => {
  it("uses the shared guard via workspace reference", () => {
    expect(isNonEmpty("valid")).toBe(true);
    expect(isNonEmpty("")).toBe(false);
  });
});
