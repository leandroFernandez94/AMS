import { describe, expect, it } from "vitest";
import {
  NoteExistsError,
  WriteApiClient,
  WriteApiConfigError,
  type WriteApiLogger,
  WriteApiNotFoundError,
  WriteApiUnavailableError,
  WriteApiUnexpectedPayloadError,
  WriteApiValidationError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers — injected fake fetch, no network
// ---------------------------------------------------------------------------

/** One recorded outgoing request, with headers resolved to a plain record. */
interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  headers: Record<string, string>;
}

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const impl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init, headers: headerRecord(init?.headers) });
    return handler(url, init);
  };
  return { impl, calls };
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  return Object.fromEntries(new Headers(headers));
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeLogger() {
  const entries: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: WriteApiLogger = {
    debug: (msg, fields) => entries.push({ msg, fields }),
    info: (msg, fields) => entries.push({ msg, fields }),
  };
  return { entries, logger };
}

/** Captures the rejection value of a promise so its fields can be asserted. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return new Error("expected the promise to reject");
}

const BASE_URL = "http://write-api.test";

/** A note satisfying the FrontmatterSchema inside DeleteResponseSchema. */
const validNote = {
  frontmatter: {
    id: "use-qmd",
    title: "Use QMD",
    date: "2026-10-03",
    type: "decision",
    tags: [],
  },
  body: "Use QMD for retrieval.",
};

// ---------------------------------------------------------------------------
// recordNote
// ---------------------------------------------------------------------------

describe("WriteApiClient.recordNote", () => {
  it("posts the payload verbatim and parses the upsert result", async () => {
    const input = {
      title: "Use QMD",
      type: "decision",
      body: "Use QMD for retrieval.",
      tags: ["retrieval"],
      overwrite: true,
    };
    const { impl, calls } = fakeFetch(() =>
      jsonResponse(201, { id: "use-qmd", path: "decisions/use-qmd.md", created: true }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const result = await client.recordNote(input, { requestId: "req_1" });

    expect(result).toEqual({ id: "use-qmd", path: "decisions/use-qmd.md", created: true });
    expect(calls[0]?.url).toBe(`${BASE_URL}/notes`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify(input));
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers["x-request-id"]).toBe("req_1");
  });

  it("maps a 409 note_exists to NoteExistsError carrying the existing note", async () => {
    const existing = {
      id: "use-qmd",
      path: "decisions/use-qmd.md",
      body: "---\nid: use-qmd\n---\nold body",
    };
    const { impl } = fakeFetch(() => jsonResponse(409, { error: "note_exists", existing }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(
      client.recordNote({ title: "Use QMD", type: "decision", body: "x" }),
    );

    expect(error).toBeInstanceOf(NoteExistsError);
    expect((error as NoteExistsError).existing).toEqual(existing);
    expect((error as NoteExistsError).message).toBe(
      "Note already exists: use-qmd at decisions/use-qmd.md",
    );
  });

  it("maps a 409 without note_exists to unavailable with the status", async () => {
    const { impl } = fakeFetch(() => jsonResponse(409, { error: "other" }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.recordNote({ title: "T", type: "note", body: "x" }));

    expect(error).toBeInstanceOf(WriteApiUnavailableError);
    expect((error as WriteApiUnavailableError).status).toBe(409);
    expect((error as WriteApiUnavailableError).message).toBe("Write API unavailable: 409");
  });

  it("maps a 400 to a validation error carrying the issues", async () => {
    const issues = [
      { field: "title", message: "title must be a non-empty string" },
      { field: "date", message: "date must be YYYY-MM-DD" },
    ];
    const { impl } = fakeFetch(() => jsonResponse(400, { error: "validation_error", issues }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.recordNote({ title: "", type: "note", body: "x" }));

    expect(error).toBeInstanceOf(WriteApiValidationError);
    expect((error as WriteApiValidationError).issues).toEqual(issues);
    // Byte-identical legacy rendering: message-only items joined by "; ".
    expect((error as WriteApiValidationError).message).toBe(
      "Validation error: title must be a non-empty string; date must be YYYY-MM-DD",
    );
  });

  it("falls back to the error code when a 400 has no issues array", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(400, { error: "invalid_body", message: "Request body must be valid JSON" }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.recordNote({ title: "T", type: "note", body: "x" }));

    expect(error).toBeInstanceOf(WriteApiValidationError);
    expect((error as WriteApiValidationError).issues).toEqual([]);
    expect((error as WriteApiValidationError).message).toBe("Validation error: invalid_body");
  });
});

// ---------------------------------------------------------------------------
// deleteNote
// ---------------------------------------------------------------------------

describe("WriteApiClient.deleteNote", () => {
  it("encodes each path segment separately and parses the delete result", async () => {
    const file = "decisions/this is a?note.md";
    const { impl, calls } = fakeFetch(() =>
      jsonResponse(200, { deleted: true, path: file, note: validNote }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const result = await client.deleteNote(file, { requestId: "req_2" });

    expect(result.deleted).toBe(true);
    expect(result.note?.frontmatter.id).toBe("use-qmd");
    expect(calls[0]?.url).toBe(`${BASE_URL}/notes/decisions/this%20is%20a%3Fnote.md`);
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(calls[0]?.headers["x-request-id"]).toBe("req_2");
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });

  it("parses a null note alongside the raw recovery content", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(200, { deleted: true, path: "notes/hand.md", note: null, raw: "raw bytes" }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const result = await client.deleteNote("notes/hand.md");

    expect(result.note).toBeNull();
    expect(result.raw).toBe("raw bytes");
  });

  it("maps a 404 to WriteApiNotFoundError with the API message", async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse(404, { error: "not_found", message: "No note at notes/gone.md" }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.deleteNote("notes/gone.md"));

    expect(error).toBeInstanceOf(WriteApiNotFoundError);
    expect((error as WriteApiNotFoundError).message).toBe("No note at notes/gone.md");
  });
});

// ---------------------------------------------------------------------------
// listTags / listTypes
// ---------------------------------------------------------------------------

describe("WriteApiClient.listTags", () => {
  it("sends no headers at all and parses the tag vocabulary", async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse(200, { tags: [{ name: "retrieval", count: 3 }] }),
    );
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const result = await client.listTags();

    expect(result.tags).toEqual([{ name: "retrieval", count: 3 }]);
    expect(calls[0]?.url).toBe(`${BASE_URL}/tags`);
    // The list_tags tool never sent a request id — preserved verbatim.
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.headers).toEqual({});
  });
});

describe("WriteApiClient.listTypes", () => {
  it("sends the request id header and parses the type list", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, { types: ["decision", "note"] }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const result = await client.listTypes({ requestId: "req_3" });

    expect(result.types).toEqual(["decision", "note"]);
    expect(calls[0]?.url).toBe(`${BASE_URL}/types`);
    expect(calls[0]?.headers["x-request-id"]).toBe("req_3");
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });

  it("maps a 5xx to unavailable with the status and body", async () => {
    const body = { error: "write_conflict", message: "Note is locked by another writer" };
    const { impl } = fakeFetch(() => jsonResponse(503, body));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.listTypes({ requestId: "req_4" }));

    expect(error).toBeInstanceOf(WriteApiUnavailableError);
    expect((error as WriteApiUnavailableError).status).toBe(503);
    expect((error as WriteApiUnavailableError).body).toEqual(body);
    expect((error as WriteApiUnavailableError).message).toBe("Write API unavailable: 503");
  });
});

// ---------------------------------------------------------------------------
// Transport failures, timeouts and payload validation
// ---------------------------------------------------------------------------

describe("WriteApiClient transport failures", () => {
  it("wraps a fetch rejection as unavailable with the cause", async () => {
    const { impl } = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.listTypes());

    expect(error).toBeInstanceOf(WriteApiUnavailableError);
    expect((error as WriteApiUnavailableError).status).toBeUndefined();
    expect((error as WriteApiUnavailableError).cause).toBeInstanceOf(Error);
    expect((error as WriteApiUnavailableError).message).toBe("Write API unavailable");
  });

  it("wraps a timed-out request as unavailable", async () => {
    const impl: typeof globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
      });
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl, timeoutMs: 10 });

    await expect(client.listTags()).rejects.toBeInstanceOf(WriteApiUnavailableError);
  });

  it("passes a timeout abort signal to every request", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, { types: [] }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    await client.listTypes();

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports an unparseable success body as an unexpected payload", async () => {
    const { impl } = fakeFetch(() => new Response("not json", { status: 200 }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.listTags());

    expect(error).toBeInstanceOf(WriteApiUnexpectedPayloadError);
    expect((error as WriteApiUnexpectedPayloadError).message).toBe(
      "Write API returned an unexpected payload",
    );
  });

  it("reports a wrong-shape success body as an unexpected payload", async () => {
    const { impl } = fakeFetch(() => jsonResponse(200, { tags: "not-an-array" }));
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl });

    const error = await captureError(client.listTags());

    expect(error).toBeInstanceOf(WriteApiUnexpectedPayloadError);
    expect((error as WriteApiUnexpectedPayloadError).payload).toEqual({ tags: "not-an-array" });
  });
});

// ---------------------------------------------------------------------------
// Configuration guard and logging
// ---------------------------------------------------------------------------

describe("WriteApiClient configuration", () => {
  it("throws a config error for an empty or blank URL without fetching", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, {}));
    const empty = new WriteApiClient({ url: "", fetch: impl });
    const blank = new WriteApiClient({ url: "   ", fetch: impl });

    const error = await captureError(empty.recordNote({ title: "T", type: "note", body: "x" }));
    await captureError(blank.listTags());

    expect(error).toBeInstanceOf(WriteApiConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe("WriteApiClient logging", () => {
  it("logs one structured entry per request with the correlation id", async () => {
    const { impl } = fakeFetch((url) =>
      url.endsWith("/tags")
        ? jsonResponse(200, { tags: [] })
        : jsonResponse(201, { id: "use-qmd", path: "decisions/use-qmd.md", created: true }),
    );
    const { entries, logger } = fakeLogger();
    const client = new WriteApiClient({ url: BASE_URL, fetch: impl, logger });

    await client.recordNote(
      { title: "Use QMD", type: "decision", body: "x" },
      {
        requestId: "req_5",
      },
    );
    await client.listTags();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.msg).toBe("write-api:request:done");
    expect(entries[0]?.fields).toMatchObject({
      method: "POST",
      path: "/notes",
      status: 201,
      requestId: "req_5",
    });
    // listTags carries no request id, so its entry must not invent one.
    expect(entries[1]?.fields).toMatchObject({ method: "GET", path: "/tags", status: 200 });
    expect(entries[1]?.fields?.requestId).toBeUndefined();
  });
});
