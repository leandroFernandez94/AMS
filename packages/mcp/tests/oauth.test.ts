import {
  createLogger,
  type TypesResponse,
  type WriteApiClient,
  type WriteApiRequestOptions,
} from "@ams/shared";
import { type ServerType, serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  getConfig,
  MCP_OAUTH_AUDIENCE_ENV,
  MCP_OAUTH_ISSUER_ENV,
  MCP_PUBLIC_URL_ENV,
  MCP_TOKEN_ENV,
  type McpOAuthConfig,
} from "../src/config.js";
import { assertHttpConfig, createHttpApp } from "../src/http-app.js";

const TOKEN = "test-token";
const AUDIENCE = "https://ams.example.com/api";
const PUBLIC_URL = "https://ams.example.com";
/** `kid` stamped on trusted tokens and on the JWKS-served key. */
const TRUSTED_KID = "test-key";

/** Discards log lines — keeps the test output clean. */
const silentLogger = createLogger(() => undefined, "error");

/** A write-tool call as observed at the `WriteApiClient` seam. */
type WriteApiCall = { method: "listTypes"; requestId?: string };

/**
 * Creates a structural `WriteApiClient` fake for `list_types` that records
 * every call and answers from `handler` (same pattern as http-server.test.ts).
 */
function fakeWriteApiClient(handler: (call: WriteApiCall) => unknown): {
  client: WriteApiClient;
  calls: WriteApiCall[];
} {
  const calls: WriteApiCall[] = [];
  const fake = {
    listTypes: async (opts?: WriteApiRequestOptions) => {
      const call: WriteApiCall = { method: "listTypes", requestId: opts?.requestId };
      calls.push(call);
      return handler(call) as TypesResponse;
    },
  };
  return { client: fake as unknown as WriteApiClient, calls };
}

/** Serves a Hono app on an ephemeral port; resolves once it is listening. */
function serveEphemeral(app: Hono): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
    server.on("error", reject);
  });
}

/** Best-effort close that tolerates an already-closed server. */
function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Minimal Auth0-style JWKS endpoint serving exactly one RSA public key. */
function jwksStubApp(jwk: Record<string, unknown>): Hono {
  return new Hono().get("/.well-known/jwks.json", (c) => c.json({ keys: [jwk] }));
}

interface JwtOverrides {
  issuer?: string;
  audience?: string;
  /** NumericDate (seconds); defaults to two minutes from now. */
  expiresAt?: number;
  /** When true, the JWT carries no exp claim at all (must be rejected). */
  omitExpiration?: boolean;
  key?: CryptoKey;
}

/** Signs a compact RS256 JWT with the trusted kid unless overridden. */
async function signJwt(overrides: JwtOverrides = {}): Promise<string> {
  const { privateKey } = trustedKeys ?? (await generateKeyPair("RS256"));
  let builder = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: TRUSTED_KID })
    .setIssuer(overrides.issuer ?? issuerUrl)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt();
  if (!overrides.omitExpiration) {
    builder = builder.setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 120);
  }
  return builder.sign(overrides.key ?? privateKey);
}

/** Base64url-encodes a JSON value (for hand-crafting alg:none tokens). */
function b64urlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Shared fixture state: populated in beforeAll, torn down in afterAll.
let trustedKeys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
let issuerUrl = "";
let oauthEntry: ServerType | undefined;
let plainEntry: ServerType | undefined;
let jwksStub: ServerType | undefined;
let writeCalls: WriteApiCall[] = [];

/** Runs an SDK client round-trip against `base/mcp` with the given bearer. */
async function withMcpClient(
  base: string,
  bearer: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "oauth-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

/** Asserts POST /mcp rejects `bearer` with 401 + invalid_token + RFC 9728 hint. */
async function expectInvalidToken(base: string, bearer: string | null): Promise<void> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
    cache: "no-store",
  });
  expect(response.status).toBe(401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(
    `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
  );
}

beforeAll(async () => {
  // The "trusted" issuer: a local JWKS stub standing in for Auth0.
  trustedKeys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(trustedKeys.publicKey);
  const stub = await serveEphemeral(jwksStubApp({ ...publicJwk, kid: TRUSTED_KID, alg: "RS256" }));
  jwksStub = stub.server;
  issuerUrl = stub.url;

  const oauthConfig: McpOAuthConfig = {
    issuer: issuerUrl,
    audience: AUDIENCE,
    publicUrl: PUBLIC_URL,
  };

  const { client: writeApiClient, calls } = fakeWriteApiClient(() => ({
    types: ["decision", "learning", "pattern"],
  }));
  writeCalls = calls;

  const oauthApp = createHttpApp({
    token: TOKEN,
    oauth: oauthConfig,
    apiUrl: "",
    qmdUrl: "",
    serverDeps: { writeApiClient, logger: silentLogger },
  });
  const servedOauth = await serveEphemeral(oauthApp);
  oauthEntry = servedOauth.server;

  // Phase-1 app (no OAuth) built from the same fake so both are comparable.
  const plainApp = createHttpApp({
    token: TOKEN,
    apiUrl: "",
    qmdUrl: "",
    serverDeps: { writeApiClient, logger: silentLogger },
  });
  const servedPlain = await serveEphemeral(plainApp);
  plainEntry = servedPlain.server;
});

afterAll(async () => {
  if (jwksStub) await closeServer(jwksStub);
  if (oauthEntry) await closeServer(oauthEntry);
  if (plainEntry) await closeServer(plainEntry);
});

// -----------------------------------------------------------------------------
// OAuth config resolution (unit)
// -----------------------------------------------------------------------------

describe("oauth config", () => {
  it("leaves OAuth unset (null after assert) when no env vars are present", () => {
    expect(getConfig({}).oauth).toEqual({ issuer: "", audience: "", publicUrl: "" });
    expect(assertHttpConfig(getConfig({ [MCP_TOKEN_ENV]: "secret" }))).toBeNull();
  });

  it("resolves the validated triple when all three env vars are set", () => {
    const oauth = assertHttpConfig(
      getConfig({
        [MCP_TOKEN_ENV]: "secret",
        [MCP_OAUTH_ISSUER_ENV]: "https://tenant.auth0.com/",
        [MCP_OAUTH_AUDIENCE_ENV]: "https://ams.example.com/api",
        [MCP_PUBLIC_URL_ENV]: "https://ams.example.com",
      }),
    );
    // Issuer kept verbatim (trailing slash included): jose compares `iss`
    // literally, so normalizing it would break verification.
    expect(oauth).toEqual({
      issuer: "https://tenant.auth0.com/",
      audience: "https://ams.example.com/api",
      publicUrl: "https://ams.example.com",
    });
  });

  it("throws ConfigError naming all three env vars on a partial OAuth config", () => {
    const partial = getConfig({
      [MCP_TOKEN_ENV]: "secret",
      [MCP_OAUTH_ISSUER_ENV]: "https://tenant.auth0.com/",
    });
    expect(() => assertHttpConfig(partial)).toThrow(ConfigError);
    expect(() => assertHttpConfig(partial)).toThrow(/AMS_MCP_OAUTH_ISSUER/);
    expect(() => assertHttpConfig(partial)).toThrow(/AMS_MCP_OAUTH_AUDIENCE/);
    expect(() => assertHttpConfig(partial)).toThrow(/AMS_MCP_PUBLIC_URL/);
  });

  it("rejects a non-https issuer and a public URL with a trailing slash", () => {
    const httpIssuer = getConfig({
      [MCP_TOKEN_ENV]: "secret",
      [MCP_OAUTH_ISSUER_ENV]: "http://tenant.auth0.com/",
      [MCP_OAUTH_AUDIENCE_ENV]: "aud",
      [MCP_PUBLIC_URL_ENV]: "https://ams.example.com",
    });
    expect(() => assertHttpConfig(httpIssuer)).toThrow(/AMS_MCP_OAUTH_ISSUER/);

    const slashedUrl = getConfig({
      [MCP_TOKEN_ENV]: "secret",
      [MCP_OAUTH_ISSUER_ENV]: "https://tenant.auth0.com/",
      [MCP_OAUTH_AUDIENCE_ENV]: "aud",
      [MCP_PUBLIC_URL_ENV]: "https://ams.example.com/",
    });
    expect(() => assertHttpConfig(slashedUrl)).toThrow(/trailing slash/);
  });
});

// -----------------------------------------------------------------------------
// Dual-credential auth on /mcp (real HTTP end to end)
// -----------------------------------------------------------------------------

describe("oauth resource server", () => {
  it("accepts a valid JWT for an initialize + listTools round-trip", async () => {
    const jwt = await signJwt();
    await withMcpClient(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("record_note");
    });
  });

  it("still accepts the static token while OAuth is configured", async () => {
    await withMcpClient(`http://127.0.0.1:${getPort(oauthEntry)}`, TOKEN, async (client) => {
      const result = await client.callTool({ name: "list_types", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(writeCalls).toEqual([{ method: "listTypes", requestId: expect.any(String) }]);
    });
  });

  it("still accepts the static token when OAuth is not configured", async () => {
    await withMcpClient(`http://127.0.0.1:${getPort(plainEntry)}`, TOKEN, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
    });
  });

  it("rejects an expired JWT (401 invalid_token with resource_metadata)", async () => {
    const jwt = await signJwt({ expiresAt: Math.floor(Date.now() / 1000) - 120 });
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects a JWT with the wrong audience (401)", async () => {
    const jwt = await signJwt({ audience: "https://other-api.example.com" });
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects a JWT with the wrong issuer (401)", async () => {
    const jwt = await signJwt({ issuer: "https://evil.example.com/" });
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects a JWT signed by an untrusted key claiming a trusted kid (401)", async () => {
    const rogue = await generateKeyPair("RS256");
    // kid spoofing: the header points at the trusted JWKS key, so jose
    // resolves it and the signature check itself must fail.
    const jwt = await signJwt({ key: rogue.privateKey });
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects a JWT without an exp claim (401)", async () => {
    // jose only validates exp when present; requiredClaims must close that
    // hole (a never-expiring token must never verify on a public endpoint).
    const jwt = await signJwt({ omitExpiration: true });
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects an unsigned alg:none token (401)", async () => {
    const payload = {
      iss: issuerUrl,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 120,
    };
    const jwt = `${b64urlJson({ alg: "none", kid: TRUSTED_KID })}.${b64urlJson(payload)}.`;
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("rejects an HS256 token keyed with the public JWK material (401)", async () => {
    // Attack replication: the attacker HMACs with a secret derived from the
    // public key. The RS256 pin plus the JWKS key class must both reject it.
    const keys = trustedKeys ?? (await generateKeyPair("RS256"));
    const publicJwk = await exportJWK(keys.publicKey);
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const jwt = await new SignJWT({ iss: issuerUrl, aud: AUDIENCE })
      .setProtectedHeader({ alg: "HS256", kid: TRUSTED_KID })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(hmacKey);
    await expectInvalidToken(`http://127.0.0.1:${getPort(oauthEntry)}`, jwt);
  });

  it("answers a charset-invalid token with 400 + resource_metadata hint", async () => {
    // Hono rejects the charset before any verification; the RFC 9728 hint
    // must still reach the client on this branch.
    const response = await fetch(`http://127.0.0.1:${getPort(oauthEntry)}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer bad:token" },
      cache: "no-store",
    });
    expect(response.status).toBe(400);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_request"');
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("rejects a request without an Authorization header (401 with resource_metadata)", async () => {
    const response = await fetch(`http://127.0.0.1:${getPort(oauthEntry)}/mcp`, {
      method: "POST",
      cache: "no-store",
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('realm=""');
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

// -----------------------------------------------------------------------------
// RFC 9728 protected-resource metadata
// -----------------------------------------------------------------------------

describe("protected-resource metadata", () => {
  it("serves the discovery document when OAuth is configured", async () => {
    const response = await fetch(
      `http://127.0.0.1:${getPort(oauthEntry)}${"/.well-known/oauth-protected-resource/mcp"}`,
      { cache: "no-store" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: `${PUBLIC_URL}/mcp`,
      authorization_servers: [issuerUrl],
      scopes_supported: null,
    });
  });

  it("does not mount the route when OAuth is not configured (404)", async () => {
    const response = await fetch(
      `http://127.0.0.1:${getPort(plainEntry)}${"/.well-known/oauth-protected-resource/mcp"}`,
      { cache: "no-store" },
    );
    expect(response.status).toBe(404);
  });
});

/** Extracts the listening port from a started ephemeral server. */
function getPort(server: ServerType | undefined): number {
  if (!server) throw new Error("fixture server not started");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected server address: ${String(address)}`);
  }
  return address.port;
}
