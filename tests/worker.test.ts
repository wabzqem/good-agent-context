import { describe, expect, it } from "vitest";
import { authorizationFromAccessClaims, createWorker, type Env } from "../apps/worker/src/index";

const env: Env = {
  LOCAL_DEVELOPMENT: "true",
  LOCAL_ROLE: "contributor",
  NAMESPACE_ID: "acme",
  VESPA_ENDPOINT: "http://vespa.test:8080",
};

function memory(memory_id: string, overrides: Record<string, unknown> = {}) {
  return {
    memory_id,
    revision: 1,
    namespace_id: "acme",
    scope_id: "capability:payments",
    scope_kind: "capability",
    kind: "architecture",
    title: "Gateway owns agent authentication",
    body: "Coding agents call the authenticated gateway instead of Vespa.",
    tags: ["gateway"],
    source_paths: [],
    created_at: 1770000000,
    updated_at: 1770000000,
    status: "active",
    supersedes_ids: [],
    derived_from_memory_ids: [],
    useful_count: 0,
    last_useful_at: 0,
    content_hash: "sha256:test",
    ...overrides,
  };
}

function fakeVespa(initial: Record<string, Record<string, unknown>>, seedScopes = true) {
  const baseScopes: Array<[string, Record<string, unknown>]> = seedScopes ? [
    ["acme:repository:payments", { scope_id: "repository:payments", namespace_id: "acme", parent_ids: [], repository_ids: ["repository:payments"], status: "active" }],
    ["acme:capability:payments", { scope_id: "capability:payments", namespace_id: "acme", parent_ids: [], repository_ids: ["repository:payments"], status: "active" }],
  ] : [];
  const records = new Map<string, Record<string, unknown>>([...baseScopes, ...Object.entries(initial)]);
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    requests.push({ url, init });
    if (url.pathname === "/search/") {
      const children = [...records.values()]
        .filter((fields) => fields.namespace_id === "acme" && fields.scope_id === url.searchParams.get("scope_id") &&
          (url.searchParams.get("queryProfile") === "documents" ? fields.lifecycle_status === "active" : fields.status === "active" || fields.status === "superseded"))
        .map((fields, index) => ({ relevance: 1 - index * 0.1, fields: { ...fields, matchfeatures: { lifecycle_weight: fields.status === "superseded" ? 0.03 : 1 } } }));
      return Response.json({ root: { children } });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const existing = records.get(id);
    if (init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
      records.set(id, payload.fields);
      return Response.json({ pathId: id });
    }
    if (init?.method === "PUT") {
      if (!existing) return new Response("{}", { status: 404 });
      const payload = JSON.parse(String(init.body)) as { fields: Record<string, { increment?: number; assign?: unknown }> };
      for (const [field, update] of Object.entries(payload.fields)) {
        if (update.increment !== undefined) existing[field] = Number(existing[field] ?? 0) + update.increment;
        if (update.assign !== undefined) existing[field] = update.assign;
      }
      return Response.json({ pathId: id });
    }
    if (existing) return Response.json({ fields: Object.fromEntries(Object.entries(existing).filter(([, value]) => !Array.isArray(value) || value.length > 0)) });
    return new Response("{}", { status: 404 });
  };
  return { fetch: fetch as typeof fetch, records, requests };
}

function request(path: string, method = "GET", body?: unknown, authorized = false): Request {
  return new Request(`https://api.example${path}`, {
    method,
    headers: { ...(authorized ? { authorization: "Bearer local-token" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Good Agent Context Worker", () => {
  it("syncs the scope graph and recalls ancestors plus repository facts without sibling leakage", async () => {
    const vespa = fakeVespa({
      service: memory("service", { scope_id: "service:ledger", scope_kind: "service" }),
      payments: memory("payments"),
      organisation: memory("organisation", { scope_id: "organisation:acme", scope_kind: "organisation" }),
      repository: memory("repository", { scope_id: "repository:payments", scope_kind: "repository" }),
      sibling: memory("sibling", { scope_id: "service:fraud", scope_kind: "service" }),
    }, false);
    const worker = createWorker({ fetch: vespa.fetch });
    const graph = {
      repository_id: "repository:payments",
      scopes: [
        { scope_id: "organisation:acme", parent_ids: [] },
        { scope_id: "capability:payments", parent_ids: ["organisation:acme"] },
        { scope_id: "service:ledger", parent_ids: ["capability:payments"] },
        { scope_id: "service:fraud", parent_ids: ["capability:payments"] },
      ],
    };
    const denied = await worker.fetch(request("/v1/scopes/sync", "POST", graph), { ...env, LOCAL_ROLE: "reader" });
    expect(denied.status).toBe(403);
    const synced = await worker.fetch(request("/v1/scopes/sync", "POST", graph), env);
    expect(synced.status).toBe(201);
    await expect(synced.json()).resolves.toEqual({ synced: ["repository:payments", "organisation:acme", "capability:payments", "service:ledger", "service:fraud"], unbound: [] });
    const response = await worker.fetch(request("/v1/recall", "POST", {
      query: "gateway", scope_id: "service:ledger", repository_id: "repository:payments",
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { memories: Array<{ memory_id: string }>; scope_ids: string[] };
    expect(body.scope_ids).toEqual(["service:ledger", "capability:payments", "organisation:acme", "repository:payments"]);
    expect(body.memories.map((item) => item.memory_id).sort()).toEqual(["organisation", "payments", "repository", "service"]);
    expect(vespa.requests.filter((entry) => entry.url.pathname === "/search/").map((entry) => entry.url.searchParams.get("scope_id")))
      .toEqual(body.scope_ids);
  });

  it("requires synced scope metadata before recall", async () => {
    const vespa = fakeVespa({}, false);
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", {
      query: "gateway", scope_id: "capability:payments", repository_id: "repository:payments",
    }), env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "scope_not_synced" } });
  });

  it("unbinds scopes removed from a repository configuration", async () => {
    const vespa = fakeVespa({}, false);
    const worker = createWorker({ fetch: vespa.fetch });
    const curator = { ...env, LOCAL_ROLE: "curator" as const };
    const first = await worker.fetch(request("/v1/scopes/sync", "POST", {
      repository_id: "repository:payments",
      scopes: [
        { scope_id: "capability:payments", parent_ids: [] },
        { scope_id: "service:ledger", parent_ids: ["capability:payments"] },
      ],
    }), curator);
    expect(first.status).toBe(201);
    const second = await worker.fetch(request("/v1/scopes/sync", "POST", {
      repository_id: "repository:payments",
      scopes: [{ scope_id: "capability:payments", parent_ids: [] }],
    }), curator);
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({ unbound: ["service:ledger"] });
    const response = await worker.fetch(request("/v1/recall", "POST", {
      query: "gateway", scope_id: "service:ledger", repository_id: "repository:payments",
    }), env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "scope_not_synced" } });
  });

  it("uses the repository scope alone when no capability is configured", async () => {
    const vespa = fakeVespa({ repository: memory("repository", { scope_id: "repository:solo", scope_kind: "repository" }) }, false);
    const worker = createWorker({ fetch: vespa.fetch });
    const synced = await worker.fetch(request("/v1/scopes/sync", "POST", {
      repository_id: "repository:solo", scopes: [],
    }), { ...env, LOCAL_ROLE: "curator" });
    expect(synced.status).toBe(201);
    const response = await worker.fetch(request("/v1/recall", "POST", {
      query: "gateway", scope_id: "repository:solo", repository_id: "repository:solo",
    }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ scope_ids: ["repository:solo"], memories: [{ memory_id: "repository" }] });
  });

  it("rejects a scope bound to a different repository", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", {
      query: "gateway", scope_id: "capability:payments", repository_id: "repository:other",
    }), env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "scope_not_in_repository" } });
  });

  it("does not inspect or require authentication for local requests", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", { query: "gateway", scope_id: "capability:payments", repository_id: "repository:payments" }, true), env);
    expect(response.status).toBe(200);
  });

  it("fails closed when production Access JWT verification is not configured", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(
      new Request("https://api.example/v1/recall", { method: "POST", body: JSON.stringify({ query: "gateway", scope_id: "capability:payments", repository_id: "repository:payments" }) }),
      { ...env, LOCAL_DEVELOPMENT: "false" },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authentication_not_configured" } });
  });

  it("publishes protected-resource metadata without requiring an Access assertion", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(new Request("https://api.example/.well-known/oauth-protected-resource/mcp"), {
      ...env,
      ACCESS_TEAM_DOMAIN: "https://team.example.cloudflareaccess.com",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: "https://api.example/mcp",
      authorization_servers: ["https://team.example.cloudflareaccess.com"],
    });
  });

  it("enforces reader and contributor route permissions for local requests", async () => {
    const vespa = fakeVespa({ "mem-gateway": memory("mem-gateway") });
    const worker = createWorker({ fetch: vespa.fetch });
    const readerEnv = { ...env, LOCAL_ROLE: "reader" as const };
    const recall = await worker.fetch(request("/v1/recall", "POST", { query: "gateway", scope_id: "capability:payments", repository_id: "repository:payments" }), readerEnv);
    expect(recall.status).toBe(200);
    const remember = await worker.fetch(request("/v1/memories", "POST", {
      memory_id: "mem-denied", scope_id: "capability:payments", scope_kind: "capability", repository_id: "repository:payments", kind: "architecture",
      title: "Denied", body: "A reader must not create memories.",
    }), readerEnv);
    expect(remember.status).toBe(403);
    await expect(remember.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    expect(vespa.records.has("mem-denied")).toBe(false);
  });

  it("maps only verified service-token client IDs to configured roles", () => {
    expect(authorizationFromAccessClaims(
      { common_name: "ci-client" },
      { DEFAULT_ROLE: "reader", SERVICE_TOKEN_ROLES_JSON: '{"ci-client":"curator"}' },
    )).toEqual({ role: "curator", principal_type: "service" });
    expect(() => authorizationFromAccessClaims(
      { common_name: "unknown-client" },
      { DEFAULT_ROLE: "contributor", SERVICE_TOKEN_ROLES_JSON: '{"ci-client":"contributor"}' },
    )).toThrow(/not authorized/);
    expect(authorizationFromAccessClaims(
      { aud: "curator-audience" },
      { DEFAULT_ROLE: "reader", CURATOR_ACCESS_AUD: "curator-audience" },
    )).toEqual({ role: "curator", principal_type: "user" });
  });

  it("injects fixed Vespa recall parameters instead of accepting YQL", async () => {
    const vespa = fakeVespa({ "mem-gateway": memory("mem-gateway") });
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/recall", "POST", { query: "gateway authentication", scope_id: "capability:payments", repository_id: "repository:payments", limit: 3 }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      memories: [{
        memory_id: "mem-gateway", revision: 1, scope_id: "capability:payments", kind: "architecture",
        title: "Gateway owns agent authentication", body: "Coding agents call the authenticated gateway instead of Vespa.",
        tags: ["gateway"], source_paths: [], status: "active",
      }],
      scope_ids: ["capability:payments", "repository:payments"],
    });
    const search = vespa.requests.find((entry) => entry.url.pathname === "/search/")!.url;
    expect(search.searchParams.get("queryProfile")).toBe("recall");
    expect(search.searchParams.get("namespace_id")).toBe("acme");
    expect(search.searchParams.get("scope_id")).toBe("capability:payments");
    expect(search.searchParams.has("yql")).toBe(false);
    expect(vespa.requests.some((entry) => entry.url.pathname.includes("/scope/"))).toBe(true);
  });

  it("writes a validated memory with server-derived namespace", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch, now: () => 1_770_000_000_000 });
    const response = await worker.fetch(request("/v1/memories", "POST", {
      memory_id: "mem-created", scope_id: "capability:payments", scope_kind: "capability", repository_id: "repository:payments", kind: "architecture",
      title: "Gateway is the Vespa boundary", body: "Agent clients use the gateway to access durable memory rather than calling Vespa directly.",
    }), env);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      memory: {
        memory_id: "mem-created", revision: 1, scope_id: "capability:payments", repository_id: "repository:payments", kind: "architecture",
        title: "Gateway is the Vespa boundary", body: "Agent clients use the gateway to access durable memory rather than calling Vespa directly.",
        tags: [], source_paths: [], status: "active",
      },
      duplicate_candidates: [],
    });
    expect(vespa.records.get("mem-created")).toMatchObject({ namespace_id: "acme", status: "active", useful_count: 0 });
  });

  it("updates aggregate usefulness and supersession without a second document collection", async () => {
    const vespa = fakeVespa({
      old: memory("old"),
      successor: memory("successor", { title: "Current gateway boundary" }),
    });
    const worker = createWorker({ fetch: vespa.fetch, now: () => 1_770_000_000_000 });
    const useful = await worker.fetch(request("/v1/memories/old/usefulness", "PUT"), env);
    await expect(useful.json()).resolves.toEqual({ memory_id: "old" });
    const superseded = await worker.fetch(request("/v1/memories/old/supersede", "POST", { expected_revision: 1, successor_memory_id: "successor" }), env);
    expect(superseded.status).toBe(200);
    expect(vespa.records.get("old")).toMatchObject({ status: "superseded", superseded_by: "successor", revision: 2 });
    expect(vespa.requests.every((entry) => !entry.url.pathname.includes("memory_revision") && !entry.url.pathname.includes("memory_usefulness"))).toBe(true);
  });

  it("allows only curators to withdraw and restore active memories", async () => {
    const vespa = fakeVespa({ active: memory("active"), historical: memory("historical", { status: "superseded", superseded_by: "active", revision: 2 }) });
    const worker = createWorker({ fetch: vespa.fetch, now: () => 1_770_000_000_000 });
    const contributorAttempt = await worker.fetch(request("/v1/memories/active/withdraw", "POST", { expected_revision: 1 }), env);
    expect(contributorAttempt.status).toBe(403);

    const curatorEnv = { ...env, LOCAL_ROLE: "curator" as const };
    const withdrawn = await worker.fetch(request("/v1/memories/active/withdraw", "POST", { expected_revision: 1 }), curatorEnv);
    expect(withdrawn.status).toBe(200);
    await expect(withdrawn.json()).resolves.toMatchObject({ memory_id: "active", status: "withdrawn", revision: 2 });
    expect(vespa.records.get("active")).toMatchObject({ status: "withdrawn", revision: 2 });

    const recalledWhileWithdrawn = await worker.fetch(request("/v1/recall", "POST", { query: "gateway", scope_id: "capability:payments", repository_id: "repository:payments" }), curatorEnv);
    const recalledBody = await recalledWhileWithdrawn.json() as { memories: Array<{ memory_id: string }>; scope_ids: string[] };
    expect(recalledBody.scope_ids).toEqual(["capability:payments", "repository:payments"]);
    expect(recalledBody.memories.map((entry) => entry.memory_id)).not.toContain("active");

    const restored = await worker.fetch(request("/v1/memories/active/restore", "POST", { expected_revision: 2 }), curatorEnv);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ memory_id: "active", status: "active", revision: 3 });

    const withdrawSuperseded = await worker.fetch(request("/v1/memories/historical/withdraw", "POST", { expected_revision: 2 }), curatorEnv);
    expect(withdrawSuperseded.status).toBe(422);
    const restoreSuperseded = await worker.fetch(request("/v1/memories/historical/restore", "POST", { expected_revision: 2 }), curatorEnv);
    expect(restoreSuperseded.status).toBe(422);
  });

  it("returns only source-of-truth context for reference-document search", async () => {
    const vespa = fakeVespa({
      "ref-api": {
        document_id: "ref-api", namespace_id: "acme", scope_id: "capability:payments", title: "Payment API specification",
        chunks: ["## Retries\nClients reuse an idempotency key."], chunk_headings: ["Retries"], repository_id: "repository:payments",
        source_path: "docs/payment-api.md", source_uri: "https://example.test/docs/payment-api.md", source_revision: "abc123",
        source_content_hash: "sha256:test", indexed_at: 1770000000, lifecycle_status: "active", source_status: "present",
        guidance_notes: ["Open the repository source before changing behavior."], matchfeatures: { bm25: 1 },
      },
    });
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/documents/search", "POST", { query: "retries", scope_id: "capability:payments", repository_id: "repository:payments" }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      documents: [{
        scope_id: "capability:payments", title: "Payment API specification", chunks: ["## Retries\nClients reuse an idempotency key."],
        repository_id: "repository:payments", source_path: "docs/payment-api.md", source_uri: "https://example.test/docs/payment-api.md",
        source_revision: "abc123", guidance_notes: ["Open the repository source before changing behavior."],
      }],
      scope_ids: ["capability:payments", "repository:payments"],
    });
  });

  it("syncs documents in a registered repository without a Worker source allowlist", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/documents/sync", "POST", {
      documents: [{ scope_id: "capability:payments", kind: "specification", title: "Specification", chunks: ["text"], chunk_headings: ["Heading"], repository_id: "repository:payments", source_path: "private/spec.md", source_revision: "abc", source_content_hash: "sha256:test" }],
    }), env);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ indexed: [{ source_path: "private/spec.md" }] });
  });

  it("requires contributor access and repository membership for document sync", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const document = { scope_id: "capability:payments", kind: "specification", title: "Specification", chunks: ["text"], chunk_headings: ["Heading"], repository_id: "repository:payments", source_path: "docs/spec.md", source_revision: "abc", source_content_hash: "sha256:test" };
    const readerResponse = await worker.fetch(request("/v1/documents/sync", "POST", { documents: [document] }), { ...env, LOCAL_ROLE: "reader" });
    expect(readerResponse.status).toBe(403);
    const foreignRepositoryResponse = await worker.fetch(request("/v1/documents/sync", "POST", {
      documents: [{ ...document, repository_id: "repository:other" }],
    }), env);
    expect(foreignRepositoryResponse.status).toBe(403);
    await expect(foreignRepositoryResponse.json()).resolves.toMatchObject({ error: { code: "scope_not_in_repository" } });
  });

  it("rejects document paths that escape the repository", async () => {
    const vespa = fakeVespa({});
    const worker = createWorker({ fetch: vespa.fetch });
    const response = await worker.fetch(request("/v1/documents/sync", "POST", {
      documents: [{ scope_id: "capability:payments", kind: "specification", title: "Specification", chunks: ["text"], chunk_headings: ["Heading"], repository_id: "repository:payments", source_path: "../private/spec.md", source_revision: "abc", source_content_hash: "sha256:test" }],
    }), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_source_path" } });
  });
});
