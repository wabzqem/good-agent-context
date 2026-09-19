# Good Agent Context: Delivery Plan

Status: Draft

## Purpose

Good Agent Context is a shared memory system for coding agents. It gives an agent durable, relevant context about the systems it is working on without carrying forward personal information, session state, or incomplete work.

Agents interact with the system through two primary operations:

- `recall`: retrieve useful memories for a task and logical system scope.
- `remember`: record a durable fact that should save future agents from rediscovering it.

Supporting operations mark memories as useful, supersede obsolete memories, and inspect history.

Supersession replaces an obsolete durable fact with an already-created active successor. The old memory is retained as clearly labelled historical context, linked by `superseded_by`, and heavily down-ranked; it is not an edit-history record or a deletion.

The system also indexes repository-owned reference documents such as specifications. These are searchable copies, not memories and not the source of truth. Every result points back to the repository path and revision from which it was indexed.

## Product principles

1. Memories describe systems, not people or sessions.
2. A memory is concise, durable, independently understandable, and evidence-backed where practical.
3. Scope describes a stable system boundary rather than a filesystem location.
4. Recall combines lexical and semantic relevance.
5. Older memories decay in ranking, while demonstrated usefulness boosts them.
6. Superseded information remains auditable and is strongly down-ranked, while withdrawn information is excluded from normal recall.
7. Clients use a domain API. They never receive Vespa credentials or unrestricted Vespa query access.
8. Tenant and scope isolation are enforced by the server, never by client-supplied filters alone.
9. Indexed reference documents retain explicit provenance and never masquerade as authoritative memory content.

## Scope model

The durable scope vocabulary is:

```text
organisation -> capability -> service -> component
```

Repositories are parallel source and build boundaries rather than parents of services. A monorepo may contain several services, and one service may span several repositories.

Each memory has one primary logical scope. Examples:

- Capability architecture: `capability:payments`
- Service API behaviour: `service:ledger`
- Component implementation: `component:posting-engine`
- Repository build tooling: `repository:platform-monorepo`
- Organisation-wide convention: `org:acme`

Scope relationships use an array of parent IDs so that a shared service can support more than one capability. A local repository configuration may map directories to scope IDs, but those paths are resolution metadata and are not the stored memory scope.

## Architecture direction

The hosted system has three main layers:

1. CLI and MCP clients expose agent-friendly operations and know only the domain contract.
2. A Cloudflare Worker is the public trust boundary. It authenticates requests, authorizes fixed operations, validates content, resolves scope, constructs bounded Vespa requests, and owns the Vespa credential.
3. Vespa is the only product datastore. It holds current memories, logical scopes, aggregate usefulness signals, and rebuildable reference-document indexes, and serves hybrid retrieval.

Cloudflare Access supplies user and workload identity. Workers Managed OAuth is the preferred interactive CLI flow; Access service tokens cover CI and other unattended callers. The Worker calls Vespa Cloud through an outbound mTLS binding. No PostgreSQL or second application database is introduced.

The Worker remains stateless on the latency-sensitive recall path. Cloudflare Queues or Workflows may later coordinate asynchronous synthesis, repair, or aggregation, but their state is operational state rather than an authoritative copy of product data.

The API boundary is intentional. Direct Vespa access would let clients bypass namespace filters, memory-quality validation, lifecycle invariants, rate limits, and audit controls.

## Delivery phases

### Phase 0: Decisions and executable contracts

Deliverables:

- Agree on stable scope-identifier conventions; a scope graph is a later, optional enrichment.
- Define memory and API JSON schemas.
- Define the reference-document contract, provenance requirements, and source configuration.
- Define authentication roles and permissions.
- Spike Access Managed OAuth with the intended CLI/MCP clients and record the beta fallback.
- Create a small relevance fixture set before tuning ranking.
- Record architectural decisions that affect compatibility.

Acceptance criteria:

- Example monorepo, polyrepo, and single-repository configurations resolve to the intended logical scopes.
- Each public operation has defined inputs, outputs, authorization requirements, and failure modes.
- Interactive authentication either passes the compatibility spike or has a documented `cloudflared` fallback.

### Phase 1: Local Vespa vertical slice

Deliverables:

- Create the application package in `vespa-app/`.
- Configure the memory document schema, BM25 fields, E5 embeddings, HNSW, query profiles, document summaries, and rank profiles.
- Add a `reference_document` schema for specifications, with section chunks, multivector embeddings, source provenance, lifecycle metadata, and a no-decay rank profile.
- Run Vespa in Docker and deploy the application locally.
- Feed representative memories and specification fixtures and execute lexical-only, semantic-only, and hybrid queries.
- Add Vespa HTTP/system tests for filtering and ranking features.

Acceptance criteria:

- Keyword-specific queries retrieve the expected memory through BM25.
- Paraphrased queries retrieve the expected memory through semantic search.
- Hybrid recall returns memories only from permitted logical scopes; superseded memories are clearly labelled and heavily down-ranked, while withdrawn memories are excluded.
- Rank diagnostics expose lexical, semantic, freshness, usefulness, and final scores.
- Specification queries return the relevant sections plus an unambiguous repository source path/revision and do not apply age decay.

### Phase 2: Cloudflare domain API and local clients

Implementation status: implemented and verified against local Vespa. The Worker is deployed at the protected Cloudflare domain; the remaining Phase 3 client-login and workload-identity work is tracked below.

Deliverables:

- Build the Cloudflare Worker API and shared TypeScript client library.
- Implement `recall`, `remember`, `get_memory`, `mark_useful`, `supersede`, and `search_documents`.
- Build a CLI and local stdio MCP adapter over the same client library.
- Add `good-context documents sync` for configured repository specification folders.
- Add content validation, secret detection, scope-ID validation, limits, and duplicate suggestions.
- Keep all Vespa endpoints and credentials server-side.

Acceptance criteria:

- An agent can complete the full workflow without constructing YQL or document API requests.
- MCP exposes explicit document search, while normal recall can surface a small, separately labelled set of relevant specification results.
- The server derives namespace and coarse role from the authenticated principal; it validates but does not pre-register scope labels.
- Arbitrary query parameters, rank profiles, document writes, and namespace overrides are impossible through the public API.

### Phase 3: Cloudflare authentication and Vespa lifecycle storage

Implementation status: implemented in the Worker and clients. Cloudflare Access protects the deployed Worker, which independently verifies the signed assertion's issuer, signature, expiry, and one of the configured Access audiences. A configured default role applies to verified interactive users; an optional curator audience grants `curator`; and verified Access service-token client IDs map explicitly to roles through `SERVICE_TOKEN_ROLES_JSON`. Unmapped service tokens are denied. The CLI implements Managed OAuth discovery, dynamic loopback registration, PKCE, refresh, and macOS Keychain storage; unattended clients use the Cloudflare service-token headers. The Worker publishes OAuth Protected Resource Metadata for a future remote `/mcp` endpoint, while the supported MCP transport remains stdio.

Deliverables:

- Protect the Worker with Cloudflare Access.
- Use Access Managed OAuth for interactive CLI and coding-agent login.
- Support Access service tokens for CI and unattended agents.
- Bind the namespace to the Worker/Access application; grant a configured default role and protect curator operations with a distinct Access audience or service token.
- Store refresh credentials in the operating-system credential store where supported.
- Reserve the existing Vespa scope schema for a future curated graph; do not require it on the normal request path.
- Bind an outbound mTLS certificate to the Worker for Vespa Cloud access.
- Implement current MCP HTTP authorization discovery for a future remote MCP endpoint.

Operator configuration: create a Cloudflare Access `Service Auth` policy for each CI token, map its client ID to a role in `SERVICE_TOKEN_ROLES_JSON`, and configure `CURATOR_ACCESS_AUD` for the separately protected Access application before granting hosted withdrawal and restoration access. These values are deployment configuration; token secrets never enter Worker variables or the repository.

Acceptance criteria:

- A token issued for another audience is rejected.
- A principal cannot read or write another organisation's memories.
- A contributor cannot write to a retired, missing, or foreign-namespace scope.
- Access policy or service-token revocation takes effect without distributing new Vespa credentials.
- Vespa credentials never reach the CLI, MCP host, logs, or repository.

### Phase 4: Memory lifecycle and quality

Deliverables:

- Make writes idempotent.
- Keep the current memory as an authoritative Vespa document with an application-level revision check.
- Record usefulness as an aggregate counter and latest-use timestamp on the current memory document.
- Implement single-memory supersession with an active successor, a supersession pointer, and historical retrieval treatment.
- Let curators withdraw an active memory from normal recall and restore it to active when appropriate.
- Reject likely personal, secret, session-specific, temporary, and incomplete content.
- Add duplicate detection within the requested logical scope.

Acceptance criteria:

- Retrying a request does not create duplicate memories.
- Superseded memories are clearly labelled and rank substantially below comparable active memories; withdrawn memories never appear in normal recall.
- Only curators can withdraw or restore memories; a withdrawn memory is retained but excluded from normal recall.
- A retry of an already-completed identical supersession returns its existing state; rare competing supersessions are accepted as last-writer-wins in this release.
- Memory documents contain no authentication principal or session identifier.

### Phase 5: Relevance evaluation

Implementation status: an initial local memory-evaluation harness and judged seed set are implemented. It reports the metrics and enforces safety regressions, but the corpus is intentionally too small to make a meaningful hybrid-superiority claim. Grow it from real coding tasks before tuning weights or adding a performance gate.

Deliverables:

- Grow a judged set of coding tasks and expected memories.
- Measure Recall@10, nDCG@10, scope leakage, superseded-memory prominence, and latency.
- Compare BM25-only, semantic-only, normalized hybrid, and reciprocal-rank fusion profiles.
- Tune decay half-life and usefulness influence from evidence rather than intuition.

Acceptance criteria:

- Hybrid retrieval outperforms both single-channel baselines on the judged set.
- Scope leakage is zero and superseded-memory prominence stays within the configured ranking threshold in conformance tests.
- Ranking changes are regression-tested before deployment.

### Phase 6: Vespa Cloud development deployment

Deliverables:

- Deploy the same application package to a Vespa Cloud `dev` zone.
- Use the Vespa Cloud E5 model ID while retaining a local model URL/path fallback.
- Configure a dedicated data-plane identity for the Worker and install it as an mTLS certificate binding.
- Run the local test suite against the cloud endpoint.
- Add deployment and smoke-test automation.

Acceptance criteria:

- Local and cloud deployments pass the same functional tests.
- Only the Worker can access the Vespa data plane.
- Credentials are rotated without client changes.

The Cloud `dev` environment is suitable for validation, not durable shared production use: it has no availability or persistence guarantee and expires after inactivity. See [Vespa environments](https://docs.vespa.ai/en/operations/environments).

### Phase 7: Production readiness

Deliverables:

- Deploy a redundant production Vespa application.
- Add backups/replay, monitoring, alerting, quotas, rate limits, and abuse controls.
- Benchmark Worker placement against the Vespa zone and document the public-mTLS endpoint design.
- Add schema migration and rollback procedures.
- Document self-hosting and managed deployment paths.

Acceptance criteria:

- Recovery is based on Vespa Cloud redundancy/backups plus exported application data; there is no second live ledger to reconcile.
- Tenant isolation and authorization have automated negative tests.
- Operational objectives and cost limits are documented and monitored.

## Deferred work

- Out-of-band synthesis of service memories into capability-level memories.
- Capability-level synthesis into organisation conventions.
- Automated stale-memory verification against source changes.
- Learned reranking or cross-encoder models.
- A custom Vespa Searcher or request handler.
- Public anonymous recall.
- Fine-grained policy beyond the initial role and scope grants.
- Reference-document kinds beyond specifications, such as ADRs and runbooks.
- Strict test-and-set supersession and workflow orchestration for competing or multi-memory lifecycle changes; the initial release accepts rare competing single-memory supersessions as last-writer-wins.

The schema should reserve provenance relationships such as `derived_from_memory_ids`, but the synthesis process is explicitly outside the first implementation.

## Initial repository layout

```text
vespa-app/
  services.xml
  deployment.xml
  schemas/
    memory.sd
    scope.sd
    reference_document.sd
  search/query-profiles/
  tests/

apps/
  worker/
    src/
    wrangler.jsonc
  mcp-server/
  cli/

packages/
  client/
  contracts/
  scope-resolution/

eval/
  fixtures/
  relevance-cases.jsonl

docs/
  plan.md
  technical-spec.md
```

## Open decisions

- Should the first hosted deployment use one Access application/Worker per organisation, or a shared multi-tenant Worker with namespace claims?
- Is a memory visible to every reader in an organisation by default, or can capabilities be private?
- Should one usefulness mark be allowed per principal forever, or should later re-confirmation refresh it?
- What is the initial decay half-life?
- Which stable identifier and alias rules apply when a capability or service is renamed?
