# Good Agent Context: Delivery Plan

This plan separates the working system from the next milestones. [The technical architecture](technical-spec.md) describes the current contracts and implementation.

## Product direction

Good Agent Context gives coding agents a shared place to recall relevant system knowledge, contribute verified findings, and search repository-owned specifications. A memory has one primary logical scope and a lifecycle. A reference result retains its repository path and revision so an agent can use the source file for exact details.

The system has three layers: CLI and local stdio MCP clients, a Cloudflare Worker domain API, and Vespa as the product datastore and hybrid search engine. The Worker owns the namespace, roles, scope-graph checks, validation, and fixed Vespa operations. Local development uses Docker Vespa and an unauthenticated loopback Worker; hosted configuration uses Cloudflare Access and a Worker-to-Vespa mTLS binding.

## Implemented foundation

### Scope and project resolution

- Each repository owns a `.good-agent-context.yaml` with a stable repository ID, logical scope parent links, path bindings, and optional specification roots.
- The CLI and MCP adapter resolve the current project's most specific binding. MCP uses per-call `project_path` or a dedicated `GOOD_CONTEXT_PROJECT_ROOT`.
- A contributor runs `scopes sync` to persist the repository scope, parent graph, and repository memberships in Vespa.
- Recall and document search use the requested scope, its ancestors, and the repository scope. Shared capability scopes can span repositories; repository-scoped memories capture repository-specific facts.
- The Worker checks active scope membership before scope-addressed operations and unbinds removed scopes on sync.

### Retrieval and memory lifecycle

- Vespa stores memory, scope, and reference-document records. Memory recall combines BM25 and E5 nearest-neighbor candidates through reciprocal-rank fusion, with freshness and aggregate-usefulness factors.
- `remember` validates durable content, supports a caller-supplied idempotent memory ID, and returns up to three same-scope duplicate suggestions.
- `mark_useful` updates aggregate counters. Supersession preserves an old fact as heavily down-ranked historical context; curator withdrawal excludes a fact from normal recall and restoration returns it.
- Normal `recall` returns memories. `search_documents` is the separate reference lane and returns selected excerpts with source provenance.

### Clients, security, and local development

- The Worker exposes fixed, versioned domain endpoints. The shared client powers both the CLI and local stdio MCP adapter.
- Hosted authentication verifies Cloudflare Access assertions. Interactive CLI login uses browser PKCE and macOS Keychain; service-token IDs map to Worker roles for unattended callers.
- The Worker uses an outbound mTLS binding for Vespa Cloud. The local environment uses loopback Worker and Docker Vespa without Access credentials.
- The local deploy script substitutes URL-based E5 model configuration for Docker, while the Cloud package uses Vespa's managed model ID.
- Unit tests cover client authentication, project scope resolution, Worker scope/lifecycle behavior, and document flows. Local Vespa scripts verify fixed query profiles and run a seed relevance evaluation.

## Next milestones

### 1. Expand retrieval evaluation

Build a larger judged set from real coding tasks, including multi-repository capabilities, repository-only scopes, ancestor relevance, misleading lexical matches, and specification excerpts. Track Recall@10, nDCG@10, latency, scope isolation, and superseded prominence across lexical, semantic, and hybrid profiles. Tune ranking weights only against those cases and add regression gates for changes to Vespa profiles.

Acceptance: judged cases demonstrate the chosen hybrid profile's advantage and catch scope or lifecycle regressions before deployment.

### 2. Complete reference-document lifecycle

Extend explicit document sync with a manifest of configured source paths, so removed files can transition their indexed copies out of active search. Add curator metadata operations for supersession pointers and guidance notes with revision checks. Keep source text, path, and revision tied to the repository copy, and make source refreshes preserve appropriate index-side metadata.

Acceptance: renames, deletions, superseded specifications, and repeated syncs produce predictable searchable state and provenance.

### 3. Production operations and hardening

Add rate limits, quotas, abuse controls, structured audit events, monitoring, backup/export and restore procedures, and schema rollout/rollback guidance. Test Vespa Cloud deployment and credential rotation with the same functional scenarios used locally. Measure Worker placement and end-to-end recall latency near the Vespa zone.

Acceptance: an operator can deploy, observe, recover, and rotate credentials without changing CLI or MCP configuration.

### 4. Remote MCP transport

Implement the remote `/mcp` endpoint and its OAuth resource-server flow. The Worker already publishes protected-resource metadata; this milestone adds the transport, authorization checks, and client interoperability tests while preserving the same domain operations as stdio MCP.

Acceptance: a remote MCP client can authenticate and use scoped tools with the same results and role boundaries as the local adapter.

### 5. Fine-grained scope policy

Define a verified policy mapping for private capability subtrees and multi-repository grants. Keep the Worker's namespace binding and synced graph as the basis for authorization, with explicit tests for readers, contributors, curators, shared capabilities, and repository-specific memories.

Acceptance: policy decisions are deterministic, auditable, and enforced before Vespa queries or writes.

## Longer-term research

- Synthesize stable service findings into capability or organisation memories, with provenance back to source memories.
- Verify stored memories against repository changes and suggest successors when source evidence moves.
- Explore stronger atomic lifecycle transitions when competing writers become common.
- Evaluate additional reference kinds, learned reranking, and asynchronous coordination only when real retrieval or workflow evidence calls for them.

## Repository map

```text
apps/cli/                  command-line client and repository document sync
apps/mcp-server/           local stdio MCP tools
apps/worker/               domain API, authorization, scope graph, Vespa adapter
packages/client/           shared HTTP/Access client and project scope resolver
packages/contracts/        request and response types
vespa-app/                 schemas, rank/query profiles, local scripts and fixtures
tests/                     client, Worker, and project-resolution tests
docs/                      architecture and delivery plan
```
