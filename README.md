# Good Agent Context

Shared, durable context for coding agents. The system stores useful facts about systems rather than people, sessions, TODOs, or incomplete work.

The public surface is a Cloudflare Worker domain API. CLI and MCP clients never receive Vespa credentials and never construct YQL. Vespa remains the sole product datastore and search engine.

## Local development

First start and validate Vespa:

```bash
cd vespa-app
./scripts/test-phase1.sh
cd ..
```

Install JavaScript dependencies and configure a local-only Worker credential:

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Replace DEVELOPMENT_AUTH_TOKEN and REFERENCE_SOURCES_JSON in apps/worker/.dev.vars.
npm run dev:worker
```

In a second terminal, use the CLI against the Worker:

```bash
export GOOD_CONTEXT_URL=http://127.0.0.1:8787
export GOOD_CONTEXT_TOKEN=replace-with-the-same-local-only-token

npm run dev:cli -- recall 'where is request authentication enforced' capability:payments
npm run dev:cli -- documents search 'payment idempotency' capability:payments
```

To sync repository specifications, copy `.good-agent-context.example.yaml` to `.good-agent-context.yaml`, adjust its stable repository and scope IDs, and make the Worker `REFERENCE_SOURCES_JSON` entry match the repository, scope, and allowed source-path prefix. Then run:

```bash
npm run dev:cli -- documents sync
```

The local token is intentionally supported only when `LOCAL_DEVELOPMENT=true`. The deployed Worker is protected by Cloudflare Access and independently verifies the signed `Cf-Access-Jwt-Assertion` against Cloudflare's public signing keys, expected issuer, and application audience. Never put the development token or a Vespa credential in an agent configuration.

For the hosted API, use browser login once; the CLI registers a public PKCE client dynamically and stores its refresh credentials in the macOS Keychain:

```bash
npm run dev:cli -- auth login
npm run dev:cli -- recall 'where is request authentication enforced' capability:payments
```

`GOOD_CONTEXT_URL` defaults to `https://gac.wabz.net`. `GOOD_CONTEXT_TOKEN` remains available for explicitly local development.

### CI and unattended agents

Create a Cloudflare Access service token and admit it to the Worker Access application with a `Service Auth` policy. Store its client ID and secret in the CI secret manager, then configure the Worker with a role mapping for that client ID. The client never sends these credentials to Vespa:

```bash
export GOOD_CONTEXT_SERVICE_TOKEN_ID=your-cloudflare-service-token-client-id
export GOOD_CONTEXT_SERVICE_TOKEN_SECRET=your-cloudflare-service-token-secret
npm run dev:cli -- documents sync
```

The Worker accepts only service-token client IDs listed in its `SERVICE_TOKEN_ROLES_JSON` variable, for example `{"your-cloudflare-service-token-client-id":"contributor"}`. Do not commit a token secret. A service token takes precedence over `GOOD_CONTEXT_TOKEN` when both are present.

## MCP

Use the local stdio command in an MCP client configuration:

```json
{
  "command": "/absolute/path/to/good-agent-context/apps/mcp-server/bin/good-context-mcp",
  "env": {
    "GOOD_CONTEXT_URL": "https://gac.wabz.net"
  }
}
```

Run `good-context auth login` first in a normal terminal. The MCP process reuses the Keychain credential and refreshes opaque Access tokens as needed. For local development, set both `GOOD_CONTEXT_URL=http://127.0.0.1:8787` and the local-only `GOOD_CONTEXT_TOKEN` instead.

It exposes `recall`, `remember`, `mark_useful`, `supersede_memory`, and `search_documents`. `remember` returns up to three scoped active-memory duplicate suggestions. Document search results are explicitly non-authoritative references and include the repository source path/revision.

The Worker also publishes OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` for the planned remote `/mcp` transport. The currently supported MCP transport remains local stdio.

## Verification

```bash
npm run typecheck
npm test
```

See [the delivery plan](docs/plan.md) and [technical specification](docs/technical-spec.md) for the staged architecture.
