# Remote MCP deployment

Expose the AMS MCP server beyond localhost: as a token-gated service on a
private network, or as a public OAuth 2.1 resource server behind a Cloudflare
tunnel. This page is a sanitized runbook — every hostname, tenant and tunnel
identifier is a placeholder (`your-domain.example.com`, `your-tenant`,
`your-tunnel-id`); substitute your own.

The base stack (Write API + QMD daemon + MCP service) is described in
[docker.md](docker.md) — deploy that first; this page configures the `ams-mcp`
service's exposure and authentication.

## Choose an auth mode

| Mode | Reach | Credential | Use when |
|---|---|---|---|
| [Token](#token-mode-private-network) | Private network only | Static bearer (`AMS_MCP_TOKEN`) | Your own agents, hosts you control |
| [OAuth 2.1](#oauth-21-mode-public-exposure) | Public internet | Auth0-issued RS256 JWT | Vendor-cloud clients (Claude app, ChatGPT connectors) |

The stdio transport has no authentication at all — it stays reserved for
agents running on the same host as the upstreams (see the security note in the
[README](../../README.md)).

## Token mode (private network)

The MCP HTTP service is stateless Streamable HTTP: every `POST /mcp` is an
independent round-trip, so the service is trivially restartable and you can
run several replicas against one `ams` backend.

### Quick path

1. Generate a token (charset matters — see below):

   ```bash
   openssl rand -base64 32
   ```

2. Configure the `ams-mcp` service (see [docker.md](docker.md) for the full
   compose file):

   ```yaml
   environment:
     AMS_MCP_TOKEN: "${AMS_MCP_TOKEN:?set in .env}"  # openssl rand -base64 32
     AMS_MCP_HOST: "0.0.0.0"       # bind-all inside the container
     AMS_API_URL: "http://ams:3000"
     AMS_QMD_URL: "http://ams:8181"
   ports:
     - "<private-ip>:3111:3111"     # publish on the private interface ONLY
   ```

3. Verify:

   ```bash
   curl -s http://<private-ip>:3111/health
   # {"status":"ok","upstreams":{"api":"up","qmd":"up"}}

   curl -i -X POST http://<private-ip>:3111/mcp
   # HTTP/1.1 401 Unauthorized + WWW-Authenticate: Bearer realm=""
   ```

4. Point each client at `http://<private-ip>:3111/mcp` with an
   `Authorization: Bearer <token>` header (OpenCode: `"type": "remote"` with
   `url` + custom `headers`; Claude Code: `claude mcp add --transport http`).

### Behavior reference

| Method & path | Auth | Behavior |
|---|---|---|
| `POST /mcp` | Bearer token | MCP endpoint. Stateless, JSON responses, no sessions. |
| Other methods on `/mcp` | Bearer token | `405` with `Allow: POST` (a missing/bad token still yields `401` — auth runs first). |
| `GET /health` | None | Upstream probe: `200` when both upstreams are up, `503` otherwise. Reports reachability only, never note content. |

Auth failures: missing header → `401` with `WWW-Authenticate: Bearer realm=""`;
valid charset, wrong value → `401 invalid_token` (timing-safe compare);
malformed charset → `400 invalid_request`.

> **Token charset.** The token is validated against
> `[A-Za-z0-9._~+/-]+=*` — anything else (embedded `=`, `:`, spaces) gets a
> `400` on every request. `openssl rand -base64 32` output qualifies.

Operational notes: logs go to stderr only; `SIGTERM`/`SIGINT` shut down
gracefully (`docker stop` is clean); missing `AMS_MCP_TOKEN` fails fast at
startup — the entrypoint refuses to serve unauthenticated; upstreams down
never crash the process — tools degrade per call and `/health` reports
`down`.

> **Keep it private.** The static token is defense in depth, not the boundary
> — the private network is. Do not publish this port on a public interface or
> through a public tunnel; that is what OAuth mode is for.

## OAuth 2.1 mode (public exposure)

With the OAuth triple set, `POST /mcp` accepts Auth0-issued RS256 JWTs **next
to** the static token (dual credentials — token checked first, timing-safe,
no network I/O; JWT verification only runs when it does not match). The
service also serves RFC 9728 protected-resource metadata so connector clients
discover the authorization server on their own.

### Service configuration

```yaml
environment:
  AMS_MCP_TOKEN: "${AMS_MCP_TOKEN:?set in .env}"     # still required (token path)
  AMS_MCP_OAUTH_ISSUER: "https://your-tenant.auth0.com/"        # verbatim, as iss appears
  AMS_MCP_OAUTH_AUDIENCE: "https://your-domain.example.com/mcp" # Auth0 API identifier
  AMS_MCP_PUBLIC_URL: "https://your-domain.example.com"         # no trailing slash
  AMS_MCP_RATE_LIMIT: "120"                                     # 0 disables the limiter
```

| Variable | Validation | Purpose |
|---|---|---|
| `AMS_MCP_OAUTH_ISSUER` | `https` URL, no query/fragment, trailing slash **allowed** | Auth0 issuer URL, kept **verbatim**: the JWT `iss` claim is compared literally (Auth0 issuers conventionally include the trailing slash). |
| `AMS_MCP_OAUTH_AUDIENCE` | Any non-empty string (not required to be a URL) | Matched literally against the JWT `aud` claim. Set it to the Auth0 API **identifier** (see below). |
| `AMS_MCP_PUBLIC_URL` | `https` URL, no query/fragment, **no trailing slash** | Public base URL. Becomes the RFC 9728 `resource` value (`<publicUrl>/mcp`) and the base of the `resource_metadata` hint in 401 challenges. |
| `AMS_MCP_RATE_LIMIT` | Non-negative integer | Max requests/minute per client key on `POST /mcp`. Key = `CF-Connecting-IP`, falling back to the socket address. |

**All-or-none triple:** setting only one or two of the three OAuth variables
is a startup `ConfigError` — a half-configured resource server would silently
reject every JWT. All three unset keeps token-only behavior.

Token validation posture: RS256 pinned (rejects `alg:none` and
HMAC-confusion), literal `iss`/`aud`, required `exp`, 30s clock tolerance,
and every JWT failure collapses to a single `401 invalid_token` shape that
leaks no detail. JWKS is fetched from the issuer and cached for 10 minutes
(unknown `kid` triggers a refresh), so Auth0 signing-key rotation needs no
restart.

### Auth0 setup

Once per Auth0 tenant. Substitute `your-tenant` and
`your-domain.example.com` throughout.

1. **Create the API** — Dashboard > Applications > APIs > **+ Create API**:

   - **Name**: `AMS MCP` (display only).
   - **Identifier**: `https://your-domain.example.com/mcp` — exactly the
     public MCP server URL. It never needs to be publicly reachable, but it
     must equal the RFC 8707 `resource` parameter the connectors send, which
     is the RFC 9728 `resource` value AMS publishes. New tenants map
     `resource` to the audience, and an API registered with a free-form
     identifier (e.g. `https://ams-mcp`) fails the connector flow with
     `Service not found: <server URL>` in the Auth0 logs. The identifier
     cannot be changed afterwards; `AMS_MCP_OAUTH_AUDIENCE` must be set to
     the same string.
   - **Signing algorithm**: `RS256` (AMS pins RS256).
   - **Authorize the connector applications**: a newly created API does NOT
     grant access to existing applications. Open the API > **Applications**
     (Application Access) and enable every connector application — without
     this toggle the token exchange is rejected even with correct credentials
     and callbacks.
   - **Allow Offline Access**: enable so applications can request refresh
     tokens; consider lowering **Maximum Access Token Lifetime** (default
     86400s) for a vault-write API.

2. **Enable the MCP-relevant tenant toggles** — Settings > Advanced:

   - **Resource Parameter Compatibility Profile**: makes Auth0 accept the
     `resource` parameter on `/authorize` and stamp it into the token's
     audience. MCP connector clients send it (RFC 8707), so this toggle
     routes their requests to the AMS API.
   - **Include Issuer in Authorization Responses**: returns `iss` on every
     authorization response (RFC 9207 mix-up protection); some vendors use it
     to qualify the authorization server.

3. **Create one Application per connector** — Applications > **Create
   Application** > **Create it manually** > **Regular Web Applications** (the
   connector runs server-side on the vendor cloud and can hold a client
   secret). Suggested names: `AMS MCP — Claude`, `AMS MCP — ChatGPT`. Manual
   registration (not Dynamic Client Registration) is the documented path —
   an open `/register` endpoint invites abuse.

4. **Allowed Callback URLs** — set per application, exactly these values
   (copy what the connector's management page shows when in doubt):

   | Application | Callback URL(s) |
   |---|---|
   | `AMS MCP — Claude` | `https://claude.ai/api/mcp/auth_callback` |
   | `AMS MCP — Claude` (if you also connect Claude Code) | `http://localhost/callback` and `http://127.0.0.1/callback`, matched port-agnostically |
   | `AMS MCP — ChatGPT` | `https://chatgpt.com/connector_platform_oauth_redirect` and/or the callback-ID form `https://chatgpt.com/connector/oauth/{callback_id}` shown on the connector's management page |
   | Testing (optional) | `http://localhost:6274/oauth/callback` (MCP Inspector) |

5. **PKCE**: connectors send an S256 `code_challenge` on every authorization
   request. This rides Auth0's authorization-code flow — no per-application
   switch to configure.

No authorization/token URL fields need to be pasted anywhere on the connector
side: the 401 `WWW-Authenticate` challenge carries the RFC 9728
`resource_metadata` URL, AMS serves the protected-resource document, and the
client reads the authorize/token endpoints from the Auth0 discovery metadata
(`/.well-known/oauth-authorization-server`, served by Auth0 at the tenant
root with no extra configuration).

### Connector setup

- **Claude app (custom connector)**: Customize > Connectors > Add > Add
  custom connector; enter the MCP server URL
  `https://your-domain.example.com/mcp`; under Authentication choose **Sign
  in now**, then **Use your own OAuth client** and enter the Client ID and
  Client Secret of the `AMS MCP — Claude` application.
- **ChatGPT (developer connector)**: create a connector with the MCP server
  URL above; configure OAuth with a predefined client (the `AMS MCP —
  ChatGPT` credentials); copy the redirect URI the management page displays
  into that application's Allowed Callback URLs.

Both connectors then run the authorization-code + PKCE flow and refresh
tokens on their own. Create a user in the tenant's database connection (or
enable a social connection) so the login screen has someone to authenticate.

## Cloudflare tunnel exposure

Public HTTPS comes from a `cloudflared` tunnel fronting the MCP service. The
origin service URL is `http://ams-mcp:3111` when cloudflared shares the AMS
compose network; otherwise point it at the published private-network address
(`http://<private-ip>:3111`).

**Remotely-managed tunnel (dashboard):**

1. Cloudflare dashboard > **Networking > Tunnels** > select your tunnel.
2. **Routes** tab > **Add route** > **Published application**.
3. Subdomain `mcp`, your domain, no path.
4. **Service URL**: `http://ams-mcp:3111`; add the route (the dashboard
   manages the hostname's DNS alongside it).

**Locally-managed tunnel (config file):**

```yaml
tunnel: your-tunnel-id
credentials-file: /etc/cloudflared/your-tunnel-id.json

ingress:
  - hostname: mcp.your-domain.example.com
    service: http://ams-mcp:3111
  - service: http_status:404   # catch-all rule — required
```

Validate with `cloudflared tunnel ingress validate`. cloudflared matches on
hostname/path but forwards the full path unmodified, so `/mcp` and
`/.well-known/...` reach the service as-is. For locally-managed tunnels,
create the DNS record yourself — a proxied CNAME:
`mcp.your-domain.example.com CNAME your-tunnel-id.cfargotunnel.com`
(`cloudflared tunnel route dns your-tunnel-id mcp.your-domain.example.com`).

> **Ingress is first-match-wins.** A wildcard rule (`*.your-domain.example.com`)
> above the specific rule shadows it and the public URL answers `404`. In
> Zero Trust > Tunnels > Public Hostname, keep the specific rule on top.

## Rate limiting

Two layers, on purpose:

1. **Cloudflare edge WAF rule** — the primary abuse control. Dashboard >
   Security > WAF > Rate limiting rules > Create rule: match
   `http.request.uri.path eq "/mcp"`, e.g. 30 requests / 10 seconds /
   mitigation timeout 10 seconds (Free-plan values), action **Block** — not
   a challenge: connector clients are non-interactive API callers that cannot
   solve browser challenges.
2. **In-app limiter** (`AMS_MCP_RATE_LIMIT`, default 120 req/min per client
   key) — bounds what a tunnel bypass can do. Counted **before** auth, so
   unauthenticated floods are throttled without any JWT/JWKS work; excess
   requests get `429` with a `Retry-After` header. `/health` and the RFC
   9728 metadata route stay unlimited.

On the public path the Cloudflare edge owns and overwrites the
`CF-Connecting-IP` header, so per-client keys are trustworthy there. A direct
hit on the private-network port can spoof that header — accepted, because the
private network is the trusted perimeter and auth still applies on every
request.

## Credential rotation

- **Static token** (`AMS_MCP_TOKEN`): generate a new one, update `.env` /
   compose, `docker compose up -d ams-mcp`, then update every
   private-network client's bearer header. Public connectors are unaffected —
   the JWT path never reads this token.
- **Auth0 client secret** (one connector at a time): rotate from the
   application's Settings. Already-issued JWTs stay valid until they expire;
   only new authorization-code exchanges need the new secret. Update the
   credentials on the vendor side and reconnect.
- **Auth0 signing keys**: nothing to do — JWKS is fetched and cached
   automatically (see above).

## Troubleshooting

Auth0's tenant logs (Dashboard > Monitoring > Logs) name the exact failure —
start there.

| Symptom | Cause | Fix |
|---|---|---|
| Auth0 log: `Service not found: <server URL>` during connector login | API identifier is not the server URL | Create an API whose identifier is exactly `<publicUrl>/mcp`; set `AMS_MCP_OAUTH_AUDIENCE` to the same string; restart `ams-mcp` |
| API created, identifier correct, token exchange still rejected | New API does not authorize existing Applications | API > Applications (Application Access) > enable each connector application |
| Public URL answers `404` (with an `openresty` footer) | Wildcard ingress rule shadows the specific rule | Move the specific rule above the wildcard |
| Connector connects but every tool call returns `401 invalid_token` | Token audience does not match `AMS_MCP_OAUTH_AUDIENCE` | Align both sides on the same string (the resource URL) and restart `ams-mcp` |
| Connector login screen has no way to authenticate | No user in the tenant's database connection | Create a user or enable a social connection |
| Only one of the OAuth vars set; service refuses to start | All-or-none triple validation | Set all three (or none) and restart |

## Next steps

- [docker.md](docker.md) — the base stack: compose file, image reference,
  complete env-var table.
- [../quickstart.md](../quickstart.md) — the record → index → search loop.
- [../architecture.md](../architecture.md) — authentication paths and the
  configuration surface in context.
