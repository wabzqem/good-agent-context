# Good Agent Context

Good Agent Context is shared, searchable knowledge for coding agents. An agent can recall architecture and implementation facts relevant to the codebase it is working in, record a verified finding for future work, and search indexed repository specifications with links back to their source files. Memories persist across agent sessions and are ranked with lexical and semantic search.

Each repository describes its logical scopes in `.good-agent-context.yaml`. The CLI or local MCP server resolves the current project path to a scope; the API searches that scope, its synced ancestors, and the repository scope. Memories have lifecycle states, so updated facts can point to a successor and withdrawn facts leave normal recall. Repository specifications are indexed as a separate reference search with source paths and revisions.

The CLI and MCP adapter call a Cloudflare Worker domain API. The Worker validates operations, applies the configured namespace and roles, resolves the scope ladder, and reads or writes Vespa. Vespa stores memories, scope metadata, and the searchable copies of reference documents. Hosted access uses Cloudflare Access and a Worker-to-Vespa mTLS binding; local development runs the same API against Vespa in Docker.

## Local development

Install dependencies, start Vespa, and deploy its Docker-compatible application package:

```bash
npm install
./vespa-app/scripts/start-local.sh
./vespa-app/scripts/deploy-local.sh
npm run dev:worker
```

The Worker reads the `local` environment in `apps/worker/wrangler.jsonc` and normally listens at `http://127.0.0.1:8787`. The Vespa scripts publish their ports on loopback. `deploy-local.sh` selects `services.local.xml`, which supplies the E5 model URLs for Docker; the default `services.xml` uses Vespa Cloud's managed model ID. `apps/worker/.dev.vars.example` shows the values used by a customized local setup.

In another terminal, sync this repository's scope graph and specifications, then search them:

```bash
export GOOD_CONTEXT_URL=http://127.0.0.1:8787
npm run dev:cli -- scopes sync
npm run dev:cli -- documents sync
npm run dev:cli -- documents search 'how are scopes resolved?'
```

As agents record findings, `npm run dev:cli -- recall 'how does the Worker reach Vespa?'` retrieves matching memories. `remember`, `useful`, `supersede`, `withdraw`, and `restore` provide the rest of the CLI memory workflow.

The loopback client and local Worker use trusted local requests without Access authentication. For a different repository, run `scopes sync` from that repository after adding its `.good-agent-context.yaml`; configure the Worker's `REFERENCE_SOURCES_JSON` allowlist for that repository before syncing its documents.

## Repository scopes and documents

A project config declares a stable `repository:` ID, logical scopes with `parents:`, and path bindings. Exactly one `root: .` binding supplies the fallback. It can point to the repository scope when the project has no capability scope. More specific paths select narrower scopes such as a service. See [the example configuration](.good-agent-context.example.yaml).

After changing scope definitions or parent links, run `good-context scopes sync` as a curator. Path-binding changes take effect when the client next reads the config. The Worker stores the repository node and parent links in Vespa. Recall and document search then use the requested scope's ancestor ladder plus the repository scope.

To index repository specifications, declare `documents:` in the project config, allow the repository/scope/path prefix in the Worker's `REFERENCE_SOURCES_JSON`, then run:

```bash
npm run dev:cli -- documents sync
```

Document results include the repository path and source revision so an agent can open the current source before relying on precise wording.

## Hosted access

`GOOD_CONTEXT_URL` defaults to `https://gac.wabz.net`. Interactive CLI access uses a Cloudflare Access browser login with PKCE; on macOS, refresh credentials are stored in Keychain:

```bash
npm run dev:cli -- auth login
npm run dev:cli -- recall 'how does the Worker reach Vespa?'
```

For CI and unattended agents, configure a Cloudflare Access service token in the workload's credential store and map its client ID to a Worker role through `SERVICE_TOKEN_ROLES_JSON`. The shared client reads `GOOD_CONTEXT_SERVICE_TOKEN_ID` and `GOOD_CONTEXT_SERVICE_TOKEN_SECRET`; a configured service token takes precedence over an interactive bearer token. Vespa credentials stay with the Worker.

## MCP

The MCP adapter runs over local stdio. For a multi-project MCP host, pass the current project's absolute `project_path` to `recall`, `remember`, and `search_documents`. A server dedicated to one project can set `GOOD_CONTEXT_PROJECT_ROOT`. An optional `scope_id` selects another scope declared by that project's config.

```json
{
  "command": "/absolute/path/to/good-agent-context/apps/mcp-server/bin/good-context-mcp",
  "env": {
    "GOOD_CONTEXT_URL": "https://gac.wabz.net"
  }
}
```

The adapter exposes `recall`, `remember`, `mark_useful`, `supersede_memory`, `withdraw_memory`, `restore_memory`, and `search_documents`. Hosted MCP reuses the CLI's Access login; local MCP can use `GOOD_CONTEXT_URL=http://127.0.0.1:8787`. The Worker publishes OAuth Protected Resource Metadata for a future remote MCP transport.

## Verification and design

```bash
npm run typecheck
npm test
./vespa-app/scripts/test-phase1.sh
```

`test-phase1.sh` deploys Vespa, feeds test fixtures, and runs the local relevance evaluation. See [the technical architecture](docs/technical-spec.md) for current behavior and [the delivery plan](docs/plan.md) for the next milestones.
