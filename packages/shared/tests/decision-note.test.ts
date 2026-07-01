import { describe, expect, it } from "vitest";
import {
  buildNote,
  type DecisionNote,
  type DecisionStatus,
  deriveId,
  extractWikilinks,
  FrontmatterSchema,
  isCoherent,
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
    expect(slugify("Decisión sobre Ñandú")).toBe("decision-sobre-nandu");
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
  it("places notes under decisions/<id>.md", () => {
    expect(notePath("2026-07-01-use-qmd")).toBe("decisions/2026-07-01-use-qmd.md");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL = `---
id: 2026-07-01-use-qmd-for-retrieval
title: Use QMD for retrieval
date: 2026-07-01
status: accepted
topic_key: architecture/retrieval
tags:
  - retrieval
  - qmd
---

## Context

We need to recall past decisions. Local embeddings are viable.

## Decision

Adopt QMD (BM25 + vector + rerank) as the read engine.

## Consequences

Tighter coupling to node-llama-cpp, but avoids reimplementing hybrid search.
`;

function buildSampleNote(): DecisionNote {
  return buildNote({
    title: "Use QMD for retrieval",
    date: "2026-07-01",
    status: "accepted",
    topic_key: "architecture/retrieval",
    tags: ["retrieval", "qmd"],
    context: "We need to recall past decisions. Local embeddings are viable.",
    decision: "Adopt QMD (BM25 + vector + rerank) as the read engine.",
    consequences: "Tighter coupling to node-llama-cpp, but avoids reimplementing hybrid search.",
  });
}

// ---------------------------------------------------------------------------
// parseNote
// ---------------------------------------------------------------------------

describe("parseNote", () => {
  it("parses a well-formed canonical note", () => {
    const note = parseNote(CANONICAL);
    expect(note.frontmatter.id).toBe("2026-07-01-use-qmd-for-retrieval");
    expect(note.frontmatter.title).toBe("Use QMD for retrieval");
    expect(note.frontmatter.status).toBe("accepted");
    expect(note.frontmatter.topic_key).toBe("architecture/retrieval");
    expect(note.frontmatter.tags).toEqual(["retrieval", "qmd"]);
    expect(note.sections.Context).toContain("embeddings");
    expect(note.sections.Decision).toContain("QMD");
    expect(note.sections.Consequences).toContain("node-llama-cpp");
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseNote("## Context\n\nbody")).toThrow(NoteParseError);
    expect(() => parseNote("## Context\n\nbody")).toThrow(/Missing YAML frontmatter/);
  });

  it("rejects malformed YAML", () => {
    const bad = `---
id: 2026-07-01-use-qmd-for-retrieval
title: [unclosed
---
## Context

x
## Decision

y
## Consequences

z
`;
    expect(() => parseNote(bad)).toThrow(/Invalid YAML frontmatter/);
  });

  it("rejects malformed frontmatter values via Zod", () => {
    const bad = `---
id: not-an-id
title: ""
date: 2026-07-01
status: maybe
---
## Context

x
## Decision

y
## Consequences

z
`;
    expect(() => parseNote(bad)).toThrow(/Invalid frontmatter/);
  });

  it("rejects missing required sections", () => {
    const missing = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: accepted
---
## Context

only context
`;
    expect(() => parseNote(missing)).toThrow(/Missing required sections/);
  });

  it("rejects invalid status enum", () => {
    const bad = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: draft
---
## Context

a
## Decision

b
## Consequences

c
`;
    expect(() => parseNote(bad)).toThrow(/status/);
  });

  it("defaults tags to empty array when omitted", () => {
    const noTags = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: proposed
---
## Context

a
## Decision

b
## Consequences

c
`;
    expect(parseNote(noTags).frontmatter.tags).toEqual([]);
  });

  it("preserves non-canonical extra sections verbatim", () => {
    const withExtra = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: proposed
---
## Context

a

## Decision

b

## Consequences

c

## Alternatives

We considered X and Y.
`;
    const note = parseNote(withExtra);
    expect(note.extraSections).toHaveLength(1);
    expect(note.extraSections[0]?.heading).toBe("Alternatives");
    expect(note.extraSections[0]?.body).toContain("We considered X and Y");
  });

  it("preserves preface content before the first H2", () => {
    const withPreface = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: proposed
---
Preface line here.

## Context

a
## Decision

b
## Consequences

c
`;
    expect(parseNote(withPreface).preface).toBe("Preface line here.");
  });
});

// ---------------------------------------------------------------------------
// Round-trip / idempotency
// ---------------------------------------------------------------------------

describe("serializeNote round-trip", () => {
  it("serializes a built note to canonical form", () => {
    const out = serializeNote(buildSampleNote());
    expect(out).toContain("---\nid: 2026-07-01-use-qmd-for-retrieval");
    expect(out).toContain("## Context");
    expect(out).toContain("## Decision");
    expect(out).toContain("## Consequences");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.indexOf("## Context")).toBeLessThan(out.indexOf("## Decision"));
    expect(out.indexOf("## Decision")).toBeLessThan(out.indexOf("## Consequences"));
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

  it("normalizes non-canonical input to canonical form", () => {
    // Extra whitespace between sections and trailing spaces.
    const sloppy = `---
id: 2026-07-01-x
title: X
date: 2026-07-01
status: proposed   
---


## Context

   spaced   

## Decision

b

## Consequences

c
`;
    const normalized = serializeNote(parseNote(sloppy));
    expect(normalized).toBe(serializeNote(parseNote(normalized)));
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

  it("extracts wikilinks from parsed body for validation", () => {
    const note = buildNote({
      title: "X",
      date: "2026-07-01",
      status: "proposed",
      context: "Refers to [[ADR-001]] and [[broken-link]]",
      decision: "x",
      consequences: "y",
    });
    expect(note.wikilinks).toEqual(["ADR-001", "broken-link"]);
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
status: proposed
---
## Context

Mentions [[totally-broken-link]].

## Decision

x

## Consequences

y
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
      status: "accepted",
    });
    expect(r.tags).toEqual([]);
    expect(r.status).toBe<DecisionStatus>("accepted");
  });

  it("rejects empty tag strings", () => {
    expect(() =>
      FrontmatterSchema.parse({
        id: "2026-07-01-x",
        title: "X",
        date: "2026-07-01",
        status: "accepted",
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
        status: "accepted",
        topic_key: "UPPER/Path",
      }),
    ).toThrow();
  });
});
