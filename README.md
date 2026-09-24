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

To redeploy to an already-running local Vespa without feeding test fixtures, run `./vespa-app/scripts/deploy-local.sh` from the repository root. Do not use `vespa deploy --target=local` against `vespa-app` directly: its default `services.xml` uses a Vespa Cloud-only model ID. The local script substitutes `services.local.xml` with a model URL.

Install JavaScript dependencies and configure the local Worker:

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Replace REFERENCE_SOURCES_JSON in apps/worker/.dev.vars.
npm run dev:worker
```

In a second terminal, sync this repository's scope graph, then use the CLI against the Worker:

```bash
export GOOD_CONTEXT_URL=http://127.0.0.1:8787

npm run dev:cli -- scopes sync
npm run dev:cli -- recall 'where is request authentication enforced'
npm run dev:cli -- documents search 'where is the scope model documented'
```

Each project needs a `.good-agent-context.yaml` at its repository root. Set a stable `repository:` ID, declare scopes with `parents:`, and add path bindings. Exactly one `root: .` binding supplies the fallback; it may point to the repository scope if there is no known capability. The most specific path binding selects the active scope, while recall also includes its synced ancestors and the repository scope. See `.good-agent-context.example.yaml` for a multi-scope example. Run `good-context scopes sync` after changing this file; scope sync requires the curator role. The local Worker profile grants that role. An unsynced scope returns `scope_not_synced` instead of searching an incomplete ladder.

To sync repository specifications, configure the `documents:` section and make the Worker `REFERENCE_SOURCES_JSON` entry match the repository, scope, and allowed source-path prefix. Then run:

```bash
npm run dev:cli -- documents sync
```

When `GOOD_CONTEXT_URL` is a loopback URL, the client sends no authentication headers and does not attempt Access login. The matching `LOCAL_DEVELOPMENT=true` Worker profile uses local Docker Vespa without mTLS and accepts these trusted local requests without authentication. Keep both services bound to loopback or a private Docker network. The deployed Worker remains protected by Cloudflare Access and independently verifies the signed `Cf-Access-Jwt-Assertion` against Cloudflare's public signing keys, expected issuer, and application audience. Never put a Vespa credential in an agent configuration.

For the hosted API, use browser login once; the CLI registers a public PKCE client dynamically and stores its refresh credentials in the macOS Keychain:

```bash
npm run dev:cli -- auth login
npm run dev:cli -- recall 'where is request authentication enforced'
```

`GOOD_CONTEXT_URL` defaults to `https://gac.wabz.net`; non-loopback URLs use Cloudflare Access.

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

Run `good-context auth login` first in a normal terminal. The MCP process reuses the Keychain credential and refreshes opaque Access tokens as needed. For local development, set `GOOD_CONTEXT_URL=http://127.0.0.1:8787`; no local token is needed.

For `recall`, `remember`, and `search_documents`, pass the current project's absolute `project_path`. The MCP server resolves that project's own configuration for each call. A server dedicated to one project may set `GOOD_CONTEXT_PROJECT_ROOT` instead. `scope_id` is optional and overrides the path binding when it names a scope declared by that repository. MCP does not use its own process directory as a project fallback.

It exposes `recall`, `remember`, `mark_useful`, `supersede_memory`, `withdraw_memory`, `restore_memory`, and `search_documents`. Withdrawal and restoration are curator-only operations. `remember` returns up to three scoped active-memory duplicate suggestions. Document search results are explicitly non-authoritative references and include the repository source path/revision.

The Worker also publishes OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` for the planned remote `/mcp` transport. The currently supported MCP transport remains local stdio.

## Verification

```bash
npm run typecheck
npm test
```

See [the delivery plan](docs/plan.md) and [technical specification](docs/technical-spec.md) for the staged architecture.
