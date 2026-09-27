# Good Agent Context: Technical Architecture

This document describes the behavior implemented in this repository. [The delivery plan](plan.md) tracks the next additions.

## Purpose and system shape

Good Agent Context gives coding agents shared, durable knowledge about the systems they work on. Agents recall relevant memories, record verified findings, manage the lifecycle of changed findings, and search indexed repository specifications. A memory is an agent-authored system fact; a reference document is a searchable copy of a repository file with source provenance.

```text
CLI or local stdio MCP
        │  typed domain requests
        ▼
Cloudflare Worker API ─── project namespace, roles, scope graph, validation
        │  fixed Vespa document and query operations
        ▼
Vespa ─── memories, scopes, reference documents, hybrid retrieval

.good-agent-context.yaml ─── repository ID, scope parents, path bindings, document roots
```

The shared client package handles HTTP requests and Access credentials. The CLI and MCP adapter resolve the calling project's scope through the same project-config parser. The Worker is the public domain boundary and Vespa is the authoritative product datastore. The Worker uses direct loopback fetch in local mode and an outbound mTLS binding for hosted Vespa Cloud access.

## Repository configuration and scope ladder

Each repository has a `.good-agent-context.yaml` at its root. Its `repository:` value is a stable `repository:*` ID. `scopes:` declares logical IDs and parent links; `bindings:` maps repository-relative paths to those IDs; `documents:` declares specification roots for explicit indexing. The repository scope itself is created by sync and does not appear in `scopes:`.

```yaml
version: 1
repository: repository:platform-monorepo
scopes:
  - id: organisation:acme
    parents: []
  - id: capability:payments
    parents: [organisation:acme]
  - id: service:ledger
    parents: [capability:payments]
bindings:
  - root: .
    scope: capability:payments
  - root: services/ledger
    scope: service:ledger
documents:
  - kind: specification
    root: specs
    include: ["**/*.md"]
    scope: capability:payments
```

Exactly one `root: .` binding provides the fallback. A repository with no known capability can use `scopes: []` and bind `.` to its `repository:*` scope. The parser validates stable lowercase IDs, declared parent IDs, unique bindings, normalized relative roots, acyclic parent links, and the `organisation → capability → service → component` ordering. It permits at most 128 declared scopes, eight parents per scope, and a 16-scope recall closure including the repository.

The CLI resolves the project path from `INIT_CWD` or its process directory. The MCP adapter takes the current project's `project_path` on each scoped call or uses `GOOD_CONTEXT_PROJECT_ROOT` for a dedicated server. The resolver finds the repository config without crossing the Git root, then selects the most specific matching path binding. An explicit `scope_id` selects another ID declared by that same repository. Both clients send `scope_id` and `repository_id` to the Worker; the Worker supplies the namespace from its own deployment configuration.

`good-context scopes sync` sends the declared graph to `POST /v1/scopes/sync`, a contributor operation. The Worker writes Vespa `scope` records for the repository and declared scopes, including parent links, ancestor IDs, and repository membership. The repository record tracks its bound scope IDs. A later sync removes that repository's membership from scopes removed from its config; a scope with no remaining repository membership becomes withdrawn. Shared scopes keep their parent structure consistent across repositories.

Before scope-addressed recall, memory creation, document search, and document sync, the Worker checks active scope records and membership in the requested repository. Missing records return `scope_not_synced`; an unbound scope returns `scope_not_in_repository`. Recall and document search walk the active scope's parents, deduplicate ancestors, and include the repository scope. Sibling scopes are outside that closure. A shared capability may contain facts contributed by several repositories; repository-specific facts belong under the repository scope. The `repository_id` request field verifies membership, while Vespa's fixed search profile filters by namespace and logical scope. Memory operations addressed by ID check the Worker's namespace and role, rather than a project path.

For example, a project path under `services/ledger` selects `service:ledger`. A recall from that path searches `service:ledger`, `capability:payments`, `organisation:acme`, and `repository:platform-monorepo`, in that order. A memory about the ledger API belongs to the service scope; a build-system fact specific to this repository belongs to its repository scope. A memory attached to `capability:payments` is shared context for repositories bound to that capability.

Scope synchronization writes several Vespa documents sequentially. The repository node records the final bound-scope set after child scope writes and unbindings; repeating a sync is the recovery path if an intermediate write fails. Vespa omits empty array fields from document GET responses, so `readScope` normalizes those fields before graph validation and repeated syncs.

## API and authorization

The Worker exposes versioned domain operations:

| Operation | Role | Behavior |
| --- | --- | --- |
| `POST /v1/recall` | reader | Search memories across the validated scope closure. |
| `GET /v1/memories/:id` | reader | Inspect a memory's current state. |
| `POST /v1/documents/search` | reader | Search indexed specifications across the scope closure. |
| `POST /v1/memories` | contributor | Store a validated memory and return duplicate suggestions. |
| `PUT /v1/memories/:id/usefulness` | contributor | Increment aggregate usefulness and update its latest timestamp. |
| `POST /v1/memories/:id/supersede` | contributor | Link a previous memory to an active successor. |
| `POST /v1/documents/sync` | contributor | Index repository specifications under synced scopes. |
| `POST /v1/scopes/sync` | contributor | Synchronize repository scope membership and parents. |
| `POST /v1/memories/:id/withdraw` | curator | Remove an active memory from normal recall. |
| `POST /v1/memories/:id/restore` | curator | Return a withdrawn memory to active recall. |

`GET /health` reports Worker health. The Worker also publishes OAuth Protected Resource Metadata, including an `/mcp` resource description for a future remote MCP transport. The running MCP adapter uses local stdio and exposes `recall`, `remember`, `mark_useful`, `supersede_memory`, `withdraw_memory`, `restore_memory`, and `search_documents`.

Local development uses `LOCAL_DEVELOPMENT=true` and `LOCAL_ROLE` for trusted loopback calls. The shared client detects loopback URLs and sends no Access credentials. The local Worker uses ordinary fetch to reach Docker Vespa.

For hosted calls, Cloudflare Access protects the Worker and the Worker independently verifies the signed `Cf-Access-Jwt-Assertion` against the Access JWKS, issuer, audience, and expiry. Verified interactive users receive `DEFAULT_ROLE` or curator access through `CURATOR_ACCESS_AUD`. Verified service-token client IDs are mapped to roles by `SERVICE_TOKEN_ROLES_JSON`. CLI browser login discovers the Access authorization server, performs dynamic loopback client registration and PKCE, and stores refresh credentials in macOS Keychain. The shared client also accepts configured Access service-token credentials for unattended workloads. Vespa Cloud requests use the Worker's `VESPA_MTLS` outbound binding.

The namespace is fixed by the Worker environment. Roles are namespace-wide; scope records establish repository membership and recall expansion. Error responses carry stable `{error:{code,message}}` values. The Worker turns unexpected exceptions into a generic `internal_error` response.

The API accepts bounded domain payloads. A scope-addressed recall request has this shape:

```json
{
  "query": "where is request authentication enforced?",
  "scope_id": "service:ledger",
  "repository_id": "repository:platform-monorepo",
  "limit": 8
}
```

The response has separate `memories` and `scope_ids` fields. Each memory view includes its ID, revision, logical scope, kind, title, body, tags, optional repository/source provenance, status, and successor pointer. Vespa rank diagnostics, content hashes, aggregate counters, and namespace bookkeeping stay in the storage layer.

## Memory storage and retrieval

A Vespa `memory` document contains one current record: ID, revision, namespace, primary scope, kind, title, body, tags, optional source provenance, lifecycle status, successor pointer, timestamps, and aggregate usefulness fields. Its E5 embedding is derived from the body as a 384-dimensional tensor and indexed with angular-distance HNSW. The Cloud package uses Vespa's managed `e5-small-v2` model ID; the local package supplies model and tokenizer URLs. Both configurations apply `query:` and `passage:` prefixes.

The Worker validates memory content, scope kind, lengths, and credential-like or temporary wording. It uses a caller-supplied `memory_id` when provided, otherwise a generated UUID. For a supplied ID, retrying with the same title, body, and scope returns the existing record; reusing it for different content returns `memory_id_conflict`. Memory creation also queries the primary logical scope for up to three active duplicate suggestions. The suggestions accompany the new memory in the response.

`POST /v1/recall` returns a `memories` array and the `scope_ids` searched. The Worker makes one fixed Vespa query per scope in the closure, merges hits by memory ID, keeps the best relevance, and returns a compact result. Reference documents are retrieved separately through `POST /v1/documents/search`.

The `recall` Vespa query profile fixes the memory schema, `memory_summary`, `memory_hybrid` ranking, namespace and scope predicates, lifecycle filter, hit count, and timeout. It combines BM25 `weakAnd` candidates with nearest-neighbor candidates. Vespa's global phase uses reciprocal-rank fusion, then freshness and usefulness factors. Freshness has a 180-day half-life; the title has twice the lexical weight of the body. Superseded memories remain labelled historical results with a 0.03 lifecycle multiplier, while withdrawn memories are outside normal recall. Lexical-only and semantic-only profiles serve local relevance evaluation.

| Query profile | Schema | Ranking purpose |
| --- | --- | --- |
| `recall` | `memory` | Hybrid production recall with lifecycle, freshness, and usefulness factors. |
| `recall-lexical` | `memory` | BM25 comparison baseline. |
| `recall-semantic` | `memory` | E5 nearest-neighbor comparison baseline. |
| `documents` | `reference_document` | Hybrid specification search with best-chunk summaries. |

The profile YQL, schema restriction, rank profile, summary, and timeout are fixed in the Vespa package. The Worker sets query text, its E5 embedding expression, namespace, and one validated scope for each request. This keeps retrieval behavior consistent across CLI and MCP callers.

`mark_useful` performs a Vespa partial update of `useful_count` and `last_useful_at`. Supersession requires an already-active successor in the same scope and an expected revision; it marks the prior record superseded and records `superseded_by`. Withdrawal and restoration also use expected revisions and preserve the record. Repeating an already-completed identical transition returns its current state. Revision checks are application-level checks on single documents; strict atomic compare-and-swap is a later hardening milestone.

## Reference-document index

The `reference_document` schema stores one searchable record per repository source file, with chunks, headings, source path, revision, content hash, optional HTTPS source URI, and lifecycle metadata. Vespa embeds each chunk into a multivector field. The `documents` profile combines lexical and semantic rank positions and returns up to three best-matching chunks. Reference ranking uses source relevance without memory freshness or usefulness factors. API results expose excerpts and source provenance so an agent can open the repository file for exact wording.

`good-context documents sync` reads the project's configured Markdown roots, splits sections at level-one through level-three headings, subdivides long sections at 3,000 characters, computes source hashes, and sends an explicit batch to the Worker. It uses repository-relative paths and avoids symlink traversal. The Worker checks each document's repository/scope membership against the synced graph and validates its relative source path and optional source URI. The CLI uses `GIT_COMMIT` as the source revision when supplied; otherwise it sends `local-uncommitted`, which the Worker accepts only in local mode. The Worker derives a stable document ID from repository ID and source path when the request omits one, then upserts the indexed copy.

Current reference sync performs upserts of the submitted files. Source-removal reconciliation, reference lifecycle metadata editing, and additional reference kinds are tracked in [the delivery plan](plan.md).

The reference index preserves a distinction between source content and index metadata. `source_path`, `source_revision`, and `source_content_hash` describe the repository file used at sync time. `indexed_at`, lifecycle state, and guidance notes describe the Vespa copy. The Worker returns source excerpts and location in search results; the repository file remains the place to verify normative details.

## Implementation map

| Concern | Source |
| --- | --- |
| HTTP routes, authorization, scope graph, and Vespa operations | `apps/worker/src/index.ts` |
| API payload validation | `apps/worker/src/validation.ts` |
| Project YAML parsing and path-to-scope resolution | `packages/client/src/project-scope.ts` |
| Shared HTTP and Access client | `packages/client/src/index.ts`, `packages/client/src/access.ts` |
| CLI commands and Markdown document sync | `apps/cli/src/index.ts` |
| Local stdio MCP tools | `apps/mcp-server/src/index.ts` |
| API request and response types | `packages/contracts/src/index.ts` |
| Document schemas and ranking | `vespa-app/schemas/` |
| Fixed Vespa search profiles | `vespa-app/search/query-profiles/` |

## Development and verification

`vespa-app/scripts/start-local.sh` runs Docker Vespa on loopback ports 8080 and 19071. `deploy-local.sh` substitutes `services.local.xml`, prepares and activates the package, and waits for application readiness. `npm run dev:worker` runs the Worker in its local Wrangler environment; `GOOD_CONTEXT_URL=http://127.0.0.1:8787` points the CLI and MCP adapter at it.

`npm run typecheck` and `npm test` exercise the TypeScript contracts, client behavior, project-scope resolution, and Worker workflows. `vespa-app/scripts/test-phase1.sh` starts and deploys Vespa, feeds fixtures, verifies fixed query behavior, and runs the judged relevance evaluator. The evaluator reports Recall@10, nDCG@10, latency, scope leakage, and superseded-memory prominence over its seed cases.
