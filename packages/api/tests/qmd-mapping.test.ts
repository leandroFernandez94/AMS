import { describe, expect, it } from "vitest";
import {
  type MemoryHit,
  mapDocument,
  mapSearchResults,
  stripContextComment,
  stripQmdUri,
} from "../src/qmd/mapping.js";

describe("stripQmdUri", () => {
  it("strips the qmd:// scheme and the collection segment", () => {
    expect(stripQmdUri("qmd://ams-test-vault/decisions/2026-07-01-x.md")).toBe(
      "decisions/2026-07-01-x.md",
    );
  });

  it("strips the collection segment from a bare collection/path form", () => {
    // QMD's structuredContent emits files as "<collection>/<relpath>".
    expect(stripQmdUri("ams-test-vault/patterns/foo.md")).toBe("patterns/foo.md");
  });

  it("returns an empty string for empty input", () => {
    expect(stripQmdUri("")).toBe("");
  });

  it("returns the input unchanged when it has no path separator", () => {
    expect(stripQmdUri("#abc123")).toBe("#abc123");
  });
});

describe("stripContextComment", () => {
  it("removes QMD's injected context preamble", () => {
    const text = "<!-- Context: AMS memory notes -->\n\n---\nid: x\n---\n\nbody";
    expect(stripContextComment(text)).toBe("---\nid: x\n---\n\nbody");
  });

  it("leaves text without a context comment untouched", () => {
    const text = "---\nid: x\n---\n\nbody";
    expect(stripContextComment(text)).toBe(text);
  });
});

describe("mapSearchResults", () => {
  it("maps a { results: [...] } structuredContent payload into AMS hits", () => {
    const payload = {
      results: [
        {
          docid: "#abc123",
          score: 0.89,
          file: "ams-test-vault/decisions/2026-07-01-use-qmd.md",
          title: "Use QMD for retrieval",
          snippet: "We will use QMD as the local engine.",
        },
      ],
    };
    expect(mapSearchResults(payload)).toEqual<MemoryHit[]>([
      {
        id: "#abc123",
        path: "decisions/2026-07-01-use-qmd.md",
        title: "Use QMD for retrieval",
        snippet: "We will use QMD as the local engine.",
        score: 0.89,
      },
    ]);
  });

  it("accepts a bare array of hits", () => {
    const hits = mapSearchResults([{ docid: "#1", file: "c/a.md", score: 0.5 }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("a.md");
  });

  it("unwraps a { docs: [...] } envelope", () => {
    const hits = mapSearchResults({ docs: [{ docid: "#2", file: "c/a.md", score: 1 }] });
    expect(hits).toHaveLength(1);
  });

  it("coerces missing/non-numeric scores to 0", () => {
    const hits = mapSearchResults([{ docid: "#3", file: "c/a.md" }]);
    expect(hits[0]?.score).toBe(0);
  });

  it("defaults missing strings to empty values", () => {
    const hits = mapSearchResults([{ file: "c/a.md", score: 0.2 }]);
    expect(hits[0]).toMatchObject({ id: "", title: "", snippet: "" });
  });

  it("returns an empty array for non-array, non-envelope payloads", () => {
    expect(mapSearchResults(null)).toEqual([]);
    expect(mapSearchResults({})).toEqual([]);
    expect(mapSearchResults("nope")).toEqual([]);
  });
});

describe("mapDocument", () => {
  it("maps a get resource into an AMS MemoryDoc, stripping the context comment", () => {
    const doc = mapDocument({
      uri: "qmd://ams-test-vault/decisions/x.md",
      text: "<!-- Context: AMS memory notes -->\n\n---\nbody",
    });
    expect(doc).toEqual({
      id: "",
      path: "decisions/x.md",
      body: "---\nbody",
    });
  });

  it("carries the docid when supplied by the caller", () => {
    const doc = mapDocument({ uri: "qmd://c/d.md", text: "x" }, "#abc");
    expect(doc?.id).toBe("#abc");
  });

  it("returns null for an empty/missing resource", () => {
    expect(mapDocument(null)).toBeNull();
    expect(mapDocument({})).toBeNull();
    expect(mapDocument({ uri: "", text: "   " })).toBeNull();
  });
});
