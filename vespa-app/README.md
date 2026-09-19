# Phase 1 Vespa application

This is the local Vespa vertical slice for Good Agent Context. It implements the authoritative Vespa document types and retrieval behaviour, but it intentionally does **not** expose a public agent API. The Cloudflare Worker from Phase 2 authenticates callers and issues fixed queries with server-derived namespace and validated logical-scope filters.

## What is implemented

- `memory`: current active memory records, BM25, native E5 embeddings, HNSW, freshness decay, and usefulness boost.
- `reference_document`: repository-owned specification copies, chunk-level BM25 and multi-vector semantic matching, source provenance, and no age decay.
- `scope`: optional, future curated logical-scope graph. Normal Phase 1/2 reads and writes do not require scope records to be predefined.
- Locked query profiles: `recall` and `documents` fix schema, ranking, result summary, lifecycle filter, and retrieval query.
- Local fixtures and a smoke test for namespace/lifecycle filtering and source-of-truth provenance.

The E5 model is fetched by Vespa from Hugging Face on its first use. The first deployment/query can therefore take longer than later runs.

`validation-overrides.xml` contains a short-lived `schema-removal` allowance solely to migrate a local deployment created before the removed `memory_usefulness` and `memory_revision` schemas. Delete the override after upgrading every such deployment; new deployments do not need it.

## Run locally

Docker Desktop must be running. These scripts bind Vespa only to `127.0.0.1`.

```bash
cd vespa-app
chmod +x scripts/*.sh
./scripts/test-phase1.sh
```

Or run the individual stages:

```bash
./scripts/start-local.sh
./scripts/deploy-local.sh
./scripts/feed-fixtures.sh
./scripts/query-local.sh recall 'where is request authentication enforced'
./scripts/query-local.sh recall-lexical 'tenant isolation gateway credentials'
./scripts/query-local.sh recall-semantic 'which layer stops coding agents from talking to the search store'
./scripts/query-local.sh documents 'how should a charge retry use an idempotency key'
node ./scripts/evaluate-relevance.mjs
```

The test calls the local Vespa HTTP API only. It is a package test, not the product's public API contract; clients must never receive the ability to submit these requests directly in production.

## Relevance evaluation

`scripts/evaluate-relevance.mjs` executes the judged memory cases in `tests/relevance/memory-cases.json` against the lexical, semantic, and hybrid profiles. It reports Recall@10, nDCG@10, mean/p95 request latency, returned IDs per case, and hard checks for scope leakage, forbidden-memory leakage, and superseded-memory prominence. `test-phase1.sh` runs it after feeding fixtures.

The seed corpus is intentionally small: its report is a reproducible baseline, not evidence that hybrid retrieval is already superior. Add a judged case whenever a real coding task exposes a retrieval failure or useful distinction before changing ranking weights.

## Design notes

The `recall` query profile filters `namespace_id`, `scope_id`, and permitted lifecycle states before combining lexical `weakAnd` candidates with HNSW nearest-neighbour candidates. Active memories rank normally; superseded memories are returned only as clearly labelled historical context with a 0.03 lifecycle multiplier, while withdrawn memories are excluded. Its global phase uses reciprocal-rank fusion and only then applies freshness, usefulness, and lifecycle factors, avoiding comparisons between raw BM25 and vector score scales. The `recall-lexical` and `recall-semantic` profiles are evaluation baselines; production callers use `recall`. Vespa returns the final rank as each hit's `relevance`, plus the lexical, semantic, freshness, usefulness, and lifecycle diagnostics in `matchfeatures`.

`reference_document` keeps all chunks under a single source document. Vespa stores one embedding per chunk, retrieves against the nearest chunk, and returns up to three best chunks. It ranks with lexical and semantic reciprocal-rank fusion only: specifications do not decay with age. Each result includes `source_path`, `source_revision`, and `source_uri` so the caller can open the authoritative repository version.

The default `services.xml` is the Vespa Cloud package and uses the managed `e5-small-v2` model. `deploy-local.sh` swaps in `services.local.xml`, which uses the public Hugging Face model URL for Docker development. For Cloud, give only the Worker an mTLS-bound Vespa data-plane identity.
