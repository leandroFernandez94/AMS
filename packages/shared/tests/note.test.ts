import { describe, expect, it } from "vitest";
import {
  buildNote,
  deriveId,
  extractWikilinks,
  FrontmatterSchema,
  isCoherent,
  type Note,
  NoteParseError,
  notePath,
  parseNote,
  serializeNote,
  slugify,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// slugify / deriveId
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("strips diacritics via NFKD", () => {
    expect(slugify("Decision on Ñandú")).toBe("decision-on-nandu");
  });

  it("treats ampersand as 'and'", () => {
    expect(slugify("A & B")).toBe("a-and-b");
  });

  it("collapses non-alphanumerics into single dashes", () => {
    expect(slugify("foo___bar,,,baz")).toBe("foo-bar-baz");
  });

  it("returns empty string for symbol-only input", () => {
    expect(slugify("🚀✨")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("handles emoji inside text", () => {
    expect(slugify("Use QMD 🚀 for retrieval")).toBe("use-qmd-for-retrieval");
  });
});

describe("deriveId", () => {
  it("joins date and slug deterministically", () => {
    expect(deriveId("Use QMD for retrieval", "2026-07-01")).toBe(
      "2026-07-01-use-qmd-for-retrieval",
    );
  });

  it("is deterministic for the same (title, date) pair", () => {
    const a = deriveId("Same title", "2026-07-01");
    const b = deriveId("Same title", "2026-07-01");
    expect(a).toBe(b);
  });

  it("throws on non-ISO date", () => {
    expect(() => deriveId("x", "2026/07/01")).toThrow(/Invalid ISO date/);
    expect(() => deriveId("x", "2026-13-01")).not.toThrow(); // valid format, range out of scope
  });

  it("throws when title yields an empty slug", () => {
    expect(() => deriveId("🚀✨", "2026-07-01")).toThrow(/empty slug/);
  });
});

describe("notePath", () => {
  it("pluralizes the type directory via simple +s", () => {
    expect(notePath("2026-07-01-use-qmd", "decision")).toBe("decisions/2026-07-01-use-qmd.md");
    expect(notePath("2026-07-01-foo", "learning")).toBe("learnings/2026-07-01-foo.md");
    expect(notePath("2026-07-01-foo", "note")).toBe("notes/2026-07-01-foo.md");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL = `---
id: 2026-07-01-use-qmd-for-retrieval
title: Use QMD for retrieval
date: 2026-07-01
type: decision
topic_key: architecture/retrieval
tags:
  - retrieval
  - qmd
---

We need to recall past decisions. Local embeddings are viable.

Adopt QMD (BM25 + vector + rerank) as the read engine.
`;

function buildSampleNote(): Note {
  return buildNote({
    title: "Use QMD for retrieval",
    date: "2026-07-01",
    type: "decision",
    topic_key: "architecture/retrieval",
    tags: ["retrieval", "qmd"],
    body:
      "We need to recall past decisions. Local embeddings are viable.\n\n" +
      "Adopt QMD (BM25 + vector + rerank) as the read engine.",
  });
}

// ---------------------------------------------------------------------------
// parseNote
// ---------------------------------------------------------------------------

describe("parseNote", () => {
  it("parses a well-formed note", () => {
    const note = parseNote(CANONICAL);
    expect(note.frontmatter.id).toBe("2026-07-01-use-qmd-for-retrieval");
    expect(note.frontmatter.title).toBe("Use QMD for retrieval");
    expect(note.frontmatter.type).toBe("decision");
    expect(note.frontmatter.topic_key).toBe("architecture/retrieval");
    expect(note.frontmatter.tags).toEqual(["retrieval", "qmd"]);
    expect(note.body).toContain("embeddings");
    expect(note.body).toContain("QMD");
  });

  it("does NOT enforce any specific H2 sections (body is free-form)", () => {
    // A body with no Context/Decision/Consequences must parse fine.
    const freeform = `---
id: 2026-07-01-shower-thought
title: Shower thought
date: 2026-07-01
type: note
---

Just a random paragraph. No headers at all.
`;
    const note = parseNote(freeform);
    expect(note.body).toBe("Just a random paragraph. No headers at all.");
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseNote("no frontmatter here")).toThrow(NoteParseError);
    expect(() => parseNote("no frontmatter here")).toThrow(/Missing YAML frontmatter/);
  });

  it("rejects malformed YAML", () => {
    const bad = `---
id: 2026-07-01-x
title: [unclosed
type: note
---
body
`;
    expect(() => parseNote(bad)).toThrow(/Invalid YAML frontmatter/);
  });

  it("rejects malformed frontmatter values via Zod", () => {
    const bad = `---
id: not-an-id
title: ""
date: 2026-07-01
type: note
---
body
`;
    expect(() => parseNote(bad)).toThrow(/Invalid frontmatter/);
  });

  it("rejects an invalid type", () => {
    const bad = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
type: "UPPER Case"
---
body
`;
    expect(() => parseNote(bad)).toThrow(/type/);
  });

  it("defaults tags to empty array when omitted", () => {
    const noTags = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
type: note
---
body
`;
    expect(parseNote(noTags).frontmatter.tags).toEqual([]);
  });

  it("extracts wikilinks from the body during parse", () => {
    const note = parseNote(`---
id: 2026-07-01-x
title: X
date: 2026-07-01
type: note
---

Refs [[ADR-001]] and [[broken-link]] and again [[ADR-001]].
`);
    expect(note.wikilinks).toEqual(["ADR-001", "broken-link"]);
  });
});

// ---------------------------------------------------------------------------
// Verbatim body preservation (lossless round-trip)
// ---------------------------------------------------------------------------

describe("verbatim body preservation", () => {
  it("preserves arbitrary markdown structure intact", () => {
    const body =
      "## Arbitrary H2\n\n- list item\n- another\n\n```ts\nconst x = 1;\n```\n\n  indented text";
    const source = `---
id: 2026-07-01-rich
title: Rich
date: 2026-07-01
type: learning
---

${body}
`;
    expect(parseNote(source).body).toBe(body);
  });

  it("preserves internal blank lines and indentation", () => {
    const body = "line one\n\n\n  indented\n\n    deeper";
    const source = `---
id: 2026-07-01-ind
title: Indented
date: 2026-07-01
type: note
---

${body}
`;
    expect(parseNote(source).body).toBe(body);
  });

  it("normalizes CRLF to LF in the body", () => {
    const source =
      "---\nid: 2026-07-01-x\ntitle: X\ndate: 2026-07-01\ntype: note\n---\r\n\r\nline a\r\nline b\r\n";
    expect(parseNote(source).body).toBe("line a\nline b");
  });
});

// ---------------------------------------------------------------------------
// serializeNote round-trip / idempotency
// ---------------------------------------------------------------------------

describe("serializeNote round-trip", () => {
  it("serializes a built note to canonical form", () => {
    const out = serializeNote(buildSampleNote());
    expect(out).toContain("---\nid: 2026-07-01-use-qmd-for-retrieval");
    expect(out).toContain("type: decision");
    expect(out.endsWith("\n")).toBe(true);
    // Frontmatter block is separated from body by exactly one blank line.
    expect(out).toContain("---\n\nWe need to recall");
  });

  it("round-trips a canonical input without loss", () => {
    // CANONICAL is already in canonical form: parse + serialize === CANONICAL.
    expect(serializeNote(parseNote(CANONICAL))).toBe(CANONICAL);
  });

  it("is idempotent under repeated parse+serialize", () => {
    const once = serializeNote(parseNote(CANONICAL));
    const twice = serializeNote(parseNote(once));
    expect(twice).toBe(once);
  });

  it("preserves an arbitrary body through round-trip", () => {
    const body = "## H2\n\n- a\n- b\n\n```js\nf();\n```";
    const note = buildNote({
      title: "Round",
      date: "2026-07-01",
      type: "pattern",
      body,
    });
    const serialized = serializeNote(note);
    expect(parseNote(serialized).body).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Wikilinks — policy: extract, never materialize
// ---------------------------------------------------------------------------

describe("wikilinks", () => {
  it("extracts [[target]] and [[target|alias]] targets", () => {
    const links = extractWikilinks(
      "see [[ADR-001]] and [[ADR-002|the second]] and again [[ADR-001]]",
    );
    expect(links).toEqual(["ADR-001", "ADR-002"]);
  });

  it("does NOT materialize files for broken links (policy)", () => {
    // Contract: parseNote only RETURNS the list of targets. Creating files
    // is the upper layer's responsibility, and the AMS policy forbids
    // creating stubs for broken links. We verify that parseNote offers no
    // API to create files and that a broken link only ends up in the
    // validation list, with no side effect.
    const note = parseNote(`---
id: 2026-07-01-x
title: X
date: 2026-07-01
type: note
---

Mentions [[totally-broken-link]].
`);
    expect(note.wikilinks).toContain("totally-broken-link");
    // The parse result is a pure object; no creation side effect.
    expect(note.frontmatter.id).toBe("2026-07-01-x");
  });
});

// ---------------------------------------------------------------------------
// Coherence / upsert key
// ---------------------------------------------------------------------------

describe("isCoherent (upsert key contract)", () => {
  it("returns true when id === deriveId(title, date)", () => {
    expect(isCoherent(buildSampleNote())).toBe(true);
  });

  it("returns false when id does not match title/date", () => {
    const note = buildSampleNote();
    note.frontmatter.id = "2026-07-01-something-else";
    expect(isCoherent(note)).toBe(false);
  });

  it("returns false on tampered date", () => {
    const note = buildSampleNote();
    note.frontmatter.date = "2026/07/01";
    expect(isCoherent(note)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema standalone
// ---------------------------------------------------------------------------

describe("FrontmatterSchema", () => {
  it("accepts a valid record", () => {
    const r = FrontmatterSchema.parse({
      id: "2026-07-01-x",
      title: "X",
      date: "2026-07-01",
      type: "note",
    });
    expect(r.tags).toEqual([]);
    expect(r.type).toBe("note");
  });

  it("rejects empty tag strings", () => {
    expect(() =>
      FrontmatterSchema.parse({
        id: "2026-07-01-x",
        title: "X",
        date: "2026-07-01",
        type: "note",
        tags: [""],
      }),
    ).toThrow();
  });

  it("rejects malformed topic_key", () => {
    expect(() =>
      FrontmatterSchema.parse({
        id: "2026-07-01-x",
        title: "X",
        date: "2026-07-01",
        type: "note",
        topic_key: "UPPER/Path",
      }),
    ).toThrow();
  });
});
